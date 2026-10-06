import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock.js';
import { signPass } from '../src/ids.js';
import { tick } from '../src/queue.js';
import { api, expectClean, hold, joinQueue, login, makeEnv, makeEvent, makeOrganiser, phoneOf, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
let crowd: Person[];

beforeAll(async () => {
  e = await makeEnv({ QUEUE_ADMIT_PER_TICK: '3', QUEUE_MAX_ADMITTED: '100', QUEUE_ADMIT_TTL_SECONDS: '60', QUEUE_ADMIT_MULTIPLIER: '2' });
  org = await makeOrganiser(e.app);
  crowd = await Promise.all(Array.from({ length: 12 }, (_, i) => login(e.app, phoneOf(400 + i))));
});
afterEach(() => setClock(null));
afterAll(async () => {
  await expectClean(e);
  await e.close();
});

const queued = (capacity = 20) => makeEvent(org, { queue_enabled: true, tiers: [{ capacity }] });
const join = joinQueue;
const status = (p: Person, eventId: string) => p.call('GET', `/api/events/${eventId}/queue`);
const want = (ev: { id: string; tiers: { id: string }[] }, p: Person, pass?: string) => hold(p, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }], pass ? { queue_pass: pass } : {});

describe('the waiting room', () => {
  it('joining twice returns the same place; concurrent joins make one entry', async () => {
    const ev = await queued();
    const first = await join(crowd[0]!, ev.id);
    expect(first.status).toBe(201);
    expect((await join(crowd[0]!, ev.id)).status).toBe(200);
    await Promise.all(Array.from({ length: 6 }, () => join(crowd[1]!, ev.id)));
    const n = await e.ctx.pool.query(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 AND user_id = $2`, [ev.id, crowd[1]!.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('admits first come, first served, a few per tick', async () => {
    const ev = await queued();
    for (const p of crowd.slice(0, 8)) await join(p, ev.id);
    expect((await status(crowd[7]!, ev.id)).body.position).toBe(8);
    await tick(e.ctx); // admits for every queued event, so judge by this event's own entries
    const states = await Promise.all(crowd.slice(0, 8).map(async (p) => (await status(p, ev.id)).body.status));
    expect(states).toEqual(['ADMITTED', 'ADMITTED', 'ADMITTED', 'WAITING', 'WAITING', 'WAITING', 'WAITING', 'WAITING']);
    expect((await status(crowd[3]!, ev.id)).body.position).toBe(1);
  });

  it('pacing follows capacity: never more outstanding admissions than twice the seats left', async () => {
    const ev = await queued(2); // 2 seats: at most 4 admissions out at once
    for (const p of crowd.slice(0, 10)) await join(p, ev.id);
    await tick(e.ctx);
    await tick(e.ctx);
    await tick(e.ctx);
    const admitted = await e.ctx.pool.query(`SELECT COUNT(*)::int AS n FROM queue_entries WHERE event_id = $1 AND status = 'ADMITTED'`, [ev.id]);
    expect(admitted.rows[0].n).toBe(4);
  });

  it('a hold needs a genuine pass: none, forged, someone elses', async () => {
    const ev = await queued();
    const a = crowd[0]!, b = crowd[1]!;
    await join(a, ev.id);
    await join(b, ev.id);
    expect((await want(ev, a)).body.error.details.reason).toBe('NO_PASS');
    expect((await want(ev, a, 'garbage.pass')).body.error.details.reason).toBe('INVALID_PASS');
    const forged = signPass('not-the-secret', { q: 'que_x', u: a.id, e: ev.id, x: Date.now() + 60_000 });
    expect((await want(ev, a, forged)).body.error.details.reason).toBe('INVALID_PASS');
    await tick(e.ctx);
    const passA = (await status(a, ev.id)).body.pass as string;
    expect(passA).toBeTruthy();
    expect((await want(ev, b, passA)).body.error.code).toBe('NOT_ADMITTED'); // b cannot use a's pass
    expect((await status(b, ev.id)).body.status).toBe('ADMITTED'); // and b's own admission is untouched
  });

  it('an admission is used once', async () => {
    const ev = await queued(5);
    const a = crowd[2]!;
    await join(a, ev.id);
    await tick(e.ctx);
    const pass = (await status(a, ev.id)).body.pass;
    expect((await want(ev, a, pass)).status).toBe(201);
    expect((await want(ev, a, pass)).body.error.details.reason).toBe('USED');
    await expectClean(e);
  });

  it('a refused hold does not use the admission up', async () => {
    const ev = await queued(1);
    const a = crowd[3]!, b = crowd[6]!;
    await join(a, ev.id);
    await join(b, ev.id);
    await tick(e.ctx);
    const passA = (await status(a, ev.id)).body.pass;
    const passB = (await status(b, ev.id)).body.pass;
    expect((await want(ev, a, passA)).status).toBe(201);
    expect((await want(ev, b, passB)).body.error.code).toBe('SOLD_OUT');
    expect((await status(b, ev.id)).body.status).toBe('ADMITTED'); // still admitted: the refusal consumed nothing
    await expectClean(e);
  });

  it('an admission lapses after its time, and the buyer can queue again', async () => {
    const ev = await queued();
    const a = crowd[4]!;
    await join(a, ev.id);
    await tick(e.ctx);
    const pass = (await status(a, ev.id)).body.pass;
    setClock(() => Date.now() + 61_000);
    expect((await status(a, ev.id)).body.status).toBe('EXPIRED');
    expect((await want(ev, a, pass)).status).toBe(403);
    const again = await join(a, ev.id);
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('WAITING');
  });

  it('events without a waiting room refuse the queue; unknown events 404', async () => {
    const plain = await makeEvent(org);
    expect((await join(crowd[5]!, plain.id)).body.error.code).toBe('QUEUE_NOT_ENABLED');
    expect((await join(crowd[5]!, 'evt_missing')).status).toBe(404);
    expect((await api(e.app)('POST', `/api/events/${plain.id}/queue`)).status).toBe(401);
  });
});
