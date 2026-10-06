// What a payment gateway must do for AtomicPass. The simulated gateway implements it today; a real one
// (Cashfree sandbox, Razorpay test mode) is one more file with the same four methods.
export interface WebhookEvent {
  /** Unique per gateway message; the same id arriving twice is processed once. */
  eventId: string;
  type: 'PAYMENT_SUCCESS' | 'PAYMENT_FAILED';
  providerOrderId: string;
  amountPaise: number;
}

export type GatewayStatus = 'PAID' | 'FAILED' | 'PENDING' | 'UNKNOWN';

export interface PaymentProvider {
  readonly name: string;
  /** Create the gateway-side order for one of our payments. */
  createOrder(input: { paymentId: string; amountPaise: number }): Promise<{ providerOrderId: string }>;
  /** The event when the signature is genuine; null when it is not. Throws on a body that is not valid. */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookEvent | null;
  /** The gateway's own opinion of an order, used by reconciliation when a webhook was missed. */
  fetchStatus(providerOrderId: string): Promise<GatewayStatus>;
  /** Give money back. Safe to call again with the same refundId. */
  refund(input: { providerOrderId: string; refundId: string; amountPaise: number }): Promise<{ ref: string }>;
}
