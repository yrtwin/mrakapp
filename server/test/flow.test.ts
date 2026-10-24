import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Bot } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deepLink, subjectNo, type ApiBootstrap, type CreateOrderResult } from '@mrak8/shared';
import { buildApp } from '../src/app.js';
import { AuthError, signInitData, validateInitData } from '../src/auth.js';
import { repointAppButtons } from '../src/bot/appButtons.js';
import type { Cdek } from '../src/services/cdek.js';
import { syncShipments } from '../src/services/shipping.js';
import { createBot, notifyDrop, setupBot } from '../src/bot/index.js';
import { canOpenWebApp, loadConfig, setPublicUrl, type Config } from '../src/config.js';
import { migrateDatabase, openDatabase, type Database } from '../src/db/index.js';
import { orders, productSizes } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { launchDueDrops } from '../src/services/catalog.js';
import { expireReservations } from '../src/services/orders.js';
import { createStorage } from '../src/services/storage.js';
import { startFakeBotApi } from './fake-bot-api.js';

const TOKEN = '123456789:TEST-mrak8-token';
const buyer = { id: 5001, first_name: 'Субъект', last_name: 'Восемь', username: 'buyer' };
const rival = { id: 5002, first_name: 'Другой', username: 'rival' };
const admin = { id: 42, first_name: 'Дежурный', username: 'op' };
const silent = { info() {}, warn() {}, error: (...a: unknown[]) => console.error(...a) };
const initData = (u: object, ageSec = 0) => signInitData({ query_id: 'AAEtest', user: JSON.stringify(u), auth_date: String(Math.floor(Date.now() / 1000) - ageSec) }, TOKEN);
const auth = (u: object) => ({ authorization: 'tma ' + initData(u) });

let api: Awaited<ReturnType<typeof startFakeBotApi>>;
let cfg: Config;
let database: Database;
let app: FastifyInstance;
let bot: Bot;
let mediaDir: string;
let updateId = 1;

const sizeRow = async (label: string) => (await database.db.select().from(productSizes).where(eq(productSizes.label, label)))[0];
const protocol = { name: 'Субъект Восемь', phone: '+7 999 008-08-08', delivery: 'cdek', address: 'Москва, ул. Тестовая, 8' };
async function order(u: object, items: { size: string; qty: number }[]) {
  const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth(u) })).json() as ApiBootstrap;
  const p = boot.products.find((x) => x.no === '001')!;
  return app.inject({ method: 'POST', url: '/api/orders', headers: auth(u), payload: { items: items.map((i) => ({ productId: p.id, ...i })), protocol } });
}

beforeAll(async () => {
  api = await startFakeBotApi();
  mediaDir = mkdtempSync(join(tmpdir(), 'mrak8-media-'));
  cfg = loadConfig({
    NODE_ENV: 'test', BOT_TOKEN: TOKEN, BOT_API_ROOT: api.url, PAYMENT_PROVIDER: 'yookassa', PAYMENT_PROVIDER_TOKEN: '381764678:TEST:100500',
    ADMIN_IDS: '42', ADMIN_CHAT_ID: '-1001234', CHANNEL_ID: '@mrak8_test', MEDIA_DIR: mediaDir,
    WEBAPP_URL: 'https://app.mrak8.test', PUBLIC_URL: 'https://api.mrak8.test', MINIAPP_LINK: 'https://t.me/mrak8_test_bot/shop',
  });
  database = await openDatabase('', 'memory://');
  await migrateDatabase(database);
  const storage = createStorage(cfg);
  await seed(database.db, storage, { images: true });
  bot = createBot({ cfg, db: database.db, storage, log: silent });
  await bot.init();
  app = await buildApp({ cfg, db: database.db, storage, bot, botMode: 'polling' });
});

afterAll(async () => {
  await app?.close();
  await database?.close();
  await api?.close();
  rmSync(mediaDir, { recursive: true, force: true });
});

