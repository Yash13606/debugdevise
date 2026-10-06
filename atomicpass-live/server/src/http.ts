// Routes, auth, validation and error mapping. No SQL and no business rules here.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import QRCode from 'qrcode';
import { z, ZodError } from 'zod';
import { canScan } from './access.js';
import * as auth from './auth.js';
import { CATEGORIES, CITIES, eventView, listEvents, seatMap } from './catalog.js';
import { iso, now } from './clock.js';
import type { Ctx } from './db.js';
import { AppError } from './errors.js';
import * as holds from './holds.js';
import { safeEqual } from './ids.js';
import { checkInvariants } from './invariants.js';
import * as notify from './notify.js';
import * as organiser from './organiser.js';
import * as payments from './payments/service.js';
import type { SimulatedProvider } from './payments/simulated.js';
import { issueChallenge, requirePow } from './pow.js';
import * as queue from './queue.js';
import { limit } from './ratelimit.js';
import * as tickets from './tickets.js';
import * as waitlist from './waitlist.js';

const id = z.string().min(1).max(64);
const isoTime = z.string().min(10).max(40);
const tierBody = z.object({
  name: z.string().min(1).max(200),
  price_paise: z.number().int().min(0).max(100_000_000),
  capacity: z.number().int().min(1).max(1_000_000).optional(),
  max_per_order: z.number().int().min(1).max(1000).optional(),
  sale_starts_at: isoTime.nullish(),
  sale_ends_at: isoTime.nullish(),
  seated: z.object({ rows: z.number().int().min(1).max(50), seats_per_row: z.number().int().min(1).max(100) }).optional(),
});
const eventBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  category: z.enum(CATEGORIES).optional(),
  city: z.enum(CITIES).optional(),
  venue: z.string().max(200).optional(),
  address: z.string().max(400).optional(),
  banner: z.string().regex(/^#[0-9a-fA-F]{6},#[0-9a-fA-F]{6}$/).optional(),
  starts_at: isoTime,
  capacity: z.number().int().min(1).max(1_000_000).optional(),
  queue_enabled: z.boolean().optional(),
  publish: z.boolean().optional(),
  tiers: z.array(tierBody).min(1).max(10),
});
const holdBody = z.object({
  items: z.array(z.object({ tier_id: id, quantity: z.number().int().min(1).max(1000).optional(), seat_ids: z.array(id).min(1).max(50).optional() })).min(1).max(20),
  promo_code: z.string().min(1).max(64).nullish(),
  queue_pass: z.string().max(600).optional(),
});
const promoBody = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  kind: z.enum(['PERCENT', 'FIXED']),
  value: z.number().int().min(1).max(1_000_000_000),
  max_uses: z.number().int().min(1).max(1_000_000_000).nullish(),
  valid_from: isoTime.nullish(),
  valid_to: isoTime.nullish(),
  tier_id: id.nullish(),
});

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw new AppError('VALIDATION_ERROR', 400, `${i.path.join('.') || 'body'}: ${i.message}`);
  }
  return r.data;
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : undefined;
};

