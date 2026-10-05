import { loadConfig, loadDotEnv } from './config.js';
import { openDb } from './db.js';
import { expireDueHolds } from './holds.js';
import { buildApp } from './http.js';
import { tick } from './queue.js';

try {
  loadDotEnv();
  const config = loadConfig();
  const ctx = { db: openDb(config.databasePath), config };
  const app = buildApp(ctx);

  // The sweeper only keeps the books tidy: the next reservation frees due seats by itself.
  const timers: NodeJS.Timeout[] = [];
  if (config.holdSweepIntervalMs > 0) {
    timers.push(
      setInterval(() => {
        try {
          expireDueHolds(ctx);
        } catch (err) {
          app.log.error(err, 'hold sweeper failed');
        }
      }, config.holdSweepIntervalMs),
    );
  }

  if (config.queueTickMs > 0) {
    timers.push(
      setInterval(() => {
        try {
          tick(ctx);
        } catch (err) {
          app.log.error(err, 'queue ticker failed');
        }
      }, config.queueTickMs),
    );
  }

  const stop = async () => {
    timers.forEach(clearInterval);
    await app.close();
    ctx.db.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await app.listen({ port: config.port });
} catch (err) {
  console.error(`Cannot start: ${(err as Error).message}`);
  process.exit(1);
}
