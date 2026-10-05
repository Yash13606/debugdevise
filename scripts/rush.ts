// Rush simulation: many buyers press "buy" at the same moment. The result is informational: how many got
// a hold, how many were told sold out, and whether the invariants still hold afterwards. It runs in this
// process against a temporary database and sends the requests through the HTTP stack (app.inject), not
// over a network.
//   npm run rush                              5,000 buyers, 4,500 seats
//   npm run rush -- --buyers 2000 --capacity 1500
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkInvariants, createEvent, createTier } from '../src/admin.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/http.js';

export async function rush(buyers = 5000, capacity = 4500) {
  const dir = mkdtempSync(join(tmpdir(), 'atomicpass-rush-'));
  const config = loadConfig({
    DATABASE_PATH: join(dir, 'rush.db'),
    LOG_LEVEL: 'silent',
    HOLD_SWEEP_INTERVAL_MS: '0',
    QUEUE_TICK_MS: '0',
  });
  const db = openDb(config.databasePath);
  const ctx = { db, config };
  const app = buildApp(ctx);
  await app.ready();
  try {
    const { event } = createEvent(ctx, { name: 'Rush', starts_at: '2026-10-20T13:00:00Z', capacity });
    const { tier } = createTier(ctx, event.id, { name: 'General', price_cents: 49900, capacity });

    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: buyers }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/api/events/${event.id}/holds`,
          payload: { email: `buyer${i}@example.com`, items: [{ tier_id: tier.id, quantity: 1 }] },
        }),
      ),
    );
    const seconds = (performance.now() - started) / 1000;

    const created = responses.filter((r) => r.statusCode === 201).length;
    const soldOut = responses.filter((r) => r.statusCode === 409 && r.json().error.code === 'SOLD_OUT').length;
    return { buyers, capacity, created, soldOut, other: buyers - created - soldOut, seconds, invariants: checkInvariants(db, event.id) };
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { buyers: { type: 'string', default: '5000' }, capacity: { type: 'string', default: '4500' } } });
  const buyers = Number(values.buyers);
  const capacity = Number(values.capacity);
  if (!Number.isInteger(buyers) || !Number.isInteger(capacity) || buyers < 1 || capacity < 1) {
    console.error('--buyers and --capacity must be whole numbers, at least 1');
    process.exit(1);
  }

  console.log(`Rush: ${buyers} buyers press buy at once for ${capacity} seats (one tier, one event)...`);
  const r = await rush(buyers, capacity);
  const expected = Math.min(buyers, capacity);
  const clean = r.created === expected && r.soldOut === buyers - expected && r.other === 0 && r.invariants.ok;
  console.log(`  requests:    ${r.buyers} in ${r.seconds.toFixed(2)} s (${Math.round(r.buyers / r.seconds)} per second)`);
  console.log(`  holds made:  ${r.created} (expected ${expected})`);
  console.log(`  sold out:    ${r.soldOut} (expected ${buyers - expected})`);
  console.log(`  other:       ${r.other}`);
  console.log(`  invariants:  ${r.invariants.ok ? 'ok' : `BROKEN ${JSON.stringify(r.invariants.mismatches.slice(0, 3))}`}`);
  console.log(clean ? 'Result: exactly the capacity was handed out, nothing oversold.' : 'Result: UNEXPECTED, see the numbers above.');
  process.exit(clean ? 0 : 1);
}
