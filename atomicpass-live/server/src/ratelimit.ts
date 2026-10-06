// Fixed-window rate limiter on Redis INCR. Fails open: if Redis is unreachable nobody is blocked.
import type { Ctx } from './db.js';
import { AppError } from './errors.js';

/** Allow `max` calls per `windowSec` for `scope`+`id`; the next one throws 429 with how long to wait. */
export async function limit(ctx: Ctx, scope: string, id: string, max: number, windowSec: number): Promise<void> {
  if (!ctx.config.rateLimitEnabled) return;
  const window = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rl:${scope}:${id}:${window}`;
  let n: number;
  try {
    n = await ctx.redis.incr(key);
    if (n === 1) await ctx.redis.pexpire(key, windowSec * 1000);
  } catch {
    ctx.metrics.inc('ratelimit_errors_total');
    return;
  }
  if (n > max) {
    ctx.metrics.inc('ratelimit_blocked_total', { scope });
    const retry = Math.max(1, Math.ceil(((window + 1) * windowSec * 1000 - Date.now()) / 1000));
    throw new AppError('RATE_LIMITED', 429, 'Too many requests, slow down', { retry_after_seconds: retry });
  }
}
