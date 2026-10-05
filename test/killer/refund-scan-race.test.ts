import { afterEach, describe, expect, it } from 'vitest';
import { buyTickets, cleanupTemp, getEvent, makeApp, newEvent, newTier } from '../helpers.js';
import { race } from './race.js';

afterEach(cleanupTemp);

describe('refund versus scan on separate connections', () => {
  it('exactly one wins for every ticket, and the counters stay true', async () => {
    const t = await makeApp({ MAX_TICKETS_PER_BUYER: '0' }); // one buyer buys all 40: the cap is not the subject here
    const event = await newEvent(t, { capacity: 40 });
    const tier = await newTier(t, event.id, { capacity: 40, max_per_order: 40, price_cents: 1000 });
    const { order, tickets } = await buyTickets(t, event.id, tier, 40);

    // Worker 0 scans each ticket while worker 1 refunds the same ticket, released together.
    const [scanner, refunder] = await race(
      t.path,
      tickets.map((x) => ({ kind: 'scanVsRefund' as const, qr: x.qr_payload, orderId: order.id, ticketId: x.id })),
      2,
    );

    let scanWins = 0;
    tickets.forEach((_, i) => {
      const s = scanner![i]!;
      const f = refunder![i]!;
      expect(s.ok !== f.ok, `ticket ${i}`).toBe(true); // exactly one winner
      if (s.ok) {
        scanWins++;
        expect(f, `ticket ${i}`).toEqual({ ok: false, code: 'TICKET_CHECKED_IN' });
      } else {
        expect(s, `ticket ${i}`).toEqual({ ok: false, code: 'TICKET_VOID' });
      }
    });

    const refunded = 40 - scanWins;
    const view = await getEvent(t, event.id);
    expect(view.event.sold).toBe(scanWins);
    expect(view.tiers[0].sold).toBe(scanWins);
    const status = (s: string) => t.db.prepare('SELECT COUNT(*) FROM tickets WHERE status = ?').pluck().get(s);
    expect([status('CHECKED_IN'), status('VOID'), status('VALID')]).toEqual([scanWins, refunded, 0]);
    expect(t.db.prepare('SELECT refunded_cents FROM orders WHERE id = ?').pluck().get(order.id)).toBe(refunded * 1000);
  });
});
