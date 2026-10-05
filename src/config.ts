import { existsSync } from 'node:fs';

export interface Config {
  port: number;
  databasePath: string;
  holdTtlSeconds: number;
  holdSweepIntervalMs: number;
  defaultMaxPerOrder: number;
  maxTicketsPerBuyer: number;
  queueTickMs: number;
  queueAdmitPerTick: number;
  queueMaxAdmitted: number;
  queueAdmitTtlSeconds: number;
  adminApiKey: string;
  gateApiKey: string;
  paymentMode: 'mock';
  currency: string;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

function str(env: Env, name: string, def: string): string {
  const v = env[name];
  if (v === undefined) return def;
  if (v.trim() === '') throw new Error(`${name} must not be empty`);
  return v.trim();
}

/** An integer in [min, max]; unset means the default, anything unparsable stops startup. */
function int(env: Env, name: string, def: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = env[name];
  if (v === undefined) return def;
  const n = v.trim() === '' ? NaN : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(v)}`);
  }
  return n;
}

/** Parse settings (ARCHITECTURE section 6). Every setting has a default; an invalid value throws. */
export function loadConfig(env: Env = process.env): Config {
  const paymentMode = str(env, 'PAYMENT_MODE', 'mock');
  if (paymentMode !== 'mock') throw new Error(`PAYMENT_MODE must be "mock", got ${JSON.stringify(paymentMode)}`);
  const logLevel = str(env, 'LOG_LEVEL', 'info');
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  return {
    port: int(env, 'PORT', 3000, 0, 65535),
    databasePath: str(env, 'DATABASE_PATH', './data/atomicpass.db'),
    holdTtlSeconds: int(env, 'HOLD_TTL_SECONDS', 600, 1),
    holdSweepIntervalMs: int(env, 'HOLD_SWEEP_INTERVAL_MS', 5000, 0),
    defaultMaxPerOrder: int(env, 'DEFAULT_MAX_PER_ORDER', 6, 1),
    maxTicketsPerBuyer: int(env, 'MAX_TICKETS_PER_BUYER', 4, 0),
    queueTickMs: int(env, 'QUEUE_TICK_MS', 2000, 0),
    queueAdmitPerTick: int(env, 'QUEUE_ADMIT_PER_TICK', 25, 1),
    queueMaxAdmitted: int(env, 'QUEUE_MAX_ADMITTED', 100, 1),
    queueAdmitTtlSeconds: int(env, 'QUEUE_ADMIT_TTL_SECONDS', 120, 1),
    adminApiKey: str(env, 'ADMIN_API_KEY', 'change-me-admin'),
    gateApiKey: str(env, 'GATE_API_KEY', 'change-me-gate'),
    paymentMode,
    currency: str(env, 'CURRENCY', 'INR'),
    logLevel,
  };
}

/** Load ./.env when it exists. Variables already in the environment win (loadEnvFile never overwrites them). */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
