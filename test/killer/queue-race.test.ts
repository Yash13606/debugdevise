import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemp, getEvent, joinQueue, makeApp, newEvent, newTier, tick } from '../helpers.js';
import { race, type Round } from './race.js';

afterEach(cleanupTemp);

describe('Q-1 under contention: one admission, one hold', () => {
  it('two connections use the same admission at the same moment: exactly one hold per admission', async () => {
    const t = await makeApp({ QUEUE_ADMIT_PER_TICK: '20', QUEUE_MAX_ADMITTED: '100' });
    const event = await newEvent(t, { capacity: 100, queue_enabled: true });
    const tier = await newTier(t, event.id, { capacity: 100 });
    const tokens: string[] = [];
    for (let i = 0; i < 20; i++) tokens.push((await joinQueue(t, event.id, `q${i}@x.com`)).json().queue_token);
    expect((await tick(t)).json()).toEqual({ admitted: 20 });

    const rounds: Round[] = tokens.map((queueToken, i) => ({
      kind: 'hold',
      eventId: event.id,
      tierId: tier.id,
      email: `q${i}@x.com`,
      queueToken,
    }));
    const perWorker = await race(t.path, rounds, 2);

    rounds.forEach((_, r) => {
      const outcomes = perWorker.map((results) => results[r]!);
      expect(outcomes.filter((o) => o.ok), `admission ${r}`).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok), `admission ${r}`).toEqual([{ ok: false, code: 'NOT_ADMITTED' }]);
    });
    expect((await getEvent(t, event.id)).event.held).toBe(20);
    expect(t.db.prepare(`SELECT COUNT(*) FROM queue_entries WHERE status = 'USED'`).pluck().get()).toBe(20);
  });
});
