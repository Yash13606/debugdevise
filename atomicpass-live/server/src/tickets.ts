import { canScan } from './access.js';
import type { User } from './auth.js';
import { iso, now as clockNow } from './clock.js';
import type { Ctx } from './db.js';
import { all, one, withTx } from './db.js';
import { AppError } from './errors.js';
import { randomId } from './ids.js';
import * as inventory from './inventory.js';
import { finishRefund } from './payments/service.js';
import * as promo from './promo.js';
import { notifyFreed } from './waitlist.js';
import { SIGNED_PREFIX, signTicket, verifyTicket } from './qr.js';
import * as seats from './seats.js';

const QR_PREFIX = 'AP1:';
const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);

interface TicketRow {
  id: string;
  event_id: string;
  tier_id: string;
  tier_name: string;
  seat: string | null;
  status: 'VALID' | 'CHECKED_IN' | 'VOID';
  qr_token: string;
}

const ticketJson = (ctx: Ctx, t: TicketRow) => ({
  id: t.id,
  tier_id: t.tier_id,
  tier_name: t.tier_name,
  seat: t.seat,
  status: t.status,
  qr_payload: signTicket(ctx.qr, { t: t.id, e: t.event_id, n: t.tier_name, s: t.seat }),
});

const TICKETS_SQL = `
  SELECT t.id, t.event_id, t.tier_id, ti.name AS tier_name, s.row_label || s.seat_no AS seat, t.status, t.qr_token, t.order_id
    FROM tickets t JOIN tiers ti ON ti.id = t.tier_id LEFT JOIN seats s ON s.id = t.seat_id
   WHERE t.order_id = ANY($1) ORDER BY t.order_id, t.created_at, t.id`;

interface OrderRow {
  id: string;
  status: string;
  total_paise: number;
  refunded_paise: number;
  paid_at: number;
  event_id: string;
  name: string;
  starts_at: number;
  venue: string;
  city: string;
  banner: string;
}

async function ordersView(ctx: Ctx, rows: OrderRow[]) {
  const tix = await all<TicketRow & { order_id: string }>(ctx.pool, TICKETS_SQL, [rows.map((r) => r.id)]);
  const now = clockNow();
  const window = ctx.config.cancelWindowHours * 3_600_000;
  return rows.map((o) => {
    const mine = tix.filter((t) => t.order_id === o.id);
    return {
      id: o.id,
      status: o.status,
      total_paise: o.total_paise,
      refunded_paise: o.refunded_paise,
      paid_at: iso(o.paid_at),
      event: { id: o.event_id, name: o.name, starts_at: iso(o.starts_at), venue: o.venue, city: o.city, banner: o.banner },
      can_cancel: mine.length > 0 && mine.every((t) => t.status === 'VALID') && o.starts_at - now >= window,
      tickets: mine.map((t) => ticketJson(ctx, t)),
    };
  });
}

const ORDER_SELECT = `SELECT o.id, o.status, o.total_paise, o.refunded_paise, o.paid_at, o.event_id, e.name, e.starts_at, e.venue, e.city, e.banner
                        FROM orders o JOIN events e ON e.id = o.event_id`;

export async function listOrders(ctx: Ctx, userId: string) {
  const rows = await all<OrderRow>(ctx.pool, `${ORDER_SELECT} WHERE o.user_id = $1 ORDER BY o.paid_at DESC LIMIT 100`, [userId]);
  return { orders: await ordersView(ctx, rows) };
}

export async function getOrder(ctx: Ctx, userId: string, orderId: string) {
  const row = await one<OrderRow>(ctx.pool, `${ORDER_SELECT} WHERE o.id = $1 AND o.user_id = $2`, [orderId, userId]);
  if (!row) throw notFound('Order');
  return { order: (await ordersView(ctx, [row]))[0]! };
}

