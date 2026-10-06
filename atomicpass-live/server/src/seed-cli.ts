// `npm run seed`: seed the database in DATABASE_URL.
import { loadConfig, loadDotEnv } from './config.js';
import { createCtx } from './runtime.js';
import { seedDemo } from './seed.js';

loadDotEnv();
const config = loadConfig();
if (!config.databaseUrl) throw new Error('Set DATABASE_URL to seed (or just run `npm start`, which seeds an empty local database)');
const { ctx, close } = await createCtx(config, config.databaseUrl);
console.log((await seedDemo(ctx)) ? 'seeded demo events' : 'demo events already exist');
await close();
