// The only module that changes the held / sold counters of tiers and events (ARCHITECTURE section 2).
// Every guard is a conditional UPDATE; the number of changed rows decides the outcome.
import { iso } from './clock.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

export interface Line {
  tierId: string;
  quantity: number;
}

interface EventRow {
  id: string;
  name: string;
  starts_at: number;
  capacity: number;
  sold: number;
  held: number;
  queue_enabled: number;
}

interface TierRow {
  id: string;
  name: string;
  price_cents: number;
  capacity: number;
  sold: number;
  held: number;
  max_per_order: number;
  sale_starts_at: number | null;
  sale_ends_at: number | null;
}

const byTier = (a: Line, b: Line) => (a.tierId < b.tierId ? -1 : a.tierId > b.tierId ? 1 : 0);

/**
 * Take `lines` from their tiers and then from the event pool (ARCHITECTURE 4.1, steps 6 and 7).
 * Tiers go in ascending id order, the pool last. Throws SALE_NOT_OPEN or SOLD_OUT, so the caller's
 * transaction rolls back and nothing stays taken.
 */
export function reserve(db: Db, eventId: string, lines: Line[], now: number): void {
  const takeTier = db.prepare(
    `UPDATE tiers SET held = held + ?
      WHERE id = ? AND event_id = ? AND capacity - sold - held >= ?
        AND (sale_starts_at IS NULL OR sale_starts_at <= ?)
        AND (sale_ends_at IS NULL OR sale_ends_at > ?)`,
  );
  let total = 0;
  for (const { tierId, quantity } of [...lines].sort(byTier)) {
    if (takeTier.run(quantity, tierId, eventId, quantity, now, now).changes === 0) {
      const t = db.prepare('SELECT sale_starts_at, sale_ends_at FROM tiers WHERE id = ?').get(tierId) as Pick<
        TierRow,
        'sale_starts_at' | 'sale_ends_at'
      >;
      const closed =
        (t.sale_starts_at !== null && t.sale_starts_at > now) || (t.sale_ends_at !== null && t.sale_ends_at <= now);
      throw closed
        ? new AppError('SALE_NOT_OPEN', 409, 'Sales for this tier are not open', { tier_id: tierId })
        : new AppError('SOLD_OUT', 409, 'Not enough tickets left', { scope: 'tier', tier_id: tierId });
    }
    total += quantity;
  }
  const takePool = db.prepare('UPDATE events SET held = held + ? WHERE id = ? AND capacity - sold - held >= ?');
  if (takePool.run(total, eventId, total).changes === 0) {
    throw new AppError('SOLD_OUT', 409, 'Not enough tickets left', { scope: 'event' });
  }
}

// ---- reads: availability is always computed fresh, never cached (PRD FR-2) ----

export const eventJson = (e: EventRow) => ({
  id: e.id,
  name: e.name,
  starts_at: iso(e.starts_at),
  capacity: e.capacity,
  sold: e.sold,
  held: e.held,
  available: Math.max(0, e.capacity - e.sold - e.held),
  queue_enabled: e.queue_enabled === 1,
});

/** `available` is the smaller of the tier's own room and the pool's room, never negative. */
export const tierJson = (t: TierRow, e: EventRow) => ({
  id: t.id,
  name: t.name,
  price_cents: t.price_cents,
  capacity: t.capacity,
  sold: t.sold,
  held: t.held,
  available: Math.max(0, Math.min(t.capacity - t.sold - t.held, e.capacity - e.sold - e.held)),
  max_per_order: t.max_per_order,
  sale_starts_at: t.sale_starts_at === null ? null : iso(t.sale_starts_at),
  sale_ends_at: t.sale_ends_at === null ? null : iso(t.sale_ends_at),
});

/** The event, its tiers and live availability, read in one snapshot. Null when the event is unknown. */
export function readEvent(db: Db, eventId: string, currency: string) {
  return db.transaction(() => {
    const e = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as EventRow | undefined;
    if (!e) return null;
    const tiers = db
      .prepare('SELECT * FROM tiers WHERE event_id = ? ORDER BY position, created_at, id')
      .all(eventId) as TierRow[];
    return { event: eventJson(e), tiers: tiers.map((t) => tierJson(t, e)), currency };
  })();
}