describe('initData', () => {
  it('accepts a correctly signed payload', () => {
    const d = validateInitData(initData(buyer), TOKEN);
    expect(d.user.id).toBe(5001);
  });
  it('rejects tampering, a foreign bot token and stale data', () => {
    const forged = initData(buyer).replace(encodeURIComponent('"id":5001'), encodeURIComponent('"id":42'));
    expect(() => validateInitData(forged, TOKEN)).toThrow(AuthError);
    expect(() => validateInitData(initData(buyer), '999:OTHER')).toThrow(AuthError);
    expect(() => validateInitData(initData(buyer, 90_000), TOKEN, 86400)).toThrow(/expired/);
  });
  it('guards every API call', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/bootstrap', headers: { authorization: 'tma hash=deadbeef' } })).statusCode).toBe(401);
  });
});

describe('catalog', () => {
  it('serves the seeded hoodie with cut-out photos, sizes and the subject number', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth(buyer) });
    expect(res.statusCode).toBe(200);
    const b = res.json() as ApiBootstrap;
    expect(b.me.subjectNo).toBe(subjectNo(5001));
    expect(b.me.isAdmin).toBe(false);
    const p = b.products.find((x) => x.no === '001')!;
    expect(p.title).toBe('ZIP-HOODIE «НЕ ДИЗАЙНЕР»');
    expect(p.images.front?.alpha).toBe(true);
    expect(p.images.front?.widths).toEqual([360, 720, 1200, 2400]);
    expect(p.images.back?.formats).toEqual(['avif', 'webp']);
    expect(p.sizes.map((s) => `${s.label}:${s.available}`)).toEqual(['XS:2', 'S:6', 'M:9', 'L:3', 'XL:0']);
    expect(b.delivery.map((d) => d.key)).toEqual(['cdek', 'post', 'pickup']);
    expect(b.config.paymentsLive).toBe(true);
    expect(b.config.testMode).toBe(true);
  });
});

