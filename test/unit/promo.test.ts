import { afterEach, describe, expect, it } from 'vitest';
import { spreadDiscount } from '../../src/promo.js';
import {
  cleanupTemp,
  createPromo,
  fakeClock,
  getEvent,
  line,
  makeApp,
  newEvent,
  newPromo,
  newTier,
  payHold,
  placeHold,
  refund,
  releaseHold,
  type TestApp,
} from '../helpers.js';

afterEach(cleanupTemp);

describe('spreadDiscount (DATA_MODEL section 5)', () => {
  it.each([
    ['the leftover cent goes to the first ticket', [100, 100, 100], [true, true, true], 10, [96, 97, 97]],
    ['the API worked example', [49900, 49900], [true, true], 9980, [44910, 44910]],
    ['a free ticket cannot take a cent', [0, 1, 1], [true, true, true], 1, [0, 0, 1]],
    ['only eligible tickets are discounted', [1000, 500], [true, false], 300, [700, 500]],
    ['a full discount', [500, 500], [true, true], 1000, [0, 0]],
    ['no discount', [500, 500], [true, true], 0, [500, 500]],
  ])('%s: %j with discount %i', (_name, prices, eligible, discount, expected) => {
    const paid = spreadDiscount(prices, eligible, discount);
    expect(paid).toEqual(expected);
    expect(paid.reduce((a, b) => a + b, 0)).toBe(prices.reduce((a, b) => a + b, 0) - discount);
  });
});

async function setup(t: TestApp, capacity = 20, price = 1000) {
  const event = await newEvent(t, { capacity });
  const tier = await newTier(t, event.id, { capacity, price_cents: price });
  return { event, tier };
}

describe('promo discounts', () => {
  it('PERCENT: the API worked example, 10% off two 499.00 tickets', async () => {
    const t = await makeApp();
    const { event, tier } = await setup(t, 20, 49900);
    await newPromo(t, event.id, { code: 'FRESHER10', kind: 'PERCENT', value: 10 });

    const res = await placeHold(t, event.id, 'a@x.com', [line(tier, 2)], { promo_code: 'FRESHER10' });

    expect(res.statusCode).toBe(201);
    expect(res.json().hold).toMatchObject({ subtotal_cents: 99800, discount_cents: 9980, total_cents: 89820 });
    const paid = await payHold(t, res.json().hold.id, res.json().hold_token);
    expect(paid.json().order).toMatchObject({ status: 'PAID', total_cents: 89820 });
  });

  it('FIXED: the discount never exceeds the subtotal, and the order can be free', async () => {
    const t = await makeApp();
    const { event, tier } = await setup(t, 20, 1000);
    await newPromo(t, event.id, { code: 'BIG', kind: 'FIXED', value: 5000 });

    const res = await placeHold(t, event.id, 'a@x.com', [line(tier)], { promo_code: 'big' });

    expect(res.json().hold).toMatchObject({ subtotal_cents: 1000, discount_cents: 1000, total_cents: 0 });
    expect((await payHold(t, res.json().hold.id, res.json().hold_token)).json().order.total_cents).toBe(0);
  });

  it('a code limited to one tier discounts only that tier', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 20 });
    const a = await newTier(t, event.id, { name: 'A', capacity: 10, price_cents: 1000 });
    const b = await newTier(t, event.id, { name: 'B', capacity: 10, price_cents: 500 });
    await newPromo(t, event.id, { code: 'HALF', kind: 'PERCENT', value: 50, tier_id: a.id });

    const res = await placeHold(t, event.id, 'a@x.com', [line(a, 2), line(b, 1)], { promo_code: 'HALF' });

    expect(res.json().hold).toMatchObject({ subtotal_cents: 2500, discount_cents: 1000, total_cents: 1500 });
  });

  it('codes are case-insensitive and surrounding spaces are ignored', async () => {
    const t = await makeApp();
    const { event, tier } = await setup(t);
    const created = await newPromo(t, event.id, { code: 'Fresher10' });
    expect(created.code).toBe('fresher10');
    for (const code of ['FRESHER10', 'fresher10', ' Fresher10 ']) {
      const res = await placeHold(t, event.id, `${code.trim()}@x.com`, [line(tier)], { promo_code: code });
      expect(res.statusCode, code).toBe(201);
    }
  });
});

