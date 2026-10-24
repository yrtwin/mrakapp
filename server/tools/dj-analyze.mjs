// DJ SET analysis of one track: tempo, beat grid, first downbeat, Camelot key and loudness → JSON on stdout.
// Runs as its own process (services/djAnalyze.ts spawns it) so seconds of number crunching never block the bot.
// usage: node tools/dj-analyze.mjs <file.mp3>   (ffmpeg in PATH, or FFMPEG_PATH)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const SR = 44100;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const { Essentia, EssentiaWASM } = createRequire(import.meta.url)('essentia.js');

// essentia key → Camelot wheel (A minor, B major): neighbours on the wheel mix without clashing
const CAMELOT = {
  minor: { 'G#': 1, Ab: 1, 'D#': 2, Eb: 2, 'A#': 3, Bb: 3, F: 4, C: 5, G: 6, D: 7, A: 8, E: 9, B: 10, 'F#': 11, Gb: 11, 'C#': 12, Db: 12 },
  major: { B: 1, 'F#': 2, Gb: 2, 'C#': 3, Db: 3, 'G#': 4, Ab: 4, 'D#': 5, Eb: 5, 'A#': 6, Bb: 6, F: 7, C: 8, G: 9, D: 10, A: 11, E: 12 },
};

const decode = (file) => {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
};

// first and last 50 ms window louder than -45 dBFS: the intro/outro silence is not part of the set
const audible = (x) => {
  const w = SR / 20, on = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0;
    for (let j = i; j < i + w; j++) s += x[j] * x[j];
    if (10 * Math.log10(s / w + 1e-12) > -45) on.push(i);
  }
  return { start: on[0] / SR, end: (on.at(-1) + w) / SR };
};

// least squares t = a + b·i over the detected beats: an exact period instead of essentia's rounded bpm
const fitGrid = (ticks, bpm) => {
  let b = 60 / bpm, a = ticks[0];
  for (let pass = 0; pass < 2; pass++) {
    const idx = ticks.map((t) => Math.round((t - a) / b));
    const n = ticks.length, mi = idx.reduce((s, v) => s + v, 0) / n, mt = ticks.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) { num += (idx[k] - mi) * (ticks[k] - mt); den += (idx[k] - mi) ** 2; }
    b = num / den; a = mt - b * mi;
  }
  return { a, b };
};

// the downbeat is the beat of the bar with the most kick: low-passed energy right after each beat, summed per bar position
// ponytail: kick heuristic, guesses wrong on tracks without a kick on "1"; a downbeat model (madmom) if that shows up
const downbeatPhase = (x, a, b, start, end) => {
  const k = 1 - Math.exp((-2 * Math.PI * 150) / SR);
  const low = new Float32Array(x.length);
  for (let i = 1, y = 0; i < x.length; i++) low[i] = y += k * (x[i] - y);
  const sum = [0, 0, 0, 0];
  for (let i = Math.ceil((start - a) / b); a + b * i < end - 0.1; i++) {
    const s = Math.round((a + b * i) * SR);
    let e = 0;
    for (let j = s; j < s + SR / 10; j++) e += low[j] * low[j];
    sum[((i % 4) + 4) % 4] += e;
  }
  return sum.indexOf(Math.max(...sum));
};

const analyse = (essentia, file) => {
  const x = decode(file);
  const { start, end } = audible(x);
  const v = essentia.arrayToVector(x);
  const r = essentia.RhythmExtractor2013(v, 208, 'multifeature', 40);
  const ticks = [...essentia.vectorToArray(r.ticks)].filter((t) => t >= start && t <= end);
  const { a, b } = fitGrid(ticks, r.bpm);
  const phase = downbeatPhase(x, a, b, start, end);
  const first = a + b * phase;
  const beat = first + 4 * b * Math.ceil((start - b / 2 - first) / (4 * b));
  const k = essentia.KeyExtractor(v, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', SR, 0.0001, 440, 'cosine', 'hann');
  let s = 0;
  const i0 = Math.floor(start * SR), i1 = Math.floor(end * SR);
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  v.delete();
  return {
    bpm: +(60 / b).toFixed(3),
    beat: +beat.toFixed(3),
    end: +end.toFixed(3),
    key: `${CAMELOT[k.scale][k.key]}${k.scale === 'minor' ? 'A' : 'B'}`,
    db: +(10 * Math.log10(s / (i1 - i0))).toFixed(1),
  };
};

process.stdout.write(JSON.stringify(analyse(new Essentia(EssentiaWASM), process.argv[2])));
