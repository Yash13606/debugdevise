import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setClock } from '../src/clock.js';
import { normalisePhone } from '../src/ids.js';
import { api, makeEnv, type Env } from './helpers.js';

let e: Env;
beforeAll(async () => {
  e = await makeEnv({ RATE_LIMIT: 'true' });
});
afterEach(() => setClock(null));
afterAll(async () => e.close());

const anon = () => api(e.app);
const otp = (phone: string) => anon()('POST', '/api/auth/otp', { phone });

describe('phone numbers', () => {
  it('accepts the usual ways of writing an Indian mobile number', () => {
    for (const raw of ['9876543210', '09876543210', '919876543210', '+91 98765 43210', '+91-98765-43210', '(98765) 43210']) {
      expect(normalisePhone(raw)).toBe('+919876543210');
    }
  });
  it('rejects what is not one', () => {
    for (const raw of ['12345', '5876543210', '98765432101', 'abcdefghij', '', '+1 415 555 0100']) {
      expect(() => normalisePhone(raw), raw).toThrow();
    }
  });
});

describe('the OTP login', () => {
  it('sends a random 6-digit code (shown in demo mode), then signs in and creates the user once', async () => {
    const a = await otp('9811111111');
    expect(a.status).toBe(200);
    expect(a.body.demo_otp).toMatch(/^\d{6}$/);
    const v = await anon()('POST', '/api/auth/verify', { phone: '98111 11111', otp: a.body.demo_otp, name: 'Asha' });
    expect(v.status).toBe(200);
    expect(v.body.is_new).toBe(true);
    expect(v.body.user).toMatchObject({ phone: '+919811111111', name: 'Asha', role: 'BUYER' });
    expect((await api(e.app, v.body.token)('GET', '/api/me')).body.user.id).toBe(v.body.user.id);

    const b = await otp('+91 9811111111');
    const v2 = await anon()('POST', '/api/auth/verify', { phone: '9811111111', otp: b.body.demo_otp });
    expect(v2.body.is_new).toBe(false);
    expect(v2.body.user.id).toBe(v.body.user.id);
    expect((await e.ctx.pool.query('SELECT 1 FROM users WHERE phone = $1', ['+919811111111'])).rowCount).toBe(1);
  });

  it('codes differ between requests and are stored hashed', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) codes.add((await otp(`98222222${10 + i}`)).body.demo_otp);
    expect(codes.size).toBeGreaterThan(1);
    const row = (await e.ctx.pool.query(`SELECT code_hash FROM otp_codes WHERE phone = '+919822222210'`)).rows[0];
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a code works once', async () => {
    const a = await otp('9833333333');
    expect((await anon()('POST', '/api/auth/verify', { phone: '9833333333', otp: a.body.demo_otp })).status).toBe(200);
    expect((await anon()('POST', '/api/auth/verify', { phone: '9833333333', otp: a.body.demo_otp })).body.error.code).toBe('OTP_INVALID');
  });

  it('five wrong tries lock the code, even for the right one', async () => {
    const a = await otp('9844444444');
    const wrong = a.body.demo_otp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await anon()('POST', '/api/auth/verify', { phone: '9844444444', otp: wrong })).body.error.code).toBe('OTP_INVALID');
    const locked = await anon()('POST', '/api/auth/verify', { phone: '9844444444', otp: a.body.demo_otp });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('OTP_LOCKED');
    const fresh = await otp('9844444444'); // a new code resets the tries
    expect((await anon()('POST', '/api/auth/verify', { phone: '9844444444', otp: fresh.body.demo_otp })).status).toBe(200);
  });

  it('a code expires', async () => {
    const a = await otp('9855555555');
    setClock(() => Date.now() + 6 * 60_000);
    expect((await anon()('POST', '/api/auth/verify', { phone: '9855555555', otp: a.body.demo_otp })).body.error.code).toBe('OTP_INVALID');
  });

  it('requesting codes is rate limited per phone, with Retry-After', async () => {
    for (let i = 0; i < 5; i++) expect((await otp('9866666666')).status).toBe(200);
    const sixth = await e.app.inject({ method: 'POST', url: '/api/auth/otp', payload: { phone: '9866666666' } });
    expect(sixth.statusCode).toBe(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(sixth.body).error.code).toBe('RATE_LIMITED');
  });

  it('the message also lands in the demo inbox', async () => {
    const a = await otp('9877777777');
    const v = await anon()('POST', '/api/auth/verify', { phone: '9877777777', otp: a.body.demo_otp });
    const inbox = await api(e.app, v.body.token)('GET', '/api/me/messages');
    expect(inbox.body.messages[0]).toMatchObject({ kind: 'OTP' });
    expect(inbox.body.messages[0].body).toContain(a.body.demo_otp);
  });
});

describe('sessions', () => {
  it('need a real token; logout ends one', async () => {
    expect((await anon()('GET', '/api/me')).status).toBe(401);
    expect((await api(e.app, 'not-a-token')('GET', '/api/me')).status).toBe(401);
    const a = await otp('9888888888');
    const v = await anon()('POST', '/api/auth/verify', { phone: '9888888888', otp: a.body.demo_otp });
    const me = api(e.app, v.body.token);
    expect((await me('GET', '/api/me')).status).toBe(200);
    await me('POST', '/api/auth/logout');
    expect((await me('GET', '/api/me')).status).toBe(401);
  });

  it('expire after their lifetime', async () => {
    const a = await otp('9899999999');
    const v = await anon()('POST', '/api/auth/verify', { phone: '9899999999', otp: a.body.demo_otp });
    setClock(() => Date.now() + 31 * 86_400_000);
    expect((await api(e.app, v.body.token)('GET', '/api/me')).status).toBe(401);
  });
});

describe('DEMO_OTP off', () => {
  it('never puts the code in the response', async () => {
    const quiet = await makeEnv({ DEMO_OTP: 'false' });
    try {
      const a = await api(quiet.app)('POST', '/api/auth/otp', { phone: '9800000000' });
      expect(a.body.demo_otp).toBeUndefined();
      expect(Object.values(a.body).some((v) => /^\d{6}$/.test(String(v)))).toBe(false);
    } finally {
      await quiet.close();
    }
  });
});
