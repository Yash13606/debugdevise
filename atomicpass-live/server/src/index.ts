import { loadConfig, loadDotEnv } from './config.js';
import { deliverPending } from './notify.js';
import { purgeExpired } from './auth.js';
import { expireDueHolds } from './holds.js';
import { buildApp } from './http.js';
import { finishPendingRefunds, reconcile } from './payments/service.js';
import { tick } from './queue.js';
import { remindExpiring } from './waitlist.js';
import { createCtx } from './runtime.js';
import { seedDemo } from './seed.js';

try {
  loadDotEnv();
  const config = loadConfig();

  // No DATABASE_URL: run a real PostgreSQL from the npm package, kept in ./.data/pg (local development only).
  let databaseUrl = config.databaseUrl;
  let stopEmbedded: (() => Promise<void>) | null = null;
  if (!databaseUrl) {
    const { startEmbeddedPostgres } = await import('./embedded.js');
    const embedded = await startEmbeddedPostgres();
    databaseUrl = embedded.url;
    stopEmbedded = embedded.stop;
    console.log('No DATABASE_URL set: using a local PostgreSQL in ./.data/pg');
  }

  const { ctx, close, redisIsReal } = await createCtx(config, databaseUrl);
  console.log(redisIsReal ? 'Redis: connected client (REDIS_URL)' : 'Redis: no REDIS_URL, using the in-process stand-in (one process only)');
  if (config.seedDemo || stopEmbedded) await seedDemo(ctx).then((made) => made && console.log('Seeded demo events. Organiser demo login: 9000000001'));

  const app = buildApp(ctx);

  // Background workers. Each is safe to run in several processes at once (guarded updates, advisory locks, SKIP LOCKED).
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    if (ms <= 0) return;
    timers.push(setInterval(() => void fn().catch((err) => app.log.error({ err: (err as Error).message }, `${name} failed`)), ms).unref());
  };
  every(config.holdSweepIntervalMs, 'hold sweeper', () => expireDueHolds(ctx));
  every(config.queueTickMs, 'queue ticker', () => tick(ctx));
  every(config.gateHealMs, 'fast gate heal', () => ctx.gate.heal());
  every(config.reconcileIntervalMs, 'reconciliation', () => reconcile(ctx));
  every(3000, 'outbox', () => deliverPending(ctx));
  every(15_000, 'hold reminders', () => remindExpiring(ctx));
  every(10_000, 'refund retry', () => finishPendingRefunds(ctx));
  every(3_600_000, 'housekeeping', () => purgeExpired(ctx));

  const stop = async () => {
    timers.forEach(clearInterval);
    await app.close();
    await close();
    await stopEmbedded?.();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await app.listen({ port: config.port, host: process.env.HOST ?? '0.0.0.0' });
} catch (err) {
  console.error(`Cannot start: ${(err as Error).message}`);
  process.exit(1);
}
