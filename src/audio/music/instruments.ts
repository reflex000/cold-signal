// The players. Six instruments built from oscillators, noise and filters; nothing is sampled.
// Each is a function that schedules ONE note on the audio clock into `dest` and returns the time
// at which that note has died away. A voice frees itself: when its last source ends it
// disconnects from the graph.
//
// Works the same on an AudioContext and an OfflineAudioContext.
import type { Player } from './score';

export type Ctx = BaseAudioContext;

export interface Kit {
  ctx: Ctx;
  /** 2 s of white noise; voices read it from random offsets. */
  noise: AudioBuffer;
  /** Bowed string, ordinary position: every harmonic, falling a little faster than a sawtooth. */
  bow: PeriodicWave;
  /** Bowed at the bridge: the fundamental nearly gone, a hump of glassy upper harmonics. */
  pont: PeriodicWave;
  /** Seeded 0..1. */
  rnd: () => number;
}

export interface NoteOn {
  /** Audio-clock time of the onset. */
  t: number;
  /** Written length in seconds. */
  dur: number;
  freq: number;
  midi: number;
  /** 0..1 dynamic (ppp 0.1 ... ff 1). */
  vel: number;
  colour: string;
}

export type Instrument = (k: Kit, n: NoteOn, dest: AudioNode) => number;

const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

/** Dynamic to linear amplitude: pp is about 19 dB under ff. */
export const dynAmp = (vel: number): number => Math.pow(clamp(vel, 0, 1), 1.25);

export function makeKit(ctx: Ctx, rnd: () => number): Kit {
  const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;

  const N = 48;
  const zero = new Float32Array(N + 1);
  const bow = new Float32Array(N + 1);
  const pont = new Float32Array(N + 1);
  for (let h = 1; h <= N; h++) {
    // A fixed ripple: no real string gives a ruler-straight spectrum.
    const ripple = 1 + 0.18 * Math.sin(h * 2.39 + 0.7);
    bow[h] = (ripple / Math.pow(h, 1.12)) * (h % 2 ? 1 : -1);
    const hump = 0.22 + 1.5 * Math.exp(-Math.pow((h - 8) / 5.5, 2));
    pont[h] = ((h === 1 ? 0.4 : 1) * hump * ripple) / h;
  }
  return {
    ctx,
    noise,
    bow: ctx.createPeriodicWave(zero, bow),
    pont: ctx.createPeriodicWave(zero, pont),
    rnd,
  };
}

// (PeriodicWave is an empty interface to the type checker, so a string would pass for one:
// the wave is a separate argument.)
function osc(ctx: Ctx, type: OscillatorType, freq: number, cents: number, t0: number, t1: number, wave?: PeriodicWave): OscillatorNode {
  const o = ctx.createOscillator();
  if (wave) o.setPeriodicWave(wave);
  else o.type = type;
  o.frequency.value = freq;
  o.detune.value = cents;
  o.start(t0);
  o.stop(t1);
  return o;
}

function noise(k: Kit, t0: number, t1: number): AudioBufferSourceNode {
  const s = k.ctx.createBufferSource();
  s.buffer = k.noise;
  s.loop = true;
  s.start(t0, k.rnd() * 1.9);
  s.stop(t1);
  return s;
}

