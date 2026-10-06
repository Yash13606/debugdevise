import { iso, now as clockNow } from './clock.js';
import type { Conn, Ctx } from './db.js';
import { all, one, scalar, withTx } from './db.js';
import { AppError } from './errors.js';
import { randomId } from './ids.js';
import * as inventory from './inventory.js';
import type { Move } from './inventory.js';
import * as promo from './promo.js';
import * as queue from './queue.js';
import * as seats from './seats.js';
import { eventView } from './catalog.js';
import { notifyFreed } from './waitlist.js';

const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);
const bad = (message: string) => new AppError('VALIDATION_ERROR', 400, message);

export interface HoldInput {
  items: { tier_id: string; quantity?: number; seat_ids?: string[] }[];
  promo_code?: string | null;
  queue_pass?: string;
}

export interface HoldRow {
  id: string;
  event_id: string;
  user_id: string;
  status: 'ACTIVE' | 'PAYING' | 'CONVERTED' | 'EXPIRED' | 'RELEASED';
  subtotal_paise: number;
  discount_paise: number;
  total_paise: number;
  promo_code_id: string | null;
  expires_at: number;
  pay_started_at: number | null;
}

interface ItemRow {
  tier_id: string;
  quantity: number;
  unit_price_paise: number;
}

export const loadItems = (q: Conn | Ctx['pool'], holdId: string) =>
  all<ItemRow>(q, 'SELECT tier_id, quantity, unit_price_paise FROM hold_items WHERE hold_id = $1 ORDER BY id', [holdId]);

/** The hold, 404 when it is unknown or belongs to someone else (a stranger cannot tell which). */
export async function loadHold(q: Conn | Ctx['pool'], holdId: string, userId: string, lock = false): Promise<HoldRow> {
  const h = await one<HoldRow>(q, `SELECT * FROM holds WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`, [holdId, userId]);
  if (!h) throw notFound('Hold');
  return h;
}

export function holdJson(h: HoldRow, items: ItemRow[], seatLabels: string[] = []) {
  return {
    id: h.id,
    status: h.status,
    event_id: h.event_id,
    items,
    seats: seatLabels,
    subtotal_paise: h.subtotal_paise,
    discount_paise: h.discount_paise,
    total_paise: h.total_paise,
    expires_at: iso(h.expires_at),
  };
}

const seatLabelsOf = async (q: Conn | Ctx['pool'], holdId: string) =>
  (await all<{ row_label: string; seat_no: number }>(q, 'SELECT row_label, seat_no FROM seats WHERE hold_id = $1 ORDER BY row_label, seat_no', [holdId])).map((s) => `${s.row_label}${s.seat_no}`);

// ---- expiry ----

/**
 * End many holds at once, ACTIVE or PAYING -> EXPIRED or RELEASED, and give their seats back. Quantities are summed
 * first and applied in the fixed lock order (inventory.ts), so two sweepers never deadlock. Returns the ids actually
 * closed: a hold that was paid or closed by someone else a moment earlier is simply not in the list.
 */
export async function closeMany(c: Conn, holdIds: string[], status: 'EXPIRED' | 'RELEASED', now: number, after: (f: () => Promise<void>) => void, ctx: Ctx): Promise<string[]> {
  if (holdIds.length === 0) return [];
  const closed = await all<{ id: string; event_id: string; promo_code_id: string | null }>(
    c,
    `UPDATE holds SET status = $2, closed_at = $3 WHERE id = ANY($1) AND status IN ('ACTIVE', 'PAYING')
     RETURNING id, event_id, promo_code_id`,
    [holdIds, status, now],
  );
  if (closed.length === 0) return [];
  const ids = closed.map((h) => h.id);
  const eventOf = new Map(closed.map((h) => [h.id, h.event_id]));
  const rows = await all<{ hold_id: string; tier_id: string; quantity: number }>(c, 'SELECT hold_id, tier_id, quantity FROM hold_items WHERE hold_id = ANY($1)', [ids]);
  const moves: Move[] = rows.map((r) => ({ eventId: eventOf.get(r.hold_id)!, tierId: r.tier_id, quantity: r.quantity }));
  await inventory.release(c, moves);
  await seats.releaseSeats(c, ids);
  await promo.returnUses(c, closed.flatMap((h) => (h.promo_code_id ? [h.promo_code_id] : [])));
  after(async () => {
    await ctx.gate.give(moves);
    await notifyFreed(ctx, moves);
  });
  ctx.metrics.inc('holds_closed_total', { status }, ids.length);
  return ids;
}

