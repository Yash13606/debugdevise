import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemp, getEvent, getHold, line, makeApp, newEvent, newTier, payHold, placeHold, sleep } from '../helpers.js';

afterEach(cleanupTemp);

describe('KT2: an unpaid hold frees its seat', () => {
  it('buyer 2 is refused, waits out the TTL, then gets the seat; paying the old hold is 410', async () => {
    // The sweeper is off (HOLD_SWEEP_INTERVAL_MS=0 in makeApp): the next reservation must free the seat itself.
    const t = await makeApp({ HOLD_TTL_SECONDS: '1' });
    const event = await newEvent(t, { capacity: 1 });
    const tier = await newTier(t, event.id, { capacity: 1 });

    const first = await placeHold(t, event.id, 'one@x.com', [line(tier)]);
    expect(first.statusCode).toBe(201);
    const { hold, hold_token } = first.json();

    const early = await placeHold(t, event.id, 'two@x.com', [line(tier)]);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('SOLD_OUT');

    await sleep(1500);

    const retry = await placeHold(t, event.id, 'two@x.com', [line(tier)]);
    expect(retry.statusCode).toBe(201);

    const old = await getHold(t, hold.id, hold_token);
    expect(old.json().hold.status).toBe('EXPIRED');

    const late = await payHold(t, hold.id, hold_token);
    expect(late.statusCode).toBe(410);
    expect(late.json().error.code).toBe('HOLD_EXPIRED');

    // Only buyer 2's hold is left: the freed seat was taken exactly once.
    expect((await getEvent(t, event.id)).event).toMatchObject({ held: 1, sold: 0, available: 0 });
  });
});
