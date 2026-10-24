/* DJ set: the tracks admins send to the bot (/dj) mixed like a DJ would, from the beat grid and key the server
   works out when a track is added (services/djAnalyze.ts):
   - next track = closest tempo (×½/×2 allowed) and a neighbouring Camelot key, a fresh round once all have played;
   - tempos within MAX_STRETCH: the incoming track is sped up/slowed to the outgoing one, its first downbeat lands on
     the outgoing track's last full 8-bar phrase, bass swap halfway through the blend, then it eases back to its own tempo;
   - tempos too far apart: a cut on the downbeat; a track without analysis: a plain crossfade at the end.
   Everything is scheduled on the AudioContext clock, so pause is just suspending the context.
   Webviews only play sound after a tap, so it starts with the subject's first touch (skipping the splash counts)
   unless they switched it off; pauses while the app is hidden. */
import { create } from 'zustand';
import type { ApiDjTrack, DjMix } from '@mrak8/shared';
import { api } from '../lib/api';
import { haptic } from '../lib/telegram';
import { toast } from '../lib/store';

type Meta = DjMix;
type Track = { src: string; title: string; m?: Meta };
// the playlist comes from the server (GET /api/dj); the audio itself from /dj/<id>
let TRACKS: Track[] = [];
const base = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const toTrack = (t: ApiDjTrack): Track => ({ src: `${base}/dj/${t.id}`, title: t.performer ? `${t.performer} — ${t.title}` : t.title, m: t.mix ?? undefined });
const VOL = 0.7;
const REF_DB = -6; // tracks are levelled to this loudness (tracks.json db), never pushed above VOL
const PHRASE = 8; // bars in a phrase = bars in a blend
const MAX_STRETCH = 0.08; // ±8 % tempo change is the most a blend may use
const FADE = 6; // seconds, crossfade for tracks without analysis
const KILL = -40; // dB, the low shelf of a track whose bass is out
const KEY = 'm8:dj';
const pref = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const save = (v: 'on' | 'off') => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

export const useDj = create<{ on: boolean; title: string; ready: boolean }>(() => ({ on: false, title: '', ready: false }));

// playback rate that puts `to` on `from`'s tempo (half/double time counts as the same tempo)
const stretch = (from?: Meta, to?: Meta) => {
  if (!from || !to) return null;
  return [0.5, 1, 2].map((f) => from.bpm / (to.bpm * f)).reduce((a, b) => (Math.abs(b - 1) < Math.abs(a - 1) ? b : a));
};
const keyCost = (a?: Meta, b?: Meta) => {
  if (!a || !b) return 1;
  const [na, la, nb, lb] = [parseInt(a.key), a.key.slice(-1), parseInt(b.key), b.key.slice(-1)];
  const d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (d === 0) return la === lb ? 0 : 0.3; // same key / relative major-minor
  return d === 1 && la === lb ? 0.2 : 1; // one step around the wheel / a clash
};
const level = (t: Track) => VOL * Math.min(1, t.m ? 10 ** ((REF_DB - t.m.db) / 20) : 1);

let played = new Set<Track>();
const bad = new Set<Track>();
const pick = (cur?: Track) => {
  let pool = TRACKS.filter((t) => !played.has(t) && !bad.has(t) && t !== cur);
  if (!pool.length) { played = new Set(cur ? [cur] : []); pool = TRACKS.filter((t) => !bad.has(t) && t !== cur); }
  if (!pool.length) pool = TRACKS.filter((t) => !bad.has(t));
  const score = (t: Track) => {
    const r = stretch(cur?.m, t.m);
    return (r === null ? 2 : Math.min(Math.abs(r - 1) * 10, 2)) + keyCost(cur?.m, t.m) + Math.random() * (cur ? 0.5 : 10);
  };
  const t = pool.sort((a, b) => score(a) - score(b))[0];
  if (t) played.add(t);
  return t;
};

type Deck = {
  t: Track; src: AudioBufferSourceNode; low: BiquadFilterNode; g: GainNode;
  from: number; // ctx time it comes in
  at: number; pos: number; // from ctx time `at` on, the track plays at rate 1 from position `pos`
  stop: number; // ctx time it is done (Infinity while it is the main track)
};
let ctx: AudioContext | null = null;
let deck: Deck | null = null; // the main track
let next: Deck | null = null; // scheduled to come in
let gone: Deck | null = null; // mixing out
let resume = false;
let session = 0; // bumps when the set restarts, so a slow decode from before does not land in it

const load = (t: Track) => fetch(t.src).then((r) => r.arrayBuffer()).then((b) => ctx!.decodeAudioData(b));

const deckFor = (t: Track, buf: AudioBuffer): Deck => {
  const src = ctx!.createBufferSource();
  src.buffer = buf;
  const low = ctx!.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 220;
  const g = ctx!.createGain();
  g.gain.value = 0;
  src.connect(low).connect(g).connect(ctx!.destination);
  return { t, src, low, g, from: 0, at: 0, pos: 0, stop: Infinity };
};

const drop = (d: Deck) => {
  try { d.src.stop(); } catch { /* never started */ }
  d.src.disconnect(); d.g.disconnect(); // decoded audio is ~80 MB a track: let it go
};

