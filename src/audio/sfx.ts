// Every one-shot sound and every footstep. Each is a small program that builds a voice from the
// atoms in dsp.ts: nothing is sampled, and nothing sounds the same twice (s.rr / s.vary).
//
// Levels are written for the engine's raw bus at unity: interface about 0.1 peak, boots and body
// 0.15 to 0.35, tools and wolves 0.3 to 0.5, the rifle and breaking ice 0.8.
// Names starting with '_' are internal: the ambience plays them.
import type { Surface } from '../sim/types';
import type { SfxName } from './api';
import { type Dest, type Pts, type Scope, clamp, lerp, smooth, tanhCurve } from './dsp';
import type { SoundDef } from './engine';

const SAT = tanhCurve(3);
const SOFT = tanhCurve(1.5);

type Build = SoundDef['build'];
const ui = (build: Build): SoundDef => ({ bus: 'ui', pri: 2, air: 0, build });
/** the listener's own body (or a companion's when given a position) */
const own = (build: Build, pri = 2): SoundDef => ({ bus: 'body', pri, air: 0, ref: 2, local: 0.12, build });
const scale = (p: Pts, k: number): Pts => p.map(([a, b]) => [a, b * k] as const);

// ------------------------------------------------------------------------------------------
// shared pieces

/** A boot, a knee or a body pressing into snow: granular crackle that squeaks upward as it packs, over a soft thump. */
export function crunch(s: Scope, t: number, g: number, o: { deep?: number; len?: number; bright?: number } = {}): void {
  const deep = o.deep ?? 0;
  const len = (o.len ?? 1) * s.vary(1, 0.15);
  const br = (o.bright ?? 1) * s.vary(1, 0.12);
  const f0 = lerp(950, 480, deep) * br;
  s.burst({ t, kind: 'crunch', f: f0, f1: f0 * s.rr(1.7, 2.3), q: 1.5, a: lerp(0.006, 0.03, deep), h: 0.03 * len, d: 0.1 * len * (1 + deep), g: g * 2.6, rate: s.rr(0.8, 1.3) });
  s.burst({ t, kind: 'pink', type: 'lowpass', f: lerp(900, 420, deep), a: 0.008 + 0.02 * deep, d: 0.09 * len * (1 + deep * 0.8), g: g * 1.3 });
  if (deep < 0.7) {
    // the squeak of cold dry snow
    const fs = s.rr(1300, 2300) * br;
    s.burst({ t: t + 0.012, kind: 'crunch', f: fs, f1: fs * s.rr(1.15, 1.4), q: 8, a: 0.015, h: 0.02 * len, d: 0.07 * len, g: g * 3.2 * (1 - deep), rate: s.rr(0.45, 0.7) });
  }
  s.tone({ t, f: s.rr(80, 100), f1: 50, a: 0.004, d: 0.07 + 0.05 * deep, g: g * (0.35 + 0.3 * deep) });
}

/** Wood struck: a few damped partials and the tick of the contact. */
function knock(s: Scope, t: number, g: number, f = 300, d = 0.07, to?: Dest): void {
  s.modes({ t, f: [f, f * 2.07, f * 3.6, f * 5.9].map((x) => s.vary(x, 0.04)), d, g: [1, 0.6, 0.35, 0.2], gain: g * 0.5, to });
  s.burst({ t, f: f * 4, q: 0.7, a: 0.001, d: 0.012, g: g * 1.6, to });
}

/** Small steel parts meeting. */
function click(s: Scope, t: number, g: number, f = 2400, d = 0.03, to?: Dest): void {
  s.modes({ t, f: [f, f * 1.58, f * 2.41, f * 3.3].map((x) => s.vary(x, 0.03)), d, gain: g * 0.3, to });
  s.burst({ t, type: 'highpass', f: f * 1.2, a: 0.0005, d: 0.006, g: g * 2, to });
}

/** Parka cloth, a pack strap, a mitt. */
function cloth(s: Scope, t: number, g: number, d = 0.15, f = 1800, to?: Dest): void {
  s.nz({ t, kind: 'crunch', f: [[0, f * 0.7], [d * 0.5, f * 1.3], [d, f * 0.8]], q: 0.7, amp: [[0, 0], [d * 0.3, g * 2], [d, 0]], rate: s.rr(0.5, 0.9), to });
}

function thump(s: Scope, t: number, g: number, f = 90, d = 0.12, to?: Dest): void {
  s.tone({ t, f: f * 1.5, f1: f * 0.6, ft: d * 0.6, a: 0.003, d, g, to });
  s.burst({ t, kind: 'pink', type: 'lowpass', f: f * 4, a: 0.003, d: d * 0.7, g: g * 1.4, to });
}

/** One breath in or out. shudder 0..1 makes it tremble. */
function breath(s: Scope, t: number, d: number, g: number, inhale: boolean, shudder = 0, to?: Dest): void {
  const out = s.gain(1);
  const f: Pts = inhale ? [[0, 1250], [d, 2300]] : [[0, 1150], [d, 640]];
  s.nz({ t, kind: 'pink', f, q: inhale ? 1.3 : 0.9, amp: inhale ? [[0, 0], [d * 0.6, g * 3], [d, 0]] : [[0, 0], [d * 0.15, g * 3], [d, 0]], to: out });
  s.nz({ t, f: inhale ? 4400 : 3000, q: 0.8, amp: [[0, 0], [d * 0.4, g * 1.2], [d, 0]], to: out });
  if (shudder > 0) {
    out.gain.value = 1 - shudder * 0.45;
    s.wob(out.gain, s.rr(8, 12), shudder * 0.45, t, d + 0.05);
  }
  out.connect((to as AudioNode) ?? s.out);
}

/** A human sound made with the throat: mostly air, a little voice. */
function grunt(s: Scope, t: number, f0: number, f1: number, dur: number, g: number, rough = 0.4, to?: Dest): void {
  s.voice({
    t, dur, f: [[0, f0], [0.25, f0 * 1.06], [1, f1]],
    formants: [[640, 3, 1], [1150, 4, 0.5], [2500, 5, 0.2]],
    chest: 0.5, chestHz: 500, breath: 0.14, breathHz: 1600, jitter: f0 * 0.04, rough: [s.rr(28, 40), rough],
    amp: [[0, 0], [0.08, 1], [0.5, 0.7], [1, 0]], g, to,
  });
}

/** A wolf's howl: quick rise, a long hold that drifts and sometimes breaks upward, a falling end. */
function howlCall(s: Scope, t: number, f0: number, dur: number, g: number, to?: Dest): void {
  const f: [number, number][] = [[0, f0 * 0.6], [0.07, f0 * 0.86], [0.17, f0]];
  let u = 0.17;
  let cur = f0;
  if (s.rnd() < 0.65) {
    const b = s.rr(0.3, 0.52);
    f.push([b, cur * s.rr(0.99, 1.03)]);
    cur *= s.rr(1.1, 1.22);
    f.push([b + 0.012, cur]);
    u = b + 0.012;
    if (s.rnd() < 0.5) {
      const e = u + s.rr(0.1, 0.18);
      f.push([e, cur * 0.99]);
      cur = f0 * s.rr(0.97, 1.02);
      f.push([e + 0.015, cur]);
      u = e + 0.015;
    }
  }
  f.push([Math.max(u + 0.05, 0.72), cur * s.rr(0.94, 1.0)], [0.88, cur * 0.82], [1, cur * 0.55]);
  s.voice({
    t, dur, f,
    formants: [[520, 2.5, 1], [1150, 4, 0.55], [2350, 5, 0.3], [3400, 6, 0.1]],
    chest: 0.35, chestHz: 900, breath: 0.03, breathHz: 2200,
    vibRate: s.rr(4.8, 6), vibDepth: f0 * 0.007, jitter: f0 * 0.012,
    amp: [[0, 0], [0.06, 0.55], [0.2, 1], [0.7, 0.9], [0.9, 0.4], [1, 0]], g, to,
  });
}

/**
 * The sound lake ice makes when it cracks far away: the sheet carries high frequencies faster
 * than low ones, so a click arrives as a falling chirp.
 */
function pew(s: Scope, t: number, g: number, fHi: number, fLo: number, dur: number, to?: Dest): void {
  for (let k = 0; k < 3; k++) {
    const d = dur * (1 + k * 0.4);
    const a = g / (1 + k * 1.2);
    s.sweep({ t: t + k * 0.011, f: [[0, fHi / (1 + k * 0.25)], [d * 0.22, fLo * 3.2], [d, fLo]], amp: [[0, 0], [0.003, a], [d * 0.45, a * 0.35], [d, 0]], to });
  }
}

