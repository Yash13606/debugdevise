import { afterEach, describe, expect, it } from 'vitest';
import { buyTickets, cleanupTemp, makeApp, newEvent, newTier } from '../helpers.js';
import { race } from './race.js';

afterEach(cleanupTemp);

describe('KT3 across connections: the gate race', () => {
  it('two worker threads scan the same QR at the same moment: exactly one is admitted, every ticket', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 20 });
    const tier = await newTier(t, event.id, { capacity: 20, max_per_order: 20 });
    const { tickets } = await buyTickets(t, event.id, tier, 20);

    const perWorker = await race(
      t.path,
      tickets.map((x) => ({ kind: 'scan' as const, qr: x.qr_payload })),
      2,
    );

    tickets.forEach((_, r) => {
      const outcomes = perWorker.map((results) => results[r]!);
      expect(outcomes.filter((o) => o.ok), `ticket ${r}`).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok), `ticket ${r}`).toEqual([{ ok: false, code: 'ALREADY_CHECKED_IN' }]);
    });
    const admitted = t.db.prepare(`SELECT COUNT(*) FROM tickets WHERE status = 'CHECKED_IN'`).pluck().get();
    expect(admitted).toBe(20);
  });
});
