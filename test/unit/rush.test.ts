import { describe, expect, it } from 'vitest';
import { rush } from '../../scripts/rush.js';

describe('the rush simulation', () => {
  it('300 buyers, 250 seats: exactly 250 get a hold, 50 are told sold out, and the invariants hold', async () => {
    const result = await rush(300, 250);

    expect(result).toMatchObject({ buyers: 300, capacity: 250, created: 250, soldOut: 50, other: 0 });
    expect(result.invariants).toEqual({ ok: true, mismatches: [] });
    expect(result.seconds).toBeGreaterThan(0);
  });

  it('more seats than buyers: everyone gets a hold', async () => {
    expect(await rush(40, 100)).toMatchObject({ created: 40, soldOut: 0, other: 0 });
  });
});
