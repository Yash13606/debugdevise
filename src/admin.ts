import { iso, now as clockNow } from './clock.js';
import type { Ctx } from './db.js';
import { AppError } from './errors.js';
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