/** Expire every due hold (the sweeper and POST /admin/sweep). Holds being closed elsewhere are skipped, not waited for. */
export async function expireDueHolds(ctx: Ctx): Promise<number> {
  return withTx(ctx.pool, async (c, after) => {
    const now = clockNow();
    const due = await all<{ id: string }>(
      c,
      `SELECT id FROM holds WHERE status IN ('ACTIVE', 'PAYING') AND expires_at <= $1 ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED`,
      [now],
    );
    return (await closeMany(c, due.map((d) => d.id), 'EXPIRED', now, after, ctx)).length;
  });
}

let lastExpiryCheck = 0;

/**
 * Reads and reservations free due holds first, but open a write transaction only when one exists. The check itself
 * runs at most every 500 ms per process: the sweeper covers quiet periods, and a busy sale does not need a probe per request.
 */
export async function expireIfDue(ctx: Ctx): Promise<void> {
  const t = clockNow();
  if (Math.abs(t - lastExpiryCheck) < 500) return;
  lastExpiryCheck = t;
  const any = await scalar<boolean>(ctx.pool, `SELECT EXISTS (SELECT 1 FROM holds WHERE status IN ('ACTIVE', 'PAYING') AND expires_at <= $1)`, [t]);
  if (any) await expireDueHolds(ctx);
}

// ---- reserve ----

/** A buyer's active holds plus valid tickets, per event, stay within the cap (0 = off). */
async function checkBuyerCap(c: Conn, eventId: string, userId: string, requested: number, limit: number): Promise<void> {
  if (limit <= 0) return;
  // Two requests from the same buyer must not both read "3 of 4 used" and both pass: one lock per buyer and event, held to commit.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`cap:${userId}:${eventId}`]);
  const { holding, owned } = (await one<{ holding: number; owned: number }>(
    c,
    `SELECT (SELECT COALESCE(SUM(hi.quantity), 0) FROM holds h JOIN hold_items hi ON hi.hold_id = h.id
              WHERE h.event_id = $1 AND h.user_id = $2 AND h.status IN ('ACTIVE', 'PAYING')) AS holding,
            (SELECT COUNT(*) FROM tickets t JOIN orders o ON o.id = t.order_id
              WHERE t.event_id = $1 AND o.user_id = $2 AND t.status IN ('VALID', 'CHECKED_IN')) AS owned`,
    [eventId, userId],
  ))!;
  if (holding + owned + requested > limit) {
    throw new AppError('BUYER_LIMIT', 409, 'Ticket limit per buyer reached', { limit, used: holding + owned, requested });
  }
}

interface Line {
  tierId: string;
  quantity: number;
  unitPrice: number;
  seatIds: string[];
  seated: boolean;
}

/**
 * Reserve seats. Before the database: cheap checks from the cached page (unknown event or tier, quantity, waiting-room
 * pass) and the fast gate. Then one transaction: validate, use the admission, apply the promo code, record the hold, take
 * the seats from the tiers, the pool and the seat rows. Any refusal rolls everything back, and the fast gate gives its
 * counts back. The hold row goes in first and the hot counters last, so their locks are held for the shortest time.
 */