function gain(ctx: Ctx, v: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function filter(ctx: Ctx, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function panner(ctx: Ctx, pan: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  return p;
}

/** When `last` (the source that stops last) ends, take the voice out of the graph. */
function release(last: AudioScheduledSourceNode, ...outs: AudioNode[]): void {
  last.onended = () => {
    for (const o of outs) o.disconnect();
  };
}

// ---------------------------------------------------------------------------------------------
// Cello: two bowed-string oscillators a few cents apart, a filter that opens with bow pressure,
// vibrato that only arrives once the note has settled, a breath of bow noise. The wooden body is
// in the player's channel strip. Colour `pont`: bowed at the bridge with a nervous tremolo, thin
// and glassy, no vibrato.

const cello: Instrument = (k, n, dest) => {
  const ctx = k.ctx;
  const pont = n.colour === 'pont';
  const { t, freq: f, vel } = n;
  const d = Math.max(0.3, n.dur);
  const amp = dynAmp(vel) * (pont ? 0.62 : 1);
  const att = pont ? clamp(d * 0.35, 0.2, 2.2) : Math.min(d * 0.4, 0.12 + 0.5 * (1 - vel));
  const tPeak = t + Math.max(att + 0.05, d * 0.45);
  const tEnd = t + d;
  const rel = pont ? 0.3 : 0.16 + 0.1 * (1 - vel);
  const tStop = tEnd + rel * 8;

  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp * 0.72, t + att);
  env.gain.linearRampToValueAtTime(amp, tPeak);
  env.gain.linearRampToValueAtTime(amp * 0.66, tEnd);
  env.gain.setTargetAtTime(0, tEnd, rel);

  const fc = pont ? 7500 : clamp(f * (4 + 9 * vel), 900, 5200);
  const lp = filter(ctx, 'lowpass', fc, 0.6);
  lp.frequency.setValueAtTime(fc * 0.5, t);
  lp.frequency.exponentialRampToValueAtTime(fc, tPeak);
  lp.frequency.exponentialRampToValueAtTime(fc * 0.7, tEnd);

  const wave = pont ? k.pont : k.bow;
  const mix = gain(ctx, 0.5);
  const o1 = osc(ctx, 'custom', f, 0, t, tStop, wave);
  const o2 = osc(ctx, 'custom', f, pont ? 8 : -6, t, tStop, wave);
  const g2 = gain(ctx, 0.45);
  o1.connect(mix);
  o2.connect(g2).connect(mix);

  // What the oscillators and the bow noise feed; ponticello puts a tremolo in between.
  let bowed: AudioNode = env;
  if (pont) {
    const trem = gain(ctx, 0.6);
    const a = osc(ctx, 'sine', 9.2 + k.rnd() * 2.2, 0, t, tStop);
    const b = osc(ctx, 'sine', 5.9 + k.rnd() * 1.3, 0, t, tStop);
    a.connect(gain(ctx, 0.28)).connect(trem.gain);
    b.connect(gain(ctx, 0.12)).connect(trem.gain);
    trem.connect(env);
    bowed = trem;
    mix.connect(filter(ctx, 'highpass', f * 2.2, 0.7)).connect(lp).connect(trem);
  } else {
    mix.connect(lp).connect(env);
    if (d >= 1) {
      // Vibrato opens late and widens with the dynamic.
      const start = t + Math.min(0.9, d * 0.35);
      const lfo = osc(ctx, 'sine', 4.9 + k.rnd() * 0.6, 0, t, tStop);
      const depth = gain(ctx, 0);
      depth.gain.setValueAtTime(0, start);
      depth.gain.linearRampToValueAtTime(8 + 10 * vel, start + Math.min(1.4, d * 0.4));
      lfo.connect(depth);
      depth.connect(o1.detune);
      depth.connect(o2.detune);
    }
  }
  const hair = noise(k, t, tStop);
  hair.connect(filter(ctx, 'bandpass', clamp(f * 5, 900, 4200), 0.9)).connect(gain(ctx, pont ? 0.16 : 0.045)).connect(bowed);

  env.connect(dest);
  release(o1, env);
  return tEnd + rel * 4;
};

// ---------------------------------------------------------------------------------------------
// Felt piano: stretched (inharmonic) partials, each with a quick first decay and a long second
// one that is shorter the higher the partial; two strings on the lowest partials beating slowly;
// the knock of a felted hammer; the damper comes down slowly, long after the written length.

const piano: Instrument = (k, n, dest) => {
  const ctx = k.ctx;
  const { t, freq: f, midi, vel } = n;
  const amp = dynAmp(vel);
  const B = 0.0003 * Math.pow(2, (midi - 50) / 14);
  const tau1 = clamp(6.5 * Math.pow(2, -(midi - 38) / 16), 0.8, 7);
  const ring = Math.max(n.dur, Math.min(3 * tau1, 9));
  const tOff = t + ring;
  const tStop = tOff + 2.2;
  const atk = 0.006 + 0.016 * (1 - vel);
  // Felt: the softer the blow the faster the partials fall away. Low strings keep more of them.
  const slope = 1.25 + 1.1 * (1 - vel) - 0.6 * clamp((130 - f) / 80, 0, 1);

  const lp = filter(ctx, 'lowpass', clamp(700 + 5000 * Math.pow(vel, 1.4) + 2.5 * f, 900, 8000), 0.5);
  const sum = gain(ctx, 0.55 * amp);
  sum.connect(lp);
  const count = f < 120 ? 9 : f < 300 ? 7 : f < 700 ? 5 : f < 1400 ? 4 : 3;
  let last: OscillatorNode | null = null;
  for (let h = 1; h <= count; h++) {
    const fh = h * f * Math.sqrt(1 + B * h * h);
    if (fh > 9000) break;
    const a = Math.pow(h, -slope) * (h === 1 ? 1 : 0.4 + 0.6 * Math.abs(Math.sin(h * Math.PI * 0.131)));
    const tau = tau1 / (1 + 0.32 * Math.pow(h - 1, 1.2));
    const pg = gain(ctx, 0);
    pg.gain.setValueAtTime(0, t);
    pg.gain.linearRampToValueAtTime(a, t + atk);
    pg.gain.setTargetAtTime(a * 0.42, t + atk, 0.11 + 0.1 / h);
    pg.gain.setTargetAtTime(0, t + atk + 0.45, tau);
    pg.gain.setTargetAtTime(0, tOff, 0.3);
    pg.connect(sum);
    if (h <= 2) {
      const cents = 0.8 + k.rnd() * 0.9;
      osc(ctx, 'sine', fh, -cents, t, tStop).connect(gain(ctx, 0.58)).connect(pg);
      last = osc(ctx, 'sine', fh, cents, t, tStop);
      last.connect(gain(ctx, 0.42)).connect(pg);
    } else {
      last = osc(ctx, 'sine', fh, 0, t, tStop);
      last.connect(pg);
    }
  }

  // Hammer: a soft wooden knock and a brush of felt.
  const hit = gain(ctx, 1);
  const ns = noise(k, t, t + 0.3);
  const knock = gain(ctx, 0);
  knock.gain.setValueAtTime(0, t);
  knock.gain.linearRampToValueAtTime(1.1 * amp, t + 0.003);
  knock.gain.setTargetAtTime(0, t + 0.003, 0.028);
  ns.connect(filter(ctx, 'lowpass', 420 + 800 * vel, 0.7)).connect(knock).connect(hit);
  const felt = gain(ctx, 0);
  felt.gain.setValueAtTime(0, t);
  felt.gain.linearRampToValueAtTime(0.12 * amp, t + 0.002);
  felt.gain.setTargetAtTime(0, t + 0.002, 0.011);
  ns.connect(filter(ctx, 'bandpass', 2400, 0.7)).connect(felt).connect(hit);

  lp.connect(dest);
  hit.connect(dest);
  if (last) release(last, lp, hit);
  return t + Math.min(ring, 2.4 * tau1) + 0.6;
};

// ---------------------------------------------------------------------------------------------
// Bowed glass / singing bowl: a pair of sines a fraction of a hertz apart, one to each side, so
// the tone turns slowly in the stereo field; weak upper modes, one of them inharmonic; a thread
// of friction noise at the pitch. Speaks slowly, lets go slowly.

const glass: Instrument = (k, n, dest) => {
  const ctx = k.ctx;
  const { t, freq: f, vel } = n;
  const d = Math.max(1, n.dur);
  const amp = dynAmp(vel);
  const att = clamp(d * 0.3, 0.5, 2.4);
  const tEnd = t + d;
  const rel = 0.75;
  const tStop = tEnd + rel * 7;

  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.setTargetAtTime(amp, t, att / 2.6);
  env.gain.setTargetAtTime(0, tEnd, rel);

  const beat = 0.3 + 0.5 * k.rnd();
  const side = k.rnd() < 0.5 ? -1 : 1;
  const a = osc(ctx, 'sine', f - beat / 2, 0, t, tStop);
  const b = osc(ctx, 'sine', f + beat / 2, 0, t, tStop);
  a.connect(gain(ctx, 0.5)).connect(panner(ctx, -0.55 * side)).connect(env);
  b.connect(gain(ctx, 0.5)).connect(panner(ctx, 0.55 * side)).connect(env);
  osc(ctx, 'sine', f * 2.003, 0, t, tStop).connect(gain(ctx, 0.07)).connect(env);
  osc(ctx, 'sine', f * 2.76, 0, t, tStop).connect(gain(ctx, 0.045)).connect(env);
  osc(ctx, 'sine', f * 2.997, 0, t, tStop).connect(gain(ctx, 0.025)).connect(env);
  noise(k, t, tStop).connect(filter(ctx, 'bandpass', f, 14)).connect(gain(ctx, 2.6)).connect(env);

  env.connect(dest);
  release(b, env);
  return tEnd + rel * 3.5;
};

// ---------------------------------------------------------------------------------------------
// Frame drum, soft mallet: the skin's fundamental dropping in pitch as it is struck, two of its
// inharmonic overtones dying faster, and the dull slap of the mallet. A heartbeat when played
// in pairs.

const drum: Instrument = (k, n, dest) => {
  const ctx = k.ctx;
  const { t, freq: f, vel } = n;
  const amp = dynAmp(vel);
  const tStop = t + 1.4;
  const out = gain(ctx, amp);

  const body = osc(ctx, 'sine', f, 0, t, tStop);
  body.frequency.setValueAtTime(f * (1.6 + 0.8 * vel), t);
  body.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  body.frequency.linearRampToValueAtTime(f * 0.93, t + 0.7);
  const bg = gain(ctx, 0);
  bg.gain.setValueAtTime(0, t);
  bg.gain.linearRampToValueAtTime(1, t + 0.004);
  bg.gain.setTargetAtTime(0, t + 0.004, 0.13 + 0.1 * vel);
  body.connect(bg).connect(out);

  const modes: [number, number, number][] = [
    [1.59, 0.3, 0.07],
    [2.3, 0.16, 0.05],
  ];
  for (const [ratio, level, tc] of modes) {
    const g = gain(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.003, tc);
    osc(ctx, 'sine', f * ratio, 0, t, t + 0.6).connect(g).connect(out);
  }

  const slap = gain(ctx, 0);
  slap.gain.setValueAtTime(0, t);
  slap.gain.linearRampToValueAtTime(2.2 * (0.4 + 0.6 * vel), t + 0.002);
  slap.gain.setTargetAtTime(0, t + 0.002, 0.022);
  noise(k, t, t + 0.25).connect(filter(ctx, 'lowpass', 250 + 700 * vel, 0.7)).connect(slap).connect(out);

  out.connect(dest);
  release(body, out);
  return t + 0.55;
};

// ---------------------------------------------------------------------------------------------
// Ice: a string harmonic or a struck icicle, very high. Two sines beating slowly, a faint octave,
// one inharmonic partial that pings and is gone, a hiss of air at the pitch. Each note sits
// somewhere different across the sky.

const ice: Instrument = (k, n, dest) => {
  const ctx = k.ctx;
  const { t, freq: f, vel } = n;
  const d = Math.max(0.5, n.dur);
  const amp = dynAmp(vel);
  const att = 0.04 + 0.3 * (1 - vel);
  const tEnd = t + d;
  const tStop = tEnd + 4.5;
  const where = (k.rnd() * 2 - 1) * 0.7;

  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp, t + att);
  env.gain.setTargetAtTime(amp * 0.25, t + att, Math.max(1, d * 0.55));
  env.gain.setTargetAtTime(0, tEnd, 0.7);

  const a = osc(ctx, 'sine', f, 0, t, tStop);
  const b = osc(ctx, 'sine', f + 0.5 + k.rnd(), 0, t, tStop);
  a.connect(gain(ctx, 0.6)).connect(panner(ctx, where)).connect(env);
  b.connect(gain(ctx, 0.4)).connect(panner(ctx, -where * 0.6)).connect(env);
  osc(ctx, 'sine', f * 2, 0, t, tStop).connect(gain(ctx, 0.05)).connect(env);
  if (f * 2.76 < 14000) {
    const ping = gain(ctx, 0);
    ping.gain.setValueAtTime(0, t);
    ping.gain.linearRampToValueAtTime(0.1, t + 0.01);
    ping.gain.setTargetAtTime(0, t + 0.01, 0.3);
    osc(ctx, 'sine', f * 2.76, 0, t, t + 2.5).connect(ping).connect(env);
  }
  noise(k, t, tStop).connect(filter(ctx, 'bandpass', f, 25)).connect(gain(ctx, 1.6)).connect(panner(ctx, where)).connect(env);

  env.connect(dest);
  release(a, env);
  return tEnd + 2.5;
};

