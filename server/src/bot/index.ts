import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { eq, and, isNull } from 'drizzle-orm';
import { deepLink, formatRub, subjectNo } from '@mrak8/shared';
import { canOpenWebApp, type Config } from '../config.js';
import type { DB } from '../db/index.js';
import { dropWatchers, productImages, products, users } from '../db/schema.js';
import { jpegForTelegram } from '../services/media.js';
import { repointAppButtons, trackAppButtons } from './appButtons.js';
import { registerChatCatalog } from './catalog.js';
import { registerDj } from './dj.js';
import { markPaid, preCheckout, type OrderItemRow, type OrderRow } from '../services/orders.js';
import type { Storage } from '../services/storage.js';
import type { Cdek } from '../services/cdek.js';
import { registerShipment } from '../services/shipping.js';

export interface BotDeps { cfg: Config; db: DB; storage: Storage; cdek?: Cdek | null; log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void } }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ALLOWED_UPDATES = ['message', 'callback_query', 'pre_checkout_query', 'inline_query'] as const;

export function webappUrl(cfg: Config, query = '') {
  return cfg.WEBAPP_URL.replace(/\/$/, '') + '/' + query;
}
export function miniappLink(cfg: Config, param?: string) {
  return deepLink(cfg.MINIAPP_LINK, param);
}

export function receiptText(order: OrderRow, items: OrderItemRow[]) {
  const lines = items.map((i, n) => `${String(n + 1).padStart(2, '0')}. ${esc(i.title)} / ${i.sizeLabel} ×${i.qty} — ${formatRub(i.price * i.qty)}`);
  return [
    `<b>ОФОРМЛЕН.</b> CASE <code>#${order.no}</code>`,
    `SUBJECT <code>#${order.subjectNo}</code>`,
    '',
    '<pre>' + lines.join('\n') + `\nДоставка · ${esc(order.deliveryTitle)} — ${formatRub(order.deliveryPrice)}\nИТОГО — ${formatRub(order.total)}</pre>`,
    'Ожидайте этапирования. Трек-номер пришлю сюда.',
    '<i>NO EMOTIONAL CONTRABAND. ALL SUBJECTS ARE MONITORED.</i>',
  ].join('\n');
}

export function createBot(deps: BotDeps) {
  const { cfg, db, log } = deps;
  const bot = new Bot(cfg.BOT_TOKEN, {
    client: { apiRoot: cfg.BOT_API_ROOT, environment: cfg.TELEGRAM_ENV, ...(cfg.TELEGRAM_PROXY ? { baseFetchConfig: { agent: new HttpsProxyAgent(cfg.TELEGRAM_PROXY), compress: true } } : {}) },
  });
  const isAdmin = (id?: number) => !!id && cfg.ADMIN_IDS.includes(id);
  const openKb = (text: string, query = '') => new InlineKeyboard().webApp(text, webappUrl(cfg, query));

  trackAppButtons(bot, cfg, db);
  bot.use(async (c, next) => {
    if (c.chat?.type === 'private' && c.from) giveMenu(cfg, bot, c.from.id);
    await next();
  });
  registerChatCatalog(bot, deps); // /start, /catalog and the in-chat shop
  registerDj(bot, deps); // admins: mp3 to the bot → DJ set, /dj

  bot.command('admin', async (c) => {
    if (!isAdmin(c.from?.id)) {
      // the id is what goes into ADMIN_IDS when a new operator joins
      await c.reply(`ДОСТУП ЗАПРЕЩЁН. Попытка зафиксирована.\nID субъекта: <code>${c.from?.id}</code>`, { parse_mode: 'HTML' });
      return;
    }
    const ok = canOpenWebApp(cfg, c.from?.id);
    await c.reply('<b>CONTROL ROOM</b>\nПульт дежурного: товары, заказы, дропы, канал. Музыка в мини-аппе — /dj' + (ok ? '' : '\nМини-апп откроется после настройки https-домена.'), { parse_mode: 'HTML', reply_markup: ok ? openKb('ОТКРЫТЬ CONTROL ROOM', '#/admin') : undefined });
  });

  bot.on('pre_checkout_query', async (c) => {
    const q = c.preCheckoutQuery;
    try {
      const r = await preCheckout(db, q.invoice_payload, q.total_amount, q.currency, cfg.RESERVE_MINUTES);
      if (r.ok) await c.answerPreCheckoutQuery(true);
      else await c.answerPreCheckoutQuery(false, { error_message: r.error });
    } catch (e) {
      log.error({ err: e }, 'pre_checkout failed');
      await c.answerPreCheckoutQuery(false, { error_message: 'Центр оформления перегружен. Повторите через минуту.' });
    }
  });

  bot.on('message:successful_payment', async (c) => {
    const sp = c.message.successful_payment;
    const r = await markPaid(db, sp.invoice_payload, { telegram: sp.telegram_payment_charge_id, provider: sp.provider_payment_charge_id, totalAmount: sp.total_amount });
    if (!r) {
      log.error({ payload: sp.invoice_payload }, 'successful_payment for unknown order');
      return;
    }
    if (r.already) return; // repeated update: already handled
    await c.reply(receiptText(r.order, r.items), { parse_mode: 'HTML', reply_markup: openKb('ОТКРЫТЬ ДЕЛО', `?startapp=order_${r.order.no}`) });
    await notifyAdmins(deps, bot, r.order, r.items, r.oversold);
    if (deps.cdek && r.order.cdek) await registerShipment(db, deps.cdek, log, r.order, r.items);
  });

  bot.catch((err) => log.error({ err: err.error }, 'bot error'));
  return bot;
}