/** The signed QR payload of a ticket, for its owner (GET /tickets/:id/qr.svg draws it). */
export async function ticketQr(ctx: Ctx, userId: string, ticketId: string): Promise<string> {
  const t = await one<TicketRow>(
    ctx.pool,
    `SELECT t.id, t.event_id, t.tier_id, ti.name AS tier_name, s.row_label || s.seat_no AS seat, t.status, t.qr_token
       FROM tickets t JOIN orders o ON o.id = t.order_id JOIN tiers ti ON ti.id = t.tier_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE t.id = $1 AND o.user_id = $2`,
    [ticketId, userId],
  );
  if (!t) throw notFound('Ticket');
  return signTicket(ctx.qr, { t: t.id, e: t.event_id, n: t.tier_name, s: t.seat });
}

// ---- the gate ----

export interface CheckInInput {
  qr: string;
  event_id: string;
  gate?: string;
  /** When the scan really happened on the device (epoch ms), for scans synced later. Never in the future, never older than a day. */
  at?: number;
}

/**
 * One conditional UPDATE (VALID -> CHECKED_IN) decides who is admitted. Refusals are returned, not thrown, so their
 * scan_log row commits with them. Only the event's organiser or staff may scan, and a ticket for another event is
 * refused (WRONG_EVENT) without being used. The code may be the signed form (AP2:, checked here with the public key and
 * no database lookup to authenticate it) or the older plain token (AP1:).
 */
export async function checkIn(ctx: Ctx, scanner: User, input: CheckInInput) {
  const result = await withTx(ctx.pool, async (c) => {
    const now = clockNow();
    const when = input.at === undefined ? now : Math.min(now, Math.max(input.at, now - 86_400_000));
    const gate = input.gate ?? null;
    const log = (ticketId: string | null, outcome: string) =>
      c.query('INSERT INTO scan_log (at, ticket_id, event_id, gate, scanned_by, result) VALUES ($1, $2, $3, $4, $5, $6)', [when, ticketId, input.event_id, gate, scanner.id, outcome]);
    const invalid = async () => {
      await log(null, 'INVALID_QR');
      return new AppError('INVALID_QR', 404, 'Unknown ticket code');
    };
    if (!(await canScan(c, scanner.id, input.event_id))) throw new AppError('FORBIDDEN', 403, 'You are not on the gate team for this event');

    const qr = input.qr.trim();
    const cols = 'id, event_id, status, checked_in_at, checked_in_gate';
    type Found = { id: string; event_id: string; status: string; checked_in_at: number | null; checked_in_gate: string | null };
    let t: Found | undefined;
    if (qr.startsWith(SIGNED_PREFIX)) {
      const facts = verifyTicket(ctx.qr, qr);
      if (!facts) return invalid(); // forged or damaged: refused without touching a ticket
      t = await one<Found>(c, `SELECT ${cols} FROM tickets WHERE id = $1`, [facts.t]);
      if (t && t.event_id !== facts.e) t = undefined;
    } else if (qr.startsWith(QR_PREFIX)) {
      t = await one<Found>(c, `SELECT ${cols} FROM tickets WHERE qr_token = $1`, [qr.slice(QR_PREFIX.length)]);
    }
    if (!t) return invalid();
    if (t.event_id !== input.event_id) {
      await log(t.id, 'WRONG_EVENT');
      return new AppError('WRONG_EVENT', 409, 'This ticket is for a different event');
    }

    const won = await one<{ id: string }>(
      c,
      `UPDATE tickets SET status = 'CHECKED_IN', checked_in_at = $2, checked_in_gate = $3, checked_in_by = $4 WHERE id = $1 AND status = 'VALID' RETURNING id`,
      [t.id, when, gate, scanner.id],
    );
    if (won) {
      await log(t.id, 'ADMITTED');
      const info = await one<{ tier_name: string; seat: string | null }>(
        c,
        `SELECT ti.name AS tier_name, s.row_label || s.seat_no AS seat FROM tickets k JOIN tiers ti ON ti.id = k.tier_id LEFT JOIN seats s ON s.id = k.seat_id WHERE k.id = $1`,
        [t.id],
      );
      return { result: 'ADMITTED' as const, ticket: { id: t.id, tier_name: info!.tier_name, seat: info!.seat }, checked_in_at: iso(when) };
    }
    const cur = await one<{ status: string; checked_in_at: number | null; checked_in_gate: string | null }>(c, 'SELECT status, checked_in_at, checked_in_gate FROM tickets WHERE id = $1', [t.id]);
    if (cur!.status === 'CHECKED_IN') {
      await log(t.id, 'ALREADY_CHECKED_IN');
      return new AppError('ALREADY_CHECKED_IN', 409, 'This ticket was already scanned', { checked_in_at: iso(cur!.checked_in_at!), gate: cur!.checked_in_gate });
    }
    await log(t.id, 'TICKET_VOID');
    return new AppError('TICKET_VOID', 409, 'This ticket was refunded');
  });
  ctx.metrics.inc('checkins_total', { result: result.result });
  return result;
}

