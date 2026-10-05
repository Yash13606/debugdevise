import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTemp,
  fakeClock,
  joinQueue,
  line,
  makeApp,
  newEvent,
  newTier,
  patchEvent,
  placeHold,
  queueStatus,
  releaseHold,
  tick,
  type TestApp,
} from '../helpers.js';

afterEach(cleanupTemp);

/** An event with the waiting room on and one tier. */
async function queueEvent(env: Record<string, string> = {}, capacity = 20) {
  const t: TestApp = await makeApp(env);
  const event = await newEvent(t, { capacity, queue_enabled: true });
  const tier = await newTier(t, event.id, { capacity, max_per_order: 10 });
  return { t, event, tier };
}

/** Join `n` buyers in order; returns their tokens. */
async function joinMany(t: TestApp, eventId: string, n: number, prefix = 'q') {
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) tokens.push((await joinQueue(t, eventId, `${prefix}${i}@x.com`)).json().queue_token);
  return tokens;
}

const hold = (t: TestApp, eventId: string, tier: { id: string }, email: string, token?: string, qty = 1) =>
  placeHold(t, eventId, email, [line(tier, qty)], {}, token ? { 'x-queue-token': token } : {});

const statusOf = async (t: TestApp, eventId: string, tokens: string[]) =>
  Promise.all(tokens.map(async (tok) => (await queueStatus(t, eventId, tok)).json().status as string));

const notAdmitted = (res: { statusCode: number; json: () => { error: { code: string; details?: { reason?: string } } } }) => [
  res.statusCode,
  res.json().error.code,
  res.json().error.details?.reason,
];