/** A small loudspeaker: narrow band and a little grit. Returns the node to feed. */
function speaker(s: Scope, g = 1): AudioNode {
  const hp = s.filt('highpass', 480, 0.8);
  const bp = s.filt('peaking', 1500, 0.9, 7);
  const lp = s.filt('lowpass', 3400, 0.7);
  s.chain(hp, bp, s.shaper(SOFT), lp, s.gain(g)).connect(s.out);
  return hp;
}

/** A small petrol engine: a pulse train through a muffler, and the rattle each stroke shakes loose. */
function motor(s: Scope, t: number, f: Pts, amp: Pts, g: number): OscillatorNode {
  const lp = s.filt('lowpass', 520, 0.9);
  s.chain(lp, s.shaper(SAT), s.gain(g * 0.55)).connect(s.out);
  const o = s.sweep({ t, type: s.W.pulse, f, amp, to: lp });
  s.sweep({ t, f: f.map(([a, b]) => [a, b] as const), amp: scale(amp, g * 0.35) });
  const len = amp[amp.length - 1][0];
  const n = s.noise('pink', t, len + 0.03);
  const ng = s.gain(0);
  const dep = s.gain(0);
  s.chain(n, s.filt('bandpass', 1500, 0.7), ng).connect(s.out);
  s.chain(o, dep).connect(ng.gain);
  // the rattle follows the envelope of the engine
  dep.gain.setValueAtTime(0, t);
  for (const [a, b] of amp) dep.gain.linearRampToValueAtTime(b * g * 1.1, t + a);
  return o;
}

// ------------------------------------------------------------------------------------------

