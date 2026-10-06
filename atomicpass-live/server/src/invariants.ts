// The audit: recompute every counter from the rows and report each difference. It runs after every test, is shown on
// the organiser dashboard, and is the tool that proves a change (for example splitting a hot counter) is safe.
import type { Q } from './db.js';
import { all } from './db.js';

export interface Mismatch {
  rule: string;
  subject: string;
  expected: number | string;
  actual: number | string;
}

const HELD = `('ACTIVE', 'PAYING')`;
const LIVE = `('VALID', 'CHECKED_IN')`;

/**
 * I1/I2 sold + held within capacity; I3 tier and event held/sold equal what holds and tickets say; I4 no impossible
 * ticket state; I5 promo uses; I6 a hold is closed exactly when it left ACTIVE/PAYING; I7 one live queue entry per
 * buyer; I8 seats agree with holds and tickets; I9 payments, orders and refunds agree; I10 ticket prices add up to the
 * order total. All events, or just `eventId`.
 */
export async function checkInvariants(q: Q, eventId?: string): Promise<{ ok: boolean; mismatches: Mismatch[] }> {
  const params = [eventId ?? null];
  const mismatches: Mismatch[] = [];
  const audit = async (rule: string, sql: string) => {
    for (const row of await all<Omit<Mismatch, 'rule'>>(q, sql, params)) mismatches.push({ rule, ...row });
  };
  const heldOf = (where: string) => `(SELECT COALESCE(SUM(hi.quantity), 0)::int FROM hold_items hi JOIN holds h ON h.id = hi.hold_id WHERE ${where} AND h.status IN ${HELD})`;
  const soldOf = (where: string) => `(SELECT COUNT(*)::int FROM tickets k WHERE ${where} AND k.status IN ${LIVE})`;

  await audit('I1', `SELECT 'tier ' || id AS subject, capacity AS expected, sold + held AS actual FROM tiers WHERE ($1::text IS NULL OR event_id = $1) AND sold + held > capacity`);
  await audit('I2', `SELECT 'event ' || id AS subject, capacity AS expected, sold + held AS actual FROM events WHERE ($1::text IS NULL OR id = $1) AND sold + held > capacity`);
  await audit('I3', `SELECT subject, expected, actual FROM (SELECT 'tier ' || t.id || ' held' AS subject, ${heldOf('hi.tier_id = t.id')} AS expected, t.held AS actual FROM tiers t WHERE $1::text IS NULL OR t.event_id = $1) x WHERE expected <> actual`);
  await audit('I3', `SELECT subject, expected, actual FROM (SELECT 'tier ' || t.id || ' sold' AS subject, ${soldOf('k.tier_id = t.id')} AS expected, t.sold AS actual FROM tiers t WHERE $1::text IS NULL OR t.event_id = $1) x WHERE expected <> actual`);
  await audit('I3', `SELECT subject, expected, actual FROM (SELECT 'event ' || e.id || ' held' AS subject, ${heldOf('h.event_id = e.id')} AS expected, e.held AS actual FROM events e WHERE $1::text IS NULL OR e.id = $1) x WHERE expected <> actual`);
  await audit('I3', `SELECT subject, expected, actual FROM (SELECT 'event ' || e.id || ' sold' AS subject, ${soldOf('k.event_id = e.id')} AS expected, e.sold AS actual FROM events e WHERE $1::text IS NULL OR e.id = $1) x WHERE expected <> actual`);
  await audit('I4', `SELECT 'ticket ' || id AS subject, 'a legal state' AS expected, status AS actual FROM tickets
                      WHERE ($1::text IS NULL OR event_id = $1)
                        AND ((status = 'VALID' AND (checked_in_at IS NOT NULL OR voided_at IS NOT NULL))
                          OR (status = 'CHECKED_IN' AND (checked_in_at IS NULL OR voided_at IS NOT NULL))
                          OR (status = 'VOID' AND (voided_at IS NULL OR checked_in_at IS NOT NULL)))`);
  await audit('I5', `SELECT subject, expected, actual FROM (SELECT 'promo ' || p.id AS subject,
                       ((SELECT COUNT(*) FROM holds h WHERE h.promo_code_id = p.id AND h.status IN ${HELD})
                        + (SELECT COUNT(*) FROM orders o WHERE o.promo_code_id = p.id AND o.status <> 'REFUNDED'))::int AS expected, p.used AS actual
                       FROM promo_codes p WHERE $1::text IS NULL OR p.event_id = $1) x WHERE expected <> actual`);
  await audit('I6', `SELECT 'hold ' || id AS subject, CASE WHEN status IN ${HELD} THEN 'no closing time' ELSE 'a closing time' END AS expected, status AS actual
                       FROM holds WHERE ($1::text IS NULL OR event_id = $1) AND ((status IN ${HELD} AND closed_at IS NOT NULL) OR (status NOT IN ${HELD} AND closed_at IS NULL))`);
  await audit('I7', `SELECT 'queue ' || event_id || ' ' || user_id AS subject, 1 AS expected, COUNT(*)::int AS actual
                       FROM queue_entries WHERE ($1::text IS NULL OR event_id = $1) AND status IN ('WAITING', 'ADMITTED') GROUP BY event_id, user_id HAVING COUNT(*) > 1`);
  await audit('I8', `SELECT 'seat ' || s.id || ' held by a closed hold' AS subject, 'an open hold' AS expected, COALESCE(h.status, 'no hold') AS actual
                       FROM seats s LEFT JOIN holds h ON h.id = s.hold_id
                      WHERE ($1::text IS NULL OR s.event_id = $1) AND s.status = 'HELD' AND (h.id IS NULL OR h.status NOT IN ${HELD})`);
  await audit('I8', `SELECT 'seat ' || s.id || ' sold without a live ticket' AS subject, 'a live ticket' AS expected, 'none' AS actual
                       FROM seats s WHERE ($1::text IS NULL OR s.event_id = $1) AND s.status = 'SOLD'
                        AND NOT EXISTS (SELECT 1 FROM tickets k WHERE k.seat_id = s.id AND k.status IN ${LIVE})`);
  await audit('I8', `SELECT 'ticket ' || k.id || ' seat not sold' AS subject, 'SOLD' AS expected, s.status AS actual
                       FROM tickets k JOIN seats s ON s.id = k.seat_id WHERE ($1::text IS NULL OR k.event_id = $1) AND k.status IN ${LIVE} AND s.status <> 'SOLD'`);
  await audit('I9', `SELECT 'payment ' || p.id AS subject, 'an order' AS expected, 'none' AS actual FROM payments p JOIN holds h ON h.id = p.hold_id
                      WHERE ($1::text IS NULL OR h.event_id = $1) AND p.status = 'SUCCESS' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.payment_id = p.id)`);
  await audit('I9', `SELECT 'order ' || o.id AS subject, 'a successful payment' AS expected, p.status AS actual FROM orders o JOIN payments p ON p.id = o.payment_id
                      WHERE ($1::text IS NULL OR o.event_id = $1) AND p.status <> 'SUCCESS'`);
  await audit('I9', `SELECT 'payment ' || p.id AS subject, 'a late-payment refund' AS expected, 'none' AS actual FROM payments p JOIN holds h ON h.id = p.hold_id
                      WHERE ($1::text IS NULL OR h.event_id = $1) AND p.status = 'LATE_REFUNDED' AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.kind = 'LATE_PAYMENT')`);
  await audit('I9', `SELECT subject, expected, actual FROM (SELECT 'order ' || o.id || ' refunded' AS subject,
                       (SELECT COALESCE(SUM(r.amount_paise), 0)::int FROM refunds r WHERE r.order_id = o.id) AS expected, o.refunded_paise AS actual
                       FROM orders o WHERE $1::text IS NULL OR o.event_id = $1) x WHERE expected <> actual`);
  await audit('I10', `SELECT subject, expected, actual FROM (SELECT 'order ' || o.id || ' ticket prices' AS subject, o.total_paise AS expected,
                       (SELECT COALESCE(SUM(k.paid_paise), 0)::int FROM tickets k WHERE k.order_id = o.id) AS actual
                       FROM orders o WHERE $1::text IS NULL OR o.event_id = $1) x WHERE expected <> actual`);
  return { ok: mismatches.length === 0, mismatches };
}
