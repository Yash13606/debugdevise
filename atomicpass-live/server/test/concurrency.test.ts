import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, expectClean, hold, login, makeEnv, makeEvent, makeOrganiser, phoneOf, secondApp, type Env, type Person } from './helpers.js';

const CROWD = 50;
const wins = (rs: { status: number }[]) => rs.filter((r) => r.status === 201).length;
const codes = (rs: { status: number; body: any }[]) => rs.filter((r) => r.status !== 201).map((r) => r.body.error.code);

// Everything runs twice: once with the Redis fast gate in front, once with it off, so the database's own guards
// are proven on their own and not just hidden behind the gate.
describe.each([
  ['fast gate on', {}],
  ['fast gate off (the database alone)', { GATE_ENABLED: 'false' }],
])('%s', (_label, envVars) => {
  let e: Env;
  let org: Person;
  let crowd: Person[];

  beforeAll(async () => {
    e = await makeEnv(envVars);
    org = await makeOrganiser(e.app);
    crowd = await Promise.all(Array.from({ length: CROWD }, (_, i) => login(e.app, phoneOf(100 + i))));
  });
  afterAll(async () => {
    await expectClean(e);
    await e.close();
  });


describe('the last ticket', () => {
  it('two buyers, one ticket: exactly one wins', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 1 }] });
    const rs = await Promise.all(crowd.slice(0, 2).map((p) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])));
    expect(wins(rs)).toBe(1);
    expect(codes(rs)).toEqual(['SOLD_OUT']);
    await expectClean(e);
  });

  it('50 buyers for 10 seats, 20 rounds: exactly 10 win every round', async () => {
    for (let round = 0; round < 20; round++) {
      const ev = await makeEvent(org, { tiers: [{ capacity: 10 }] });
      const rs = await Promise.all(crowd.map((p) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])));
      expect(wins(rs), `round ${round}`).toBe(10);
      expect(new Set(codes(rs))).toEqual(new Set(['SOLD_OUT']));
      const stats = await org.call('GET', `/api/organiser/events/${ev.id}`);
      expect(stats.body.event.held).toBe(10);
      expect(stats.body.event.available).toBe(0);
    }
    await expectClean(e);
  });

  it('a shared pool: two tiers of 5 inside an event of 5; ten buyers, exactly five win', async () => {
    const ev = await makeEvent(org, { capacity: 5, tiers: [{ capacity: 5 }, { capacity: 5 }] });
    const rs = await Promise.all(crowd.slice(0, 10).map((p, i) => hold(p, ev.id, [{ tier_id: ev.tiers[i % 2]!.id, quantity: 1 }])));
    expect(wins(rs)).toBe(5);
    expect(new Set(codes(rs))).toEqual(new Set(['SOLD_OUT'])); // a clean refusal, not a database CHECK error
    const view = await org.call('GET', `/api/organiser/events/${ev.id}`);
    expect(view.body.event.held).toBe(5);
    expect(view.body.tiers.every((t: { held: number }) => t.held <= 5)).toBe(true);
    await expectClean(e);
  });

  it('big orders racing small ones never oversell', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 10, max_per_order: 4 }] });
    const rs = await Promise.all(crowd.slice(0, 20).map((p, i) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: (i % 4) + 1 }])));
    const held = rs.filter((r) => r.status === 201).reduce((s, r) => s + r.body.hold.items[0].quantity, 0);
    expect(held).toBeLessThanOrEqual(10);
    expect(codes(rs).every((c) => c === 'SOLD_OUT')).toBe(true);
    const view = await org.call('GET', `/api/organiser/events/${ev.id}`);
    expect(view.body.event.held).toBe(held);
    await expectClean(e);
  });

  it('two server instances on one database race for the same seats', async () => {
    const other = await secondApp(e);
    try {
      const second = crowd.map((p) => ({ ...p, call: api(other.app, p.token) }));
      for (let round = 0; round < 5; round++) {
        const ev = await makeEvent(org, { tiers: [{ capacity: 8 }] });
        const rs = await Promise.all(crowd.map((p, i) => hold(i % 2 ? second[i]! : p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])));
        expect(wins(rs), `round ${round}`).toBe(8);
      }
      await expectClean(e);
    } finally {
      await other.close();
    }
  });
});

describe('reserved seats', () => {
  it('20 buyers want the same seat: exactly one gets it', async () => {
    const ev = await makeEvent(org, { tiers: [{ seated: { rows: 2, seats_per_row: 5 } }] });
    const map = await org.call('GET', `/api/events/${ev.id}/seats`);
    const seat = map.body.tiers[ev.tiers[0]!.id][0];
    const rs = await Promise.all(crowd.slice(0, 20).map((p) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, seat_ids: [seat.id] }])));
    expect(wins(rs)).toBe(1);
    // The fast gate counts requests, not seat identity, so while many requests are in flight some are turned away as
    // SOLD_OUT instead of SEAT_TAKEN. Both are refusals; neither can ever be an oversell.
    expect(codes(rs).every((c) => c === 'SEAT_TAKEN' || c === 'SOLD_OUT')).toBe(true);
    await expectClean(e);
  });

  it('overlapping seat sets taken in opposite orders never deadlock', async () => {
    for (let round = 0; round < 10; round++) {
      const ev = await makeEvent(org, { tiers: [{ seated: { rows: 1, seats_per_row: 6 } }] });
      const seats = (await org.call('GET', `/api/events/${ev.id}/seats`)).body.tiers[ev.tiers[0]!.id] as { id: string }[];
      const ids = seats.map((s) => s.id);
      const asks = [ids.slice(0, 3), [...ids.slice(0, 3)].reverse(), ids.slice(2, 5), [...ids.slice(2, 5)].reverse(), ids.slice(4, 6)];
      const rs = await Promise.all(asks.map((seatIds, i) => hold(crowd[i]!, ev.id, [{ tier_id: ev.tiers[0]!.id, seat_ids: seatIds }])));
      expect(rs.every((r) => r.status === 201 || ['SEAT_TAKEN', 'SOLD_OUT'].includes(r.body.error.code)), JSON.stringify(rs.map((r) => r.body.error ?? 'ok'))).toBe(true);
      expect(wins(rs)).toBeGreaterThanOrEqual(1);
    }
    await expectClean(e);
  });
});
});
