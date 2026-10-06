import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import type { Config } from './config.js';
import { AppError } from './errors.js';

// BIGINT (epoch ms, COUNT) and NUMERIC (SUM) come back as numbers; every value here is far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Pool = pg.Pool;
export type Conn = pg.PoolClient;
/** Anything that can run a query: the pool or a transaction's connection. */
export type Q = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, max: number): Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  pool.on('error', () => {}); // an idle client dropping must not crash the process; the next query reconnects
  return pool;
}

export async function one<T>(q: Q, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q.query(sql, params)).rows[0] as T | undefined;
}

export async function all<T>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q.query(sql, params)).rows as T[];
}

/** First column of the first row (COUNT, SUM, EXISTS). */
export async function scalar<T = number>(q: Q, sql: string, params: unknown[] = []): Promise<T> {
  const r = await q.query({ text: sql, values: params, rowMode: 'array' });
  return r.rows[0]![0] as T;
}

export type After = (fn: () => Promise<void> | void) => void;
const RETRYABLE = new Set(['40P01', '40001']); // deadlock detected, serialization failure
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` in one transaction (READ COMMITTED; every rule is a guarded UPDATE, so no stronger isolation is needed).
 * Throwing rolls back. Returning an AppError commits, then throws it: use that for a refusal that must persist.
 * `after` queues work (cache invalidation, Redis give-back) that runs only once the commit succeeded.
 * A deadlock is retried: it can only mean two transactions took locks in different orders, and the retry is safe
 * because nothing from the failed attempt survived.
 */
export async function withTx<T>(pool: Pool, fn: (c: Conn, after: After) => Promise<T | AppError>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const c = await pool.connect();
    const afters: (() => Promise<void> | void)[] = [];
    let result: T | AppError;
    try {
      await c.query('BEGIN');
      result = await fn(c, (f) => void afters.push(f));
      await c.query('COMMIT');
    } catch (err) {
      try {
        await c.query('ROLLBACK');
        c.release();
      } catch {
        c.release(true);
      }
      if (attempt < 4 && RETRYABLE.has((err as { code?: string }).code ?? '')) {
        await sleep(5 * attempt + Math.random() * 10);
        continue;
      }
      throw err;
    }
    c.release();
    for (const f of afters) {
      try {
        await f();
      } catch {
        // best effort: the database already has the truth
      }
    }
    if (result instanceof AppError) throw result;
    return result;
  }
}

/** Create or upgrade the schema from server/migrations/*.sql. An advisory lock lets several processes start together. */
export async function migrate(pool: Pool, dir = new URL('../migrations/', import.meta.url)): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727274)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r: { name: string }) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(new URL(file, dir), 'utf8'));
        await c.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [file, Date.now()]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}

/** What every operation needs. */
export interface Ctx {
  pool: Pool;
  config: Config;
  redis: import('./redis.js').RedisLike;
  gate: import('./gate.js').FastGate;
  cache: import('./cache.js').Cache;
  metrics: import('./metrics.js').Metrics;
  qr: import('./qr.js').QrKeys;
  provider: import('./payments/provider.js').PaymentProvider;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
}