// plan how the main track hands over to the next one
async function queue() {
  const cur = deck!, s = session;
  const t = pick(cur.t);
  if (!t) return;
  let buf: AudioBuffer;
  try { buf = await load(t); } catch { bad.add(t); if (s === session && cur === deck) void queue(); return; }
  if (s !== session || cur !== deck) return;
  const inc = deckFor(t, buf), a = cur.t.m, b = t.m, lv = level(t);
  const rate = stretch(a, b);
  const blend = rate !== null && Math.abs(rate - 1) <= MAX_STRETCH;
  const earliest = Math.max(ctx!.currentTime + 1, cur.at); // decoding took a while: never schedule into the past
  const posAt = (time: number) => cur.pos + (time - cur.at);
  const end = a?.end ?? cur.src.buffer!.duration;
  let out: number, len: number; // where the outgoing track hands over (its own seconds) and for how long
  if (a) {
    const bar = (4 * 60) / a.bpm;
    len = blend ? PHRASE * bar : bar / 2;
    // the last whole phrase that still fits, or the next downbeat if we are already past it
    const k = Math.floor((end - len - a.beat) / (PHRASE * bar));
    out = a.beat + k * PHRASE * bar;
    if (out < posAt(earliest)) out = a.beat + Math.ceil((posAt(earliest) - a.beat) / bar) * bar;
  } else {
    len = FADE;
    out = Math.max(end - FADE, posAt(earliest));
  }
  const when = cur.at + (out - cur.pos);
  const half = when + len / 2, done = when + len;
  const offset = b?.beat ?? 0;

  const r = blend ? rate! : 1;
  inc.src.playbackRate.value = r;
  inc.src.start(when, offset);
  inc.from = when;
  if (blend) {
    // bass swap on the middle downbeat: never two kicks and two basslines at once
    inc.low.gain.value = KILL;
    inc.low.gain.setValueAtTime(0, half);
    cur.low.gain.setValueAtTime(KILL, half);
    inc.g.gain.setValueAtTime(0, when);
    inc.g.gain.linearRampToValueAtTime(lv, half);
    cur.g.gain.setValueAtTime(cur.g.gain.value, half);
    cur.g.gain.linearRampToValueAtTime(0, done);
    // back to its own tempo over the next phrase, then the position runs at rate 1 again
    const ease = PHRASE * (4 * 60) / b!.bpm;
    inc.src.playbackRate.setValueAtTime(r, done);
    inc.src.playbackRate.linearRampToValueAtTime(1, done + ease);
    inc.at = done + ease;
    inc.pos = offset + r * len + (ease * (r + 1)) / 2;
  } else {
    inc.g.gain.setValueAtTime(0, when);
    inc.g.gain.linearRampToValueAtTime(lv, when + (a ? 0.05 : len)); // a cut slams in, an unanalysed track fades
    cur.g.gain.setValueAtTime(cur.g.gain.value, when);
    cur.g.gain.linearRampToValueAtTime(0, done);
    inc.at = when;
    inc.pos = offset;
  }
  cur.stop = done + 0.1;
  cur.src.stop(cur.stop);
  next = inc;
}

// the scheduled audio needs no timers; this only moves the bookkeeping along on the context clock
function tick() {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  if (gone && now >= gone.stop) { drop(gone); gone = null; }
  if (next && now >= next.from) { gone = deck; deck = next; next = null; useDj.setState({ title: deck.t.title }); void queue(); }
}

async function start() {
  const s = ++session;
  const t = pick();
  if (!t) return;
  useDj.setState({ title: t.title });
  let buf: AudioBuffer;
  try { buf = await load(t); } catch { bad.add(t); if (s === session) void start(); return; }
  if (s !== session) return;
  const d = deckFor(t, buf);
  d.from = d.at = ctx!.currentTime + 0.05;
  d.g.gain.value = level(t);
  d.src.start(d.at);
  deck = d;
  void queue();
}

// must run inside a tap: that is the only moment a webview lets the AudioContext start
const play = () => {
  if (!TRACKS.length) return;
  if (!ctx) {
    ctx = new AudioContext();
    const s = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (s) s.type = 'playback'; // iOS 17+: play past the silent switch like plain <audio> does
    setInterval(tick, 200);
    void start();
  }
  void ctx.resume();
  useDj.setState({ on: true });
};

const pause = () => {
  void ctx?.suspend();
  useDj.setState({ on: false });
};

export function initDj() {
  api.dj().then((list) => { TRACKS = list.map(toTrack); useDj.setState({ title: TRACKS[0]?.title ?? '', ready: TRACKS.length > 0 }); }).catch(() => {});
  // a first tap on the DJ button itself is left to the button (it would start and stop the set at once)
  const first = (e: Event) => { if (pref() !== 'off' && !(e.target as Element).closest?.('.hdr__dj')) play(); };
  document.addEventListener('pointerdown', first, { capture: true, once: true });
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) { resume = useDj.getState().on; pause(); }
    else if (resume) play();
  });
}

export function DjButton() {
  const { on, title, ready } = useDj();
  if (!ready) return null; // an empty set: no button
  const toggle = () => {
    haptic.impact('light');
    if (on) { pause(); save('off'); toast('DJ SET — ПАУЗА'); }
    else { play(); save('on'); toast(`▶ ${useDj.getState().title}`); }
  };
  return (
    <button type="button" className={`hdr__dj ${on ? 'is-on' : ''}`} onClick={toggle} aria-label={on ? `Пауза: ${title}` : `Включить DJ SET: ${title}`} aria-pressed={on}>
      <i /><i /><i /><i />
    </button>
  );
}
