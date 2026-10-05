// Worker thread for KT1-db. It opens its OWN database connection, then for each round waits at a
// barrier until every worker has arrived and calls createHold, so the writers truly collide.
import { parentPort, workerData } from 'node:worker_threads';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { AppError } from '../../src/errors.js';
import { createHold } from '../../src/holds.js';

export interface WorkerJob {
  dbPath: string;
  barrier: SharedArrayBuffer; // one Int32 counter per round
  workers: number;
  buyer: number;
  rounds: { eventId: string; tierId: string }[];
}
export type RoundResult = { ok: true } | { ok: false; code: string };

const job = workerData as WorkerJob;
const db = openDb(job.dbPath);
const ctx = { db, config: loadConfig({ DATABASE_PATH: job.dbPath }) };
const counters = new Int32Array(job.barrier);
const results: RoundResult[] = [];

job.rounds.forEach((round, r) => {
  if (Atomics.add(counters, r, 1) + 1 === job.workers) Atomics.notify(counters, r);
  else while (Atomics.load(counters, r) < job.workers) Atomics.wait(counters, r, Atomics.load(counters, r), 100);
  try {
    createHold(ctx, round.eventId, {
      email: `worker${job.buyer}-round${r}@x.com`,
      items: [{ tier_id: round.tierId, quantity: 1 }],
    });
    results.push({ ok: true });
  } catch (e) {
    results.push({ ok: false, code: e instanceof AppError ? e.code : String(e) });
  }
});

db.close();
parentPort!.postMessage(results);
