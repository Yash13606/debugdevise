import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db.js';

const dirs: string[] = [];
const dbs: Db[] = [];

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

/** Close every opened database, then delete the temp folders (Windows keeps open files locked). */
export function cleanupTemp(): void {
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