export async function notifyAdmins(deps: BotDeps, bot: Bot, order: OrderRow, items: OrderItemRow[], oversold = false) {
  const { cfg, log } = deps;
  if (!cfg.ADMIN_CHAT_ID) return;
  const text = [
    `${oversold ? '⚠️ ПЕРЕПРОДАЖА · ' : ''}<b>НОВОЕ ДЕЛО</b> <code>#${order.no}</code> · ${formatRub(order.total)}`,
    `SUBJECT #${order.subjectNo} · ${esc(order.name)} · ${esc(order.phone)}`,
    `${esc(order.deliveryTitle)}${order.address ? ': ' + esc(order.address) : ''}`,
    ...items.map((i) => `— ${esc(i.title)} / ${i.sizeLabel} ×${i.qty}`),
    order.comment ? `💬 ${esc(order.comment)}` : '',
  ].filter(Boolean).join('\n');
  try {
    await bot.api.sendMessage(cfg.ADMIN_CHAT_ID, text, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().webApp('CONTROL ROOM', webappUrl(cfg, '#/admin/orders')) });
  } catch (e) {
    log.warn({ err: e }, 'admin notify failed');
  }
}

/** a status change or a track number goes straight to the subject */
export async function notifyOrderUpdate(deps: BotDeps, bot: Bot, order: OrderRow, note?: string) {
  const label: Record<string, string> = { assembled: 'СОБРАН', shipped: 'ЭТАПИРОВАН', delivered: 'ДОСТАВЛЕН', cancelled: 'ОТМЕНЁН' };
  const st = label[order.status];
  if (!st && !order.trackNo) return;
  const text = [
    `CASE <code>#${order.no}</code> — <b>${st ?? 'ОБНОВЛЁН'}</b>`,
    order.trackNo ? `Трек-номер (${esc(order.deliveryTitle)}): <code>${esc(order.trackNo)}</code>` : '',
    order.cdek?.mode === 'pvz' && order.cdek.pvzAddress && order.status === 'shipped' ? `Пункт выдачи: ${esc(order.cdek.pvzAddress)}` : '',
    note ? esc(note) : '',
    order.status === 'delivered' ? 'Вещдок выдан. Дело закрыто.' : '',
  ].filter(Boolean).join('\n');
  const kb = new InlineKeyboard();
  const track = order.trackNo && trackingUrl(order.deliveryKey, order.trackNo);
  if (track) kb.url('📦 ОТСЛЕДИТЬ ПОСЫЛКУ', track).row();
  kb.webApp('ДОСЬЕ', webappUrl(deps.cfg, `?startapp=order_${order.no}`));
  await bot.api.sendMessage(order.userId, text, { parse_mode: 'HTML', reply_markup: kb });
}

