// A short read cache (Redis). Seat counts shown on pages may be up to CACHE_TTL_MS old and are cleared whenever
// they change; the hold path never reads from here, so a stale page can only show a number, never sell a seat.
import type { Metrics } from './metrics.js';
import type { RedisLike } from './redis.js';

export class Cache {
  constructor(
    private redis: RedisLike,
    private ttlMs: number,
    private metrics: Metrics,
  ) {}

  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return loader();
    try {
      const hit = await this.redis.get(key);
      if (hit !== null) {
        this.metrics.inc('cache_hits_total');
        return JSON.parse(hit) as T;
      }
    } catch {
      this.metrics.inc('cache_errors_total');
    }
    this.metrics.inc('cache_misses_total');
    const value = await loader();
    try {
      await this.redis.set(key, JSON.stringify(value), 'PX', this.ttlMs);
    } catch {
      this.metrics.inc('cache_errors_total');
    }
    return value;
  }

  async invalidate(...keys: string[]): Promise<void> {
    try {
      await this.redis.del(...keys);
    } catch {
      this.metrics.inc('cache_errors_total');
    }
  }
}

export const eventCacheKey = (eventId: string) => `ev:${eventId}`;