describe('payment flow (Telegram Payments + ЮKassa, test token)', () => {
  let created: CreateOrderResult;
  let payload = '';

  it('creates the order from DB prices, reserves stock and builds an invoice with a 54-ФЗ receipt', async () => {
    const res = await order(buyer, [{ size: 'M', qty: 1 }]);
    expect(res.statusCode).toBe(200);
    created = res.json();
    expect(created.order.no).toMatch(/^MRK-\d{6}$/);
    expect(created.order.total).toBe(6900 + 390);
    expect(created.invoiceLink).toMatch(/^https:\/\/t\.me\/\$invoice-/);
    const call = api.of('createInvoiceLink').at(-1)!.body;
    payload = call.payload;
    expect(call.currency).toBe('RUB');
    expect(call.provider_token).toBe('381764678:TEST:100500');
    expect(call.prices.reduce((a: number, p: { amount: number }) => a + p.amount, 0)).toBe(729000);
    expect(call.need_phone_number).toBe(true);
    expect(call.send_phone_number_to_provider).toBe(true);
    const receipt = JSON.parse(call.provider_data).receipt;
    const sum = receipt.items.reduce((a: number, i: { amount: { value: string }; quantity: string }) => a + Number(i.amount.value) * Number(i.quantity), 0);
    expect(sum).toBe(7290);
    expect(receipt.items[0]).toMatchObject({ vat_code: 1, payment_mode: 'full_payment', payment_subject: 'commodity' });
    expect(receipt.items[1]).toMatchObject({ payment_subject: 'service' });
    expect(receipt.customer.phone).toBe('79990080808');
    const m = await sizeRow('M');
    expect(m.reserved).toBe(1);
  });

  it('client prices are ignored', async () => {
    const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap', headers: auth(rival) })).json() as ApiBootstrap;
    const p = boot.products.find((x) => x.no === '001')!;
    const res = await app.inject({ method: 'POST', url: '/api/orders', headers: auth(rival), payload: { items: [{ productId: p.id, size: 'S', qty: 1, price: 1 }], protocol: { ...protocol, delivery: 'pickup' } } });
    expect(res.json().order.total).toBe(6900);
    await app.inject({ method: 'POST', url: `/api/orders/${res.json().order.no}/cancel`, headers: auth(rival) });
    expect((await sizeRow('S')).reserved).toBe(0);
  });

  it('pre_checkout_query: wrong amount is declined, the right one is approved', async () => {
    await bot.handleUpdate({ update_id: updateId++, pre_checkout_query: { id: 'pcq-bad', from: { ...buyer, is_bot: false }, currency: 'RUB', total_amount: 100, invoice_payload: payload } });
    const bad = api.of('answerPreCheckoutQuery').at(-1)!.body;
    expect(bad.ok).toBe(false);
    expect(bad.error_message).toMatch(/Сумма/);
    await bot.handleUpdate({ update_id: updateId++, pre_checkout_query: { id: 'pcq-ok', from: { ...buyer, is_bot: false }, currency: 'RUB', total_amount: 729000, invoice_payload: payload } });
    expect(api.of('answerPreCheckoutQuery').at(-1)!.body).toMatchObject({ pre_checkout_query_id: 'pcq-ok', ok: true });
  });

  const paidUpdate = () => ({
    update_id: updateId++,
    message: {
      message_id: 900, date: Math.floor(Date.now() / 1000), chat: { id: buyer.id, type: 'private' as const, first_name: buyer.first_name }, from: { ...buyer, is_bot: false },
      successful_payment: { currency: 'RUB', total_amount: 729000, invoice_payload: payload, telegram_payment_charge_id: 'tg-charge-1', provider_payment_charge_id: 'yk-charge-1' },
    },
  });

  it('successful_payment: order paid, stock written off, receipt to the subject, alert to admins', async () => {
    const before = api.of('sendMessage').length;
    await bot.handleUpdate(paidUpdate());
    const [o] = await database.db.select().from(orders).where(eq(orders.payload, payload));
    expect(o.status).toBe('paid');
    expect(o.telegramChargeId).toBe('tg-charge-1');
    expect(o.providerChargeId).toBe('yk-charge-1');
    const m = await sizeRow('M');
    expect([m.stock, m.reserved]).toEqual([8, 0]);
    const sent = api.of('sendMessage').slice(before);
    expect(sent.map((c) => String(c.body.chat_id))).toEqual(['5001', '-1001234']);
    expect(sent[0].body.text).toContain('ОФОРМЛЕН');
    expect(sent[0].body.text).toContain(created.order.no);
  });

  it('a repeated webhook does nothing twice (idempotent)', async () => {
    const before = api.of('sendMessage').length;
    await bot.handleUpdate(paidUpdate());
    expect(api.of('sendMessage').length).toBe(before);
    expect((await sizeRow('M')).stock).toBe(8);
  });

  it('the dossier shows the case', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/orders', headers: auth(buyer) })).json();
    expect(list[0]).toMatchObject({ no: created.order.no, status: 'paid', total: 7290 });
  });
});

describe('stock and reserves', () => {
  it('refuses more than is left and seized sizes', async () => {
    expect((await order(rival, [{ size: 'XS', qty: 3 }])).json()).toMatchObject({ error: 'OUT_OF_STOCK' });
    expect((await order(rival, [{ size: 'XL', qty: 1 }])).statusCode).toBe(409);
  });

  it('a reserve expires after RESERVE_MINUTES and can be re-taken at pre-checkout', async () => {
    const res = await order(rival, [{ size: 'L', qty: 2 }]);
    expect(res.statusCode).toBe(200);
    expect((await sizeRow('L')).reserved).toBe(2);
    const expired = await expireReservations(database.db, new Date(Date.now() + 16 * 60_000));
    expect(expired).toContain(res.json().order.no);
    expect((await sizeRow('L')).reserved).toBe(0);
    const [o] = await database.db.select().from(orders).where(eq(orders.no, res.json().order.no));
    await bot.handleUpdate({ update_id: updateId++, pre_checkout_query: { id: 'pcq-late', from: { ...rival, is_bot: false }, currency: 'RUB', total_amount: o.total * 100, invoice_payload: o.payload } });
    expect(api.of('answerPreCheckoutQuery').at(-1)!.body.ok).toBe(true);
    expect((await sizeRow('L')).reserved).toBe(2);
  });

  it('one subject never holds two reserves', async () => {
    await order(rival, [{ size: 'XS', qty: 1 }]);
    expect((await sizeRow('L')).reserved).toBe(0); // previous pending order cancelled
    expect((await sizeRow('XS')).reserved).toBe(1);
  });
});

