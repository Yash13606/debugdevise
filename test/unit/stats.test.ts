import { afterEach, describe, expect, it } from 'vitest';
import { checkInvariants } from '../../src/admin.js';
import {
  ADMIN,
  buyTickets,
  cleanupTemp,
  fakeClock,
  joinQueue,
  line,
  makeApp,
  newEvent,
  newPromo,
  newTier,
  payHold,
  placeHold,
  refund,
  releaseHold,
  scan,
  tick,
  type TestApp,
} from '../helpers.js';

afterEach(cleanupTemp);

const stats = (t: TestApp, eventId: string, headers: Record<string, string> = ADMIN) =>
  t.app.inject({ method: 'GET', url: `/api/admin/events/${eventId}/stats`, headers });

describe('GET /api/admin/events/:id/stats', () => {
  it('reports the pool, the tiers and every status count, and the invariants are clean', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '600' });
    const clock = fakeClock();
    const event = await newEvent(t, { capacity: 20 });
    const a = await newTier(t, event.id, { name: 'A', capacity: 10, price_cents: 1000 });
    const b = await newTier(t, event.id, { name: 'B', capacity: 10, price_cents: 500 });

    await placeHold(t, event.id, 'stale@x.com', [line(b)]); // will expire
    clock.advance(601_000);
    const bought = await buyTickets(t, event.id, a, 2, 'buyer@x.com'); // 2 tickets
    await scan(t, bought.tickets[0]!.qr_payload); // one CHECKED_IN
    await refund(t, bought.order.id, { ticket_ids: [bought.tickets[1]!.id] }); // one VOID
    const released = (await placeHold(t, event.id, 'gone@x.com', [line(b)])).json();
    await releaseHold(t, released.hold.id, released.hold_token); // RELEASED
    await placeHold(t, event.id, 'live@x.com', [line(a, 3)]); // ACTIVE, 3 seats of A

    const res = await stats(t, event.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      event: { capacity: 20, sold: 1, held: 3, available: 16 },
      tiers: [
        { id: a.id, capacity: 10, sold: 1, held: 3, available: 6 },
        { id: b.id, capacity: 10, sold: 0, held: 0, available: 10 },
      ],
      tickets: { VALID: 0, CHECKED_IN: 1, VOID: 1 },
      holds: { ACTIVE: 1, CONVERTED: 1, EXPIRED: 1, RELEASED: 1 },
      queue: { WAITING: 0, ADMITTED: 0, USED: 0, EXPIRED: 0 },
      invariants: { ok: true, mismatches: [] },
    });
  });

  it('counts the waiting room by status', async () => {
    const t = await makeApp({ QUEUE_ADMIT_PER_TICK: '2' });
    const event = await newEvent(t, { capacity: 10, queue_enabled: true });
    const tier = await newTier(t, event.id, { capacity: 10 });
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) tokens.push((await joinQueue(t, event.id, `q${i}@x.com`)).json().queue_token);
    await tick(t); // admits q0 and q1
    await placeHold(t, event.id, 'q0@x.com', [line(tier)], {}, { 'x-queue-token': tokens[0]! }); // q0 USED

    expect((await stats(t, event.id)).json().queue).toEqual({ WAITING: 2, ADMITTED: 1, USED: 1, EXPIRED: 0 });
  });

  it('frees due holds first, so the numbers are current', async () => {
    const t = await makeApp({ HOLD_TTL_SECONDS: '1' });
    const clock = fakeClock();
    const event = await newEvent(t, { capacity: 5 });
    const tier = await newTier(t, event.id, { capacity: 5 });
    await placeHold(t, event.id, 'a@x.com', [line(tier, 2)]);
    clock.advance(1000);

    const body = (await stats(t, event.id)).json();

    expect(body.event).toMatchObject({ held: 0, available: 5 });
    expect(body.holds).toMatchObject({ ACTIVE: 0, EXPIRED: 1 });
  });

  it('needs the admin key; an unknown event is 404', async () => {
    const t = await makeApp();
    const event = await newEvent(t);
    expect((await stats(t, event.id, {})).statusCode).toBe(401);
    expect((await stats(t, 'evt_doesnotexist')).statusCode).toBe(404);
  });
});