export async function createHold(ctx: Ctx, userId: string, eventId: string, input: HoldInput) {
  const { config } = ctx;
  if (!Array.isArray(input.items) || input.items.length === 0) throw bad('items must not be empty');
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.tier_id)) throw bad('each ticket type may appear only once');
    seen.add(item.tier_id);
  }

  await expireIfDue(ctx);

  // Cheap refusals from the cached page: they cost no database work. The transaction below re-checks everything.
  const cached = await eventView(ctx, eventId);
  if (cached.event.status !== 'PUBLISHED') throw new AppError('EVENT_NOT_ON_SALE', 409, 'This event is not on sale');
  const wanted = input.items.map((item) => {
    const tier = cached.tiers.find((t) => t.id === item.tier_id);
    if (!tier) throw notFound('Ticket type');
    const quantity = tier.seated ? (item.seat_ids?.length ?? 0) : (item.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity < 1) throw bad(tier.seated ? 'choose at least one seat' : 'quantity must be a whole number, at least 1');
    if (tier.seated && item.quantity !== undefined && item.quantity !== quantity) throw bad('quantity must match the number of seats chosen');
    if (quantity > tier.max_per_order) {
      throw new AppError('MAX_PER_ORDER', 422, 'Quantity is above the limit per order', { tier_id: tier.id, max_per_order: tier.max_per_order });
    }
    return { tierId: tier.id, quantity };
  });
  if (cached.event.queue_enabled) queue.checkPass(ctx, input.queue_pass, userId, eventId, clockNow());

  const taken = await ctx.gate.take(eventId, wanted);
  if (!taken.ok) {
    ctx.metrics.inc('holds_refused_total', { code: 'SOLD_OUT', by: 'gate' });
    throw new AppError('SOLD_OUT', 409, 'Not enough tickets left', taken.scope === 'tier' ? { scope: 'tier', tier_id: taken.tierId } : { scope: 'event' });
  }

  const holdId = randomId('hold');
  try {
    const result = await withTx(ctx.pool, async (c, after) => {
      const now = clockNow();
      const rows = await all<{ id: string; price_paise: number; max_per_order: number; seated: boolean; queue_enabled: boolean; status: string }>(
        c,
        `SELECT t.id, t.price_paise, t.max_per_order, t.seated, e.queue_enabled, e.status FROM tiers t JOIN events e ON e.id = t.event_id WHERE t.event_id = $1 AND t.id = ANY($2)`,
        [eventId, input.items.map((i) => i.tier_id)],
      );
      if (rows.length === 0 && !(await one(c, 'SELECT 1 FROM events WHERE id = $1', [eventId]))) throw notFound('Event');
      const event = { queue_enabled: rows[0]?.queue_enabled ?? false, status: rows[0]?.status ?? 'PUBLISHED' };
      if (event.status !== 'PUBLISHED') throw new AppError('EVENT_NOT_ON_SALE', 409, 'This event is not on sale');

      const lines: Line[] = [];
      for (const item of input.items) {
        const tier = rows.find((r) => r.id === item.tier_id);
        if (!tier) throw notFound('Ticket type');
        const seatIds = tier.seated ? (item.seat_ids ?? []) : [];
        const quantity = tier.seated ? seatIds.length : (item.quantity ?? 0);
        if (!Number.isInteger(quantity) || quantity < 1) throw bad('quantity must be a whole number, at least 1');
        if (quantity > tier.max_per_order) {
          throw new AppError('MAX_PER_ORDER', 422, 'Quantity is above the limit per order', { tier_id: item.tier_id, max_per_order: tier.max_per_order });
        }
        lines.push({ tierId: item.tier_id, quantity, unitPrice: tier.price_paise, seatIds, seated: tier.seated });
      }
      lines.sort((a, b) => (a.tierId < b.tierId ? -1 : 1));
      const quantity = lines.reduce((s, l) => s + l.quantity, 0);

      const queueEntryId = event.queue_enabled ? await queue.consume(ctx, c, eventId, input.queue_pass, userId, now) : null;
      await checkBuyerCap(c, eventId, userId, quantity, config.maxTicketsPerBuyer);

      let code: promo.Promo | null = null;
      if (input.promo_code) {
        code = await promo.reserveUse(c, eventId, input.promo_code, now);
        if (!promo.appliesTo(code, lines.map((l) => l.tierId))) {
          throw new AppError('PROMO_INVALID', 422, 'The promo code cannot be used (NOT_APPLICABLE)', { reason: 'NOT_APPLICABLE' });
        }
      }

      const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      const discount = code ? promo.discountFor(code, lines) : 0;
      const expiresAt = now + config.holdTtlSeconds * 1000;
      const seatIds = lines.flatMap((l) => l.seatIds);
      const labels = seatIds.length
        ? (await all<{ row_label: string; seat_no: number }>(c, 'SELECT row_label, seat_no FROM seats WHERE id = ANY($1) ORDER BY row_label, seat_no', [seatIds])).map((s) => `${s.row_label}${s.seat_no}`)
        : [];
      await c.query(
        `WITH h AS (
           INSERT INTO holds (id, event_id, user_id, status, quantity_total, subtotal_paise, discount_paise, total_paise, promo_code_id, queue_entry_id, created_at, expires_at)
           VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id)
         INSERT INTO hold_items (hold_id, tier_id, quantity, unit_price_paise)
         SELECT h.id, x.t, x.q, x.p FROM h, unnest($12::text[], $13::int[], $14::int[]) AS x(t, q, p)`,
        [holdId, eventId, userId, quantity, subtotal, discount, subtotal - discount, code?.id ?? null, queueEntryId, now, expiresAt, lines.map((l) => l.tierId), lines.map((l) => l.quantity), lines.map((l) => l.unitPrice)],
      );

      // Counters last, and nothing but COMMIT after them: the hot rows stay locked for the shortest possible time.
      // Tiers, then the event, then seats. The response below is built from values already in hand, not re-read.
      await inventory.reserve(c, eventId, lines, now);
      for (const l of lines) if (l.seated) await seats.reserveSeats(c, eventId, l.tierId, l.seatIds, holdId);

      const h: HoldRow = { id: holdId, event_id: eventId, user_id: userId, status: 'ACTIVE', subtotal_paise: subtotal, discount_paise: discount, total_paise: subtotal - discount, promo_code_id: code?.id ?? null, expires_at: expiresAt, pay_started_at: null };
      const items = lines.map((l) => ({ tier_id: l.tierId, quantity: l.quantity, unit_price_paise: l.unitPrice }));
      return { hold: { ...holdJson(h, items, labels), expires_in_seconds: config.holdTtlSeconds } };
    });
    ctx.metrics.inc('holds_created_total');
    return result;
  } catch (err) {
    await taken.undo(); // the database refused: the fast gate's counts go back
    if (err instanceof AppError) ctx.metrics.inc('holds_refused_total', { code: err.code, by: 'database' });
    throw err;
  }
}

