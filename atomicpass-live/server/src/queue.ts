// The waiting room: first come, first admitted. Admissions are paced by what the event can actually sell (never
// more outstanding admissions than twice the seats left), and an admitted buyer holds a signed pass that the server
// can check without the database. The admission itself is consumed by the hold that uses it, inside that hold's
// transaction, so a refused hold leaves it untouched.
import { iso, now as clockNow } from './clock.js';
import type { Conn, Ctx } from './db.js';
import { one, scalar, withTx } from './db.js';
import { AppError } from './errors.js';
import { randomId, signPass, verifyPass } from './ids.js';

interface Entry {
  seq: number;
  id: string;
  event_id: string;
  user_id: string;
  status: 'WAITING' | 'ADMITTED' | 'USED' | 'EXPIRED';
  admit_expires_at: number | null;
}

interface Pass {
  q: string; // queue entry id
  u: string; // user id
  e: string; // event id
  x: number; // expiry, epoch ms
}

async function view(ctx: Ctx, c: Conn | Ctx['pool'], e: Entry, now: number) {
  const status = e.status === 'ADMITTED' && e.admit_expires_at! <= now ? 'EXPIRED' : e.status;
  const position = status === 'WAITING' ? await scalar(c, `SELECT COUNT(*) FROM queue_entries WHERE event_id = $1 AND status = 'WAITING' AND seq <= $2`, [e.event_id, e.seq]) : 0;
  const { queueAdmitPerTick, queueTickMs, passSecret } = ctx.config;
  return {
    status,
    position,
    ahead: Math.max(0, position - 1),
    eta_seconds: Math.ceil((Math.ceil(position / queueAdmitPerTick) * queueTickMs) / 1000),
    admit_expires_at: status === 'ADMITTED' ? iso(e.admit_expires_at!) : null,
    pass: status === 'ADMITTED' ? signPass(passSecret, { q: e.id, u: e.user_id, e: e.event_id, x: e.admit_expires_at! }) : null,
  };
}

const expireAdmissions = (c: Conn, eventId: string, now: number) =>
  c.query(`UPDATE queue_entries SET status = 'EXPIRED' WHERE event_id = $1 AND status = 'ADMITTED' AND admit_expires_at <= $2`, [eventId, now]);

/** A buyer with a live entry gets it back unchanged; otherwise a new entry goes to the back. */
export async function join(ctx: Ctx, userId: string, eventId: string) {
  return withTx(ctx.pool, async (c) => {
    const now = clockNow();
    const event = await one<{ queue_enabled: boolean; status: string }>(c, 'SELECT queue_enabled, status FROM events WHERE id = $1', [eventId]);
    if (!event) throw new AppError('NOT_FOUND', 404, 'Event not found');
    if (!event.queue_enabled) throw new AppError('QUEUE_NOT_ENABLED', 409, 'This event has no waiting room');
    await expireAdmissions(c, eventId, now); // a lapsed admission must not block a fresh join

    const cols = 'seq, id, event_id, user_id, status, admit_expires_at';
    const found = await one<Entry>(c, `SELECT ${cols} FROM queue_entries WHERE event_id = $1 AND user_id = $2 AND status IN ('WAITING', 'ADMITTED')`, [eventId, userId]);
    let entry = found;
    if (!entry) {
      entry = await one<Entry>(
        c,
        `INSERT INTO queue_entries (id, event_id, user_id, status, joined_at) VALUES ($1, $2, $3, 'WAITING', $4)
         ON CONFLICT (event_id, user_id) WHERE status IN ('WAITING', 'ADMITTED') DO NOTHING RETURNING ${cols}`,
        [randomId('que'), eventId, userId, now],
      );
      entry ??= (await one<Entry>(c, `SELECT ${cols} FROM queue_entries WHERE event_id = $1 AND user_id = $2 AND status IN ('WAITING', 'ADMITTED')`, [eventId, userId]))!;
    }
    return { created: !found, ...(await view(ctx, c, entry, now)) };
  });
}

