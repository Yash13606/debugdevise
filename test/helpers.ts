import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type Ctx, type Db } from '../src/db.js';
import { buildApp } from '../src/http.js';

export const ADMIN = { 'x-admin-key': 'change-me-admin' };
export const GATE = { 'x-gate-key': 'change-me-gate' };

const dirs: string[] = [];
const dbs: Db[] = [];
const apps: FastifyInstance[] = [];

/** A fresh database path inside a new temp folder. */
export function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atomicpass-'));
  dirs.push(dir);
  return join(dir, 'test.db');
}

/** Open (and remember) a database; `cleanupTemp` closes it. */
export function openTempDb(path: string = tempDbPath()): Db {
  const db = openDb(path);
  dbs.push(db);
  return db;
}

/** Close apps and databases, then delete the temp folders (Windows keeps open files locked). */
export async function cleanupTemp(): Promise<void> {
  for (const app of apps.splice(0)) await app.close();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp folder; the OS cleans it up later */
    }
  }
}

export interface TestApp {
  app: FastifyInstance;
  ctx: Ctx;
  db: Db;
  config: Config;
  path: string;
}

/** An app on its own temp database. Timers are off; tests sweep and tick by hand. */
export async function makeApp(env: Record<string, string> = {}): Promise<TestApp> {
  const path = tempDbPath();
  const config = loadConfig({
    DATABASE_PATH: path,
    HOLD_SWEEP_INTERVAL_MS: '0',
    QUEUE_TICK_MS: '0',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const db = openTempDb(path);
  const ctx: Ctx = { db, config };
  const app = buildApp(ctx);
  await app.ready();
  apps.push(app);
  return { app, ctx, db, config, path };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export async function newEvent(t: TestApp, body: Record<string, unknown> = {}): Promise<Json> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/admin/events',
    headers: ADMIN,
    payload: { name: 'Fest 2026', starts_at: '2026-10-20T13:00:00Z', capacity: 10, ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().event;
}

export async function newTier(t: TestApp, eventId: string, body: Record<string, unknown> = {}): Promise<Json> {
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/admin/events/${eventId}/tiers`,
    headers: ADMIN,
    payload: { name: 'General', price_cents: 1000, capacity: 10, ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().tier;
}

/** One tier line. */
export const line = (tier: { id: string }, quantity = 1) => ({ tier_id: tier.id, quantity });

/** POST /api/events/:id/holds; returns the raw response so tests can assert on failures. */
export function placeHold(
  t: TestApp,
  eventId: string,
  email: string,
  items: { tier_id: string; quantity: number }[],
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return t.app.inject({
    method: 'POST',
    url: `/api/events/${eventId}/holds`,
    headers,
    payload: { email, items, ...extra },
  });
}

/** GET /api/events/:id: the public availability view. */
export async function getEvent(t: TestApp, eventId: string): Promise<Json> {
  const res = await t.app.inject({ method: 'GET', url: `/api/events/${eventId}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
