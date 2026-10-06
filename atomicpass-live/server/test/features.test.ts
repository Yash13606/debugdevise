import { createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeQrKeys, signTicket } from '../src/qr.js';
import { remindExpiring } from '../src/waitlist.js';
import { expectClean, hold, joinQueue, login, makeEnv, makeEvent, makeOrganiser, pay, phoneOf, solvePow, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
let buyers: Person[];

beforeAll(async () => {
  e = await makeEnv({ HOLD_TTL_SECONDS: '60', REMINDER_LEAD_SECONDS: '120' });
  org = await makeOrganiser(e.app);
  buyers = await Promise.all(Array.from({ length: 6 }, (_, i) => login(e.app, phoneOf(1000 + i))));
});
afterAll(async () => {
  await expectClean(e);
  await e.close();
});

/** Buy n tickets and return the event and the signed QR codes. */
async function bought(n = 1, who = buyers[0]!, ev?: Awaited<ReturnType<typeof makeEvent>>) {
  const event = ev ?? (await makeEvent(org, { tiers: [{ name: 'Gold', capacity: 20 }] }));
  const h = await hold(who, event.id, [{ tier_id: event.tiers[0]!.id, quantity: n }]);
  const orderId = (await pay(e, who, h.body.hold.id))!;
  const tickets = (await who.call('GET', `/api/orders/${orderId}`)).body.order.tickets as { id: string; qr_payload: string }[];
  return { event, orderId, tickets };
}
const scan = (p: Person, eventId: string, qr: string, extra: Record<string, unknown> = {}) => p.call('POST', '/api/gate/checkin', { qr, event_id: eventId, ...extra });

describe('signed tickets and offline scanning', () => {
  it('a gate device holding only the public key can verify a ticket with no network', async () => {
    const { event, tickets } = await bought(1);
    const key = await org.call('GET', `/api/gate/events/${event.id}/verify-key`);
    expect(key.body).toMatchObject({ algorithm: 'Ed25519', public_key: e.ctx.qr.publicKey });

    // what the scanner's own code does: nothing but the public key and the QR text
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key.body.public_key, 'base64url')]);
    const pub = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const [body, sig] = tickets[0]!.qr_payload.slice(4).split('.') as [string, string];
    expect(verify(null, Buffer.from(body), pub, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toMatchObject({ t: tickets[0]!.id, e: event.id, n: 'Gold' });
    const tampered = Buffer.from(body, 'base64url').toString().replace('Gold', 'VIP!');
    expect(verify(null, Buffer.from(Buffer.from(tampered).toString('base64url')), pub, Buffer.from(sig, 'base64url'))).toBe(false);
  });

  it('only the gate team can fetch the key', async () => {
    const ev = await makeEvent(org);
    expect((await buyers[1]!.call('GET', `/api/gate/events/${ev.id}/verify-key`)).status).toBe(403);
  });

  it('refuses forged, edited and foreign-key tickets, and tickets for another event', async () => {
    const a = await bought(1);
    const b = await bought(1);
    const real = a.tickets[0]!.qr_payload;
    const [body, sig] = real.slice(4).split('.') as [string, string];
    const forgedKey = makeQrKeys('some-other-seed');
    const stranger = signTicket(forgedKey, { t: a.tickets[0]!.id, e: a.event.id, n: 'Gold', s: null });
    const edited = `AP2:${Buffer.from(JSON.stringify({ t: b.tickets[0]!.id, e: a.event.id, n: 'Gold', s: null })).toString('base64url')}.${sig}`;
    for (const bad of [stranger, edited, `AP2:${body}.${sig.slice(0, -4)}AAAA`, 'AP2:', 'AP2:nodot']) {
      expect((await scan(org, a.event.id, bad)).body.error.code, bad.slice(0, 30)).toBe('INVALID_QR');
    }
    expect((await scan(org, a.event.id, b.tickets[0]!.qr_payload)).body.error.code).toBe('WRONG_EVENT');
    expect((await scan(org, a.event.id, real)).body.result).toBe('ADMITTED'); // none of that used the real ticket up
    expect((await scan(org, a.event.id, real)).body.error.code).toBe('ALREADY_CHECKED_IN');
  });

  it('a refunded ticket refuses at the gate even though its signature is genuine', async () => {
    const { event, orderId, tickets } = await bought(1);
    await org.call('POST', `/api/organiser/orders/${orderId}/refund`, {});
    expect((await scan(org, event.id, tickets[0]!.qr_payload)).body.error.code).toBe('TICKET_VOID');
  });

  it('older plain-token codes still work', async () => {
    const { event, tickets } = await bought(1);
    const row = (await e.ctx.pool.query('SELECT qr_token FROM tickets WHERE id = $1', [tickets[0]!.id])).rows[0];
    expect((await scan(org, event.id, `AP1:${row.qr_token}`)).body.result).toBe('ADMITTED');
  });

  it('scans made offline sync later with the time they were made; double entries are found, not hidden', async () => {
    const { event, tickets } = await bought(3);
    const staff = await login(e.app, phoneOf(1100), 'Second Gate');
    await org.call('POST', `/api/organiser/events/${event.id}/staff`, { phone: phoneOf(1100) });
    const t1 = Date.now() - 600_000;
    const t2 = Date.now() - 300_000;

    // device A was offline and admitted tickets 0 and 1; device B, also offline, admitted ticket 1 as well
    const a = await org.call('POST', '/api/gate/checkin/batch', { event_id: event.id, scans: [{ qr: tickets[0]!.qr_payload, at: t1, gate: 'A' }, { qr: tickets[1]!.qr_payload, at: t1 + 1000, gate: 'A' }, { qr: 'AP2:forged.zzz', at: t1 }] });
    expect(a.body.results.map((r: { code: string }) => r.code)).toEqual(['ADMITTED', 'ADMITTED', 'INVALID_QR']);
    const b = await staff.call('POST', '/api/gate/checkin/batch', { event_id: event.id, scans: [{ qr: tickets[1]!.qr_payload, at: t2, gate: 'B' }, { qr: tickets[2]!.qr_payload, at: t2 + 1000, gate: 'B' }] });
    expect(b.body.results.map((r: { code: string }) => r.code)).toEqual(['ALREADY_CHECKED_IN', 'ADMITTED']);
    expect(b.body).toMatchObject({ admitted: 1, refused: 1 });

    const row = (await e.ctx.pool.query('SELECT checked_in_at FROM tickets WHERE id = $1', [tickets[0]!.id])).rows[0];
    expect(row.checked_in_at).toBe(t1); // the device's time, not the sync time
    const future = await org.call('POST', '/api/gate/checkin/batch', { event_id: event.id, scans: [{ qr: (await bought(1, buyers[2]!, event)).tickets[0]!.qr_payload, at: Date.now() + 9e9 }] });
    expect(future.status).toBe(200); // a wrong device clock is clamped, not trusted
    expect((await e.ctx.pool.query(`SELECT MAX(checked_in_at) AS m FROM tickets WHERE event_id = $1`, [event.id])).rows[0].m).toBeLessThanOrEqual(Date.now());

    expect((await buyers[3]!.call('POST', '/api/gate/checkin/batch', { event_id: event.id, scans: [{ qr: tickets[0]!.qr_payload }] })).status).toBe(403);
    await expectClean(e);
  });
});