describe('chat catalog (for buyers and payment-provider moderation)', () => {
  const msg = (text: string, u: { id: number; first_name: string } = buyer) => ({ update_id: updateId++, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: u.id, type: 'private' as const, first_name: u.first_name }, from: { ...u, is_bot: false }, text, entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0].length }] } });
  it('/start lists goods with prices and order buttons', async () => {
    await bot.handleUpdate(msg('/start'));
    const m = api.of('sendMessage').at(-1)!.body;
    expect(m.text).toContain('ZIP-HOODIE «НЕ ДИЗАЙНЕР»');
    expect(m.text).toContain('6 900 ₽');
    expect(JSON.stringify(m.reply_markup)).toContain('p:');
    expect(JSON.stringify(m.reply_markup)).toContain('web_app'); // https WEBAPP_URL in tests
  });
  it('a product card comes with the photo and size buttons', async () => {
    const before = api.of('sendPhoto').length;
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: 'cb1', chat_instance: 'x', from: { ...buyer, is_bot: false }, data: 'p:1', message: { message_id: 2, date: 0, chat: { id: buyer.id, type: 'private' as const, first_name: 'S' } } } });
    expect(api.of('sendPhoto').length).toBe(before + 1);
    const ph = api.of('sendPhoto').at(-1)!.body;
    expect(ph.caption).toContain('Цена');
    expect(ph.reply_markup).toContain('s:1:M');
  });
  it('deep links: a plain bot link goes through /start (no Main Mini App → «bot invalid»), a named app keeps startapp', () => {
    expect(deepLink('https://t.me/mrak8_shop_bot', 'order_MRK-000009')).toBe('https://t.me/mrak8_shop_bot?start=order_MRK-000009');
    expect(deepLink('https://t.me/mrak8_bot/shop', 'product_1')).toBe('https://t.me/mrak8_bot/shop?startapp=product_1');
  });
  it('/start order_<no> gives the owner a button into the case', async () => {
    const [o] = await database.db.select().from(orders).where(eq(orders.userId, buyer.id));
    await bot.handleUpdate(msg(`/start order_${o.no}`));
    const m = api.of('sendMessage').at(-1)!.body;
    expect(m.text).toContain(`CASE #${o.no}`);
    expect(JSON.stringify(m.reply_markup)).toContain(`startapp=order_${o.no}`);
  });
  it('«О магазине» links the Instagram profile instead of a Telegram @mention', async () => {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: 'cb2', chat_instance: 'x', from: { ...buyer, is_bot: false }, data: 'info:about', message: { message_id: 3, date: 0, chat: { id: buyer.id, type: 'private' as const, first_name: 'S' } } } });
    expect(api.of('sendMessage').at(-1)!.body.text).toContain('<a href="https://www.instagram.com/mrak8.merch/">@mrak8.merch</a>');
  });
  it('after a tunnel moves the mini app, buttons in old messages are re-pointed to the new address', async () => {
    const mcfg = loadConfig({ NODE_ENV: 'test', BOT_TOKEN: TOKEN, BOT_API_ROOT: api.url, WEBAPP_URL: 'https://old.lhr.life', ADMIN_IDS: '42', MEDIA_DIR: mediaDir });
    const moving = createBot({ cfg: mcfg, db: database.db, storage: createStorage(mcfg), log: silent });
    await moving.init();
    await moving.handleUpdate(msg('/start'));
    await new Promise((r) => setTimeout(r, 50)); // the tracker stores the message in the background
    setPublicUrl(mcfg, 'https://new.lhr.life');
    const before = api.of('editMessageReplyMarkup').length;
    await repointAppButtons(moving, mcfg, database.db, silent);
    const edits = api.of('editMessageReplyMarkup').slice(before).map((c) => JSON.stringify(c.body));
    expect(edits.some((e) => e.includes('"chat_id":5001') && e.includes('https://new.lhr.life/'))).toBe(true);
    expect(edits.some((e) => e.includes('https://old.lhr.life'))).toBe(false);
  });
  it('in the Telegram test environment the mini app opens from plain http://127.0.0.1', async () => {
    const tcfg = loadConfig({ NODE_ENV: 'test', BOT_TOKEN: TOKEN, BOT_API_ROOT: api.url, TELEGRAM_ENV: 'test', WEBAPP_URL: 'http://127.0.0.1:8088', MEDIA_DIR: mediaDir });
    const local = createBot({ cfg: tcfg, db: database.db, storage: createStorage(tcfg), log: silent });
    await local.init();
    await local.handleUpdate(msg('/start'));
    const call = api.of('sendMessage').at(-1)!;
    expect(call.test).toBe(true);
    expect(JSON.stringify(call.body.reply_markup)).toContain('"web_app":{"url":"http://127.0.0.1:8088/"}');
  });
  it('a mini app on this computer (https://127.0.0.1) is offered to the operators only', async () => {
    const lcfg = loadConfig({ NODE_ENV: 'test', BOT_TOKEN: TOKEN, BOT_API_ROOT: api.url, WEBAPP_URL: 'https://127.0.0.1:8443', ADMIN_IDS: '42', MEDIA_DIR: mediaDir });
    const deps = { cfg: lcfg, db: database.db, storage: createStorage(lcfg), log: silent };
    const local = createBot(deps);
    await local.init();
    await local.handleUpdate(msg('/start'));
    expect(JSON.stringify(api.of('sendMessage').at(-1)!.body.reply_markup)).not.toContain('web_app');
    await local.handleUpdate(msg('/start', admin));
    expect(JSON.stringify(api.of('sendMessage').at(-1)!.body.reply_markup)).toContain('https://127.0.0.1:8443/');
    const before = api.of('setChatMenuButton').length;
    await setupBot(deps, local, 'polling');
    const set = api.of('setChatMenuButton').slice(before);
    expect(set.find((c) => String(c.body.chat_id) === '42')?.body.menu_button.type).toBe('web_app');
    expect(set.filter((c) => !c.body.chat_id).every((c) => c.body.menu_button.type === 'default')).toBe(true);
  });
});

