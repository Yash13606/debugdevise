import { iso, now as clockNow } from './clock.js';
import type { Ctx, Db } from './db.js';
import { AppError } from './errors.js';
import { expireDueHolds } from './holds.js';
import { randomId } from './ids.js';
import * as inventory from './inventory.js';

const bad = (message: string) => new AppError('VALIDATION_ERROR', 400, message);

function parseTime(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw bad(`${field} must be an ISO-8601 date-time`);
  return ms;
}

export interface EventInput {
  name: string;
  starts_at: string;
  capacity: number;
  queue_enabled?: boolean;
}

export function createEvent(ctx: Ctx, input: EventInput) {
  const id = randomId('evt');
  ctx.db
    .prepare('INSERT INTO events (id, name, starts_at, capacity, queue_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, input.name.trim(), parseTime(input.starts_at, 'starts_at'), input.capacity, input.queue_enabled ? 1 : 0, clockNow());
  return { event: inventory.readEvent(ctx.db, id, ctx.config.currency)!.event };
}

export interface TierInput {
  name: string;
  price_cents: number;
  capacity: number;
  max_per_order?: number;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
}

export function createTier(ctx: Ctx, eventId: string, input: TierInput) {
  const { db, config } = ctx;
  const starts = input.sale_starts_at ? parseTime(input.sale_starts_at, 'sale_starts_at') : null;
  const ends = input.sale_ends_at ? parseTime(input.sale_ends_at, 'sale_ends_at') : null;
  if (starts !== null && ends !== null && starts >= ends) throw bad('sale_starts_at must be before sale_ends_at');
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw new AppError('NOT_FOUND', 404, 'Event not found');

  const id = randomId('tier');
  db.prepare(
    `INSERT INTO tiers (id, event_id, name, price_cents, capacity, max_per_order, sale_starts_at, sale_ends_at, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COUNT(*) FROM tiers WHERE event_id = ?), ?)`,
  ).run(id, eventId, input.name.trim(), input.price_cents, input.capacity, input.max_per_order ?? config.defaultMaxPerOrder, starts, ends, eventId, clockNow());
  const view = inventory.readEvent(db, eventId, config.currency)!;
  return { tier: view.tiers.find((t) => t.id === id)! };
}

export interface PromoInput {
  code: string;
  kind: 'PERCENT' | 'FIXED';
  value: number;
  max_uses?: number | null;
  valid_from?: string | null;
  valid_to?: string | null;
  tier_id?: string | null;
}

export function createPromo(ctx: Ctx, eventId: string, input: PromoInput) {
  const { db } = ctx;
  if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw new AppError('NOT_FOUND', 404, 'Event not found');
  if (input.kind === 'PERCENT' && input.value > 100) throw bad('a PERCENT value must be from 1 to 100');
  const from = input.valid_from ? parseTime(input.valid_from, 'valid_from') : null;
  const to = input.valid_to ? parseTime(input.valid_to, 'valid_to') : null;
  if (from !== null && to !== null && from >= to) throw bad('valid_from must be before valid_to');
  const tierId = input.tier_id ?? null;
  if (tierId && !db.prepare('SELECT 1 FROM tiers WHERE id = ? AND event_id = ?').get(tierId, eventId)) {
    throw new AppError('NOT_FOUND', 404, 'Tier not found in this event');
  }

  const id = randomId('promo');
  const code = input.code.trim().toLowerCase();
  try {
    db.prepare(
      `INSERT INTO promo_codes (id, event_id, code, kind, value, max_uses, valid_from, valid_to, tier_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, eventId, code, input.kind, input.value, input.max_uses ?? null, from, to, tierId, clockNow());
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new AppError('PROMO_EXISTS', 409, 'That code already exists for this event');
    }
    throw e;
  }
  return {
    promo: {
      id,
      code,
      kind: input.kind,
      value: input.value,
      max_uses: input.max_uses ?? null,
      used: 0,
      valid_from: from === null ? null : iso(from),
      valid_to: to === null ? null : iso(to),
      tier_id: tierId,
    },
  };
}

/** PATCH /api/admin/events/:id: switch the waiting room on or off. */
export function patchEvent(ctx: Ctx, eventId: string, input: { queue_enabled: boolean }) {
  const { db, config } = ctx;
  if (db.prepare('UPDATE events SET queue_enabled = ? WHERE id = ?').run(input.queue_enabled ? 1 : 0, eventId).changes === 0) {
    throw new AppError('NOT_FOUND', 404, 'Event not found');
  }
  return { event: inventory.readEvent(db, eventId, config.currency)!.event };
}

// ---- stats and the invariant check (DATA_MODEL section 3) ----

export interface Mismatch {
  rule: string;
  subject: string;
  /** What the rows say (for I1 and I2: the capacity that sold + held must not exceed). */
  expected: number | string;
  actual: number | string;
}

/**
 * Recompute the counters from the rows and report every difference: I1/I2 (sold + held within capacity),
 * I3 (tier and event held/sold equal what the holds and tickets say), I4 (no impossible ticket state),
 * I5 (promo uses), I6 (a hold has a closing time exactly when it left ACTIVE), I7 (one live queue entry
 * per buyer). All events, or just `eventId`.
 */
export function checkInvariants(db: Db, eventId?: string): { ok: boolean; mismatches: Mismatch[] } {
  const params = { e: eventId ?? null };
  const mismatches: Mismatch[] = [];
  const audit = (rule: string, sql: string) => {
    for (const row of db.prepare(sql).all(params) as Omit<Mismatch, 'rule'>[]) mismatches.push({ rule, ...row });
  };
  const heldOf = (where: string) =>
    `(SELECT COALESCE(SUM(hi.quantity), 0) FROM hold_items hi JOIN holds h ON h.id = hi.hold_id WHERE ${where} AND h.status = 'ACTIVE')`;
  const soldOf = (where: string) =>
    `(SELECT COUNT(*) FROM tickets k WHERE ${where} AND k.status IN ('VALID', 'CHECKED_IN'))`;

  audit('I1', `SELECT 'tier ' || id AS subject, capacity AS expected, sold + held AS actual FROM tiers
                WHERE (@e IS NULL OR event_id = @e) AND sold + held > capacity`);
  audit('I2', `SELECT 'event ' || id AS subject, capacity AS expected, sold + held AS actual FROM events
                WHERE (@e IS NULL OR id = @e) AND sold + held > capacity`);
  audit('I3', `SELECT 'tier ' || t.id || ' held' AS subject, ${heldOf('hi.tier_id = t.id')} AS expected, t.held AS actual
                 FROM tiers t WHERE (@e IS NULL OR t.event_id = @e) AND expected != actual`);
  audit('I3', `SELECT 'tier ' || t.id || ' sold' AS subject, ${soldOf('k.tier_id = t.id')} AS expected, t.sold AS actual
                 FROM tiers t WHERE (@e IS NULL OR t.event_id = @e) AND expected != actual`);
  audit('I3', `SELECT 'event ' || e.id || ' held' AS subject, ${heldOf('h.event_id = e.id')} AS expected, e.held AS actual
                 FROM events e WHERE (@e IS NULL OR e.id = @e) AND expected != actual`);
  audit('I3', `SELECT 'event ' || e.id || ' sold' AS subject, ${soldOf('k.event_id = e.id')} AS expected, e.sold AS actual
                 FROM events e WHERE (@e IS NULL OR e.id = @e) AND expected != actual`);
  audit('I4', `SELECT 'ticket ' || id AS subject, 'a legal state' AS expected, status AS actual FROM tickets
                WHERE (@e IS NULL OR event_id = @e)
                  AND ((status = 'VALID' AND (checked_in_at IS NOT NULL OR voided_at IS NOT NULL))
                    OR (status = 'CHECKED_IN' AND voided_at IS NOT NULL)
                    OR (status = 'VOID' AND checked_in_at IS NOT NULL))`);
  audit('I5', `SELECT 'promo ' || p.id AS subject,
                      (SELECT COUNT(*) FROM holds h WHERE h.promo_code_id = p.id AND h.status = 'ACTIVE')
                      + (SELECT COUNT(*) FROM orders o WHERE o.promo_code_id = p.id AND o.status != 'REFUNDED') AS expected,
                      p.used AS actual
                 FROM promo_codes p WHERE (@e IS NULL OR p.event_id = @e) AND expected != actual`);
  audit('I6', `SELECT 'hold ' || id AS subject,
                      CASE WHEN status = 'ACTIVE' THEN 'no closing time' ELSE 'a closing time' END AS expected, status AS actual
                 FROM holds WHERE (@e IS NULL OR event_id = @e)
                  AND ((status = 'ACTIVE' AND closed_at IS NOT NULL) OR (status != 'ACTIVE' AND closed_at IS NULL))`);
  audit('I7', `SELECT 'queue ' || event_id || ' ' || email_norm AS subject, 1 AS expected, COUNT(*) AS actual
                 FROM queue_entries WHERE (@e IS NULL OR event_id = @e) AND status IN ('WAITING', 'ADMITTED')
                GROUP BY event_id, email_norm HAVING COUNT(*) > 1`);

  return { ok: mismatches.length === 0, mismatches };
}

/** GET /api/admin/events/:id/stats. Due holds are expired first, so the numbers are current. */
export function stats(ctx: Ctx, eventId: string) {
  const { db, config } = ctx;
  expireDueHolds(ctx);
  return db.transaction(() => {
    const view = inventory.readEvent(db, eventId, config.currency);
    if (!view) throw new AppError('NOT_FOUND', 404, 'Event not found');
    const counts = (table: string, statuses: string[]) => {
      const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM ${table} WHERE event_id = ? GROUP BY status`).all(eventId) as {
        status: string;
        n: number;
      }[];
      return Object.fromEntries(statuses.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0]));
    };
    const { capacity, sold, held, available } = view.event;
    return {
      event: { capacity, sold, held, available },
      tiers: view.tiers.map((t) => ({ id: t.id, capacity: t.capacity, sold: t.sold, held: t.held, available: t.available })),
      tickets: counts('tickets', ['VALID', 'CHECKED_IN', 'VOID']),
      holds: counts('holds', ['ACTIVE', 'CONVERTED', 'EXPIRED', 'RELEASED']),
      queue: counts('queue_entries', ['WAITING', 'ADMITTED', 'USED', 'EXPIRED']),
      invariants: checkInvariants(db, eventId),
    };
  })();
}
