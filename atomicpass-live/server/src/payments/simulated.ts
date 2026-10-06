// A pretend payment gateway that keeps its own books (sim_gateway_orders) and speaks like a real one:
// it signs webhooks, it can deliver them late or twice, and it can disagree with us until reconciled.
import type { Pool } from '../db.js';
import { one, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { hmacHex, randomId, safeEqual } from '../ids.js';
import type { GatewayStatus, PaymentProvider, WebhookEvent } from './provider.js';

export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated';

  constructor(
    private pool: Pool,
    private secret: string,
  ) {}

  async createOrder({ amountPaise }: { paymentId: string; amountPaise: number }) {
    const providerOrderId = randomId('sim');
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO sim_gateway_orders (provider_order_id, amount_paise, status, created_at, updated_at) VALUES ($1, $2, 'CREATED', $3, $3)`,
      [providerOrderId, amountPaise, now],
    );
    return { providerOrderId };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookEvent | null {
    const sig = headers['x-signature'];
    if (!sig || !safeEqual(sig, hmacHex(this.secret, rawBody))) return null;
    const b = JSON.parse(rawBody) as { event_id?: unknown; type?: unknown; provider_order_id?: unknown; amount_paise?: unknown };
    if (
      typeof b.event_id !== 'string' ||
      typeof b.provider_order_id !== 'string' ||
      !Number.isInteger(b.amount_paise) ||
      (b.type !== 'PAYMENT_SUCCESS' && b.type !== 'PAYMENT_FAILED')
    ) {
      throw new AppError('VALIDATION_ERROR', 400, 'Malformed webhook body');
    }
    return { eventId: b.event_id, type: b.type, providerOrderId: b.provider_order_id, amountPaise: b.amount_paise as number };
  }

  async fetchStatus(providerOrderId: string): Promise<GatewayStatus> {
    const row = await one<{ status: string }>(this.pool, 'SELECT status FROM sim_gateway_orders WHERE provider_order_id = $1', [providerOrderId]);
    if (!row) return 'UNKNOWN';
    return row.status === 'PAID' ? 'PAID' : row.status === 'FAILED' ? 'FAILED' : 'PENDING';
  }

  async refund({ providerOrderId, refundId, amountPaise }: { providerOrderId: string; refundId: string; amountPaise: number }) {
    // Idempotent per refundId: the books move only the first time that id is seen.
    const ref = `simref_${refundId}`;
    const now = Date.now();
    await withTx(this.pool, async (c) => {
      const fresh = await c.query(
        `INSERT INTO sim_gateway_refunds (refund_id, provider_order_id, amount_paise, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (refund_id) DO NOTHING`,
        [refundId, providerOrderId, amountPaise, now],
      );
      if (fresh.rowCount === 0) return;
      const r = await c.query(
        `UPDATE sim_gateway_orders SET refunded_paise = refunded_paise + $2, updated_at = $3
          WHERE provider_order_id = $1 AND status = 'PAID' AND refunded_paise + $2 <= amount_paise`,
        [providerOrderId, amountPaise, now],
      );
      if (r.rowCount !== 1) throw new AppError('REFUND_REJECTED', 502, 'The gateway rejected the refund');
    });
    return { ref };
  }

  // ---- the gateway's own side, used by the demo "pay" screen and by tests ----

  /** The customer finished (or abandoned) the payment: the gateway records it and returns the signed webhook to send. */
  async settle(providerOrderId: string, outcome: 'success' | 'failure'): Promise<{ rawBody: string; headers: Record<string, string> } | null> {
    const status = outcome === 'success' ? 'PAID' : 'FAILED';
    const row = await one<{ amount_paise: number }>(
      this.pool,
      `UPDATE sim_gateway_orders SET status = $2, updated_at = $3 WHERE provider_order_id = $1 AND status = 'CREATED' RETURNING amount_paise`,
      [providerOrderId, status, Date.now()],
    );
    if (!row) return null;
    return this.signedWebhook(providerOrderId, row.amount_paise, outcome === 'success' ? 'PAYMENT_SUCCESS' : 'PAYMENT_FAILED');
  }

  signedWebhook(providerOrderId: string, amountPaise: number, type: WebhookEvent['type'], eventId = randomId('whk')) {
    const rawBody = JSON.stringify({ event_id: eventId, type, provider_order_id: providerOrderId, amount_paise: amountPaise });
    return { rawBody, headers: { 'x-signature': hmacHex(this.secret, rawBody), 'content-type': 'application/json' } };
  }
}
