import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTemp,
  fakeClock,
  getEvent,
  line,
  makeApp,
  newEvent,
  newTier,
  payHold,
  placeHold,
  refund,
  releaseHold,
  type TestApp,
} from '../helpers.js';

afterEach(cleanupTemp);

async function setup(env: Record<string, string> = {}) {
  const t: TestApp = await makeApp({ MAX_TICKETS_PER_BUYER: '4', ...env });
  const event = await newEvent(t, { capacity: 40 });
  const tier = await newTier(t, event.id, { capacity: 40, max_per_order: 10 });
  return { t, event, tier };
}

const limitError = (res: { statusCode: number; json: () => { error: { code: string; details?: unknown } } }) =>
  [res.statusCode, res.json().error.code, res.json().error.details];

describe('B-1: at most MAX_TICKETS_PER_BUYER per buyer per event', () => {
  it('a+x@g.com and a@g.com are one buyer: asking 3 and then 2 with a cap of 4 gives 409 BUYER_LIMIT', async () => {
    const { t, event, tier } = await setup();

    const first = await placeHold(t, event.id, 'a+x@g.com', [line(tier, 3)]);
    const second = await placeHold(t, event.id, 'a@g.com', [line(tier, 2)]);

    expect(first.statusCode).toBe(201);
    expect(limitError(second)).toEqual([409, 'BUYER_LIMIT', { limit: 4, used: 3, requested: 2 }]);
    expect((await getEvent(t, event.id)).event.held).toBe(3); // the refused request consumed nothing
    expect((await placeHold(t, event.id, 'A@G.com', [line(tier, 1)])).statusCode).toBe(201); // 3 + 1 = 4 is allowed
  });

  it('a single request above the cap is refused too', async () => {
    const { t, event, tier } = await setup();
    const res = await placeHold(t, event.id, 'a@x.com', [line(tier, 5)]);
    expect(limitError(res)).toEqual([409, 'BUYER_LIMIT', { limit: 4, used: 0, requested: 5 }]);
  });

  it('gmail dots do not make a new buyer, but dots elsewhere do', async () => {
    const { t, event, tier } = await setup();
    await placeHold(t, event.id, 'a.b@gmail.com', [line(tier, 4)]);
    expect((await placeHold(t, event.id, 'ab@gmail.com', [line(tier)])).statusCode).toBe(409);
    await placeHold(t, event.id, 'c.d@college.edu', [line(tier, 4)]);
    expect((await placeHold(t, event.id, 'cd@college.edu', [line(tier)])).statusCode).toBe(201);
  });

  it('counts paid tickets as well as active holds', async () => {
    const { t, event, tier } = await setup();
    const held = (await placeHold(t, event.id, 'a@x.com', [line(tier, 3)])).json();
    await payHold(t, held.hold.id, held.hold_token); // 3 tickets, now owned

    expect(limitError(await placeHold(t, event.id, 'a@x.com', [line(tier, 2)]))).toEqual([
      409,
      'BUYER_LIMIT',
      { limit: 4, used: 3, requested: 2 },
    ]);
    expect((await placeHold(t, event.id, 'a@x.com', [line(tier, 1)])).statusCode).toBe(201);
  });

  it('stops counting a hold that was released or expired, and a ticket that was refunded', async () => {
    const { t, event, tier } = await setup({ HOLD_TTL_SECONDS: '1' });
    const clock = fakeClock();
    const released = (await placeHold(t, event.id, 'a@x.com', [line(tier, 4)])).json();
    expect((await placeHold(t, event.id, 'a@x.com', [line(tier)])).statusCode).toBe(409);
    await releaseHold(t, released.hold.id, released.hold_token);

    const expiring = await placeHold(t, event.id, 'a@x.com', [line(tier, 4)]);
    expect(expiring.statusCode).toBe(201);
    clock.advance(1000);

    const paid = (await placeHold(t, event.id, 'a@x.com', [line(tier, 4)])).json();
    const order = (await payHold(t, paid.hold.id, paid.hold_token)).json();
    expect((await placeHold(t, event.id, 'a@x.com', [line(tier)])).statusCode).toBe(409);
    await refund(t, order.order.id, { ticket_ids: [order.tickets[0].id] });
    expect((await placeHold(t, event.id, 'a@x.com', [line(tier)])).statusCode).toBe(201);
    expect((await placeHold(t, event.id, 'a@x.com', [line(tier)])).statusCode).toBe(409);
  });

  it('is per event, and MAX_TICKETS_PER_BUYER=0 turns it off', async () => {
    const { t, event, tier } = await setup();
    const other = await newEvent(t, { capacity: 10 });
    const otherTier = await newTier(t, other.id, { capacity: 10 });
    await placeHold(t, event.id, 'a@x.com', [line(tier, 4)]);
    expect((await placeHold(t, other.id, 'a@x.com', [line(otherTier, 4)])).statusCode).toBe(201);

    const off = await setup({ MAX_TICKETS_PER_BUYER: '0' });
    expect((await placeHold(off.t, off.event.id, 'a@x.com', [line(off.tier, 10)])).statusCode).toBe(201);
    expect((await placeHold(off.t, off.event.id, 'a@x.com', [line(off.tier, 10)])).statusCode).toBe(201);
  });
});
