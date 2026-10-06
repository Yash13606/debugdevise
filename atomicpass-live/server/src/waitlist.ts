// The waitlist and expiry reminders. Both only write to the outbox; delivery is the outbox worker's job.
import { now as clockNow } from './clock.js';
import type { Ctx } from './db.js';
import { all, one, withTx } from './db.js';
import { AppError } from './errors.js';
import { enqueue } from './notify.js';

/** Ask to be told when a seat frees up. Only for events that are sold out right now. */
export async function join(ctx: Ctx, userId: string, eventId: string) {
  const e = await one<{ capacity: number; sold: number; held: number; status: string }>(ctx.pool, 'SELECT capacity, sold, held, status FROM events WHERE id = $1', [eventId]);
  if (!e) throw new AppError('NOT_FOUND', 404, 'Event not found');
  if (e.status !== 'PUBLISHED') throw new AppError('EVENT_NOT_ON_SALE', 409, 'This event is not on sale');
  if (e.capacity - e.sold - e.held > 0) throw new AppError('NOT_SOLD_OUT', 409, 'Seats are still available, no need to wait');
  const r = await ctx.pool.query(`INSERT INTO waitlist (event_id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (event_id, user_id) DO UPDATE SET notified_at = NULL, created_at = EXCLUDED.created_at WHERE waitlist.notified_at IS NOT NULL`, [eventId, userId, clockNow()]);
  const place = await one<{ n: number }>(ctx.pool, `SELECT COUNT(*)::int AS n FROM waitlist WHERE event_id = $1 AND notified_at IS NULL AND created_at <= (SELECT created_at FROM waitlist WHERE event_id = $1 AND user_id = $2)`, [eventId, userId]);
  return { joined: (r.rowCount ?? 0) > 0, position: place?.n ?? 1 };
}

/**
 * Seats came back: tell as many waiting buyers as seats freed, first come first told. Best effort and after the commit;
 * telling someone is not a promise of a seat.
 */
export async function notifyFreed(ctx: Ctx, moves: { eventId: string; quantity: number }[]): Promise<void> {
  const freed = new Map<string, number>();
  for (const m of moves) freed.set(m.eventId, (freed.get(m.eventId) ?? 0) + m.quantity);
  for (const [eventId, n] of freed) {
    await withTx(ctx.pool, async (c) => {
      const rows = await all<{ user_id: string; phone: string; name: string }>(
        c,
        `UPDATE waitlist w SET notified_at = $3
          WHERE (w.event_id, w.user_id) IN (SELECT event_id, user_id FROM waitlist WHERE event_id = $1 AND notified_at IS NULL ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
          RETURNING w.user_id, (SELECT phone FROM users WHERE id = w.user_id) AS phone, (SELECT name FROM events WHERE id = w.event_id) AS name`,
        [eventId, n, clockNow()],
      );
      for (const r of rows) await enqueue(c, r.phone, 'WAITLIST', `A seat just freed up for ${r.name}. Book now before it goes.`);
    });
  }
}

/**
 * One reminder per hold, when it has about REMINDER_LEAD_SECONDS left and is still unpaid. Marking and writing the
 * message are one statement, so two workers can never send it twice.
 */
export async function remindExpiring(ctx: Ctx): Promise<number> {
  const now = clockNow();
  const r = await ctx.pool.query(
    `WITH due AS (
       UPDATE holds SET reminded = TRUE
        WHERE status = 'ACTIVE' AND NOT reminded AND expires_at > $1 AND expires_at - $1 <= $2
        RETURNING user_id, event_id, expires_at)
     INSERT INTO outbox (phone, kind, body, created_at)
     SELECT u.phone, 'HOLD_REMINDER',
            'Your seats for ' || e.name || ' are held for about ' || GREATEST(1, ROUND((d.expires_at - $1) / 60000.0)) || ' more minute(s). Pay now to keep them.', $1
       FROM due d JOIN users u ON u.id = d.user_id JOIN events e ON e.id = d.event_id`,
    [now, ctx.config.reminderLeadSeconds * 1000],
  );
  return r.rowCount ?? 0;
}
