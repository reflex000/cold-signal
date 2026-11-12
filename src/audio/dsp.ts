// DSP toolkit: everything the synths are built from. Pure Web Audio, works the same on a live
// AudioContext and on an OfflineAudioContext (tools/audio-check.mjs renders every sound offline
// through these same builders).
//
// - noise sources: pre-rendered loopable buffers (white, pink, brown) and three grain textures
// - impulse responses generated in code: a dead wooden room, a cave, the open mountain
// - waveshaper curves, periodic waves
// - Scope: the per-voice builder with the atoms (burst, tone, modes, creak, voice) the sounds use

export type Ctx = BaseAudioContext;
export type Rnd = () => number;
export type NoiseKind = 'white' | 'pink' | 'brown' | 'crunch' | 'crackle' | 'dust';

export const clamp = (x: number, a = 0, b = 1): number => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const dB = (d: number): number => Math.pow(10, d / 20);
/** Exponential interpolation, for frequencies. */
export const xlerp = (a: number, b: number, t: number): number => a * Math.pow(b / a, t);

export function mulberry(seed: number): Rnd {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function h1(n: number, seed: number): number {
  let h = Math.imul(n | 0, 0x27d4eb2f) ^ Math.imul(seed | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
}
/** Smooth 1-D value noise in -1..1 (two octaves). Slow random drift for anything driven from update(). */
export function wander(t: number, seed: number): number {
  const f = (x: number, s: number) => {
    const i = Math.floor(x);
    const u = x - i;
    const w = u * u * (3 - 2 * u);
    return lerp(h1(i, s), h1(i + 1, s), w);
  };
  return f(t, seed) * 0.7 + f(t * 2.37 + 11.3, seed + 7) * 0.3;
}

// ------------------------------------------------------------------------------------------
// Noise buffers

export interface Buffers {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** Dense overlapping grains of noise: the crackle inside a snow crunch, torn cloth, grit. */
  crunch: AudioBuffer;
  /** Sparse loud pops with tiny tails: fire. */
  crackle: AudioBuffer;
  /** Many faint ticks: ice grains on a hood, embers, static. */
  dust: AudioBuffer;
}

function normalise(d: Float32Array, rms: number, peakMax = 0.98): void {
  let s = 0;
  let mean = 0;
  for (let i = 0; i < d.length; i++) mean += d[i];
  mean /= d.length;
  let pk = 0;
  for (let i = 0; i < d.length; i++) {
    d[i] -= mean;
    s += d[i] * d[i];
    const a = Math.abs(d[i]);
    if (a > pk) pk = a;
  }
  let k = rms / Math.sqrt(s / d.length || 1);
  if (pk * k > peakMax) k = peakMax / pk;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

/** Crossfade the overrun (samples n..n+f) into the head so samples 0..n loop without a seam. */
function seamless(x: Float32Array, n: number, f: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  out.set(x.subarray(0, n));
  for (let i = 0; i < f; i++) {
    const u = i / f;
    out[i] = x[i] * Math.sqrt(u) + x[n + i] * Math.sqrt(1 - u);
  }
  return out;
}

export function makeBuffers(ctx: Ctx, rnd: Rnd, seconds: number): Buffers {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.25);
  const mk = (data: Float32Array<ArrayBuffer>): AudioBuffer => {
    const b = ctx.createBuffer(1, data.length, sr);
    b.copyToChannel(data, 0);
    return b;
  };
  const w = () => rnd() * 2 - 1;

  const white = new Float32Array(n);
  for (let i = 0; i < n; i++) white[i] = w();
  normalise(white, 0.3);

  // Pink: Paul Kellet's economy filter.
  const pk = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n + fade; i++) {
    const x = w();
    b0 = 0.99765 * b0 + x * 0.099046;
    b1 = 0.963 * b1 + x * 0.2965164;
    b2 = 0.57 * b2 + x * 1.0526913;
    pk[i] = b0 + b1 + b2 + x * 0.1848;
  }
  const pink = seamless(pk, n, fade);
  normalise(pink, 0.25);

  // Brown: leaky integrator (corner about 30 Hz so it stays a rumble, not a drift).
  const br = new Float32Array(n + fade);
  let acc = 0;
  for (let i = 0; i < n + fade; i++) {
    acc = acc * 0.996 + w() * 0.06;
    br[i] = acc;
  }
  const brown = seamless(br, n, fade);
  normalise(brown, 0.25);

  // Grain textures are shorter: they are always played from a random offset at a random rate.
  const gn = Math.floor(sr * Math.min(seconds, 2.5));
  const grainTex = (perSec: number, minMs: number, maxMs: number, pow: number, rms: number): Float32Array<ArrayBuffer> => {
    const d = new Float32Array(gn);
    const count = Math.floor((gn / sr) * perSec);
    for (let g = 0; g < count; g++) {
      const at = Math.floor(rnd() * (gn - 1));
      const len = Math.max(2, Math.floor((sr * (minMs + rnd() * (maxMs - minMs))) / 1000));
      const amp = Math.pow(rnd(), pow) * (rnd() < 0.5 ? -1 : 1);
      const k = 5 / len;
      for (let i = 0; i < len; i++) {
        // wraps, so the texture loops
        const j = (at + i) % gn;
        d[j] += amp * Math.exp(-i * k) * (i === 0 ? 1 : w());
      }
    }
    normalise(d, rms);
    return d;
  };
  const crunch = grainTex(900, 0.4, 4, 2.2, 0.2);
  const crackle = grainTex(14, 0.2, 1.6, 3, 0.05);
  const dust = grainTex(260, 0.1, 0.5, 2, 0.06);

  return { white: mk(white), pink: mk(pink), brown: mk(brown), crunch: mk(crunch), crackle: mk(crackle), dust: mk(dust) };
}

// ------------------------------------------------------------------------------------------
// Impulse responses

export type Space = 'room' | 'cave' | 'mountain';

/**
 * room: the ranger cabin. Small, wooden, dead: a cluster of early reflections and 150 ms of dull tail.
 * cave: stone. Bright slaps, flutter between the walls, a second of tail.
 * mountain: open air. Almost nothing near (snow eats sound), then the far walls answer: a slow
 *   diffuse wash and distinct late echoes that get darker and quieter as they come from farther.
 * Each channel is scaled to unit energy, so sustained noise comes back as loud as it went in and
 * the send level alone sets the wet amount (ConvolverNode.normalize is off).
 */
export function makeIR(ctx: Ctx, kind: Space, lite: boolean, rnd: Rnd): AudioBuffer {
  const sr = ctx.sampleRate;
  const secs = kind === 'room' ? 0.3 : kind === 'cave' ? (lite ? 1.1 : 1.9) : lite ? 2.7 : 5.6;
  const n = Math.floor(sr * secs);
  const buf = ctx.createBuffer(2, n, sr);
  const w = () => rnd() * 2 - 1;
  const lpCoef = (fc: number) => 1 - Math.exp((-2 * Math.PI * fc) / sr);
  const echoPan = [0.3, -0.45, 0.15, -0.2, 0.5, -0.35, 0.1];
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(n);
    if (kind === 'room') {
      for (let k = 0; k < 18; k++) {
        const at = Math.floor(sr * (0.0015 + rnd() * 0.032));
        d[at] += (rnd() < 0.5 ? -1 : 1) * (0.9 - k * 0.035) * Math.exp(-at / (sr * 0.02));
      }
      let s = 0;
      for (let i = Math.floor(sr * 0.004); i < n; i++) {
        const t = i / sr;
        s += lpCoef(3800 * Math.exp(-t / 0.12) + 900) * (w() - s);
        d[i] += s * Math.exp(-t / 0.042) * 0.9;
      }
      // a little box resonance: wood panels ring low
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        d[i] += Math.sin(2 * Math.PI * (190 + ch * 23) * t) * Math.exp(-t / 0.03) * 0.05;
      }
    } else if (kind === 'cave') {
      for (let k = 0; k < 9; k++) {
        const at = Math.floor(sr * (0.011 + k * (0.027 + ch * 0.003) + rnd() * 0.004));
        if (at < n) d[at] += (k % 2 ? -1 : 1) * 0.8 * Math.exp(-k * 0.42);
      }
      let s = 0;
      for (let i = Math.floor(sr * 0.006); i < n; i++) {
        const t = i / sr;
        s += lpCoef(6500 * Math.exp(-t / 0.5) + 1300) * (w() - s);
        d[i] += s * (1 - Math.exp(-t / 0.03)) * Math.exp(-t / (lite ? 0.24 : 0.4)) * 0.6;
      }
    } else {
      // sparse near reflections: ground, trunks, a rock face
      for (let k = 0; k < 6; k++) {
        const at = Math.floor(sr * (0.05 + rnd() * 0.16));
        d[at] += (rnd() < 0.5 ? -1 : 1) * 0.25 * rnd();
      }
      // the diffuse wash builds, then decays, darkening. Open air has no room to keep it: it is
      // gone in about three seconds (RT60), leaving the far walls' echoes to carry the tail
      let s = 0;
      const tau = lite ? 0.38 : 0.5;
      for (let i = Math.floor(sr * 0.08); i < n; i++) {
        const t = i / sr;
        const fc = 3600 * Math.exp(-t / 1.0) + 420;
        s += lpCoef(fc) * (w() - s);
        d[i] += s * (1 - Math.exp(-(t - 0.08) / 0.16)) * Math.exp(-t / tau) * Math.sqrt(3600 / fc) * 0.16;
      }
      // the far walls: distinct, smeared, each darker than the last
      const delays = lite ? [0.41, 0.77, 1.26, 1.92] : [0.41, 0.77, 1.26, 1.92, 2.75, 3.7, 4.6];
      for (let k = 0; k < delays.length; k++) {
        const pan = echoPan[k % echoPan.length];
        const amp = 0.95 * Math.exp(-k * 0.5) * (ch === 0 ? 1 - pan : 1 + pan);
        const at = Math.floor(sr * delays[k] * (1 + (ch ? 0.004 : -0.004) * (k + 1)));
        const len = Math.floor(sr * (0.16 + k * 0.05));
        const a = lpCoef(2600 * Math.exp(-k * 0.42) + 380);
        const decay = sr * (0.035 + k * 0.016);
        const attack = sr * (0.004 + k * 0.004);
        let e = 0;
        for (let i = 0; i < len && at + i < n; i++) {
          e += a * (w() - e);
          d[at + i] += e * amp * Math.min(1, i / attack) * Math.exp(-i / decay) * (1 / Math.sqrt(a));
        }
      }
      // fade the very end so the tail never stops on a step
      const f = Math.floor(sr * 0.2);
      for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
    }
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const k = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < n; i++) d[i] *= k;
    buf.copyToChannel(d, ch);
  }
  return buf;
}

