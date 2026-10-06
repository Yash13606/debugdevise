// Starts one real PostgreSQL server for the whole test run. Each test file gets its own database in it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-live-pg-'));
  const port = 54320 + Math.floor(Math.random() * 60);
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'pw',
    port,
    persistent: false,
    // Speed over durability: this server is thrown away after the run.
    postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=400'],
  });
  await pg.initialise();
  await pg.start();
  project.provide('pgUrl', `postgres://postgres:pw@localhost:${port}/postgres`);
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
