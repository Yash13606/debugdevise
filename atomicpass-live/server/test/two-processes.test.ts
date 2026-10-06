// The multi-server gate: two real server processes (separate memory, separate connection pools) on one database,
// hit over real HTTP at the same time. The in-process Redis stand-in is not shared between them, so this also shows
// that the database, not the fast gate, decides.
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectClean, login, makeEnv, makeEvent, makeOrganiser, phoneOf, pay, hold, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
const procs: ChildProcess[] = [];
const ports = [41000 + Math.floor(Math.random() * 400), 41500 + Math.floor(Math.random() * 400)];
const base = (i: number) => `http://127.0.0.1:${ports[i]}`;

async function start(port: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: e.dbUrl, LOG_LEVEL: 'silent', RATE_LIMIT: 'false', CACHE_TTL_MS: '0', QUEUE_TICK_MS: '0', HOLD_SWEEP_INTERVAL_MS: '0', RECONCILE_INTERVAL_MS: '0', GATE_HEAL_MS: '0', DB_POOL_MAX: '30' },
    stdio: 'ignore',
  });
  procs.push(child);
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} did not start`);
}

const post = (i: number, path: string, token: string, body: unknown) =>
  fetch(base(i) + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeAll(async () => {
  e = await makeEnv();
  org = await makeOrganiser(e.app);
  await Promise.all(ports.map(start));
}, 120_000);
afterAll(async () => {
  procs.forEach((p) => p.kill());
  await expectClean(e);
  await e.close();
});

describe('two server processes on one database', () => {
  it('200 buyers split across both servers for 50 seats: exactly 50 win', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 50 }] });
    const crowd = await Promise.all(Array.from({ length: 200 }, (_, i) => login(e.app, phoneOf(800 + i))));
    const rs = await Promise.all(crowd.map((p, i) => post(i % 2, `/api/events/${ev.id}/holds`, p.token, { items: [{ tier_id: ev.tiers[0]!.id, quantity: 1 }] })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(50);
    expect(rs.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'SOLD_OUT')).toBe(true);
    expect((await org.call('GET', `/api/organiser/events/${ev.id}`)).body.event.held).toBe(50);
  }, 120_000);

  it('the same ticket scanned at both servers at once is admitted once', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const buyer = await login(e.app, phoneOf(790));
    const h = await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }]);
    const orderId = (await pay(e, buyer, h.body.hold.id))!;
    const qr = (await buyer.call('GET', `/api/orders/${orderId}`)).body.order.tickets[0].qr_payload;
    const scans = await Promise.all(Array.from({ length: 20 }, (_, i) => post(i % 2, '/api/gate/checkin', org.token, { qr, event_id: ev.id, gate: `G${i}` })));
    expect(scans.filter((s) => s.status === 200)).toHaveLength(1);
    expect(scans.filter((s) => s.status === 409).every((s) => s.body.error.code === 'ALREADY_CHECKED_IN')).toBe(true);
  }, 120_000);

  it('a payment started on one server can be completed through the other', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const buyer = await login(e.app, phoneOf(791));
    const h = await post(0, `/api/events/${ev.id}/holds`, buyer.token, { items: [{ tier_id: ev.tiers[0]!.id, quantity: 2 }] });
    const co = await post(0, `/api/holds/${h.body.hold.id}/checkout`, buyer.token, {});
    const pay1 = await post(1, `/api/sim-gateway/orders/${co.body.payment.provider_order_id}/pay`, buyer.token, { outcome: 'success', duplicate: true });
    expect(pay1.status).toBe(200);
    const orders = await e.ctx.pool.query('SELECT 1 FROM orders WHERE event_id = $1', [ev.id]);
    expect(orders.rowCount).toBe(1);
  }, 120_000);
});
