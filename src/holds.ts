import { iso, now as clockNow } from './clock.js';
import { runTx, type Ctx } from './db.js';
import { AppError } from './errors.js';
import { normaliseEmail, randomId, randomToken, sha256 } from './ids.js';
import * as inventory from './inventory.js';

const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);
const bad = (message: string) => new AppError('VALIDATION_ERROR', 400, message);

export interface HoldInput {
  email: string;
  items: { tier_id: string; quantity: number }[];
}

interface TierPrice {
  price_cents: number;
  max_per_order: number;
}

/** Event, tiers and live availability (GET /api/events/:eventId). */
export function availability(ctx: Ctx, eventId: string) {
  const view = inventory.readEvent(ctx.db, eventId, ctx.config.currency);
  if (!view) throw notFound('Event');
  return view;
}

/**
 * Reserve seats (ARCHITECTURE 4.1): validate, take them from the tiers and the pool in one
 * transaction, record the hold. Any refusal is thrown, so nothing stays consumed.
 */
export function createHold(ctx: Ctx, eventId: string, input: HoldInput) {
  const { db, config } = ctx;
  const holdId = randomId('hold');
  const holdToken = randomToken();

  return runTx(db, () => {
    const now = clockNow();
    if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw notFound('Event');
    const emailNorm = normaliseEmail(input.email);
    if (!Array.isArray(input.items) || input.items.length === 0) throw bad('items must not be empty');

    const getTier = db.prepare('SELECT price_cents, max_per_order FROM tiers WHERE id = ? AND event_id = ?');
    const seen = new Set<string>();
    const lines = input.items.map((item) => {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw bad('quantity must be a whole number, at least 1');
      if (seen.has(item.tier_id)) throw bad('each tier may appear only once');
      seen.add(item.tier_id);
      const tier = getTier.get(item.tier_id, eventId) as TierPrice | undefined;
      if (!tier) throw notFound('Tier');
      if (item.quantity > tier.max_per_order) {
        throw new AppError('MAX_PER_ORDER', 422, 'Quantity is above the limit per order', {
          tier_id: item.tier_id,
          max_per_order: tier.max_per_order,
        });
      }
      return { tierId: item.tier_id, quantity: item.quantity, unitPrice: tier.price_cents };
    });

    inventory.reserve(db, eventId, lines, now);

    const quantity = lines.reduce((sum, l) => sum + l.quantity, 0);
    const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
    const expiresAt = now + config.holdTtlSeconds * 1000;
    db.prepare(
      `INSERT INTO holds (id, event_id, email, email_norm, token_hash, status, quantity_total,
                          subtotal_cents, discount_cents, total_cents, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 0, ?, ?, ?)`,
    ).run(holdId, eventId, input.email.trim(), emailNorm, sha256(holdToken), quantity, subtotal, subtotal, now, expiresAt);
    const addItem = db.prepare('INSERT INTO hold_items (hold_id, tier_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)');
    for (const l of lines) addItem.run(holdId, l.tierId, l.quantity, l.unitPrice);

    return {
      hold: {
        id: holdId,
        status: 'ACTIVE',
        event_id: eventId,
        email: input.email.trim(),
        items: lines.map((l) => ({ tier_id: l.tierId, quantity: l.quantity, unit_price_cents: l.unitPrice })),
        subtotal_cents: subtotal,
        discount_cents: 0,
        total_cents: subtotal,
        expires_at: iso(expiresAt),
        expires_in_seconds: config.holdTtlSeconds,
      },
      hold_token: holdToken,
    };
  });
}