export function buildApp(ctx: Ctx): FastifyInstance {
  const { config } = ctx;
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy, bodyLimit: 256 * 1024 });

  // JSON bodies are parsed from the exact text, which is kept: the webhook signature covers the raw bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = (body as string).trim();
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('VALIDATION_ERROR', 400, 'Request body is not valid JSON'));
    }
  });
  app.addHook('preValidation', async (req) => {
    if (req.body === undefined) req.body = {};
  });

  app.addHook('onRequest', async (req) => {
    (req as FastifyRequest & { t0?: number }).t0 = performance.now();
  });
  app.addHook('onResponse', async (req, reply) => {
    const t0 = (req as FastifyRequest & { t0?: number }).t0;
    if (t0 !== undefined && req.url.startsWith('/api/')) ctx.metrics.observeRequest(performance.now() - t0);
    ctx.metrics.inc('http_requests_total', { status: `${Math.floor(reply.statusCode / 100)}xx` });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const error = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
      if (err.code === 'RATE_LIMITED') reply.header('retry-after', String(err.details?.retry_after_seconds ?? 1));
      return reply.code(err.status).send({ error });
    }
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: err.issues[0]?.message ?? 'Invalid request' } });
    const e = err as Error & { statusCode?: number; code?: string };
    const status = e.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
  });

  const webDist = new URL('../../web/dist/', import.meta.url);
  const hasWeb = existsSync(webDist);
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
  if (hasWeb) void app.register(fastifyStatic, { root: fileURLToPath(webDist), wildcard: false });

  // ---- helpers ----
  const user = async (req: FastifyRequest, token = bearer(req)): Promise<auth.User> => {
    const u = await auth.authenticate(ctx, token);
    if (!u) throw new AppError('UNAUTHORIZED', 401, 'Please sign in');
    return u;
  };
  const organiserUser = async (req: FastifyRequest) => {
    const u = await user(req);
    if (u.role !== 'ORGANISER') throw new AppError('FORBIDDEN', 403, 'This needs an organiser account');
    return u;
  };
  const adminOnly = async (req: FastifyRequest) => {
    const given = req.headers['x-admin-key'];
    if (typeof given !== 'string' || !safeEqual(given, config.adminApiKey)) throw new AppError('UNAUTHORIZED', 401, 'Missing or invalid admin key');
  };
  const params = <T extends z.ZodRawShape>(req: FastifyRequest, shape: T) => parse(z.object(shape), req.params);

  // Per-IP ceiling on the whole API (the webhook and the demo gateway are exempt).
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/webhooks') && !req.url.startsWith('/api/sim-gateway')) {
      await limit(ctx, 'api-ip', req.ip, 1200, 60);
    }
  });

  // ---- health and metrics ----
  app.get('/healthz', async () => ({ ok: true, time: iso(now()) }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.pool.query('SELECT 1');
      const redis = await ctx.redis.ping().then(() => 'up', () => 'down');
      return { ok: true, database: 'up', redis };
    } catch {
      return reply.code(503).send({ ok: false, database: 'down' });
    }
  });
  app.get('/metrics', { onRequest: adminOnly }, async (_req, reply) => reply.type('text/plain; version=0.0.4').send(ctx.metrics.render()));

  // ---- auth ----
  app.post('/api/auth/otp', async (req) => auth.requestOtp(ctx, parse(z.object({ phone: z.string().min(5).max(20) }), req.body).phone, req.ip));
  app.post('/api/auth/verify', async (req) => {
    const b = parse(z.object({ phone: z.string().min(5).max(20), otp: z.string().regex(/^\d{6}$/), name: z.string().max(80).optional() }), req.body);
    return auth.verifyOtp(ctx, b.phone, b.otp, b.name);
  });
  app.post('/api/auth/logout', async (req) => {
    await user(req);
    await auth.logout(ctx, bearer(req)!);
    return { ok: true };
  });
  app.get('/api/me', async (req) => ({ user: auth.userJson(await user(req)) }));
  app.patch('/api/me', async (req) => ({ user: await auth.updateProfile(ctx, (await user(req)).id, parse(z.object({ name: z.string().max(80).optional() }), req.body)) }));
  app.post('/api/me/organiser', async (req) => ({ user: await auth.becomeOrganiser(ctx, (await user(req)).id, parse(z.object({ org_name: z.string().min(1).max(120) }), req.body).org_name) }));
  app.get('/api/me/messages', async (req) => ({ messages: await notify.inbox(ctx, (await user(req)).phone) }));

  // ---- catalogue ----
  app.get('/api/meta', async () => ({ cities: CITIES, categories: CATEGORIES, currency: config.currency, hold_seconds: config.holdTtlSeconds }));
  app.get('/api/events', async (req) => {
    const q = parse(z.object({ city: z.string().max(40).optional(), category: z.string().max(40).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional() }), req.query);
    return listEvents(ctx, q);
  });
  app.get('/api/events/:eventId', async (req) => eventView(ctx, params(req, { eventId: id }).eventId));
  app.get('/api/events/:eventId/seats', async (req) => seatMap(ctx, params(req, { eventId: id }).eventId));

  // ---- waiting room ----
  app.post('/api/events/:eventId/queue', async (req, reply) => {
    const u = await user(req);
    await limit(ctx, 'queue-join', u.id, 10, 60);
    const { eventId } = params(req, { eventId: id });
    await requirePow(ctx, u.id, eventId, parse(z.object({ pow: z.object({ challenge: z.string().max(600), nonce: z.union([z.string().max(40), z.number()]).transform(String) }).optional() }), req.body).pow);
    const { created, ...entry } = await queue.join(ctx, u.id, eventId);
    return reply.code(created ? 201 : 200).send(entry);
  });
  app.get('/api/events/:eventId/queue/challenge', async (req) => issueChallenge(ctx, (await user(req)).id, params(req, { eventId: id }).eventId));
  app.post('/api/events/:eventId/waitlist', async (req) => {
    const u = await user(req);
    await limit(ctx, 'waitlist', u.id, 10, 60);
    return waitlist.join(ctx, u.id, params(req, { eventId: id }).eventId);
  });
  app.get('/api/events/:eventId/queue', async (req) => queue.status(ctx, (await user(req)).id, params(req, { eventId: id }).eventId));
  // Server-sent events: the page cannot set headers on EventSource, so the token may come in the query string here only.
  app.get('/api/events/:eventId/queue/stream', async (req, reply) => {
    const { eventId } = params(req, { eventId: id });
    const u = await user(req, parse(z.object({ access_token: z.string().max(200) }), req.query).access_token);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let open = true;
    const send = async () => {
      if (!open) return;
      try {
        res.write(`data: ${JSON.stringify(await queue.status(ctx, u.id, eventId))}\n\n`);
      } catch (e) {
        res.write(`event: problem\ndata: ${JSON.stringify({ code: e instanceof AppError ? e.code : 'INTERNAL' })}\n\n`);
      }
    };
    await send();
    const timer = setInterval(send, 1500);
    const stop = setTimeout(() => res.end(), 15 * 60_000);
    req.raw.on('close', () => {
      open = false;
      clearInterval(timer);
      clearTimeout(stop);
    });
  });

  // ---- holds and checkout ----
  app.post('/api/events/:eventId/holds', async (req, reply) => {
    const u = await user(req);
    await limit(ctx, 'hold', u.id, 30, 60);
    const body = parse(holdBody, req.body);
    const pass = body.queue_pass ?? (typeof req.headers['x-queue-pass'] === 'string' ? req.headers['x-queue-pass'] : undefined);
    return reply.code(201).send(await holds.createHold(ctx, u.id, params(req, { eventId: id }).eventId, { ...body, queue_pass: pass }));
  });
  app.get('/api/holds/:holdId', async (req) => holds.getHold(ctx, (await user(req)).id, params(req, { holdId: id }).holdId));
  app.delete('/api/holds/:holdId', async (req) => holds.releaseHold(ctx, (await user(req)).id, params(req, { holdId: id }).holdId));
  app.post('/api/holds/:holdId/checkout', async (req, reply) => {
    const u = await user(req);
    await limit(ctx, 'checkout', u.id, 30, 60);
    const out = await payments.startCheckout(ctx, u.id, params(req, { holdId: id }).holdId);
    return reply.code(out.replay ? 200 : 201).send(out);
  });

  // ---- payments: the gateway's webhook, and the demo gateway's own "pay" screen ----
  app.post('/api/webhooks/payments', async (req) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    return payments.handleWebhook(ctx, raw, headers);
  });
  app.post('/api/sim-gateway/orders/:providerOrderId/pay', async (req) => {
    if (ctx.provider.name !== 'simulated') throw new AppError('NOT_FOUND', 404, 'Route not found');
    const { providerOrderId } = params(req, { providerOrderId: id });
    const b = parse(z.object({ outcome: z.enum(['success', 'failure']), delay_ms: z.number().int().min(0).max(30_000).optional(), duplicate: z.boolean().optional() }), req.body);
    const sim = ctx.provider as SimulatedProvider;
    const hook = await sim.settle(providerOrderId, b.outcome);
    if (!hook) throw new AppError('ALREADY_SETTLED', 409, 'That payment was already completed');
    const deliver = () =>
      app.inject({ method: 'POST', url: '/api/webhooks/payments', headers: hook.headers, payload: hook.rawBody }).then((r) => r.statusCode);
    if (!b.delay_ms) {
      await deliver();
      if (b.duplicate) await deliver();
    } else {
      // Pretend the gateway is slow: the webhook arrives later, perhaps after the hold has expired.
      setTimeout(() => void deliver().then(() => (b.duplicate ? deliver() : undefined)).catch(() => {}), b.delay_ms).unref();
    }
    return { ok: true, outcome: b.outcome, webhook: b.delay_ms ? `scheduled in ${b.delay_ms} ms` : 'delivered' };
  });

  // ---- orders and tickets ----
  app.get('/api/orders', async (req) => tickets.listOrders(ctx, (await user(req)).id));
  app.get('/api/orders/:orderId', async (req) => tickets.getOrder(ctx, (await user(req)).id, params(req, { orderId: id }).orderId));
  app.post('/api/orders/:orderId/cancel', async (req) => {
    const u = await user(req);
    return tickets.refundOrder(ctx, params(req, { orderId: id }).orderId, { kind: 'BUYER_CANCEL', ownerUserId: u.id });
  });
  app.get('/api/tickets/:ticketId/qr.svg', async (req, reply) => {
    const payload = await tickets.ticketQr(ctx, (await user(req)).id, params(req, { ticketId: id }).ticketId);
    return reply.type('image/svg+xml').send(await QRCode.toString(payload, { type: 'svg', margin: 2 }));
  });

  // ---- gate ----
  app.get('/api/gate/events', async (req) => organiser.gateEvents(ctx, await user(req)));
  app.post('/api/gate/checkin', async (req) => {
    const u = await user(req);
    return tickets.checkIn(ctx, u, parse(z.object({ qr: z.string().min(1).max(600), event_id: id, gate: z.string().min(1).max(64).optional(), at: z.number().int().optional() }), req.body));
  });
  app.post('/api/gate/checkin/batch', async (req) => {
    const u = await user(req);
    return tickets.checkInBatch(ctx, u, parse(z.object({ event_id: id, scans: z.array(z.object({ qr: z.string().min(1).max(600), at: z.number().int().optional(), gate: z.string().min(1).max(64).optional() })).min(1).max(500) }), req.body));
  });
  app.get('/api/gate/events/:eventId/verify-key', async (req) => {
    const u = await user(req);
    const { eventId } = params(req, { eventId: id });
    if (!(await canScan(ctx.pool, u.id, eventId))) throw new AppError('FORBIDDEN', 403, 'You are not on the gate team for this event');
    return { algorithm: 'Ed25519', public_key: ctx.qr.publicKey, event_id: eventId };
  });
  app.get('/api/gate/events/:eventId/summary', async (req) => {
    const u = await user(req);
    const { eventId } = params(req, { eventId: id });
    if (!(await canScan(ctx.pool, u.id, eventId))) throw new AppError('FORBIDDEN', 403, 'You are not on the gate team for this event');
    return tickets.gateSummary(ctx, eventId);
  });

  // ---- organiser ----
  app.post('/api/organiser/events', async (req, reply) => reply.code(201).send(await organiser.createEvent(ctx, await organiserUser(req), parse(eventBody, req.body))));
  app.get('/api/organiser/events', async (req) => organiser.listMine(ctx, await organiserUser(req)));
  app.get('/api/organiser/events/:eventId', async (req) => organiser.eventStats(ctx, await organiserUser(req), params(req, { eventId: id }).eventId));
  app.patch('/api/organiser/events/:eventId', async (req) =>
    organiser.patchEvent(ctx, await organiserUser(req), params(req, { eventId: id }).eventId, parse(z.object({ queue_enabled: z.boolean().optional(), status: z.enum(['PUBLISHED', 'CANCELLED']).optional() }), req.body)),
  );
  app.post('/api/organiser/events/:eventId/tiers', async (req, reply) => reply.code(201).send(await organiser.addTier(ctx, await organiserUser(req), params(req, { eventId: id }).eventId, parse(tierBody, req.body))));
  app.post('/api/organiser/events/:eventId/promo-codes', async (req, reply) => reply.code(201).send(await organiser.createPromo(ctx, await organiserUser(req), params(req, { eventId: id }).eventId, parse(promoBody, req.body))));
  app.get('/api/organiser/events/:eventId/staff', async (req) => organiser.listStaff(ctx, await organiserUser(req), params(req, { eventId: id }).eventId));
  app.post('/api/organiser/events/:eventId/staff', async (req) => organiser.addStaff(ctx, await organiserUser(req), params(req, { eventId: id }).eventId, parse(z.object({ phone: z.string().min(5).max(20) }), req.body).phone));
  app.delete('/api/organiser/events/:eventId/staff/:phone', async (req) => {
    const p = params(req, { eventId: id, phone: z.string().min(5).max(20) });
    return organiser.removeStaff(ctx, await organiserUser(req), p.eventId, p.phone);
  });
  app.get('/api/organiser/events/:eventId/scan-report', async (req) => organiser.scanReport(ctx, await organiserUser(req), params(req, { eventId: id }).eventId));
  app.get('/api/organiser/events/:eventId/settlement', async (req) => organiser.settlement(ctx, await organiserUser(req), params(req, { eventId: id }).eventId));
  app.post('/api/organiser/orders/:orderId/refund', async (req) => {
    const u = await organiserUser(req);
    const body = parse(z.object({ ticket_ids: z.array(id).min(1).max(1000).optional() }), req.body);
    return tickets.refundOrder(ctx, params(req, { orderId: id }).orderId, { kind: 'ORGANISER', organiserUserId: u.id, ticket_ids: body.ticket_ids });
  });

  // ---- admin (operations) ----
  app.register(async (admin) => {
    admin.addHook('onRequest', adminOnly);
    admin.post('/sweep', async () => ({ expired: await holds.expireDueHolds(ctx) }));
    admin.post('/queue/tick', async () => ({ admitted: await queue.tick(ctx) }));
    admin.post('/reconcile', async () => payments.reconcile(ctx));
    admin.get('/invariants', async (req) => checkInvariants(ctx.pool, parse(z.object({ event_id: id.optional() }), req.query).event_id));
    admin.get('/reconciliation-issues', async () => ({ issues: (await ctx.pool.query('SELECT * FROM reconciliation_issues ORDER BY id DESC LIMIT 100')).rows }));
  }, { prefix: '/api/admin' });

  return app;
}
