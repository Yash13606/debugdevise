import QRCode from 'qrcode';
import { afterEach, describe, expect, it } from 'vitest';
import { buyTickets, cleanupTemp, fakeClock, line, makeApp, newEvent, newTier, placeHold } from '../helpers.js';

afterEach(cleanupTemp);

describe('GET /health', () => {
  it('answers ok with the current time', async () => {
    const t = await makeApp();
    const clock = fakeClock(Date.UTC(2026, 9, 6, 12, 30));
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, time: '2026-10-06T12:30:00.000Z' });
    clock.advance(1);
  });
});

describe('GET /api/events', () => {
  it('lists the events with their live availability, soonest first', async () => {
    const t = await makeApp();
    const later = await newEvent(t, { name: 'Later', starts_at: '2026-12-01T10:00:00Z', capacity: 8 });
    const sooner = await newEvent(t, { name: 'Sooner', starts_at: '2026-11-01T10:00:00Z', capacity: 5 });
    const tier = await newTier(t, sooner.id, { capacity: 5 });
    await placeHold(t, sooner.id, 'a@x.com', [line(tier, 2)]);

    const res = await t.app.inject({ method: 'GET', url: '/api/events' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      events: [
        { id: sooner.id, name: 'Sooner', starts_at: '2026-11-01T10:00:00.000Z', available: 3 },
        { id: later.id, name: 'Later', starts_at: '2026-12-01T10:00:00.000Z', available: 8 },
      ],
    });
  });

  it('frees due holds first, and is an empty list when there are no events', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '1' });
    expect((await t.app.inject({ method: 'GET', url: '/api/events' })).json()).toEqual({ events: [] });
    const clock = fakeClock();
    const event = await newEvent(t, { capacity: 3 });
    const tier = await newTier(t, event.id, { capacity: 3 });
    await placeHold(t, event.id, 'a@x.com', [line(tier, 3)]);
    expect((await t.app.inject({ method: 'GET', url: '/api/events' })).json().events[0].available).toBe(0);

    clock.advance(1000);

    expect((await t.app.inject({ method: 'GET', url: '/api/events' })).json().events[0].available).toBe(3);
  });
});

describe('GET /api/tickets/:id/qr.svg', () => {
  async function bought() {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 5 });
    const tier = await newTier(t, event.id, { capacity: 5 });
    return { t, ...(await buyTickets(t, event.id, tier, 2)) };
  }

  it("is an SVG image of the ticket's QR payload, for the buyer", async () => {
    const { t, tickets, token } = await bought();

    const res = await t.app.inject({ method: 'GET', url: `/api/tickets/${tickets[0]!.id}/qr.svg`, headers: { 'x-hold-token': token } });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.body).toBe(await QRCode.toString(tickets[0]!.qr_payload, { type: 'svg', margin: 2 }));
    const other = await t.app.inject({ method: 'GET', url: `/api/tickets/${tickets[1]!.id}/qr.svg`, headers: { 'x-hold-token': token } });
    expect(other.body).not.toBe(res.body);
  });

  it('needs the buyer token: wrong or missing is 403, an unknown ticket is 404', async () => {
    const { t, tickets } = await bought();
    const url = `/api/tickets/${tickets[0]!.id}/qr.svg`;
    for (const headers of [{ 'x-hold-token': 'nope' }, {}]) {
      const res = await t.app.inject({ method: 'GET', url, headers });
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'FORBIDDEN']);
    }
    const unknown = await t.app.inject({ method: 'GET', url: '/api/tickets/tkt_doesnotexist/qr.svg', headers: { 'x-hold-token': 'x' } });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'NOT_FOUND']);
  });
});
