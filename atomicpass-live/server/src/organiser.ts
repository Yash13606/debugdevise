import { requireOrganiserOf } from './access.js';
import type { User } from './auth.js';
import { iso, now as clockNow } from './clock.js';
import type { Conn, Ctx } from './db.js';
import { all, one, scalar, withTx } from './db.js';
import { AppError } from './errors.js';
import { normalisePhone, randomId } from './ids.js';
import { invalidateEvent, readEvent } from './catalog.js';
import { checkInvariants } from './invariants.js';
import { expireDueHolds } from './holds.js';

const bad = (message: string) => new AppError('VALIDATION_ERROR', 400, message);

function parseTime(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw bad(`${field} must be an ISO-8601 date-time`);
  return ms;
}

export interface TierInput {
  name: string;
  price_paise: number;
  capacity?: number;
  max_per_order?: number;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
  /** Reserved seating: rows x seats_per_row seats are created and the capacity is their number. */
  seated?: { rows: number; seats_per_row: number };
}

export interface EventInput {
  name: string;
  description?: string;
  category?: string;
  city?: string;
  venue?: string;
  address?: string;
  banner?: string;
  starts_at: string;
  capacity?: number;
  queue_enabled?: boolean;
  publish?: boolean;
  tiers: TierInput[];
}

/** A, B, ... Z, AA, AB, ... */
const rowLabel = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));

