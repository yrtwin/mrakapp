/* DJ set: the playlist admins send to the bot (/dj), played track after track on a loop. Webviews only play
   sound after a tap, so it starts with the subject's first touch (skipping the splash counts) unless they switched
   it off; it pauses while the app is hidden. No tracks — no button. */
import { create } from 'zustand';
import type { ApiDjTrack } from '@mrak8/shared';
import { api } from '../lib/api';
import { haptic } from '../lib/telegram';
import { toast } from '../lib/store';

const KEY = 'm8:dj';
const pref = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const save = (v: 'on' | 'off') => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };
const name = (t: ApiDjTrack) => (t.performer ? `${t.performer} — ${t.title}` : t.title);
const src = (t: ApiDjTrack) => `${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}/dj/${t.id}`;

export const useDj = create<{ on: boolean; tracks: ApiDjTrack[] }>(() => ({ on: false, tracks: [] }));
let audio: HTMLAudioElement | null = null;
let idx = 0;
let resume = false;

const el = () => {
  if (!audio) {
    audio = new Audio();
    audio.volume = 0.7;
    audio.preload = 'none';
    audio.addEventListener('play', () => useDj.setState({ on: true }));
    audio.addEventListener('pause', () => useDj.setState({ on: false }));
    // next track; a single track simply loops
    audio.addEventListener('ended', () => { const n = useDj.getState().tracks.length; if (n) { idx = (idx + 1) % n; void play(false); } });
  }
  return audio;
};

async function play(announce = true) {
  const list = useDj.getState().tracks;
  if (!list.length) return;
  const t = list[idx % list.length];
  const a = el();
  if (!a.src.endsWith(`/dj/${t.id}`)) a.src = src(t);
  a.loop = list.length === 1;
  try {
    await a.play();
    if (announce) toast(`▶ ${name(t)}`);
  } catch { /* refused without a gesture — the next tap retries */ }
}

export function initDj() {
  api.dj().then((tracks) => useDj.setState({ tracks })).catch(() => {});
  // a first tap on the DJ button itself is left to the button (it would start and stop the track at once)
  const first = (e: Event) => { if (pref() !== 'off' && !(e.target as Element).closest?.('.hdr__dj')) void play(); };
  document.addEventListener('pointerdown', first, { capture: true, once: true });
  document.addEventListener('visibilitychange', () => {
    if (!audio) return;
    if (document.hidden) { resume = !audio.paused; audio.pause(); }
    else if (resume) void play(false);
  });
}

export function DjButton() {
  const on = useDj((s) => s.on);
  const has = useDj((s) => s.tracks.length > 0);
  if (!has) return null;
  const toggle = () => {
    haptic.impact('light');
    if (on) { el().pause(); save('off'); toast('DJ SET — ПАУЗА'); }
    else { save('on'); void play(); }
  };
  return (
    <button type="button" className={`hdr__dj ${on ? 'is-on' : ''}`} onClick={toggle} aria-label={on ? 'Пауза DJ-сета' : 'Включить DJ-сет'} aria-pressed={on}>
      <i /><i /><i /><i />
    </button>
  );
}
