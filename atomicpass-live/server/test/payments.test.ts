import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setClock } from '../src/clock.js';
import { expireDueHolds } from '../src/holds.js';
import { reconcile } from '../src/payments/service.js';
import { api, expectClean, hold, login, makeEnv, makeEvent, makeOrganiser, pay, phoneOf, sim, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
let buyers: Person[];
let clock = Date.now();
const advance = (ms: number) => {
  clock = Math.max(clock, Date.now()) + ms; // from now (or from the last jump, if that is later)
  setClock(() => clock);
};

beforeAll(async () => {
  e = await makeEnv({ HOLD_TTL_SECONDS: '60', PAY_WINDOW_SECONDS: '120' });
  org = await makeOrganiser(e.app);
  buyers = await Promise.all(Array.from({ length: 8 }, (_, i) => login(e.app, phoneOf(200 + i))));
});
afterEach(() => setClock(null));
afterAll(async () => {
  await expectClean(e);
  await e.close();
});

const checkout = async (p: Person, holdId: string) => (await p.call('POST', `/api/holds/${holdId}/checkout`)).body.payment as { provider_order_id: string; amount_paise: number };
const deliver = (hook: { rawBody: string; headers: Record<string, string> }) =>
  e.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: hook.headers, payload: hook.rawBody });
const orders = async (eventId: string) => (await e.ctx.pool.query('SELECT * FROM orders WHERE event_id = $1', [eventId])).rows;
const one = async (ev: { id: string; tiers: { id: string }[] }, p: Person, q = 1) => (await hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: q }])).body.hold.id as string;

describe('checkout and the PAYING state', () => {
  it('moves the hold to PAYING and extends its life once', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const holdId = await one(ev, buyers[0]!);
    const before = (await buyers[0]!.call('GET', `/api/holds/${holdId}`)).body.hold.seconds_left;
    expect(before).toBeLessThanOrEqual(60);
    await checkout(buyers[0]!, holdId);
    const after = (await buyers[0]!.call('GET', `/api/holds/${holdId}`)).body.hold;
    expect(after.status).toBe('PAYING');
    expect(after.seconds_left).toBeGreaterThan(100);
    const again = await buyers[0]!.call('POST', `/api/holds/${holdId}/checkout`);
    expect(again.status).toBe(201); // the same open payment comes back
    expect((await e.ctx.pool.query('SELECT 1 FROM payments WHERE hold_id = $1', [holdId])).rowCount).toBe(1);
  });

  it('a payment in progress cannot be released', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const holdId = await one(ev, buyers[1]!);
    await checkout(buyers[1]!, holdId);
    const r = await buyers[1]!.call('DELETE', `/api/holds/${holdId}`);
    expect(r.body.error.code).toBe('PAYMENT_IN_PROGRESS');
  });

  it("another buyer cannot see or pay your hold", async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const holdId = await one(ev, buyers[2]!);
    expect((await buyers[3]!.call('GET', `/api/holds/${holdId}`)).status).toBe(404);
    expect((await buyers[3]!.call('POST', `/api/holds/${holdId}/checkout`)).status).toBe(404);
  });

  it('a declined payment returns the hold to ACTIVE and the buyer can retry', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const p = buyers[4]!;
    const holdId = await one(ev, p);
    expect(await pay(e, p, holdId, 'failure')).toBeNull();
    expect((await p.call('GET', `/api/holds/${holdId}`)).body.hold.status).toBe('ACTIVE');
    const orderId = await pay(e, p, holdId, 'success');
    expect(orderId).toBeTruthy();
    expect((await orders(ev.id)).length).toBe(1);
  });

  it('free tickets (and a 100% promo) need no gateway', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5, price_paise: 0 }] });
    const holdId = await one(ev, buyers[5]!);
    const co = await buyers[5]!.call('POST', `/api/holds/${holdId}/checkout`);
    expect(co.body.order_id).toBeTruthy();
    expect(co.body.payment).toBeNull();

    const paid = await makeEvent(org, { tiers: [{ capacity: 5, price_paise: 10_000 }] });
    await org.call('POST', `/api/organiser/events/${paid.id}/promo-codes`, { code: 'FREE100', kind: 'PERCENT', value: 100 });
    const h = await hold(buyers[5]!, paid.id, [{ tier_id: paid.tiers[0]!.id, quantity: 2 }], { promo_code: 'free100' });
    expect(h.body.hold.total_paise).toBe(0);
    expect((await buyers[5]!.call('POST', `/api/holds/${h.body.hold.id}/checkout`)).body.order_id).toBeTruthy();
  });
});

