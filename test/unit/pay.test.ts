import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  cleanupTemp,
  fakeClock,
  getEvent,
  getHold,
  line,
  makeApp,
  newEvent,
  newTier,
  payHold,
  placeHold,
  releaseHold,
  type TestApp,
} from '../helpers.js';

afterEach(cleanupTemp);

/** An event of 10 seats with one 499.00 tier, and a hold of `quantity` seats on it. */
async function holdOf(t: TestApp, quantity = 2) {
  const event = await newEvent(t, { capacity: 10 });
  const tier = await newTier(t, event.id, { capacity: 10, price_cents: 49900 });
  const res = await placeHold(t, event.id, 'a@x.com', [line(tier, quantity)]);
  expect(res.statusCode).toBe(201);
  const { hold, hold_token } = res.json();
  return { event, tier, hold, token: hold_token as string };
}

describe('pay', () => {
  it('turns a hold into a PAID order with one QR ticket per seat, moving held to sold', async () => {
    const t = await makeApp();
    const { event, tier, hold, token } = await holdOf(t);

    const res = await payHold(t, hold.id, token);

    expect(res.statusCode).toBe(201);
    const { order, tickets } = res.json();
    expect(order).toMatchObject({ status: 'PAID', total_cents: 99800, refunded_cents: 0 });
    expect(order.id).toMatch(/^ord_[a-z2-7]{12}$/);
    expect(Date.parse(order.paid_at)).not.toBeNaN();
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect(ticket).toMatchObject({ tier_id: tier.id, status: 'VALID' });
      expect(ticket.id).toMatch(/^tkt_[a-z2-7]{12}$/);
      expect(ticket.qr_payload).toMatch(/^AP1:[A-Za-z0-9_-]{22}$/);
    }
    expect(new Set(tickets.map((x: { qr_payload: string }) => x.qr_payload)).size).toBe(2);

    const view = await getEvent(t, event.id);
    expect(view.event).toMatchObject({ sold: 2, held: 0, available: 8 });
    expect(view.tiers[0]).toMatchObject({ sold: 2, held: 0, available: 8 });
    expect((await getHold(t, hold.id, token)).json().hold.status).toBe('CONVERTED');
  });

  it('paying twice returns the same order and creates no second set of tickets', async () => {
    const t = await makeApp();
    const { event, hold, token } = await holdOf(t);

    const first = await payHold(t, hold.id, token);
    const again = await payHold(t, hold.id, token);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((await getEvent(t, event.id)).event).toMatchObject({ sold: 2, held: 0 });
  });

  it('a declined payment leaves the hold ACTIVE and it can be paid again', async () => {
    const t = await makeApp();
    const { event, hold, token } = await holdOf(t);

    const declined = await payHold(t, hold.id, token, { simulate: 'decline' });

    expect(declined.statusCode).toBe(402);
    expect(declined.json().error.code).toBe('PAYMENT_FAILED');
    expect((await getHold(t, hold.id, token)).json().hold.status).toBe('ACTIVE');
    expect((await getEvent(t, event.id)).event).toMatchObject({ sold: 0, held: 2 });

    expect((await payHold(t, hold.id, token, { simulate: 'success' })).statusCode).toBe(201);
  });

  it('rejects an unknown payment method or unknown field', async () => {
    const t = await makeApp();
    const { hold, token } = await holdOf(t);
    expect((await payHold(t, hold.id, token, { payment_method: 'card' })).statusCode).toBe(400);
    expect((await payHold(t, hold.id, token, { tip: 5 })).statusCode).toBe(400);
  });
});

describe('release', () => {
  it('returns the seats at once; releasing or paying again is 409 HOLD_NOT_ACTIVE', async () => {
    const t = await makeApp();
    const { event, hold, token } = await holdOf(t);

    const released = await releaseHold(t, hold.id, token);

    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ hold: { id: hold.id, status: 'RELEASED' } });
    expect((await getEvent(t, event.id)).event).toMatchObject({ held: 0, sold: 0, available: 10 });
    const second = await releaseHold(t, hold.id, token);
    expect([second.statusCode, second.json().error.code]).toEqual([409, 'HOLD_NOT_ACTIVE']);
    const pay = await payHold(t, hold.id, token);
    expect([pay.statusCode, pay.json().error.code]).toEqual([409, 'HOLD_NOT_ACTIVE']);
  });

  it('cannot release a paid hold', async () => {
    const t = await makeApp();
    const { hold, token } = await holdOf(t);
    await payHold(t, hold.id, token);
    expect((await releaseHold(t, hold.id, token)).statusCode).toBe(409);
  });
});

