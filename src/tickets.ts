import { iso, now as clockNow } from './clock.js';
import { runTx, type Ctx } from './db.js';
import { AppError } from './errors.js';
import * as inventory from './inventory.js';
import * as payments from './payments.js';
import * as promo from './promo.js';

const QR_PREFIX = 'AP1:';

export interface CheckInInput {
  qr: string;
  gate?: string;
}

interface ScannedTicket {
  id: string;
  tier_id: string;
  tier_name: string;
  event_id: string;
  status: 'VALID' | 'CHECKED_IN' | 'VOID';
  checked_in_at: number | null;
  checked_in_gate: string | null;
}

/**
 * POST /api/checkin (ARCHITECTURE 4.5). One conditional UPDATE (VALID -> CHECKED_IN) decides who is
 * admitted. Refusals are returned, not thrown, so their scan_log row commits with them.
 */
export function checkIn(ctx: Ctx, input: CheckInInput) {
  const { db } = ctx;
  return runTx(db, () => {
    const now = clockNow();
    const gate = input.gate ?? null;
    const log = (ticketId: string | null, result: string) =>
      db.prepare('INSERT INTO scan_log (at, ticket_id, gate, result) VALUES (?, ?, ?, ?)').run(now, ticketId, gate, result);
    const invalid = () => {
      log(null, 'INVALID_QR');
      return new AppError('INVALID_QR', 404, 'Unknown ticket code');
    };

    const qr = input.qr.trim();
    if (!qr.startsWith(QR_PREFIX)) return invalid();
    const token = qr.slice(QR_PREFIX.length);

    const admitted =
      db
        .prepare(`UPDATE tickets SET status = 'CHECKED_IN', checked_in_at = ?, checked_in_gate = ? WHERE qr_token = ? AND status = 'VALID'`)
        .run(now, gate, token).changes === 1;
    const t = db
      .prepare(
        `SELECT t.id, t.tier_id, ti.name AS tier_name, t.event_id, t.status, t.checked_in_at, t.checked_in_gate
           FROM tickets t JOIN tiers ti ON ti.id = t.tier_id WHERE t.qr_token = ?`,
      )
      .get(token) as ScannedTicket | undefined;
    if (!t) return invalid();

    if (admitted) {
      log(t.id, 'ADMITTED');
      return {
        result: 'ADMITTED' as const,
        ticket: { id: t.id, tier_id: t.tier_id, tier_name: t.tier_name, event_id: t.event_id },
        checked_in_at: iso(now),
      };
    }
    if (t.status === 'CHECKED_IN') {
      log(t.id, 'ALREADY_CHECKED_IN');
      return new AppError('ALREADY_CHECKED_IN', 409, 'This ticket was already scanned', {
        checked_in_at: iso(t.checked_in_at!),
        gate: t.checked_in_gate,
      });
    }
    log(t.id, 'TICKET_VOID');
    return new AppError('TICKET_VOID', 409, 'This ticket was refunded');
  });
}

export interface RefundInput {
  ticket_ids?: string[];
  reason?: string; // accepted for the organiser's own records; nothing is stored
}

const checkedIn = () => new AppError('TICKET_CHECKED_IN', 409, 'A ticket that was already scanned cannot be refunded');
const alreadyRefunded = () => new AppError('ALREADY_REFUNDED', 409, 'The ticket was already refunded');

/**
 * POST /api/admin/orders/:id/refund (ARCHITECTURE 4.8). Each ticket is voided by a conditional UPDATE
 * (VALID -> VOID), the same guard check-in uses, so a scan and a refund racing for one ticket have
 * exactly one winner. All or nothing: any refusal rolls the whole refund back.
 */
export function refund(ctx: Ctx, orderId: string, input: RefundInput) {
  const { db } = ctx;
  return runTx(db, () => {
    const now = clockNow();
    const order = db
      .prepare('SELECT event_id, payment_ref, promo_code_id FROM orders WHERE id = ?')
      .get(orderId) as { event_id: string; payment_ref: string; promo_code_id: string | null } | undefined;
    if (!order) throw new AppError('NOT_FOUND', 404, 'Order not found');
    const all = db
      .prepare('SELECT id, tier_id, status, paid_cents FROM tickets WHERE order_id = ? ORDER BY rowid')
      .all(orderId) as { id: string; tier_id: string; status: string; paid_cents: number }[];

    let targets: typeof all;
    if (input.ticket_ids) {
      targets = [...new Set(input.ticket_ids)].map((id) => {
        const t = all.find((x) => x.id === id);
        if (!t) throw new AppError('NOT_FOUND', 404, 'Ticket not found in this order');
        return t;
      });
    } else {
      targets = all.filter((t) => t.status !== 'VOID'); // the whole order: every ticket not yet refunded
      if (targets.length === 0) throw alreadyRefunded();
    }
    if (targets.some((t) => t.status === 'CHECKED_IN')) throw checkedIn();
    if (targets.some((t) => t.status === 'VOID')) throw alreadyRefunded();

    const voidTicket = db.prepare(
      `UPDATE tickets SET status = 'VOID', voided_at = ? WHERE id = ? AND order_id = ? AND status = 'VALID'`,
    );
    let voided = 0;
    for (const t of targets) voided += voidTicket.run(now, t.id, orderId).changes;
    if (voided !== targets.length) throw checkedIn(); // lost a race with a scan: roll back

    const perTier = new Map<string, number>();
    for (const t of targets) perTier.set(t.tier_id, (perTier.get(t.tier_id) ?? 0) + 1);
    inventory.returnSold(db, order.event_id, [...perTier].map(([tierId, quantity]) => ({ tierId, quantity })));

    const refundCents = targets.reduce((sum, t) => sum + t.paid_cents, 0);
    payments.refund(order.payment_ref, refundCents);
    const fullyRefunded = all.every((t) => t.status === 'VOID' || targets.includes(t));
    const status = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    db.prepare('UPDATE orders SET refunded_cents = refunded_cents + ?, status = ? WHERE id = ?').run(refundCents, status, orderId);
    if (fullyRefunded && order.promo_code_id) promo.returnUse(db, order.promo_code_id);

    const refundedTotal = db.prepare('SELECT refunded_cents FROM orders WHERE id = ?').pluck().get(orderId) as number;
    return {
      order: { id: orderId, status, refunded_cents: refundedTotal },
      voided_ticket_ids: targets.map((t) => t.id),
      refunded_cents: refundCents,
    };
  });
}
