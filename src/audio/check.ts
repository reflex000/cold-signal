// Offline rendering and measurement, for tools/audio-check.mjs (which drives it through the bench
// page, dev/audio.html). Not imported by the game.
//
// Every sound goes through the same buildAudio() graph the game plays: the voice, its strip, the
// reverbs, the master compressor and limiter. The OfflineAudioContext has four channels: 0-1 are
// the master (what the player hears), 2-3 the raw bus before the dynamics (what the synth wrote,
// so headroom can be judged). From those: audible length, peak, RMS, the loudest 50 ms, spectral
// centroid, DC, samples held at the limiter's ceiling, and a picture: the level over time above
// a log-frequency spectrogram (window sized to the sound, colours relative to its loudest bin).
import type { Surface } from '../sim/types';
import type { LoopName } from './api';
import { measureCompGain, type Vec3 } from './engine';
import { buildAudio, type AudioCore } from './index';
import { LOOP_NAMES } from './loops';
import { SCENES, SceneRunner } from './scenes';
import { INTERNAL_NAMES, SFX, SFX_NAMES, STEPS, STEP_NAMES } from './sfx';

export type CheckKind = 'sfx' | 'loop' | 'step' | 'scene' | 'stress';

export interface CheckSpec {
  id: string;
  kind: CheckKind;
  /** sfx name, loop name, surface or scene id */
  name: string;
  label: string;
  /** spatial: metres from a listener at (0, 1.7, 0) facing north */
  pos?: Vec3;
  /** the builder's free numbers (internal sounds: cold, level) */
  a?: number;
  b?: number;
  /** render length; sfx default: what the builder asks for plus the reverb tail */
  secs?: number;
}

export interface CheckOptions {
  sampleRate?: number;
  /** the phone profile: equal-power panning, short reverbs, fewer voices */
  lite?: boolean;
  seed?: number;
  wav?: boolean;
  /** no reverb returns: the voice alone */
  dry?: boolean;
}

export interface CheckResult {
  id: string;
  kind: CheckKind;
  label: string;
  /** rendered length */
  secs: number;
  /** from the first to the last sample above -66 dBFS and within 40 dB of the peak */
  dur: number;
  peakDb: number;
  rawPeakDb: number;
  /** over the audible part */
  rmsDb: number;
  /** the loudest 50 ms */
  rms50Db: number;
  centroid: number;
  dc: number;
  /** samples within 0.3 dB of the limiter's ceiling */
  limited: number;
  voicesMax: number;
  flags: string[];
  /** fail: SILENT, CLIP, NAN. warn: LIMIT, HOT, DC, CUT, QUIET */
  fail: boolean;
  image: string;
  wav?: string;
}

/** one-shots start this late: DynamicsCompressorNode takes about 0.3 s to settle after a context starts */
const PRE = 0.4;
const STEP = 0.05;
/** the limiter never passes 0.97 (dsp.limiterCurve) */
const CEIL = 0.97;

const db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -200);

// ---------------------------------------------------------------------------------------------
// What gets checked

const LOOP_PARAM: Partial<Record<LoopName, [number, number, string]>> = {
  fire: [0, 1, 'heat'],
  flare: [1, 0, 'life'],
  generator: [0, 1, 'charge'],
  radio_static: [0, 1, 'signal'],
  heli: [0, 1, 'closeness'],
  wolf_breath: [0, 1, 'closeness'],
};

