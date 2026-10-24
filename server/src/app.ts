import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { webhookCallback, type Bot } from 'grammy';
import { ZodError } from 'zod';
import { subjectNo } from '@mrak8/shared';
import { AuthError, validateInitData, type TgUser } from './auth.js';
import { weakWebhookSecret, type Config } from './config.js';
import type { DB } from './db/index.js';
import { users } from './db/schema.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';
import { CdekError, type Cdek } from './services/cdek.js';
import { OrderError } from './services/orders.js';
import type { Storage } from './services/storage.js';

export interface AppCtx {
  cfg: Config;
  db: DB;
  storage: Storage;
  bot: Bot | null;
  botMode: 'webhook' | 'polling' | 'off';
  cdek?: Cdek | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    tg: { user: TgUser; subjectNo: string; isAdmin: boolean; startParam?: string } | null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export async function upsertUser(db: DB, u: TgUser) {
  const sn = subjectNo(u.id);
  await db
    .insert(users)
    .values({ id: u.id, username: u.username ?? null, firstName: u.first_name ?? '', lastName: u.last_name ?? '', photoUrl: u.photo_url ?? null, languageCode: u.language_code ?? null, subjectNo: sn })
    .onConflictDoUpdate({
      target: users.id,
      set: { username: u.username ?? null, firstName: u.first_name ?? '', lastName: u.last_name ?? '', photoUrl: u.photo_url ?? null, languageCode: u.language_code ?? null, lastSeenAt: new Date() },
    });
  return sn;
}

export async function buildApp(ctx: AppCtx): Promise<FastifyInstance> {
  const { cfg, db, storage, bot } = ctx;
  const app = Fastify({
    logger: cfg.NODE_ENV === 'test' ? false : { level: 'info', transport: cfg.isProd ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname', singleLine: true } } },
    bodyLimit: 1_048_576,
    trustProxy: true,
  });

  const origins = [cfg.WEBAPP_URL, ...cfg.CORS_ORIGINS.split(',')].map((s) => s.trim()).filter(Boolean).map((u) => { try { return new URL(u).origin; } catch { return u; } });
  await app.register(cors, { origin: cfg.isProd ? origins : true, allowedHeaders: ['authorization', 'content-type', 'x-dev-user'], methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10 } });
  if (storage.localDir) {
    await app.register(fastifyStatic, { root: storage.localDir, prefix: '/media/', decorateReply: false, maxAge: '365d', immutable: true });
  }

  app.decorateRequest('tg', null);

  // every /api call carries Telegram initData: Authorization: tma <initData>
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/health')) return;
    const h = req.headers.authorization || '';
    let user: TgUser | null = null;
    let startParam: string | undefined;
    if (h.startsWith('tma ')) {
      const d = validateInitData(h.slice(4), cfg.BOT_TOKEN, cfg.INIT_DATA_MAX_AGE);
      user = d.user;
      startParam = d.startParam;
    } else if (cfg.DEV_AUTH && !cfg.isProd) {
      // local browser development only: X-Dev-User: {"id":1,"first_name":"Dev"}
      const raw = req.headers['x-dev-user'];
      try { const v = String(raw || ''); user = JSON.parse(v.startsWith('%7B') ? decodeURIComponent(v) : v); } catch { user = null; }
      if (!user || typeof user.id !== 'number') user = { id: 1, first_name: 'Dev', username: 'dev_subject' };
    }
    if (!user) return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Откройте мини-апп из Telegram' });
    const sn = await upsertUser(db, user);
    req.tg = { user, subjectNo: sn, isAdmin: cfg.ADMIN_IDS.includes(user.id), startParam };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof AuthError) return reply.status(401).send({ error: 'UNAUTHORIZED', message: err.message });
    if (err instanceof OrderError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof CdekError) return reply.status(502).send({ error: 'CDEK', message: `СДЭК: ${err.message}` });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'BAD_REQUEST', message: 'Протокол заполнен неверно', issues: err.issues.map((i) => i.path.join('.')) });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'BAD_REQUEST', message: err.message });
    req.log.error({ err }, 'unhandled');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Связь с центром потеряна' });
  });

  app.get('/api/health', async () => ({ ok: true, bot: ctx.botMode, time: new Date().toISOString() }));

  if (bot && ctx.botMode === 'webhook') {
    if (weakWebhookSecret(cfg.WEBHOOK_SECRET)) throw new Error('webhook mode needs a strong WEBHOOK_SECRET (openssl rand -hex 32)');
    app.post('/telegram/webhook', webhookCallback(bot, 'fastify', { secretToken: cfg.WEBHOOK_SECRET }));
  }

  await app.register(publicRoutes(ctx));
  await app.register(adminRoutes(ctx), { prefix: '/api/admin' });

  // optional: serve the built mini app from the same origin (single deploy)
  const webDist = [resolve(here, '../../web/dist'), resolve(here, '../web/dist'), resolve(process.cwd(), '../web/dist')].find((p) => existsSync(resolve(p, 'index.html')));
  if (cfg.SERVE_WEB && webDist) {
    // Telegram's webview caches hard: index.html is always revalidated, hashed /assets/* are immutable
    const cacheFor = (file: string) => (/[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, decorateReply: true, cacheControl: false, setHeaders: (res, file) => { res.header('cache-control', cacheFor(file)); } });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/media/')) return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply.status(404).send({ error: 'NOT_FOUND' });
    });
  }
  return app;
}
