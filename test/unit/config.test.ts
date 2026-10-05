import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

// The defaults table of ARCHITECTURE section 6, written out by hand.
const DEFAULTS = {
  port: 3000,
  databasePath: './data/atomicpass.db',
  holdTtlSeconds: 600,
  holdSweepIntervalMs: 5000,
  defaultMaxPerOrder: 6,
  maxTicketsPerBuyer: 4,
  queueTickMs: 2000,
  queueAdmitPerTick: 25,
  queueMaxAdmitted: 100,
  queueAdmitTtlSeconds: 120,
  adminApiKey: 'change-me-admin',
  gateApiKey: 'change-me-gate',
  paymentMode: 'mock',
  currency: 'INR',
  logLevel: 'info',
};

describe('config', () => {
  it('runs on defaults alone (no environment, no .env)', () => {
    expect(loadConfig({})).toEqual(DEFAULTS);
  });

  it('reads overrides from the environment', () => {
    const c = loadConfig({
      HOLD_TTL_SECONDS: '2',
      MAX_TICKETS_PER_BUYER: '0',
      DATABASE_PATH: ':memory:',
      QUEUE_TICK_MS: '0',
    });
    expect(c).toMatchObject({
      holdTtlSeconds: 2,
      maxTicketsPerBuyer: 0,
      databasePath: ':memory:',
      queueTickMs: 0,
    });
  });

  it.each([
    ['HOLD_TTL_SECONDS', 'abc'],
    ['HOLD_TTL_SECONDS', '0'],
    ['HOLD_TTL_SECONDS', ''],
    ['PORT', '70000'],
    ['MAX_TICKETS_PER_BUYER', '-1'],
    ['DEFAULT_MAX_PER_ORDER', '1.5'],
    ['QUEUE_ADMIT_PER_TICK', '0'],
    ['PAYMENT_MODE', 'stripe'],
    ['LOG_LEVEL', 'loud'],
    ['ADMIN_API_KEY', ''],
  ])('stops startup on invalid %s=%j', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('.env.example lists all 15 settings and matches the defaults', () => {
    const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const env = Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '' && !line.startsWith('#'))
        .map((line) => line.split('=', 2) as [string, string]),
    );
    expect(Object.keys(env)).toHaveLength(15);
    expect(loadConfig(env)).toEqual(DEFAULTS);
  });
});