const defs = {
  // ---------------------------------------------------------------- interface: quiet and dry
  ui_hover: ui((s) => {
    s.burst({ type: 'highpass', f: 4200, a: 0.001, d: 0.012, g: 0.2 });
    s.tone({ f: 2100, d: 0.012, g: 0.015 });
    return 0.05;
  }),
  ui_click: ui((s) => {
    s.burst({ f: 2300, q: 1.2, a: 0.0008, d: 0.016, g: 0.55 });
    s.tone({ f: 760, f1: 520, d: 0.03, g: 0.06 });
    return 0.08;
  }),
  ui_open: ui((s) => {
    s.nz({ kind: 'crunch', f: [[0, 900], [0.11, 2400]], q: 0.9, amp: [[0, 0], [0.03, 0.5], [0.12, 0]] });
    s.tone({ t: s.t + 0.02, f: 440, f1: 660, ft: 0.08, a: 0.01, d: 0.09, g: 0.045 });
    return 0.2;
  }),
  ui_close: ui((s) => {
    s.nz({ kind: 'crunch', f: [[0, 2200], [0.1, 800]], q: 0.9, amp: [[0, 0], [0.02, 0.5], [0.11, 0]] });
    s.tone({ t: s.t + 0.01, f: 620, f1: 400, ft: 0.07, a: 0.008, d: 0.08, g: 0.045 });
    return 0.2;
  }),
  toast: ui((s) => {
    s.tone({ f: 330, d: 0.14, g: 0.06 });
    s.tone({ f: 662, d: 0.08, g: 0.02 });
    s.burst({ f: 1200, q: 1, d: 0.015, g: 0.25 });
    return 0.3;
  }),
  objective: ui((s) => {
    // two soft struck tones, a fifth apart
    [293.66, 440].forEach((f, i) => {
      const t = s.t + i * 0.24;
      s.tone({ t, f, a: 0.03, d: 1.5, g: 0.07 });
      s.tone({ t, f: f * 2.003, a: 0.04, d: 0.9, g: 0.018 });
      s.tone({ t, f: f * 3.01, a: 0.02, d: 0.4, g: 0.006 });
    });
    return 2.4;
  }),
  part_found: ui((s) => {
    [293.66, 440, 587.33].forEach((f, i) => {
      const t = s.t + i * 0.17;
      s.tone({ t, f, a: 0.02, d: 1.7, g: 0.065 });
      s.tone({ t, f: f * 2.004, a: 0.03, d: 1.1, g: 0.02 });
      s.tone({ t, f: f * 4.02, a: 0.005, d: 0.25, g: 0.006 });
    });
    click(s, s.t, 0.12, 3100, 0.05);
    return 2.6;
  }),

  // ---------------------------------------------------------------- body
  jump: own((s) => {
    cloth(s, s.t, 0.1, 0.16, 1500);
    crunch(s, s.t, 0.09, { len: 0.6 });
    breath(s, s.t + 0.02, 0.16, 0.05, false);
    return 0.4;
  }, 1),
  land: own((s) => {
    thump(s, s.t, 0.22, 80, 0.13);
    crunch(s, s.t + 0.005, 0.17, { len: 1.3 });
    cloth(s, s.t + 0.03, 0.08, 0.2, 1300);
    breath(s, s.t + 0.06, 0.2, 0.05, false);
    return 0.6;
  }, 1),
  hurt: own((s) => {
    thump(s, s.t, 0.22, 110, 0.08);
    grunt(s, s.t + 0.01, s.rr(170, 200), 120, s.rr(0.24, 0.32), 0.3, 0.5);
    breath(s, s.t + 0.02, 0.22, 0.1, false);
    return 0.5;
  }),
  bite: own((s) => {
    // jaws close: a wet snap, cloth tearing, the weight of the animal
    click(s, s.t, 0.2, 1500, 0.02);
    s.burst({ kind: 'pink', type: 'lowpass', f: 900, a: 0.002, d: 0.06, g: 0.9 });
    s.nz({ t: s.t + 0.03, kind: 'crunch', f: [[0, 1400], [0.2, 3200]], q: 1.2, amp: [[0, 0], [0.04, 0.9], [0.22, 0]], rate: 0.7 });
    thump(s, s.t + 0.01, 0.25, 85, 0.1);
    grunt(s, s.t + 0.06, 190, 130, 0.25, 0.22, 0.6);
    return 0.5;
  }),
  downed: own((s) => {
    grunt(s, s.t, 170, 95, 0.55, 0.22, 0.5);
    thump(s, s.t + 0.35, 0.4, 62, 0.22);
    crunch(s, s.t + 0.36, 0.3, { len: 2.2, deep: 0.5 });
    cloth(s, s.t + 0.4, 0.15, 0.4, 1200);
    breath(s, s.t + 0.8, 0.9, 0.09, false, 0.5);
    return 1.9;
  }, 3),
  revived: own((s) => {
    // a hard breath in, then out
    breath(s, s.t, 0.5, 0.2, true);
    s.voice({ t: s.t + 0.05, dur: 0.4, f: [[0, 190], [1, 260]], formants: [[700, 3, 1], [1300, 4, 0.5]], breath: 0.3, g: 0.07 });
    breath(s, s.t + 0.6, 0.7, 0.12, false, 0.3);
    cloth(s, s.t + 0.3, 0.1, 0.4, 1500);
    return 1.5;
  }, 3),
  death: own((s) => {
    breath(s, s.t, 1.8, 0.14, false, 0.25);
    s.voice({ t: s.t, dur: 1.3, f: [[0, 160], [1, 85]], formants: [[560, 3, 1], [1000, 4, 0.4]], chest: 0.5, breath: 0.3, jitter: 6, amp: [[0, 0], [0.1, 1], [1, 0]], g: 0.1 });
    thump(s, s.t + 0.5, 0.35, 55, 0.3);
    crunch(s, s.t + 0.52, 0.2, { len: 2.5, deep: 0.6 });
    return 2.2;
  }, 3),
  shiver: own((s) => {
    const d = s.rr(0.7, 1.0);
    breath(s, s.t, d, 0.11, false, 1);
    chatter(s, s.t + 0.05, d * 0.8, 0.12);
    return d + 0.1;
  }, 1),
  gasp: own((s) => {
    breath(s, s.t, 0.38, 0.2, true);
    s.voice({ t: s.t, dur: 0.3, f: [[0, 210], [1, 300]], formants: [[800, 3, 1], [1500, 4, 0.5]], breath: 0.4, g: 0.06 });
    return 0.5;
  }),
  cough: own((s) => {
    const n = s.rnd() < 0.5 ? 2 : 3;
    let t = s.t;
    for (let i = 0; i < n; i++) {
      const g = 0.3 * (1 - i * 0.2);
      s.burst({ t, kind: 'pink', f: s.rr(700, 1000), f1: 420, q: 0.8, a: 0.004, d: 0.1, g: g * 3 });
      s.burst({ t, f: 2600, q: 0.7, a: 0.003, d: 0.05, g: g });
      grunt(s, t, s.rr(150, 180), 105, 0.11, g * 0.7, 0.8);
      t += s.rr(0.2, 0.3);
    }
    breath(s, t + 0.05, 0.35, 0.08, true, 0.3);
    return t - s.t + 0.5;
  }),
  eat: own((s) => {
    cloth(s, s.t, 0.07, 0.18, 3200);
    let t = s.t + 0.25;
    for (let i = 0; i < 3; i++) {
      s.burst({ t, kind: 'crunch', f: s.rr(1500, 2300), q: 1.2, a: 0.004, d: s.rr(0.06, 0.1), g: 0.8, rate: s.rr(0.6, 1) });
      s.burst({ t, kind: 'pink', type: 'lowpass', f: 600, a: 0.004, d: 0.06, g: 0.4 });
      t += s.rr(0.26, 0.36);
    }
    return t - s.t + 0.1;
  }, 1),
  drink: own((s) => {
    // liquid in a flask, then swallows
    s.nz({ kind: 'pink', f: [[0, 500], [0.2, 1300], [0.35, 700]], q: 2, amp: [[0, 0], [0.1, 0.5], [0.35, 0]] });
    let t = s.t + 0.35;
    for (let i = 0; i < 3; i++) {
      const f = s.rr(150, 190);
      s.sweep({ t, f: [[0, f], [0.07, f * 1.9], [0.13, f * 1.3]], amp: [[0, 0], [0.02, 0.16], [0.13, 0]] });
      s.burst({ t, kind: 'pink', type: 'lowpass', f: 500, a: 0.01, d: 0.07, g: 0.3 });
      t += s.rr(0.3, 0.38);
    }
    breath(s, t, 0.3, 0.06, false);
    return t - s.t + 0.4;
  }, 1),
  bandage: own((s) => {
    // tear the wrapper, wind the gauze
    s.nz({ kind: 'crunch', f: [[0, 2000], [0.3, 4200]], q: 1, amp: [[0, 0], [0.02, 1.1], [0.25, 0.7], [0.32, 0]], rate: 1.4 });
    for (let i = 0; i < 3; i++) cloth(s, s.t + 0.5 + i * 0.32, 0.09, 0.24, s.rr(1200, 1800));
    return 1.6;
  }, 1),
  heartbeat: own((s) => {
    const lp = s.filt('lowpass', 140, 0.7);
    lp.connect(s.out);
    s.tone({ f: 62, f1: 44, ft: 0.07, a: 0.012, d: 0.1, g: 0.5, to: lp });
    s.tone({ t: s.t + 0.13, f: 74, f1: 50, ft: 0.05, a: 0.01, d: 0.075, g: 0.34, to: lp });
    s.burst({ kind: 'brown', type: 'lowpass', f: 90, a: 0.01, d: 0.08, g: 0.5, to: lp });
    return 0.4;
  }, 1),
  /** internal: one breath cycle. a = cold 0..1 (rate and raggedness), b = level */
  _breath: own((s, x) => {
    const c = x.a;
    const g = x.b;
    const tin = lerp(1.25, 0.42, c) * s.vary(1, 0.12);
    const tout = lerp(1.7, 0.6, c) * s.vary(1, 0.15);
    const rag = smooth(0.4, 0.9, c);
    if (rag > 0.3 && s.rnd() < rag * 0.6) {
      // the breath catches halfway in
      breath(s, s.t, tin * 0.45, g * 0.8, true, rag * 0.6);
      breath(s, s.t + tin * 0.55, tin * 0.45, g, true, rag * 0.6);
    } else breath(s, s.t, tin, g * 0.85, true, rag * 0.5);
    breath(s, s.t + tin + 0.08, tout, g, false, rag * s.rr(0.5, 1));
    return tin + tout + 0.2;
  }, 0),
  /** internal: teeth. a = how hard */
  _chatter: own((s, x) => {
    const d = s.rr(0.5, 1.3);
    chatter(s, s.t, d, 0.1 + 0.12 * x.a);
    return d + 0.1;
  }, 0),

  // ---------------------------------------------------------------- items and tools
  pickup: { pri: 1, ref: 2, build(s) {
    cloth(s, s.t, 0.1, 0.12, 2000);
    knock(s, s.t + 0.07, 0.1, s.rr(500, 700), 0.03);
    return 0.3;
  } },
  pickup_wood: { pri: 1, ref: 2, build(s) {
    knock(s, s.t, 0.22, s.rr(380, 480), 0.05);
    knock(s, s.t + s.rr(0.06, 0.1), 0.14, s.rr(520, 640), 0.04);
    s.nz({ t: s.t + 0.02, kind: 'crunch', f: 900, q: 1, amp: [[0, 0], [0.03, 0.5], [0.14, 0]], rate: 0.6 });
    return 0.35;
  } },
  open_crate: { pri: 1, ref: 2.5, local: 0.3, build(s) {
    click(s, s.t, 0.25, 1900, 0.03);
    click(s, s.t + 0.09, 0.2, 2300, 0.03);
    s.creak({ t: s.t + 0.2, d: 0.5, r0: 38, r1: 14, f: [420, 910, 1650], q: 9, g: 0.5 });
    thump(s, s.t + 0.75, 0.2, 120, 0.09);
    knock(s, s.t + 0.75, 0.14, 210, 0.08);
    return 1.1;
  } },
  equip: { pri: 1, ref: 2, build(s) {
    cloth(s, s.t, 0.12, 0.2, 1500);
    click(s, s.t + 0.17, 0.14, 2100, 0.025);
    return 0.4;
  } },
  axe_swing: { pri: 1, ref: 2.5, build(s) {
    const d = s.rr(0.24, 0.3);
    s.nz({ kind: 'pink', f: [[0, 420], [d * 0.55, s.rr(1500, 1900)], [d, 520]], q: 1.6, amp: [[0, 0], [d * 0.5, 1.3], [d, 0]] });
    s.nz({ f: [[0, 2000], [d * 0.55, 5200], [d, 2400]], q: 1.2, amp: [[0, 0], [d * 0.55, 0.25], [d, 0]] });
    cloth(s, s.t, 0.07, d, 1200);
    return d + 0.05;
  } },
  axe_wood: { pri: 2, ref: 6, local: 0.35, far: 0.35, build(s) {
    const f = s.rr(250, 340);
    s.tone({ f: 180, f1: 85, ft: 0.05, a: 0.001, d: 0.09, g: 0.45 });
    knock(s, s.t, 0.75, f, 0.06);
    s.burst({ type: 'highpass', f: 1900, a: 0.0005, d: 0.014, g: 2.2 });
    // the steel sings a little, chips fall
    s.modes({ f: [s.rr(2700, 3100), 4350, 6100], d: 0.12, gain: 0.035 });
    s.nz({ t: s.t + 0.03, kind: 'crunch', f: 2600, q: 0.8, amp: [[0, 0], [0.02, 0.45], [0.16, 0]], rate: 1.2 });
    return 0.4;
  } },
  axe_flesh: { pri: 2, ref: 4, build(s) {
    thump(s, s.t, 0.45, 75, 0.12);
    s.burst({ kind: 'pink', type: 'lowpass', f: 700, f1: 250, a: 0.002, d: 0.09, g: 1.3 });
    s.nz({ t: s.t + 0.01, kind: 'crunch', f: [[0, 700], [0.1, 380]], q: 1.2, amp: [[0, 0], [0.015, 0.9], [0.12, 0]], rate: 0.5 });
    return 0.35;
  } },
  wood_split: { pri: 2, ref: 6, local: 0.35, far: 0.3, build(s) {
    s.burst({ type: 'highpass', f: 1500, a: 0.0005, d: 0.02, g: 2.4 });
    knock(s, s.t, 0.6, s.rr(210, 260), 0.07);
    // fibres tearing
    s.nz({ t: s.t + 0.01, kind: 'crunch', f: [[0, 1100], [0.22, 2900]], q: 1.4, amp: [[0, 0], [0.02, 1.5], [0.14, 0.8], [0.26, 0]], rate: s.rr(0.9, 1.3) });
    // the two halves fall
    knock(s, s.t + s.rr(0.3, 0.38), 0.3, s.rr(330, 400), 0.06);
    knock(s, s.t + s.rr(0.42, 0.55), 0.24, s.rr(430, 520), 0.05);
    crunch(s, s.t + 0.45, 0.07, { len: 0.7 });
    return 0.85;
  } },
  tree_fall: { pri: 3, ref: 18, local: 0.3, far: 0.9, build(s) {
    // the hinge groans, fibres let go one by one, the crown comes down through the air, the trunk hits
    s.creak({ d: 1.5, r0: 9, r1: 46, f: [180, 410, 870, 1500], q: 7, g: 1.1, jit: 0.5, amp: [[0, 0], [0.2, 0.5], [0.8, 1], [1, 0.3]] });
    for (let i = 0; i < 7; i++) {
      const t = s.t + 0.5 + i * i * 0.022 + s.rr(0, 0.05);
      s.burst({ t, type: 'highpass', f: s.rr(1200, 2200), a: 0.0005, d: 0.02, g: s.rr(1, 2) });
      knock(s, t, s.rr(0.2, 0.4), s.rr(170, 260), 0.05);
    }
    s.nz({ t: s.t + 1.3, kind: 'pink', f: [[0, 500], [0.8, 1700], [1.0, 900]], q: 0.8, amp: [[0, 0], [0.75, 1.0], [1.0, 0.2], [1.1, 0]] });
    const hit = s.t + 2.3;
    thump(s, hit, 0.75, 46, 0.5);
    s.burst({ t: hit, kind: 'brown', type: 'lowpass', f: 160, a: 0.004, d: 0.6, g: 2 });
    s.nz({ t: hit, kind: 'crunch', f: [[0, 2400], [1.1, 800]], q: 0.6, amp: [[0, 0], [0.03, 2.2], [0.3, 1], [1.2, 0]], rate: 0.8 });
    s.nz({ t: hit + 0.05, kind: 'pink', type: 'lowpass', f: [[0, 1500], [1.6, 300]], amp: [[0, 0], [0.15, 0.9], [1.7, 0]] });
    return 4.2;
  } },
  rifle_shot: { pri: 3, ref: 40, local: 0.5, far: 1.6, build(s, x) {
    const t = s.t;
    const far = smooth(90, 220, x.dist);
    const sh = s.shaper(SAT);
    s.chain(sh, s.gain(0.8)).connect(s.out);
    // the crack
    s.burst({ t, type: 'highpass', f: lerp(700, 250, far), a: 0.0004, d: lerp(0.045, 0.09, far), g: 3.4 * (1 - far * 0.6), to: sh });
    // the muzzle: a thump you feel, and the gas
    s.tone({ t, f: 170, f1: 40, ft: 0.1, a: 0.001, d: 0.3, g: 1.1, to: sh });
    s.burst({ t, kind: 'pink', type: 'lowpass', f: 2600, f1: 220, ft: 0.25, a: 0.001, d: 0.4, g: 2.4, to: sh });
    s.modes({ t, f: [2350, 3700, 5200], d: 0.05, gain: 0.05 * (1 - far) });
    // then the mountain answers: the slope across the valley, the far wall, the ridge
    const roll: Pts = [[0, 0], [0.32, 0], [0.5, 0.3], [0.75, 0.12], [0.95, 0.26], [1.3, 0.08], [1.6, 0.18], [2.2, 0.05], [2.7, 0.1], [3.6, 0.02], [4.5, 0]];
    s.nz({ t, kind: 'brown', type: 'lowpass', f: [[0, 700], [4.5, 140]], q: 0.6, amp: scale(roll, 1.5) });
    s.nz({ t, kind: 'pink', f: [[0, 900], [4.5, 300]], q: 0.6, amp: scale(roll, 0.35) });
    s.far = 1.6 + far;
    return 4.6;
  } },
  rifle_bolt: { pri: 2, ref: 2.5, build(s) {
    // up, back, forward, down
    const t = s.t;
    click(s, t, 0.3, 2300, 0.025);
    s.nz({ t: t + 0.05, f: [[0, 2600], [0.09, 3800]], q: 2, amp: [[0, 0], [0.02, 0.5], [0.09, 0]] });
    click(s, t + 0.14, 0.4, 1700, 0.035);
    s.nz({ t: t + 0.3, f: [[0, 3800], [0.08, 2700]], q: 2, amp: [[0, 0], [0.02, 0.5], [0.08, 0]] });
    click(s, t + 0.38, 0.42, 1900, 0.03);
    click(s, t + 0.47, 0.34, 2500, 0.03);
    thump(s, t + 0.38, 0.06, 180, 0.04);
    return 0.65;
  } },
  rifle_dry: { pri: 2, ref: 2, build(s) {
    click(s, s.t, 0.3, 1900, 0.02);
    s.tone({ f: s.rr(860, 940), d: 0.09, g: 0.012 });
    return 0.2;
  } },
  rifle_reload: { pri: 2, ref: 2.5, build(s) {
    let t = s.t;
    click(s, t, 0.3, 2300, 0.025);
    click(s, t + 0.13, 0.38, 1700, 0.035);
    t += 0.45;
    for (let i = 0; i < 3; i++) {
      // a round pressed down onto the follower spring
      click(s, t, 0.2, s.rr(3000, 3600), 0.02);
      s.tone({ t: t + 0.03, f: s.rr(600, 760), f1: 900, ft: 0.06, d: 0.07, g: 0.012 });
      click(s, t + 0.09, 0.24, s.rr(1500, 1800), 0.025);
      t += s.rr(0.34, 0.42);
    }
    click(s, t, 0.42, 1900, 0.03);
    click(s, t + 0.09, 0.34, 2500, 0.03);
    return t - s.t + 0.3;
  } },
  bullet_snow: { pri: 1, ref: 5, build(s) {
    s.nz({ kind: 'pink', f: [[0, 2600], [0.07, 380]], q: 1.2, amp: [[0, 0], [0.003, 2.2], [0.09, 0]] });
    thump(s, s.t, 0.18, 90, 0.07);
    s.nz({ t: s.t + 0.02, kind: 'crunch', f: 1700, q: 0.7, amp: [[0, 0], [0.03, 0.5], [0.25, 0]] });
    return 0.35;
  } },
  bullet_wood: { pri: 1, ref: 6, local: 0.2, build(s) {
    s.burst({ type: 'highpass', f: 1800, a: 0.0004, d: 0.015, g: 2.4 });
    knock(s, s.t, 0.6, s.rr(260, 380), 0.05);
    s.nz({ t: s.t + 0.01, kind: 'crunch', f: [[0, 3200], [0.14, 1800]], q: 1, amp: [[0, 0], [0.01, 0.8], [0.16, 0]], rate: 1.3 });
    return 0.3;
  } },
  flare_shot: { pri: 3, ref: 14, local: 0.3, far: 0.8, build(s) {
    const sh = s.shaper(SAT);
    s.chain(sh, s.gain(0.5)).connect(s.out);
    // a hollow pop from a short wide barrel
    s.tone({ f: 250, f1: 70, ft: 0.07, a: 0.001, d: 0.16, g: 1.1, to: sh });
    s.burst({ f: 720, q: 1.4, a: 0.001, d: 0.09, g: 3.2, to: sh });
    s.burst({ type: 'highpass', f: 2200, a: 0.0005, d: 0.03, g: 1.2, to: sh });
    // the star leaves, already burning
    s.nz({ t: s.t + 0.02, type: 'highpass', f: [[0, 1800], [1.1, 4200]], q: 0.8, amp: [[0, 0], [0.04, 0.45], [0.5, 0.14], [1.3, 0]] });
    s.nz({ t: s.t + 0.02, kind: 'pink', f: [[0, 800], [1.0, 1900]], q: 2.5, amp: [[0, 0], [0.05, 0.6], [0.6, 0.12], [1.2, 0]] });
    return 1.5;
  } },
  flare_land: { pri: 1, ref: 6, build(s) {
    crunch(s, s.t, 0.2, { len: 0.8 });
    // snow flashing to steam
    s.nz({ type: 'highpass', f: [[0, 2600], [0.7, 5000]], amp: [[0, 0], [0.02, 0.5], [0.25, 0.2], [0.8, 0]] });
    s.nz({ kind: 'dust', type: 'highpass', f: 2000, amp: [[0, 0], [0.05, 1.5], [0.8, 0]] });
    return 0.9;
  } },
  light_click: { pri: 1, ref: 2, build(s) {
    click(s, s.t, 0.09, 3100, 0.012);
    click(s, s.t + 0.035, 0.13, 2500, 0.015);
    s.tone({ f: 1100, d: 0.02, g: 0.012 });
    return 0.12;
  } },
  radio_crank: { pri: 1, ref: 2.5, build(s) {
    // one turn of the handle: the pawl ticks, the dynamo winds up and runs down
    const d = s.rr(0.5, 0.62);
    const n = 9;
    for (let i = 0; i < n; i++) click(s, s.t + (i / n) * d + s.rr(0, 0.006), s.rr(0.07, 0.11), s.rr(3200, 3900), 0.008);
    const bp = s.filt('bandpass', 1400, 1.2);
    bp.connect(s.out);
    s.sweep({ type: s.W.pulse, f: [[0, 70], [d * 0.5, 150], [d * 1.4, 60]], amp: [[0, 0], [d * 0.4, 0.18], [d * 1.4, 0]], to: bp });
    s.sweep({ type: 'triangle', f: [[0, 600], [d * 0.5, 1250], [d * 1.4, 520]], amp: [[0, 0], [d * 0.45, 0.022], [d * 1.4, 0]] });
    s.nz({ kind: 'crunch', f: 2400, q: 1, amp: [[0, 0], [d * 0.5, 0.2], [d, 0]], rate: 0.6 });
    return d * 1.5;
  } },
  radio_blip: { pri: 1, ref: 2.5, build(s) {
    const sp = speaker(s, 0.5);
    s.nz({ kind: 'dust', type: 'highpass', f: 1200, amp: [[0, 0], [0.01, 2], [0.2, 2], [0.24, 0]], to: sp });
    s.sweep({ f: [[0, 1040], [0.08, 1040]], amp: [[0, 0], [0.005, 0.2], [0.07, 0.2], [0.08, 0]], to: sp });
    s.sweep({ t: s.t + 0.1, f: [[0, 1310], [0.1, 1310]], amp: [[0, 0], [0.005, 0.2], [0.09, 0.2], [0.1, 0]], to: sp });
    return 0.3;
  } },
  match_strike: { pri: 2, ref: 2, build(s) {
    // the head drags, catches, flares and settles
    s.nz({ kind: 'crunch', f: [[0, 2600], [0.13, 4600]], q: 1.2, amp: [[0, 0], [0.02, 0.8], [0.11, 1.2], [0.14, 0.2], [0.16, 0]], rate: 1.5 });
    s.nz({ t: s.t + 0.12, type: 'highpass', f: [[0, 1500], [0.08, 2600], [0.5, 3600]], amp: [[0, 0], [0.03, 0.75], [0.15, 0.3], [0.55, 0]] });
    s.nz({ t: s.t + 0.12, kind: 'pink', f: [[0, 500], [0.1, 900], [0.4, 600]], q: 0.8, amp: [[0, 0], [0.04, 0.9], [0.4, 0]] });
    s.nz({ t: s.t + 0.14, kind: 'crackle', type: 'highpass', f: 1800, amp: [[0, 3], [0.5, 0]] });
    return 0.75;
  } },
  match_fail: { pri: 2, ref: 2, build(s) {
    s.nz({ kind: 'crunch', f: [[0, 2600], [0.12, 4200]], q: 1.2, amp: [[0, 0], [0.02, 0.8], [0.1, 1], [0.13, 0]], rate: 1.5 });
    // a spit of flame the wind takes at once
    s.nz({ t: s.t + 0.11, type: 'highpass', f: [[0, 1800], [0.12, 4000]], amp: [[0, 0], [0.02, 0.4], [0.14, 0]] });
    s.nz({ t: s.t + 0.34, kind: 'crunch', f: [[0, 2800], [0.08, 3800]], q: 1.2, amp: [[0, 0], [0.02, 0.5], [0.09, 0]], rate: 1.5 });
    return 0.5;
  } },

  // ---------------------------------------------------------------- fire
  fire_catch: { pri: 2, ref: 4, local: 0.2, build(s) {
    // air drawn in, the whoomp, then the first crackle
    s.nz({ kind: 'brown', type: 'lowpass', f: [[0, 160], [0.3, 520], [1.2, 300]], amp: [[0, 0], [0.25, 2.2], [0.6, 1], [1.4, 0]] });
    s.nz({ kind: 'pink', f: [[0, 500], [0.3, 1300], [1.2, 800]], q: 0.6, amp: [[0, 0], [0.28, 0.8], [1.3, 0]] });
    s.nz({ t: s.t + 0.2, kind: 'crackle', f: 2800, q: 0.6, amp: [[0, 0], [0.4, 4], [1.6, 2.5], [2, 0]], rate: 1.2 });
    return 2.3;
  } },
  fire_feed: { pri: 1, ref: 4, local: 0.2, build(s) {
    knock(s, s.t, 0.3, s.rr(230, 300), 0.06);
    knock(s, s.t + 0.08, 0.16, s.rr(340, 420), 0.05);
    // embers burst up
    s.nz({ t: s.t + 0.03, kind: 'crackle', type: 'highpass', f: 1500, amp: [[0, 0], [0.03, 6], [0.5, 2], [1.1, 0]], rate: 1.6 });
    s.nz({ t: s.t + 0.03, kind: 'dust', type: 'highpass', f: 3000, amp: [[0, 0], [0.04, 2], [0.7, 0]] });
    s.nz({ t: s.t + 0.05, kind: 'brown', type: 'lowpass', f: 380, amp: [[0, 0], [0.2, 1.2], [1, 0]] });
    return 1.3;
  } },
  fire_die: { pri: 1, ref: 4, build(s) {
    // the last flame goes: hiss, a few ticks, nothing
    s.nz({ type: 'highpass', f: [[0, 2200], [1.5, 5000]], amp: [[0, 0], [0.05, 0.4], [0.5, 0.18], [1.8, 0]] });
    s.nz({ kind: 'brown', type: 'lowpass', f: [[0, 400], [0.8, 120]], amp: [[0, 0.9], [0.9, 0]] });
    s.nz({ kind: 'crackle', f: 2200, q: 0.7, amp: [[0, 3], [0.6, 1.5], [2.2, 0]], rate: 0.6 });
    return 2.4;
  } },
  fire_pop: { pri: 1, ref: 4, local: 0.15, build(s) {
    const f = s.rr(1500, 2600);
    s.burst({ type: 'highpass', f: 900, a: 0.0004, d: 0.006, g: 2.4 });
    s.modes({ f: [f, f * 1.7, f * 2.6], d: 0.012, gain: 0.25 });
    thump(s, s.t, 0.07, 190, 0.03);
    s.nz({ t: s.t + 0.01, kind: 'dust', type: 'highpass', f: 3500, amp: [[0, 2.5], [0.3, 0]] });
    return 0.35;
  } },

  // ---------------------------------------------------------------- wolves
  howl: { pri: 3, ref: 30, local: 0.4, far: 1.1, build(s, x) {
    const dur = s.rr(3.2, 5.2);
    const far = smooth(120, 350, x.dist);
    howlCall(s, s.t, s.rr(330, 470), dur, 0.42);
    s.far = 1.1 + far * 1.2;
    return dur + 0.2;
  } },
  /** The pack somewhere on the mountain: several voices at different pitches, dulled by the air and answered by the far walls. */
  howl_far: { pri: 2, ref: 60, far: 2.6, air: 0.3, build(s) {
    const lp = s.filt('lowpass', 1500, 0.6);
    s.chain(lp, s.filt('highpass', 240, 0.7)).connect(s.out);
    const n = s.pick([2, 3, 3, 4]);
    let t = s.t;
    let end = 0;
    for (let i = 0; i < n; i++) {
      const dur = s.rr(3, 5);
      const p = s.pan(s.rr(-0.6, 0.6));
      p.connect(lp);
      howlCall(s, t, s.rr(290, 500), dur, 0.22 * s.rr(0.6, 1), p);
      end = Math.max(end, t - s.t + dur);
      t += s.rr(0.5, 2.2);
    }
    return end + 0.2;
  } },
  growl: { pri: 2, ref: 5, local: 0.2, build(s) {
    const dur = s.rr(1.2, 1.8);
    s.voice({
      dur, f: [[0, 76], [0.3, 94], [0.8, 86], [1, 68]], wave: s.W.rasp,
      formants: [[380, 2, 1], [820, 3, 0.7], [1900, 4, 0.3], [2900, 4, 0.15]],
      chest: 0.9, chestHz: 300, breath: 0.2, breathHz: 1200, jitter: 6, rough: [s.rr(24, 33), 0.85],
      amp: [[0, 0], [0.25, 0.7], [0.6, 1], [0.85, 0.8], [1, 0]], g: 0.5,
    });
    return dur + 0.1;
  } },
  bark: { pri: 2, ref: 8, local: 0.3, far: 0.5, build(s) {
    const n = s.rnd() < 0.4 ? 2 : 1;
    let t = s.t;
    for (let i = 0; i < n; i++) {
      const f = s.rr(310, 380);
      s.voice({
        t, dur: s.rr(0.12, 0.16), f: [[0, f], [0.2, f * 1.25], [1, f * 0.55]], wave: s.W.rasp,
        formants: [[750, 2.5, 1], [1500, 3, 0.7], [2700, 4, 0.3]], chest: 0.6, breath: 0.3, rough: [60, 0.5],
        amp: [[0, 0], [0.08, 1], [0.5, 0.6], [1, 0]], g: 0.55,
      });
      s.burst({ t, f: 1300, q: 0.8, a: 0.003, d: 0.05, g: 1.1 });
      t += s.rr(0.22, 0.3);
    }
    return t - s.t + 0.1;
  } },
  yelp: { pri: 2, ref: 8, local: 0.3, far: 0.5, build(s) {
    const f = s.rr(600, 720);
    s.voice({ dur: s.rr(0.2, 0.28), f: [[0, f], [0.2, f * 1.75], [0.5, f * 1.4], [1, f * 0.72]], formants: [[1300, 3, 1], [2600, 4, 0.5], [3600, 5, 0.2]], breath: 0.1, amp: [[0, 0], [0.06, 1], [0.6, 0.6], [1, 0]], g: 0.55 });
    if (s.rnd() < 0.5) s.voice({ t: s.t + 0.3, dur: 0.14, f: [[0, f * 1.1], [0.3, f * 1.5], [1, f * 0.8]], formants: [[1300, 3, 1], [2600, 4, 0.5]], g: 0.3 });
    return 0.55;
  } },
  wolf_die: { pri: 2, ref: 8, local: 0.3, far: 0.4, build(s) {
    const f = s.rr(640, 760);
    s.voice({ dur: 0.95, f: [[0, f], [0.15, f * 1.18], [0.5, f * 0.75], [1, f * 0.36]], formants: [[1100, 3, 1], [2300, 4, 0.5], [3300, 5, 0.15]], breath: 0.15, vibRate: 9, vibDepth: 25, amp: [[0, 0], [0.05, 1], [0.4, 0.6], [1, 0]], g: 0.45 });
    thump(s, s.t + 0.5, 0.3, 65, 0.18);
    crunch(s, s.t + 0.52, 0.22, { len: 1.8, deep: 0.4 });
    breath(s, s.t + 0.9, 0.6, 0.06, false);
    return 1.6;
  } },
  paws: { pri: 0, ref: 3, build(s) {
    // one bound of a gallop in snow
    const g = [0, 0.085, 0.19, 0.265];
    for (let i = 0; i < 4; i++) crunch(s, s.t + g[i] + s.rr(0, 0.012), s.rr(0.07, 0.11), { len: 0.5, bright: 1.3 });
    return 0.5;
  } },

  // ---------------------------------------------------------------- world
  ice_creak: { pri: 1, ref: 8, far: 0.5, build(s) {
    const d = s.rr(0.9, 1.6);
    s.creak({ d, r0: s.rr(14, 22), r1: s.rr(30, 50), f: [640, 1180, 2100, 3300], q: 14, g: 0.9, jit: 0.6 });
    // the sheet flexes: a low groan under the ticks
    s.sweep({ f: [[0, s.rr(70, 90)], [d, s.rr(48, 60)]], amp: [[0, 0], [d * 0.3, 0.2], [d, 0]] });
    s.nz({ kind: 'brown', f: 130, q: 2, amp: [[0, 0], [d * 0.4, 1.3], [d, 0]] });
    return d + 0.1;
  } },
  /** A crack running through lake ice: a rifle-sharp report, then the falling "pew" as it rings down the sheet. */
  ice_crack: { pri: 3, ref: 25, far: 1.4, local: 0.2, build(s) {
    const sh = s.shaper(SAT);
    s.chain(sh, s.gain(0.55)).connect(s.out);
    s.burst({ type: 'highpass', f: 1300, a: 0.0004, d: 0.03, g: 3, to: sh });
    s.burst({ kind: 'pink', type: 'lowpass', f: 1800, f1: 200, ft: 0.12, a: 0.001, d: 0.16, g: 1.6, to: sh });
    s.tone({ f: 140, f1: 50, ft: 0.08, a: 0.001, d: 0.2, g: 0.6, to: sh });
    pew(s, s.t + 0.012, 0.3, s.rr(6500, 9000), s.rr(260, 420), s.rr(0.35, 0.6));
    // it runs on: a second, smaller chirp from farther down the crack
    pew(s, s.t + s.rr(0.25, 0.45), 0.1, s.rr(4000, 6000), s.rr(200, 300), s.rr(0.5, 0.8));
    return 1.6;
  } },
  ice_break: { pri: 3, ref: 10, far: 0.6, build(s) {
    const sh = s.shaper(SAT);
    s.chain(sh, s.gain(0.6)).connect(s.out);
    s.burst({ type: 'highpass', f: 1000, a: 0.0004, d: 0.035, g: 3, to: sh });
    s.tone({ f: 120, f1: 42, ft: 0.1, a: 0.001, d: 0.35, g: 0.9, to: sh });
    s.burst({ kind: 'pink', type: 'lowpass', f: 1400, f1: 180, ft: 0.2, a: 0.001, d: 0.3, g: 2, to: sh });
    // plates tipping and knocking together
    for (let i = 0; i < 9; i++) {
      const t = s.t + 0.03 + i * s.rr(0.035, 0.075);
      const f = s.rr(700, 2600);
      s.modes({ t, f: [f, f * 1.73, f * 2.9, f * 4.3], d: s.rr(0.03, 0.09), gain: s.rr(0.04, 0.12) });
      s.burst({ t, type: 'highpass', f: 2500, a: 0.0005, d: 0.01, g: s.rr(0.3, 0.8) });
    }
    s.nz({ t: s.t + 0.02, kind: 'crunch', f: [[0, 3000], [0.6, 1400]], q: 0.7, amp: [[0, 0], [0.03, 1.4], [0.7, 0]], rate: 1.2 });
    // water comes up through
    s.nz({ t: s.t + 0.12, kind: 'pink', type: 'lowpass', f: [[0, 500], [0.3, 1400], [0.9, 500]], amp: [[0, 0], [0.2, 0.9], [1.0, 0]] });
    return 1.3;
  } },
  /** The lake settling in the cold, a long way off: felt as much as heard. */
  ice_boom: { pri: 1, ref: 150, far: 1.6, air: 0.4, build(s) {
    const d = s.rr(1.4, 2.2);
    s.sweep({ f: [[0, s.rr(52, 64)], [d, s.rr(27, 33)]], amp: [[0, 0], [0.02, 0.5], [d * 0.3, 0.22], [d, 0]] });
    s.burst({ kind: 'brown', type: 'lowpass', f: 150, a: 0.01, d: d * 0.6, g: 2 });
    s.burst({ kind: 'pink', f: 300, q: 0.8, a: 0.004, d: 0.12, g: 0.9 });
    pew(s, s.t + 0.02, 0.09, s.rr(1400, 2200), s.rr(70, 110), d * 0.7);
    return d + 0.2;
  } },
  /** internal: a far pinging sweep across the lake */
  _ice_ping: { pri: 0, ref: 120, far: 2, air: 0.3, build(s) {
    const n = s.pick([1, 1, 2, 3]);
    let t = s.t;
    for (let i = 0; i < n; i++) {
      pew(s, t, 0.16 * s.rr(0.5, 1), s.rr(3000, 8000), s.rr(180, 420), s.rr(0.25, 0.7));
      t += s.rr(0.12, 0.5);
    }
    return t - s.t + 1.2;
  } },
  splash: { pri: 3, ref: 8, far: 0.3, build(s) {
    // the body goes in: a slap, the cavity closing, spray falling back, air coming up
    s.burst({ kind: 'pink', type: 'lowpass', f: 2400, f1: 300, ft: 0.2, a: 0.002, d: 0.3, g: 2.6 });
    thump(s, s.t, 0.5, 70, 0.25);
    s.nz({ t: s.t + 0.05, f: [[0, 1800], [0.3, 4200], [1.2, 2600]], q: 0.5, amp: [[0, 0], [0.12, 0.9], [0.5, 0.35], [1.3, 0]] });
    s.nz({ t: s.t + 0.1, kind: 'pink', f: [[0, 400], [0.25, 900], [1.2, 500]], q: 1.5, amp: [[0, 0], [0.2, 1.2], [1.4, 0]] });
    for (let i = 0; i < 14; i++) {
      const t = s.t + 0.25 + s.rr(0, 1.1);
      const f = s.rr(280, 900);
      s.sweep({ t, f: [[0, f], [0.05, f * s.rr(1.4, 2)]], amp: [[0, 0], [0.006, s.rr(0.03, 0.09)], [0.05, 0]] });
    }
    return 1.7;
  } },
  /** A gust coming across the slope and passing. */
  gust: { bus: 'ambience', pri: 0, ref: 30, air: 0, build(s) {
    const d = s.rr(2.6, 3.8);
    const pk = d * s.rr(0.4, 0.55);
    s.nz({ kind: 'pink', f: [[0, 260], [pk, s.rr(800, 1100)], [d, 320]], q: 0.9, amp: [[0, 0], [pk, 1.6], [d, 0]] });
    s.nz({ kind: 'brown', type: 'lowpass', f: [[0, 120], [pk, 320], [d, 140]], amp: [[0, 0], [pk, 1.1], [d, 0]] });
    s.nz({ type: 'highpass', f: [[0, 2500], [pk, 4500], [d, 3000]], amp: [[0, 0], [pk, 0.2], [d, 0]] });
    const fw = s.rr(650, 900);
    s.nz({ kind: 'pink', f: [[0, fw], [pk, fw * 1.6], [d, fw * 1.1]], q: 30, amp: [[0, 0], [pk * 0.7, 0], [pk, 3.5], [pk * 1.35, 0], [d, 0]] });
    return d + 0.1;
  } },
  branch_snow: { pri: 0, ref: 8, build(s) {
    // the load lets go, falls through the lower branches and lands; the branch springs back
    s.nz({ kind: 'pink', type: 'lowpass', f: [[0, 1600], [0.45, 500]], amp: [[0, 0], [0.2, 0.9], [0.5, 0.3], [0.55, 0]] });
    s.nz({ kind: 'crunch', f: [[0, 2400], [0.4, 1200]], q: 0.6, amp: [[0, 0], [0.15, 0.6], [0.5, 0]], rate: 0.5 });
    const hit = s.t + s.rr(0.4, 0.5);
    thump(s, hit, 0.3, 62, 0.16);
    crunch(s, hit, 0.14, { len: 1.6, deep: 0.8 });
    s.nz({ t: hit - 0.3, f: [[0, 2600], [0.5, 4200]], q: 0.8, amp: [[0, 0], [0.1, 0.16], [0.35, 0.05], [0.6, 0]] });
    return 1.2;
  } },
  door: { pri: 1, ref: 4, local: 0.5, build(s) {
    click(s, s.t, 0.25, 1500, 0.03);
    s.creak({ t: s.t + 0.06, d: s.rr(0.45, 0.6), r0: s.rr(26, 36), r1: s.rr(50, 70), f: [520, 1250, 2300], q: 12, g: 0.5 });
    const shut = s.t + 0.7;
    thump(s, shut, 0.4, 85, 0.14);
    knock(s, shut, 0.3, 170, 0.09);
    click(s, shut + 0.02, 0.2, 1700, 0.03);
    return 1.0;
  } },
  log_lift: { pri: 1, ref: 3, build(s) {
    s.nz({ kind: 'crunch', f: [[0, 600], [0.3, 1000]], q: 1, amp: [[0, 0], [0.1, 0.9], [0.35, 0]], rate: 0.5 });
    knock(s, s.t + 0.05, 0.25, s.rr(150, 190), 0.08);
    crunch(s, s.t + 0.1, 0.12, { len: 1.2 });
    breath(s, s.t + 0.15, 0.3, 0.08, false);
    return 0.6;
  } },
  log_drop: { pri: 2, ref: 5, local: 0.2, far: 0.2, build(s) {
    thump(s, s.t, 0.6, 58, 0.22);
    knock(s, s.t, 0.5, s.rr(120, 150), 0.1);
    crunch(s, s.t + 0.005, 0.3, { len: 1.5, deep: 0.4 });
    knock(s, s.t + s.rr(0.12, 0.18), 0.18, s.rr(160, 200), 0.07);
    return 0.7;
  } },
  generator_start: { pri: 3, ref: 10, local: 0.2, far: 0.3, build(s) {
    // the cord, two coughs that do not take, then it catches and climbs
    const t = s.t;
    for (let i = 0; i < 12; i++) click(s, t + i * 0.022, 0.08, 2800, 0.008);
    s.nz({ kind: 'pink', f: [[0, 500], [0.25, 1300]], q: 1.5, amp: [[0, 0], [0.2, 0.5], [0.28, 0]] });
    motor(s, t + 0.3, [[0, 9], [0.35, 14], [0.5, 6]], [[0, 0], [0.05, 0.8], [0.35, 0.7], [0.5, 0]], 0.7);
    motor(s, t + 1.0, [[0, 10], [0.3, 19], [0.55, 8]], [[0, 0], [0.05, 0.9], [0.4, 0.8], [0.55, 0]], 0.75);
    motor(s, t + 1.75, [[0, 11], [0.4, 26], [0.9, 49], [1.5, 44], [2.4, 46]], [[0, 0], [0.05, 0.9], [0.9, 1], [1.8, 0.9], [2.4, 0]], 0.8);
    return 4.3;
  } },
  generator_stop: { pri: 2, ref: 10, local: 0.2, build(s) {
    motor(s, s.t, [[0, 46], [0.7, 22], [1.2, 9], [1.5, 5]], [[0, 0.9], [0.8, 0.9], [1.3, 0.7], [1.5, 0]], 0.8);
    // hot metal ticking as it cools
    for (let i = 0; i < 5; i++) click(s, s.t + 1.7 + i * i * 0.09 + s.rr(0, 0.05), 0.05, s.rr(2600, 3800), 0.02);
    return 3.6;
  } },
  panel_install: { pri: 2, ref: 3, local: 0.3, build(s) {
    // slides home, seats, a thumbscrew, and the relay behind the panel pulls in
    s.nz({ f: [[0, 2200], [0.16, 3600]], q: 2.5, amp: [[0, 0], [0.03, 0.4], [0.17, 0]] });
    click(s, s.t + 0.17, 0.4, 1500, 0.04);
    thump(s, s.t + 0.17, 0.1, 150, 0.05);
    for (let i = 0; i < 4; i++) click(s, s.t + 0.42 + i * 0.07, 0.08, 3300, 0.01);
    const relay = s.t + 0.85;
    click(s, relay, 0.3, 1100, 0.03);
    thump(s, relay, 0.12, 110, 0.05);
    s.sweep({ t: relay, type: 'sawtooth', f: [[0, 100], [0.6, 100]], amp: [[0, 0], [0.03, 0.02], [0.4, 0.012], [0.6, 0]] });
    return 1.5;
  } },
  /** The call goes out: key down, the carrier opens, three tone bursts, the squelch tail. */
  transmit: { pri: 3, ref: 4, local: 0.2, build(s) {
    const sp = speaker(s, 0.6);
    click(s, s.t, 0.2, 1600, 0.02);
    s.nz({ t: s.t + 0.03, type: 'highpass', f: 900, amp: [[0, 0], [0.01, 0.5], [0.12, 0.12], [1.5, 0.1], [1.52, 0.5], [1.7, 0]], to: sp });
    s.sweep({ t: s.t + 0.05, f: [[0, 600], [0.06, 1050], [1.5, 1050]], amp: [[0, 0], [0.03, 0.05], [1.45, 0.05], [1.5, 0]], to: sp });
    for (let i = 0; i < 3; i++) {
      const t = s.t + 0.25 + i * 0.4;
      s.sweep({ t, f: [[0, 1310], [0.25, 1310]], amp: [[0, 0], [0.006, 0.24], [0.24, 0.24], [0.25, 0]], to: sp });
      s.sweep({ t, f: [[0, 1965], [0.25, 1965]], amp: [[0, 0], [0.006, 0.07], [0.24, 0.07], [0.25, 0]], to: sp });
    }
    return 1.9;
  } },
  metal_creak: { pri: 1, ref: 12, far: 0.6, local: 0.2, build(s) {
    // the tower working in the wind
    const d = s.rr(1.1, 2.0);
    s.creak({ d, r0: s.rr(7, 12), r1: s.rr(16, 30), f: [210, 470, 1130, 2480, 3900], q: 28, g: 1.5, jit: 0.5, hp: 150 });
    s.sweep({ f: [[0, s.rr(90, 110)], [d, s.rr(70, 84)]], amp: [[0, 0], [d * 0.4, 0.12], [d, 0]] });
    return d + 0.6;
  } },
  /** Snow thunder, or a slide letting go somewhere above: a long broken rumble. */
  thunder: { bus: 'ambience', pri: 2, ref: 400, far: 1.2, air: 0.3, build(s) {
    const d = s.rr(4.5, 6.5);
    const pts: [number, number][] = [[0, 0], [0.04, 1]];
    for (let u = 0.12; u < 0.9; u += s.rr(0.07, 0.16)) pts.push([u * d, s.rr(0.2, 1) * (1 - u)]);
    pts.push([d, 0]);
    s.nz({ kind: 'brown', type: 'lowpass', f: [[0, 420], [d, 70]], amp: scale(pts, 2.2) });
    s.nz({ kind: 'pink', f: [[0, 700], [d * 0.4, 220], [d, 110]], q: 0.5, amp: scale(pts, 0.9) });
    s.burst({ type: 'bandpass', f: 1400, q: 0.5, a: 0.002, d: 0.12, g: 0.8 });
    s.sweep({ f: [[0, 60], [d, 30]], amp: [[0, 0], [0.05, 0.3], [d * 0.5, 0.12], [d, 0]] });
    return d + 0.2;
  } },
  /** internal: the cabin's timbers taking the wind */
  _timber: { pri: 0, ref: 4, local: 0.8, build(s) {
    const d = s.rr(0.25, 0.9);
    s.creak({ d, r0: s.rr(10, 22), r1: s.rr(6, 30), f: [s.rr(240, 330), 610, 1180, 1900], q: 10, g: 0.8, jit: 0.6, hp: 200 });
    if (s.rnd() < 0.4) knock(s, s.t + d, 0.12, s.rr(140, 200), 0.06);
    return d + 0.2;
  } },
  /** internal: a trunk rubbing its neighbour in the wind */
  _trunk: { pri: 0, ref: 10, far: 0.3, build(s) {
    const d = s.rr(0.8, 2.2);
    s.creak({ d, r0: s.rr(5, 11), r1: s.rr(9, 24), f: [s.rr(160, 230), 390, 760, 1340], q: 9, g: 1.2, jit: 0.7, hp: 120, amp: [[0, 0], [0.3, 1], [0.6, 0.5], [0.8, 0.9], [1, 0]] });
    return d + 0.2;
  } },
  /** internal: the stovepipe and the tin roof ticking */
  _tick: { pri: 0, ref: 3, local: 0.6, build(s) {
    const n = s.pick([1, 1, 2, 3]);
    for (let i = 0; i < n; i++) click(s, s.t + i * s.rr(0.12, 0.4), s.rr(0.04, 0.09), s.rr(1800, 3400), s.rr(0.02, 0.06));
    return 1.4;
  } },
} satisfies Record<SfxName | `_${string}`, SoundDef>;

