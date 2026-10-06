// The small slice of Redis this app uses, with the same call shapes as ioredis. With REDIS_URL set the real
// client is used (Upstash, Redis Cloud or any free tier); without it an in-process store stands in.
import { Redis } from 'ioredis';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  decrby(key: string, by: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

/** An in-process stand-in: same behaviour for the commands above, including expiry. One process only. */
export class MemoryRedis implements RedisLike {
  private store = new Map<string, { v: string; exp: number | null }>();

  private live(key: string) {
    const e = this.store.get(key);
    if (e && e.exp !== null && e.exp <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string) {
    return this.live(key)?.v ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]) {
    const nx = args.includes('NX');
    const px = args.indexOf('PX');
    if (nx && this.live(key)) return null;
    this.store.set(key, { v: String(value), exp: px >= 0 ? Date.now() + Number(args[px + 1]) : null });
    return 'OK' as const;
  }

  async del(...keys: string[]) {
    return keys.reduce((n, k) => n + (this.live(k) ? (this.store.delete(k), 1) : 0), 0);
  }

  async incrby(key: string, by: number) {
    const e = this.live(key);
    const next = (e ? Number(e.v) : 0) + by;
    this.store.set(key, { v: String(next), exp: e?.exp ?? null });
    return next;
  }

  incr = (key: string) => this.incrby(key, 1);
  decrby = (key: string, by: number) => this.incrby(key, -by);

  async pexpire(key: string, ms: number) {
    const e = this.live(key);
    if (!e) return 0;
    e.exp = Date.now() + ms;
    return 1;
  }

  async ping() {
    return 'PONG';
  }

  async quit() {
    this.store.clear();
  }
}

/** The real client when a URL is given (a failed connection never blocks sales: callers fail open), else the stand-in. */
export function connectRedis(url: string | null, onError: (err: Error) => void): { redis: RedisLike; real: boolean } {
  if (!url) return { redis: new MemoryRedis(), real: false };
  const client = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 1000, enableOfflineQueue: false });
  client.on('error', onError);
  return { redis: client as unknown as RedisLike, real: true };
}