describe('the invariant check (I-1)', () => {
  /** A paid order of 3 (with a promo), one active hold of 2; the data is then damaged on purpose. */
  async function scenario() {
    const t = await makeApp({ MAX_TICKETS_PER_BUYER: '0' });
    t.checkInvariants = false;
    const event = await newEvent(t, { capacity: 20 });
    const tier = await newTier(t, event.id, { capacity: 20, max_per_order: 20 });
    const promo = await newPromo(t, event.id, { code: 'ONE', max_uses: 5 });
    const bought = (await placeHold(t, event.id, 'a@x.com', [line(tier, 3)], { promo_code: 'ONE' })).json();
    await payHold(t, bought.hold.id, bought.hold_token);
    await placeHold(t, event.id, 'b@x.com', [line(tier, 2)]);
    const one = (sql: string) => t.db.prepare(sql).pluck().get() as string;
    return {
      t,
      event,
      tier,
      promo,
      ticket: one('SELECT id FROM tickets ORDER BY rowid LIMIT 1'),
      activeHold: one(`SELECT id FROM holds WHERE status = 'ACTIVE'`),
    };
  }

  it('is clean on healthy data', async () => {
    const s = await scenario();
    expect(checkInvariants(s.t.db)).toEqual({ ok: true, mismatches: [] });
    expect(checkInvariants(s.t.db, s.event.id)).toEqual({ ok: true, mismatches: [] });
  });

  it.each([
    ['a tier counts a seat nobody holds', 'UPDATE tiers SET held = held + 1', (s: Awaited<ReturnType<typeof scenario>>) => `I3 tier ${s.tier.id} held`],
    ['a tier forgets a sold seat', 'UPDATE tiers SET sold = sold - 1', (s: Awaited<ReturnType<typeof scenario>>) => `I3 tier ${s.tier.id} sold`],
    ['the event counts a seat nobody holds', 'UPDATE events SET held = held + 1', (s: Awaited<ReturnType<typeof scenario>>) => `I3 event ${s.event.id} held`],
    ['the event forgets a sold seat', 'UPDATE events SET sold = sold - 1', (s: Awaited<ReturnType<typeof scenario>>) => `I3 event ${s.event.id} sold`],
    ['a promo code has a use nobody made', 'UPDATE promo_codes SET used = used + 1', (s: Awaited<ReturnType<typeof scenario>>) => `I5 promo ${s.promo.id}`],
    ['a valid ticket has a void time', 'UPDATE tickets SET voided_at = 1 WHERE rowid = 1', (s: Awaited<ReturnType<typeof scenario>>) => `I4 ticket ${s.ticket}`],
    ['a void ticket was once checked in', "UPDATE tickets SET status = 'VOID', checked_in_at = 1 WHERE rowid = 1", (s: Awaited<ReturnType<typeof scenario>>) => `I4 ticket ${s.ticket}`],
    ['a live hold has a closing time', "UPDATE holds SET closed_at = 5 WHERE status = 'ACTIVE'", (s: Awaited<ReturnType<typeof scenario>>) => `I6 hold ${s.activeHold}`],
  ])('finds it when %s', async (_name, damage, expected) => {
    const s = await scenario();
    s.t.db.exec(damage);

    const result = checkInvariants(s.t.db, s.event.id);

    expect(result.ok).toBe(false);
    expect(result.mismatches.map((m) => `${m.rule} ${m.subject}`)).toContain(expected(s));
    expect((await stats(s.t, s.event.id)).json().invariants.ok).toBe(false);
  });

  it('finds sold + held above capacity on a tier and on the pool (I1, I2)', async () => {
    const s = await scenario();
    s.t.db.exec('PRAGMA ignore_check_constraints = ON'); // the CHECK would refuse this; the audit must still notice
    s.t.db.exec('UPDATE tiers SET held = 99; UPDATE events SET held = 99');

    const found = checkInvariants(s.t.db).mismatches.map((m) => `${m.rule} ${m.subject}`);

    expect(found).toContain(`I1 tier ${s.tier.id}`);
    expect(found).toContain(`I2 event ${s.event.id}`);
  });

  it('finds two live queue entries for one buyer when the unique index is gone (I7)', async () => {
    const t = await makeApp();
    t.checkInvariants = false;
    const event = await newEvent(t, { capacity: 5, queue_enabled: true });
    t.db.exec('DROP INDEX uq_queue_live');
    const add = t.db.prepare(
      `INSERT INTO queue_entries (id, event_id, email, email_norm, queue_token, status, joined_at)
       VALUES (?, ?, 'a@x.com', 'a@x.com', ?, 'WAITING', 0)`,
    );
    add.run('que_one', event.id, 'tok1');
    add.run('que_two', event.id, 'tok2');

    expect(checkInvariants(t.db).mismatches.map((m) => `${m.rule} ${m.subject}`)).toEqual([`I7 queue ${event.id} a@x.com`]);
  });
});