describe('Q-1: first come, first admitted', () => {
  it('ten buyers join in order; three are admitted per tick, in join order; the 4th is 403 NOT_ADMITTED', async () => {
    const { t, event, tier } = await queueEvent({ QUEUE_ADMIT_PER_TICK: '3' });

    const joins = [];
    for (let i = 0; i < 10; i++) joins.push(await joinQueue(t, event.id, `q${i}@x.com`));
    expect(joins.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
    expect(joins.map((r) => r.json().position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(joins.map((r) => r.json().ahead)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(joins[0]!.json()).toMatchObject({ status: 'WAITING', admit_expires_at: null });
    const tokens: string[] = joins.map((r) => r.json().queue_token);

    expect((await tick(t)).json()).toEqual({ admitted: 3 });
    expect(await statusOf(t, event.id, tokens)).toEqual([...Array(3).fill('ADMITTED'), ...Array(7).fill('WAITING')]);
    const admitted = (await queueStatus(t, event.id, tokens[0])).json();
    expect(admitted).toMatchObject({ status: 'ADMITTED', position: 0, ahead: 0, eta_seconds: 0, sold_out: false });
    expect(Date.parse(admitted.admit_expires_at)).not.toBeNaN();
    expect((await queueStatus(t, event.id, tokens[3])).json()).toMatchObject({ status: 'WAITING', position: 1, ahead: 0 });

    // The 4th buyer is not admitted yet; the 1st is and may reserve.
    expect(notAdmitted(await hold(t, event.id, tier, 'q3@x.com', tokens[3]))).toEqual([403, 'NOT_ADMITTED', 'WAITING']);
    expect((await hold(t, event.id, tier, 'q0@x.com', tokens[0])).statusCode).toBe(201);
    expect((await queueStatus(t, event.id, tokens[0])).json().status).toBe('USED');

    // Later ticks keep the join order.
    await tick(t);
    expect(await statusOf(t, event.id, tokens)).toEqual([
      'USED', 'ADMITTED', 'ADMITTED', 'ADMITTED', 'ADMITTED', 'ADMITTED', ...Array(4).fill('WAITING'),
    ]);
    expect((await hold(t, event.id, tier, 'q3@x.com', tokens[3])).statusCode).toBe(201);
  });

  it('reports a rough wait: ceil(position / admitted per tick) ticks of QUEUE_TICK_MS', async () => {
    const { t, event } = await queueEvent({ QUEUE_ADMIT_PER_TICK: '3', QUEUE_TICK_MS: '2000' });
    const tokens = await joinMany(t, event.id, 10);
    const etas = await Promise.all(tokens.map(async (tok) => (await queueStatus(t, event.id, tok)).json().eta_seconds));
    expect(etas).toEqual([2, 2, 2, 4, 4, 4, 6, 6, 6, 8]);
  });
});

describe('Q-2: joining twice returns the same entry', () => {
  it('the same email, in any spelling that normalises to it, gets the same token and place', async () => {
    const { t, event } = await queueEvent();
    await joinMany(t, event.id, 3);

    const first = await joinQueue(t, event.id, 'A.B+one@gmail.com');
    const again = await joinQueue(t, event.id, ' ab@Gmail.com ');

    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(first.json().position).toBe(4);
  });
});

describe('when the waiting room does not apply', () => {
  it('joining an event without it is 409 QUEUE_NOT_ENABLED and holds need no token; the organiser can switch it on and off', async () => {
    const t = await makeApp();
    const event = await newEvent(t, { capacity: 5 });
    const tier = await newTier(t, event.id, { capacity: 5 });
    const join = await joinQueue(t, event.id, 'a@x.com');
    expect([join.statusCode, join.json().error.code]).toEqual([409, 'QUEUE_NOT_ENABLED']);
    expect((await hold(t, event.id, tier, 'a@x.com')).statusCode).toBe(201);

    const on = await patchEvent(t, event.id, { queue_enabled: true });
    expect(on.json().event.queue_enabled).toBe(true);
    expect(notAdmitted(await hold(t, event.id, tier, 'b@x.com'))).toEqual([403, 'NOT_ADMITTED', 'UNKNOWN_TOKEN']);
    expect((await joinQueue(t, event.id, 'b@x.com')).statusCode).toBe(201);

    await patchEvent(t, event.id, { queue_enabled: false });
    expect((await hold(t, event.id, tier, 'b@x.com')).statusCode).toBe(201);
  });

  it('PATCH needs the admin key and a boolean; unknown events are 404', async () => {
    const { t, event } = await queueEvent();
    expect((await patchEvent(t, event.id, { queue_enabled: false }, {})).statusCode).toBe(401);
    expect((await patchEvent(t, event.id, { queue_enabled: 'yes' })).statusCode).toBe(400);
    expect((await patchEvent(t, event.id, {})).statusCode).toBe(400);
    expect((await patchEvent(t, 'evt_doesnotexist', { queue_enabled: true })).statusCode).toBe(404);
  });
});

describe('who may use an admission', () => {
  it('names the reason: UNKNOWN_TOKEN, EMAIL_MISMATCH, WAITING, USED', async () => {
    const { t, event, tier } = await queueEvent();
    const [a, b] = await joinMany(t, event.id, 2, 'who');
    await tick(t);

    expect(notAdmitted(await hold(t, event.id, tier, 'who0@x.com', 'not-a-token'))).toEqual([403, 'NOT_ADMITTED', 'UNKNOWN_TOKEN']);
    expect(notAdmitted(await hold(t, event.id, tier, 'who0@x.com'))).toEqual([403, 'NOT_ADMITTED', 'UNKNOWN_TOKEN']);
    expect(notAdmitted(await hold(t, event.id, tier, 'who1@x.com', a))).toEqual([403, 'NOT_ADMITTED', 'EMAIL_MISMATCH']);
    expect((await hold(t, event.id, tier, 'WHO0@x.com', a)).statusCode).toBe(201); // same buyer, other spelling
    expect(notAdmitted(await hold(t, event.id, tier, 'who0@x.com', a))).toEqual([403, 'NOT_ADMITTED', 'USED']);
    expect((await hold(t, event.id, tier, 'who1@x.com', b)).statusCode).toBe(201);
  });

  it("a token is only good for its own event", async () => {
    const { t, event, tier } = await queueEvent();
    const otherEvent = await newEvent(t, { capacity: 5, queue_enabled: true });
    const otherTier = await newTier(t, otherEvent.id, { capacity: 5 });
    const [token] = await joinMany(t, event.id, 1);
    await tick(t);

    expect(notAdmitted(await hold(t, otherEvent.id, otherTier, 'q0@x.com', token))).toEqual([403, 'NOT_ADMITTED', 'UNKNOWN_TOKEN']);
    expect((await queueStatus(t, otherEvent.id, token)).statusCode).toBe(403);
    expect((await hold(t, event.id, tier, 'q0@x.com', token)).statusCode).toBe(201);
  });
});

describe('an admission survives a refused reservation', () => {
  it('sold out: the admitted buyer keeps the admission and gets the seat when it is released', async () => {
    const { t, event, tier } = await queueEvent({}, 1);
    const [a, b] = await joinMany(t, event.id, 2, 'seat');
    await tick(t);

    const taken = await hold(t, event.id, tier, 'seat0@x.com', a);
    expect(taken.statusCode).toBe(201);
    const refused = await hold(t, event.id, tier, 'seat1@x.com', b);
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'SOLD_OUT']);
    expect((await queueStatus(t, event.id, b)).json()).toMatchObject({ status: 'ADMITTED', sold_out: true });

    await releaseHold(t, taken.json().hold.id, taken.json().hold_token);
    expect((await hold(t, event.id, tier, 'seat1@x.com', b)).statusCode).toBe(201);
  });

  it('over the per-buyer cap: BUYER_LIMIT keeps the admission too', async () => {
    const { t, event, tier } = await queueEvent({ MAX_TICKETS_PER_BUYER: '4' });
    const [first] = await joinMany(t, event.id, 1, 'cap');
    await tick(t);
    expect((await hold(t, event.id, tier, 'cap0@x.com', first, 3)).statusCode).toBe(201);

    const second = (await joinQueue(t, event.id, 'cap0@x.com')).json().queue_token as string; // a new admission
    await tick(t);
    const refused = await hold(t, event.id, tier, 'cap0@x.com', second, 2);
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'BUYER_LIMIT']);
    expect((await queueStatus(t, event.id, second)).json().status).toBe('ADMITTED');
    expect((await hold(t, event.id, tier, 'cap0@x.com', second, 1)).statusCode).toBe(201);
  });
});

