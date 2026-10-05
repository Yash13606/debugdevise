// Mock payment provider: deterministic, no network, no keys. Runs inside the caller's transaction.
export type Simulate = 'success' | 'decline';

export function charge(_totalCents: number, reference: string, simulate: Simulate = 'success') {
  return simulate === 'decline' ? ({ ok: false } as const) : ({ ok: true, ref: `mock_${reference}` } as const);
}

export function refund(paymentRef: string, cents: number) {
  return { ok: true, ref: `mock_refund_${paymentRef}_${cents}` } as const;
}
