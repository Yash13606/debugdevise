// Routes, auth headers, JSON-schema validation and error mapping. No SQL and no business rules here.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import * as admin from './admin.js';
import { iso, now } from './clock.js';
import type { Ctx } from './db.js';
import { AppError } from './errors.js';
import * as holds from './holds.js';
import { safeEqual } from './ids.js';
import * as tickets from './tickets.js';

/** onRequest hook: the named header must equal the expected key (compared in constant time). */
const requireKey = (header: string, expected: string) => async (req: FastifyRequest) => {
  const given = req.headers[header];
  if (typeof given !== 'string' || !safeEqual(given, expected)) {
    throw new AppError('UNAUTHORIZED', 401, 'Missing or invalid key');
  }
};

const idParam = (name: string) => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'string', minLength: 1, maxLength: 64 } },
});
type EventParams = { eventId: string };
type HoldParams = { holdId: string };

const holdToken = (req: FastifyRequest) => {
  const v = req.headers['x-hold-token'];
  return typeof v === 'string' ? v : undefined;
};

const promoBody = {
  type: 'object',
  required: ['code', 'kind', 'value'],
  additionalProperties: false,
  properties: {
    code: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' },
    kind: { type: 'string', enum: ['PERCENT', 'FIXED'] },
    value: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
    max_uses: { type: ['integer', 'null'], minimum: 1, maximum: 1_000_000_000 },
    valid_from: { type: ['string', 'null'], maxLength: 40 },
    valid_to: { type: ['string', 'null'], maxLength: 40 },
    tier_id: { type: ['string', 'null'], maxLength: 64 },
  },
};

const refundBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ticket_ids: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'string', minLength: 1, maxLength: 64 } },
    reason: { type: 'string', maxLength: 500 },
  },
};

const checkinBody = {
  type: 'object',
  required: ['qr'],
  additionalProperties: false,
  properties: {
    qr: { type: 'string', minLength: 1, maxLength: 200 },
    gate: { type: 'string', minLength: 1, maxLength: 64 },
  },
};

const payBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    payment_method: { type: 'string', enum: ['mock'] },
    simulate: { type: 'string', enum: ['success', 'decline'] },
  },
};

const eventBody = {
  type: 'object',
  required: ['name', 'starts_at', 'capacity'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    starts_at: { type: 'string', minLength: 10, maxLength: 40 },
    capacity: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
    queue_enabled: { type: 'boolean' },
  },
};

const tierBody = {
  type: 'object',
  required: ['name', 'price_cents', 'capacity'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    price_cents: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
    capacity: { type: 'integer', minimum: 1, maximum: 1_000_000_000 },
    max_per_order: { type: 'integer', minimum: 1, maximum: 1000 },
    sale_starts_at: { type: ['string', 'null'], maxLength: 40 },
    sale_ends_at: { type: ['string', 'null'], maxLength: 40 },
  },
};

const holdBody = {
  type: 'object',
  required: ['email', 'items'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', minLength: 3, maxLength: 254 },
    promo_code: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['tier_id', 'quantity'],
        additionalProperties: false,
        properties: {
          tier_id: { type: 'string', minLength: 1, maxLength: 64 },
          quantity: { type: 'integer', minimum: 1, maximum: 1000 },
        },
      },
    },
  },
};

export function buildApp(ctx: Ctx): FastifyInstance {
  const { config } = ctx;
  const app = Fastify({
    logger: { level: config.logLevel },
    // Unknown fields are rejected (the default silently strips them) and types are never coerced.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } },
  });

  // An empty JSON body counts as {}.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('VALIDATION_ERROR', 400, 'Request body is not valid JSON'));
    }
  });

  // A request without a body counts as {} (pay and release have no required fields).
  app.addHook('preValidation', async (req) => {
    if (req.body === undefined) req.body = {};
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      const error = { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
      return reply.code(err.status).send({ error });
    }
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'VALIDATION_ERROR', message: e.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Unexpected error' } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  app.get('/health', async () => ({ ok: true, time: iso(now()) }));

  app.get('/api/events/:eventId', { schema: { params: idParam('eventId') } }, async (req) =>
    holds.availability(ctx, (req.params as EventParams).eventId),
  );

  app.post('/api/events/:eventId/holds', { schema: { params: idParam('eventId'), body: holdBody } }, async (req, reply) =>
    reply.code(201).send(holds.createHold(ctx, (req.params as EventParams).eventId, req.body as holds.HoldInput)),
  );

  app.get('/api/holds/:holdId', { schema: { params: idParam('holdId') } }, async (req) =>
    holds.getHold(ctx, (req.params as HoldParams).holdId, holdToken(req)),
  );

  app.delete('/api/holds/:holdId', { schema: { params: idParam('holdId') } }, async (req) =>
    holds.releaseHold(ctx, (req.params as HoldParams).holdId, holdToken(req)),
  );

  app.post('/api/holds/:holdId/pay', { schema: { params: idParam('holdId'), body: payBody } }, async (req, reply) => {
    const { replay, order, tickets } = holds.payHold(ctx, (req.params as HoldParams).holdId, holdToken(req), req.body as holds.PayInput);
    return reply.code(replay ? 200 : 201).send({ order, tickets });
  });

  app.get('/api/orders/:orderId', { schema: { params: idParam('orderId') } }, async (req) =>
    holds.getOrder(ctx, (req.params as { orderId: string }).orderId, holdToken(req)),
  );

  app.post(
    '/api/checkin',
    { onRequest: requireKey('x-gate-key', config.gateApiKey), schema: { body: checkinBody } },
    async (req) => tickets.checkIn(ctx, req.body as tickets.CheckInInput),
  );

  app.register(
    async (adminApp) => {
      adminApp.addHook('onRequest', requireKey('x-admin-key', config.adminApiKey));

      adminApp.post('/sweep', async () => ({ expired: holds.expireDueHolds(ctx) }));

      adminApp.post('/events', { schema: { body: eventBody } }, async (req, reply) =>
        reply.code(201).send(admin.createEvent(ctx, req.body as admin.EventInput)),
      );

      adminApp.post(
        '/events/:eventId/promo-codes',
        { schema: { params: idParam('eventId'), body: promoBody } },
        async (req, reply) => reply.code(201).send(admin.createPromo(ctx, (req.params as EventParams).eventId, req.body as admin.PromoInput)),
      );

      adminApp.post('/orders/:orderId/refund', { schema: { params: idParam('orderId'), body: refundBody } }, async (req) =>
        tickets.refund(ctx, (req.params as { orderId: string }).orderId, req.body as tickets.RefundInput),
      );

      adminApp.post('/events/:eventId/tiers', { schema: { params: idParam('eventId'), body: tierBody } }, async (req, reply) =>
        reply.code(201).send(admin.createTier(ctx, (req.params as EventParams).eventId, req.body as admin.TierInput)),
      );
    },
    { prefix: '/api/admin' },
  );

  return app;
}
