// Messages (OTP, ticket confirmation) are written to the outbox in the same transaction as the event that
// caused them, so a message exists exactly when its event does. A worker delivers them. Delivery here is the
// demo kind: the message is marked sent and logged, and the app shows it in an inbox. A real SMS/email
// provider replaces the body of deliverPending() and nothing else.
import type { Ctx, Q } from './db.js';
import { all } from './db.js';
import { now as clockNow } from './clock.js';

export async function enqueue(q: Q, phone: string, kind: string, body: string): Promise<void> {
  await q.query('INSERT INTO outbox (phone, kind, body, created_at) VALUES ($1, $2, $3, $4)', [phone, kind, body, clockNow()]);
}

export async function deliverPending(ctx: Ctx, batch = 100): Promise<number> {
  const rows = await all<{ phone: string; kind: string }>(
    ctx.pool,
    `UPDATE outbox SET status = 'SENT', sent_at = $1
      WHERE id IN (SELECT id FROM outbox WHERE status = 'PENDING' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING phone, kind`,
    [clockNow(), batch],
  );
  for (const r of rows) ctx.log.info({ kind: r.kind, to: `${r.phone.slice(0, 5)}*****${r.phone.slice(-2)}` }, 'message delivered (demo)');
  return rows.length;
}

export interface Message {
  id: number;
  kind: string;
  body: string;
  created_at: number;
}

/** The demo inbox: the latest messages sent to a phone. */
export const inbox = (ctx: Ctx, phone: string, limit = 20) =>
  all<Message>(ctx.pool, 'SELECT id, kind, body, created_at FROM outbox WHERE phone = $1 ORDER BY id DESC LIMIT $2', [phone, limit]);
