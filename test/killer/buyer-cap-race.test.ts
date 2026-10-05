import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemp, getEvent, line, makeApp, newEvent, newTier, placeHold } from '../helpers.js';
import { race, type Round } from './race.js';

afterEach(cleanupTemp);

describe('B-1 under contention: the per-buyer cap cannot be raced', () => {
  it('ten parallel requests of one seat from one buyer: exactly 4 succeed (cap 4)', async () => {
    const t = await makeApp({ MAX_TICKETS_PER_BUYER: '4' });
    const event = await newEvent(t, { capacity: 100 });
    const tier = await newTier(t, event.id, { capacity: 100 });

    const results = await Promise.all(Array.from({ length: 10 }, () => placeHold(t, event.id, 'greedy@x.com', [line(tier)])));

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(4);
    expect(results.filter((r) => r.statusCode === 409 && r.json().error.code === 'BUYER_LIMIT')).toHaveLength(6);
    expect((await getEvent(t, event.id)).event.held).toBe(4);
  });

  it('two connections ask for 3 seats each for the same buyer at the same moment: exactly one wins, every round', async () => {
    const t = await makeApp({ MAX_TICKETS_PER_BUYER: '4' });
    const event = await newEvent(t, { capacity: 100 });
    const tier = await newTier(t, event.id, { capacity: 100, max_per_order: 10 });
    const rounds: Round[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'hold',
      eventId: event.id,
      tierId: tier.id,
      email: `buyer${i}@x.com`,
      quantity: 3,
    }));

    const perWorker = await race(t.path, rounds, 2);

    rounds.forEach((_, r) => {
      const outcomes = perWorker.map((results) => results[r]!);
      expect(outcomes.filter((o) => o.ok), `buyer ${r}`).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok), `buyer ${r}`).toEqual([{ ok: false, code: 'BUYER_LIMIT' }]);
    });
    expect((await getEvent(t, event.id)).event.held).toBe(60); // 20 buyers x 3 seats, never 6
  });
});
