// Routes, auth headers, JSON-schema validation and error mapping. No SQL and no business rules here.
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import * as admin from './admin.js';
import { iso, now } from './clock.js';
import type { Ctx } from './db.js';
import { AppError } from './errors.js';
import * as holds from './holds.js';
import { sha256 } from './ids.js';

const same = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

/** onRequest hook: the named header must equal the expected key (compared in constant time). */
const requireKey = (header: string, expected: string) => async (req: FastifyRequest) => {
  const given = req.headers[header];
  if (typeof given !== 'string' || !same(given, expected)) {
    throw new AppError('UNAUTHORIZED', 401, 'Missing or invalid key');
  }
};

const idParam = (name: string) => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'string', minLength: 1, maxLength: 64 } },
});
type EventParams = { eventId: string };

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

  // An empty body counts as {} (pay and release have no required fields).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError('VALIDATION_ERROR', 400, 'Request body is not valid JSON'));
    }
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

  app.register(
    async (adminApp) => {
      adminApp.addHook('onRequest', requireKey('x-admin-key', config.adminApiKey));

      adminApp.post('/events', { schema: { body: eventBody } }, async (req, reply) =>
        reply.code(201).send(admin.createEvent(ctx, req.body as admin.EventInput)),
      );

      adminApp.post('/events/:eventId/tiers', { schema: { params: idParam('eventId'), body: tierBody } }, async (req, reply) =>
        reply.code(201).send(admin.createTier(ctx, (req.params as EventParams).eventId, req.body as admin.TierInput)),
      );
    },
    { prefix: '/api/admin' },
  );

  return app;
}