describe('a promo code that does not apply fails the request (never ignored)', () => {
  it('reports why: NOT_FOUND, NOT_STARTED, EXPIRED, EXHAUSTED, NOT_APPLICABLE; nothing is consumed', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 20 });
    const a = await newTier(t, event.id, { name: 'A', capacity: 10 });
    const b = await newTier(t, event.id, { name: 'B', capacity: 10 });
    const hour = 3_600_000;
    await newPromo(t, event.id, { code: 'later', valid_from: new Date(Date.now() + hour).toISOString() });
    await newPromo(t, event.id, { code: 'old', valid_to: new Date(Date.now() - hour).toISOString() });
    await newPromo(t, event.id, { code: 'once', max_uses: 1 });
    await newPromo(t, event.id, { code: 'only-a', tier_id: a.id });
    expect((await placeHold(t, event.id, 'first@x.com', [line(a)], { promo_code: 'once' })).statusCode).toBe(201);

    const cases: [string, ReturnType<typeof line>, string][] = [
      ['nope', line(a), 'NOT_FOUND'],
      ['later', line(a), 'NOT_STARTED'],
      ['old', line(a), 'EXPIRED'],
      ['once', line(a), 'EXHAUSTED'],
      ['only-a', line(b), 'NOT_APPLICABLE'],
    ];
    for (const [code, item, reason] of cases) {
      const res = await placeHold(t, event.id, `${code}@x.com`, [item], { promo_code: code });
      expect([res.statusCode, res.json().error.code, res.json().error.details.reason], code).toEqual([422, 'PROMO_INVALID', reason]);
    }
    // Only the one successful hold holds a seat.
    expect((await getEvent(t, event.id)).event).toMatchObject({ held: 1 });
  });

  it('a hold refused for another reason does not use up the code', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 1 });
    const tier = await newTier(t, event.id, { capacity: 1 });
    await newPromo(t, event.id, { code: 'once', max_uses: 1 });
    const taker = (await placeHold(t, event.id, 'a@x.com', [line(tier)])).json(); // takes the only seat
    const refused = await placeHold(t, event.id, 'b@x.com', [line(tier)], { promo_code: 'once' });
    expect(refused.statusCode).toBe(409);

    await releaseHold(t, taker.hold.id, taker.hold_token);
    const ok = await placeHold(t, event.id, 'b@x.com', [line(tier)], { promo_code: 'once' });
    expect(ok.statusCode).toBe(201); // the refused attempt did not use the only use
  });
});

describe('P-1: the last use of a code, claimed in parallel', () => {
  it('max_uses = 1 and two parallel holds: one 201, one 422 PROMO_INVALID (EXHAUSTED)', async () => {
    const t = await makeApp();
    const { event, tier } = await setup(t);
    await newPromo(t, event.id, { code: 'once', max_uses: 1 });

    const results = await Promise.all([
      placeHold(t, event.id, 'a@x.com', [line(tier)], { promo_code: 'once' }),
      placeHold(t, event.id, 'b@x.com', [line(tier)], { promo_code: 'once' }),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
    const loser = results.find((r) => r.statusCode === 422)!;
    expect(loser.json().error).toMatchObject({ code: 'PROMO_INVALID', details: { reason: 'EXHAUSTED' } });
    expect((await getEvent(t, event.id)).event.held).toBe(1);
  });
});

describe('P-2: the use comes back when the hold or order ends', () => {
  async function takeAndCheck(t: TestApp, eventId: string, tierLine: ReturnType<typeof line>) {
    const second = await placeHold(t, eventId, 'second@x.com', [tierLine], { promo_code: 'once' });
    return second.statusCode;
  }

  it('release returns it', async () => {
    const t = await makeApp();
    const { event, tier } = await setup(t);
    await newPromo(t, event.id, { code: 'once', max_uses: 1 });
    const first = (await placeHold(t, event.id, 'a@x.com', [line(tier)], { promo_code: 'once' })).json();
    expect(await takeAndCheck(t, event.id, line(tier))).toBe(422);

    await releaseHold(t, first.hold.id, first.hold_token);

    expect(await takeAndCheck(t, event.id, line(tier))).toBe(201);
  });

  it('expiry returns it', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '1' });
    const clock = fakeClock();
    const { event, tier } = await setup(t);
    await newPromo(t, event.id, { code: 'once', max_uses: 1 });
    await placeHold(t, event.id, 'a@x.com', [line(tier)], { promo_code: 'once' });
    expect(await takeAndCheck(t, event.id, line(tier))).toBe(422);

    clock.advance(1000);

    expect(await takeAndCheck(t, event.id, line(tier))).toBe(201);
  });

  it('a paid order keeps it; a full refund returns it, a partial refund does not', async () => {
    const t = await makeApp();
    const { event, tier } = await setup(t, 20, 1000);
    await newPromo(t, event.id, { code: 'once', max_uses: 1 });
    const hold = (await placeHold(t, event.id, 'a@x.com', [line(tier, 2)], { promo_code: 'once' })).json();
    const paid = (await payHold(t, hold.hold.id, hold.hold_token)).json();
    expect(await takeAndCheck(t, event.id, line(tier))).toBe(422);

    const [t1, t2] = paid.tickets;
    await refund(t, paid.order.id, { ticket_ids: [t1.id] }); // partial
    expect(await takeAndCheck(t, event.id, line(tier))).toBe(422);

    await refund(t, paid.order.id, { ticket_ids: [t2.id] }); // now the whole order is refunded
    expect(await takeAndCheck(t, event.id, line(tier))).toBe(201);
  });
});

