import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, expectClean, hold, joinQueue, login, makeEnv, makeEvent, makeOrganiser, phoneOf, type Env, type Person } from './helpers.js';

let e: Env;
let org: Person;
let other: Person;
let buyer: Person;

beforeAll(async () => {
  e = await makeEnv();
  org = await makeOrganiser(e.app, 900);
  other = await makeOrganiser(e.app, 901);
  buyer = await login(e.app, phoneOf(700));
});
afterAll(async () => {
  await expectClean(e);
  await e.close();
});

describe('requests', () => {
  it('bad input is a 400 VALIDATION_ERROR naming the field', async () => {
    const r = await org.call('POST', '/api/organiser/events', { name: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.message).toMatch(/starts_at|tiers/);
    expect((await buyer.call('POST', '/api/events/evt_x/holds', { items: [] })).status).toBe(400);
    const raw = await e.app.inject({ method: 'POST', url: '/api/auth/otp', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(raw.statusCode).toBe(400);
  });

  it('unknown routes are a JSON 404, protected routes need a sign-in', async () => {
    expect((await api(e.app)('GET', '/api/nothing')).body.error.code).toBe('NOT_FOUND');
    for (const [m, u] of [['GET', '/api/orders'], ['POST', '/api/gate/checkin'], ['GET', '/api/organiser/events'], ['GET', '/api/me/messages']] as const) {
      expect((await api(e.app)(m, u)).status, u).toBe(401);
    }
  });

  it('buyers cannot use organiser routes', async () => {
    expect((await buyer.call('GET', '/api/organiser/events')).status).toBe(403);
    expect((await buyer.call('POST', '/api/organiser/events', {})).status).toBe(403);
  });

  it('admin and metrics routes need the admin key', async () => {
    expect((await api(e.app)('POST', '/api/admin/sweep')).status).toBe(401);
    expect((await api(e.app)('GET', '/metrics')).status).toBe(401);
    const key = { 'x-admin-key': e.config.adminApiKey };
    expect((await api(e.app)('POST', '/api/admin/sweep', undefined, key)).body).toHaveProperty('expired');
    expect((await api(e.app)('GET', '/api/admin/invariants', undefined, key)).body.ok).toBe(true);
    const m = await e.app.inject({ method: 'GET', url: '/metrics', headers: key });
    expect(m.body).toContain('http_requests_total');
    expect(m.body).toContain('http_request_duration_ms_count');
  });

  it('health and readiness report the database and Redis', async () => {
    expect((await api(e.app)('GET', '/healthz')).body.ok).toBe(true);
    expect((await api(e.app)('GET', '/readyz')).body).toMatchObject({ ok: true, database: 'up', redis: 'up' });
  });
});

describe('catalogue', () => {
  it('lists events by city, category and search, with live flags', async () => {
    const a = await org.call('POST', '/api/organiser/events', { name: 'Jazz Night', category: 'Music', city: 'Pune', starts_at: new Date(Date.now() + 86_400_000).toISOString(), tiers: [{ name: 'GA', price_paise: 25_000, capacity: 10 }, { name: 'VIP', price_paise: 90_000, capacity: 2 }] });
    const b = await org.call('POST', '/api/organiser/events', { name: 'Laugh Riot', category: 'Comedy', city: 'Pune', starts_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), tiers: [{ name: 'GA', price_paise: 10_000, capacity: 2 }] });
    const list = (q: string) => api(e.app)('GET', `/api/events?${q}`).then((r) => r.body.events as { id: string; name: string; min_price_paise: number; sold_out: boolean; selling_fast: boolean }[]);
    expect((await list('city=Pune')).map((x) => x.name)).toEqual(['Jazz Night', 'Laugh Riot']);
    expect((await list('city=Pune&category=Comedy')).map((x) => x.name)).toEqual(['Laugh Riot']);
    expect((await list('q=jazz')).map((x) => x.name)).toEqual(['Jazz Night']);
    expect((await list('city=Delhi'))).toEqual([]);
    expect((await list('city=Pune'))[0]!.min_price_paise).toBe(25_000);
    const ev = await api(e.app)('GET', `/api/events/${b.body.event.id}`);
    await hold(buyer, ev.body.event.id, [{ tier_id: ev.body.tiers[0].id, quantity: 2 }]);
    const after = (await list('category=Comedy'))[0]!;
    expect(after.sold_out).toBe(true);
    expect(a.status).toBe(201);
  });

  it('draft and cancelled events are hidden and refuse holds', async () => {
    const d = await org.call('POST', '/api/organiser/events', { name: 'Secret Draft', publish: false, starts_at: new Date(Date.now() + 86_400_000).toISOString(), tiers: [{ name: 'GA', price_paise: 100, capacity: 5 }] });
    expect((await api(e.app)('GET', '/api/events?q=Secret')).body.events).toEqual([]);
    const tier = (await api(e.app)('GET', `/api/events/${d.body.event.id}`)).body.tiers[0].id;
    expect((await hold(buyer, d.body.event.id, [{ tier_id: tier, quantity: 1 }])).body.error.code).toBe('EVENT_NOT_ON_SALE');
    expect((await org.call('PATCH', `/api/organiser/events/${d.body.event.id}`, { status: 'PUBLISHED' })).body.event.status).toBe('PUBLISHED');
    expect((await hold(buyer, d.body.event.id, [{ tier_id: tier, quantity: 1 }])).status).toBe(201);
    expect((await org.call('PATCH', `/api/organiser/events/${d.body.event.id}`, { status: 'CANCELLED' })).body.event.status).toBe('CANCELLED');
    expect((await hold(buyer, d.body.event.id, [{ tier_id: tier, quantity: 1 }])).body.error.code).toBe('EVENT_NOT_ON_SALE');
    expect((await org.call('PATCH', `/api/organiser/events/${d.body.event.id}`, { status: 'PUBLISHED' })).status).toBe(409); // never back on sale
  });
});

describe('organiser', () => {
  it("only the organiser can see or change their event; others get 404", async () => {
    const ev = await makeEvent(org);
    for (const [m, u, b] of [
      ['GET', `/api/organiser/events/${ev.id}`],
      ['PATCH', `/api/organiser/events/${ev.id}`, { queue_enabled: true }],
      ['POST', `/api/organiser/events/${ev.id}/tiers`, { name: 'X', price_paise: 1, capacity: 1 }],
      ['POST', `/api/organiser/events/${ev.id}/promo-codes`, { code: 'X', kind: 'FIXED', value: 1 }],
      ['POST', `/api/organiser/events/${ev.id}/staff`, { phone: phoneOf(5) }],
      ['GET', `/api/organiser/events/${ev.id}/settlement`],
    ] as const) {
      expect((await other.call(m, u, b)).status, u).toBe(404);
    }
    expect((await other.call('GET', '/api/organiser/events')).body.events).not.toContainEqual(expect.objectContaining({ id: ev.id }));
  });

  it('creates a seated tier with labelled seats and a general tier together', async () => {
    const ev = await makeEvent(org, { tiers: [{ name: 'Stalls', seated: { rows: 3, seats_per_row: 4 } }, { name: 'Standing', capacity: 5 }] });
    const view = (await api(e.app)('GET', `/api/events/${ev.id}`)).body;
    expect(view.event.capacity).toBe(17);
    expect(view.tiers[0]).toMatchObject({ seated: true, capacity: 12 });
    const seats = (await api(e.app)('GET', `/api/events/${ev.id}/seats`)).body.tiers[ev.tiers[0]!.id] as { row: string; no: number }[];
    expect(seats).toHaveLength(12);
    expect(seats.map((s) => `${s.row}${s.no}`).slice(0, 5)).toEqual(['A1', 'A2', 'A3', 'A4', 'B1']);
  });

  it('seated holds need seat ids; the chosen seats are named on the hold', async () => {
    const ev = await makeEvent(org, { tiers: [{ seated: { rows: 1, seats_per_row: 5 } }] });
    const seats = (await api(e.app)('GET', `/api/events/${ev.id}/seats`)).body.tiers[ev.tiers[0]!.id] as { id: string }[];
    expect((await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 2 }])).status).toBe(400);
    const h = await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, seat_ids: [seats[3]!.id, seats[1]!.id] }]);
    expect(h.status).toBe(201);
    expect(h.body.hold.seats).toEqual(['A2', 'A4']);
    expect((await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, seat_ids: ['seat_missing'] }])).status).toBe(404);
  });

  it('adding a tier later grows the pool; the new tier is sellable at once', async () => {
    const ev = await makeEvent(org, { tiers: [{ capacity: 2 }] });
    expect((await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 2 }])).status).toBe(201);
    const added = await org.call('POST', `/api/organiser/events/${ev.id}/tiers`, { name: 'Late release', price_paise: 5_000, capacity: 3 });
    expect(added.status).toBe(201);
    expect((await api(e.app)('GET', `/api/events/${ev.id}`)).body.event.available).toBe(3);
    expect((await hold(await login(e.app, phoneOf(701)), ev.id, [{ tier_id: added.body.tier.id, quantity: 3 }])).status).toBe(201);
  });

  it('duplicate promo codes are refused; stats show the audit', async () => {
    const ev = await makeEvent(org);
    expect((await org.call('POST', `/api/organiser/events/${ev.id}/promo-codes`, { code: 'Hello', kind: 'FIXED', value: 5 })).status).toBe(201);
    expect((await org.call('POST', `/api/organiser/events/${ev.id}/promo-codes`, { code: 'hello', kind: 'FIXED', value: 5 })).body.error.code).toBe('PROMO_EXISTS');
    const stats = await org.call('GET', `/api/organiser/events/${ev.id}`);
    expect(stats.body).toMatchObject({ invariants: { ok: true }, money: { orders: 0 }, holds: { ACTIVE: 0 } });
  });

  it('turning the waiting room on takes effect for the next hold', async () => {
    const ev = await makeEvent(org);
    expect((await hold(buyer, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])).status).toBe(201);
    await org.call('PATCH', `/api/organiser/events/${ev.id}`, { queue_enabled: true });
    const second = await login(e.app, phoneOf(702));
    expect((await hold(second, ev.id, [{ tier_id: ev.tiers[0]!.id, quantity: 1 }])).body.error.code).toBe('NOT_ADMITTED');
  });
});

describe('live queue updates (server-sent events)', () => {
  it('streams the buyer\'s place over a real connection', async () => {
    const ev = await makeEvent(org, { queue_enabled: true });
    await joinQueue(buyer, ev.id);
    await e.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (e.app.server.address() as { port: number }).port;
    const ctl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/events/${ev.id}/queue/stream?access_token=${buyer.token}`, { signal: ctl.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const first = new TextDecoder().decode((await res.body!.getReader().read()).value);
      expect(first.startsWith('data: ')).toBe(true);
      expect(JSON.parse(first.slice(6))).toMatchObject({ status: 'WAITING', position: 1 });
      const bad = await fetch(`http://127.0.0.1:${port}/api/events/${ev.id}/queue/stream?access_token=nope`);
      expect(bad.status).toBe(401);
    } finally {
      ctl.abort();
    }
  });
});
