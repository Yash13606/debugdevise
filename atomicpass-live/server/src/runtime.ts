import { Cache } from './cache.js';
import type { Config } from './config.js';
import type { Ctx } from './db.js';
import { createPool, migrate } from './db.js';
import { FastGate } from './gate.js';
import { Metrics } from './metrics.js';
import { SimulatedProvider } from './payments/simulated.js';
import { makeQrKeys } from './qr.js';
import { connectRedis } from './redis.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

/** A small JSON logger honouring LOG_LEVEL (silent switches it off). */
function makeLog(level: string): Ctx['log'] {
  const min = LEVELS.indexOf(level);
  const out = (lvl: string) => (o: unknown, m?: string) => {
    if (level === 'silent' || LEVELS.indexOf(lvl) < min) return;
    console.log(JSON.stringify({ level: lvl, time: new Date().toISOString(), msg: m, ...(typeof o === 'object' && o ? o : { value: o }) }));
  };
  return { info: out('info'), warn: out('warn'), error: out('error') };
}

/** Connect everything the app needs. The database is migrated before this returns. */
export async function createCtx(config: Config, databaseUrl: string): Promise<{ ctx: Ctx; close: () => Promise<void>; redisIsReal: boolean }> {
  const log = makeLog(config.logLevel);
  const pool = createPool(databaseUrl, config.dbPoolMax);
  await migrate(pool);
  const metrics = new Metrics();
  const { redis, real } = connectRedis(config.redisUrl, (err) => log.warn({ err: err.message }, 'redis error (continuing without it)'));
  const ctx: Ctx = {
    pool,
    config,
    redis,
    metrics,
    log,
    gate: new FastGate(redis, pool, metrics, config.fastGate),
    cache: new Cache(redis, config.cacheTtlMs, metrics),
    qr: makeQrKeys(config.qrSeed),
    provider: new SimulatedProvider(pool, config.webhookSecret),
  };
  return {
    ctx,
    redisIsReal: real,
    close: async () => {
      await redis.quit().catch(() => {});
      await pool.end();
    },
  };
}
