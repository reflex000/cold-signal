// Bench page for the score (src/audio/music). Two jobs:
//
// 1. Live: a button per mood, an intensity slider, and a scrolling view of which players are
//    playing what. `?auto=1&mood=title&intensity=0.5` starts without a click (headless capture).
// 2. Offline: `window.MUSIC.render(script, seconds)` renders the score through an
//    OfflineAudioContext with the same update loop the game uses and returns level statistics
//    and a spectrogram. tools/music-check.mjs drives it.
import type { MusicMood } from '../src/audio/api';
import { createMusic } from '../src/audio/music';
import type { Music, MusicNote, Player } from '../src/audio/music';
import { PLAYERS, midiName } from '../src/audio/music/score';

const MOODS: MusicMood[] = ['none', 'title', 'calm', 'cold', 'night', 'stalked', 'attack', 'whiteout', 'shelter', 'tower', 'holdout', 'rescue', 'death'];

const HUE: Record<Player, [number, number, number]> = {
  cello: [214, 150, 96],
  piano: [226, 226, 216],
  glass: [120, 190, 214],
  drum: [196, 92, 74],
  ice: [176, 224, 255],
  brass: [230, 168, 74],
};

// ---------------------------------------------------------------------------------------------
// Offline render and analysis

interface Cue {
  t: number;
  mood: MusicMood;
  intensity?: number;
}

interface RenderResult {
  seconds: number;
  /** Linear peak over both channels and its dBFS. */
  peak: number;
  peakDb: number;
  rmsDb: number;
  /** Fraction of 50 ms windows below -54 dBFS (40 dB under the score's ceiling). */
  silence: number;
  notes: number;
  byPlayer: Record<string, number>;
  /**
   * Share of the energy (0..1) by band: sub < 60 Hz, low < 250, lowmid < 800, mid < 2.5k,
   * high < 6k, air above. Mud shows in low + lowmid, harshness in high + air.
   */
  bands: Record<'sub' | 'low' | 'lowmid' | 'mid' | 'high' | 'air', number>;
  /** Most notes written to sound at once. */
  poly: number;
  /** PNG data URL: note lanes over a log-frequency spectrogram. */
  image: string;
  /** Base64 16-bit stereo WAV when asked for. */
  wav?: string;
}

const db = (x: number): number => (x > 1e-9 ? 20 * Math.log10(x) : -180);

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Cold to hot: black, deep blue, ice, white, amber for the very loudest. */
function colour(v: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0, 6, 8, 11],
    [0.3, 14, 44, 82],
    [0.58, 52, 150, 190],
    [0.82, 232, 242, 244],
    [1, 255, 196, 96],
  ];
  const x = Math.min(1, Math.max(0, v));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const u = (x - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return [255, 196, 96];
}

const F_LO = 30;
const F_HI = 15000;
const DB_LO = -100;
const DB_HI = -24;
const BAND_EDGES: [keyof RenderResult['bands'], number][] = [
  ['sub', 60],
  ['low', 250],
  ['lowmid', 800],
  ['mid', 2500],
  ['high', 6000],
  ['air', Infinity],
];

/** A drum stroke is drawn as a short mark, so a pulse reads as a pulse and not as one long bar. */
const markSeconds = (n: MusicNote): number => (n.player === 'drum' ? Math.min(n.dur, 0.12) : n.dur);