/**
 * Scans a gate device made while it was offline, sent in one go. Each is decided on its own, exactly as if it had been
 * scanned live, so a ticket that two offline devices both admitted is admitted once and the second is reported
 * ALREADY_CHECKED_IN. Offline scanning cannot stop that double entry at the door; it can only find it afterwards.
 */
export async function checkInBatch(ctx: Ctx, scanner: User, input: { event_id: string; scans: { qr: string; at?: number; gate?: string }[] }) {
  type Out = { qr: string; ok: boolean; code: string; ticket?: { id: string; tier_name: string; seat: string | null } };
  const out: Out[] = new Array(input.scans.length);
  // Decided oldest first, so that when two devices admitted the same ticket the earlier scan is the one that stands.
  const order = input.scans.map((sc, i) => ({ sc, i })).sort((a, b) => (a.sc.at ?? 0) - (b.sc.at ?? 0));
  for (const { sc, i } of order) {
    try {
      const r = await checkIn(ctx, scanner, { qr: sc.qr, event_id: input.event_id, gate: sc.gate, at: sc.at });
      out[i] = { qr: sc.qr, ok: true, code: r.result, ticket: r.ticket };
    } catch (e) {
      if (e instanceof AppError && e.code !== 'FORBIDDEN') out[i] = { qr: sc.qr, ok: false, code: e.code };
      else throw e;
    }
  }
  return { results: out, admitted: out.filter((r) => r.ok).length, refused: out.filter((r) => !r.ok).length };
}

/** Counts and the latest scans, for the gate screen. */
export async function gateSummary(ctx: Ctx, eventId: string) {
  const counts = await all<{ status: string; n: number }>(ctx.pool, 'SELECT status, COUNT(*)::int AS n FROM tickets WHERE event_id = $1 GROUP BY status', [eventId]);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const recent = await all<{ at: number; result: string; gate: string | null; seat: string | null }>(
    ctx.pool,
    `SELECT l.at, l.result, l.gate, s.row_label || s.seat_no AS seat FROM scan_log l LEFT JOIN tickets t ON t.id = l.ticket_id LEFT JOIN seats s ON s.id = t.seat_id
      WHERE l.event_id = $1 ORDER BY l.id DESC LIMIT 15`,
    [eventId],
  );
  return { admitted: n('CHECKED_IN'), waiting: n('VALID'), refunded: n('VOID'), recent: recent.map((r) => ({ ...r, at: iso(r.at) })) };
}

// ---- refunds ----

export interface RefundInput {
  ticket_ids?: string[];
  kind: 'BUYER_CANCEL' | 'ORGANISER';
  /** When set, the order must belong to this buyer (404 otherwise). */
  ownerUserId?: string;
  /** When set, the order's event must belong to this organiser (404 otherwise). */
  organiserUserId?: string;
}

const checkedIn = () => new AppError('TICKET_CHECKED_IN', 409, 'A ticket that was already scanned cannot be refunded');
const alreadyRefunded = () => new AppError('ALREADY_REFUNDED', 409, 'The ticket was already refunded');

/**
 * Each ticket is voided by a conditional UPDATE (VALID -> VOID), the same guard check-in uses, so a scan and a refund
 * racing for one ticket have exactly one winner. All or nothing: any refusal rolls the whole refund back. The money
 * goes back through a PENDING refund row that is finished right after the commit (and retried by reconciliation).
 */
