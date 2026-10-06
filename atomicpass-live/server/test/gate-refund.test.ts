import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, expectClean, hold, login, makeEnv, makeEvent, makeOrganiser, pay, phoneOf, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
let other: Person;
let buyer: Person;

beforeAll(async () => {
  e = await makeEnv();
  org = await makeOrganiser(e.app, 900);
  other = await makeOrganiser(e.app, 901);
  buyer = await login(e.app, phoneOf(300));
});
afterAll(async () => {
  await expectClean(e);
  await e.close();
});

/** Buy `n` tickets and return the event, order and ticket list. */
async function bought(n = 1, ev?: Awaited<ReturnType<typeof makeEvent>>, who: Person = buyer) {
  const event = ev ?? (await makeEvent(org, { tiers: [{ capacity: 20 }] }));
  const h = await hold(who, event.id, [{ tier_id: event.tiers[0]!.id, quantity: n }]);
  const orderId = (await pay(e, who, h.body.hold.id))!;
  const order = (await who.call('GET', `/api/orders/${orderId}`)).body.order;
  return { event, orderId, tickets: order.tickets as { id: string; qr_payload: string }[] };
}
const scan = (p: Person, eventId: string, qr: string, gate = 'G1') => p.call('POST', '/api/gate/checkin', { qr, event_id: eventId, gate });

describe('one scan, one entry', () => {
  it('twenty scans of one ticket at once: exactly one is admitted', async () => {
    const { event, tickets } = await bought(1);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => scan(org, event.id, tickets[0]!.qr_payload, `G${i}`)));
    expect(rs.filter((r) => r.status === 200 && r.body.result === 'ADMITTED')).toHaveLength(1);
    expect(rs.filter((r) => r.body.error?.code === 'ALREADY_CHECKED_IN')).toHaveLength(19);
    await expectClean(e);
  });

  it('a scan and a refund racing for one ticket have exactly one winner', async () => {
    for (let round = 0; round < 15; round++) {
      const { event, orderId, tickets } = await bought(1);
      const [s, r] = await Promise.all([scan(org, event.id, tickets[0]!.qr_payload), org.call('POST', `/api/organiser/orders/${orderId}/refund`, {})]);
      const admitted = s.status === 200;
      const refunded = r.status === 200;
      expect(admitted !== refunded, `round ${round}: scan ${s.status} refund ${r.status}`).toBe(true);
      if (admitted) expect(r.body.error.code).toBe('TICKET_CHECKED_IN');
      else expect(s.body.error.code).toBe('TICKET_VOID');
    }
    await expectClean(e);
  });

  it('refuses unknown codes, wrong events, and anyone not on the gate team', async () => {
    const a = await bought(1);
    const b = await bought(1);
    expect((await scan(org, a.event.id, 'AP1:nope')).body.error.code).toBe('INVALID_QR');
    expect((await scan(org, a.event.id, 'garbage')).body.error.code).toBe('INVALID_QR');
    const wrong = await scan(org, a.event.id, b.tickets[0]!.qr_payload);
    expect(wrong.body.error.code).toBe('WRONG_EVENT');
    expect((await scan(other, a.event.id, a.tickets[0]!.qr_payload)).status).toBe(403); // another organiser
    expect((await scan(buyer, a.event.id, a.tickets[0]!.qr_payload)).status).toBe(403); // the buyer themselves
    // the wrong-event ticket was not used up
    expect((await scan(org, b.event.id, b.tickets[0]!.qr_payload)).body.result).toBe('ADMITTED');
  });

  it('staff added by the organiser can scan, after logging in with their own OTP', async () => {
    const { event, tickets } = await bought(1);
    const staffPhone = phoneOf(777);
    const added = await org.call('POST', `/api/organiser/events/${event.id}/staff`, { phone: staffPhone });
    expect(added.body.staff).toHaveLength(1);
    const staff = await login(e.app, staffPhone, 'Gate Guy');
    expect((await staff.call('GET', '/api/gate/events')).body.events.map((x: { id: string }) => x.id)).toContain(event.id);
    expect((await scan(staff, event.id, tickets[0]!.qr_payload)).body.result).toBe('ADMITTED');
    const sum = await staff.call('GET', `/api/gate/events/${event.id}/summary`);
    expect(sum.body.admitted).toBe(1);
    expect(sum.body.recent[0].result).toBe('ADMITTED');
    // not for another event
    const elsewhere = await makeEvent(org);
    expect((await staff.call('GET', `/api/gate/events/${elsewhere.id}/summary`)).status).toBe(403);
  });
});

