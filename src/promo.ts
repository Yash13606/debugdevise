// Promo codes: a use is counted atomically at hold time and handed back when the hold or order ends.
// Plain functions that run inside the caller's transaction.
import type { Db } from './db.js';
import { AppError } from './errors.js';

export interface Promo {
  id: string;
  kind: 'PERCENT' | 'FIXED';
  value: number;
  tier_id: string | null;
}

const invalid = (reason: string) => new AppError('PROMO_INVALID', 422, `The promo code cannot be used (${reason})`, { reason });

/**
 * Count one use of `code` (ARCHITECTURE 4.1, step 5). One conditional UPDATE decides; when it matches
 * nothing the row is re-read to say why. A later failure in the same transaction gives the use back.
 */
export function reserveUse(db: Db, eventId: string, code: string, now: number): Promo {
  const lower = code.trim().toLowerCase();
  const taken = db
    .prepare(
      `UPDATE promo_codes SET used = used + 1
        WHERE event_id = ? AND code = ?
          AND (max_uses IS NULL OR used < max_uses)
          AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)`,
    )
    .run(eventId, lower, now, now);
  const row = db
    .prepare('SELECT id, kind, value, tier_id, valid_from, valid_to FROM promo_codes WHERE event_id = ? AND code = ?')
    .get(eventId, lower) as (Promo & { valid_from: number | null; valid_to: number | null }) | undefined;
  if (taken.changes === 0) {
    if (!row) throw invalid('NOT_FOUND');
    if (row.valid_from !== null && row.valid_from > now) throw invalid('NOT_STARTED');
    if (row.valid_to !== null && row.valid_to <= now) throw invalid('EXPIRED');
    throw invalid('EXHAUSTED');
  }
  return row!;
}

/** A hold or order that used a code has ended: its use comes back. */
export function returnUse(db: Db, promoId: string): void {
  db.prepare('UPDATE promo_codes SET used = used - 1 WHERE id = ? AND used > 0').run(promoId);
}

/** The code must apply to at least one line when it is limited to a tier. */
export function appliesTo(p: Promo, tierIds: string[]): boolean {
  return p.tier_id === null || tierIds.includes(p.tier_id);
}

/** DATA_MODEL section 5: PERCENT is floor(eligible x value / 100), FIXED is min(value, eligible). */
export function discountFor(p: Promo, lines: { tierId: string; quantity: number; unitPrice: number }[]): number {
  const eligible = lines
    .filter((l) => p.tier_id === null || l.tierId === p.tier_id)
    .reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  return p.kind === 'PERCENT' ? Math.floor((eligible * p.value) / 100) : Math.min(p.value, eligible);
}

/**
 * What each ticket pays once `discount` is spread over the eligible tickets in proportion to price
 * (floor division). The leftover cents go one each to the first eligible tickets that still pay
 * something, so the amounts add up exactly to the order total. BigInt keeps the products exact.
 */
export function spreadDiscount(prices: number[], eligible: boolean[], discount: number): number[] {
  const base = prices.reduce((sum, p, i) => sum + (eligible[i] ? p : 0), 0);
  if (discount === 0 || base === 0) return [...prices];
  const cut = prices.map((p, i) => (eligible[i] ? Number((BigInt(discount) * BigInt(p)) / BigInt(base)) : 0));
  let left = discount - cut.reduce((a, b) => a + b, 0);
  for (let i = 0; i < prices.length && left > 0; i++) {
    if (eligible[i] && prices[i]! - cut[i]! > 0) {
      cut[i]!++;
      left--;
    }
  }
  return prices.map((p, i) => p - cut[i]!);
}
