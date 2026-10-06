// Phone login. The demo sends a random 6-digit code and, with DEMO_OTP on, also shows it in the response and the
// in-app inbox (there is no real SMS). Everything around it is the real mechanism: codes are stored hashed, expire,
// allow five tries, and are rate limited per phone and per IP; sessions are random tokens stored hashed.
import { randomBytes, randomInt } from 'node:crypto';
import { now as clockNow } from './clock.js';
import type { Ctx } from './db.js';
import { one, withTx } from './db.js';
import { AppError } from './errors.js';
import { normalisePhone, randomId, safeEqual, sha256 } from './ids.js';
import { enqueue } from './notify.js';
import { limit } from './ratelimit.js';

export interface User {
  id: string;
  phone: string;
  name: string;
  role: 'BUYER' | 'ORGANISER';
  org_name: string | null;
}

export const userJson = (u: User) => ({ id: u.id, phone: u.phone, name: u.name, role: u.role, org_name: u.org_name });

const MAX_TRIES = 5;
const codeHash = (phone: string, code: string) => sha256(`${phone}:${code}`);

export async function requestOtp(ctx: Ctx, rawPhone: string, ip: string) {
  const phone = normalisePhone(rawPhone);
  await limit(ctx, 'otp-ip', ip, 30, 600);
  await limit(ctx, 'otp-phone', phone, 5, 600);
  const code = String(randomInt(100000, 1000000));
  const now = clockNow();
  await withTx(ctx.pool, async (c) => {
    await c.query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, created_at) VALUES ($1, $2, $3, 0, $4)
       ON CONFLICT (phone) DO UPDATE SET code_hash = $2, expires_at = $3, attempts = 0, created_at = $4`,
      [phone, codeHash(phone, code), now + ctx.config.otpTtlSeconds * 1000, now],
    );
    await enqueue(c, phone, 'OTP', `Your AtomicPass code is ${code}. It is valid for ${Math.round(ctx.config.otpTtlSeconds / 60)} minutes.`);
  });
  return { phone, expires_in_seconds: ctx.config.otpTtlSeconds, ...(ctx.config.demoOtp ? { demo_otp: code } : {}) };
}

export async function verifyOtp(ctx: Ctx, rawPhone: string, code: string, name?: string) {
  const phone = normalisePhone(rawPhone);
  await limit(ctx, 'verify-phone', phone, 12, 600);
  const now = clockNow();
  const token = randomBytes(32).toString('base64url');
  const out = await withTx(ctx.pool, async (c) => {
    const row = await one<{ code_hash: string; expires_at: number; attempts: number }>(c, 'SELECT code_hash, expires_at, attempts FROM otp_codes WHERE phone = $1 FOR UPDATE', [phone]);
    if (!row || row.expires_at <= now) return new AppError('OTP_INVALID', 401, 'That code is wrong or has expired. Ask for a new one.');
    if (row.attempts >= MAX_TRIES) return new AppError('OTP_LOCKED', 429, 'Too many wrong tries. Ask for a new code.');
    if (!safeEqual(row.code_hash, codeHash(phone, code.trim()))) {
      await c.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = $1', [phone]);
      return new AppError('OTP_INVALID', 401, 'That code is wrong or has expired. Ask for a new one.'); // returned: the count commits
    }
    await c.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
    const cleanName = name?.trim().slice(0, 80) ?? '';
    let user = await one<User>(c, 'SELECT id, phone, name, role, org_name FROM users WHERE phone = $1', [phone]);
    const isNew = !user;
    if (!user) {
      user = (await one<User>(
        c,
        `INSERT INTO users (id, phone, name, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id, phone, name, role, org_name`,
        [randomId('usr'), phone, cleanName, now],
      ))!;
    } else if (cleanName && !user.name) {
      await c.query('UPDATE users SET name = $2 WHERE id = $1', [user.id, cleanName]);
      user = { ...user, name: cleanName };
    }
    await c.query('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256(token),
      user.id,
      now,
      now + ctx.config.sessionTtlDays * 86_400_000,
    ]);
    return { user, isNew };
  });
  return { token, user: userJson(out.user), is_new: out.isNew };
}

/** The user for a bearer token, or null. */
export async function authenticate(ctx: Ctx, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const u = await one<User>(
    ctx.pool,
    `SELECT u.id, u.phone, u.name, u.role, u.org_name FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > $2`,
    [sha256(token), clockNow()],
  );
  return u ?? null;
}

export async function logout(ctx: Ctx, token: string): Promise<void> {
  await ctx.pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function updateProfile(ctx: Ctx, userId: string, input: { name?: string }) {
  const name = input.name?.trim().slice(0, 80);
  if (name !== undefined) await ctx.pool.query('UPDATE users SET name = $2 WHERE id = $1', [userId, name]);
  return one<User>(ctx.pool, 'SELECT id, phone, name, role, org_name FROM users WHERE id = $1', [userId]).then((u) => userJson(u!));
}

/** Any signed-in buyer may become an organiser by naming their organisation (the demo has no vetting). */
export async function becomeOrganiser(ctx: Ctx, userId: string, orgName: string) {
  const name = orgName.trim().slice(0, 120);
  if (!name) throw new AppError('VALIDATION_ERROR', 400, 'Organisation name is required');
  const u = await one<User>(ctx.pool, `UPDATE users SET role = 'ORGANISER', org_name = $2 WHERE id = $1 RETURNING id, phone, name, role, org_name`, [userId, name]);
  return userJson(u!);
}

/** Housekeeping: drop sessions and codes that have expired. */
export async function purgeExpired(ctx: Ctx): Promise<void> {
  const now = clockNow();
  await ctx.pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
  await ctx.pool.query('DELETE FROM otp_codes WHERE expires_at <= $1', [now]);
}
