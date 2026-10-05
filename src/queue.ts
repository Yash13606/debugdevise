// The waiting room (ARCHITECTURE 4.6): first come, first admitted. An admission is consumed by the
// hold that uses it, inside that hold's transaction, so a refused hold leaves it untouched.
import { iso, now as clockNow } from './clock.js';
import { runTx, type Ctx, type Db } from './db.js';
import { AppError } from './errors.js';
import { normaliseEmail, randomId, randomToken } from './ids.js';

interface Entry {
  seq: number;
  event_id: string;
  email_norm: string;
  queue_token: string;
  status: 'WAITING' | 'ADMITTED' | 'USED' | 'EXPIRED';
  admit_expires_at: number | null;
}

/** What the buyer sees. An admission past its time reads as EXPIRED even before a tick records it. */
function view({ db, config }: Ctx, e: Entry, now: number) {
  const status = e.status === 'ADMITTED' && e.admit_expires_at! <= now ? 'EXPIRED' : e.status;
  const position =
    status === 'WAITING'
      ? (db
          .prepare(`SELECT COUNT(*) FROM queue_entries WHERE event_id = ? AND status = 'WAITING' AND seq <= ?`)
          .pluck()
          .get(e.event_id, e.seq) as number)
      : 0;
  return {
    status,
    position,
    ahead: Math.max(0, position - 1),
    eta_seconds: Math.ceil((Math.ceil(position / config.queueAdmitPerTick) * config.queueTickMs) / 1000),
    admit_expires_at: status === 'ADMITTED' ? iso(e.admit_expires_at!) : null,
  };
}

const expireAdmissions = (db: Db, eventId: string, now: number) =>
  db
    .prepare(`UPDATE queue_entries SET status = 'EXPIRED' WHERE event_id = ? AND status = 'ADMITTED' AND admit_expires_at <= ?`)
    .run(eventId, now);

/**
 * POST /api/events/:id/queue. A buyer with a live entry (WAITING or ADMITTED) gets it back unchanged;
 * otherwise a new entry goes to the back. Used and expired entries are kept, not replaced.
 */
export function join(ctx: Ctx, eventId: string, email: string) {
  const { db } = ctx;
  return runTx(db, () => {
    const now = clockNow();
    const event = db.prepare('SELECT queue_enabled FROM events WHERE id = ?').get(eventId) as { queue_enabled: number } | undefined;
    if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');
    if (!event.queue_enabled) throw new AppError('QUEUE_NOT_ENABLED', 409, 'This event has no waiting room');
    const emailNorm = normaliseEmail(email);
    expireAdmissions(db, eventId, now); // a lapsed admission must not block a fresh join

    let entry = db
      .prepare(`SELECT * FROM queue_entries WHERE event_id = ? AND email_norm = ? AND status IN ('WAITING', 'ADMITTED')`)
      .get(eventId, emailNorm) as Entry | undefined;
    const created = !entry;
    if (!entry) {
      const token = randomToken();
      db.prepare(
        `INSERT INTO queue_entries (id, event_id, email, email_norm, queue_token, status, joined_at)
         VALUES (?, ?, ?, ?, ?, 'WAITING', ?)`,
      ).run(randomId('que'), eventId, email.trim(), emailNorm, token, now);
      entry = db.prepare('SELECT * FROM queue_entries WHERE queue_token = ?').get(token) as Entry;
    }
    return { created, queue_token: entry.queue_token, ...view(ctx, entry, now) };
  });
}

/** GET /api/events/:id/queue: position, wait and, once admitted, the admission window. */
export function status(ctx: Ctx, eventId: string, token: string | undefined) {
  const { db } = ctx;
  return db.transaction(() => {
    const entry = token
      ? (db.prepare('SELECT * FROM queue_entries WHERE queue_token = ? AND event_id = ?').get(token, eventId) as Entry | undefined)
      : undefined;
    if (!entry) throw new AppError('FORBIDDEN', 403, 'Wrong queue token');
    const e = db.prepare('SELECT capacity, sold, held FROM events WHERE id = ?').get(eventId) as { capacity: number; sold: number; held: number };
    return { ...view(ctx, entry, clockNow()), sold_out: e.capacity - e.sold - e.held <= 0 };
  })();
}

/**
 * One admission tick for every event with the queue on: lapse old admissions, then admit the next
 * waiting entries in arrival order, at most QUEUE_ADMIT_PER_TICK and never more than
 * QUEUE_MAX_ADMITTED unused admissions at once. Returns how many were admitted.
 */
export function tick(ctx: Ctx): number {
  const { db, config } = ctx;
  return runTx(db, () => {
    const now = clockNow();
    let admitted = 0;
    for (const eventId of db.prepare('SELECT id FROM events WHERE queue_enabled = 1').pluck().all() as string[]) {
      expireAdmissions(db, eventId, now);
      const active = db
        .prepare(`SELECT COUNT(*) FROM queue_entries WHERE event_id = ? AND status = 'ADMITTED'`)
        .pluck()
        .get(eventId) as number;
      const n = Math.min(config.queueAdmitPerTick, config.queueMaxAdmitted - active);
      if (n > 0) {
        admitted += db
          .prepare(
            `UPDATE queue_entries SET status = 'ADMITTED', admitted_at = ?, admit_expires_at = ?
              WHERE seq IN (SELECT seq FROM queue_entries WHERE event_id = ? AND status = 'WAITING' ORDER BY seq LIMIT ?)`,
          )
          .run(now, now + config.queueAdmitTtlSeconds * 1000, eventId, n).changes;
      }
    }
    return admitted;
  });
}

/**
 * Use the admission for one hold (ARCHITECTURE 4.6, "Consume"). One conditional UPDATE decides;
 * otherwise 403 NOT_ADMITTED with the reason. Runs inside the reservation transaction.
 */
export function consume(db: Db, eventId: string, token: string | undefined, emailNorm: string, now: number): string {
  const won = token
    ? (db
        .prepare(
          `UPDATE queue_entries SET status = 'USED', used_at = ?
            WHERE queue_token = ? AND event_id = ? AND status = 'ADMITTED' AND admit_expires_at > ? AND email_norm = ?
            RETURNING id`,
        )
        .get(now, token, eventId, now, emailNorm) as { id: string } | undefined)
    : undefined;
  if (won) return won.id;

  const row = token
    ? (db.prepare('SELECT status, email_norm FROM queue_entries WHERE queue_token = ? AND event_id = ?').get(token, eventId) as
        | { status: Entry['status']; email_norm: string }
        | undefined)
    : undefined;
  const reason = !row
    ? 'UNKNOWN_TOKEN'
    : row.email_norm !== emailNorm
      ? 'EMAIL_MISMATCH'
      : row.status === 'WAITING'
        ? 'WAITING'
        : row.status === 'USED'
          ? 'USED'
          : 'EXPIRED'; // ADMITTED but past its time, or already recorded as EXPIRED
  throw new AppError('NOT_ADMITTED', 403, 'You have not been admitted yet', { reason });
}
