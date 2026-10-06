// Rush test against a running server. Start the server with RATE_LIMIT=false (the limits would, rightly, stop this):
//   RATE_LIMIT=false npm start        then      npm run load
// Settings (env): BASE (default http://127.0.0.1:3100), BUYERS (5000), SEATS (4500), CONCURRENCY (400), PAY (1 = also pay every winner), ADMIN_KEY.
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const BUYERS = Number(process.env.BUYERS ?? 5000);
const SEATS = Number(process.env.SEATS ?? 4500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 400);
const PAY = (process.env.PAY ?? '1') === '1';
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'dev-admin-key';

interface Res {
  status: number;
  body: any;
  ms: number;
}

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const t0 = performance.now();
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, ms: performance.now() - t0 };
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pmap<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!) : 0;
};
const phone = (n: number) => String(9_200_000_000 + n);

async function signIn(phoneNo: string, name: string) {
  const otp = await call('POST', '/api/auth/otp', undefined, { phone: phoneNo });
  if (otp.status !== 200) throw new Error(`otp failed (${otp.status}): ${JSON.stringify(otp.body)} - is the server running with RATE_LIMIT=false and DEMO_OTP on?`);
  const v = await call('POST', '/api/auth/verify', undefined, { phone: phoneNo, otp: otp.body.demo_otp, name });
  return v.body.token as string;
}

console.log(`Rush test: ${BUYERS} buyers, ${SEATS} seats, server ${BASE}`);
const seed = Date.now() % 100_000;

const orgToken = await signIn(phone(seed), 'Load Organiser');
await call('POST', '/api/me/organiser', orgToken, { org_name: 'Load Test' });
const created = await call('POST', '/api/organiser/events', orgToken, {
  name: `Rush ${new Date().toISOString()}`,
  starts_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  tiers: [{ name: 'Entry', price_paise: 49_900, capacity: SEATS, max_per_order: 4 }],
});
if (created.status !== 201) throw new Error(`could not create the event: ${JSON.stringify(created.body)}`);
const eventId = created.body.event.id as string;
const tierId = (await call('GET', `/api/events/${eventId}`)).body.tiers[0].id as string;

let t0 = performance.now();
const tokens = await pmap(Array.from({ length: BUYERS }, (_, i) => i), 100, (i) => signIn(phone(seed * 10 + i + 1_000), `Buyer ${i}`));
console.log(`signed in ${BUYERS} buyers in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

t0 = performance.now();
const holds = await pmap(tokens, CONCURRENCY, (tok) => call('POST', `/api/events/${eventId}/holds`, tok, { items: [{ tier_id: tierId, quantity: 1 }] }));
const rushSeconds = (performance.now() - t0) / 1000;
const won = holds.filter((h) => h.status === 201);
const refused = holds.filter((h) => h.status !== 201);
const byCode: Record<string, number> = {};
for (const h of refused) byCode[h.body?.error?.code ?? `HTTP ${h.status}`] = (byCode[h.body?.error?.code ?? `HTTP ${h.status}`] ?? 0) + 1;
const lat = holds.map((h) => h.ms);

console.log(`\nRUSH: ${won.length} holds, ${refused.length} refused ${JSON.stringify(byCode)}`);
console.log(`      ${rushSeconds.toFixed(2)} s for all ${BUYERS} requests = ${Math.round(BUYERS / rushSeconds)} requests/s`);
console.log(`      latency p50 ${pct(lat, 50)} ms, p95 ${pct(lat, 95)} ms, p99 ${pct(lat, 99)} ms, max ${pct(lat, 100)} ms`);

let paid = 0;
let payResult: Record<string, number> | undefined;
if (PAY) {
  t0 = performance.now();
  const winners = holds.map((h, i) => ({ h, tok: tokens[i]! })).filter((x) => x.h.status === 201);
  const outcomes = await pmap(winners, 200, async ({ h, tok }) => {
    const co = await call('POST', `/api/holds/${h.body.hold.id}/checkout`, tok);
    const g = await call('POST', `/api/sim-gateway/orders/${co.body.payment.provider_order_id}/pay`, undefined, { outcome: 'success' });
    return { co: co.ms, g: g.ms, ok: g.status === 200 };
  });
  paid = outcomes.filter((o) => o.ok).length;
  const secs = (performance.now() - t0) / 1000;
  payResult = { paid, seconds: Number(secs.toFixed(2)), checkout_p95_ms: pct(outcomes.map((o) => o.co), 95), payment_p95_ms: pct(outcomes.map((o) => o.g), 95) };
  console.log(`PAY:  ${paid} of ${winners.length} paid in ${secs.toFixed(1)} s (${Math.round(paid / secs)} payments/s), checkout p95 ${payResult.checkout_p95_ms} ms, payment+webhook p95 ${payResult.payment_p95_ms} ms`);
}

const stats = await call('GET', `/api/organiser/events/${eventId}`, orgToken);
const audit = await call('GET', `/api/admin/invariants?event_id=${eventId}`, undefined, undefined, { 'x-admin-key': ADMIN_KEY });
const ev = stats.body.event;
const oversold = ev.sold + ev.held - ev.capacity;
console.log(`\nEVENT: capacity ${ev.capacity}, sold ${ev.sold}, held ${ev.held}, available ${ev.available}`);
console.log(`AUDIT: ${audit.body.ok ? 'clean (every counter recomputed from the records matches)' : 'MISMATCHES ' + JSON.stringify(audit.body.mismatches.slice(0, 5))}`);
const pass = won.length === Math.min(SEATS, BUYERS) && oversold <= 0 && audit.body.ok && (!PAY || paid === won.length);
console.log(pass ? '\nPASS: exactly as many winners as seats, nothing oversold, audit clean.' : '\nFAIL: see above.');

mkdirSync('.data', { recursive: true });
writeFileSync('.data/load-last.json', JSON.stringify({ at: new Date().toISOString(), buyers: BUYERS, seats: SEATS, concurrency: CONCURRENCY, won: won.length, refused: byCode, rush_seconds: Number(rushSeconds.toFixed(2)), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), pay: payResult, audit_ok: audit.body.ok, pass }, null, 2));
process.exit(pass ? 0 : 1);