/** The buyer's place: position, wait and, once admitted, the signed pass. */
export async function status(ctx: Ctx, userId: string, eventId: string) {
  const now = clockNow();
  const entry = await one<Entry>(
    ctx.pool,
    `SELECT seq, id, event_id, user_id, status, admit_expires_at FROM queue_entries WHERE event_id = $1 AND user_id = $2 ORDER BY seq DESC LIMIT 1`,
    [eventId, userId],
  );
  if (!entry) throw new AppError('NOT_IN_QUEUE', 404, 'You are not in the waiting room for this event');
  const ev = await one<{ capacity: number; sold: number; held: number }>(ctx.pool, 'SELECT capacity, sold, held FROM events WHERE id = $1', [eventId]);
  return { ...(await view(ctx, ctx.pool, entry, now)), sold_out: !ev || ev.capacity - ev.sold - ev.held <= 0 };
}

const TICK_LOCK = 727275;

/**
 * One admission tick for every event with the queue on: lapse old admissions, then admit the next waiting entries in
 * arrival order. How many: at most QUEUE_ADMIT_PER_TICK, and never so many that outstanding admissions exceed
 * QUEUE_MAX_ADMITTED or QUEUE_ADMIT_MULTIPLIER x the seats left. Only one process ticks at a time.
 */
export async function tick(ctx: Ctx): Promise<number> {
  const { config } = ctx;
  return withTx(ctx.pool, async (c) => {
    if (!(await scalar<boolean>(c, 'SELECT pg_try_advisory_xact_lock($1)', [TICK_LOCK]))) return 0;
    const now = clockNow();
    let admitted = 0;
    const events = (await c.query(`SELECT id, capacity - sold - held AS open FROM events WHERE queue_enabled AND status = 'PUBLISHED' ORDER BY id`)).rows as { id: string; open: number }[];
    for (const ev of events) {
      await expireAdmissions(c, ev.id, now);
      const active = await scalar(c, `SELECT COUNT(*) FROM queue_entries WHERE event_id = $1 AND status = 'ADMITTED'`, [ev.id]);
      const ceiling = Math.min(config.queueMaxAdmitted, ev.open * config.queueAdmitMultiplier);
      const n = Math.min(config.queueAdmitPerTick, ceiling - active);
      if (n > 0) {
        const r = await c.query(
          `UPDATE queue_entries SET status = 'ADMITTED', admitted_at = $1, admit_expires_at = $2
            WHERE seq IN (SELECT seq FROM queue_entries WHERE event_id = $3 AND status = 'WAITING' ORDER BY seq LIMIT $4 FOR UPDATE SKIP LOCKED)`,
          [now, now + config.queueAdmitTtlSeconds * 1000, ev.id, n],
        );
        admitted += r.rowCount ?? 0;
      }
    }
    return admitted;
  });
}

/** The pass is genuine, unexpired and this buyer's own. Needs no database; a forged or stale pass stops here. */
export function checkPass(ctx: Ctx, pass: string | undefined, userId: string, eventId: string, now: number): Pass {
  const p = pass ? verifyPass<Pass>(ctx.config.passSecret, pass, now) : null;
  if (!p || p.u !== userId || p.e !== eventId) {
    throw new AppError('NOT_ADMITTED', 403, 'You have not been admitted yet', { reason: pass ? 'INVALID_PASS' : 'NO_PASS' });
  }
  return p;
}

/** Use the admission for one hold. One conditional UPDATE decides; runs inside the reservation transaction. */
export async function consume(ctx: Ctx, c: Conn, eventId: string, pass: string | undefined, userId: string, now: number): Promise<string> {
  const p = checkPass(ctx, pass, userId, eventId, now);
  const won = await one<{ id: string }>(
    c,
    `UPDATE queue_entries SET status = 'USED', used_at = $1
      WHERE id = $2 AND event_id = $3 AND user_id = $4 AND status = 'ADMITTED' AND admit_expires_at > $1 RETURNING id`,
    [now, p.q, eventId, userId],
  );
  if (won) return won.id;
  const row = await one<{ status: Entry['status'] }>(c, 'SELECT status FROM queue_entries WHERE id = $1', [p.q]);
  const reason = !row ? 'UNKNOWN_PASS' : row.status === 'WAITING' ? 'WAITING' : row.status === 'USED' ? 'USED' : 'EXPIRED';
  throw new AppError('NOT_ADMITTED', 403, 'You have not been admitted yet', { reason });
}
