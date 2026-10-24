import type { Bot } from 'grammy';
import type { BotDeps } from './bot/index.js';
import { notifyDrop, notifyOrderUpdate } from './bot/index.js';
import { launchDueDrops } from './services/catalog.js';
import { expireReservations } from './services/orders.js';
import { syncShipments } from './services/shipping.js';

/**
 * Background work for a single instance (run one server process, or move this to a cron worker):
 * – unpaid reserves older than RESERVE_MINUTES go back to stock;
 * – drops whose time has come go live and everyone watching gets a message from the bot;
 * – every 2 minutes СДЭК numbers and statuses are fetched for orders on their way.
 */
export function startJobs(deps: BotDeps, bot: Bot | null, everyMs = 30_000) {
  let busy = false, ticks = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const expired = await expireReservations(deps.db);
      if (expired.length) deps.log.info({ expired }, 'reserves released');
      const launched = await launchDueDrops(deps.db);
      for (const id of launched) {
        deps.log.info({ productId: id }, 'drop launched');
        // not awaited: messaging thousands of watchers takes minutes, and reserves must keep expiring meanwhile.
        // launchDueDrops returns each product once, so a drop is never announced twice
        if (bot) void notifyDrop(deps, bot, id).catch((e) => deps.log.error({ err: e, productId: id }, 'drop notify failed'));
      }
      if (deps.cdek && ticks++ % Math.max(1, Math.round(120_000 / everyMs)) === 0) {
        await syncShipments(deps.db, deps.cdek, deps.log, async (o, note) => { if (bot) await notifyOrderUpdate(deps, bot, o, note); });
      }
    } catch (e) {
      deps.log.error({ err: e }, 'job tick failed');
    } finally {
      busy = false;
    }
  };
  const t = setInterval(tick, everyMs);
  void tick();
  return () => clearInterval(t);
}