/** Teeth: bursts of quick clicks, the rate wandering. */
function chatter(s: Scope, t0: number, dur: number, g: number): void {
  let t = t0;
  while (t < t0 + dur) {
    const f = s.rr(1700, 2500);
    s.modes({ t, f: [f, f * 1.9, f * 3.1], d: 0.008, gain: g * s.rr(0.5, 1) });
    s.burst({ t, f: 3000, q: 1, a: 0.0005, d: 0.005, g: g * 2 });
    t += s.rr(0.055, 0.085) * (s.rnd() < 0.12 ? 2.5 : 1);
  }
}

// ------------------------------------------------------------------------------------------
// Footsteps. a = speed 0..1, b = snow depth 0..1.

const step = (ref: number, build: Build, local = 0): SoundDef => ({ pri: 1, ref, local, build });

const steps: Record<Surface, SoundDef> = {
  snow: step(2.5, (s, x) => {
    const sp = x.a;
    const deep = clamp(x.b) * 0.6;
    const g = 0.14 + 0.09 * sp;
    const gap = lerp(0.09, 0.045, sp) * s.vary(1, 0.2);
    // heel, then the roll onto the ball of the foot
    crunch(s, s.t, g, { deep, len: lerp(1.15, 0.8, sp) });
    crunch(s, s.t + gap, g * s.rr(0.45, 0.7), { deep, len: 0.7, bright: s.rr(1.15, 1.4) });
    if (s.rnd() < 0.3) cloth(s, s.t, 0.03, 0.2, 1500);
    return 0.5 + deep * 0.3;
  }),
  deep: step(2.5, (s, x) => {
    const sp = x.a;
    const deep = clamp(0.6 + 0.4 * (x.b || 0.6));
    const g = 0.15 + 0.07 * sp;
    // the leg pushes in to the knee: a long soft whumpf, hardly a squeak, then the drag out
    crunch(s, s.t, g, { deep, len: 1.5 });
    s.nz({ kind: 'pink', type: 'lowpass', f: [[0, 700], [0.3, 260]], amp: [[0, 0], [0.06, g * 4], [0.36, 0]] });
    s.nz({ t: s.t + 0.12, kind: 'crunch', f: [[0, 700], [0.3, 1500]], q: 0.8, amp: [[0, 0], [0.12, g * 3.5], [0.34, 0]], rate: s.rr(0.4, 0.6) });
    cloth(s, s.t + 0.05, 0.035, 0.3, 1300);
    return 0.75;
  }),
  rock: step(3, (s, x) => {
    const g = 0.16 + 0.1 * x.a;
    const f = s.rr(1700, 2400);
    // lug on stone: a hard tick, the boot's dull body, grit dragged under the sole
    s.modes({ f: [f, f * 1.62, f * 2.5], d: 0.012, gain: g * 0.7 });
    s.burst({ type: 'highpass', f: 2600, a: 0.0005, d: 0.008, g: g * 5 });
    s.tone({ f: s.rr(130, 160), f1: 85, ft: 0.03, a: 0.002, d: 0.045, g: g * 1.2 });
    s.burst({ kind: 'pink', type: 'lowpass', f: 700, a: 0.002, d: 0.04, g: g * 2.5 });
    const sc = s.rr(0.05, 0.13);
    s.nz({ t: s.t + s.rr(0.015, 0.04), kind: 'crunch', f: [[0, s.rr(2600, 3600)], [sc, s.rr(1800, 2600)]], q: 1.4, amp: [[0, 0], [0.012, g * s.rr(2, 5)], [sc, 0]], rate: s.rr(1, 1.6) });
    return 0.3;
  }),
  ice: step(3, (s, x) => {
    const g = 0.14 + 0.09 * x.a;
    const f = s.rr(700, 880);
    // a glassy knock; the sheet sings faintly under it
    s.modes({ f: [f, f * 1.83, f * 3.02, f * 5.1], d: [0.05, 0.04, 0.025, 0.015], g: [1, 0.7, 0.5, 0.3], gain: g * 0.9 });
    s.burst({ type: 'highpass', f: 3200, a: 0.0005, d: 0.007, g: g * 4 });
    s.tone({ f: 120, f1: 80, ft: 0.03, a: 0.002, d: 0.05, g: g * 0.9 });
    const fs = s.rr(330, 560);
    s.sweep({ t: s.t + 0.004, f: [[0, fs * 1.5], [0.08, fs], [0.6, fs * 0.97]], amp: [[0, 0], [0.006, g * 0.22], [0.12, g * 0.1], [0.65, 0]] });
    s.sweep({ t: s.t + 0.004, f: [[0, fs * 4.2], [0.1, fs * 2.76]], amp: [[0, 0], [0.004, g * 0.1], [0.3, 0]] });
    if (s.rnd() < 0.35) s.nz({ t: s.t + 0.02, type: 'highpass', f: 4500, amp: [[0, 0], [0.01, g * 1.2], [s.rr(0.05, 0.12), 0]] });
    return 0.75;
  }),
  wood: step(3, (s, x) => {
    const g = 0.17 + 0.1 * x.a;
    const f = s.rr(95, 125);
    // boards over a hollow floor
    s.tone({ f: f * 1.3, f1: f * 0.75, ft: 0.05, a: 0.003, d: 0.1, g: g * 1.5 });
    s.modes({ f: [f * 1.9, f * 3.1, f * 4.6], d: 0.07, gain: g * 0.6 });
    s.burst({ kind: 'pink', type: 'lowpass', f: 800, a: 0.002, d: 0.05, g: g * 3 });
    s.burst({ f: 1900, q: 1, a: 0.001, d: 0.012, g: g * 2 });
    if (s.rnd() < 0.18) s.creak({ t: s.t + 0.03, d: s.rr(0.12, 0.25), r0: 30, r1: 18, f: [450, 980, 1700], q: 9, g: g * 1.6 });
    return 0.4;
  }, 0.5),
  metal: step(4, (s, x) => {
    const g = 0.15 + 0.1 * x.a;
    const f = s.rr(390, 450);
    // a deck plate: the boot's thud and the plate ringing on after it
    s.modes({ f: [f, f * 2.32, f * 3.86, f * 6.4, f * 9.3].map((v) => s.vary(v, 0.02)), d: [0.4, 0.3, 0.22, 0.12, 0.07], g: [1, 0.8, 0.6, 0.35, 0.2], gain: g * 0.42 });
    s.tone({ f: 150, f1: 90, ft: 0.03, a: 0.002, d: 0.05, g: g * 1.1 });
    s.burst({ type: 'highpass', f: 2200, a: 0.0005, d: 0.008, g: g * 4 });
    s.burst({ kind: 'pink', f: 500, q: 1.5, a: 0.002, d: 0.06, g: g * 2.5 });
    return 0.7;
  }, 0.2),
  water: step(3, (s, x) => {
    const g = 0.16 + 0.1 * x.a;
    s.nz({ kind: 'pink', f: [[0, 500], [0.12, 1300], [0.4, 600]], q: 1.2, amp: [[0, 0], [0.04, g * 6], [0.45, 0]] });
    s.nz({ f: [[0, 2200], [0.3, 3800]], q: 0.6, amp: [[0, 0], [0.06, g * 1.6], [0.35, 0]] });
    thump(s, s.t, g * 0.8, 90, 0.08);
    for (let i = 0; i < 4; i++) {
      const f = s.rr(350, 900);
      s.sweep({ t: s.t + s.rr(0.05, 0.4), f: [[0, f], [0.04, f * 1.6]], amp: [[0, 0], [0.005, g * 0.3], [0.04, 0]] });
    }
    return 0.6;
  }),
};

export const SFX: Readonly<Record<string, SoundDef>> = defs;
export const STEPS: Readonly<Record<Surface, SoundDef>> = steps;
/** Every public one-shot name (the bench page and the check tool list these). */
export const SFX_NAMES = Object.keys(defs).filter((k) => !k.startsWith('_')) as SfxName[];
export const INTERNAL_NAMES = Object.keys(defs).filter((k) => k.startsWith('_'));
export const STEP_NAMES = Object.keys(steps) as Surface[];