// ------------------------------------------------------------------------------------------
// Curves and waves

/** Odd soft saturation, y = tanh(k x) / tanh(k). */
export function tanhCurve(k: number, n = 1024): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1)) / norm;
  return c;
}

/**
 * The final safety on the master bus. The shaper's input is the bus at half scale (so it sees up
 * to +6 dBFS): linear up to `knee`, then bends toward `ceil` and never passes it.
 */
export function limiterCurve(knee = 0.7, ceil = 0.97, n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceil - knee) * Math.tanh((a - knee) / (ceil - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

export interface Waves {
  /** Throat: strong fundamental, harmonics falling about 9 dB / octave. Wolves, people. */
  glottal: PeriodicWave;
  /** A harder voice with more upper harmonics: growls, barks. */
  rasp: PeriodicWave;
  /** Narrow pulse train: engines, rotor blades, cranks. */
  pulse: PeriodicWave;
}

export function makeWaves(ctx: Ctx): Waves {
  const mk = (count: number, amp: (h: number) => number, cosine = false): PeriodicWave => {
    const re = new Float32Array(count + 1);
    const im = new Float32Array(count + 1);
    for (let h = 1; h <= count; h++) (cosine ? re : im)[h] = amp(h);
    return ctx.createPeriodicWave(re, im);
  };
  return {
    glottal: mk(20, (h) => 1 / Math.pow(h, 1.55) * (h % 2 ? 1 : 0.8)),
    rasp: mk(28, (h) => 1 / Math.pow(h, 0.95)),
    pulse: mk(36, (h) => 1 / Math.pow(h, 0.25), true),
  };
}

// ------------------------------------------------------------------------------------------
// Envelopes

/** 0 -> peak in `a`, hold `h`, then fall toward 0 reaching about -45 dB after `d`. */
export function env(p: AudioParam, t: number, peak: number, a: number, h: number, d: number): void {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (h > 0) p.setValueAtTime(peak, t + a + h);
  p.setTargetAtTime(0, t + a + h, d / 5);
}

/** Piecewise curve through [time offset, value] points; 'x' = exponential segments (values > 0). */
export function curve(p: AudioParam, t: number, pts: ReadonlyArray<readonly [number, number]>, mode: 'l' | 'x' = 'l'): void {
  p.setValueAtTime(pts[0][1], t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) {
    if (mode === 'x') p.exponentialRampToValueAtTime(Math.max(1e-4, pts[i][1]), t + pts[i][0]);
    else p.linearRampToValueAtTime(pts[i][1], t + pts[i][0]);
  }
}

// ------------------------------------------------------------------------------------------
// Scope: one voice being built

export interface Kit {
  ctx: Ctx;
  rnd: Rnd;
  B: Buffers;
  W: Waves;
  lite: boolean;
}

export type Dest = AudioNode | AudioParam;
export type Pts = ReadonlyArray<readonly [number, number]>;

export interface BurstOpts {
  t?: number;
  kind?: NoiseKind;
  type?: BiquadFilterType;
  f: number;
  /** sweep the filter to f1 over `ft` seconds (default: the whole burst) */
  f1?: number;
  ft?: number;
  q?: number;
  a?: number;
  h?: number;
  d: number;
  g: number;
  rate?: number;
  to?: Dest;
}

export interface ToneOpts {
  t?: number;
  type?: OscillatorType | PeriodicWave;
  f: number;
  f1?: number;
  /** time constant style glide: reaches f1 after about `ft` seconds */
  ft?: number;
  a?: number;
  h?: number;
  d: number;
  g: number;
  to?: Dest;
}

export interface VoiceOpts {
  t?: number;
  dur: number;
  /** pitch contour: [fraction of dur, Hz] */
  f: ReadonlyArray<readonly [number, number]>;
  wave?: PeriodicWave | OscillatorType;
  /** formants: [Hz, Q, gain] */
  formants: ReadonlyArray<readonly [number, number, number]>;
  /** dry low-passed source under the formants (chest) */
  chest?: number;
  chestHz?: number;
  breath?: number;
  breathHz?: number;
  vibRate?: number;
  vibDepth?: number; // Hz
  jitter?: number; // Hz of random pitch drift
  /** amplitude roughness: [rate Hz, depth 0..1] */
  rough?: readonly [number, number];
  /** gain contour over the call: [fraction, gain]; default a plain swell */
  amp?: ReadonlyArray<readonly [number, number]>;
  g: number;
  to?: Dest;
}

export class Scope {
  readonly ctx: Ctx;
  readonly rnd: Rnd;
  readonly B: Buffers;
  readonly W: Waves;
  readonly lite: boolean;
  /** start time on the context clock */
  readonly t: number;
  /** the voice's input: connect everything here */
  readonly out: GainNode;
  /** pitch multiplier from the caller, applied as detune to every source */
  readonly pitch: number;
  /** reverb sends, set by the builder (the SfxDef supplies defaults) */
  local = 0;
  far = 0;
  /** every scheduled source, so loops can stop them */
  readonly srcs: (OscillatorNode | AudioBufferSourceNode)[] = [];
  /** control-rate sources (LFOs): stopped with the voice, not touched by pitch */
  readonly ctl: AudioScheduledSourceNode[] = [];
  private cents: number;

  constructor(kit: Kit, t: number, out: GainNode, pitch = 1) {
    this.ctx = kit.ctx;
    this.rnd = kit.rnd;
    this.B = kit.B;
    this.W = kit.W;
    this.lite = kit.lite;
    this.t = t;
    this.out = out;
    this.pitch = pitch;
    this.cents = pitch === 1 ? 0 : 1200 * Math.log2(pitch);
  }

  /** uniform in a..b */
  rr(a: number, b: number): number {
    return a + (b - a) * this.rnd();
  }
  /** a value scattered around x by +-frac */
  vary(x: number, frac: number): number {
    return x * (1 + (this.rnd() * 2 - 1) * frac);
  }
  pick<T>(a: readonly T[]): T {
    return a[Math.floor(this.rnd() * a.length) % a.length];
  }

  gain(v = 1): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }
  filt(type: BiquadFilterType, f: number, q = 0.707, gainDb = 0): BiquadFilterNode {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = Math.min(f, this.ctx.sampleRate * 0.45);
    b.Q.value = q;
    b.gain.value = gainDb;
    return b;
  }
  shaper(c: Float32Array<ArrayBuffer>): WaveShaperNode {
    const s = this.ctx.createWaveShaper();
    s.curve = c;
    return s;
  }
  delay(sec: number, max = 1): DelayNode {
    const d = this.ctx.createDelay(Math.max(max, sec + 0.01));
    d.delayTime.value = sec;
    return d;
  }
  /** A fixed stereo position. Browsers without StereoPannerNode get a plain gain (centre). */
  pan(p: number): AudioNode {
    if (typeof this.ctx.createStereoPanner !== 'function') return this.gain(1);
    const s = this.ctx.createStereoPanner();
    s.pan.value = p;
    return s;
  }
  /** connect in series, return the last node */
  chain<T extends AudioNode>(...nodes: [...AudioNode[], T]): T {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1] as T;
  }

  /** A looping noise source from a random offset. dur = Infinity for loops. */
  noise(kind: NoiseKind, t: number, dur: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    const b = this.B[kind];
    s.buffer = b;
    s.loop = true;
    s.playbackRate.value = rate;
    if (this.cents) s.detune.value = this.cents;
    s.start(t, this.rnd() * b.duration * 0.98);
    if (dur !== Infinity) s.stop(t + dur);
    this.srcs.push(s);
    return s;
  }
  osc(type: OscillatorType | PeriodicWave, f: number, t: number, dur: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (typeof type === 'string') o.type = type as OscillatorType;
    else o.setPeriodicWave(type);
    o.frequency.value = f;
    if (this.cents) o.detune.value = this.cents;
    o.start(t);
    if (dur !== Infinity) o.stop(t + dur);
    this.srcs.push(o);
    return o;
  }
  /**
   * Smooth random control signal in about -1..1 changing `hz` times a second: white noise read
   * very slowly (the buffer source interpolates). Connect through a gain to an AudioParam.
   */
  lfo(hz: number, t: number, dur: number): AudioNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.B.white;
    s.loop = true;
    s.playbackRate.value = hz / this.ctx.sampleRate;
    s.start(t, this.rnd() * this.B.white.duration * 0.98);
    if (dur !== Infinity) s.stop(t + dur);
    this.ctl.push(s);
    // the white buffer is at 0.3 rms / about 0.5 peak: bring it to roughly +-1
    const g = this.gain(2);
    s.connect(g);
    return g;
  }
  /** lfo -> depth -> param */
  mod(param: AudioParam, hz: number, depth: number, t = this.t, dur = Infinity): void {
    const g = this.gain(depth);
    this.lfo(hz, t, dur).connect(g);
    g.connect(param);
  }

  private dest(to: Dest | undefined): Dest {
    return to ?? this.out;
  }
  private link(n: AudioNode, to: Dest | undefined): void {
    const d = this.dest(to);
    if (d instanceof AudioNode) n.connect(d);
    else n.connect(d);
  }

  /** Filtered noise with a percussive envelope. Returns the filter (for further automation). */
  burst(o: BurstOpts): BiquadFilterNode {
    const t = o.t ?? this.t;
    const a = o.a ?? 0.002;
    const h = o.h ?? 0;
    const len = a + h + o.d * 1.3 + 0.02;
    const src = this.noise(o.kind ?? 'white', t, len, o.rate ?? 1);
    const f = this.filt(o.type ?? 'bandpass', o.f, o.q ?? 0.8);
    if (o.f1 !== undefined) {
      f.frequency.setValueAtTime(o.f, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + (o.ft ?? a + h + o.d));
    }
    const g = this.gain(0);
    env(g.gain, t, o.g, a, h, o.d);
    src.connect(f);
    f.connect(g);
    this.link(g, o.to);
    return f;
  }

  /** One oscillator with a percussive envelope and an optional glide. */
  tone(o: ToneOpts): OscillatorNode {
    const t = o.t ?? this.t;
    const a = o.a ?? 0.002;
    const h = o.h ?? 0;
    const osc = this.osc(o.type ?? 'sine', o.f, t, a + h + o.d * 1.3 + 0.02);
    if (o.f1 !== undefined) {
      osc.frequency.setValueAtTime(o.f, t);
      osc.frequency.setTargetAtTime(o.f1, t, (o.ft ?? o.d) / 3);
    }
    const g = this.gain(0);
    env(g.gain, t, o.g, a, h, o.d);
    osc.connect(g);
    this.link(g, o.to);
    return osc;
  }

  /** A struck body: decaying partials. f in Hz, d = decay seconds, g = relative level per partial. */
  modes(o: { t?: number; f: readonly number[]; d: readonly number[] | number; g?: readonly number[] | number; gain: number; a?: number; to?: Dest; bend?: number }): void {
    const t = o.t ?? this.t;
    const sum = this.gain(o.gain);
    for (let i = 0; i < o.f.length; i++) {
      const d = typeof o.d === 'number' ? o.d / (1 + i * 0.35) : o.d[i];
      const g = o.g === undefined ? 1 / (1 + i * 0.6) : typeof o.g === 'number' ? o.g : o.g[i];
      this.tone({ t, f: o.f[i], f1: o.bend ? o.f[i] * o.bend : undefined, ft: d, a: o.a ?? 0.0015, d, g, to: sum });
    }
    this.link(sum, o.to);
  }

  /**
   * Stick-slip: a sawtooth at a few tens of hertz, its rate gliding and jittering, high-passed
   * into a train of ticks that rings a set of resonances. Hinges, timber, ice, steel.
   * amp: optional [fraction, level] contour.
   */
  creak(o: { t?: number; d: number; r0: number; r1: number; f: readonly number[]; q: number; g: number; jit?: number; to?: Dest; amp?: ReadonlyArray<readonly [number, number]>; hp?: number }): void {
    const t = o.t ?? this.t;
    const osc = this.osc('sawtooth', o.r0, t, o.d + 0.05);
    osc.frequency.setValueAtTime(o.r0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.r1), t + o.d);
    this.mod(osc.frequency, 11, o.r0 * (o.jit ?? 0.35), t, o.d + 0.05);
    const hp = this.filt('highpass', o.hp ?? 350, 0.7);
    osc.connect(hp);
    const g = this.gain(0);
    if (o.amp) curve(g.gain, t, o.amp.map(([u, v]) => [u * o.d, v * o.g] as const));
    else curve(g.gain, t, [[0, 0], [o.d * 0.12, o.g], [o.d * 0.8, o.g * 0.8], [o.d, 0]]);
    for (const f of o.f) {
      const bp = this.filt('bandpass', f * this.vary(1, 0.04), o.q);
      hp.connect(bp);
      bp.connect(g);
    }
    this.link(g, o.to);
  }

  /**
   * A throat: a harmonic source with a pitch contour, vibrato and drift, mixed with breath noise,
   * through parallel formant resonances. Used for wolves and for the player's own body.
   */
  voice(o: VoiceOpts): void {
    const t = o.t ?? this.t;
    const dur = o.dur;
    const osc = this.osc(o.wave ?? this.W.glottal, o.f[0][1], t, dur + 0.05);
    curve(osc.frequency, t, o.f.map(([u, hz]) => [u * dur, hz] as const), 'x');
    if (o.vibDepth) {
      const lf = this.osc('sine', o.vibRate ?? 5, t, dur + 0.05);
      const d = this.gain(0);
      // vibrato grows into the note
      curve(d.gain, t, [[0, 0], [dur * 0.4, o.vibDepth], [dur, o.vibDepth * 0.6]]);
      lf.connect(d);
      d.connect(osc.frequency);
    }
    if (o.jitter) this.mod(osc.frequency, 7, o.jitter, t, dur + 0.05);
    const src = this.gain(1);
    osc.connect(src);
    if (o.rough) {
      // roughness: the source gain itself rattles
      src.gain.value = 1 - o.rough[1] * 0.5;
      this.mod(src.gain, o.rough[0], o.rough[1] * 0.5, t, dur + 0.05);
    }
    const mix = this.gain(1);
    src.connect(mix);
    if (o.breath) {
      const n = this.noise('pink', t, dur + 0.05);
      const bf = this.filt('bandpass', o.breathHz ?? 1800, 0.5);
      const bg = this.gain(o.breath * 3);
      n.connect(bf);
      bf.connect(bg);
      bg.connect(mix);
    }
    const g = this.gain(0);
    const amp = o.amp ?? [[0, 0], [0.12, 1], [0.7, 0.85], [1, 0]];
    curve(g.gain, t, amp.map(([u, v]) => [u * dur, v * o.g] as const));
    for (const [f, q, lv] of o.formants) {
      const bp = this.filt('bandpass', f, q);
      const fg = this.gain(lv);
      mix.connect(bp);
      bp.connect(fg);
      fg.connect(g);
    }
    if (o.chest) {
      const lp = this.filt('lowpass', o.chestHz ?? 700, 0.6);
      const cg = this.gain(o.chest);
      mix.connect(lp);
      lp.connect(cg);
      cg.connect(g);
    }
    this.link(g, o.to);
  }

  /**
   * Sustained shaped noise: a filter whose frequency follows `f` ([seconds, Hz] points, exponential
   * segments) and a gain that follows `amp` ([seconds, level], linear). The last amp point ends it.
   */
  nz(o: { t?: number; kind?: NoiseKind; type?: BiquadFilterType; f: number | Pts; q?: number; amp: Pts; rate?: number; to?: Dest }): BiquadFilterNode {
    const t = o.t ?? this.t;
    const len = o.amp[o.amp.length - 1][0];
    const src = this.noise(o.kind ?? 'white', t, len + 0.03, o.rate ?? 1);
    const f = this.filt(o.type ?? 'bandpass', typeof o.f === 'number' ? o.f : o.f[0][1], o.q ?? 0.8);
    if (typeof o.f !== 'number') curve(f.frequency, t, o.f, 'x');
    const g = this.gain(0);
    curve(g.gain, t, o.amp);
    src.connect(f);
    f.connect(g);
    this.link(g, o.to);
    return f;
  }

  /** An oscillator on a frequency curve ([seconds, Hz], exponential) with an amplitude curve ([seconds, level]). */
  sweep(o: { t?: number; type?: OscillatorType | PeriodicWave; f: Pts; amp: Pts; to?: Dest }): OscillatorNode {
    const t = o.t ?? this.t;
    const len = o.amp[o.amp.length - 1][0];
    const osc = this.osc(o.type ?? 'sine', o.f[0][1], t, len + 0.03);
    curve(osc.frequency, t, o.f, 'x');
    const g = this.gain(0);
    curve(g.gain, t, o.amp);
    osc.connect(g);
    this.link(g, o.to);
    return osc;
  }

  /** A slow sine LFO scaled into a param (regular motion: pants, rotors, tremble). */
  wob(param: AudioParam, hz: number, depth: number, t = this.t, dur = Infinity): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.frequency.value = hz;
    o.start(t);
    if (dur !== Infinity) o.stop(t + dur);
    this.ctl.push(o);
    const g = this.gain(depth);
    o.connect(g);
    g.connect(param);
    return o;
  }

  /** Stop every source (loops, stolen voices). */
  stopAll(at: number): void {
    for (const s of [...this.srcs, ...this.ctl]) {
      try {
        s.stop(at);
      } catch {
        /* already stopped */
      }
    }
  }
}
