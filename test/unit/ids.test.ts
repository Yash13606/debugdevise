import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import { normaliseEmail, randomId, randomToken, sha256 } from '../../src/ids.js';

describe('ids', () => {
  it('randomId is prefix_ plus 12 lowercase base32 characters, and does not repeat', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = randomId('evt');
      expect(id).toMatch(/^evt_[a-z2-7]{12}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(2000);
  });

  it('randomToken is 128 bits as 22 base64url characters', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('sha256 returns lowercase hex (known vector)', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('normaliseEmail (rule N1)', () => {
  it.each([
    ['  A@G.com ', 'a@g.com'],
    ['a+x@g.com', 'a@g.com'],
    ['a+b+c@x.org', 'a@x.org'],
    ['A.B+tag@Gmail.com', 'ab@gmail.com'],
    ['a.b@googlemail.com', 'ab@googlemail.com'],
    ['a.b@college.edu', 'a.b@college.edu'],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseEmail(input)).toBe(expected);
  });

  it.each(['nope', '@x.com', '+tag@x.com', 'a@', 'a b@x.com', 'a@x', 'a@b@c.com'])(
    'rejects %j as VALIDATION_ERROR',
    (input) => {
      expect(() => normaliseEmail(input)).toThrow(AppError);
      try {
        normaliseEmail(input);
      } catch (e) {
        expect(e).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
      }
    },
  );
});