/** the carrier's own tracking page for a track number */
export function trackingUrl(deliveryKey: string, trackNo: string) {
  const t = encodeURIComponent(trackNo.trim());
  if (deliveryKey === 'cdek') return `https://www.cdek.ru/ru/tracking/?order_id=${t}`;
  if (deliveryKey === 'post') return `https://www.pochta.ru/tracking?barcode=${t}`;
  return null;
}

/** drop went live: message everyone who pressed «Уведомить меня» (~25 msg/s) */
export async function notifyDrop(deps: BotDeps, bot: Bot, productId: number) {
  const { db, cfg, log } = deps;
  const [p] = await db.select().from(products).where(eq(products.id, productId));
  if (!p) return 0;
  const list = await db.select().from(dropWatchers).where(and(eq(dropWatchers.productId, productId), isNull(dropWatchers.notifiedAt)));
  let sent = 0;
  for (const w of list) {
    let settled = true; // delivered, or failed for good (the subject blocked the bot)
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.api.sendMessage(w.userId, `<b>ДРОП ОТКРЫТ.</b> Вещдок <code>#${p.no}</code> — ${esc(p.title)}.\nПартия ${esc(p.batch)}. Изымайте, пока не изъяли другие.`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard().webApp(`ОТКРЫТЬ ДЕЛО #${p.no}`, webappUrl(cfg, `?startapp=product_${p.id}`)),
        });
        sent++;
        break;
      } catch (e) {
        // 429: Telegram says how long to wait — wait and send again instead of losing the message
        const wait = e instanceof GrammyError && e.error_code === 429 ? (e.parameters.retry_after ?? 1) : null;
        if (wait === null || attempt === 5) {
          log.warn({ err: e, user: w.userId }, 'drop notify failed');
          settled = wait === null;
          break;
        }
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    // still rate-limited after 5 tries: left unmarked rather than reported as notified
    if (settled) await db.update(dropWatchers).set({ notifiedAt: new Date() }).where(and(eq(dropWatchers.productId, productId), eq(dropWatchers.userId, w.userId)));
    await new Promise((r) => setTimeout(r, 40));
  }
  return sent;
}

/** «Анонсировать в канале»: photo + button that opens the mini app right on the product (startapp=product_<id>) */
export async function announceProduct(deps: BotDeps, bot: Bot, productId: number, caption?: string) {
  const { db, cfg, storage } = deps;
  if (!cfg.CHANNEL_ID) throw new Error('CHANNEL_ID is not set');
  const [p] = await db.select().from(products).where(eq(products.id, productId));
  if (!p) throw new Error('product not found');
  const [img] = await db.select().from(productImages).where(and(eq(productImages.productId, productId), eq(productImages.slot, 'front')));
  const text = caption || `🟥 <b>ВЕЩДОК #${p.no} — ${esc(p.title)}</b>\nПартия ${esc(p.batch)} · ${formatRub(p.price)}\n\n<i>NO EMOTIONAL CONTRABAND. ALL SUBJECTS ARE MONITORED.</i>`;
  const kb = new InlineKeyboard().url(`ОТКРЫТЬ ДЕЛО #${p.no}`, miniappLink(cfg, `product_${p.id}`));
  if (img) {
    const jpg = await jpegForTelegram(storage, img.key, img.widths, 1200);
    return bot.api.sendPhoto(cfg.CHANNEL_ID, new InputFile(jpg, `mrak8-${p.no}.jpg`), { caption: text, parse_mode: 'HTML', reply_markup: kb });
  }
  return bot.api.sendMessage(cfg.CHANNEL_ID, text, { parse_mode: 'HTML', reply_markup: kb });
}

