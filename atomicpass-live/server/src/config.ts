import { existsSync } from 'node:fs';

export interface Config {
  port: number;
  databaseUrl: string | null;
  dbPoolMax: number;
  redisUrl: string | null;
  holdTtlSeconds: number;
  payWindowSeconds: number;
  holdSweepIntervalMs: number;
  defaultMaxPerOrder: number;
  maxTicketsPerBuyer: number;
  queueTickMs: number;
  queueAdmitPerTick: number;
  queueMaxAdmitted: number;
  queueAdmitMultiplier: number;
  queueAdmitTtlSeconds: number;
  adminApiKey: string;
  webhookSecret: string;
  passSecret: string;
  qrSeed: string;
  joinPowBits: number;
  reminderLeadSeconds: number;
  demoOtp: boolean;
  otpTtlSeconds: number;
  sessionTtlDays: number;
  currency: string;
  cancelWindowHours: number;
  platformFeeBps: number;
  gstBps: number;
  cacheTtlMs: number;
  gateHealMs: number;
  fastGate: boolean;
  reconcileIntervalMs: number;
  reconcileAgeSeconds: number;
  rateLimitEnabled: boolean;
  trustProxy: boolean;
  seedDemo: boolean;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const DEV_SECRET = /^dev-/;

function str(env: Env, name: string, def: string): string {
  const v = env[name];
  if (v === undefined) return def;
  if (v.trim() === '') throw new Error(`${name} must not be empty`);
  return v.trim();
}

function opt(env: Env, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
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

function bool(env: Env, name: string, def: boolean): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return def;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(env[name])}`);
}

/** Parse settings. Every setting has a default; an invalid value throws. Production refuses the built-in dev secrets. */
export function loadConfig(env: Env = process.env): Config {
  const provider = str(env, 'PAYMENT_PROVIDER', 'simulated');
  if (provider !== 'simulated') throw new Error(`PAYMENT_PROVIDER must be "simulated", got ${JSON.stringify(provider)}`);
  const logLevel = str(env, 'LOG_LEVEL', 'info');
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  const production = env.NODE_ENV === 'production';
  const config: Config = {
    port: int(env, 'PORT', 3100, 0, 65535),
    databaseUrl: opt(env, 'DATABASE_URL'),
    dbPoolMax: int(env, 'DB_POOL_MAX', 20, 1, 500),
    redisUrl: opt(env, 'REDIS_URL'),
    holdTtlSeconds: int(env, 'HOLD_TTL_SECONDS', 600, 1),
    payWindowSeconds: int(env, 'PAY_WINDOW_SECONDS', 300, 1),
    holdSweepIntervalMs: int(env, 'HOLD_SWEEP_INTERVAL_MS', 5000, 0),
    defaultMaxPerOrder: int(env, 'DEFAULT_MAX_PER_ORDER', 6, 1),
    maxTicketsPerBuyer: int(env, 'MAX_TICKETS_PER_BUYER', 6, 0),
    queueTickMs: int(env, 'QUEUE_TICK_MS', 2000, 0),
    queueAdmitPerTick: int(env, 'QUEUE_ADMIT_PER_TICK', 25, 1),
    queueMaxAdmitted: int(env, 'QUEUE_MAX_ADMITTED', 100, 1),
    queueAdmitMultiplier: int(env, 'QUEUE_ADMIT_MULTIPLIER', 2, 1),
    queueAdmitTtlSeconds: int(env, 'QUEUE_ADMIT_TTL_SECONDS', 120, 1),
    adminApiKey: str(env, 'ADMIN_API_KEY', 'dev-admin-key'),
    webhookSecret: str(env, 'WEBHOOK_SECRET', 'dev-webhook-secret'),
    passSecret: str(env, 'PASS_SECRET', 'dev-pass-secret'),
    qrSeed: str(env, 'QR_SEED', 'dev-qr-seed'),
    joinPowBits: int(env, 'JOIN_POW_BITS', 12, 0, 28),
    reminderLeadSeconds: int(env, 'REMINDER_LEAD_SECONDS', 120, 0),
    demoOtp: bool(env, 'DEMO_OTP', true),
    otpTtlSeconds: int(env, 'OTP_TTL_SECONDS', 300, 1),
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 30, 1),
    currency: str(env, 'CURRENCY', 'INR'),
    cancelWindowHours: int(env, 'CANCEL_WINDOW_HOURS', 24, 0),
    platformFeeBps: int(env, 'PLATFORM_FEE_BPS', 500, 0, 10000),
    gstBps: int(env, 'GST_BPS', 1800, 0, 10000),
    cacheTtlMs: int(env, 'CACHE_TTL_MS', 1000, 0),
    gateHealMs: int(env, 'GATE_HEAL_MS', 5000, 0),
    fastGate: bool(env, 'GATE_ENABLED', true),
    reconcileIntervalMs: int(env, 'RECONCILE_INTERVAL_MS', 60000, 0),
    reconcileAgeSeconds: int(env, 'RECONCILE_AGE_SECONDS', 60, 0),
    rateLimitEnabled: bool(env, 'RATE_LIMIT', true),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    seedDemo: bool(env, 'SEED_DEMO', false),
    logLevel,
  };
  if (production) {
    for (const k of ['adminApiKey', 'webhookSecret', 'passSecret', 'qrSeed'] as const) {
      if (DEV_SECRET.test(config[k])) throw new Error(`Set a real ${k} for production (the built-in "dev-" value is public)`);
    }
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required in production');
  }
  return config;
}

/** Load ./.env when it exists. Variables already in the environment win (loadEnvFile never overwrites them). */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