export async function refundOrder(ctx: Ctx, orderId: string, input: RefundInput) {
  const out = await withTx(ctx.pool, async (c, after) => {
    const now = clockNow();
    const order = await one<{ event_id: string; user_id: string; payment_id: string; promo_code_id: string | null; starts_at: number; organiser_id: string | null }>(
      c,
      `SELECT o.event_id, o.user_id, o.payment_id, o.promo_code_id, e.starts_at, e.organiser_id FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    );
    if (!order || (input.ownerUserId && order.user_id !== input.ownerUserId) || (input.organiserUserId && order.organiser_id !== input.organiserUserId)) throw notFound('Order');
    if (input.kind === 'BUYER_CANCEL' && order.starts_at - now < ctx.config.cancelWindowHours * 3_600_000) {
      throw new AppError('CANCEL_WINDOW_CLOSED', 409, `Orders can be cancelled until ${ctx.config.cancelWindowHours} hours before the event`);
    }
    const everything = await all<{ id: string; tier_id: string; seat_id: string | null; status: string; paid_paise: number }>(
      c,
      'SELECT id, tier_id, seat_id, status, paid_paise FROM tickets WHERE order_id = $1 ORDER BY id',
      [orderId],
    );

    let targets: typeof everything;
    if (input.ticket_ids) {
      targets = [...new Set(input.ticket_ids)].sort().map((id) => {
        const t = everything.find((x) => x.id === id);
        if (!t) throw notFound('Ticket in this order');
        return t;
      });
    } else {
      targets = everything.filter((t) => t.status !== 'VOID');
      if (targets.length === 0) throw alreadyRefunded();
    }
    if (input.kind === 'BUYER_CANCEL' && targets.length !== everything.filter((t) => t.status !== 'VOID').length) {
      throw new AppError('VALIDATION_ERROR', 400, 'A buyer cancels the whole order');
    }
    if (targets.some((t) => t.status === 'CHECKED_IN')) throw checkedIn();
    if (targets.some((t) => t.status === 'VOID')) throw alreadyRefunded();

    let voided = 0;
    for (const t of targets) {
      voided += (await c.query(`UPDATE tickets SET status = 'VOID', voided_at = $3 WHERE id = $1 AND order_id = $2 AND status = 'VALID'`, [t.id, orderId, now])).rowCount ?? 0;
    }
    if (voided !== targets.length) throw checkedIn(); // lost a race with a scan: roll back

    const moves = [...targets.reduce((m, t) => m.set(t.tier_id, (m.get(t.tier_id) ?? 0) + 1), new Map<string, number>())].map(([tierId, quantity]) => ({ eventId: order.event_id, tierId, quantity }));
    await inventory.returnSold(c, moves);
    await seats.freeSeats(c, targets.flatMap((t) => (t.seat_id ? [t.seat_id] : [])));

    const amount = targets.reduce((sum, t) => sum + t.paid_paise, 0);
    const fully = everything.every((t) => t.status === 'VOID' || targets.includes(t));
    const status = fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const refundId = randomId('rfd');
    await c.query(`INSERT INTO refunds (id, order_id, payment_id, amount_paise, kind, created_at) VALUES ($1, $2, $3, $4, $5, $6)`, [refundId, orderId, order.payment_id, amount, input.kind, now]);
    const upd = await one<{ refunded_paise: number }>(c, 'UPDATE orders SET refunded_paise = refunded_paise + $2, status = $3 WHERE id = $1 RETURNING refunded_paise', [orderId, amount, status]);
    if (fully && order.promo_code_id) await promo.returnUses(c, [order.promo_code_id]);

    after(async () => {
      await ctx.gate.give(moves);
      await notifyFreed(ctx, moves);
      await finishRefund(ctx, refundId);
    });
    return { order: { id: orderId, status, refunded_paise: upd!.refunded_paise }, voided_ticket_ids: targets.map((t) => t.id), refunded_paise: amount };
  });
  ctx.metrics.inc('refund_requests_total', { kind: input.kind });
  return out;
}