function drawAnalysis(mono: Float32Array, sr: number, notes: MusicNote[], cues: Cue[], title: string): { image: string; bands: RenderResult['bands'] } {
  const W = 1500;
  const laneH = 14;
  const lanes = PLAYERS.length * laneH + 8;
  const specH = 460;
  const left = 46;
  const top = 22;
  const canvas = document.createElement('canvas');
  canvas.width = left + W + 8;
  canvas.height = top + lanes + specH + 22;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#0a0c0f';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const seconds = mono.length / sr;

  // Spectrogram: Hann window, one column per pixel, log frequency, the loudest bin in each row.
  const N = 4096;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const img = g.createImageData(W, specH);
  const rowBin = new Float32Array(specH + 1);
  for (let y = 0; y <= specH; y++) rowBin[y] = (F_LO * Math.pow(F_HI / F_LO, 1 - y / specH) * N) / sr;
  // Which band each FFT bin falls in, and the energy summed per band over every column.
  const binBand = new Uint8Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    const f = (i * sr) / N;
    let b = 0;
    while (f >= BAND_EDGES[b][1]) b++;
    binBand[i] = b;
  }
  const energy = new Float64Array(BAND_EDGES.length);
  for (let x = 0; x < W; x++) {
    const centre = Math.floor(((x + 0.5) / W) * mono.length);
    for (let i = 0; i < N; i++) {
      const s = centre - N / 2 + i;
      re[i] = s >= 0 && s < mono.length ? mono[s] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let i = 1; i < N / 2; i++) energy[binBand[i]] += re[i] * re[i] + im[i] * im[i];
    for (let y = 0; y < specH; y++) {
      const b1 = rowBin[y];
      const b0 = rowBin[y + 1];
      let m = 0;
      const i0 = Math.max(1, Math.floor(b0));
      const i1 = Math.max(i0, Math.min(N / 2 - 1, Math.ceil(b1)));
      for (let i = i0; i <= i1; i++) {
        const a = re[i] * re[i] + im[i] * im[i];
        if (a > m) m = a;
      }
      const level = db(Math.sqrt(m) / (N / 4));
      const [r, gg, b] = colour((level - DB_LO) / (DB_HI - DB_LO));
      const o = (y * W + x) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, left, top + lanes);

  g.font = '11px "Segoe UI", Arial, sans-serif';
  g.textBaseline = 'middle';
  // Note lanes.
  PLAYERS.forEach((p, i) => {
    const y = top + i * laneH;
    g.fillStyle = '#7d8791';
    g.textAlign = 'right';
    g.fillText(p, left - 6, y + laneH / 2);
    const [r, gg, b] = HUE[p];
    for (const n of notes) {
      if (n.player !== p) continue;
      const x0 = left + (n.t / seconds) * W;
      const w = Math.max(1.5, (markSeconds(n) / seconds) * W);
      g.fillStyle = `rgba(${r},${gg},${b},${0.35 + 0.65 * n.vel})`;
      g.fillRect(x0, y + 3, Math.min(w, left + W - x0), laneH - 6);
    }
  });
  // Axes.
  g.fillStyle = '#7d8791';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const y = top + lanes + specH * (1 - Math.log(f / F_LO) / Math.log(F_HI / F_LO));
    g.textAlign = 'right';
    g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), left - 6, y);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(left, y, W, 1);
    g.fillStyle = '#7d8791';
  }
  g.textAlign = 'center';
  const step = seconds > 150 ? 20 : seconds > 70 ? 10 : 5;
  for (let s = 0; s <= seconds + 0.001; s += step) {
    const x = left + (s / seconds) * W;
    g.fillText(s + ' s', x, top + lanes + specH + 12);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(x, top, 1, lanes + specH);
    g.fillStyle = '#7d8791';
  }
  g.textAlign = 'left';
  g.fillStyle = '#e6a84a';
  for (const c of cues) {
    const x = left + (c.t / seconds) * W;
    g.fillRect(x, top - 4, 1, lanes + specH + 4);
    g.fillText(c.mood + (c.intensity !== undefined ? ' ' + c.intensity.toFixed(2) : ''), x + 4, 10);
  }
  g.fillStyle = '#dfe3e6';
  g.textAlign = 'right';
  g.fillText(title, left + W, 10);
  let total = 0;
  for (const e of energy) total += e;
  const bands = {} as RenderResult['bands'];
  BAND_EDGES.forEach(([name], i) => (bands[name] = total > 0 ? energy[i] / total : 0));
  return { image: canvas.toDataURL('image/png'), bands };
}

