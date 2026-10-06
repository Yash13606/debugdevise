import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cache } from '../src/cache.js';
import { FastGate } from '../src/gate.js';
import { Metrics } from '../src/metrics.js';
import { MemoryRedis, type RedisLike } from '../src/redis.js';
import { Redis } from 'ioredis';
import { expectClean, hold, login, makeEnv, makeEvent, makeOrganiser, phoneOf, type Env, type Person } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The commands the app relies on, checked the same way against the stand-in and (when REDIS_URL is set) a real server. */
function contract(name: string, make: () => RedisLike, skip = false) {
  describe.skipIf(skip)(`redis commands: ${name}`, () => {
    const key = (k: string) => `test:${Math.random().toString(36).slice(2)}:${k}`;
    it('get / set / del', async () => {
      const r = make();
      const k = key('a');
      expect(await r.get(k)).toBeNull();
      expect(await r.set(k, 'x')).toBe('OK');
      expect(await r.get(k)).toBe('x');
      expect(await r.del(k)).toBe(1);
      expect(await r.del(k)).toBe(0);
      await r.quit();
    });
    it('NX only sets a missing key; PX expires', async () => {
      const r = make();
      const k = key('nx');
      expect(await r.set(k, '1', 'NX')).toBe('OK');
      expect(await r.set(k, '2', 'NX')).toBeNull();
      expect(await r.get(k)).toBe('1');
      const t = key('px');
      await r.set(t, 'v', 'PX', 60);
      expect(await r.get(t)).toBe('v');
      await sleep(120);
      expect(await r.get(t)).toBeNull();
      await r.del(k);
      await r.quit();
    });
    it('incr / incrby / decrby create missing keys at zero and go negative', async () => {
      const r = make();
      const k = key('n');
      expect(await r.incr(k)).toBe(1);
      expect(await r.incrby(k, 4)).toBe(5);
      expect(await r.decrby(k, 7)).toBe(-2);
      expect(await r.get(k)).toBe('-2');
      await r.del(k);
      await r.quit();
    });
    it('pexpire sets a lifetime on an existing key only', async () => {
      const r = make();
      const k = key('pe');
      expect(await r.pexpire(k, 50)).toBe(0);
      await r.set(k, '1');
      expect(await r.pexpire(k, 50)).toBe(1);
      await sleep(100);
      expect(await r.get(k)).toBeNull();
      await r.quit();
    });
    it('concurrent decrements never lose an update', async () => {
      const r = make();
      const k = key('c');
      await r.set(k, '100');
      const out = await Promise.all(Array.from({ length: 100 }, () => r.decrby(k, 1)));
      expect(new Set(out).size).toBe(100);
      expect(await r.get(k)).toBe('0');
      await r.del(k);
      await r.quit();
    });
  });
}

contract('in-process stand-in', () => new MemoryRedis());
contract('real server (REDIS_URL)', () => new Redis(process.env.REDIS_URL!) as unknown as RedisLike, !process.env.REDIS_URL);

let e: Env;
let org: Person;
let crowd: Person[];
beforeAll(async () => {
  e = await makeEnv();
  org = await makeOrganiser(e.app);
  crowd = await Promise.all(Array.from({ length: 50 }, (_, i) => login(e.app, phoneOf(600 + i))));
});
afterAll(async () => {
  await expectClean(e);
  await e.close();
});

const failing = (): RedisLike => {
  const boom = async () => {
    throw new Error('redis is down');
  };
  return { get: boom, set: boom, del: boom, incr: boom, incrby: boom, decrby: boom, pexpire: boom, ping: boom, quit: async () => {} } as RedisLike;
};

