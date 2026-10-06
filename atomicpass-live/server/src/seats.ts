// Reserved seating. A seat is taken by a conditional UPDATE (AVAILABLE -> HELD); the number of changed rows
// must equal the number requested or the whole hold is refused. Seats are locked in id order (last in the
// lock order, after tiers and events), so two buyers wanting overlapping seats cannot deadlock.
import type { Conn } from './db.js';
import { all } from './db.js';
import { AppError } from './errors.js';

export async function reserveSeats(c: Conn, eventId: string, tierId: string, seatIds: string[], holdId: string): Promise<void> {
  const ids = [...new Set(seatIds)].sort();
  if (ids.length !== seatIds.length) throw new AppError('VALIDATION_ERROR', 400, 'A seat was listed twice');
  // Lock the rows in id order first; a concurrent buyer waits here, then finds the seat HELD below.
  await c.query('SELECT id FROM seats WHERE id = ANY($1) AND tier_id = $2 AND event_id = $3 ORDER BY id FOR UPDATE', [ids, tierId, eventId]);
  const r = await c.query(
    `UPDATE seats SET status = 'HELD', hold_id = $1
      WHERE id = ANY($2) AND tier_id = $3 AND event_id = $4 AND status = 'AVAILABLE'`,
    [holdId, ids, tierId, eventId],
  );
  if (r.rowCount !== ids.length) {
    const taken = await all<{ id: string; row_label: string; seat_no: number }>(
      c,
      `SELECT id, row_label, seat_no FROM seats WHERE id = ANY($1) AND tier_id = $2 AND event_id = $3 AND status <> 'AVAILABLE' AND hold_id IS DISTINCT FROM $4 ORDER BY id`,
      [ids, tierId, eventId, holdId],
    );
    const known = await all<{ id: string }>(c, 'SELECT id FROM seats WHERE id = ANY($1) AND tier_id = $2 AND event_id = $3', [ids, tierId, eventId]);
    if (known.length !== ids.length) throw new AppError('NOT_FOUND', 404, 'A seat does not belong to this ticket type');
    throw new AppError('SEAT_TAKEN', 409, 'Someone else just took one of those seats', {
      seats: taken.map((s) => `${s.row_label}${s.seat_no}`),
    });
  }
}

/** Holds ended without a sale (all given at once): their seats are free again. */
export async function releaseSeats(c: Conn, holdIds: string[]): Promise<void> {
  if (holdIds.length === 0) return;
  await c.query(`SELECT id FROM seats WHERE hold_id = ANY($1) AND status = 'HELD' ORDER BY id FOR UPDATE`, [holdIds]);
  await c.query(`UPDATE seats SET status = 'AVAILABLE', hold_id = NULL WHERE hold_id = ANY($1) AND status = 'HELD'`, [holdIds]);
}

/** A paid hold: its held seats become sold. Returns the seats by tier, in id order, for the tickets. */
export async function sellSeats(c: Conn, holdId: string): Promise<Map<string, string[]>> {
  const rows = await all<{ id: string; tier_id: string }>(
    c,
    `UPDATE seats SET status = 'SOLD' WHERE hold_id = $1 AND status = 'HELD' RETURNING id, tier_id`,
    [holdId],
  );
  const byTier = new Map<string, string[]>();
  for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) byTier.set(r.tier_id, [...(byTier.get(r.tier_id) ?? []), r.id]);
  return byTier;
}

/** Refunded tickets give their seats back. */
export async function freeSeats(c: Conn, seatIds: string[]): Promise<void> {
  if (seatIds.length === 0) return;
  const ids = [...seatIds].sort();
  await c.query('SELECT id FROM seats WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
  const r = await c.query(`UPDATE seats SET status = 'AVAILABLE', hold_id = NULL WHERE id = ANY($1) AND status = 'SOLD'`, [ids]);
  if (r.rowCount !== ids.length) throw new AppError('INTERNAL', 500, 'Seats are out of step with tickets');
}
