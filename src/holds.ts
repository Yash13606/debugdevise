import { iso, now as clockNow } from './clock.js';
import { runTx, type Ctx, type Db } from './db.js';
import { AppError } from './errors.js';
import { normaliseEmail, randomId, randomToken, safeEqual, sha256 } from './ids.js';
import * as inventory from './inventory.js';
import * as payments from './payments.js';

const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found`);
const bad = (message: string) => new AppError('VALIDATION_ERROR', 400, message);
const expired = () => new AppError('HOLD_EXPIRED', 410, 'The hold has expired');
const notActive = () => new AppError('HOLD_NOT_ACTIVE', 409, 'The hold is no longer active');

export interface HoldInput {
  email: string;
  items: { tier_id: string; quantity: number }[];
}

interface HoldRow {
  id: string;
  event_id: string;
  email: string;
  email_norm: string;
  promo_code_id: string | null;
  token_hash: string;
  status: 'ACTIVE' | 'CONVERTED' | 'EXPIRED' | 'RELEASED';
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  expires_at: number;
}

interface ItemRow {
  tier_id: string;
  quantity: number;
  unit_price_cents: number;
}

const loadItems = (db: Db, holdId: string) =>
  db.prepare('SELECT tier_id, quantity, unit_price_cents FROM hold_items WHERE hold_id = ? ORDER BY id').all(holdId) as ItemRow[];

/** The hold row, or 404. */
function loadHold(db: Db, holdId: string): HoldRow {
  const h = db.prepare('SELECT * FROM holds WHERE id = ?').get(holdId) as HoldRow | undefined;
  if (!h) throw notFound('Hold');
  return h;
}

/** A missing or wrong x-hold-token is 403. */
function authorise(h: HoldRow, token: string | undefined): void {
  if (!token || !safeEqual(sha256(token), h.token_hash)) throw new AppError('FORBIDDEN', 403, 'Wrong hold token');
}

function holdJson(h: HoldRow, items: ItemRow[]) {
  return {
    id: h.id,
    status: h.status,
    event_id: h.event_id,
    email: h.email,
    items,
    subtotal_cents: h.subtotal_cents,
    discount_cents: h.discount_cents,
    total_cents: h.total_cents,
    expires_at: iso(h.expires_at),
  };
}

// ---- expiry (ARCHITECTURE 4.2) ----

/** ACTIVE -> EXPIRED or RELEASED, giving the seats back. False when the hold had already left ACTIVE. */
function closeHold(db: Db, holdId: string, status: 'EXPIRED' | 'RELEASED', now: number): boolean {
  const closed = db.prepare(`UPDATE holds SET status = ?, closed_at = ? WHERE id = ? AND status = 'ACTIVE'`).run(status, now, holdId);
  if (closed.changes === 0) return false;
  const eventId = db.prepare('SELECT event_id FROM holds WHERE id = ?').pluck().get(holdId) as string;
  inventory.release(db, eventId, loadItems(db, holdId).map((i) => ({ tierId: i.tier_id, quantity: i.quantity })));
  return true;
}

/** Expire every due hold. Runs inside the caller's transaction. */
function expireDue(db: Db, now: number): number {
  const due = db.prepare(`SELECT id FROM holds WHERE status = 'ACTIVE' AND expires_at <= ?`).pluck().all(now) as string[];
  for (const id of due) closeHold(db, id, 'EXPIRED', now);
  return due.length;
}

/** The sweeper and POST /api/admin/sweep: expire every due hold in one transaction. */
export function expireDueHolds(ctx: Ctx): number {
  return runTx(ctx.db, () => expireDue(ctx.db, clockNow()));
}

/** Event, tiers and live availability (GET /api/events/:eventId). Due holds are expired first. */
export function availability(ctx: Ctx, eventId: string) {
  const { db } = ctx;
  if (db.prepare(`SELECT 1 FROM holds WHERE status = 'ACTIVE' AND expires_at <= ? LIMIT 1`).get(clockNow())) {
    expireDueHolds(ctx);
  }
  const view = inventory.readEvent(db, eventId, ctx.config.currency);
  if (!view) throw notFound('Event');
  return view;
}

// ---- reserve (ARCHITECTURE 4.1) ----

/**
 * Reserve seats: expire due holds, validate, take the seats from the tiers and the pool, record the hold,
 * all in one transaction. Any refusal is thrown, so nothing stays consumed.
 */
export function createHold(ctx: Ctx, eventId: string, input: HoldInput) {
  const { db, config } = ctx;
  const holdId = randomId('hold');
  const holdToken = randomToken();

  return runTx(db, () => {
    const now = clockNow();
    expireDue(db, now);
    if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) throw notFound('Event');
    const emailNorm = normaliseEmail(input.email);
    if (!Array.isArray(input.items) || input.items.length === 0) throw bad('items must not be empty');

    const getTier = db.prepare('SELECT price_cents, max_per_order FROM tiers WHERE id = ? AND event_id = ?');
    const seen = new Set<string>();
    const lines = input.items.map((item) => {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw bad('quantity must be a whole number, at least 1');
      if (seen.has(item.tier_id)) throw bad('each tier may appear only once');
      seen.add(item.tier_id);
      const tier = getTier.get(item.tier_id, eventId) as { price_cents: number; max_per_order: number } | undefined;
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
    db.prepare(
      `INSERT INTO holds (id, event_id, email, email_norm, token_hash, status, quantity_total,
                          subtotal_cents, discount_cents, total_cents, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 0, ?, ?, ?)`,
    ).run(holdId, eventId, input.email.trim(), emailNorm, sha256(holdToken), quantity, subtotal, subtotal, now, now + config.holdTtlSeconds * 1000);
    const addItem = db.prepare('INSERT INTO hold_items (hold_id, tier_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)');
    for (const l of [...lines].sort((a, b) => (a.tierId < b.tierId ? -1 : 1))) addItem.run(holdId, l.tierId, l.quantity, l.unitPrice);

    const hold = { ...holdJson(loadHold(db, holdId), loadItems(db, holdId)), expires_in_seconds: config.holdTtlSeconds };
    return { hold, hold_token: holdToken };
  });
}

// ---- buyer actions on a hold ----

/** GET /api/holds/:id. A hold past its expiry is expired on the spot, so the answer is never stale. */
export function getHold(ctx: Ctx, holdId: string, token: string | undefined) {
  const { db } = ctx;
  return runTx(db, () => {
    const now = clockNow();
    authorise(loadHold(db, holdId), token);
    expireDue(db, now);
    const h = loadHold(db, holdId);
    const secondsLeft = h.status === 'ACTIVE' ? Math.ceil((h.expires_at - now) / 1000) : 0;
    return { hold: { ...holdJson(h, loadItems(db, holdId)), seconds_left: secondsLeft } };
  });
}

/** DELETE /api/holds/:id: the buyer gives the seats back. */
export function releaseHold(ctx: Ctx, holdId: string, token: string | undefined) {
  const { db } = ctx;
  return runTx(db, () => {
    authorise(loadHold(db, holdId), token);
    if (!closeHold(db, holdId, 'RELEASED', clockNow())) throw notActive();
    return { hold: { id: holdId, status: 'RELEASED' } };
  });
}

export interface PayInput {
  payment_method?: 'mock';
  simulate?: 'success' | 'decline';
}

/** The order a hold was converted into, with its tickets (QR payload = `AP1:` + token). */
function orderView(db: Db, holdId: string) {
  const o = db
    .prepare('SELECT id, status, total_cents, refunded_cents, paid_at FROM orders WHERE hold_id = ?')
    .get(holdId) as { id: string; status: string; total_cents: number; refunded_cents: number; paid_at: number };
  const tickets = db
    .prepare('SELECT id, tier_id, status, qr_token FROM tickets WHERE order_id = ? ORDER BY rowid')
    .all(o.id) as { id: string; tier_id: string; status: string; qr_token: string }[];
  return {
    order: { id: o.id, status: o.status, total_cents: o.total_cents, refunded_cents: o.refunded_cents, paid_at: iso(o.paid_at) },
    tickets: tickets.map((t) => ({ id: t.id, tier_id: t.tier_id, status: t.status, qr_payload: `AP1:${t.qr_token}` })),
  };
}

/** GET /api/orders/:id: needs the token of the hold the order came from. */
export function getOrder(ctx: Ctx, orderId: string, token: string | undefined) {
  const { db } = ctx;
  return db.transaction(() => {
    const o = db.prepare('SELECT hold_id FROM orders WHERE id = ?').get(orderId) as { hold_id: string } | undefined;
    if (!o) throw notFound('Order');
    authorise(loadHold(db, o.hold_id), token);
    return orderView(db, o.hold_id);
  })();
}

/**
 * POST /api/holds/:id/pay (ARCHITECTURE 4.3): charge, convert held to sold, create the order and one
 * ticket per seat, all in one transaction. A second call returns the same order (`replay`).
 */
export function payHold(ctx: Ctx, holdId: string, token: string | undefined, input: PayInput) {
  const { db } = ctx;
  return runTx(db, () => {
    const now = clockNow();
    const h = loadHold(db, holdId);
    authorise(h, token);
    if (h.status === 'CONVERTED') return { replay: true, ...orderView(db, holdId) };
    if (h.status === 'EXPIRED') return expired();
    if (h.status === 'RELEASED') return notActive();
    if (h.expires_at <= now) {
      closeHold(db, holdId, 'EXPIRED', now);
      return expired(); // returned, not thrown: the expiry commits
    }

    const charge = payments.charge(h.total_cents, h.id, input.simulate);
    if (!charge.ok) throw new AppError('PAYMENT_FAILED', 402, 'The payment was declined'); // rolls back; the hold stays ACTIVE

    const moved = db
      .prepare(`UPDATE holds SET status = 'CONVERTED', closed_at = ? WHERE id = ? AND status = 'ACTIVE' AND expires_at > ?`)
      .run(now, h.id, now);
    if (moved.changes === 0) throw notActive();
    const items = loadItems(db, h.id);
    inventory.convert(db, h.event_id, items.map((i) => ({ tierId: i.tier_id, quantity: i.quantity })));

    const orderId = randomId('ord');
    db.prepare(
      `INSERT INTO orders (id, hold_id, event_id, email, email_norm, status, subtotal_cents, discount_cents,
                           total_cents, promo_code_id, payment_ref, paid_at)
       VALUES (?, ?, ?, ?, ?, 'PAID', ?, ?, ?, ?, ?, ?)`,
    ).run(orderId, h.id, h.event_id, h.email, h.email_norm, h.subtotal_cents, h.discount_cents, h.total_cents, h.promo_code_id, charge.ref, now);
    const addTicket = db.prepare(
      `INSERT INTO tickets (id, order_id, event_id, tier_id, qr_token, status, paid_cents, created_at)
       VALUES (?, ?, ?, ?, ?, 'VALID', ?, ?)`,
    );
    for (const item of items) {
      for (let n = 0; n < item.quantity; n++) {
        addTicket.run(randomId('tkt'), orderId, h.event_id, item.tier_id, randomToken(), item.unit_price_cents, now);
      }
    }
    return { replay: false, ...orderView(db, h.id) };
  });
}
