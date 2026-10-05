import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { SCHEMA_SQL } from './schema.js';

export type Db = Database.Database;

/** What every operation needs: a connection and the settings. */
export interface Ctx {
  db: Db;
  config: Config;
}

/** Open the database, set the pragmas (DATA_MODEL section 1) and create the schema when the file is new. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  // BEGIN IMMEDIATE: two connections opening a fresh file together create the schema only once.
  db.transaction(() => {
    if (db.pragma('user_version', { simple: true }) === 0) {
      db.exec(SCHEMA_SQL);
      db.pragma('user_version = 1');
    }
  }).immediate();
  return db;
}

/**
 * Run `fn` in one BEGIN IMMEDIATE transaction (ARCHITECTURE section 3).
 * Throwing rolls back. Returning an AppError commits and then throws it: use that for a
 * refusal that must still persist, such as expiring a stale hold while answering 410.
 */
export function runTx<T>(db: Db, fn: () => T | AppError): T {
  const result = db.transaction(fn).immediate();
  if (result instanceof AppError) throw result;
  return result;
}
