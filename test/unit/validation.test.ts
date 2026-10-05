import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  cleanupTemp,
  fakeClock,
  getEvent,
  line,
  makeApp,
  newEvent,
  newTier,
  placeHold,
} from '../helpers.js';

afterEach(cleanupTemp);

const codeOf = (res: { statusCode: number; json: () => { error: { code: string } } }) => [res.statusCode, res.json().error.code];

describe('holds: what a request must look like', () => {
  it('an unknown event, an unknown tier and a tier of another event are 404 NOT_FOUND', async () => {
    const t = await makeApp();
    const event = await newEvent(t);
    const tier = await newTier(t, event.id);
    const other = await newEvent(t);
    const otherTier = await newTier(t, other.id);

    expect(codeOf(await placeHold(t, 'evt_doesnotexist', 'a@x.com', [line(tier)]))).toEqual([404, 'NOT_FOUND']);
    expect(codeOf(await placeHold(t, event.id, 'a@x.com', [{ tier_id: 'tier_doesnotexist', quantity: 1 }]))).toEqual([404, 'NOT_FOUND']);
    expect(codeOf(await placeHold(t, event.id, 'a@x.com', [line(otherTier)]))).toEqual([404, 'NOT_FOUND']);
    expect((await getEvent(t, event.id)).event.held).toBe(0);
  });

  it.each([
    ['no items', { email: 'a@x.com' }],
    ['an empty item list', { email: 'a@x.com', items: [] }],
    ['no email', { items: [{ tier_id: 'x', quantity: 1 }] }],
    ['a bad email', { email: 'not-an-email', items: [{ tier_id: 'TIER', quantity: 1 }] }],
    ['quantity 0', { email: 'a@x.com', items: [{ tier_id: 'TIER', quantity: 0 }] }],
    ['a fractional quantity', { email: 'a@x.com', items: [{ tier_id: 'TIER', quantity: 1.5 }] }],
    ['a quantity sent as text', { email: 'a@x.com', items: [{ tier_id: 'TIER', quantity: '2' }] }],
    ['an unknown field', { email: 'a@x.com', items: [{ tier_id: 'TIER', quantity: 1 }], coupon: 'x' }],
    ['the same tier twice', { email: 'a@x.com', items: [{ tier_id: 'TIER', quantity: 1 }, { tier_id: 'TIER', quantity: 1 }] }],
  ])('%s is 400 VALIDATION_ERROR and holds nothing', async (_name, body) => {
    const t = await makeApp();
    const event = await newEvent(t);
    const tier = await newTier(t, event.id);
    const payload = JSON.parse(JSON.stringify(body).replaceAll('TIER', tier.id));

    const res = await t.app.inject({ method: 'POST', url: `/api/events/${event.id}/holds`, payload });

    expect(codeOf(res)).toEqual([400, 'VALIDATION_ERROR']);
    expect((await getEvent(t, event.id)).event.held).toBe(0);
  });

  it('a body that is not JSON is 400 VALIDATION_ERROR', async () => {
    const t = await makeApp();
    const event = await newEvent(t);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/events/${event.id}/holds`,
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });
    expect(codeOf(res)).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('an unknown route is 404 NOT_FOUND in the same error format', async () => {
    const t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(codeOf(res)).toEqual([404, 'NOT_FOUND']);
  });
});

describe('MAX_PER_ORDER', () => {
  it('a line above the tier limit is 422 and names the limit; the limit defaults to DEFAULT_MAX_PER_ORDER', async () => {
    const t = await makeApp({ DEFAULT_MAX_PER_ORDER: '3', MAX_TICKETS_PER_BUYER: '0' });
    const event = await newEvent(t, { capacity: 50 });
    const byDefault = await newTier(t, event.id, { name: 'Default', capacity: 50 });
    const roomy = await newTier(t, event.id, { name: 'Roomy', capacity: 50, max_per_order: 8 });
    expect(byDefault.max_per_order).toBe(3);

    const refused = await placeHold(t, event.id, 'a@x.com', [line(byDefault, 4)]);
    expect(codeOf(refused)).toEqual([422, 'MAX_PER_ORDER']);
    expect(refused.json().error.details).toEqual({ tier_id: byDefault.id, max_per_order: 3 });
    expect((await placeHold(t, event.id, 'a@x.com', [line(byDefault, 3)])).statusCode).toBe(201);
    expect((await placeHold(t, event.id, 'b@x.com', [line(roomy, 8)])).statusCode).toBe(201);
    expect((await getEvent(t, event.id)).event.held).toBe(11); // the refused request took nothing
  });
});

describe('the sale window of a tier', () => {
  it('SALE_NOT_OPEN before it opens and from the instant it closes; open in between; nothing is held on refusal', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '86400' }); // holds outlast the two hours this test jumps through
    const clock = fakeClock(Date.UTC(2026, 9, 6, 12, 0, 0));
    const hour = 3_600_000;
    const event = await newEvent(t, { capacity: 10 });
    const tier = await newTier(t, event.id, {
      capacity: 10,
      sale_starts_at: new Date(Date.UTC(2026, 9, 6, 12) + hour).toISOString(),
      sale_ends_at: new Date(Date.UTC(2026, 9, 6, 12) + 2 * hour).toISOString(),
    });
    const ask = (email: string) => placeHold(t, event.id, email, [line(tier)]);

    const early = await ask('a@x.com');
    expect(codeOf(early)).toEqual([409, 'SALE_NOT_OPEN']);
    expect(early.json().error.details).toEqual({ tier_id: tier.id });
    clock.advance(hour); // the opening instant counts as open
    expect((await ask('b@x.com')).statusCode).toBe(201);
    clock.advance(hour - 1);
    expect((await ask('c@x.com')).statusCode).toBe(201);
    clock.advance(1); // the closing instant counts as closed
    expect(codeOf(await ask('d@x.com'))).toEqual([409, 'SALE_NOT_OPEN']);
    expect((await getEvent(t, event.id)).event.held).toBe(2);
  });

  it('a window that is not an ordered pair of dates is refused when the tier is created', async () => {
    const t = await makeApp();
    const event = await newEvent(t);
    const create = (body: Record<string, unknown>) =>
      t.app.inject({ method: 'POST', url: `/api/admin/events/${event.id}/tiers`, headers: ADMIN, payload: { name: 'T', price_cents: 1, capacity: 1, ...body } });

    expect(codeOf(await create({ sale_starts_at: '2026-10-02T00:00:00Z', sale_ends_at: '2026-10-01T00:00:00Z' }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(codeOf(await create({ sale_starts_at: 'next tuesday' }))).toEqual([400, 'VALIDATION_ERROR']);
  });
});

describe('admin: creating events and tiers', () => {
  it('needs the admin key; rejects bad input; an unknown event is 404', async () => {
    const t = await makeApp();
    const event = await newEvent(t);
    const post = (url: string, payload: unknown, headers: Record<string, string> = ADMIN) =>
      t.app.inject({ method: 'POST', url, headers, payload: payload as Record<string, unknown> });
    const good = { name: 'Fest', starts_at: '2026-10-20T13:00:00Z', capacity: 5 };
    const goodTier = { name: 'T', price_cents: 100, capacity: 5 };

    expect(codeOf(await post('/api/admin/events', good, {}))).toEqual([401, 'UNAUTHORIZED']);
    expect(codeOf(await post('/api/admin/events', good, { 'x-admin-key': 'wrong' }))).toEqual([401, 'UNAUTHORIZED']);
    for (const bad of [{ ...good, capacity: 0 }, { ...good, name: '' }, { ...good, starts_at: 'soon' }, { ...good, queue_enabled: 'yes' }, { name: 'x' }]) {
      expect(codeOf(await post('/api/admin/events', bad)), JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR']);
    }
    for (const bad of [{ ...goodTier, capacity: 0 }, { ...goodTier, price_cents: -1 }, { ...goodTier, max_per_order: 0 }, { ...goodTier, name: '' }, { name: 'x' }]) {
      expect(codeOf(await post(`/api/admin/events/${event.id}/tiers`, bad)), JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect(codeOf(await post('/api/admin/events/evt_doesnotexist/tiers', goodTier))).toEqual([404, 'NOT_FOUND']);
  });

  it('a free tier (price 0) is allowed, tier capacities may add up to more than the event, and events default to no queue', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 5 });
    expect(event.queue_enabled).toBe(false);
    const free = await newTier(t, event.id, { name: 'Free', price_cents: 0, capacity: 5 });
    const big = await newTier(t, event.id, { name: 'Big', capacity: 500 });
    const view = await getEvent(t, event.id);
    expect(view.tiers.map((x: { id: string }) => x.id)).toEqual([free.id, big.id]); // creation order
    expect(view.tiers[1].available).toBe(5); // the pool limits it
  });
});

describe('GET /api/events/:id', () => {
  it('an unknown event is 404 NOT_FOUND', async () => {
    const t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/events/evt_doesnotexist' });
    expect(codeOf(res)).toEqual([404, 'NOT_FOUND']);
  });
});
