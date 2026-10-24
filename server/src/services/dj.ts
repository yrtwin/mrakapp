/* DJ set. The audio lives in Telegram: an admin sends mp3s to the bot, the DB keeps only file_id + title.
   On the first play the server downloads a track once into MEDIA_DIR/dj and streams it from there (Range too). */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import { resolve } from 'node:path';
import { asc, eq, max } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ApiDjTrack } from '@mrak8/shared';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { djTracks } from '../db/schema.js';

export type DjTrackRow = typeof djTracks.$inferSelect;

export const listTracks = (db: DB) => db.select().from(djTracks).orderBy(asc(djTracks.position), asc(djTracks.id));

export const toApiTracks = (rows: DjTrackRow[]): ApiDjTrack[] => rows.map((t) => ({ id: t.id, title: t.title, performer: t.performer, duration: t.duration, mix: t.mix ?? null }));

/** a sent audio becomes the last track; the same file sent twice is not duplicated */
export async function addTrack(db: DB, a: { file_id: string; file_unique_id: string; title?: string; performer?: string; file_name?: string; duration?: number; file_size?: number }) {
  const [{ last }] = await db.select({ last: max(djTracks.position) }).from(djTracks);
  const title = (a.title || a.file_name?.replace(/\.[a-z0-9]+$/i, '') || 'Без названия').slice(0, 120);
  const [row] = await db
    .insert(djTracks)
    .values({ fileId: a.file_id, fileUniqueId: a.file_unique_id, title, performer: (a.performer ?? '').slice(0, 120), duration: a.duration ?? 0, size: a.file_size ?? 0, position: (last ?? 0) + 1 })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export const removeTrack = (db: DB, id: number) => db.delete(djTracks).where(eq(djTracks.id, id)).returning();

/** swap with the track above and renumber the playlist */
export async function moveUp(db: DB, id: number) {
  const list = await listTracks(db);
  const i = list.findIndex((t) => t.id === id);
  if (i <= 0) return;
  [list[i - 1], list[i]] = [list[i], list[i - 1]];
  for (const [n, t] of list.entries()) await db.update(djTracks).set({ position: n + 1 }).where(eq(djTracks.id, t.id));
}

const download = (url: string, proxy: string) =>
  new Promise<Buffer>((ok, no) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { agent: proxy && url.startsWith('https:') ? new HttpsProxyAgent(proxy) : undefined, timeout: 60_000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); no(new Error(`telegram file ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('telegram file timeout')));
    req.on('error', no);
  });

/** local copy of a track: downloaded from Telegram once (Bot API serves files up to 20 MB) */
export async function cachedFile(cfg: Config, bot: Bot, t: DjTrackRow) {
  const dir = resolve(cfg.MEDIA_DIR, 'dj');
  const path = resolve(dir, `${t.fileUniqueId}.mp3`);
  if (existsSync(path)) return path;
  const f = await bot.api.getFile(t.fileId);
  if (!f.file_path) throw new Error('telegram gave no file path');
  const buf = await download(`${cfg.BOT_API_ROOT.replace(/\/$/, '')}/file/bot${cfg.BOT_TOKEN}/${f.file_path}`, cfg.TELEGRAM_PROXY);
  await mkdir(dir, { recursive: true });
  await writeFile(path, buf);
  return path;
}

/** GET /dj/:id — plain URL for <audio> (it cannot send headers), with Range so phones can seek and stream */
export async function streamTrack(cfg: Config, db: DB, bot: Bot | null, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const [t] = await db.select().from(djTracks).where(eq(djTracks.id, Number(req.params.id)));
  if (!t || !bot) return reply.status(404).send({ error: 'NOT_FOUND' });
  const path = await cachedFile(cfg, bot, t);
  const size = (await stat(path)).size;
  reply.header('content-type', 'audio/mpeg').header('accept-ranges', 'bytes').header('cache-control', 'public, max-age=86400');
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m) return reply.header('content-length', size).send(createReadStream(path));
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return reply.status(416).header('content-range', `bytes */${size}`).send();
  return reply.status(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(createReadStream(path, { start, end }));
}
