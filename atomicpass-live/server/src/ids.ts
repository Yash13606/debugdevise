import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `prefix_` plus 12 random lowercase base32 characters (a byte masked to 5 bits is unbiased). */
export function randomId(prefix: string): string {
  let s = '';
  for (const byte of randomBytes(12)) s += BASE32[byte & 31];
  return `${prefix}_${s}`;
}

/** A 128-bit secret as 22 base64url characters. */
export const randomToken = (): string => randomBytes(16).toString('base64url');

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret: string, data: string): string => createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time string comparison (both sides are hashed first, so the lengths always match). */
export const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

/** Indian mobile numbers only: accepts 9876543210, 09876543210, 919876543210, +91 98765 43210. Returns +919876543210. */
export function normalisePhone(raw: string): string {
  let d = raw.replace(/[\s\-()]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Enter a valid 10-digit Indian mobile number');
  }
  return `+91${d}`;
}

/** A signed, expiring pass the server can check without touching the database. */
export function signPass(secret: string, payload: Record<string, string | number>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmacHex(secret, body)}`;
}

/** The payload when the signature is genuine and the pass is not expired; otherwise null. */
export function verifyPass<T extends { x: number }>(secret: string, pass: string, now: number): T | null {
  const dot = pass.indexOf('.');
  if (dot < 1) return null;
  const body = pass.slice(0, dot);
  if (!safeEqual(pass.slice(dot + 1), hmacHex(secret, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
    return typeof payload.x === 'number' && payload.x > now ? payload : null;
  } catch {
    return null;
  }
}
