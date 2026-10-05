import { iso, now as clockNow } from './clock.js';
import { runTx, type Ctx } from './db.js';
import { AppError } from './errors.js';

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
