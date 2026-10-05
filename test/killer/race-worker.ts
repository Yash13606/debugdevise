// Worker thread for the cross-connection races (see race.ts). It opens its own connection, then for
// each round waits at a barrier until every worker has arrived and runs the operation at once.
import { parentPort, workerData } from 'node:worker_threads';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db.js';
import { AppError } from '../../src/errors.js';
import { createHold } from '../../src/holds.js';
import { checkIn, refund } from '../../src/tickets.js';
import type { RaceJob, RoundResult } from './race.js';

const job = workerData as RaceJob;
const db = openDb(job.dbPath);
const ctx = { db, config: loadConfig({ DATABASE_PATH: job.dbPath }) };
const counters = new Int32Array(job.barrier);
const results: RoundResult[] = [];

job.rounds.forEach((round, r) => {
  if (Atomics.add(counters, r, 1) + 1 === job.workers) Atomics.notify(counters, r);
  else while (Atomics.load(counters, r) < job.workers) Atomics.wait(counters, r, Atomics.load(counters, r), 100);
  try {
    if (round.kind === 'hold') {
      createHold(ctx, round.eventId, {
        email: `worker${job.worker}-round${r}@x.com`,
        items: [{ tier_id: round.tierId, quantity: 1 }],
      });
    } else if (round.kind === 'scan' || job.worker === 0) {
      checkIn(ctx, { qr: round.qr, gate: `worker-${job.worker}` });
    } else {
      refund(ctx, round.orderId, { ticket_ids: [round.ticketId] });
    }
    results.push({ ok: true });
  } catch (e) {
    results.push({ ok: false, code: e instanceof AppError ? e.code : String(e) });
  }
});

db.close();
parentPort!.postMessage(results);
