// Reads for the buyer pages: listings, one event with live availability, and the seat map. Pages may come from the
// short cache; the hold path (holds.ts) never does.
import { createHash } from 'node:crypto';
import { iso, now as clockNow } from './clock.js';
import type { Ctx } from './db.js';
import { all, one } from './db.js';
import { AppError } from './errors.js';
import { eventCacheKey } from './cache.js';

interface EventRow {
  id: string;
  organiser_id: string | null;
  name: string;
  description: string;
  category: string;
  city: string;
  venue: string;
  address: string;
  banner: string;
  status: string;
  starts_at: number;
  capacity: number;
  sold: number;
  held: number;
  queue_enabled: boolean;
}

interface TierRow {
  id: string;
  name: string;
  price_paise: number;
  capacity: number;
  sold: number;
  held: number;
  max_per_order: number;
  seated: boolean;
  sale_starts_at: number | null;
  sale_ends_at: number | null;
}

export const CATEGORIES = ['Music', 'Comedy', 'Festival', 'Sports', 'Workshop', 'Theatre'] as const;
export const CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Chennai', 'Pune'] as const;

const room = (x: { capacity: number; sold: number; held: number }) => Math.max(0, x.capacity - x.sold - x.held);

export const eventJson = (e: EventRow, organiserName: string | null) => ({
  id: e.id,
  name: e.name,
  description: e.description,
  category: e.category,
  city: e.city,
  venue: e.venue,
  address: e.address,
  banner: e.banner,
  status: e.status,
  starts_at: iso(e.starts_at),
  capacity: e.capacity,
  sold: e.sold,
  held: e.held,
  available: room(e),
  queue_enabled: e.queue_enabled,
  organiser: organiserName,
});

/** `available` is the smaller of the tier's own room and the pool's room, never negative. */
export const tierJson = (t: TierRow, e: EventRow) => ({
  id: t.id,
  name: t.name,
  price_paise: t.price_paise,
  capacity: t.capacity,
  sold: t.sold,
  held: t.held,
  available: Math.min(room(t), room(e)),
  max_per_order: t.max_per_order,
  seated: t.seated,
  sale_starts_at: t.sale_starts_at === null ? null : iso(t.sale_starts_at),
  sale_ends_at: t.sale_ends_at === null ? null : iso(t.sale_ends_at),
});

export type EventView = NonNullable<Awaited<ReturnType<typeof readEvent>>>;

/** The event, its tiers and availability, from one snapshot. Null when the event is unknown. */
export async function readEvent(ctx: Ctx, eventId: string) {
  const c = await ctx.pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const e = await one<EventRow & { organiser_name: string | null }>(
      c,
      `SELECT e.*, u.org_name AS organiser_name FROM events e LEFT JOIN users u ON u.id = e.organiser_id WHERE e.id = $1`,
      [eventId],
    );
    if (!e) return null;
    const tiers = await all<TierRow>(c, 'SELECT * FROM tiers WHERE event_id = $1 ORDER BY position, created_at, id', [eventId]);
    await c.query('COMMIT');
    return { event: eventJson(e, e.organiser_name), tiers: tiers.map((t) => tierJson(t, e)), currency: ctx.config.currency, as_of: iso(clockNow()) };
  } finally {
    c.release();
  }
}

/** GET /events/:id, from the cache when fresh. */
export async function eventView(ctx: Ctx, eventId: string): Promise<EventView> {
  const view = await ctx.cache.getOrLoad(eventCacheKey(eventId), () => readEvent(ctx, eventId));
  if (!view) throw new AppError('NOT_FOUND', 404, 'Event not found');
  return view;
}

export const seatsCacheKey = (eventId: string) => `seats:${eventId}`;

/** Both cached views of an event go stale together; call after any commit that moves its seats. */
export const invalidateEvent = (ctx: Ctx, eventId: string) => ctx.cache.invalidate(eventCacheKey(eventId), seatsCacheKey(eventId));

export interface ListQuery {
  city?: string;
  category?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listEvents(ctx: Ctx, query: ListQuery) {
  const limit = Math.min(Math.max(query.limit ?? 24, 1), 60);
  const offset = Math.max(query.offset ?? 0, 0);
  const key = 'list:' + createHash('sha1').update(JSON.stringify([query.city, query.category, query.q, limit, offset])).digest('hex');
  return ctx.cache.getOrLoad(key, async () => {
    const rows = await all<EventRow & { min_price: number | null }>(
      ctx.pool,
      `SELECT e.*, (SELECT MIN(price_paise) FROM tiers t WHERE t.event_id = e.id) AS min_price
         FROM events e
        WHERE e.status = 'PUBLISHED' AND e.starts_at > $1
          AND ($2::text IS NULL OR e.city = $2) AND ($3::text IS NULL OR e.category = $3)
          AND ($4::text IS NULL OR e.name ILIKE '%' || $4 || '%' OR e.venue ILIKE '%' || $4 || '%')
        ORDER BY e.starts_at, e.id LIMIT $5 OFFSET $6`,
      [clockNow() - 6 * 3600_000, query.city ?? null, query.category ?? null, query.q?.trim() || null, limit, offset],
    );
    return {
      events: rows.map((e) => ({
        id: e.id,
        name: e.name,
        category: e.category,
        city: e.city,
        venue: e.venue,
        banner: e.banner,
        starts_at: iso(e.starts_at),
        available: room(e),
        capacity: e.capacity,
        min_price_paise: e.min_price,
        selling_fast: e.capacity > 0 && room(e) / e.capacity < 0.2 && room(e) > 0,
        sold_out: room(e) === 0,
      })),
    };
  });
}

/** Every seat of an event, grouped by tier, for the seat picker. */
export async function seatMap(ctx: Ctx, eventId: string) {
  return ctx.cache.getOrLoad(seatsCacheKey(eventId), async () => {
    const rows = await all<{ id: string; tier_id: string; row_label: string; seat_no: number; status: string }>(
      ctx.pool,
      'SELECT id, tier_id, row_label, seat_no, status FROM seats WHERE event_id = $1 ORDER BY tier_id, row_label, seat_no',
      [eventId],
    );
    const tiers: Record<string, { id: string; row: string; no: number; status: string }[]> = {};
    for (const r of rows) (tiers[r.tier_id] ??= []).push({ id: r.id, row: r.row_label, no: r.seat_no, status: r.status });
    return { tiers, as_of: iso(clockNow()) };
  });
}