describe('public url (docker:public tunnel)', () => {
  it('moving from this computer to a tunnel address opens the mini app buttons to everyone', () => {
    const c = loadConfig({ NODE_ENV: 'test', WEBAPP_URL: 'https://127.0.0.1:8443', ADMIN_IDS: '42' });
    expect([canOpenWebApp(c, buyer.id), canOpenWebApp(c, admin.id)]).toEqual([false, true]);
    setPublicUrl(c, 'https://8f122671ee6e83.lhr.life');
    expect([c.WEBAPP_URL, c.PUBLIC_URL]).toEqual(['https://8f122671ee6e83.lhr.life', 'https://8f122671ee6e83.lhr.life']);
    expect(canOpenWebApp(c, buyer.id)).toBe(true);
  });
});

describe('control room', () => {
  it('is closed for subjects, open for ADMIN_IDS', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: auth(buyer) })).statusCode).toBe(403);
    const d = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: auth(admin) });
    expect(d.statusCode).toBe(200);
    expect(d.json().revenueToday).toBe(7290);
    expect(d.json().top.no).toBe('001');
  });

  it('a track number ships the order and the bot tells the subject', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/admin/orders?status=paid', headers: auth(admin) })).json();
    const no = list[0].no;
    const res = await app.inject({ method: 'PATCH', url: `/api/admin/orders/${no}`, headers: auth(admin), payload: { trackNo: '10045522871' } });
    expect(res.json()).toMatchObject({ status: 'shipped', trackNo: '10045522871', notified: true });
    const msg = api.of('sendMessage').at(-1)!.body;
    expect(String(msg.chat_id)).toBe('5001');
    expect(msg.text).toContain('10045522871');
    expect(JSON.stringify(msg.reply_markup)).toContain('https://www.cdek.ru/ru/tracking/?order_id=10045522871');
  });

  it('exports CSV and announces in the channel with a deep link button', async () => {
    const csv = await app.inject({ method: 'GET', url: '/api/admin/orders.csv', headers: auth(admin) });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('MRK-');
    const products = (await app.inject({ method: 'GET', url: '/api/admin/products', headers: auth(admin) })).json();
    const res = await app.inject({ method: 'POST', url: `/api/admin/products/${products[0].id}/announce`, headers: auth(admin), payload: {} });
    expect(res.statusCode).toBe(200);
    const photo = api.of('sendPhoto').at(-1)!.body;
    expect(photo.chat_id).toBe('@mrak8_test');
    expect(photo.reply_markup).toContain(`startapp=product_${products[0].id}`);
  });

  it('a scheduled drop goes live and watchers get a message', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/admin/products', headers: auth(admin),
      payload: { no: '004', slug: 'longsleeve-intake', title: 'ЛОНГСЛИВ «INTAKE»', name: 'ЛОНГСЛИВ', sub: '«INTAKE»', category: 'tee', price: 4900, oldPrice: null, color: 'ЧЁРНЫЙ', batch: '1/40', status: 'drop', dropAt: new Date(Date.now() - 1000).toISOString(), proto: [], hotspots: { front: [], back: [] }, sizes: [{ label: 'M', stock: 5, heightMin: 171, heightMax: 179, length: 70, width: 58, sleeve: 62 }] },
    });
    expect(res.statusCode).toBe(200);
    const id = res.json().id;
    expect((await app.inject({ method: 'POST', url: `/api/drops/${id}/watch`, headers: auth(buyer), payload: { on: true } })).json()).toMatchObject({ on: true });
    const launched = await launchDueDrops(database.db);
    expect(launched).toContain(id);
    const sent = await notifyDrop({ cfg, db: database.db, storage: createStorage(cfg), log: silent }, bot, id);
    expect(sent).toBe(1);
    expect(api.of('sendMessage').at(-1)!.body.text).toContain('ДРОП ОТКРЫТ');
  });

  it('shareMessage gets a prepared inline message', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/orders', headers: auth(buyer) })).json();
    const res = await app.inject({ method: 'POST', url: `/api/share/${list[0].no}`, headers: auth(buyer) });
    expect(res.json()).toEqual({ id: 'prep-1' });
    expect(api.of('savePreparedInlineMessage').at(-1)!.body.result.photo_url).toBe('https://app.mrak8.test/share/booked.jpg');
  });
});