describe('refunds', () => {
  it('a refunded ticket cannot be scanned and its seat returns', async () => {
    const ev = await makeEvent(org, { tiers: [{ seated: { rows: 1, seats_per_row: 4 } }] });
    const seats = (await org.call('GET', `/api/events/${ev.id}/seats`)).body.tiers[ev.tiers[0]!.id] as { id: string }[];
    const h = await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, seat_ids: [seats[0]!.id, seats[1]!.id] }]);
    const orderId = (await pay(e, buyer, h.body.hold.id))!;
    const order = (await buyer.call('GET', `/api/orders/${orderId}`)).body.order;
    expect(order.tickets.map((t: { seat: string }) => t.seat).sort()).toEqual(['A1', 'A2']);

    const part = await org.call('POST', `/api/organiser/orders/${orderId}/refund`, { ticket_ids: [order.tickets[0].id] });
    expect(part.body.order.status).toBe('PARTIALLY_REFUNDED');
    expect((await scan(org, ev.id, order.tickets[0].qr_payload)).body.error.code).toBe('TICKET_VOID');
    expect((await scan(org, ev.id, order.tickets[1].qr_payload)).body.result).toBe('ADMITTED');
    const map = (await org.call('GET', `/api/events/${ev.id}/seats`)).body.tiers[ev.tiers[0]!.id] as { id: string; status: string }[];
    expect(map.filter((s) => s.status === 'AVAILABLE')).toHaveLength(3); // A1 came back
    expect((await org.call('POST', `/api/organiser/orders/${orderId}/refund`, { ticket_ids: [order.tickets[0].id] })).body.error.code).toBe('ALREADY_REFUNDED');
    await expectClean(e);
  });

  it("an organiser cannot refund another organiser's order, and a buyer cannot cancel someone else's", async () => {
    const { orderId } = await bought(1);
    expect((await other.call('POST', `/api/organiser/orders/${orderId}/refund`, {})).status).toBe(404);
    const stranger = await login(e.app, phoneOf(301));
    expect((await stranger.call('POST', `/api/orders/${orderId}/cancel`)).status).toBe(404);
  });

  it('buyers can cancel until the cut-off, not after', async () => {
    const soon = await makeEvent(org, { starts_at: new Date(Date.now() + 3_600_000).toISOString(), tiers: [{ capacity: 5 }] });
    const { orderId } = await bought(1, soon);
    const r = await buyer.call('POST', `/api/orders/${orderId}/cancel`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CANCEL_WINDOW_CLOSED');
    const orders = await buyer.call('GET', '/api/orders');
    expect(orders.body.orders.find((o: { id: string }) => o.id === orderId).can_cancel).toBe(false);
  });

  it('the organiser settlement adds up: sales, refunds, fee and GST', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 20, price_paise: 100_000 }] });
    const first = await bought(2, ev);
    await bought(1, ev);
    await buyer.call('POST', `/api/orders/${first.orderId}/cancel`);
    const s = (await org.call('GET', `/api/organiser/events/${ev.id}/settlement`)).body;
    expect(s.gross_paise).toBe(300_000);
    expect(s.refunds_paise).toBe(200_000);
    expect(s.net_sales_paise).toBe(100_000);
    expect(s.platform_fee_paise).toBe(5_000); // 5%
    expect(s.gst_on_fee_paise).toBe(900); // 18% of the fee
    expect(s.payable_paise).toBe(100_000 - 5_000 - 900);
    expect(s.by_tier[0].sold).toBe(1);
    expect((await other.call('GET', `/api/organiser/events/${ev.id}/settlement`)).status).toBe(404);
  });
});
