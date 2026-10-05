import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemp, getEvent, makeApp, newEvent, newTier } from '../helpers.js';
import { race, type Round } from './race.js';

afterEach(cleanupTemp);

describe('KT1-db: separate connections, released together', () => {
  it('two worker threads race for the last ticket: exactly one wins, every round', async () => {
    const t = await makeApp();
    const rounds: Round[] = [];
    for (let i = 0; i < 20; i++) {
      const event = await newEvent(t, { capacity: 1 });
      const tier = await newTier(t, event.id, { capacity: 1 });
      rounds.push({ kind: 'hold', eventId: event.id, tierId: tier.id });
    }

    const perWorker = await race(t.path, rounds, 2);

    rounds.forEach((_, r) => {
      const outcomes = perWorker.map((results) => results[r]!);
      expect(outcomes.filter((o) => o.ok), `round ${r}`).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok), `round ${r}`).toEqual([{ ok: false, code: 'SOLD_OUT' }]);
    });
    for (const round of rounds) {
      if (round.kind !== 'hold') continue;
      const view = await getEvent(t, round.eventId);
      expect(view.event, round.eventId).toMatchObject({ held: 1, sold: 0 });
      expect(view.tiers[0], round.eventId).toMatchObject({ held: 1, sold: 0 });
    }
  });
});