describe('who may act on a hold', () => {
  it('a wrong or missing token is 403 FORBIDDEN; an unknown hold is 404 NOT_FOUND', async () => {
    const t = await makeApp();
    const { hold } = await holdOf(t);
    for (const call of [getHold, payHold, releaseHold]) {
      const wrong = await call(t, hold.id, 'not-the-token');
      expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'FORBIDDEN']);
    }
    const missing = await t.app.inject({ method: 'GET', url: `/api/holds/${hold.id}` });
    expect(missing.statusCode).toBe(403);
    const unknown = await getHold(t, 'hold_doesnotexist', 'x');
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('expiry rules', () => {
  it('a hold can be paid up to its expiry instant; at the instant it is 410 and the seats are free', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '600' });
    const clock = fakeClock();
    const event = await newEvent(t, { capacity: 2 });
    const tier = await newTier(t, event.id, { capacity: 2 });
    const a = (await placeHold(t, event.id, 'a@x.com', [line(tier)])).json();
    const b = (await placeHold(t, event.id, 'b@x.com', [line(tier)])).json();

    clock.advance(600_000 - 1);
    expect((await payHold(t, a.hold.id, a.hold_token)).statusCode).toBe(201);

    clock.advance(1); // now == expires_at
    const late = await payHold(t, b.hold.id, b.hold_token);
    expect([late.statusCode, late.json().error.code]).toEqual([410, 'HOLD_EXPIRED']);
    // The 410 also expired the hold, so the sweeper finds nothing left to do.
    const sweep = await t.app.inject({ method: 'POST', url: '/api/admin/sweep', headers: ADMIN });
    expect(sweep.json()).toEqual({ expired: 0 });
    expect((await getEvent(t, event.id)).event).toMatchObject({ sold: 1, held: 0, available: 1 });
  });

  it('KT2-paid: a paid hold is never expired; the order and tickets stay and no capacity is released', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '1' });
    const clock = fakeClock();
    const { event, tier, hold, token } = await holdOf(t);
    const paid = await payHold(t, hold.id, token);

    clock.advance(3_600_000);
    const sweep = await t.app.inject({ method: 'POST', url: '/api/admin/sweep', headers: ADMIN });

    expect(sweep.json()).toEqual({ expired: 0 });
    expect((await getEvent(t, event.id)).event).toMatchObject({ sold: 2, held: 0, available: 8 });
    expect((await getHold(t, hold.id, token)).json().hold.status).toBe('CONVERTED');
    expect((await payHold(t, hold.id, token)).json()).toEqual(paid.json());
    // The two sold seats stay sold: of the 8 left, a buyer takes 6, and 3 more are then refused.
    expect((await placeHold(t, event.id, 'b@x.com', [line(tier, 6)])).statusCode).toBe(201);
    expect((await placeHold(t, event.id, 'c@x.com', [line(tier, 3)])).statusCode).toBe(409);
  });
});

describe('the sweeper endpoint and lazy expiry', () => {
  it('POST /api/admin/sweep expires every due hold and returns the count; it needs the admin key', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '1' });
    const clock = fakeClock();
    const event = await newEvent(t, { capacity: 5 });
    const tier = await newTier(t, event.id, { capacity: 5 });
    for (const who of ['a', 'b', 'c']) await placeHold(t, event.id, `${who}@x.com`, [line(tier)]);

    expect((await t.app.inject({ method: 'POST', url: '/api/admin/sweep' })).statusCode).toBe(401);
    clock.advance(1000);
    const first = await t.app.inject({ method: 'POST', url: '/api/admin/sweep', headers: ADMIN });
    const second = await t.app.inject({ method: 'POST', url: '/api/admin/sweep', headers: ADMIN });

    expect([first.json(), second.json()]).toEqual([{ expired: 3 }, { expired: 0 }]);
    expect((await getEvent(t, event.id)).event).toMatchObject({ held: 0, available: 5 });
  });

  it('reading availability frees due holds even when the sweeper never runs', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '1' });
    const clock = fakeClock();
    const event = await newEvent(t, { capacity: 1 });
    const tier = await newTier(t, event.id, { capacity: 1 });
    await placeHold(t, event.id, 'a@x.com', [line(tier)]);
    expect((await getEvent(t, event.id)).event.available).toBe(0);

    clock.advance(1000);

    expect((await getEvent(t, event.id)).event).toMatchObject({ held: 0, available: 1 });
  });
});