export function checkList(): CheckSpec[] {
  const out: CheckSpec[] = [];
  for (const n of SFX_NAMES) out.push({ id: n, kind: 'sfx', name: n, label: n });
  // far variants: the builder picks for distance, the air thins it, the mountain answers
  out.push({ id: 'rifle_shot_far', kind: 'sfx', name: 'rifle_shot', label: 'rifle_shot at 300 m', pos: [120, 10, -275] });
  out.push({ id: 'howl_250m', kind: 'sfx', name: 'howl', label: 'howl at 250 m', pos: [-170, 30, -180] });
  out.push({ id: 'ice_crack_150m', kind: 'sfx', name: 'ice_crack', label: 'ice_crack at 150 m', pos: [90, -1, -120] });
  out.push({ id: '_breath_warm', kind: 'sfx', name: '_breath', label: 'breath (warm)', a: 0.1, b: 0.03 });
  out.push({ id: '_breath_cold', kind: 'sfx', name: '_breath', label: 'breath (freezing)', a: 0.92, b: 0.075 });
  for (const n of INTERNAL_NAMES) if (n !== '_breath') out.push({ id: n, kind: 'sfx', name: n, label: n, a: 0.8 });
  for (const n of LOOP_NAMES) {
    const p = LOOP_PARAM[n];
    out.push({ id: 'loop_' + n, kind: 'loop', name: n, label: p ? `loop ${n}, ${p[2]} ${p[0]} > ${p[1]}` : `loop ${n}`, secs: p ? 10 : 6 });
  }
  for (const s of STEP_NAMES) out.push({ id: 'step_' + s, kind: 'step', name: s, label: `steps on ${s}: 3 walking, 3 running` });
  for (const sc of SCENES) out.push({ id: 'scene_' + sc.id, kind: 'scene', name: sc.id, label: 'scene: ' + sc.label, secs: 24 });
  out.push({ id: 'stress', kind: 'stress', name: 'stress', label: 'stress: storm, fire, 3 shots, 5 howls, ice, thunder, 16 steps', secs: 9 });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rendering

let compGainP: Promise<number> | null = null;
const compGain = (sr: number): Promise<number> => (compGainP ??= measureCompGain(sr));

function coreOn(ctx: BaseAudioContext, o: Required<Pick<CheckOptions, 'lite' | 'seed'>>, k: number, dest: AudioNode | undefined, ambience: boolean, offline: boolean): AudioCore {
  const core = buildAudio(ctx, { lite: o.lite, seed: o.seed, compGain: k, dest, offline, ambience, music: false });
  core.setListener(0, 1.7, 0, 0, 0, -1);
  return core;
}

/** The length a one-shot's builder asks for, found by building it on a context that is never rendered (same seed: same choices). */
function probe(spec: CheckSpec, sr: number, o: Required<Pick<CheckOptions, 'lite' | 'seed'>>): number {
  const pc = new OfflineAudioContext(2, 128, sr);
  const core = coreOn(pc, o, 1, undefined, false, false);
  return core.engine.play(spec.name, SFX[spec.name], { pos: spec.pos, a: spec.a, b: spec.b, delay: PRE }) ?? 1;
}

function lengthOf(spec: CheckSpec, sr: number, o: Required<Pick<CheckOptions, 'lite' | 'seed'>>): number {
  if (spec.secs) return spec.secs;
  if (spec.kind === 'step') return 6.2;
  if (spec.kind === 'sfx') {
    const def = SFX[spec.name];
    const wet = (def.far ?? 0) > 0 || (def.local ?? 0) > 0;
    return Math.min(20, PRE + probe(spec, sr, o) + (wet ? (o.lite ? 3.2 : 6) : 0.5));
  }
  return 8;
}

export async function renderCheck(spec: CheckSpec, opts: CheckOptions = {}): Promise<CheckResult> {
  const sr = opts.sampleRate ?? 48000;
  const o = { lite: opts.lite ?? false, seed: opts.seed ?? 4170 };
  const k = await compGain(sr);
  const secs = lengthOf(spec, sr, o);
  const ctx = new OfflineAudioContext(4, Math.ceil(secs * sr), sr);
  const merge = ctx.createChannelMerger(4);
  merge.connect(ctx.destination);
  const master = ctx.createChannelSplitter(2);
  master.connect(merge, 0, 0);
  master.connect(merge, 1, 1);
  const withAmbience = spec.kind === 'scene' || spec.kind === 'stress';
  const core = coreOn(ctx, o, k, master, withAmbience, true);
  if (opts.dry) core.engine.setWet(0);
  const rawSplit = ctx.createChannelSplitter(2);
  core.engine.raw.connect(rawSplit);
  rawSplit.connect(merge, 0, 2);
  rawSplit.connect(merge, 1, 3);

  let voicesMax = 0;
  let tick: (now: number) => void = () => {};
  const eng = core.engine;
  if (spec.kind === 'sfx') {
    eng.play(spec.name, SFX[spec.name], { pos: spec.pos, a: spec.a, b: spec.b, delay: PRE });
  } else if (spec.kind === 'step') {
    const s = spec.name as Surface;
    let t = PRE;
    for (let i = 0; i < 6; i++) {
      const run = i >= 3;
      eng.play('step_' + s, STEPS[s], { delay: t, a: run ? 1 : 0.35, b: s === 'snow' ? 0 : s === 'deep' ? 0.7 : 0 });
      t += run ? 0.36 : 0.62;
    }
  } else if (spec.kind === 'loop') {
    const name = spec.name as LoopName;
    const p = LOOP_PARAM[name];
    const end = secs - 0.9;
    const h = core.loop(name, { param: p ? p[0] : 0 });
    tick = (now) => {
      if (p) h.set({ param: p[0] + (p[1] - p[0]) * Math.min(1, now / (end - 0.3)) });
      if (now >= end && now < end + STEP) h.stop(0.5);
    };
  } else if (spec.kind === 'scene') {
    const sc = SCENES.find((x) => x.id === spec.name);
    if (!sc) throw new Error(`no scene '${spec.name}'`);
    const run = new SceneRunner(core, sc, { music: false });
    tick = () => run.tick(STEP);
  } else {
    // twenty-odd voices at once on top of a storm: the master must hold
    core.setAmbience({ wind: 1, gust: 0.8, storm: 1, snowfall: 1, height: 500, cold: 0.8, windDir: [0.6, 0.8] });
    core.loop('fire', { param: 1, pos: [1, 0.2, 2] });
    const shots: [number, string, Vec3 | undefined][] = [
      [0.5, 'rifle_shot', undefined], [0.62, 'howl', [30, 3, -40]], [0.7, 'howl', [-40, 3, -30]], [0.8, 'ice_break', [3, 0, 3]],
      [0.9, 'rifle_shot', undefined], [1.0, 'thunder', undefined], [1.05, 'howl_far', [200, 40, -300]], [1.1, 'growl', [-3, 0.5, -4]],
      [1.15, 'bark', [4, 0.5, -5]], [1.2, 'tree_fall', [12, 0, -20]], [1.3, 'rifle_shot', undefined], [1.35, 'ice_crack', [20, 0, -30]],
      [1.4, 'generator_start', [6, 0, 6]], [1.45, 'howl', [60, 5, 10]], [1.5, 'yelp', [5, 0.5, -6]], [1.6, 'hurt', undefined],
      [1.65, 'wood_split', [1.5, 0, -1]], [1.7, 'flare_shot', undefined], [1.8, 'splash', [2, 0, 2]], [1.9, 'howl', [-20, 2, 30]],
    ];
    for (const [t, n, pos] of shots) eng.play(n, SFX[n], { delay: t, pos });
    for (let i = 0; i < 16; i++) eng.play('step_snow', STEPS.snow, { delay: 0.4 + i * 0.12, a: 1 });
  }

  const marks: number[] = [];
  for (let at = STEP; at < secs - 0.01; at += STEP) marks.push(at);
  for (const at of marks) {
    void ctx.suspend(at).then(() => {
      tick(at);
      core.update(STEP);
      voicesMax = Math.max(voicesMax, eng.voiceCount);
      void ctx.resume();
    });
  }
  voicesMax = Math.max(voicesMax, eng.voiceCount);
  const buf = await ctx.startRendering();
  core.dispose();
  return analyse(spec, buf, secs, voicesMax, opts.wav === true);
}

// ---------------------------------------------------------------------------------------------
// Measuring

interface Plot {
  canvas: HTMLCanvasElement;
  label: string;
  line: string;
  flags: string[];
  fail: boolean;
}
const plots = new Map<string, Plot>();

function analyse(spec: CheckSpec, buf: AudioBuffer, secs: number, voicesMax: number, wantWav: boolean): CheckResult {
  const sr = buf.sampleRate;
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const RL = buf.getChannelData(2);
  const RR = buf.getChannelData(3);
  const n = L.length;
  let peak = 0;
  let rawPeak = 0;
  let limited = 0;
  let nan = false;
  let tailEnd = 0;
  const tailFrom = n - Math.floor(sr * 0.05);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]);
    const b = Math.abs(R[i]);
    if (!(a < 10 && b < 10)) nan = true;
    const m = a > b ? a : b;
    if (m > peak) peak = m;
    if (m > CEIL * 0.966) limited++;
    if (i >= tailFrom && m > tailEnd) tailEnd = m;
    const r = Math.max(Math.abs(RL[i]), Math.abs(RR[i]));
    if (r > rawPeak) rawPeak = r;
  }
  // audible length: above -66 dBFS and no more than 40 dB under the sound's own peak
  const thr = Math.max(Math.pow(10, -66 / 20), peak * 0.01);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(L[i]) > thr || Math.abs(R[i]) > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const on = first < 0 ? 0 : first;
  const off = last < 0 ? n : last + 1;
  let sq = 0;
  let sum = 0;
  for (let i = on; i < off; i++) {
    sq += (L[i] * L[i] + R[i] * R[i]) * 0.5;
    sum += (L[i] + R[i]) * 0.5;
  }
  const cnt = Math.max(1, off - on);
  const rms = Math.sqrt(sq / cnt);
  const dc = sum / cnt;
  const w50 = Math.floor(sr * 0.05);
  let best = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += (L[i] * L[i] + R[i] * R[i]) * 0.5;
    if (i >= w50) acc -= (L[i - w50] * L[i - w50] + R[i - w50] * R[i - w50]) * 0.5;
    if (i >= w50 - 1 && acc > best) best = acc;
  }
  const rms50 = Math.sqrt(Math.max(0, best) / w50);
  const loopish = spec.kind === 'loop' || spec.kind === 'scene' || spec.kind === 'stress';

  const flags: string[] = [];
  let fail = false;
  const bad = (f: string): void => {
    flags.push(f);
    fail = true;
  };
  if (nan) bad('NAN');
  if (peak < Math.pow(10, -60 / 20)) bad('SILENT');
  else if (peak < Math.pow(10, -42 / 20) && spec.kind !== 'scene') flags.push('QUIET');
  if (peak >= 0.995) bad('CLIP');
  if (limited > 0) flags.push(`LIMIT ${limited}`);
  if (rawPeak > 1) flags.push('HOT');
  if (Math.abs(dc) > Math.max(0.002, 0.05 * rms)) flags.push('DC');
  if (!loopish && tailEnd > Math.pow(10, -60 / 20)) flags.push('CUT');

  // the picture: from just before the onset to just after the end
  const from = loopish ? 0 : Math.max(0, on - Math.floor(sr * 0.02));
  const to = loopish ? n : Math.min(n, Math.max(off + Math.floor(sr * 0.08), from + Math.floor(sr * 0.15)));
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
  const { canvas, centroid } = draw(mono, L, R, RL, RR, sr, from, to, on, off);
  const dur = first < 0 ? 0 : (off - on) / sr;
  const line =
    `dur ${dur.toFixed(2)} s  peak ${db(peak).toFixed(1)}  raw ${db(rawPeak).toFixed(1)}  rms ${db(rms).toFixed(1)}  ` +
    `50ms ${db(rms50).toFixed(1)} dBFS  centroid ${centroid < 1000 ? centroid.toFixed(0) + ' Hz' : (centroid / 1000).toFixed(2) + ' kHz'}` +
    (voicesMax > 1 ? `  voices ${voicesMax}` : '');
  plots.set(spec.id, { canvas, label: spec.label, line, flags, fail });
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    secs,
    dur,
    peakDb: db(peak),
    rawPeakDb: db(rawPeak),
    rmsDb: db(rms),
    rms50Db: db(rms50),
    centroid,
    dc,
    limited,
    voicesMax,
    flags,
    fail,
    image: withTitle(spec.id).toDataURL('image/png'),
    wav: wantWav ? wavBase64(L, R, sr) : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Pictures

