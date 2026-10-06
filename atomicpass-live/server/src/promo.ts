// Promo codes: a use is counted atomically at hold time and handed back when the hold or order ends.
import type { Conn } from './db.js';
import { one } from './db.js';
import { AppError } from './errors.js';

export interface Promo {
  id: string;
  kind: 'PERCENT' | 'FIXED';
  value: number;
  tier_id: string | null;
}

const invalid = (reason: string) => new AppError('PROMO_INVALID', 422, `The promo code cannot be used (${reason})`, { reason });

/** Count one use of `code`. One conditional UPDATE decides; when it matches nothing the row is re-read to say why. */
export async function reserveUse(c: Conn, eventId: string, code: string, now: number): Promise<Promo> {
  const lower = code.trim().toLowerCase();
  const row = await one<Promo>(
    c,
    `UPDATE promo_codes SET used = used + 1
      WHERE event_id = $1 AND code = $2
        AND (max_uses IS NULL OR used < max_uses)
        AND (valid_from IS NULL OR valid_from <= $3) AND (valid_to IS NULL OR valid_to > $3)
      RETURNING id, kind, value, tier_id`,
    [eventId, lower, now],
  );
  if (row) return row;
  const why = await one<{ valid_from: number | null; valid_to: number | null }>(
    c,
    'SELECT valid_from, valid_to FROM promo_codes WHERE event_id = $1 AND code = $2',
    [eventId, lower],
  );
  if (!why) throw invalid('NOT_FOUND');
  if (why.valid_from !== null && why.valid_from > now) throw invalid('NOT_STARTED');
  if (why.valid_to !== null && why.valid_to <= now) throw invalid('EXPIRED');
  throw invalid('EXHAUSTED');
}

/** Holds or orders that used a code have ended: their uses come back. */
export async function returnUses(c: Conn, promoIds: string[]): Promise<void> {
  for (const id of [...promoIds].sort()) await c.query('UPDATE promo_codes SET used = used - 1 WHERE id = $1 AND used > 0', [id]);
}

export const appliesTo = (p: Promo, tierIds: string[]): boolean => p.tier_id === null || tierIds.includes(p.tier_id);

/** PERCENT is floor(eligible x value / 100), FIXED is min(value, eligible). */
export function discountFor(p: Promo, lines: { tierId: string; quantity: number; unitPrice: number }[]): number {
  const eligible = lines.filter((l) => p.tier_id === null || l.tierId === p.tier_id).reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  return p.kind === 'PERCENT' ? Math.floor((eligible * p.value) / 100) : Math.min(p.value, eligible);
}

/**
 * What each ticket pays once `discount` is spread over the eligible tickets in proportion to price
 * (floor division). The leftover paise go one each to the first eligible tickets that still pay
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
