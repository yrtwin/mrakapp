import './env.js';
import { loadConfig } from './config.js';
import { migrateDatabase, openDatabase } from './db/index.js';
import { seed } from './db/seed.js';
import { createStorage } from './services/storage.js';
import { ALLOWED_UPDATES, createBot, setupBot, syncMenus } from './bot/index.js';
import { buildApp } from './app.js';
import { startJobs } from './jobs.js';
import { createCdek } from './services/cdek.js';
import { analysePending } from './services/djAnalyze.js';
import { followPublicUrl } from './publicUrl.js';

async function main() {
  const cfg = loadConfig();
  const database = await openDatabase(cfg.DATABASE_URL, cfg.PGLITE_DIR);
  await migrateDatabase(database);
  const storage = createStorage(cfg);
  const cdek = createCdek(cfg);
  const { db } = database;

  const mode: 'webhook' | 'polling' | 'off' = !cfg.botEnabled ? 'off' : cfg.BOT_MODE === 'auto' ? (/^https:\/\//.test(cfg.PUBLIC_URL) && cfg.isProd ? 'webhook' : 'polling') : (cfg.BOT_MODE as 'webhook' | 'polling');
  const bot = mode === 'off' ? null : createBot({ cfg, db, storage, cdek, log: console });
  const app = await buildApp({ cfg, db, storage, bot, botMode: mode, cdek });
  const log = app.log;

  if (process.env.SEED_ON_START !== '0') {
    const created = await seed(db, storage, { demo: process.env.SEED_DEMO === '1', log: (m) => log.info(m) });
    if (created) log.info('database seeded');
  }

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  log.info(`MRAK8 central booking is up: ${cfg.PUBLIC_URL} (db: ${database.kind}, bot: ${mode}, payments: ${cfg.PAYMENT_PROVIDER}${cfg.testPayments ? ' TEST' : ''})`);

  const deps = { cfg, db, storage, cdek, log };
  if (bot) {
    await bot.init();
    try { await setupBot(deps, bot, mode as 'webhook' | 'polling'); } catch (e) { log.warn({ err: e }, 'bot setup failed'); }
    void analysePending(cfg, db, bot, log); // DJ tracks still without a beat grid
    if (mode === 'polling') void bot.start({ allowed_updates: [...ALLOWED_UPDATES], onStart: (me) => log.info(`bot @${me.username} polling`) });
  }
  const stopJobs = startJobs(deps, bot);
  const stopFollow = cfg.PUBLIC_URL_FILE ? followPublicUrl(deps, bot, mode === 'off' ? 'polling' : mode) : () => {};

  const shutdown = async (sig: string) => {
    log.info(`${sig}: shutting down`);
    stopJobs();
    stopFollow();
    // a mini app on this computer or behind a tunnel is going away: no MRAK8 buttons to a dead address
    if (bot && cfg.webAppButtons && (cfg.webAppLocal || cfg.PUBLIC_URL_FILE)) await syncMenus(deps, bot, false);
    if (bot && mode === 'polling') await bot.stop().catch(() => {});
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