// ---- buyer actions on a hold ----

/** A hold past its expiry is expired on the spot, so the answer is never stale. */
export async function getHold(ctx: Ctx, userId: string, holdId: string) {
  await loadHold(ctx.pool, holdId, userId);
  await expireIfDue(ctx);
  const h = await loadHold(ctx.pool, holdId, userId);
  const now = clockNow();
  const open = h.status === 'ACTIVE' || h.status === 'PAYING';
  const order = h.status === 'CONVERTED' ? await one<{ id: string }>(ctx.pool, 'SELECT id FROM orders WHERE hold_id = $1', [h.id]) : undefined;
  return {
    hold: {
      ...holdJson(h, await loadItems(ctx.pool, holdId), await seatLabelsOf(ctx.pool, holdId)),
      seconds_left: open ? Math.max(0, Math.ceil((h.expires_at - now) / 1000)) : 0,
      order_id: order?.id ?? null,
    },
  };
}

/** The buyer gives the seats back. Not allowed while a payment is in flight (money may be on its way). */
export async function releaseHold(ctx: Ctx, userId: string, holdId: string) {
  return withTx(ctx.pool, async (c, after) => {
    const h = await loadHold(c, holdId, userId, true);
    if (h.status === 'PAYING') throw new AppError('PAYMENT_IN_PROGRESS', 409, 'A payment is in progress for this hold');
    if (h.status !== 'ACTIVE') throw new AppError('HOLD_NOT_ACTIVE', 409, 'The hold is no longer active');
    await closeMany(c, [holdId], 'RELEASED', clockNow(), after, ctx);
    return { hold: { id: holdId, status: 'RELEASED' } };
  });
}
