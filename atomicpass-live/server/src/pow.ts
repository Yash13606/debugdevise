// A small proof-of-work challenge at queue join. It is a free stand-in for a CAPTCHA: the browser must spend a little
// computation (about a few thousand hashes at the default setting) before it may join, which is nothing to one person
// and a real cost to a script joining thousands of times. A solved challenge works once (Redis NX), is tied to one buyer and
// one event, and expires. It does not stop a determined attacker with many machines; rate limits and the phone login
// are the other layers.
import { createHash } from 'node:crypto';
import type { Ctx } from './db.js';
import { AppError } from './errors.js';
import { randomToken, sha256, signPass, verifyPass } from './ids.js';
import { now as clockNow } from './clock.js';

const TTL_MS = 120_000;

interface Challenge {
  u: string;
  e: string;
  r: string;
  x: number;
}

export function issueChallenge(ctx: Ctx, userId: string, eventId: string) {
  const bits = ctx.config.joinPowBits;
  return {
    bits,
    challenge: bits > 0 ? signPass(ctx.config.passSecret, { u: userId, e: eventId, r: randomToken(), x: clockNow() + TTL_MS }) : null,
    expires_in_seconds: TTL_MS / 1000,
  };
}

export const leadingZeroBits = (digest: Buffer): number => {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
};

/** True when sha256(challenge + ":" + nonce) starts with at least `bits` zero bits. */
export const solves = (challenge: string, nonce: string, bits: number): boolean =>
  leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= bits;

/** Throws POW_REQUIRED (428) with a fresh challenge unless a valid, unused, unexpired solution is given. */
export async function requirePow(ctx: Ctx, userId: string, eventId: string, pow?: { challenge: string; nonce: string }): Promise<void> {
  const bits = ctx.config.joinPowBits;
  if (bits === 0) return;
  const refuse = (reason: string) => new AppError('POW_REQUIRED', 428, 'Solve the challenge to join the waiting room', { reason, ...issueChallenge(ctx, userId, eventId) });
  if (!pow) throw refuse('MISSING');
  const c = verifyPass<Challenge>(ctx.config.passSecret, pow.challenge, clockNow());
  if (!c || c.u !== userId || c.e !== eventId) throw refuse('INVALID');
  if (!solves(pow.challenge, String(pow.nonce), bits)) throw refuse('WRONG');
  try {
    if ((await ctx.redis.set(`pow:${sha256(pow.challenge)}`, '1', 'PX', TTL_MS, 'NX')) === null) throw refuse('USED');
  } catch (e) {
    if (e instanceof AppError) throw e; // Redis down: fail open
  }
}
