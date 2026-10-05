import { afterEach, describe, expect, it } from 'vitest';
import {
  buyTickets,
  cleanupTemp,
  getEvent,
  getOrder,
  line,
  makeApp,
  newEvent,
  newPromo,
  newTier,
  payHold,
  placeHold,
  refund,
  scan,
} from '../helpers.js';

afterEach(cleanupTemp);

/** An event of 20 seats and a paid order of `quantity` tickets at `price` each. */
async function paidOrder(quantity: number, price = 1000) {
  const t = await makeApp();
  const event = await newEvent(t, { capacity: 20 });
  const tier = await newTier(t, event.id, { capacity: 20, price_cents: price, max_per_order: 20 });
  return { t, event, tier, ...(await buyTickets(t, event.id, tier, quantity)) };
}

describe('R-1: refunding an order', () => {
  it('a full refund of a 3-ticket order lowers sold by 3 on the tier and the pool', async () => {
    const { t, event, order, tickets, token } = await paidOrder(3);
    expect((await getEvent(t, event.id)).event).toMatchObject({ sold: 3, available: 17 });

    const res = await refund(t, order.id); // no ticket_ids: the whole order

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      order: { id: order.id, status: 'REFUNDED', refunded_cents: 3000 },
      refunded_cents: 3000,
    });
    expect([...res.json().voided_ticket_ids].sort()).toEqual(tickets.map((x) => x.id).sort());
    const view = await getEvent(t, event.id);
    expect(view.event).toMatchObject({ sold: 0, held: 0, available: 20 });
    expect(view.tiers[0]).toMatchObject({ sold: 0, available: 20 });
    const after = (await getOrder(t, order.id, token)).json();
    expect(after.order.status).toBe('REFUNDED');
    expect(after.tickets.map((x: { status: string }) => x.status)).toEqual(['VOID', 'VOID', 'VOID']);
  });

  it('listed tickets: PARTIALLY_REFUNDED, then the rest: REFUNDED; nothing is left to refund after that', async () => {
    const { t, event, order, tickets } = await paidOrder(2, 49900);
    const [first, second] = tickets;

    const part = await refund(t, order.id, { ticket_ids: [first!.id], reason: 'student request' });
    expect(part.json()).toMatchObject({
      order: { status: 'PARTIALLY_REFUNDED', refunded_cents: 49900 },
      voided_ticket_ids: [first!.id],
      refunded_cents: 49900,
    });
    expect((await getEvent(t, event.id)).event.sold).toBe(1);

    const rest = await refund(t, order.id); // omitted: every ticket not yet refunded
    expect(rest.json()).toMatchObject({
      order: { status: 'REFUNDED', refunded_cents: 99800 },
      voided_ticket_ids: [second!.id],
      refunded_cents: 49900,
    });
    expect((await getEvent(t, event.id)).event.sold).toBe(0);

    const again = await refund(t, order.id);
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'ALREADY_REFUNDED']);
  });

  it('refunds what each ticket actually paid, promo included', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 20 });
    const tier = await newTier(t, event.id, { capacity: 20, price_cents: 49900 });
    await newPromo(t, event.id, { code: 'FRESHER10', kind: 'PERCENT', value: 10 });
    const held = (await placeHold(t, event.id, 'a@x.com', [line(tier, 2)], { promo_code: 'FRESHER10' })).json();
    const paid = (await payHold(t, held.hold.id, held.hold_token)).json();

    const res = await refund(t, paid.order.id, { ticket_ids: [paid.tickets[0].id] });

    expect(res.json()).toMatchObject({ refunded_cents: 44910, order: { status: 'PARTIALLY_REFUNDED', refunded_cents: 44910 } });
  });

  it('a refund frees the seats for other buyers', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 2 });
    const tier = await newTier(t, event.id, { capacity: 2 });
    const { order } = await buyTickets(t, event.id, tier, 2);
    expect((await placeHold(t, event.id, 'b@x.com', [line(tier)])).statusCode).toBe(409);

    await refund(t, order.id);

    expect((await placeHold(t, event.id, 'b@x.com', [line(tier, 2)])).statusCode).toBe(201);
  });
});

