// A real PostgreSQL server for local runs with no setup: started from an npm package into ./.data/pg.
// Production uses DATABASE_URL (Neon, Supabase, RDS...) and never loads this file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function startEmbeddedPostgres(dir = '.data/pg', port = 54330): Promise<{ url: string; stop: () => Promise<void> }> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, postgresFlags: ['-c', 'max_connections=300'] });
  if (!existsSync(join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('atomicpass');
  } catch {
    // it already exists
  }
  return { url: `postgres://postgres:postgres@localhost:${port}/atomicpass`, stop: () => pg.stop() };
}