async function insertTier(ctx: Ctx, c: Conn, eventId: string, input: TierInput, position: number, now: number): Promise<{ id: string; capacity: number }> {
  const starts = input.sale_starts_at ? parseTime(input.sale_starts_at, 'sale_starts_at') : null;
  const ends = input.sale_ends_at ? parseTime(input.sale_ends_at, 'sale_ends_at') : null;
  if (starts !== null && ends !== null && starts >= ends) throw bad('sale_starts_at must be before sale_ends_at');
  const seated = input.seated;
  if (seated && (seated.rows < 1 || seated.rows > 50 || seated.seats_per_row < 1 || seated.seats_per_row > 100)) throw bad('seated needs 1-50 rows of 1-100 seats');
  const capacity = seated ? seated.rows * seated.seats_per_row : input.capacity;
  if (!capacity || !Number.isInteger(capacity) || capacity < 1) throw bad('capacity must be a whole number, at least 1');

  const id = randomId('tier');
  await c.query(
    `INSERT INTO tiers (id, event_id, name, price_paise, capacity, max_per_order, seated, sale_starts_at, sale_ends_at, position, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, eventId, input.name.trim(), input.price_paise, capacity, Math.min(input.max_per_order ?? ctx.config.defaultMaxPerOrder, capacity), !!seated, starts, ends, position, now],
  );
  if (seated) {
    const ids: string[] = [], rows: string[] = [], nos: number[] = [];
    for (let r = 0; r < seated.rows; r++) {
      for (let n = 1; n <= seated.seats_per_row; n++) {
        ids.push(randomId('seat'));
        rows.push(rowLabel(r));
        nos.push(n);
      }
    }
    await c.query(
      `INSERT INTO seats (id, event_id, tier_id, row_label, seat_no) SELECT s.id, $1, $2, s.row_label, s.seat_no FROM unnest($3::text[], $4::text[], $5::int[]) AS s(id, row_label, seat_no)`,
      [eventId, id, ids, rows, nos],
    );
  }
  return { id, capacity };
}

export async function createEvent(ctx: Ctx, user: User, input: EventInput) {
  if (!input.tiers?.length) throw bad('add at least one ticket type');
  const startsAt = parseTime(input.starts_at, 'starts_at');
  const id = randomId('evt');
  await withTx(ctx.pool, async (c) => {
    const now = clockNow();
    await c.query(
      `INSERT INTO events (id, organiser_id, name, description, category, city, venue, address, banner, status, starts_at, capacity, queue_enabled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13)`,
      [id, user.id, input.name.trim(), input.description ?? '', input.category ?? 'Music', input.city ?? 'Bengaluru', input.venue ?? '', input.address ?? '', input.banner ?? '#0b6e6e,#12232b', input.publish === false ? 'DRAFT' : 'PUBLISHED', startsAt, !!input.queue_enabled, now],
    );
    let sum = 0;
    for (const [i, t] of input.tiers.entries()) sum += (await insertTier(ctx, c, id, t, i, now)).capacity;
    const capacity = input.capacity ?? sum;
    if (capacity < 1 || capacity > sum) throw bad('capacity must be between 1 and the total of the ticket types');
    await c.query('UPDATE events SET capacity = $2 WHERE id = $1', [id, capacity]);
  });
  return { event: (await readEvent(ctx, id))!.event };
}

/** Add a ticket type later. The event's pool grows by the new type's capacity. */
export async function addTier(ctx: Ctx, user: User, eventId: string, input: TierInput) {
  const added = await withTx(ctx.pool, async (c) => {
    await requireOrganiserOf(c, user, eventId);
    const position = await scalar(c, 'SELECT COUNT(*) FROM tiers WHERE event_id = $1', [eventId]);
    const t = await insertTier(ctx, c, eventId, input, position, clockNow());
    await c.query('UPDATE events SET capacity = capacity + $2 WHERE id = $1', [eventId, t.capacity]);
    return t;
  });
  await ctx.gate.give([{ eventId, tierId: added.id, quantity: added.capacity }]);
  await invalidateEvent(ctx, eventId);
  const view = (await readEvent(ctx, eventId))!;
  return { tier: view.tiers.find((t) => t.id === added.id)! };
}

export async function listMine(ctx: Ctx, user: User) {
  const rows = await all<{ id: string; name: string; city: string; status: string; starts_at: number; capacity: number; sold: number; held: number; revenue: number }>(
    ctx.pool,
    `SELECT e.id, e.name, e.city, e.status, e.starts_at, e.capacity, e.sold, e.held,
            COALESCE((SELECT SUM(o.total_paise - o.refunded_paise) FROM orders o WHERE o.event_id = e.id), 0)::int AS revenue
       FROM events e WHERE e.organiser_id = $1 ORDER BY e.starts_at DESC`,
    [user.id],
  );
  return { events: rows.map((e) => ({ ...e, starts_at: iso(e.starts_at), available: Math.max(0, e.capacity - e.sold - e.held), revenue_paise: e.revenue })) };
}

export async function patchEvent(ctx: Ctx, user: User, eventId: string, input: { queue_enabled?: boolean; status?: 'PUBLISHED' | 'CANCELLED' }) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  if (input.queue_enabled !== undefined) await ctx.pool.query('UPDATE events SET queue_enabled = $2 WHERE id = $1', [eventId, input.queue_enabled]);
  if (input.status) {
    // Publishing a draft or cancelling a sale; a cancelled event never goes back on sale.
    const ok = input.status === 'PUBLISHED' ? `status = 'DRAFT'` : `status IN ('DRAFT', 'PUBLISHED')`;
    const r = await ctx.pool.query(`UPDATE events SET status = $2 WHERE id = $1 AND ${ok}`, [eventId, input.status]);
    if (r.rowCount === 0) throw new AppError('INVALID_TRANSITION', 409, `The event cannot move to ${input.status} from its current state`);
  }
  await invalidateEvent(ctx, eventId);
  return { event: (await readEvent(ctx, eventId))!.event };
}

export interface PromoInput {
  code: string;
  kind: 'PERCENT' | 'FIXED';
  value: number;
  max_uses?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  tier_id?: string | null;
}

export async function createPromo(ctx: Ctx, user: User, eventId: string, input: PromoInput) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  if (input.kind === 'PERCENT' && input.value > 100) throw bad('a PERCENT value must be from 1 to 100');
  const from = input.valid_from ? parseTime(input.valid_from, 'valid_from') : null;
  const to = input.valid_to ? parseTime(input.valid_to, 'valid_to') : null;
  if (from !== null && to !== null && from >= to) throw bad('valid_from must be before valid_to');
  const tierId = input.tier_id ?? null;
  if (tierId && !(await one(ctx.pool, 'SELECT 1 FROM tiers WHERE id = $1 AND event_id = $2', [tierId, eventId]))) throw new AppError('NOT_FOUND', 404, 'Ticket type not found in this event');
  const code = input.code.trim().toLowerCase();
  const id = randomId('promo');
  const r = await ctx.pool.query(
    `INSERT INTO promo_codes (id, event_id, code, kind, value, max_uses, valid_from, valid_to, tier_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (event_id, code) DO NOTHING`,
    [id, eventId, code, input.kind, input.value, input.max_uses ?? null, from, to, tierId, clockNow()],
  );
  if (r.rowCount === 0) throw new AppError('PROMO_EXISTS', 409, 'That code already exists for this event');
  return { promo: { id, code, kind: input.kind, value: input.value, max_uses: input.max_uses ?? null, used: 0, tier_id: tierId } };
}

/** Let a phone number scan tickets for this event. The person logs in with their own OTP; no shared key. */
export async function addStaff(ctx: Ctx, user: User, eventId: string, rawPhone: string) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  const phone = normalisePhone(rawPhone);
  await withTx(ctx.pool, async (c) => {
    const u = await one<{ id: string }>(
      c,
      `INSERT INTO users (id, phone, created_at) VALUES ($1, $2, $3) ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id`,
      [randomId('usr'), phone, clockNow()],
    );
    await c.query('INSERT INTO event_staff (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [eventId, u!.id]);
  });
  return listStaff(ctx, user, eventId);
}

export async function listStaff(ctx: Ctx, user: User, eventId: string) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  return { staff: await all<{ phone: string; name: string }>(ctx.pool, 'SELECT u.phone, u.name FROM event_staff s JOIN users u ON u.id = s.user_id WHERE s.event_id = $1 ORDER BY u.phone', [eventId]) };
}

/** Events a signed-in user may scan for: their own and those they were added to. */
export async function gateEvents(ctx: Ctx, user: User) {
  const rows = await all<{ id: string; name: string; starts_at: number; venue: string; city: string }>(
    ctx.pool,
    `SELECT e.id, e.name, e.starts_at, e.venue, e.city FROM events e
      WHERE e.organiser_id = $1 OR EXISTS (SELECT 1 FROM event_staff s WHERE s.event_id = e.id AND s.user_id = $1) ORDER BY e.starts_at DESC`,
    [user.id],
  );
  return { events: rows.map((e) => ({ ...e, starts_at: iso(e.starts_at) })) };
}

/** Everything the organiser dashboard shows. Due holds are expired first, so the numbers are current. */
export async function eventStats(ctx: Ctx, user: User, eventId: string) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  await expireDueHolds(ctx);
  const view = await readEvent(ctx, eventId);
  if (!view) throw new AppError('NOT_FOUND', 404, 'Event not found');
  const counts = async (table: string, statuses: string[]) => {
    const rows = await all<{ status: string; n: number }>(ctx.pool, `SELECT status, COUNT(*)::int AS n FROM ${table} WHERE event_id = $1 GROUP BY status`, [eventId]);
    return Object.fromEntries(statuses.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
  };
  const money = await one<{ gross: number; refunded: number; orders: number }>(
    ctx.pool,
    `SELECT COALESCE(SUM(total_paise), 0)::int AS gross, COALESCE(SUM(refunded_paise), 0)::int AS refunded, COUNT(*)::int AS orders FROM orders WHERE event_id = $1`,
    [eventId],
  );
  const since = Math.floor((clockNow() - 29 * 60_000) / 60_000) * 60_000;
  const perMinute = async (table: string, col: string) =>
    new Map((await all<{ minute: number; n: number }>(ctx.pool, `SELECT (${col} / 60000) * 60000 AS minute, COUNT(*)::int AS n FROM ${table} WHERE event_id = $1 AND ${col} >= $2 GROUP BY 1`, [eventId, since])).map((r) => [r.minute, r.n]));
  const [holdsPer, ordersPer] = [await perMinute('holds', 'created_at'), await perMinute('orders', 'paid_at')];
  const timeline = Array.from({ length: 30 }, (_, i) => since + i * 60_000).map((t) => ({ t: iso(t), holds: holdsPer.get(t) ?? 0, orders: ordersPer.get(t) ?? 0 }));
  const waiting = await scalar(ctx.pool, 'SELECT COUNT(*)::int FROM waitlist WHERE event_id = $1 AND notified_at IS NULL', [eventId]);
  return {
    ...view,
    timeline,
    waitlist: { waiting },
    tickets: await counts('tickets', ['VALID', 'CHECKED_IN', 'VOID']),
    holds: await counts('holds', ['ACTIVE', 'PAYING', 'CONVERTED', 'EXPIRED', 'RELEASED']),
    queue: await counts('queue_entries', ['WAITING', 'ADMITTED', 'USED', 'EXPIRED']),
    money: { gross_paise: money!.gross, refunded_paise: money!.refunded, orders: money!.orders },
    invariants: await checkInvariants(ctx.pool, eventId),
  };
}

/**
 * What the organiser would be paid: sales less refunds, less the platform fee, less GST on that fee. The rates are
 * illustrative settings (PLATFORM_FEE_BPS, GST_BPS); nothing is paid out by this app.
 */
export async function settlement(ctx: Ctx, user: User, eventId: string) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  const { gross, refunds } = (await one<{ gross: number; refunds: number }>(
    ctx.pool,
    `SELECT COALESCE((SELECT SUM(total_paise) FROM orders WHERE event_id = $1), 0)::int AS gross,
            COALESCE((SELECT SUM(r.amount_paise) FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1), 0)::int AS refunds`,
    [eventId],
  ))!;
  const net = gross - refunds;
  const fee = Math.floor((net * ctx.config.platformFeeBps) / 10_000);
  const gst = Math.floor((fee * ctx.config.gstBps) / 10_000);
  const byTier = await all<{ tier: string; sold: number; revenue: number }>(
    ctx.pool,
    `SELECT ti.name AS tier, COUNT(*)::int AS sold, COALESCE(SUM(k.paid_paise), 0)::int AS revenue
       FROM tickets k JOIN tiers ti ON ti.id = k.tier_id WHERE k.event_id = $1 AND k.status IN ('VALID', 'CHECKED_IN') GROUP BY ti.name, ti.position ORDER BY ti.position`,
    [eventId],
  );
  const pending = await scalar(ctx.pool, `SELECT COALESCE(SUM(r.amount_paise), 0)::int FROM refunds r JOIN orders o ON o.id = r.order_id WHERE o.event_id = $1 AND r.status = 'PENDING'`, [eventId]);
  return {
    illustrative: true,
    gross_paise: gross,
    refunds_paise: refunds,
    net_sales_paise: net,
    platform_fee_paise: fee,
    gst_on_fee_paise: gst,
    payable_paise: net - fee - gst,
    refunds_pending_paise: pending,
    rates: { platform_fee_bps: ctx.config.platformFeeBps, gst_bps: ctx.config.gstBps },
    by_tier: byTier,
  };
}

/** Take a phone number off the gate team. It takes effect on the very next scan, because access is checked per scan. */
export async function removeStaff(ctx: Ctx, user: User, eventId: string, rawPhone: string) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  const phone = normalisePhone(rawPhone);
  await ctx.pool.query('DELETE FROM event_staff WHERE event_id = $1 AND user_id = (SELECT id FROM users WHERE phone = $2)', [eventId, phone]);
  return listStaff(ctx, user, eventId);
}

/** Who scanned what: one row per person on the gate team, from the scan log. */
export async function scanReport(ctx: Ctx, user: User, eventId: string) {
  await requireOrganiserOf(ctx.pool, user, eventId);
  const rows = await all<{ phone: string; name: string; admitted: number; refused: number; last_at: number }>(
    ctx.pool,
    `SELECT u.phone, u.name, COUNT(*) FILTER (WHERE l.result = 'ADMITTED')::int AS admitted, COUNT(*) FILTER (WHERE l.result <> 'ADMITTED')::int AS refused, MAX(l.at) AS last_at
       FROM scan_log l JOIN users u ON u.id = l.scanned_by WHERE l.event_id = $1 GROUP BY u.phone, u.name ORDER BY admitted DESC`,
    [eventId],
  );
  return { staff: rows.map((r) => ({ ...r, last_at: iso(r.last_at) })) };
}