describe('refund refusals', () => {
  it('the same ticket twice: 409 ALREADY_REFUNDED, and nothing changes', async () => {
    const { t, event, order, tickets } = await paidOrder(2);
    await refund(t, order.id, { ticket_ids: [tickets[0]!.id] });

    const again = await refund(t, order.id, { ticket_ids: [tickets[0]!.id] });

    expect([again.statusCode, again.json().error.code]).toEqual([409, 'ALREADY_REFUNDED']);
    expect((await getEvent(t, event.id)).event.sold).toBe(1);
  });

  it('a checked-in ticket cannot be refunded, and a refund is all or nothing', async () => {
    const { t, event, order, tickets } = await paidOrder(2);
    const [used, unused] = tickets;
    await scan(t, used!.qr_payload);

    const one = await refund(t, order.id, { ticket_ids: [used!.id] });
    const both = await refund(t, order.id, { ticket_ids: [used!.id, unused!.id] });
    const whole = await refund(t, order.id);

    for (const r of [one, both, whole]) expect([r.statusCode, r.json().error.code]).toEqual([409, 'TICKET_CHECKED_IN']);
    expect((await getEvent(t, event.id)).event.sold).toBe(2); // the unused ticket was not refunded either
    expect((await refund(t, order.id, { ticket_ids: [unused!.id] })).statusCode).toBe(200);
  });

  it('KT3-void: a refunded ticket is refused at the gate with 409 TICKET_VOID', async () => {
    const { t, order, tickets } = await paidOrder(1);
    await refund(t, order.id);

    const res = await scan(t, tickets[0]!.qr_payload, 'north-1');

    expect([res.statusCode, res.json().error.code]).toEqual([409, 'TICKET_VOID']);
    const last = t.db.prepare('SELECT result FROM scan_log ORDER BY id DESC LIMIT 1').pluck().get();
    expect(last).toBe('TICKET_VOID');
  });

  it('needs the admin key; unknown order and foreign tickets are 404; the body is validated', async () => {
    const { t, event, tier, order } = await paidOrder(1);
    const other = await buyTickets(t, event.id, tier, 1, 'other@x.com');

    expect((await refund(t, order.id, {}, {})).statusCode).toBe(401);
    expect((await refund(t, order.id, {}, { 'x-gate-key': 'change-me-gate' })).statusCode).toBe(401);
    expect((await refund(t, 'ord_doesnotexist')).statusCode).toBe(404);
    const foreign = await refund(t, order.id, { ticket_ids: [other.tickets[0]!.id] });
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([404, 'NOT_FOUND']);
    for (const bad of [{ ticket_ids: [] }, { ticket_ids: 'x' }, { reason: 5 }, { extra: 1 }]) {
      const res = await refund(t, order.id, bad);
      expect([res.statusCode, res.json().error.code], JSON.stringify(bad)).toEqual([400, 'VALIDATION_ERROR']);
    }
  });
});

describe('a refund and a scan racing for one ticket', () => {
  it('exactly one wins every time, and the counters stay true (HTTP, both orders)', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 40 });
    const tier = await newTier(t, event.id, { capacity: 40 });
    let scanWins = 0;

    for (let i = 0; i < 20; i++) {
      const { order, tickets } = await buyTickets(t, event.id, tier, 1, `r${i}@x.com`);
      const doRefund = () => refund(t, order.id, { ticket_ids: [tickets[0]!.id] });
      const doScan = () => scan(t, tickets[0]!.qr_payload);
      const [r, s] = i % 2 === 0
        ? await Promise.all([doRefund(), doScan()])
        : (await Promise.all([doScan(), doRefund()])).reverse();

      expect((r!.statusCode === 200) !== (s!.statusCode === 200), `round ${i}`).toBe(true);
      if (s!.statusCode === 200) {
        scanWins++;
        expect(r!.json().error.code).toBe('TICKET_CHECKED_IN');
      } else {
        expect(s!.json().error.code).toBe('TICKET_VOID');
      }
    }

    expect(scanWins).toBeGreaterThan(0);
    expect(scanWins).toBeLessThan(20); // both outcomes were exercised
    expect((await getEvent(t, event.id)).event.sold).toBe(scanWins);
  });
});