describe('the fast gate', () => {
  const lines = (tierId: string, quantity: number) => [{ tierId, quantity }];

  it('seeds from the database, refuses once the counter is spent, and gives seats back', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 3 }] });
    const gate = new FastGate(new MemoryRedis(), e.ctx.pool, new Metrics());
    const t = ev.tiers[0]!.id;
    const a = await gate.take(ev.id, lines(t, 2));
    expect(a.ok).toBe(true);
    const b = await gate.take(ev.id, lines(t, 2));
    expect(b).toMatchObject({ ok: false, scope: 'tier' });
    const c = await gate.take(ev.id, lines(t, 1));
    expect(c.ok).toBe(true);
    expect((await gate.take(ev.id, lines(t, 1))).ok).toBe(false);
    await gate.give([{ eventId: ev.id, tierId: t, quantity: 2 }]);
    expect((await gate.take(ev.id, lines(t, 2))).ok).toBe(true);
  });

  it('a refused multi-tier request leaves every counter as it was', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }, { capacity: 1 }] });
    const redis = new MemoryRedis();
    const gate = new FastGate(redis, e.ctx.pool, new Metrics());
    const r = await gate.take(ev.id, [{ tierId: ev.tiers[0]!.id, quantity: 3 }, { tierId: ev.tiers[1]!.id, quantity: 2 }]);
    expect(r.ok).toBe(false);
    // Tiers are tried in id order, so the refusing tier may come first and the other never be seeded: either way, nothing is spent.
    expect([null, '5']).toContain(await redis.get(`gate:t:${ev.tiers[0]!.id}`));
    expect([null, '1']).toContain(await redis.get(`gate:t:${ev.tiers[1]!.id}`));
    expect([null, '6']).toContain(await redis.get(`gate:e:${ev.id}`)); // untouched (or seeded, never spent)
  });

  it('heal raises a counter that fell below the truth, and never lowers one', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 10 }] });
    const t = ev.tiers[0]!.id;
    const redis = new MemoryRedis();
    const gate = new FastGate(redis, e.ctx.pool, new Metrics());
    await gate.take(ev.id, lines(t, 1)); // seeds and tracks the keys: now 9, but the database still says 10 free
    await redis.set(`gate:t:${t}`, '0'); // as after a process died between taking and committing
    expect(await gate.heal()).toBeGreaterThanOrEqual(1);
    expect(await redis.get(`gate:t:${t}`)).toBe('10');
    await redis.set(`gate:t:${t}`, '99'); // too high is harmless: the database would refuse
    await gate.heal();
    expect(await redis.get(`gate:t:${t}`)).toBe('99');
  });

  it('waves everyone through when Redis is down, and counts the errors', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 3 }] });
    const metrics = new Metrics();
    const gate = new FastGate(failing(), e.ctx.pool, metrics);
    const r = await gate.take(ev.id, lines(ev.tiers[0]!.id, 1));
    expect(r.ok).toBe(true);
    expect(metrics.get('gate_errors_total')).toBeGreaterThan(0);
    await gate.give([{ eventId: ev.id, tierId: ev.tiers[0]!.id, quantity: 1 }]); // must not throw
  });

  it('shields the database: with 50 buyers for 10 seats most refusals never reach it', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 10 }] });
    const before = e.ctx.metrics.get('gate_refusals_total', { scope: 'tier' });
    const rs = await Promise.all(crowd.map((p) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(10);
    expect(e.ctx.metrics.get('gate_refusals_total', { scope: 'tier' }) - before).toBe(40);
    await expectClean(e);
  });

  it('a false "sold out" from a too-low counter clears when heal runs', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const t = ev.tiers[0]!.id;
    expect((await hold(crowd[0]!, ev.id, [{ tier_id: t, quantity: 1 }])).status).toBe(201); // seeds the keys
    await e.ctx.redis.set(`gate:t:${t}`, '0');
    await e.ctx.redis.set(`gate:e:${ev.id}`, '0');
    expect((await hold(crowd[1]!, ev.id, [{ tier_id: t, quantity: 1 }])).body.error.code).toBe('SOLD_OUT'); // wrongly refused
    await e.ctx.gate.heal();
    expect((await hold(crowd[1]!, ev.id, [{ tier_id: t, quantity: 1 }])).status).toBe(201);
  });

  it('sales continue and never oversell when Redis fails mid-rush', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 10 }] });
    const real = { decrby: e.ctx.redis.decrby, incrby: e.ctx.redis.incrby, get: e.ctx.redis.get };
    e.ctx.redis.decrby = async () => {
      throw new Error('redis is down');
    };
    try {
      const rs = await Promise.all(crowd.map((p) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(10);
      expect(rs.filter((r) => r.status !== 201).every((r) => r.body.error.code === 'SOLD_OUT')).toBe(true);
    } finally {
      Object.assign(e.ctx.redis, real);
    }
    await expectClean(e);
  });
});

describe('the read cache', () => {
  it('serves a stored value until it expires or is invalidated', async () => {
    const metrics = new Metrics();
    const cache = new Cache(new MemoryRedis(), 80, metrics);
    let loads = 0;
    const load = async () => ({ n: ++loads });
    expect(await cache.getOrLoad('k', load)).toEqual({ n: 1 });
    expect(await cache.getOrLoad('k', load)).toEqual({ n: 1 });
    expect(metrics.get('cache_hits_total')).toBe(1);
    await cache.invalidate('k');
    expect(await cache.getOrLoad('k', load)).toEqual({ n: 2 });
    await sleep(120);
    expect(await cache.getOrLoad('k', load)).toEqual({ n: 3 });
  });

  it('falls back to loading when Redis is down', async () => {
    const cache = new Cache(failing(), 1000, new Metrics());
    expect(await cache.getOrLoad('k', async () => 'fresh')).toBe('fresh');
    await cache.invalidate('k'); // must not throw
  });

  it('a page can be briefly stale (never longer than the TTL), the hold path never reads it, and organiser edits clear it at once', async () => {
    const cached = await makeEnv({ CACHE_TTL_MS: '400' });
    try {
      const o = await makeOrganiser(cached.app);
      const ev = await makeEvent(o, { tiers: [{ capacity: 4 }] });
      const buyer = await login(cached.app, phoneOf(650));
      const page = () => buyer.call('GET', `/api/events/${ev.id}`).then((r) => r.body.event.available as number);
      expect(await page()).toBe(4);
      const h = await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 2 }]);
      expect(h.status).toBe(201);
      expect(await page()).toBe(4); // stale on purpose: a rush must not flush the cache on every hold
      await sleep(500);
      expect(await page()).toBe(2); // one TTL later it has caught up

      // Make the cached page lie (as if sold out): holds must still be decided by the database.
      const live = (await buyer.call('GET', `/api/events/${ev.id}`)).body;
      await cached.ctx.redis.set(`ev:${ev.id}`, JSON.stringify({ ...live, event: { ...live.event, available: 0 } }), 'PX', 5000);
      expect(await page()).toBe(0);
      expect((await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])).status).toBe(201);

      // An organiser change clears the page immediately.
      await o.call('POST', `/api/organiser/events/${ev.id}/tiers`, { name: 'Extra', price_paise: 100, capacity: 3 });
      expect(await page()).toBe(4); // 4 capacity + 3 new - 3 held
      await expectClean(cached);
    } finally {
      await cached.close();
    }
  });
});
