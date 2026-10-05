// A short, narrated demo of the differentiator: the waiting room and the per-buyer cap. It runs in this
// process on a temporary database and sends every request through the HTTP stack (app.inject).
//   npm run demo
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEvent, createTier } from '../src/admin.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/http.js';

const STARTS_AT = '2026-10-20T13:00:00Z';

export async function demo(print: (line: string) => void = console.log) {
  const dir = mkdtempSync(join(tmpdir(), 'atomicpass-demo-'));
  const config = loadConfig({
    DATABASE_PATH: join(dir, 'demo.db'),
    LOG_LEVEL: 'silent',
    HOLD_SWEEP_INTERVAL_MS: '0',
    QUEUE_TICK_MS: '0',
    QUEUE_ADMIT_PER_TICK: '3',
    MAX_TICKETS_PER_BUYER: '4',
  });
  const db = openDb(config.databasePath);
  const ctx = { db, config };
  const app = buildApp(ctx);
  await app.ready();
  const admin = { 'x-admin-key': config.adminApiKey };
  try {
    print('AtomicPass demo: the waiting room and the per-buyer cap');
    print('(one process, temporary database; 3 admitted per tick, at most 4 tickets per buyer)');

    const { event } = createEvent(ctx, { name: 'Fest', starts_at: STARTS_AT, capacity: 20, queue_enabled: true });
    const { tier } = createTier(ctx, event.id, { name: 'General', price_cents: 49900, capacity: 20 });
    const email = (n: number) => `q${n}@x.com`;
    const buy = (n: number, token: string, quantity: number) =>
      app.inject({
        method: 'POST',
        url: `/api/events/${event.id}/holds`,
        headers: { 'x-queue-token': token },
        payload: { email: email(n), items: [{ tier_id: tier.id, quantity }] },
      });
    const statuses = async (tokens: string[]) =>
      Promise.all(
        tokens.map(async (token) => {
          const j = (await app.inject({ method: 'GET', url: `/api/events/${event.id}/queue`, headers: { 'x-queue-token': token } })).json();
          return { status: j.status as string, position: j.position as number };
        }),
      );
    const admittedEmails = (s: { status: string }[]) => s.flatMap((x, i) => (x.status === 'ADMITTED' ? [email(i + 1)] : []));

    print('\n1. Ten buyers join the line, in order');
    const tokens: string[] = [];
    const positions: number[] = [];
    for (let n = 1; n <= 10; n++) {
      const r = await app.inject({ method: 'POST', url: `/api/events/${event.id}/queue`, payload: { email: email(n) } });
      tokens.push(r.json().queue_token);
      positions.push(r.json().position);
      print(`   ${email(n).padEnd(8)} POST /queue -> ${r.statusCode} ${r.json().status}, position ${r.json().position}`);
    }

    print('\n2. One tick of the waiting room admits the first three, in join order');
    const tick1 = (await app.inject({ method: 'POST', url: '/api/admin/queue/tick', headers: admin })).json();
    const afterFirst = await statuses(tokens);
    const admittedByFirstTick = admittedEmails(afterFirst);
    print(`   POST /admin/queue/tick -> admitted ${tick1.admitted}: ${admittedByFirstTick.join(', ')}`);
    print(`   still waiting: ${afterFirst.flatMap((s, i) => (s.status === 'WAITING' ? [`${email(i + 1)} (position ${s.position})`] : [])).join(', ')}`);

    print('\n3. The fourth buyer tries to buy before being admitted');
    const early = await buy(4, tokens[3]!, 1);
    const earlyError = early.json().error;
    print(`   ${email(4)} POST /holds -> ${early.statusCode} ${earlyError.code} (${earlyError.details.reason})`);

    print('\n4. The first buyer was admitted and buys three tickets');
    const first = await buy(1, tokens[0]!, 3);
    print(`   ${email(1)} POST /holds -> ${first.statusCode}, ${first.json().hold.items[0].quantity} seats held for ${first.json().hold.expires_in_seconds} s`);

    print('\n5. The next tick admits the next three; the fourth buyer is now in and buys');
    await app.inject({ method: 'POST', url: '/api/admin/queue/tick', headers: admin });
    const afterSecond = await statuses(tokens);
    const admittedBySecondTick = admittedEmails(afterSecond).filter((e) => !admittedByFirstTick.includes(e));
    print(`   newly admitted: ${admittedBySecondTick.join(', ')}`);
    const late = await buy(4, tokens[3]!, 1);
    print(`   ${email(4)} POST /holds -> ${late.statusCode}`);

    print('\n6. The per-buyer cap: the same person under two spellings of one address (event without a queue)');
    const open = createEvent(ctx, { name: 'Open sale', starts_at: STARTS_AT, capacity: 20 }).event;
    const openTier = createTier(ctx, open.id, { name: 'General', price_cents: 49900, capacity: 20 }).tier;
    const ask = (who: string, quantity: number) =>
      app.inject({
        method: 'POST',
        url: `/api/events/${open.id}/holds`,
        payload: { email: who, items: [{ tier_id: openTier.id, quantity }] },
      });
    const one = await ask('a+x@g.com', 3);
    print(`   a+x@g.com asks for 3 -> ${one.statusCode}`);
    const two = await ask('a@g.com', 2);
    const capError = two.json().error;
    print(`   a@g.com   asks for 2 -> ${two.statusCode} ${capError.code} ${JSON.stringify(capError.details)}`);

    print('\nDone: the line was first come, first admitted; an unadmitted buyer was refused; the cap held.');
    return {
      positions,
      admittedByFirstTick,
      waitingBuyerRefusal: { status: early.statusCode, code: earlyError.code as string, reason: earlyError.details.reason as string },
      admittedBuyerStatus: first.statusCode,
      admittedBySecondTick,
      fourthBuyerStatus: late.statusCode,
      capRefusal: { status: two.statusCode, code: capError.code as string, details: capError.details as Record<string, number> },
    };
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await demo();
}
