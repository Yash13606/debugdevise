import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sleep } from '../helpers.js';

const entry = ['--import', 'tsx', 'src/index.ts'];

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

describe('npm start (src/index.ts)', () => {
  it('boots on the given settings, creates its database file and answers /health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomicpass-boot-'));
    const port = await freePort();
    const child = spawn(process.execPath, entry, {
      env: { ...process.env, PORT: String(port), DATABASE_PATH: join(dir, 'nested', 'boot.db'), LOG_LEVEL: 'silent' },
      stdio: 'ignore',
    });
    try {
      let body: { ok: boolean } | undefined;
      for (let i = 0; i < 100 && !body; i++) {
        try {
          const res = await fetch(`http://localhost:${port}/health`);
          if (res.ok) body = (await res.json()) as { ok: boolean };
        } catch {
          await sleep(150);
        }
      }
      expect(body).toMatchObject({ ok: true });

      const created = await fetch(`http://localhost:${port}/api/admin/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-key': 'change-me-admin' },
        body: JSON.stringify({ name: 'Boot', starts_at: '2026-10-20T13:00:00Z', capacity: 3 }),
      });
      expect(created.status).toBe(201); // the default admin key works with no .env
    } finally {
      child.kill();
      await sleep(300);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an invalid setting stops startup with a message that names it', () => {
    const run = spawnSync(process.execPath, entry, {
      env: { ...process.env, HOLD_TTL_SECONDS: 'abc', DATABASE_PATH: join(tmpdir(), 'atomicpass-never-created.db') },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Cannot start: HOLD_TTL_SECONDS');
  });
});
