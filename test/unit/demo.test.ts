import { describe, expect, it } from 'vitest';
import { demo } from '../../scripts/demo.js';

describe('npm run demo: the waiting room and the per-buyer cap', () => {
  it('plays the documented outcomes and narrates them', async () => {
    const lines: string[] = [];

    const result = await demo((line) => lines.push(line));

    expect(result).toEqual({
      positions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      admittedByFirstTick: ['q1@x.com', 'q2@x.com', 'q3@x.com'],
      waitingBuyerRefusal: { status: 403, code: 'NOT_ADMITTED', reason: 'WAITING' },
      admittedBuyerStatus: 201,
      admittedBySecondTick: ['q4@x.com', 'q5@x.com', 'q6@x.com'],
      fourthBuyerStatus: 201,
      capRefusal: { status: 409, code: 'BUYER_LIMIT', details: { limit: 4, used: 3, requested: 2 } },
    });
    const text = lines.join('\n');
    expect(text).toContain('NOT_ADMITTED');
    expect(text).toContain('BUYER_LIMIT');
  });
});
