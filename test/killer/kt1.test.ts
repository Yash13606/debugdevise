import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemp, getEvent, line, makeApp, newEvent, newTier, placeHold } from '../helpers.js';

afterEach(cleanupTemp);

describe('KT1: the last ticket', () => {
  it('two buyers ask for the last ticket at once: exactly one 201, the other 409 SOLD_OUT', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 1 });
    const tier = await newTier(t, event.id, { capacity: 1 });

    const results = await Promise.all([
      placeHold(t, event.id, 'a@x.com', [line(tier)]),
      placeHold(t, event.id, 'b@x.com', [line(tier)]),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    expect(loser.json().error).toMatchObject({ code: 'SOLD_OUT', details: { scope: 'tier', tier_id: tier.id } });
    const winner = results.find((r) => r.statusCode === 201)!.json();
    expect(winner.hold).toMatchObject({ status: 'ACTIVE', event_id: event.id, total_cents: 1000 });
    expect(winner.hold_token).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const view = await getEvent(t, event.id);
    expect(view.event).toMatchObject({ held: 1, sold: 0, available: 0 });
    expect(view.tiers[0]).toMatchObject({ held: 1, sold: 0, available: 0 });
  });
});

describe('KT1-n: ten tickets, fifty buyers, twenty times', () => {
  it('exactly 10 successes every run, and sold + held = 10', async () => {
    const t = await makeApp();
    for (let run = 1; run <= 20; run++) {
      const event = await newEvent(t, { capacity: 10 });
      const tier = await newTier(t, event.id, { capacity: 10 });

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => placeHold(t, event.id, `buyer${i}@x.com`, [line(tier)])),
      );

      const created = results.filter((r) => r.statusCode === 201);
      const soldOut = results.filter((r) => r.statusCode === 409 && r.json().error.code === 'SOLD_OUT');
      expect(created, `run ${run}`).toHaveLength(10);
      expect(soldOut, `run ${run}`).toHaveLength(40);
      const view = await getEvent(t, event.id);
      expect(view.event.sold + view.event.held, `run ${run}`).toBe(10);
      expect(view.tiers[0].sold + view.tiers[0].held, `run ${run}`).toBe(10);
    }
  });
});