describe('expiry', () => {
  it('an unpaid hold frees its seats for the next buyer, and paying it later fails', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 1 }] });
    const first = await one(ev, buyers[0]!);
    expect((await hold(buyers[1]!, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])).body.error.code).toBe('SOLD_OUT');
    advance(61_000);
    const second = await hold(buyers[1]!, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }]);
    expect(second.status).toBe(201);
    const late = await buyers[0]!.call('POST', `/api/holds/${first}/checkout`);
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe('HOLD_EXPIRED');
  });

  it('the sweeper expires due holds without any traffic', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 3 }] });
    await one(ev, buyers[2]!, 3);
    advance(61_000);
    expect(await expireDueHolds(e.ctx)).toBeGreaterThanOrEqual(1);
    expect((await api(e.app)('GET', `/api/events/${ev.id}`)).body.event.available).toBe(3);
  });
});

describe('webhooks', () => {
  it('the same webhook delivered many times at once makes exactly one order', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const holdId = await one(ev, buyers[3]!, 2);
    const pmt = await checkout(buyers[3]!, holdId);
    const hook = (await sim(e).settle(pmt.provider_order_id, 'success'))!;
    const rs = await Promise.all(Array.from({ length: 8 }, () => deliver(hook)));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    const results = rs.map((r) => JSON.parse(r.body).result).sort();
    expect(results.filter((x) => x === 'processed')).toHaveLength(1);
    expect(results.filter((x) => x === 'duplicate')).toHaveLength(7);
    expect(await orders(ev.id)).toHaveLength(1);
    expect((await e.ctx.pool.query(`SELECT COUNT(*)::int AS n FROM tickets WHERE event_id = $1`, [ev.id])).rows[0].n).toBe(2);
  });

  it('a bad signature is refused and stores nothing', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const holdId = await one(ev, buyers[4]!);
    const pmt = await checkout(buyers[4]!, holdId);
    const hook = sim(e).signedWebhook(pmt.provider_order_id, pmt.amount_paise, 'PAYMENT_SUCCESS');
    const before = (await e.ctx.pool.query('SELECT COUNT(*)::int AS n FROM webhook_events')).rows[0].n;
    for (const headers of [{ ...hook.headers, 'x-signature': 'f'.repeat(64) }, { 'content-type': 'application/json' }]) {
      const r = await e.app.inject({ method: 'POST', url: '/api/webhooks/payments', headers, payload: hook.rawBody });
      expect(r.statusCode).toBe(401);
    }
    expect((await e.ctx.pool.query('SELECT COUNT(*)::int AS n FROM webhook_events')).rows[0].n).toBe(before);
    expect(await orders(ev.id)).toHaveLength(0);
  });

  it('a webhook whose amount differs from ours is not acted on and is flagged', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5, price_paise: 10_000 }] });
    const holdId = await one(ev, buyers[5]!);
    const pmt = await checkout(buyers[5]!, holdId);
    const r = await deliver(sim(e).signedWebhook(pmt.provider_order_id, pmt.amount_paise - 1, 'PAYMENT_SUCCESS'));
    expect(JSON.parse(r.body).result).toBe('ignored');
    expect(await orders(ev.id)).toHaveLength(0);
    expect((await e.ctx.pool.query(`SELECT 1 FROM reconciliation_issues WHERE kind = 'AMOUNT_MISMATCH'`)).rowCount).toBeGreaterThan(0);
  });
});

