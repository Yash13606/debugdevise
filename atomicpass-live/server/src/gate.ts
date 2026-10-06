// The fast gate: an in-memory counter per tier and per event (Redis) that turns away buyers who obviously cannot
// win, so they never reach the database. It is only a shield. The guarded UPDATE in the database stays the judge,
// so a wrong counter can cost a false "sold out" for a moment or some extra database work, never an oversell.
//   - the counter is too LOW if a process dies between taking and committing: heal() raises it back to the truth;
//   - it is too HIGH after a lost give-back: harmless, the database still refuses.
// If Redis fails, take() waves everyone through (fail open) and counts the error.
import type { Pool } from './db.js';
import { all } from './db.js';
import type { Line } from './inventory.js';
import type { Metrics } from './metrics.js';
import type { RedisLike } from './redis.js';

const tierKey = (id: string) => `gate:t:${id}`;
const eventKey = (id: string) => `gate:e:${id}`;

export type Take = { ok: true; undo: () => Promise<void> } | { ok: false; scope: 'tier' | 'event'; tierId?: string };

export class FastGate {
  private tracked = { tiers: new Set<string>(), events: new Set<string>() };

  constructor(
    private redis: RedisLike,
    private pool: Pool,
    private metrics: Metrics,
    private enabled = true,
  ) {}

  private async seed(table: 'tiers' | 'events', id: string): Promise<void> {
    const key = table === 'tiers' ? tierKey(id) : eventKey(id);
    if ((await this.redis.get(key)) !== null) return;
    const rows = await all<{ a: number }>(this.pool, `SELECT capacity - sold - held AS a FROM ${table} WHERE id = $1`, [id]);
    await this.redis.set(key, String(rows[0]?.a ?? 0), 'NX'); // NX: two processes seeding together keep the first value
    (table === 'tiers' ? this.tracked.tiers : this.tracked.events).add(id);
  }

  /** Try to take the lines (and their total from the event pool). */
  async take(eventId: string, lines: Line[]): Promise<Take> {
    if (!this.enabled) return { ok: true, undo: async () => {} };
    const taken: { key: string; q: number }[] = [];
    const undo = async () => {
      for (const t of taken) await this.redis.incrby(t.key, t.q).catch(() => {});
    };
    try {
      const steps: { table: 'tiers' | 'events'; id: string; q: number }[] = [...lines].sort((a, b) => (a.tierId < b.tierId ? -1 : 1)).map((l) => ({ table: 'tiers', id: l.tierId, q: l.quantity }));
      steps.push({ table: 'events', id: eventId, q: lines.reduce((s, l) => s + l.quantity, 0) });
      for (const s of steps) {
        await this.seed(s.table, s.id);
        const key = s.table === 'tiers' ? tierKey(s.id) : eventKey(s.id);
        const left = await this.redis.decrby(key, s.q);
        taken.push({ key, q: s.q });
        if (left < 0) {
          await undo();
          this.metrics.inc('gate_refusals_total', { scope: s.table === 'tiers' ? 'tier' : 'event' });
          return s.table === 'tiers' ? { ok: false, scope: 'tier', tierId: s.id } : { ok: false, scope: 'event' };
        }
      }
      return { ok: true, undo };
    } catch {
      this.metrics.inc('gate_errors_total');
      await undo();
      return { ok: true, undo: async () => {} };
    }
  }

  /** Seats came back (hold released, expired, or refunded): give them to the counters again. */
  async give(moves: { eventId: string; tierId: string; quantity: number }[]): Promise<void> {
    if (!this.enabled) return;
    try {
      const perEvent = new Map<string, number>();
      for (const m of moves) {
        await this.redis.incrby(tierKey(m.tierId), m.quantity);
        perEvent.set(m.eventId, (perEvent.get(m.eventId) ?? 0) + m.quantity);
      }
      for (const [id, q] of perEvent) await this.redis.incrby(eventKey(id), q);
    } catch {
      this.metrics.inc('gate_errors_total');
    }
  }

  /** Raise any counter that has fallen below what the database says is really available. Never lowers one. */
  async heal(): Promise<number> {
    if (!this.enabled) return 0;
    let raised = 0;
    try {
      for (const [table, ids, keyOf] of [
        ['tiers', [...this.tracked.tiers], tierKey],
        ['events', [...this.tracked.events], eventKey],
      ] as const) {
        if (ids.length === 0) continue;
        const rows = await all<{ id: string; a: number }>(this.pool, `SELECT id, capacity - sold - held AS a FROM ${table} WHERE id = ANY($1)`, [ids]);
        for (const r of rows) {
          const cur = await this.redis.get(keyOf(r.id));
          if (cur === null || Number(cur) < r.a) {
            await this.redis.set(keyOf(r.id), String(r.a));
            raised++;
          }
        }
      }
    } catch {
      this.metrics.inc('gate_errors_total');
    }
    if (raised) this.metrics.inc('gate_heals_total', {}, raised);
    return raised;
  }
}
