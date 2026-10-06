import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, expectClean, hold, login, makeEnv, makeEvent, makeOrganiser, pay, phoneOf, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
beforeAll(async () => {
  e = await makeEnv();
  org = await makeOrganiser(e.app);
});
afterAll(async () => {
  await expectClean(e);
  await e.close();
});

describe('a purchase from login to the gate', () => {
  it('login, hold, pay, ticket, scan, refund-after-scan refused', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 10, price_paise: 50_000 }] });
    const buyer = await login(e.app, phoneOf(1));

    const h = await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 2 }]);
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    expect(h.body.hold.total_paise).toBe(100_000);

    const orderId = await pay(e, buyer, h.body.hold.id);
    expect(orderId).toBeTruthy();
    const order = await buyer.call('GET', `/api/orders/${orderId}`);
    expect(order.body.order.tickets).toHaveLength(2);
    expect(order.body.order.status).toBe('PAID');

    const qr = order.body.order.tickets[0].qr_payload as string;
    expect(qr.startsWith('AP2:')).toBe(true); // the signed form
    const svg = await buyer.call('GET', `/api/tickets/${order.body.order.tickets[0].id}/qr.svg`);
    expect(svg.status).toBe(200);

    const scan1 = await org.call('POST', '/api/gate/checkin', { qr, event_id: ev.id });
    expect(scan1.body.result).toBe('ADMITTED');
    const scan2 = await org.call('POST', '/api/gate/checkin', { qr, event_id: ev.id });
    expect(scan2.status).toBe(409);
    expect(scan2.body.error.code).toBe('ALREADY_CHECKED_IN');

    const refund = await org.call('POST', `/api/organiser/orders/${orderId}/refund`, { ticket_ids: [order.body.order.tickets[0].id] });
    expect(refund.status).toBe(409);
    expect(refund.body.error.code).toBe('TICKET_CHECKED_IN');

    const full = await buyer.call('POST', `/api/orders/${orderId}/cancel`);
    expect(full.status).toBe(409); // one ticket was scanned
    const inbox = await buyer.call('GET', '/api/me/messages');
    expect(inbox.body.messages.some((m: { kind: string }) => m.kind === 'TICKETS')).toBe(true);
  });

  it('buyer cancel returns seats and money; stats stay clean', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 3, price_paise: 20_000 }] });
    const buyer = await login(e.app, phoneOf(2));
    const h = await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 3 }]);
    const orderId = await pay(e, buyer, h.body.hold.id);
    const full = await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }]);
    expect(full.body.error.code).toBe('SOLD_OUT');

    const cancel = await buyer.call('POST', `/api/orders/${orderId}/cancel`);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.order.status).toBe('REFUNDED');
    const view = await api(e.app)('GET', `/api/events/${ev.id}`);
    expect(view.body.event.available).toBe(3);
    const stats = await org.call('GET', `/api/organiser/events/${ev.id}`);
    expect(stats.body.invariants.ok).toBe(true);
    expect(stats.body.money.refunded_paise).toBe(60_000);
    const rf = await e.ctx.pool.query(`SELECT status FROM refunds WHERE order_id = $1`, [orderId]);
    expect(rf.rows[0].status).toBe('DONE');
  });
});
