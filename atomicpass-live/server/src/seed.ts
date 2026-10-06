// Demo data: one organiser and a handful of events covering every kind of sale the app supports.
import type { User } from './auth.js';
import { now as clockNow } from './clock.js';
import type { Ctx } from './db.js';
import { one } from './db.js';
import { randomId } from './ids.js';
import { createEvent, createPromo } from './organiser.js';

export const DEMO_ORGANISER_PHONE = '+919000000001';

const day = 86_400_000;

/** Creates the demo organiser and events once. Returns false when they already exist. */
export async function seedDemo(ctx: Ctx): Promise<boolean> {
  const exists = await one(ctx.pool, 'SELECT 1 FROM users WHERE phone = $1', [DEMO_ORGANISER_PHONE]);
  if (exists) return false;
  const id = randomId('usr');
  await ctx.pool.query(`INSERT INTO users (id, phone, name, role, org_name, created_at) VALUES ($1, $2, 'Demo Organiser', 'ORGANISER', 'Midnight Sounds', $3)`, [id, DEMO_ORGANISER_PHONE, clockNow()]);
  const org: User = { id, phone: DEMO_ORGANISER_PHONE, name: 'Demo Organiser', role: 'ORGANISER', org_name: 'Midnight Sounds' };
  const at = (days: number) => new Date(clockNow() + days * day).toISOString();

  const live = await createEvent(ctx, org, {
    name: 'Arijit Singh Live', category: 'Music', city: 'Mumbai', venue: 'Jio World Garden', address: 'BKC, Mumbai', banner: '#4a2340,#111111',
    description: 'One night, one voice. Doors open at 6 PM.', starts_at: at(14), queue_enabled: true,
    tiers: [{ name: 'General', price_paise: 149_900, capacity: 800, max_per_order: 4 }, { name: 'Gold', price_paise: 299_900, capacity: 200, max_per_order: 4 }],
  });
  await createPromo(ctx, org, live.event.id, { code: 'EARLY20', kind: 'PERCENT', value: 20, max_uses: 100 });

  await createEvent(ctx, org, {
    name: 'Standup Saturday', category: 'Comedy', city: 'Bengaluru', venue: 'Phoenix Marketcity Arena', address: 'Whitefield, Bengaluru', banner: '#e8b13a,#111111',
    description: 'Pick your own seat. Front rows get the best view of the roasting.', starts_at: at(9),
    tiers: [
      { name: 'Front rows', price_paise: 99_900, seated: { rows: 4, seats_per_row: 12 }, max_per_order: 6 },
      { name: 'Back rows', price_paise: 59_900, seated: { rows: 6, seats_per_row: 12 }, max_per_order: 6 },
    ],
  });

  const fest = await createEvent(ctx, org, {
    name: 'Techfest Night 2026', category: 'Festival', city: 'Hyderabad', venue: 'University Grounds', address: 'Gachibowli, Hyderabad', banner: '#17382f,#111111',
    description: '5,000 passes drop at 6 PM. The waiting room keeps it fair.', starts_at: at(21), queue_enabled: true,
    tiers: [{ name: 'Entry pass', price_paise: 49_900, capacity: 5000, max_per_order: 4 }],
  });
  await createPromo(ctx, org, fest.event.id, { code: 'STUDENT50', kind: 'FIXED', value: 5_000, max_uses: 500 });

  await createEvent(ctx, org, {
    name: 'Postgres Locking Workshop', category: 'Workshop', city: 'Pune', venue: 'Coworking Hub', address: 'Baner, Pune', banner: '#1c2a52,#111111',
    description: 'A free hands-on session on row locks and guarded updates.', starts_at: at(5),
    tiers: [{ name: 'Free seat', price_paise: 0, capacity: 40, max_per_order: 2 }],
  });

  await createEvent(ctx, org, {
    name: 'IPL Screening Night', category: 'Sports', city: 'Chennai', venue: 'Marina Fan Park', address: 'Marina Beach, Chennai', banner: '#111111,#111111',
    description: 'Big screen, loud crowd.', starts_at: at(3),
    tiers: [{ name: 'Standing', price_paise: 29_900, capacity: 300, max_per_order: 6 }],
  });
  return true;
}
