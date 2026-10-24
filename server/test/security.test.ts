/* Regression tests for SECURITY_AUDIT.md: each one failed before its fix. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { ApiBootstrap } from '@mrak8/shared';
import { buildApp } from '../src/app.js';
import { signInitData } from '../src/auth.js';
import { createBot } from '../src/bot/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrateDatabase, openDatabase, type Database } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
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
    expect(() => loadConfig({ NODE_ENV: 'development', DEV_AUTH: '1', PUBLIC_URL: 'http://localhost:8080' })).not.toThrow();
  });
});
