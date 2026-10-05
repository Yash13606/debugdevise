import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemp, getEvent, line, makeApp, newEvent, newTier, placeHold } from '../helpers.js';

afterEach(cleanupTemp);

describe('KT1-pool: capacity shared by several tiers (the fix for GAP-1)', () => {
  it('tiers A and B (5 each) in a pool of 5: ten parallel holds, exactly 5 succeed', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 5 });
    const a = await newTier(t, event.id, { name: 'A', capacity: 5 });
    const b = await newTier(t, event.id, { name: 'B', capacity: 5 });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => placeHold(t, event.id, `buyer${i}@x.com`, [line(i % 2 === 0 ? a : b)])),
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(refused).toHaveLength(5);
    for (const r of refused) {
      expect(r.json().error).toMatchObject({ code: 'SOLD_OUT', details: { scope: 'event' } });
    }

    const view = await getEvent(t, event.id);
    expect(view.event).toMatchObject({ held: 5, sold: 0, available: 0 });
    // Refused requests gave their tier seats back: the tiers hold exactly what the pool holds,
    // neither tier is above its own capacity, and the pool shows through as 0 available on both.
    expect(view.tiers.reduce((sum: number, tier: { held: number }) => sum + tier.held, 0)).toBe(5);
    for (const tier of view.tiers) {
      expect(tier.held).toBeLessThanOrEqual(tier.capacity);
      expect(tier.available).toBe(0);
    }
  });

  it('a hold that spans both tiers is taken whole or not at all', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 3 });
    const a = await newTier(t, event.id, { name: 'A', capacity: 3 });
    const b = await newTier(t, event.id, { name: 'B', capacity: 3 });

    const refused = await placeHold(t, event.id, 'a@x.com', [line(a, 2), line(b, 2)]); // 4 seats, pool has 3
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toEqual({ scope: 'event' });
    expect((await getEvent(t, event.id)).event).toMatchObject({ held: 0 });

    const ok = await placeHold(t, event.id, 'a@x.com', [line(a, 2), line(b, 1)]); // 3 seats
    expect(ok.statusCode).toBe(201);
    expect(ok.json().hold.total_cents).toBe(3000);
    expect((await getEvent(t, event.id)).event).toMatchObject({ held: 3, available: 0 });
  });
});