// ---------------------------------------------------------------------------------------------
// Muted brass: three horns a few cents apart. Every note is a swell: it starts dark and closed,
// the filter opens as it grows (brass brightens as it gets louder), and it falls back. The mute
// (thin lows, a nasal peak) is in the channel strip.

const brass: Instrument = (k, n, dest) => {
  const ctx = k.ctx;
  const { t, freq: f, vel } = n;
  const d = Math.max(0.6, n.dur);
  const amp = dynAmp(vel);
  const tPeak = t + d * 0.58;
  const tEnd = t + d;
  const rel = 0.28;
  const tStop = tEnd + rel * 8;

  const env = gain(ctx, 0);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp * 0.22, t + Math.min(0.35, d * 0.2));
  env.gain.linearRampToValueAtTime(amp, tPeak);
  env.gain.linearRampToValueAtTime(amp * 0.4, tEnd);
  env.gain.setTargetAtTime(0, tEnd, rel);

  const lo = f * 1.3;
  const hi = clamp(f * (2.2 + 7 * vel), 400, 5000);
  const lp = filter(ctx, 'lowpass', lo, 1.1);
  lp.frequency.setValueAtTime(lo, t);
  lp.frequency.exponentialRampToValueAtTime(hi, tPeak);
  lp.frequency.exponentialRampToValueAtTime(lo * 1.2, tEnd);

  let last: OscillatorNode | null = null;
  for (const cents of [-7, 0, 6]) {
    last = osc(ctx, 'sawtooth', f, cents + (k.rnd() - 0.5) * 3, t, tStop);
    last.connect(gain(ctx, 0.33)).connect(lp);
  }
  lp.connect(env);
  noise(k, t, tStop).connect(filter(ctx, 'bandpass', 1600, 0.8)).connect(gain(ctx, 0.03)).connect(env);

  env.connect(dest);
  if (last) release(last, env);
  return tEnd + rel * 4;
};

export const INSTRUMENTS: Readonly<Record<Player, Instrument>> = { cello, piano, glass, drum, ice, brass };
