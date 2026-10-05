// Cross-connection races: N worker threads, each with its OWN database connection, run every round
// behind an Atomics barrier so the writers really collide (used by KT1-db, the KT3 check-in race and the refund-versus-scan race).
import { Worker } from 'node:worker_threads';

export type Round =
  | { kind: 'hold'; eventId: string; tierId: string }
  | { kind: 'scan'; qr: string }
  // worker 0 scans the ticket while every other worker refunds it
  | { kind: 'scanVsRefund'; qr: string; orderId: string; ticketId: string };
export type RoundResult = { ok: true } | { ok: false; code: string };

export interface RaceJob {
  dbPath: string;
  barrier: SharedArrayBuffer; // one Int32 arrival counter per round
  workers: number;
  worker: number;
  rounds: Round[];
}

/** One result per round, per worker. A thrown AppError becomes `{ ok: false, code }`. */
export async function race(dbPath: string, rounds: Round[], workers = 2): Promise<RoundResult[][]> {
  const barrier = new SharedArrayBuffer(4 * rounds.length);
  const threads: Worker[] = [];
  try {
    return await Promise.all(
      Array.from({ length: workers }, (_, worker) => {
        const job: RaceJob = { dbPath, barrier, workers, worker, rounds };
        // tsx lets the worker import the TypeScript sources.
        const w = new Worker(new URL('./race-worker.ts', import.meta.url), { workerData: job, execArgv: ['--import', 'tsx'] });
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