describe('СДЭК: priced by the server, handed over after payment, tracked', () => {
  const courier = { id: 5003, first_name: 'Получатель', username: 'pvz' };
  const fake: Cdek = {
    cities: async () => [{ code: 137, name: 'Санкт-Петербург' }],
    points: async () => [{ code: 'SPB1', name: 'SPB1', address: 'Лиговский пр., 50', workTime: 'Пн-Вс 10-21', metro: 'Площадь Восстания', lat: 59.92, lon: 30.36 }],
    quote: async (_city, mode) => ({ price: mode === 'pvz' ? 200 : 350, daysMin: 1, daysMax: 2 }),
    createShipment: async () => ({ uuid: 'cdek-uuid-1' }),
    shipment: async () => ({ number: '1110042895', status: 'RECEIVED_AT_SHIPMENT_WAREHOUSE', statusName: 'Принят на склад отправителя' }),
    waybill: async () => Buffer.from('%PDF-1.4'),
  };
  let withCdek: FastifyInstance;
  beforeAll(async () => { withCdek = await buildApp({ cfg, db: database.db, storage: createStorage(cfg), bot, botMode: 'polling', cdek: fake }); });

  it('the delivery price is the server’s CDEK quote, the pickup point address comes from CDEK', async () => {
    const boot = (await withCdek.inject({ method: 'GET', url: '/api/bootstrap', headers: auth(courier) })).json() as ApiBootstrap;
    expect(boot.config.cdek).toBe(true);
    const p = boot.products.find((x) => x.no === '001')!;
    const size = p.sizes.find((s) => s.available > 0)!.label;
    const res = await withCdek.inject({ method: 'POST', url: '/api/orders', headers: auth(courier), payload: { items: [{ productId: p.id, size, qty: 1 }], protocol: { ...protocol, delivery: 'cdek', address: '', cdek: { cityCode: 137, city: 'Санкт-Петербург', mode: 'pvz', pvzCode: 'SPB1' } } } });
    expect(res.statusCode).toBe(200);
    const o = (res.json() as CreateOrderResult).order;
    expect(o.delivery).toMatchObject({ title: 'СДЭК · пункт выдачи', price: 200 });
    expect(o.total).toBe(p.price + 200);

    const paid = await withCdek.inject({ method: 'POST', url: `/api/dev/pay/${o.no}`, headers: auth(courier) });
    expect(paid.statusCode).toBe(200);
    const [row] = await database.db.select().from(orders).where(eq(orders.no, o.no));
    expect(row.cdek).toMatchObject({ uuid: 'cdek-uuid-1', pvzCode: 'SPB1', pvzAddress: 'Лиговский пр., 50' });
    expect(row.address).toContain('ПВЗ SPB1');

    const told: string[] = [];
    await syncShipments(database.db, fake, silent, async (u) => { told.push(`${u.status}:${u.trackNo}`); });
    const [after] = await database.db.select().from(orders).where(eq(orders.no, o.no));
    expect([after.status, after.trackNo]).toEqual(['shipped', '1110042895']);
    expect(told).toEqual(['shipped:1110042895']);
  });

  it('a pickup point of another city is refused', async () => {
    const boot = (await withCdek.inject({ method: 'GET', url: '/api/bootstrap', headers: auth(courier) })).json() as ApiBootstrap;
    const p = boot.products.find((x) => x.no === '001')!;
    const res = await withCdek.inject({ method: 'POST', url: '/api/orders', headers: auth(courier), payload: { items: [{ productId: p.id, size: p.sizes.find((s) => s.available > 0)!.label, qty: 1 }], protocol: { ...protocol, delivery: 'cdek', cdek: { cityCode: 137, city: 'Санкт-Петербург', mode: 'pvz', pvzCode: 'MSK2' } } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_PVZ');
  });
});

describe('DJ set: tracks live in Telegram', () => {
  const audio = (from: { id: number; first_name: string }) => ({
    update_id: updateId++,
    message: {
      message_id: 9, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: 'private' as const, first_name: from.first_name }, from: { ...from, is_bot: false },
      audio: { file_id: 'AUDIO1', file_unique_id: 'UNI1', duration: 150, performer: 'VILLIAN, madk1d', title: 'ДИНАСТИЯ', file_size: 2_400_000 },
    },
  });
  it('an admin’s mp3 joins the playlist, a buyer’s does not; the audio streams, with Range', async () => {
    await bot.handleUpdate(audio(buyer));
    expect((await app.inject({ method: 'GET', url: '/api/dj', headers: auth(buyer) })).json()).toEqual([]);
    await bot.handleUpdate(audio(admin));
    expect(api.of('sendMessage').at(-1)!.body.text).toContain('Добавлено в DJ-сет');
    const list = (await app.inject({ method: 'GET', url: '/api/dj', headers: auth(buyer) })).json();
    expect(list).toMatchObject([{ title: 'ДИНАСТИЯ', performer: 'VILLIAN, madk1d', duration: 150 }]);
    const full = await app.inject({ method: 'GET', url: `/dj/${list[0].id}` });
    expect([full.statusCode, full.body]).toEqual([200, 'ID3-fake-mp3-bytes']);
    const part = await app.inject({ method: 'GET', url: `/dj/${list[0].id}`, headers: { range: 'bytes=0-2' } });
    expect([part.statusCode, part.body, part.headers['content-range']]).toEqual([206, 'ID3', 'bytes 0-2/18']);
    await bot.handleUpdate(audio(admin));
    expect(api.of('sendMessage').at(-1)!.body.text).toContain('уже в DJ-сете');
  });
});
