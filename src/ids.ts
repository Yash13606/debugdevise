import { createHash, randomBytes } from 'node:crypto';
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const invalid = () => new AppError('VALIDATION_ERROR', 400, 'A valid email address is required');

/**
 * Rule N1: trim and lowercase; drop everything from `+` in the local part; for gmail.com and
 * googlemail.com also drop dots from the local part. Throws VALIDATION_ERROR for a bad address.
 */
export function normaliseEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !EMAIL.test(e)) throw invalid();
  const at = e.indexOf('@');
  let local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replaceAll('.', '');
  if (!local) throw invalid();
  return `${local}@${domain}`;
}
