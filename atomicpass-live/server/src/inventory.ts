// The only module that changes the held / sold counters of tiers and events. Every guard is one conditional
// UPDATE and the number of changed rows decides. Lock order is always: tiers by id, then events by id, then
// seats by id (seats.ts). A fixed order means two transactions can never wait on each other in a circle.
import type { Conn } from './db.js';
import { one } from './db.js';
import { AppError } from './errors.js';

export interface Line {
  tierId: string;
  quantity: number;
}

const byTier = (a: Line, b: Line) => (a.tierId < b.tierId ? -1 : a.tierId > b.tierId ? 1 : 0);

/**
 * Take `lines` from their tiers and then from the event pool. Throws SALE_NOT_OPEN or SOLD_OUT, so the
 * caller's transaction rolls back and nothing stays taken.
 */
export async function reserve(c: Conn, eventId: string, lines: Line[], now: number): Promise<void> {
  let total = 0;
  for (const { tierId, quantity } of [...lines].sort(byTier)) {
    const r = await c.query(
      `UPDATE tiers SET held = held + $1
        WHERE id = $2 AND event_id = $3 AND capacity - sold - held >= $1
          AND (sale_starts_at IS NULL OR sale_starts_at <= $4)
          AND (sale_ends_at IS NULL OR sale_ends_at > $4)`,
      [quantity, tierId, eventId, now],
    );
    if (r.rowCount === 0) {
      const t = await one<{ sale_starts_at: number | null; sale_ends_at: number | null }>(
        c,
        'SELECT sale_starts_at, sale_ends_at FROM tiers WHERE id = $1',
        [tierId],
      );
      const closed = !!t && ((t.sale_starts_at !== null && t.sale_starts_at > now) || (t.sale_ends_at !== null && t.sale_ends_at <= now));
      throw closed
        ? new AppError('SALE_NOT_OPEN', 409, 'Sales for this ticket type are not open', { tier_id: tierId })
        : new AppError('SOLD_OUT', 409, 'Not enough tickets left', { scope: 'tier', tier_id: tierId });
    }
    total += quantity;
  }
  const pool = await c.query('UPDATE events SET held = held + $1 WHERE id = $2 AND capacity - sold - held >= $1', [total, eventId]);
  if (pool.rowCount === 0) throw new AppError('SOLD_OUT', 409, 'Not enough tickets left', { scope: 'event' });
}

export interface Move {
  eventId: string;
  tierId: string;
  quantity: number;
}

const outOfStep = () => new AppError('INTERNAL', 500, 'Inventory counters are out of step');

/**
 * One counter change per tier and per event, with the quantities of many holds added together first, in the
 * fixed lock order. A guard matching no row means the counters are broken.
 */
async function adjust(c: Conn, moves: Move[], set: string, guard: string): Promise<void> {
  const perTier = new Map<string, number>();
  const perEvent = new Map<string, number>();
  for (const m of moves) {
    perTier.set(m.tierId, (perTier.get(m.tierId) ?? 0) + m.quantity);
    perEvent.set(m.eventId, (perEvent.get(m.eventId) ?? 0) + m.quantity);
  }
  for (const table of ['tiers', 'events'] as const) {
    const map = table === 'tiers' ? perTier : perEvent;
    for (const id of [...map.keys()].sort()) {
      const r = await c.query(`UPDATE ${table} SET ${set} WHERE id = $1 AND ${guard}`, [id, map.get(id)]);
      if (r.rowCount !== 1) throw outOfStep();
    }
  }
}

/** Holds ended without a sale: their seats go back to the tiers and the pool. */
export const release = (c: Conn, moves: Move[]) => adjust(c, moves, 'held = held - $2', 'held >= $2');

/** A hold was paid: held becomes sold in the same statement, so held + sold never changes. */
export const convert = (c: Conn, moves: Move[]) => adjust(c, moves, 'held = held - $2, sold = sold + $2', 'held >= $2');

/** Tickets were refunded: their seats leave `sold` on the tiers and the pool. */
export const returnSold = (c: Conn, moves: Move[]) => adjust(c, moves, 'sold = sold - $2', 'sold >= $2');