const W = 760;
const LEFT = 46;
const RIGHT = 10;
const PW = W - LEFT - RIGHT;
const ENV_H = 56;
const GAP = 6;
const SPEC_H = 210;
const AXIS_H = 18;
const PLOT_H = ENV_H + GAP + SPEC_H + AXIS_H;
const TITLE_H = 36;
const F_LO = 30;

/** magma, roughly */
const MAP: [number, number, number, number][] = [
  [0, 0, 0, 4],
  [0.18, 28, 16, 68],
  [0.36, 79, 18, 123],
  [0.52, 129, 37, 129],
  [0.68, 181, 54, 122],
  [0.8, 229, 80, 100],
  [0.9, 251, 135, 97],
  [1, 252, 253, 191],
];
function colour(v: number): [number, number, number] {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  for (let i = 1; i < MAP.length; i++) {
    if (x <= MAP[i][0]) {
      const a = MAP[i - 1];
      const b = MAP[i];
      const u = (x - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return [252, 253, 191];
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
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

function niceStep(span: number): number {
  for (const s of [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10]) if (span / s <= 9) return s;
  return 20;
}

function draw(
  mono: Float32Array, L: Float32Array, R: Float32Array, RL: Float32Array, RR: Float32Array,
  sr: number, from: number, to: number, on: number, off: number,
): { canvas: HTMLCanvasElement; centroid: number } {
  const span = to - from;
  const secs = span / sr;
  const N = secs < 0.35 ? 512 : secs < 1.6 ? 1024 : secs < 7 ? 2048 : 4096;
  const fHi = Math.min(20000, sr / 2);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const pow = new Float32Array(PW * SPEC_H);
  const rowLo = new Float32Array(SPEC_H);
  const rowHi = new Float32Array(SPEC_H);
  const rowF = (y: number) => fHi * Math.pow(F_LO / fHi, y / (SPEC_H - 1));
  for (let y = 0; y < SPEC_H; y++) {
    rowLo[y] = (rowF(y + 0.5) * N) / sr;
    rowHi[y] = (rowF(y - 0.5) * N) / sr;
  }
  let cNum = 0;
  let cDen = 0;
  let maxP = 1e-20;
  for (let x = 0; x < PW; x++) {
    const c = Math.floor(from + ((x + 0.5) / PW) * span);
    const s0 = c - N / 2;
    for (let i = 0; i < N; i++) {
      const j = s0 + i;
      re[i] = j >= 0 && j < mono.length ? mono[j] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    for (let b = 0; b < N / 2; b++) mag[b] = re[b] * re[b] + im[b] * im[b];
    if (c >= on && c < off) {
      for (let b = 1; b < N / 2; b++) {
        cNum += mag[b] * ((b * sr) / N);
        cDen += mag[b];
      }
    }
    for (let y = 0; y < SPEC_H; y++) {
      const lo = rowLo[y];
      const hi = rowHi[y];
      let p = 0;
      if (hi - lo < 1) {
        const k = (lo + hi) / 2;
        const k0 = Math.floor(k);
        const u = k - k0;
        p = mag[Math.min(k0, N / 2 - 1)] * (1 - u) + mag[Math.min(k0 + 1, N / 2 - 1)] * u;
      } else {
        for (let b = Math.ceil(lo); b <= Math.min(Math.floor(hi), N / 2 - 1); b++) if (mag[b] > p) p = mag[b];
      }
      pow[y * PW + x] = p;
      if (p > maxP) maxP = p;
    }
  }
  const centroid = cDen > 0 ? cNum / cDen : 0;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = PLOT_H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#0a0c0f';
  g.fillRect(0, 0, W, PLOT_H);

  // level over time: master peak (filled) and the raw bus (line), -72..0 dBFS
  const envY = (d: number) => ENV_H - ((Math.max(-72, Math.min(0, d)) + 72) / 72) * ENV_H;
  g.strokeStyle = '#2a3038';
  g.lineWidth = 1;
  g.font = '10px monospace';
  g.fillStyle = '#7d8791';
  for (const d of [0, -12, -24, -48]) {
    const y = Math.round(envY(d)) + 0.5;
    g.beginPath();
    g.moveTo(LEFT, y);
    g.lineTo(W - RIGHT, y);
    g.stroke();
    g.fillText(String(d), 4, y + 3);
  }
  const rawLine: number[] = [];
  g.fillStyle = '#9aa6b2';
  for (let x = 0; x < PW; x++) {
    const a = Math.floor(from + (x / PW) * span);
    const b = Math.max(a + 1, Math.floor(from + ((x + 1) / PW) * span));
    let pk = 0;
    let rp = 0;
    for (let i = a; i < b; i++) {
      const m = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (m > pk) pk = m;
      const r = Math.max(Math.abs(RL[i]), Math.abs(RR[i]));
      if (r > rp) rp = r;
    }
    const y = envY(db(pk));
    g.fillRect(LEFT + x, y, 1, ENV_H - y);
    rawLine.push(envY(db(rp)));
  }
  g.strokeStyle = '#e6a84a';
  g.beginPath();
  rawLine.forEach((y, x) => (x ? g.lineTo(LEFT + x, y) : g.moveTo(LEFT + x, y)));
  g.stroke();

  // the spectrogram: 84 dB under the loudest bin
  const top = ENV_H + GAP;
  const img = g.createImageData(PW, SPEC_H);
  const ref = 10 * Math.log10(maxP);
  for (let i = 0; i < PW * SPEC_H; i++) {
    const d = 10 * Math.log10(pow[i] + 1e-30) - ref;
    const [r, gg, b] = colour((d + 84) / 84);
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, LEFT, top);
  g.fillStyle = '#7d8791';
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    if (f > fHi) continue;
    const y = Math.round(top + ((SPEC_H - 1) * Math.log(fHi / f)) / Math.log(fHi / F_LO)) + 0.5;
    g.beginPath();
    g.moveTo(LEFT, y);
    g.lineTo(LEFT + 6, y);
    g.stroke();
    g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), 4, y + 3);
  }
  // time axis
  const st = niceStep(secs);
  const t0 = from / sr;
  for (let t = Math.ceil(t0 / st) * st; t <= to / sr + 1e-9; t += st) {
    const x = Math.round(LEFT + ((t - t0) / secs) * PW) + 0.5;
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.beginPath();
    g.moveTo(x, top + SPEC_H);
    g.lineTo(x, top + SPEC_H + 4);
    g.stroke();
    g.fillText(st < 0.1 ? t.toFixed(2) : st < 1 ? t.toFixed(1) : t.toFixed(0), x - 8, top + SPEC_H + 14);
  }
  return { canvas, centroid };
}

function title(g: CanvasRenderingContext2D, p: Plot, x: number, y: number, w: number, size: number): void {
  g.font = `${size}px monospace`;
  g.fillStyle = '#dfe3e6';
  g.fillText(p.label, x + 4, y + size + 2);
  g.fillStyle = p.fail ? '#ff5a4a' : p.flags.length ? '#e6a84a' : '#7d8791';
  const fl = p.flags.length ? '  ' + p.flags.join(' ') : '';
  g.fillText(p.line + fl, x + 4, y + size * 2 + 6, w - 8);
}

function withTitle(id: string): HTMLCanvasElement {
  const p = plots.get(id)!;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = TITLE_H + PLOT_H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0a0c0f';
  g.fillRect(0, 0, c.width, c.height);
  title(g, p, 0, 0, W, 11);
  g.drawImage(p.canvas, 0, TITLE_H);
  return c;
}

/** Several rendered checks on one page, smaller, each with its own label: one picture to read many sounds. */
export function contactSheet(ids: string[], heading: string, cols = 4): string {
  const cw = 380;
  const scale = cw / W;
  const ch = 32 + Math.round(PLOT_H * scale);
  const have = ids.filter((id) => plots.has(id));
  const rows = Math.max(1, Math.ceil(have.length / cols));
  const c = document.createElement('canvas');
  c.width = cw * cols;
  c.height = 26 + rows * ch;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0a0c0f';
  g.fillRect(0, 0, c.width, c.height);
  g.font = '13px monospace';
  g.fillStyle = '#e6a84a';
  g.fillText(heading, 6, 18);
  have.forEach((id, i) => {
    const p = plots.get(id)!;
    const x = (i % cols) * cw;
    const y = 26 + Math.floor(i / cols) * ch;
    title(g, p, x, y, cw, 10);
    g.drawImage(p.canvas, x, y + 30, cw, Math.round(PLOT_H * scale));
  });
  return c.toDataURL('image/png');
}

function wavBase64(l: Float32Array, r: Float32Array, sr: number): string {
  const n = l.length;
  const bytes = new Uint8Array(44 + n * 4);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