describe('admission lifetime and pace', () => {
  it('an admission lapses after QUEUE_ADMIT_TTL_SECONDS: EXPIRED, the next tick admits the next buyer, re-joining goes to the back', async () => {
    const { t, event, tier } = await queueEvent({ QUEUE_ADMIT_PER_TICK: '1', QUEUE_MAX_ADMITTED: '1', QUEUE_ADMIT_TTL_SECONDS: '1' });
    const clock = fakeClock();
    const tokens = await joinMany(t, event.id, 3);
    await tick(t); // admits #1 only
    expect(await statusOf(t, event.id, tokens)).toEqual(['ADMITTED', 'WAITING', 'WAITING']);
    expect((await tick(t)).json()).toEqual({ admitted: 0 }); // still 1 unused admission

    clock.advance(1000);
    expect((await queueStatus(t, event.id, tokens[0])).json().status).toBe('EXPIRED'); // visible before any tick
    expect(notAdmitted(await hold(t, event.id, tier, 'q0@x.com', tokens[0]))).toEqual([403, 'NOT_ADMITTED', 'EXPIRED']);

    expect((await tick(t)).json()).toEqual({ admitted: 1 });
    expect(await statusOf(t, event.id, tokens)).toEqual(['EXPIRED', 'ADMITTED', 'WAITING']);

    const rejoin = await joinQueue(t, event.id, 'q0@x.com');
    expect(rejoin.statusCode).toBe(201);
    expect(rejoin.json().queue_token).not.toBe(tokens[0]);
    expect(rejoin.json().position).toBe(2); // behind #3
  });

  it('QUEUE_MAX_ADMITTED bounds the unused admissions; using one makes room for the next', async () => {
    const { t, event, tier } = await queueEvent({ QUEUE_ADMIT_PER_TICK: '5', QUEUE_MAX_ADMITTED: '2' });
    const tokens = await joinMany(t, event.id, 6);

    expect((await tick(t)).json()).toEqual({ admitted: 2 });
    expect((await tick(t)).json()).toEqual({ admitted: 0 });
    await hold(t, event.id, tier, 'q0@x.com', tokens[0]);
    expect((await tick(t)).json()).toEqual({ admitted: 1 });
    expect(await statusOf(t, event.id, tokens)).toEqual(['USED', 'ADMITTED', 'ADMITTED', 'WAITING', 'WAITING', 'WAITING']);
  });

  it('a buyer who used an admission can join again, at the back, with a new token', async () => {
    const { t, event, tier } = await queueEvent({ QUEUE_ADMIT_PER_TICK: '1' });
    const tokens = await joinMany(t, event.id, 3);
    await tick(t);
    await hold(t, event.id, tier, 'q0@x.com', tokens[0]);

    const rejoin = await joinQueue(t, event.id, 'q0@x.com');

    expect(rejoin.statusCode).toBe(201);
    expect(rejoin.json()).toMatchObject({ status: 'WAITING', position: 3 }); // behind q1 and q2
    expect(rejoin.json().queue_token).not.toBe(tokens[0]);
    expect((await queueStatus(t, event.id, tokens[0])).json().status).toBe('USED'); // the old entry is kept
  });
});

describe('queue status and join checks', () => {
  it('needs the entry token: wrong or missing is 403 FORBIDDEN', async () => {
    const { t, event } = await queueEvent();
    await joinMany(t, event.id, 1);
    for (const token of [undefined, 'nope']) {
      const res = await queueStatus(t, event.id, token);
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'FORBIDDEN']);
    }
  });

  it('validates the email and the event', async () => {
    const { t, event } = await queueEvent();
    const bad = await joinQueue(t, event.id, 'not-an-email');
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'VALIDATION_ERROR']);
    const unknown = await joinQueue(t, 'evt_doesnotexist', 'a@x.com');
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('POST /api/admin/queue/tick needs the admin key', async () => {
    const { t } = await queueEvent();
    expect((await t.app.inject({ method: 'POST', url: '/api/admin/queue/tick' })).statusCode).toBe(401);
  });
});