/** The most notes whose written lengths overlap at any moment. */
function polyphony(notes: MusicNote[]): number {
  const edges: [number, number][] = [];
  for (const n of notes) edges.push([n.t, 1], [n.t + n.dur, -1]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let most = 0;
  for (const [, d] of edges) most = Math.max(most, (now += d));
  return most;
}

function wavBase64(l: Float32Array, r: Float32Array, sr: number): string {
  const n = l.length;
  const bytes = new Uint8Array(44 + n * 4);
  const v = new DataView(bytes.buffer);
  const tag = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  tag(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Render `seconds` of the score offline. `script` is a list of mood changes; the conductor is
 * updated every 0.1 s of audio time, as a game running at a poor frame rate would.
 */
async function render(
  script: Cue[],
  seconds: number,
  o: { wav?: boolean; title?: string; sampleRate?: number; mute?: Player[]; image?: boolean; raw?: boolean } = {},
): Promise<RenderResult> {
  const sr = o.sampleRate ?? 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const notes: MusicNote[] = [];
  const music = createMusic(ctx, ctx.destination, { onNote: (n) => notes.push(n), mute: o.mute, raw: o.raw });
  const cues = [...script].sort((a, b) => a.t - b.t);
  let next = 0;
  const tick = (now: number): void => {
    while (next < cues.length && cues[next].t <= now + 1e-6) {
      music.setMood(cues[next].mood, { intensity: cues[next].intensity });
      next++;
    }
    music.update(0.1);
  };
  const STEP = 0.1;
  for (let i = 1; i * STEP < seconds; i++) {
    const at = i * STEP;
    void ctx.suspend(at).then(() => {
      tick(at);
      void ctx.resume();
    });
  }
  tick(0);
  const buf = await ctx.startRendering();
  music.dispose();

  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const mono = new Float32Array(l.length);
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]);
    const b = Math.abs(r[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
    sq += (l[i] * l[i] + r[i] * r[i]) * 0.5;
    mono[i] = (l[i] + r[i]) * 0.5;
  }
  const win = Math.floor(sr * 0.05);
  let quiet = 0;
  let wins = 0;
  for (let i = 0; i + win <= l.length; i += win) {
    let e = 0;
    for (let k = i; k < i + win; k++) e += (l[k] * l[k] + r[k] * r[k]) * 0.5;
    if (db(Math.sqrt(e / win)) < -54) quiet++;
    wins++;
  }
  const byPlayer: Record<string, number> = {};
  for (const n of notes) {
    const key = n.colour ? `${n.player}.${n.colour}` : n.player;
    byPlayer[key] = (byPlayer[key] || 0) + 1;
  }
  const heard = notes.filter((n) => n.t < seconds);
  const title = o.title ?? cues.map((c) => c.mood).join(' > ');
  const pic = drawAnalysis(mono, sr, heard, cues, title);
  return {
    seconds,
    peak,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sq / l.length)),
    silence: wins ? quiet / wins : 1,
    notes: heard.length,
    byPlayer,
    bands: pic.bands,
    poly: polyphony(heard),
    image: o.image === false ? '' : pic.image,
    wav: o.wav ? wavBase64(l, r, sr) : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Live page

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

let ctx: AudioContext | null = null;
let music: Music | null = null;
let analyser: AnalyserNode | null = null;
let windGain: GainNode | null = null;
let want: MusicMood = (params.get('mood') as MusicMood) || 'title';
let intensity = Number(params.get('intensity') ?? 0.5);
let peakHold = 0;
const roll: MusicNote[] = [];
const scope = new Float32Array(2048);

const moodBox = $('moods');
const buttons = new Map<MusicMood, HTMLButtonElement>();
for (const m of MOODS) {
  const b = document.createElement('button');
  b.textContent = m;
  b.addEventListener('click', () => {
    want = m;
    void start();
  });
  moodBox.appendChild(b);
  buttons.set(m, b);
}
const slider = $<HTMLInputElement>('intensity');
slider.value = String(intensity);
$('ival').textContent = intensity.toFixed(2);
slider.addEventListener('input', () => {
  intensity = Number(slider.value);
  $('ival').textContent = intensity.toFixed(2);
});
const startBtn = $<HTMLButtonElement>('start');
startBtn.addEventListener('click', () => {
  if (ctx && ctx.state === 'running') void ctx.suspend().then(paint);
  else void start();
});
$<HTMLInputElement>('wind').addEventListener('change', (e) => {
  if (windGain && ctx) windGain.gain.setTargetAtTime((e.target as HTMLInputElement).checked ? 1 : 0, ctx.currentTime, 0.5);
});

/** A plain wind bed (filtered noise near -20 dBFS RMS) to judge the score's level against. */
function makeWind(c: AudioContext, out: AudioNode): GainNode {
  const buf = c.createBuffer(2, c.sampleRate * 4, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      b += 0.02 * (Math.random() * 2 - 1 - b);
      d[i] = b * 6;
    }
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 420;
  band.Q.value = 0.5;
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.11;
  const depth = c.createGain();
  depth.gain.value = 180;
  lfo.connect(depth).connect(band.frequency);
  const g = c.createGain();
  g.gain.value = 0;
  src.connect(band).connect(g).connect(out);
  src.start();
  lfo.start();
  return g;
}

async function start(): Promise<void> {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.connect(ctx.destination);
    music = createMusic(ctx, analyser, {
      onNote: (n) => {
        roll.push(n);
        if (roll.length > 600) roll.splice(0, roll.length - 600);
      },
    });
    windGain = makeWind(ctx, ctx.destination);
    if ($<HTMLInputElement>('wind').checked) windGain.gain.value = 1;
  }
  if (ctx.state !== 'running') await ctx.resume();
  paint();
}

const canvas = $<HTMLCanvasElement>('roll');
const g2 = canvas.getContext('2d')!;
/** Seconds of the past shown in the roll. */
const SPAN = 40;

function paint(): void {
  const live = !!ctx && ctx.state === 'running';
  startBtn.textContent = live ? 'Pause' : ctx ? 'Resume' : 'Start audio';
  startBtn.classList.toggle('live', live);
  const st = music ? music.state() : null;
  for (const [m, b] of buttons) {
    b.classList.toggle('on', st ? st.mood === m && !!ctx : false);
    b.classList.toggle('want', m === want && (!st || st.mood !== m));
  }

  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  g2.clearRect(0, 0, w, h);
  const now = ctx ? ctx.currentTime : 0;
  const nameW = 64 * dpr;
  const meterW = 46 * dpr;
  const x0 = nameW + meterW + 14 * dpr;
  // Room right of the now line for what is sounding (a chord's names) and the notes' written ends.
  const nowX = w - 120 * dpr;
  const pxPerS = (nowX - x0) / SPAN;
  const rowH = h / PLAYERS.length;
  g2.font = `300 ${13 * dpr}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
  g2.textBaseline = 'middle';
  PLAYERS.forEach((p, i) => {
    const y = i * rowH;
    const level = st ? st.players[p] : 0;
    const [r, gg, b] = HUE[p];
    g2.fillStyle = level > 0.01 ? '#dfe3e6' : '#7d8791';
    g2.textAlign = 'left';
    g2.fillText(p, 0, y + rowH / 2);
    // Activity: a hairline that fills while the player sounds.
    g2.fillStyle = '#2a3038';
    g2.fillRect(nameW, y + rowH / 2, meterW, dpr);
    g2.fillStyle = `rgb(${r},${gg},${b})`;
    g2.fillRect(nameW, y + rowH / 2 - dpr, meterW * Math.min(1, level * 1.4), 3 * dpr);
    g2.fillStyle = '#161a1f';
    g2.fillRect(x0, y + rowH - dpr, w - x0, dpr);
    // Notes of this player: pitch maps to height inside the row (low notes low).
    const names = new Map<number, string>();
    let topY = Infinity;
    for (const n of roll) {
      const len = markSeconds(n);
      if (n.player !== p || n.t + len < now - SPAN) continue;
      const xa = Math.max(x0, nowX + (n.t - now) * pxPerS);
      const xb = Math.min(w, nowX + (n.t + len - now) * pxPerS);
      if (xb <= xa) continue;
      const pitch = Math.min(1, Math.max(0, (n.midi - 30) / 72));
      const ny = y + rowH - 6 * dpr - pitch * (rowH - 12 * dpr);
      const sounding = n.t <= now && n.t + n.dur >= now;
      g2.fillStyle = `rgba(${r},${gg},${b},${(sounding ? 0.55 : 0.25) + 0.45 * n.vel})`;
      g2.fillRect(xa, ny - 1.5 * dpr, Math.max(2 * dpr, xb - xa), 3 * dpr);
      if (sounding) {
        names.set(n.midi, midiName(n.midi));
        topY = Math.min(topY, ny);
      }
    }
    if (names.size) {
      // What the player is sounding now, low to high, just above its highest bar past the now line.
      const text = [...names.entries()]
        .sort((a, b2) => a[0] - b2[0])
        .map((e) => e[1])
        .join(' ');
      g2.textAlign = 'left';
      g2.fillStyle = '#7d8791';
      g2.fillText(text, nowX + 6 * dpr, Math.max(y + 8 * dpr, topY - 9 * dpr));
    }
  });
  g2.fillStyle = '#e6a84a';
  g2.fillRect(nowX, 0, dpr, h);

  let peak = 0;
  if (analyser && live) {
    analyser.getFloatTimeDomainData(scope);
    for (let i = 0; i < scope.length; i++) peak = Math.max(peak, Math.abs(scope[i]));
  }
  peakHold = Math.max(peak, peakHold * 0.985);
  const status = $('status');
  if (!ctx) status.textContent = 'Silent until started: browsers only let audio begin from a click or a tap.';
  else if (st) {
    const waiting = st.target !== st.mood ? ` &nbsp; waiting for the phrase to end, then <b>${st.target}</b>` : '';
    const where = st.phrase ? `phrase <b>${st.phrase}</b>` : st.nextIn === Infinity ? 'nothing more to play' : `rest, next phrase in <b>${st.nextIn.toFixed(1)} s</b>`;
    status.innerHTML = `<b>${st.mood}</b> &nbsp; ${where}${waiting} &nbsp; notes ${st.notes} &nbsp; peak <b>${peakHold > 1e-5 ? db(peakHold).toFixed(1) : '-inf'} dBFS</b>`;
  }
}

function frame(): void {
  if (music && ctx && ctx.state === 'running') {
    music.setMood(want, { intensity });
    music.update(1 / 60);
  }
  paint();
  requestAnimationFrame(frame);
}

(window as any).MUSIC = { render, moods: MOODS };
(window as any).BACKEND = 'audio';

if (params.has('auto')) void start();
requestAnimationFrame(() => {
  frame();
  requestAnimationFrame(() => {
    (window as any).DONE = true;
  });
});
