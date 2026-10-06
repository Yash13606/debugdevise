// Payments. A checkout moves the hold ACTIVE -> PAYING and gets a gateway order. The gateway later sends a signed
// webhook; every message is stored once (webhook_events, keyed by its id) so redelivery is harmless. Money beats the
// timer as long as the seats are still ours: a success that arrives after the hold's expiry but before anyone closed
// it still converts, because nobody else can have taken those seats. A success that arrives after the hold was closed
// cannot be honoured, so it is refunded (LATE_PAYMENT). Reconciliation catches webhooks that never came.
import { now as clockNow } from '../clock.js';
import type { Conn, Ctx } from '../db.js';
import { all, one, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { randomId, randomToken } from '../ids.js';
import { loadHold, loadItems, closeMany } from '../holds.js';
import * as inventory from '../inventory.js';
import { enqueue } from '../notify.js';
import * as promo from '../promo.js';
import * as seats from '../seats.js';
import type { WebhookEvent } from './provider.js';

interface PaymentRow {
  id: string;
  hold_id: string;
  user_id: string;
  provider: string;
  provider_order_id: string;
  amount_paise: number;
  status: 'CREATED' | 'SUCCESS' | 'FAILED' | 'LATE_REFUNDED';
}

const FREE = 'free';

/** Start paying for a hold. Idempotent: a second call while a payment is open returns the same one. */
export async function startCheckout(ctx: Ctx, userId: string, holdId: string) {
  // Phase 1: validate. The gateway call happens outside any transaction, as it would with a real network gateway.
  const prep = await withTx(ctx.pool, async (c, after) => {
    const now = clockNow();
    const h = await loadHold(c, holdId, userId, true);
    if (h.status === 'CONVERTED') return { done: await orderIdOf(c, holdId) } as const;
    if (h.status === 'EXPIRED') return new AppError('HOLD_EXPIRED', 410, 'The hold has expired');
    if (h.status === 'RELEASED') return new AppError('HOLD_NOT_ACTIVE', 409, 'The hold is no longer active');
    if (h.expires_at <= now) {
      await closeMany(c, [holdId], 'EXPIRED', now, after, ctx);
      return new AppError('HOLD_EXPIRED', 410, 'The hold has expired'); // returned: the expiry commits
    }
    const open = await one<PaymentRow>(c, `SELECT * FROM payments WHERE hold_id = $1 AND status = 'CREATED' ORDER BY created_at DESC LIMIT 1`, [holdId]);
    return { hold: h, open } as const;
  });
  if ('done' in prep) return { replay: true, order_id: prep.done, payment: null };
  if (prep.open) return { replay: false, order_id: null, payment: paymentJson(prep.open) };

  const h = prep.hold;
  if (h.total_paise === 0) return freeCheckout(ctx, userId, holdId);

  const paymentId = randomId('pay');
  const gateway = await ctx.provider.createOrder({ paymentId, amountPaise: h.total_paise });

  // Phase 2: record the payment and extend the hold once, so a slow UPI approval does not lose the seats.
  return withTx(ctx.pool, async (c, after) => {
    const now = clockNow();
    const cur = await loadHold(c, holdId, userId, true);
    if (cur.status === 'CONVERTED') return { replay: true, order_id: await orderIdOf(c, holdId), payment: null };
    const open = await one<PaymentRow>(c, `SELECT * FROM payments WHERE hold_id = $1 AND status = 'CREATED' ORDER BY created_at DESC LIMIT 1`, [holdId]);
    if (open) return { replay: false, order_id: null, payment: paymentJson(open) };
    if (cur.status !== 'ACTIVE' && cur.status !== 'PAYING') return new AppError('HOLD_NOT_ACTIVE', 409, 'The hold is no longer active');
    if (cur.expires_at <= now) {
      await closeMany(c, [holdId], 'EXPIRED', now, after, ctx);
      return new AppError('HOLD_EXPIRED', 410, 'The hold has expired');
    }
    await c.query(
      `UPDATE holds SET status = 'PAYING',
              expires_at = CASE WHEN pay_started_at IS NULL THEN GREATEST(expires_at, $2::bigint + $3::bigint) ELSE expires_at END,
              pay_started_at = COALESCE(pay_started_at, $2::bigint)
        WHERE id = $1 AND status IN ('ACTIVE', 'PAYING')`,
      [holdId, now, ctx.config.payWindowSeconds * 1000],
    );
    const p = await one<PaymentRow>(
      c,
      `INSERT INTO payments (id, hold_id, user_id, provider, provider_order_id, amount_paise, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'CREATED', $7, $7) RETURNING *`,
      [paymentId, holdId, userId, ctx.provider.name, gateway.providerOrderId, h.total_paise, now],
    );
    ctx.metrics.inc('payments_started_total');
    return { replay: false, order_id: null, payment: paymentJson(p!) };
  });
}

const paymentJson = (p: PaymentRow) => ({ id: p.id, provider: p.provider, provider_order_id: p.provider_order_id, amount_paise: p.amount_paise, status: p.status });

const orderIdOf = async (c: Conn | Ctx['pool'], holdId: string) => (await one<{ id: string }>(c, 'SELECT id FROM orders WHERE hold_id = $1', [holdId]))?.id ?? null;

/** A hold worth nothing (free tickets, or a promo that covers everything) needs no gateway. */
async function freeCheckout(ctx: Ctx, userId: string, holdId: string) {
  return withTx(ctx.pool, async (c, after) => {
    const now = clockNow();
    const h = await loadHold(c, holdId, userId, true);
    if (h.status === 'CONVERTED') return { replay: true, order_id: await orderIdOf(c, holdId), payment: null };
    if (h.status !== 'ACTIVE' && h.status !== 'PAYING') return new AppError('HOLD_NOT_ACTIVE', 409, 'The hold is no longer active');
    if (h.expires_at <= now) {
      await closeMany(c, [holdId], 'EXPIRED', now, after, ctx);
      return new AppError('HOLD_EXPIRED', 410, 'The hold has expired');
    }
    const p = await one<PaymentRow>(
      c,
      `INSERT INTO payments (id, hold_id, user_id, provider, provider_order_id, amount_paise, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 0, 'CREATED', $6, $6) RETURNING *`,
      [randomId('pay'), holdId, userId, FREE, `free_${holdId}`, now],
    );
    const result = await settleSuccess(ctx, c, after, p!, now);
    return { replay: false, order_id: result.orderId, payment: null };
  });
}

// ---- turning a payment into an order, or into a refund ----

interface Settled {
  kind: 'ORDER' | 'REPLAY' | 'LATE' | 'IGNORED';
  orderId: string | null;
}

/** Runs inside a transaction that holds the payment row's lock. */
async function settleSuccess(ctx: Ctx, c: Conn, after: (f: () => Promise<void>) => void, payment: PaymentRow, now: number): Promise<Settled> {
  if (payment.status === 'SUCCESS') return { kind: 'REPLAY', orderId: await orderIdOf(c, payment.hold_id) };
  if (payment.status === 'LATE_REFUNDED') return { kind: 'IGNORED', orderId: null };

  const hold = await one<{ id: string; event_id: string; user_id: string; subtotal_paise: number; discount_paise: number; total_paise: number; promo_code_id: string | null }>(
    c,
    `UPDATE holds SET status = 'CONVERTED', closed_at = $2 WHERE id = $1 AND status IN ('ACTIVE', 'PAYING')
     RETURNING id, event_id, user_id, subtotal_paise, discount_paise, total_paise, promo_code_id`,
    [payment.hold_id, now],
  );

  if (!hold) {
    // The hold was closed first: the seats may belong to someone else now. Give the money back.
    await c.query(`UPDATE payments SET status = 'LATE_REFUNDED', updated_at = $2 WHERE id = $1`, [payment.id, now]);
    const refundId = randomId('rfd');
    await c.query(
      `INSERT INTO refunds (id, order_id, payment_id, amount_paise, kind, created_at) VALUES ($1, NULL, $2, $3, 'LATE_PAYMENT', $4)`,
      [refundId, payment.id, payment.amount_paise, now],
    );
    ctx.metrics.inc('payments_late_refunded_total');
    after(async () => void (await finishRefund(ctx, refundId)));
    return { kind: 'LATE', orderId: null };
  }

  const items = await loadItems(c, hold.id);
  const moves = items.map((i) => ({ eventId: hold.event_id, tierId: i.tier_id, quantity: i.quantity }));
  await inventory.convert(c, moves);
  const seatsByTier = await seats.sellSeats(c, hold.id);

  const orderId = randomId('ord');
  await c.query(
    `INSERT INTO orders (id, hold_id, payment_id, user_id, event_id, status, subtotal_paise, discount_paise, total_paise, promo_code_id, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'PAID', $6, $7, $8, $9, $10)`,
    [orderId, hold.id, payment.id, hold.user_id, hold.event_id, hold.subtotal_paise, hold.discount_paise, hold.total_paise, hold.promo_code_id, now],
  );
  const promoTier = hold.promo_code_id ? (await one<{ tier_id: string | null }>(c, 'SELECT tier_id FROM promo_codes WHERE id = $1', [hold.promo_code_id]))!.tier_id : null;
  const perSeat = items.flatMap((i) => Array.from({ length: i.quantity }, () => i));
  const paid = promo.spreadDiscount(
    perSeat.map((s) => s.unit_price_paise),
    perSeat.map((s) => promoTier === null || s.tier_id === promoTier),
    hold.discount_paise,
  );
  for (const [n, seat] of perSeat.entries()) {
    const seatId = seatsByTier.get(seat.tier_id)?.shift() ?? null;
    await c.query(
      `INSERT INTO tickets (id, order_id, event_id, tier_id, seat_id, qr_token, status, paid_paise, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'VALID', $7, $8)`,
      [randomId('tkt'), orderId, hold.event_id, seat.tier_id, seatId, randomToken(), paid[n], now],
    );
  }
  await c.query(`UPDATE payments SET status = 'SUCCESS', updated_at = $2 WHERE id = $1`, [payment.id, now]);

  const who = await one<{ phone: string; name: string }>(
    c,
    `SELECT u.phone, e.name FROM users u, events e WHERE u.id = $1 AND e.id = $2`,
    [hold.user_id, hold.event_id],
  );
  if (who) await enqueue(c, who.phone, 'TICKETS', `Booking confirmed: ${perSeat.length} ticket${perSeat.length > 1 ? 's' : ''} for ${who.name}. Order ${orderId}. Show the QR at the gate.`);
  ctx.metrics.inc('orders_created_total');
  return { kind: 'ORDER', orderId };
}

async function settleFailure(c: Conn, payment: PaymentRow, now: number): Promise<void> {
  if (payment.status !== 'CREATED') return;
  await c.query(`UPDATE payments SET status = 'FAILED', updated_at = $2 WHERE id = $1`, [payment.id, now]);
  // The buyer may try again until the hold expires; its (already extended) expiry is unchanged.
  await c.query(`UPDATE holds SET status = 'ACTIVE' WHERE id = $1 AND status = 'PAYING'`, [payment.hold_id]);
}

/**
 * Apply one gateway outcome (from a webhook or from reconciliation). The event id is stored first; if it was already
 * stored, nothing else happens. Storing and acting are one transaction, so a crash in between replays the event.
 */
export async function applyOutcome(ctx: Ctx, ev: WebhookEvent, payload: unknown): Promise<'processed' | 'duplicate' | 'ignored'> {
  return withTx(ctx.pool, async (c, after) => {
    const now = clockNow();
    const fresh = await c.query(
      `INSERT INTO webhook_events (event_id, provider, payload, received_at) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING`,
      [ev.eventId, ctx.provider.name, JSON.stringify(payload), now],
    );
    if (fresh.rowCount === 0) return 'duplicate' as const;

    const payment = await one<PaymentRow>(c, 'SELECT * FROM payments WHERE provider_order_id = $1 FOR UPDATE', [ev.providerOrderId]);
    if (!payment) return 'ignored' as const;
    if (payment.amount_paise !== ev.amountPaise) {
      await c.query(
        `INSERT INTO reconciliation_issues (payment_id, kind, detail, created_at) VALUES ($1, 'AMOUNT_MISMATCH', $2, $3)`,
        [payment.id, `gateway says ${ev.amountPaise}, we expected ${payment.amount_paise}`, now],
      );
      return 'ignored' as const;
    }
    if (ev.type === 'PAYMENT_SUCCESS') await settleSuccess(ctx, c, after, payment, now);
    else await settleFailure(c, payment, now);
    return 'processed' as const;
  });
}

/** POST /webhooks/payments: verify the signature, then apply. A bad signature is 401 and nothing is stored. */
export async function handleWebhook(ctx: Ctx, rawBody: string, headers: Record<string, string | undefined>) {
  const ev = ctx.provider.verifyWebhook(rawBody, headers);
  if (!ev) {
    ctx.metrics.inc('webhooks_total', { result: 'bad_signature' });
    throw new AppError('BAD_SIGNATURE', 401, 'Webhook signature is not valid');
  }
  const result = await applyOutcome(ctx, ev, JSON.parse(rawBody));
  ctx.metrics.inc('webhooks_total', { result });
  return { result };
}

// ---- refunds that finish at the gateway ----

/** Tell the gateway to give the money back, then mark the refund done. A failure leaves it PENDING for a retry. */
export async function finishRefund(ctx: Ctx, refundId: string): Promise<boolean> {
  const r = await one<{ id: string; amount_paise: number; status: string; provider: string; provider_order_id: string }>(
    ctx.pool,
    `SELECT r.id, r.amount_paise, r.status, p.provider, p.provider_order_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1`,
    [refundId],
  );
  if (!r || r.status === 'DONE') return true;
  try {
    const ref = r.provider === FREE || r.amount_paise === 0 ? { ref: 'none' } : await ctx.provider.refund({ providerOrderId: r.provider_order_id, refundId: r.id, amountPaise: r.amount_paise });
    await ctx.pool.query(`UPDATE refunds SET status = 'DONE', provider_ref = $2, done_at = $3 WHERE id = $1 AND status = 'PENDING'`, [r.id, ref.ref, clockNow()]);
    ctx.metrics.inc('refunds_done_total');
    return true;
  } catch (err) {
    ctx.metrics.inc('refunds_failed_total');
    ctx.log.warn({ refundId, err: (err as Error).message }, 'refund will be retried');
    return false;
  }
}

export async function finishPendingRefunds(ctx: Ctx): Promise<number> {
  const pending = await all<{ id: string }>(ctx.pool, `SELECT id FROM refunds WHERE status = 'PENDING' ORDER BY created_at LIMIT 100`);
  let done = 0;
  for (const p of pending) if (await finishRefund(ctx, p.id)) done++;
  return done;
}

// ---- reconciliation ----

export interface ReconcileReport {
  settled: number;
  failed: number;
  still_pending: number;
  refunds_finished: number;
  issues: number;
}

const issue = (c: Ctx['pool'], paymentId: string | null, kind: string, detail: string) =>
  c.query(
    `INSERT INTO reconciliation_issues (payment_id, kind, detail, created_at)
     SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM reconciliation_issues WHERE payment_id IS NOT DISTINCT FROM $1 AND kind = $2)`,
    [paymentId, kind, detail, clockNow()],
  );

/**
 * For payments the gateway has not told us about (webhook lost or late), ask the gateway and apply its answer through
 * the same code as a webhook. Then finish pending refunds, and flag any payment we call successful that the gateway
 * does not.
 */
export async function reconcile(ctx: Ctx): Promise<ReconcileReport> {
  const report: ReconcileReport = { settled: 0, failed: 0, still_pending: 0, refunds_finished: 0, issues: 0 };
  const cutoff = clockNow() - ctx.config.reconcileAgeSeconds * 1000;
  const open = await all<PaymentRow>(ctx.pool, `SELECT * FROM payments WHERE status = 'CREATED' AND provider <> $2 AND created_at <= $1 ORDER BY created_at LIMIT 200`, [cutoff, FREE]);
  for (const p of open) {
    const st = await ctx.provider.fetchStatus(p.provider_order_id);
    if (st === 'PAID' || st === 'FAILED') {
      const ev: WebhookEvent = { eventId: `recon_${p.id}_${st}`, type: st === 'PAID' ? 'PAYMENT_SUCCESS' : 'PAYMENT_FAILED', providerOrderId: p.provider_order_id, amountPaise: p.amount_paise };
      if ((await applyOutcome(ctx, ev, { source: 'reconciliation', status: st })) === 'processed') st === 'PAID' ? report.settled++ : report.failed++;
    } else if (st === 'UNKNOWN') {
      await issue(ctx.pool, p.id, 'GATEWAY_UNKNOWN_ORDER', 'the gateway has no such order');
    } else report.still_pending++;
  }
  report.refunds_finished = await finishPendingRefunds(ctx);

  const recent = await all<PaymentRow>(ctx.pool, `SELECT * FROM payments WHERE status = 'SUCCESS' AND provider <> $2 AND updated_at >= $1 LIMIT 1000`, [clockNow() - 86_400_000, FREE]);
  for (const p of recent) {
    if ((await ctx.provider.fetchStatus(p.provider_order_id)) !== 'PAID') await issue(ctx.pool, p.id, 'SUCCESS_NOT_PAID_AT_GATEWAY', 'we sold tickets but the gateway shows no payment');
  }
  report.issues = await one<{ n: number }>(ctx.pool, 'SELECT COUNT(*)::int AS n FROM reconciliation_issues').then((r) => r!.n);
  return report;
}