describe('the join challenge (bot protection)', () => {
  it('needs a solved, fresh, personal challenge', async () => {
    const ev = await makeEvent(org, { queue_enabled: true });
    const [a, b] = [buyers[0]!, buyers[1]!];
    const none = await a.call('POST', `/api/events/${ev.id}/queue`, {});
    expect(none.status).toBe(428);
    expect(none.body.error.code).toBe('POW_REQUIRED');
    expect(none.body.error.details).toMatchObject({ reason: 'MISSING', bits: 12 });

    const c = (await a.call('GET', `/api/events/${ev.id}/queue/challenge`)).body;
    const wrong = await a.call('POST', `/api/events/${ev.id}/queue`, { pow: { challenge: c.challenge, nonce: 'x'.repeat(5) } });
    expect(wrong.body.error.details.reason).toBe('WRONG');

    const nonce = solvePow(c.challenge, c.bits);
    expect((await b.call('POST', `/api/events/${ev.id}/queue`, { pow: { challenge: c.challenge, nonce } })).body.error.details.reason).toBe('INVALID'); // someone else's
    const ok = await a.call('POST', `/api/events/${ev.id}/queue`, { pow: { challenge: c.challenge, nonce } });
    expect(ok.status).toBe(201);
    const replay = await a.call('POST', `/api/events/${ev.id}/queue`, { pow: { challenge: c.challenge, nonce } });
    expect(replay.body.error.details.reason).toBe('USED'); // a solved challenge works once
    expect((await joinQueue(b, ev.id)).status).toBe(201); // the normal path
  });

  it('can be switched off', async () => {
    const open = await makeEnv({ JOIN_POW_BITS: '0' });
    try {
      const o = await makeOrganiser(open.app);
      const ev = await makeEvent(o, { queue_enabled: true });
      const p = await login(open.app, phoneOf(1200));
      expect((await p.call('POST', `/api/events/${ev.id}/queue`, {})).status).toBe(201);
    } finally {
      await open.close();
    }
  });
});

