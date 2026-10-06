import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import pg from 'pg';
import { expect } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { setClock } from '../src/clock.js';
import type { Ctx } from '../src/db.js';
import { buildApp } from '../src/http.js';
import { checkInvariants } from '../src/invariants.js';
import { createCtx } from '../src/runtime.js';
import type { SimulatedProvider } from '../src/payments/simulated.js';
import { solves } from '../src/pow.js';

export interface Env {
  ctx: Ctx;
  app: FastifyInstance;
  dbUrl: string;
  config: Config;
  close: () => Promise<void>;
}

const baseEnv = { LOG_LEVEL: process.env.TEST_LOG ?? 'silent', RATE_LIMIT: 'false', CACHE_TTL_MS: '0', HOLD_SWEEP_INTERVAL_MS: '0', QUEUE_TICK_MS: '0', GATE_HEAL_MS: '0', RECONCILE_INTERVAL_MS: '0', DB_POOL_MAX: '40' };

/** A fresh database in the shared test server, with the app wired to it. `env` overrides settings like the real env vars. */
export async function makeEnv(env: Record<string, string> = {}): Promise<Env> {
  const admin = new pg.Pool({ connectionString: inject('pgUrl'), max: 1 });
  const name = `t_${Math.random().toString(36).slice(2, 10)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const dbUrl = inject('pgUrl').replace(/\/postgres$/, `/${name}`);
  const config = loadConfig({ ...baseEnv, ...env });
  const { ctx, close } = await createCtx(config, dbUrl);
  const app = buildApp(ctx);
  await app.ready();
  return {
    ctx,
    app,
    dbUrl,
    config,
    close: async () => {
      setClock(null);
      await app.close();
      await close();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** A second app on the same database with its own connections: what a second server process looks like. */
export async function secondApp(e: Env): Promise<{ app: FastifyInstance; ctx: Ctx; close: () => Promise<void> }> {
  const { ctx, close } = await createCtx(e.config, e.dbUrl);
  const app = buildApp(ctx);
  await app.ready();
  return { app, ctx, close: async () => { await app.close(); await close(); } };
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export type Api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;

/** An API caller bound to one app and (optionally) one signed-in user. */
export function api(app: FastifyInstance, token?: string): Api {
  return async (method, url, body, headers = {}) => {
    const r = await app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: body === undefined ? undefined : (body as object) });
    const json = String(r.headers['content-type'] ?? '').includes('json');
    return { status: r.statusCode, body: r.body && json ? JSON.parse(r.body) : r.body };
  };
}

/** The n-th test phone number: 10 digits starting with 9. */
export const phoneOf = (n: number) => String(9_100_000_000 + n);

export interface Person {
  token: string;
  id: string;
  phone: string;
  call: Api;
}

/** Sign in through the real OTP flow (the demo returns the code). */
export async function login(app: FastifyInstance, phone: string, name = 'Test Person'): Promise<Person> {
  const anon = api(app);
  const otp = await anon('POST', '/api/auth/otp', { phone });
  expect(otp.status).toBe(200);
  const v = await anon('POST', '/api/auth/verify', { phone, otp: otp.body.demo_otp, name });
  expect(v.status).toBe(200);
  return { token: v.body.token, id: v.body.user.id, phone: v.body.user.phone, call: api(app, v.body.token) };
}

export async function makeOrganiser(app: FastifyInstance, n = 900): Promise<Person> {
  const p = await login(app, phoneOf(n), 'Organiser');
  const r = await p.call('POST', '/api/me/organiser', { org_name: 'Test Productions' });
  expect(r.status).toBe(200);
  return p;
}

export interface TierSpec {
  name?: string;
  price_paise?: number;
  capacity?: number;
  max_per_order?: number;
  seated?: { rows: number; seats_per_row: number };
  sale_starts_at?: string;
  sale_ends_at?: string;
}

/** Create an event through the organiser API. Returns the event and its tiers. */
export async function makeEvent(org: Person, over: { name?: string; capacity?: number; queue_enabled?: boolean; starts_at?: string; tiers?: TierSpec[] } = {}) {
  const r = await org.call('POST', '/api/organiser/events', {
    name: over.name ?? 'Test Event',
    starts_at: over.starts_at ?? new Date(Date.now() + 10 * 86_400_000).toISOString(),
    capacity: over.capacity,
    queue_enabled: over.queue_enabled,
    tiers: (over.tiers ?? [{ capacity: 10 }]).map((t, i) => ({ name: t.name ?? `Tier ${i + 1}`, price_paise: t.price_paise ?? 100_00, max_per_order: t.max_per_order ?? 10, ...t })),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const view = await org.call('GET', `/api/events/${r.body.event.id}`);
  return { id: r.body.event.id as string, tiers: view.body.tiers as { id: string; name: string; capacity: number; seated: boolean }[] };
}

/** Hold quantity seats of the first tier (or a given item list). */
export const hold = (p: Person, eventId: string, items: { tier_id: string; quantity?: number; seat_ids?: string[] }[], extra: Record<string, unknown> = {}) =>
  p.call('POST', `/api/events/${eventId}/holds`, { items, ...extra });

/** Checkout then complete the simulated payment. Returns the final hold view's order id. */
export async function pay(e: Env, p: Person, holdId: string, outcome: 'success' | 'failure' = 'success'): Promise<string | null> {
  const co = await p.call('POST', `/api/holds/${holdId}/checkout`);
  expect([200, 201], JSON.stringify(co.body)).toContain(co.status);
  if (co.body.order_id) return co.body.order_id;
  const g = await api(e.app)('POST', `/api/sim-gateway/orders/${co.body.payment.provider_order_id}/pay`, { outcome });
  expect(g.status, JSON.stringify(g.body)).toBe(200);
  const h = await p.call('GET', `/api/holds/${holdId}`);
  return h.body.hold.order_id;
}

export const sim = (e: Env) => e.ctx.provider as SimulatedProvider;

/** The audit must be clean: run after every test that changes data. */
export async function expectClean(e: Env | { ctx: Ctx }) {
  const r = await checkInvariants(e.ctx.pool);
  expect(r.mismatches).toEqual([]);
}

/** Solve a proof-of-work challenge the way a browser would. */
export function solvePow(challenge: string, bits: number): string {
  for (let n = 0; ; n++) if (solves(challenge, String(n), bits)) return String(n);
}

/** Join the waiting room: fetch the challenge, solve it, join. */
export async function joinQueue(p: Person, eventId: string) {
  const c = await p.call('GET', `/api/events/${eventId}/queue/challenge`);
  const pow = c.body.challenge ? { challenge: c.body.challenge as string, nonce: solvePow(c.body.challenge, c.body.bits) } : undefined;
  return p.call('POST', `/api/events/${eventId}/queue`, pow ? { pow } : {});
}
