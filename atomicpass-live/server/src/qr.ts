// Signed tickets. The QR carries the ticket's own facts (id, event, ticket type, seat) and an Ed25519 signature.
// A gate device holding only the PUBLIC key can tell a genuine ticket from a forged one with no network. The private
// key never leaves the server, so a stolen scanner cannot mint tickets. One-time use still needs the server (or a
// later sync): two offline devices can both admit the same ticket, and the sync flags the second.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const SIGNED_PREFIX = 'AP2:';

export interface QrKeys {
  priv: KeyObject;
  pub: KeyObject;
  /** The raw 32-byte public key, base64url: what a gate device stores. */
  publicKey: string;
}

export interface TicketFacts {
  t: string; // ticket id
  e: string; // event id
  n: string; // ticket type name
  s: string | null; // seat label
}

export function makeQrKeys(seed: string): QrKeys {
  const raw = createHash('sha256').update(seed).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  return { priv, pub, publicKey: pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') };
}

export function signTicket(keys: QrKeys, facts: TicketFacts): string {
  const body = Buffer.from(JSON.stringify(facts)).toString('base64url');
  return `${SIGNED_PREFIX}${body}.${sign(null, Buffer.from(body), keys.priv).toString('base64url')}`;
}

/** The ticket's facts when the signature is genuine; null for anything else. */
export function verifyTicket(keys: QrKeys, qr: string): TicketFacts | null {
  if (!qr.startsWith(SIGNED_PREFIX)) return null;
  const rest = qr.slice(SIGNED_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 1) return null;
  const body = rest.slice(0, dot);
  try {
    if (!verify(null, Buffer.from(body), keys.pub, Buffer.from(rest.slice(dot + 1), 'base64url'))) return null;
    const f = JSON.parse(Buffer.from(body, 'base64url').toString()) as TicketFacts;
    return typeof f.t === 'string' && typeof f.e === 'string' ? f : null;
  } catch {
    return null;
  }
}