describe('money and the timer', () => {
  it('a success that arrives after expiry but before anyone closed the hold still converts', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 1 }] });
    const holdId = await one(ev, buyers[0]!);
    const pmt = await checkout(buyers[0]!, holdId);
    const hook = (await sim(e).settle(pmt.provider_order_id, 'success'))!;
    advance(10 * 60_000); // far past the (extended) expiry, with no sweep and no traffic
    expect(JSON.parse((await deliver(hook)).body).result).toBe('processed');
    expect(await orders(ev.id)).toHaveLength(1);
    expect((await api(e.app)('GET', `/api/events/${ev.id}`)).body.event.available).toBe(0);
  });

  it('a success that arrives after the hold was closed and resold is refunded, not honoured', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 1, price_paise: 40_000 }] });
    const slow = buyers[1]!;
    const holdId = await one(ev, slow);
    const pmt = await checkout(slow, holdId);
    const hook = (await sim(e).settle(pmt.provider_order_id, 'success'))!;
    advance(10 * 60_000);
    const resold = await hold(buyers[2]!, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }]); // frees the stale hold, takes the seat
    expect(resold.status).toBe(201);

    expect(JSON.parse((await deliver(hook)).body).result).toBe('processed');
    expect(await orders(ev.id)).toHaveLength(0);
    const p = (await e.ctx.pool.query('SELECT status FROM payments WHERE provider_order_id = $1', [pmt.provider_order_id])).rows[0];
    expect(p.status).toBe('LATE_REFUNDED');
    const rf = (await e.ctx.pool.query(`SELECT amount_paise, status, kind FROM refunds WHERE payment_id = (SELECT id FROM payments WHERE provider_order_id = $1)`, [pmt.provider_order_id])).rows;
    expect(rf).toEqual([{ amount_paise: 40_000, status: 'DONE', kind: 'LATE_PAYMENT' }]);
    const gw = (await e.ctx.pool.query('SELECT refunded_paise FROM sim_gateway_orders WHERE provider_order_id = $1', [pmt.provider_order_id])).rows[0];
    expect(gw.refunded_paise).toBe(40_000); // the gateway really gave the money back
    expect((await buyers[2]!.call('GET', `/api/holds/${resold.body.hold.id}`)).body.hold.status).toBe('ACTIVE'); // the new buyer is untouched
  });

  it('a webhook racing the sweeper: one outcome, never both an order and a refund', async () => {
    for (let round = 0; round < 15; round++) {
      const ev = await makeEvent(org, { tiers: [{ capacity: 1, price_paise: 10_000 }] });
      const holdId = await one(ev, buyers[3]!);
      const pmt = await checkout(buyers[3]!, holdId);
      const hook = (await sim(e).settle(pmt.provider_order_id, 'success'))!;
      advance(10 * 60_000);
      await Promise.all([deliver(hook), expireDueHolds(e.ctx), expireDueHolds(e.ctx)]);
      const made = (await orders(ev.id)).length;
      const refunds = (await e.ctx.pool.query(`SELECT 1 FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.provider_order_id = $1`, [pmt.provider_order_id])).rowCount;
      expect(made + (refunds ?? 0), `round ${round}`).toBe(1);
      setClock(null);
    }
    await expectClean(e);
  });
});

describe('reconciliation', () => {
  it('finds a payment whose webhook never arrived', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const holdId = await one(ev, buyers[6]!);
    const pmt = await checkout(buyers[6]!, holdId);
    await sim(e).settle(pmt.provider_order_id, 'success'); // the gateway took the money; the webhook is "lost"
    expect(await orders(ev.id)).toHaveLength(0);
    advance(5 * 60_000);
    const report = await reconcile(e.ctx);
    expect(report.settled).toBeGreaterThanOrEqual(1);
    expect(await orders(ev.id)).toHaveLength(1);
    expect((await reconcile(e.ctx)).settled).toBe(0); // running it again changes nothing
  });

  it('a refund the gateway rejected stays PENDING and is finished on the next run', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5, price_paise: 30_000 }] });
    const p = buyers[7]!;
    const orderId = await pay(e, p, await one(ev, p));
    const spy = vi.spyOn(e.ctx.provider, 'refund').mockRejectedValueOnce(new Error('gateway down'));
    const cancel = await p.call('POST', `/api/orders/${orderId}/cancel`);
    expect(cancel.status).toBe(200);
    expect((await e.ctx.pool.query('SELECT status FROM refunds WHERE order_id = $1', [orderId])).rows[0].status).toBe('PENDING');
    const settled = await org.call('GET', `/api/organiser/events/${ev.id}`);
    expect(settled.body.invariants.ok).toBe(true); // we owe the money, and the books say so
    spy.mockRestore();
    expect((await reconcile(e.ctx)).refunds_finished).toBeGreaterThanOrEqual(1);
    expect((await e.ctx.pool.query('SELECT status FROM refunds WHERE order_id = $1', [orderId])).rows[0].status).toBe('DONE');
  });
});
