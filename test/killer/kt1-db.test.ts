import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemp, getEvent, makeApp, newEvent, newTier } from '../helpers.js';
import type { RoundResult, WorkerJob } from './hold-worker.js';

afterEach(cleanupTemp);

/** Start `workers` threads on the same database file; each runs every round behind a barrier. */
async function race(dbPath: string, rounds: WorkerJob['rounds'], workers: number): Promise<RoundResult[][]> {
  const barrier = new SharedArrayBuffer(4 * rounds.length);
  const threads: Worker[] = [];
  try {
    return await Promise.all(
      Array.from({ length: workers }, (_, buyer) => {
        const job: WorkerJob = { dbPath, barrier, workers, buyer, rounds };
        // tsx lets the worker import the TypeScript sources.
        const w = new Worker(new URL('./hold-worker.ts', import.meta.url), { workerData: job, execArgv: ['--import', 'tsx'] });
        threads.push(w);
        return new Promise<RoundResult[]>((resolve, reject) => {
          w.once('message', resolve);
          w.once('error', reject);
        });
      }),
    );
  } finally {
    await Promise.all(threads.map((w) => w.terminate()));
  }
}

describe('KT1-db: separate connections, released together', () => {
  it('two worker threads race for the last ticket: exactly one wins, every round', async () => {
    const t = await makeApp();
    const rounds: WorkerJob['rounds'] = [];
    for (let i = 0; i < 20; i++) {
      const event = await newEvent(t, { capacity: 1 });
      const tier = await newTier(t, event.id, { capacity: 1 });
      rounds.push({ eventId: event.id, tierId: tier.id });
    }

    const perWorker = await race(t.path, rounds, 2);

    rounds.forEach((_, r) => {
      const outcomes = perWorker.map((results) => results[r]!);
      expect(outcomes.filter((o) => o.ok), `round ${r}`).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok), `round ${r}`).toEqual([{ ok: false, code: 'SOLD_OUT' }]);
    });
    for (const round of rounds) {
      const view = await getEvent(t, round.eventId);
      expect(view.event, round.eventId).toMatchObject({ held: 1, sold: 0 });
      expect(view.tiers[0], round.eventId).toMatchObject({ held: 1, sold: 0 });
    }
  });
});
