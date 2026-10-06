import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock.js';
import { expireDueHolds } from '../src/holds.js';
import { spreadDiscount } from '../src/promo.js';
import { expectClean, hold, login, makeEnv, makeEvent, makeOrganiser, pay, phoneOf, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
let crowd: Person[];

beforeAll(async () => {
  e = await makeEnv({ MAX_TICKETS_PER_BUYER: '4', HOLD_TTL_SECONDS: '60' });
  org = await makeOrganiser(e.app);
  crowd = await Promise.all(Array.from({ length: 30 }, (_, i) => login(e.app, phoneOf(500 + i))));
});
afterAll(async () => {
  setClock(null);
  await expectClean(e);
  await e.close();
});

const promo = (eventId: string, body: Record<string, unknown>) => org.call('POST', `/api/organiser/events/${eventId}/promo-codes`, body);
const take = (p: Person, ev: { id: string; tiers: { id: string }[] }, q = 1, code?: string) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: q }], code ? { promo_code: code } : {});

describe('promo codes', () => {
  it('thirty buyers race for 5 uses: exactly 5 get the discount', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 100, price_paise: 10_000 }] });
    await promo(ev.id, { code: 'FIVE', kind: 'PERCENT', value: 10, max_uses: 5 });
    const rs = await Promise.all(crowd.map((p) => take(p, ev, 1, 'five')));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
    expect(rs.filter((r) => r.status !== 201).every((r) => r.body.error.details.reason === 'EXHAUSTED')).toBe(true);
    expect(rs.find((r) => r.status === 201)!.body.hold.total_paise).toBe(9_000);
    await expectClean(e);
  });

  it('a use comes back when the hold is released, expires or is refunded', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 100, price_paise: 10_000 }] });
    await promo(ev.id, { code: 'ONE', kind: 'FIXED', value: 1_000, max_uses: 1 });
    const a = await take(crowd[0]!, ev, 1, 'one');
    expect((await take(crowd[1]!, ev, 1, 'one')).body.error.details.reason).toBe('EXHAUSTED');
    await crowd[0]!.call('DELETE', `/api/holds/${a.body.hold.id}`);
    const b = await take(crowd[1]!, ev, 1, 'one');
    expect(b.status).toBe(201);
    setClock(() => Date.now() + 61_000);
    await expireDueHolds(e.ctx);
    setClock(null);
    const c = await take(crowd[2]!, ev, 1, 'one');
    expect(c.status).toBe(201);
    const orderId = await pay(e, crowd[2]!, c.body.hold.id);
    expect((await take(crowd[3]!, ev, 1, 'one')).status).toBe(422);
    await crowd[2]!.call('POST', `/api/orders/${orderId}/cancel`);
    expect((await take(crowd[3]!, ev, 1, 'one')).status).toBe(201);
    await expectClean(e);
  });

  it('refuses codes that are unknown, not started, expired, or for another ticket type', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 10, price_paise: 5_000 }, { capacity: 10, price_paise: 5_000 }] });
    await promo(ev.id, { code: 'LATER', kind: 'FIXED', value: 100, valid_from: new Date(Date.now() + 86_400_000).toISOString() });
    await promo(ev.id, { code: 'GONE', kind: 'FIXED', value: 100, valid_to: new Date(Date.now() - 1000).toISOString() });
    await promo(ev.id, { code: 'TIER2', kind: 'FIXED', value: 100, tier_id: ev.tiers[1]!.id });
    const reason = async (code: string) => (await take(crowd[4]!, ev, 1, code)).body.error.details.reason;
    expect(await reason('nope')).toBe('NOT_FOUND');
    expect(await reason('later')).toBe('NOT_STARTED');
    expect(await reason('gone')).toBe('EXPIRED');
    expect(await reason('tier2')).toBe('NOT_APPLICABLE');
  });

  it('spreads a discount so the ticket prices add up exactly to the total', () => {
    expect(spreadDiscount([10_000, 10_000, 10_000], [true, true, true], 1)).toEqual([9_999, 10_000, 10_000]);
    expect(spreadDiscount([10_000, 10_000, 10_000], [true, true, true], 10_000)).toEqual([6_666, 6_667, 6_667]); // the odd paisa comes off the first ticket
    expect(spreadDiscount([300, 100], [true, false], 50)).toEqual([250, 100]); // only eligible tickets are cut
    for (const [prices, d] of [[[333, 333, 334], 100], [[999, 1, 1], 500], [[7, 11, 13], 31]] as const) {
      const out = spreadDiscount([...prices], prices.map(() => true), d);
      expect(out.reduce((a, b) => a + b, 0)).toBe(prices.reduce((a, b) => a + b, 0) - d);
      expect(out.every((x) => x >= 0)).toBe(true);
    }
  });

  it('a promo covering only one tier discounts only that tier in the order total', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 10, price_paise: 10_000 }, { capacity: 10, price_paise: 20_000 }] });
    await promo(ev.id, { code: 'GOLD', kind: 'PERCENT', value: 50, tier_id: ev.tiers[1]!.id });
    const h = await hold(crowd[5]!, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }, { tier_id: ev.tiers[1]!.id, quantity: 1 }], { promo_code: 'gold' });
    expect(h.body.hold.discount_paise).toBe(10_000);
    expect(h.body.hold.total_paise).toBe(20_000);
    await pay(e, crowd[5]!, h.body.hold.id);
    await expectClean(e); // invariant I10: the tickets' prices sum to the order total
  });
});

describe('the per-buyer limit', () => {
  it('counts holds and tickets together, per buyer and event', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 50, max_per_order: 4 }] });
    const p = crowd[6]!;
    expect((await take(p, ev, 3)).status).toBe(201);
    const over = await take(p, ev, 2);
    expect(over.body.error.code).toBe('BUYER_LIMIT');
    expect(over.body.error.details).toMatchObject({ limit: 4, used: 3, requested: 2 });
    expect((await take(p, ev, 1)).status).toBe(201);
    expect((await take(crowd[7]!, ev, 4)).status).toBe(201); // someone else is unaffected
    const other = await makeEvent(org, { tiers: [{ capacity: 50 }] });
    expect((await take(p, other, 4)).status).toBe(201); // and the limit is per event
  });

  it('ten simultaneous requests from one buyer cannot get past the limit', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 50 }] });
    const rs = await Promise.all(Array.from({ length: 10 }, () => take(crowd[8]!, ev, 1)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(4);
    expect(rs.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'BUYER_LIMIT')).toBe(true);
    await expectClean(e);
  });
});