describe('creating promo codes', () => {
  it('needs the admin key and validates its input', async () => {
    const t = await makeApp();
    const { event } = await setup(t);
    const other = await newEvent(t, { capacity: 5 });
    const otherTier = await newTier(t, other.id, { capacity: 5 });
    const body = { code: 'ok', kind: 'PERCENT', value: 10 };

    expect((await createPromo(t, event.id, body, {})).statusCode).toBe(401);
    expect((await createPromo(t, 'evt_unknown', body)).statusCode).toBe(404);
    for (const bad of [
      { ...body, value: 101 }, // percent above 100
      { ...body, value: 0 },
      { ...body, kind: 'BOGUS' },
      { ...body, max_uses: 0 },
      { ...body, code: 'has space' },
      { ...body, code: '' },
      { ...body, valid_from: '2026-10-02T00:00:00Z', valid_to: '2026-10-01T00:00:00Z' },
      { ...body, extra: true },
    ]) {
      const res = await createPromo(t, event.id, bad);
      expect([res.statusCode, res.json().error.code], JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR']);
    }
    const foreignTier = await createPromo(t, event.id, { ...body, tier_id: otherTier.id });
    expect([foreignTier.statusCode, foreignTier.json().error.code]).toEqual([404, 'NOT_FOUND']);
    expect((await createPromo(t, event.id, { ...body, kind: 'FIXED', value: 100000 })).statusCode).toBe(201); // FIXED may be large
  });

  it('a code exists once per event, in any letter case: the second is 409 PROMO_EXISTS', async () => {
    const t = await makeApp();
    const { event } = await setup(t);
    const other = await newEvent(t, { capacity: 5 });
    await newPromo(t, event.id, { code: 'Fresher10' });

    const dup = await createPromo(t, event.id, { code: 'FRESHER10', kind: 'FIXED', value: 5 });

    expect([dup.statusCode, dup.json().error.code]).toEqual([409, 'PROMO_EXISTS']);
    expect((await createPromo(t, other.id, { code: 'fresher10', kind: 'FIXED', value: 5 })).statusCode).toBe(201);
  });

  it('returns the stored code', async () => {
    const t = await makeApp();
    const { event, tier } = await setup(t);
    const res = await createPromo(t, event.id, {
      code: 'Welcome', kind: 'FIXED', value: 250, max_uses: 3, valid_from: null, valid_to: '2027-01-01T00:00:00Z', tier_id: tier.id,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().promo).toMatchObject({
      code: 'welcome', kind: 'FIXED', value: 250, max_uses: 3, used: 0,
      valid_from: null, valid_to: '2027-01-01T00:00:00.000Z', tier_id: tier.id,
    });
  });
});