describe('waitlist and reminders', () => {
  const messages = async (p: Person) => (await p.call('GET', '/api/me/messages')).body.messages as { kind: string; body: string }[];

  it('a waiting buyer is told when a seat frees up, in order, one per seat', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 1 }] });
    const [holder, first, second] = [buyers[0]!, buyers[1]!, buyers[2]!];
    expect((await first.call('POST', `/api/events/${ev.id}/waitlist`)).body.error.code).toBe('NOT_SOLD_OUT');
    const h = await hold(holder, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }]);
    expect((await first.call('POST', `/api/events/${ev.id}/waitlist`)).body).toMatchObject({ joined: true, position: 1 });
    expect((await second.call('POST', `/api/events/${ev.id}/waitlist`)).body.position).toBe(2);

    await holder.call('DELETE', `/api/holds/${h.body.hold.id}`);
    expect((await messages(first)).some((m) => m.kind === 'WAITLIST')).toBe(true);
    expect((await messages(second)).some((m) => m.kind === 'WAITLIST')).toBe(false); // one seat, one message
    const stats = await org.call('GET', `/api/organiser/events/${ev.id}`);
    expect(stats.body.waitlist.waiting).toBe(1);
  });

  it('a refund also tells the waitlist', async () => {
    const { event, orderId } = await bought(1, buyers[3]!, await makeEvent(org, { tiers: [{ capacity: 1 }] }));
    await buyers[4]!.call('POST', `/api/events/${event.id}/waitlist`);
    await buyers[3]!.call('POST', `/api/orders/${orderId}/cancel`);
    expect((await messages(buyers[4]!)).some((m) => m.kind === 'WAITLIST')).toBe(true);
  });

  it('an unpaid hold gets one reminder before it expires, and a paying one gets none', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 5 }] });
    const [waiting, paying] = [buyers[5]!, buyers[1]!];
    const w = await hold(waiting, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }]);
    const pr = await hold(paying, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }]);
    await paying.call('POST', `/api/holds/${pr.body.hold.id}/checkout`);
    expect(w.status).toBe(201);
    expect(await remindExpiring(e.ctx)).toBeGreaterThanOrEqual(1);
    expect(await remindExpiring(e.ctx)).toBe(0); // only once
    const mine = (await messages(waiting)).filter((m) => m.kind === 'HOLD_REMINDER');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.body).toContain('held for about');
    expect((await messages(paying)).filter((m) => m.kind === 'HOLD_REMINDER' && m.body.includes(ev.id))).toHaveLength(0);
  });
});

describe('gate team and the live dashboard', () => {
  it('removing someone from the gate team stops their scans on the very next scan, and the report shows who scanned', async () => {
    const { event, tickets } = await bought(2, buyers[2]!);
    const guard = await login(e.app, phoneOf(1300), 'Guard Dev');
    await org.call('POST', `/api/organiser/events/${event.id}/staff`, { phone: phoneOf(1300) });
    expect((await scan(guard, event.id, tickets[0]!.qr_payload)).body.result).toBe('ADMITTED');
    const left = await org.call('DELETE', `/api/organiser/events/${event.id}/staff/${phoneOf(1300)}`);
    expect(left.body.staff).toEqual([]);
    expect((await scan(guard, event.id, tickets[1]!.qr_payload)).status).toBe(403); // the same login, now refused
    expect((await guard.call('GET', `/api/gate/events/${event.id}/summary`)).status).toBe(403);

    expect((await scan(org, event.id, 'AP1:nope')).status).toBe(404);
    const report = (await org.call('GET', `/api/organiser/events/${event.id}/scan-report`)).body.staff as { name: string; admitted: number; refused: number }[];
    expect(report.find((r) => r.name === 'Guard Dev')).toMatchObject({ admitted: 1, refused: 0 });
    expect(report.find((r) => r.name === 'Organiser')).toMatchObject({ admitted: 0, refused: 1 });
    expect((await buyers[0]!.call('GET', `/api/organiser/events/${event.id}/scan-report`)).status).toBe(403);
  });

  it('the dashboard feed has a 30-minute timeline of holds and orders', async () => {
    const { event } = await bought(2, buyers[4]!);
    const stats = (await org.call('GET', `/api/organiser/events/${event.id}`)).body;
    expect(stats.timeline).toHaveLength(30);
    const last = stats.timeline.slice(-2);
    expect(last.reduce((s: number, m: { holds: number }) => s + m.holds, 0)).toBe(1);
    expect(last.reduce((s: number, m: { orders: number }) => s + m.orders, 0)).toBe(1);
    expect(stats.timeline.every((m: { t: string }) => /^\d{4}-/.test(m.t))).toBe(true);
  });
});
