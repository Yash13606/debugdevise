import { afterEach, describe, expect, it } from 'vitest';
import { buyTickets, cleanupTemp, getOrder, makeApp, newEvent, newTier, scan } from '../helpers.js';

afterEach(cleanupTemp);

async function oneTicket() {
  const t = await makeApp();
  const event = await newEvent(t, { capacity: 10 });
  const tier = await newTier(t, event.id, { capacity: 10 });
  return { t, ...(await buyTickets(t, event.id, tier, 1)) };
}

describe('check-in', () => {
  it('needs the gate key: missing or wrong is 401 UNAUTHORIZED and nothing is scanned', async () => {
    const { t, tickets } = await oneTicket();
    const qr = tickets[0]!.qr_payload;

    const none = await scan(t, qr, 'north-1', {});
    const wrong = await scan(t, qr, 'north-1', { 'x-gate-key': 'nope' });
    const admin = await scan(t, qr, 'north-1', { 'x-admin-key': 'change-me-admin' });

    for (const r of [none, wrong, admin]) {
      expect([r.statusCode, r.json().error.code]).toEqual([401, 'UNAUTHORIZED']);
    }
    expect((await scan(t, qr)).statusCode).toBe(200); // the ticket is still unused
  });

  it('an unknown code, or one without the AP1: prefix, is 404 INVALID_QR', async () => {
    const { t, tickets } = await oneTicket();
    const token = tickets[0]!.qr_payload.slice('AP1:'.length);
    for (const qr of ['AP1:AAAAAAAAAAAAAAAAAAAAAA', 'garbage', token, '']) {
      const r = await scan(t, qr);
      expect([r.statusCode, r.json().error.code], qr).toEqual(qr === '' ? [400, 'VALIDATION_ERROR'] : [404, 'INVALID_QR']);
    }
  });

  it('ignores whitespace around the code and does not need a gate name', async () => {
    const { t, tickets } = await oneTicket();
    const r = await scan(t, `  ${tickets[0]!.qr_payload}\n`, null);
    expect(r.statusCode).toBe(200);
    const again = await scan(t, tickets[0]!.qr_payload, null);
    expect(again.json().error.details).toEqual({ checked_in_at: r.json().checked_in_at, gate: null });
  });

  it('every attempt is written to the scan log', async () => {
    const { t, tickets } = await oneTicket();
    await scan(t, tickets[0]!.qr_payload, 'north-1');
    await scan(t, tickets[0]!.qr_payload, 'north-2');
    await scan(t, 'AP1:AAAAAAAAAAAAAAAAAAAAAA', 'north-3');

    const rows = t.db.prepare('SELECT ticket_id, gate, result FROM scan_log ORDER BY id').all();
    expect(rows).toEqual([
      { ticket_id: tickets[0]!.id, gate: 'north-1', result: 'ADMITTED' },
      { ticket_id: tickets[0]!.id, gate: 'north-2', result: 'ALREADY_CHECKED_IN' },
      { ticket_id: null, gate: 'north-3', result: 'INVALID_QR' },
    ]);
  });
});

describe('GET /api/orders/:id', () => {
  it('shows the order and its tickets, with the status after a scan', async () => {
    const { t, order, tickets, token } = await oneTicket();

    const before = await getOrder(t, order.id, token);
    expect(before.statusCode).toBe(200);
    expect(before.json().order).toMatchObject({ id: order.id, status: 'PAID' });
    expect(before.json().tickets).toEqual(tickets.map((x) => expect.objectContaining({ id: x.id, status: 'VALID', qr_payload: x.qr_payload })));

    await scan(t, tickets[0]!.qr_payload);
    expect((await getOrder(t, order.id, token)).json().tickets[0].status).toBe('CHECKED_IN');
  });

  it('needs the token of the originating hold: wrong is 403, unknown order is 404', async () => {
    const { t, order } = await oneTicket();
    const wrong = await getOrder(t, order.id, 'not-the-token');
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'FORBIDDEN']);
    const unknown = await getOrder(t, 'ord_doesnotexist', 'x');
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'NOT_FOUND']);
  });
});