/** prepared message for Telegram.WebApp.shareMessage() — the «Я оформлен в MRAK8» card */
export async function prepareShare(deps: BotDeps, bot: Bot, userId: number, orderNo: string) {
  const { cfg } = deps;
  const card = `${cfg.WEBAPP_URL.replace(/\/$/, '')}/share/booked.jpg`;
  return bot.api.savePreparedInlineMessage(
    userId,
    {
      type: 'photo',
      id: `booked-${orderNo}`.slice(0, 64),
      photo_url: card,
      thumbnail_url: card,
      caption: `Меня оформили в <b>MRAK8 Central Booking</b>. SUBJECT <code>#${subjectNo(userId)}</code>.\n<i>NO EMOTIONAL CONTRABAND.</i>`,
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().url('ОФОРМИТЬСЯ В MRAK8', miniappLink(cfg, 'from_share')),
    },
    { allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true },
  );
}

const menuButton = (cfg: Config) => ({ type: 'web_app' as const, text: 'MRAK8', web_app: { url: webappUrl(cfg) } });

/* The MRAK8 button in each subject's own chat. Once @BotFather has set the menu button, Telegram ignores the API's
   bot-wide one, and a mini app on 127.0.0.1 is for the operators only — so it is set per chat, and moved along when
   a tunnel changes the address. */
const seen = new Set<number>(); // private chats that wrote to the bot during this run
const menuFor = new Map<number, string>(); // chat → address its button opens

function giveMenu(cfg: Config, bot: Bot, id: number) {
  seen.add(id);
  if (!canOpenWebApp(cfg, id) || menuFor.get(id) === cfg.WEBAPP_URL) return;
  menuFor.set(id, cfg.WEBAPP_URL);
  void bot.api.setChatMenuButton({ chat_id: id, menu_button: menuButton(cfg) }).catch(() => menuFor.delete(id));
}

/** every known chat (operators, mini app users, whoever wrote this run) gets the current button, or loses it (`on` false) */
export async function syncMenus(deps: BotDeps, bot: Bot, on = true) {
  const { cfg, db } = deps;
  const known = await db.select({ id: users.id }).from(users).catch(() => [] as { id: number }[]);
  for (const id of new Set([...cfg.ADMIN_IDS, ...seen, ...known.map((u) => u.id)])) {
    const open = on && canOpenWebApp(cfg, id);
    await bot.api.setChatMenuButton({ chat_id: id, menu_button: open ? menuButton(cfg) : { type: 'default' } }).catch(() => {});
    if (open) menuFor.set(id, cfg.WEBAPP_URL);
    else menuFor.delete(id);
  }
}

/** commands, menu button, webhook — safe to call on every start */
export async function setupBot(deps: BotDeps, bot: Bot, mode: 'webhook' | 'polling') {
  const { cfg, log } = deps;
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть центр оформления' },
    { command: 'admin', description: 'Control room (для дежурных)' },
  ]);
  const local = cfg.webAppButtons && cfg.webAppLocal;
  await syncMenus(deps, bot);
  // buttons in messages sent at an old address (a tunnel reconnected, or the shop restarted with a new one)
  if (cfg.webAppButtons && !local) void repointAppButtons(bot, cfg, deps.db, log).catch((e) => log.warn({ err: e }, 'repoint failed'));
  if (cfg.webAppButtons && !local) {
    await bot.api.setChatMenuButton({ menu_button: menuButton(cfg) });
  } else {
    // Telegram silently ignores resetting a bot-wide web_app button set earlier (e.g. a tunnel address that is dead now);
    // only @BotFather removes it, so at least say so
    await bot.api.setChatMenuButton({ menu_button: { type: 'default' } });
    const left = await bot.api.getChatMenuButton();
    if (left.type === 'web_app') log.warn(`menu button still opens ${left.web_app.url} — remove it: @BotFather → /setmenubutton → this bot → /empty`);
    else if (local) log.info('the mini app runs on this computer: menu button only in the ADMIN_IDS chats');
    else log.warn('WEBAPP_URL is not https — no menu button (Telegram requires https outside the test environment)');
  }
  if (mode === 'webhook') {
    const url = `${cfg.PUBLIC_URL.replace(/\/$/, '')}/telegram/webhook`;
    await bot.api.setWebhook(url, { secret_token: cfg.WEBHOOK_SECRET, allowed_updates: [...ALLOWED_UPDATES], drop_pending_updates: false });
    log.info({ url }, 'webhook set');
  }
}
export { ALLOWED_UPDATES };
