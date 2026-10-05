import { afterEach, describe, expect, it } from 'vitest';
import { buyTickets, cleanupTemp, makeApp, newEvent, newTier, scan } from '../helpers.js';

afterEach(cleanupTemp);

async function ticketsFor(quantity: number) {
  const t = await makeApp();
  const event = await newEvent(t, { capacity: 50 });
  const tier = await newTier(t, event.id, { name: 'Early', capacity: 50, max_per_order: 50 });
  return { t, event, tier, ...(await buyTickets(t, event.id, tier, quantity)) };
}

describe('KT3: one scan per ticket', () => {
  it('the first scan admits, the second is 409 ALREADY_CHECKED_IN with the first scan time and gate', async () => {
    const { t, event, tier, tickets } = await ticketsFor(1);
    const qr = tickets[0]!.qr_payload;

    const first = await scan(t, qr, 'north-1');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      result: 'ADMITTED',
      ticket: { id: tickets[0]!.id, tier_id: tier.id, tier_name: 'Early', event_id: event.id },
    });
    const firstAt: string = first.json().checked_in_at;
    expect(Date.parse(firstAt)).not.toBeNaN();

    const second = await scan(t, qr, 'south-2');
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: 'ALREADY_CHECKED_IN',
      details: { checked_in_at: firstAt, gate: 'north-1' },
    });
  });

  it('twenty parallel scans of a new ticket: exactly one 200, nineteen 409', async () => {
    const { t, tickets } = await ticketsFor(1);
    const qr = tickets[0]!.qr_payload;

    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => scan(t, qr, `gate-${i}`)));

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(refused).toHaveLength(19);
    for (const r of refused) expect(r.json().error.code).toBe('ALREADY_CHECKED_IN');
    // Every refusal names the one gate that won.
    const winner = results.findIndex((r) => r.statusCode === 200);
    for (const r of refused) expect(r.json().error.details.gate).toBe(`gate-${winner}`);
  });

  it('each ticket of an order admits once, independently', async () => {
    const { t, tickets } = await ticketsFor(3);
    const results = await Promise.all([...tickets, ...tickets].map((x) => scan(t, x.qr_payload)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
  });
});
