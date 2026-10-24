/* Beat grid, key and loudness of a DJ set track: tools/dj-analyze.mjs (essentia.js + ffmpeg) in its own process,
   so seconds of number crunching never block the bot or the API. No ffmpeg / no essentia → null, and the mini app
   simply crossfades that track instead of beatmatching it. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, isNull } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { DjMix } from '@mrak8/shared';
import type { Config } from '../config.js';
import type { DB } from '../db/index.js';
import { djTracks } from '../db/schema.js';
import { cachedFile } from './dj.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/services in development, dist in production — tools/ sits next to src/ and dist/
const TOOL = [resolve(here, '../../tools/dj-analyze.mjs'), resolve(here, '../tools/dj-analyze.mjs')].find((p) => existsSync(p));

export function analyseFile(path: string): Promise<DjMix | null> {
  if (!TOOL) return Promise.resolve(null);
  return new Promise((ok) => {
    execFile(process.execPath, [TOOL, path], { timeout: 180_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err) return ok(null);
      try { ok(JSON.parse(out) as DjMix); } catch { ok(null); }
    });
  });
}

/** download (once) and analyse one track; the result goes straight into dj_tracks.mix */
export async function analyseTrack(cfg: Config, db: DB, bot: Bot, id: number): Promise<DjMix | null> {
  const [t] = await db.select().from(djTracks).where(eq(djTracks.id, id));
  if (!t) return null;
  const mix = await analyseFile(await cachedFile(cfg, bot, t));
  if (mix) await db.update(djTracks).set({ mix }).where(eq(djTracks.id, id));
  return mix;
}

/** at start: tracks that never got analysed (ffmpeg was missing, the server restarted mid-way) get another try */
export async function analysePending(cfg: Config, db: DB, bot: Bot, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }) {
  for (const t of await db.select({ id: djTracks.id, title: djTracks.title }).from(djTracks).where(isNull(djTracks.mix))) {
    try {
      const mix = await analyseTrack(cfg, db, bot, t.id);
      if (mix) log.info(`dj: ${t.title} — ${mix.bpm} BPM, ${mix.key}`);
    } catch (e) { log.warn({ err: e }, 'dj analysis failed'); }
  }
}
