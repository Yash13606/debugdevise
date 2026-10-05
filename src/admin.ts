import { now as clockNow } from './clock.js';
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
