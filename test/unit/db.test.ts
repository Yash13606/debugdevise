import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTx, type Db } from '../../src/db.js';
import { AppError } from '../../src/errors.js';
import { SCHEMA_SQL } from '../../src/schema.js';
import { cleanupTemp, openTempDb, tempDbPath } from '../helpers.js';

afterEach(cleanupTemp);

const count = (db: Db, table: string) => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();

function seed(db: Db) {
  db.prepare(`INSERT INTO events (id, name, starts_at, capacity, created_at) VALUES ('evt_a', 'Fest', 0, 5, 0)`).run();
  db.prepare(
    `INSERT INTO tiers (id, event_id, name, price_cents, capacity, created_at) VALUES ('tier_a', 'evt_a', 'Early', 100, 5, 0)`,
  ).run();
}

describe('schema', () => {
  it('is exactly the DDL in docs/DATA_MODEL.md section 2', () => {
    const md = readFileSync(new URL('../../docs/DATA_MODEL.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const block = /```sql\n([\s\S]*?)```/.exec(md);
    expect(block).not.toBeNull();
    expect(SCHEMA_SQL.trim()).toBe(block![1]!.trim());
  });
});

describe('openDb', () => {
  it('sets the pragmas and creates every table', () => {
    const db = openTempDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .pluck()
      .all();
    expect(tables).toEqual(
      ['events', 'hold_items', 'holds', 'orders', 'promo_codes', 'queue_entries', 'scan_log', 'tickets', 'tiers'].sort(),
    );
  });

  it('can open an existing file again without rerunning the DDL', () => {
    const path = tempDbPath();
    seed(openTempDb(path));
    expect(count(openTempDb(path), 'events')).toBe(1);
  });

  it('creates the database folder when it is missing', () => {
    const db = openTempDb(join(dirname(tempDbPath()), 'nested', 'deeper', 'x.db'));
    expect(count(db, 'events')).toBe(0);
  });
});

describe('capacity constraints (the database as the last line of defence)', () => {
  it('reject sold + held above capacity on the event pool', () => {
    const db = openTempDb();
    seed(db);
    expect(() => db.prepare(`UPDATE events SET sold = 3, held = 3 WHERE id = 'evt_a'`).run()).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('reject sold + held above capacity on a tier', () => {
    const db = openTempDb();
    seed(db);
    expect(() => db.prepare(`UPDATE tiers SET sold = 1, held = 5 WHERE id = 'tier_a'`).run()).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('allow sold + held exactly at capacity', () => {
    const db = openTempDb();
    seed(db);
    db.prepare(`UPDATE events SET sold = 3, held = 2 WHERE id = 'evt_a'`).run();
    db.prepare(`UPDATE tiers SET sold = 3, held = 2 WHERE id = 'tier_a'`).run();
    expect(db.prepare(`SELECT sold + held FROM tiers WHERE id = 'tier_a'`).pluck().get()).toBe(5);
  });

  it('reject a negative counter', () => {
    const db = openTempDb();
    seed(db);
    expect(() => db.prepare(`UPDATE tiers SET held = held - 1 WHERE id = 'tier_a'`).run()).toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe('runTx (ARCHITECTURE section 3)', () => {
  const insertRow = (db: Db) => db.prepare('INSERT INTO t VALUES (1)').run();

  it('commits and returns the value', () => {
    const db = openTempDb();
    db.exec('CREATE TABLE t (n INTEGER)');
    expect(runTx(db, () => (insertRow(db), 'done'))).toBe('done');
    expect(count(db, 't')).toBe(1);
  });

  it('rolls everything back when the function throws', () => {
    const db = openTempDb();
    db.exec('CREATE TABLE t (n INTEGER)');
    expect(() =>
      runTx(db, () => {
        insertRow(db);
        throw new AppError('SOLD_OUT', 409, 'Not enough tickets left');
      }),
    ).toThrow(AppError);
    expect(count(db, 't')).toBe(0);
  });

  it('commits first, then throws, when the function returns an AppError (a refusal)', () => {
    const db = openTempDb();
    db.exec('CREATE TABLE t (n INTEGER)');
    let caught: unknown;
    try {
      runTx(db, () => {
        insertRow(db);
        return new AppError('HOLD_EXPIRED', 410, 'Hold expired');
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ code: 'HOLD_EXPIRED', status: 410 });
    expect(count(db, 't')).toBe(1);
  });
});
