// The bed everything else sits on: the wind, the place you are in, and your own body.
//
// The wind is layers of filtered noise that never stop: a low body, a mid rush, a high hiss,
// narrow whistles, a storm roar, the hush of pines, the moan through the cabin walls. Twenty
// times a second `apply` works out how hard the air is moving at the ear (the game's wind and
// gust, plus slow turbulence of our own) and glides every layer's level and colour to match:
// louder is always brighter, and no two layers swell together.
//
// tick(dt, at) is the only clock, so the same code runs live (from update) and offline (the
// check tool steps it across an OfflineAudioContext before rendering).
import type { Ambience } from './api';
import { type NoiseKind, type Rnd, clamp, lerp, mulberry, smooth, wander, xlerp } from './dsp';
import type { Engine, PlayOpts, Vec3 } from './engine';

/** `cave` is an optional extra the contract does not carry: 0..1 inside the cave (stone reverb, the wind left at the mouth). */
export interface AmbienceEx extends Ambience {
  cave: number;
}

export const AMBIENCE_DEFAULT: AmbienceEx = {
  wind: 0.25, gust: 0, storm: 0, snowfall: 0, shelter: 0, indoor: 0, forest: 0, height: 0, night: 0, onIce: 0, cold: 0, windDir: [1, 0], cave: 0,
};

interface Strand {
  f: BiquadFilterNode;
  g: GainNode;
  p: StereoPannerNode | null;
  /** pan offset from the wind's direction */
  off: number;
}

const TC = 0.09;
/**
 * The bed under everything, measured offline (tools/audio-check.mjs, the scene_* rows: RMS with the
 * body and the scene's events): a calm dusk about -30 dBFS, a whiteout on the ridge about -19,
 * the cabin about -31. Room is left above it for boots (-16 peak) and the shot (-1).
 */
const BED_LEVEL = 0.7;
const NUM: (keyof AmbienceEx)[] = ['wind', 'gust', 'storm', 'snowfall', 'shelter', 'indoor', 'forest', 'height', 'night', 'onIce', 'cold', 'cave'];

export class AmbienceSynth {
  readonly target: AmbienceEx = { ...AMBIENCE_DEFAULT, windDir: [1, 0] };
  readonly cur: AmbienceEx = { ...AMBIENCE_DEFAULT, windDir: [1, 0] };

  private eng: Engine;
  private fire: (name: string, o: PlayOpts) => void;
  private rnd: Rnd;
  private T: number;
  private acc = 1;
  private first = true;
  private srcs: { src: AudioBufferSourceNode; offset: number }[] = [];

  private outG: GainNode;
  private outLP: BiquadFilterNode;
  private body: Strand;
  private buffet: Strand;
  private buffetDepth: GainNode;
  private rush: Strand[] = [];
  private hiss: Strand[] = [];
  private edge: Strand;
  private whistles: Strand[] = [];
  private whistleHz: number[] = [];
  private roarLo: Strand;
  private roarMid: Strand;
  private forest: Strand[] = [];
  private grains: Strand;
  private moan: Strand[] = [];
  private draft: Strand;
  private room: Strand;

  private timers = { trunk: 0, branch: 0, timber: 0, tick: 0, boom: 0, ping: 0, breath: 1.2, chatter: 0, heart: 0, shiver: 0 };
  private envKey = -1;
  private bodyKey = -1;

  constructor(eng: Engine, fire: (name: string, o: PlayOpts) => void, startAt: number, seed: number) {
    this.eng = eng;
    this.fire = fire;
    this.rnd = mulberry(seed);
    // start somewhere in the turbulence, not at its origin
    this.T = 50 + this.rnd() * 500;
    const ctx = eng.ctx;
    const wide = !eng.lite;

    // the whole bed's level against everything else (set by measuring the scenes: see BED_LEVEL)
    const bed = ctx.createGain();
    bed.gain.value = BED_LEVEL;
    bed.connect(eng.bus.ambience);
    this.outLP = ctx.createBiquadFilter();
    this.outLP.type = 'lowpass';
    this.outLP.Q.value = 0.5;
    this.outLP.frequency.value = 20000;
    this.outG = ctx.createGain();
    this.outLP.connect(this.outG).connect(bed);
    const out = this.outLP;
    const inside = bed;

    this.body = this.strand('brown', 'lowpass', 160, 0.6, out, 0);
    this.buffet = this.strand('brown', 'lowpass', 190, 0.7, out, 0);
    // buffeting: the air beating on the hood, a flutter in the low end that comes with exposure
    this.buffetDepth = ctx.createGain();
    this.buffetDepth.gain.value = 0;
    this.slow(11).connect(this.buffetDepth).connect(this.buffet.g.gain);
    for (const off of wide ? [-0.55, 0.55] : [0]) {
      this.rush.push(this.strand('pink', 'bandpass', 500, 0.8, out, off));
      this.hiss.push(this.strand('white', 'highpass', 3200, 0.7, out, off * 0.8));
      this.forest.push(this.strand('pink', 'bandpass', 3000, 0.45, out, -off * 1.2));
    }
    // the hard edge on the ridge flaps like a torn tent
    this.edge = this.strand('white', 'bandpass', 6800, 1.4, out, 0.2, 13);
    for (const [f, off] of (wide ? [[540, -0.4], [870, 0.5], [1420, -0.1]] : [[610, -0.3], [1180, 0.3]]) as [number, number][]) {
      this.whistles.push(this.strand('pink', 'bandpass', f, 38, out, off));
      this.whistleHz.push(f);
    }
    this.roarLo = this.strand('brown', 'lowpass', 110, 0.7, out, 0);
    this.roarMid = this.strand('pink', 'bandpass', 210, 0.7, out, 0);
    this.grains = this.strand('dust', 'highpass', 3600, 0.7, out, 0);
    this.moan.push(this.strand('pink', 'bandpass', 120, 9, inside, -0.25), this.strand('pink', 'bandpass', 265, 12, inside, 0.3));
    this.draft = this.strand('brown', 'lowpass', 75, 0.7, inside, 0);
    this.room = this.strand('pink', 'lowpass', 320, 0.5, inside, 0);
    for (const s of this.srcs) s.src.start(startAt, s.offset);
  }

  /** noise -> filter -> gain -> (flutter) -> pan -> to. flutterHz adds a random amplitude flap. */
  private strand(kind: NoiseKind, type: BiquadFilterType, f: number, q: number, to: AudioNode, off: number, flutterHz = 0): Strand {
    const ctx = this.eng.ctx;
    const src = ctx.createBufferSource();
    const b = this.eng.kit.B[kind];
    src.buffer = b;
    src.loop = true;
    // each strand reads the shared buffer from its own place at its own speed: no two are correlated
    src.playbackRate.value = 0.9 + this.rnd() * 0.25;
    this.srcs.push({ src, offset: this.rnd() * b.duration * 0.9 });
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(flt).connect(g);
    let tail: AudioNode = g;
    if (flutterHz > 0) {
      const fl = ctx.createGain();
      fl.gain.value = 0.5;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      this.slow(flutterHz).connect(depth).connect(fl.gain);
      g.connect(fl);
      tail = fl;
    }
    let p: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === 'function') {
      p = ctx.createStereoPanner();
      p.pan.value = off;
      tail.connect(p).connect(to);
    } else tail.connect(to);
    return { f: flt, g, p, off };
  }

  /** A slow random control signal in about -1..1, `hz` changes a second. */
  private slow(hz: number): AudioNode {
    const ctx = this.eng.ctx;
    const src = ctx.createBufferSource();
    const b = this.eng.kit.B.white;
    src.buffer = b;
    src.loop = true;
    src.playbackRate.value = hz / ctx.sampleRate;
    this.srcs.push({ src, offset: this.rnd() * b.duration * 0.9 });
    const g = ctx.createGain();
    g.gain.value = 2;
    src.connect(g);
    return g;
  }

  set(a: Partial<AmbienceEx>): void {
    const t = this.target;
    for (const k of NUM) {
      const v = a[k] as number | undefined;
      if (typeof v === 'number' && isFinite(v)) (t[k] as number) = k === 'height' ? v : clamp(v);
    }
    if (a.windDir && isFinite(a.windDir[0] + a.windDir[1])) {
      const l = Math.hypot(a.windDir[0], a.windDir[1]);
      if (l > 1e-4) t.windDir = [a.windDir[0] / l, a.windDir[1] / l];
    }
  }

  /** Advance by dt seconds; `at` is the context time the changes apply at. */
  tick(dt: number, at: number): void {
    const c = this.cur;
    const t = this.target;
    const k = this.first ? 1 : 1 - Math.exp(-dt * 2.2);
    const kg = this.first ? 1 : 1 - Math.exp(-dt * 7);
    for (const key of NUM) (c[key] as number) += ((t[key] as number) - (c[key] as number)) * (key === 'gust' ? kg : k);
    const dx = lerp(c.windDir[0], t.windDir[0], k);
    const dz = lerp(c.windDir[1], t.windDir[1], k);
    const dl = Math.hypot(dx, dz) || 1;
    c.windDir[0] = dx / dl;
    c.windDir[1] = dz / dl;
    this.T += dt;
    this.acc += dt;
    if (this.acc >= 0.05) {
      this.acc = 0;
      this.apply(at);
    }
    this.events(dt, at);
    this.first = false;
  }

  private apply(at: number): void {
    const c = this.cur;
    const T = this.T;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, at, TC);

    // how hard the air moves at the ear: the game's wind and gust, and three scales of our own turbulence
    const turb = 0.55 * wander(T * 0.09, 1) + 0.3 * wander(T * 0.31, 2) + 0.15 * wander(T * 1.3, 3);
    const I = clamp(c.wind * (0.78 + 0.34 * turb) + c.gust * (0.3 + 0.25 * c.wind) + c.storm * 0.12, 0.03, 1);
    const Ik = (i: number) => clamp(I * (1 + 0.28 * wander(T * 0.5, 10 + i)), 0.02, 1);
    const hk = smooth(80, 420, c.height);
    const nk = c.night;
    const st = c.storm;
    const open = (1 - c.shelter) * (1 - c.indoor) * (1 - c.cave);

    // where it comes from, against where the listener faces
    const h = this.eng.heading();
    const fromX = -c.windDir[0];
    const fromZ = -c.windDir[1];
    const side = (fromX * -h.fz + fromZ * h.fx) * 0.6;
    const front = fromX * h.fx + fromZ * h.fz;
    const pan = (s: Strand) => {
      if (s.p) s.p.pan.setTargetAtTime(clamp(side + s.off, -1, 1), at, 0.2);
    };

    // body: the weight of moving air. Thinner up high.
    set(this.body.f.frequency, 80 + 300 * I);
    set(this.body.g.gain, (1.1 * Math.pow(I, 1.3) + 0.3 * st) * (1 - 0.45 * hk));
    set(this.buffet.g.gain, 0.9 * I * I * open);
    set(this.buffetDepth.gain, 0.55 * I * I * open);

    // rush: the voice of it. Each side gusts on its own.
    for (let i = 0; i < this.rush.length; i++) {
      const w = Ik(i);
      const s = this.rush[i];
      set(s.f.frequency, (260 + 1000 * Math.pow(w, 1.4)) * (1 + 0.5 * hk));
      set(s.g.gain, 1.5 * Math.pow(w, 1.7));
      pan(s);
    }
    // hiss: spindrift over crust, air through cloth. From behind the hood dulls it.
    for (let i = 0; i < this.hiss.length; i++) {
      const w = Ik(4 + i);
      const s = this.hiss[i];
      set(s.f.frequency, 2600 + 2600 * w);
      set(s.g.gain, 0.42 * Math.pow(w, 2.2) * (1 + 1.3 * hk) * (0.82 + 0.18 * front));
      pan(s);
    }
    set(this.edge.g.gain, 0.9 * hk * I * I);
    set(this.edge.f.frequency, 5600 + 2600 * I);
    pan(this.edge);

    // whistles: only in strong wind (sooner on the ridge), each drifting in pitch, coming and going
    for (let i = 0; i < this.whistles.length; i++) {
      const s = this.whistles[i];
      const present = smooth(0.2, 0.75, 0.5 + 0.5 * wander(T * 0.13, 20 + i)) * smooth(0.5, 0.85, Ik(8 + i) + 0.18 * hk);
      set(s.f.frequency, this.whistleHz[i] * (0.82 + 0.42 * I) * (1 + 0.06 * wander(T * 0.6, 30 + i)));
      set(s.g.gain, 16 * present * (0.5 + 0.5 * open));
      pan(s);
    }

    // the storm itself, out on the mountain: a roar that does not gust with the near wind
    const roar = Math.pow(st, 1.4) * (0.72 + 0.28 * wander(T * 0.07, 40)) * (1 - 0.3 * nk);
    set(this.roarLo.g.gain, 1.5 * roar);
    set(this.roarMid.g.gain, 1.1 * roar);
    set(this.roarMid.f.frequency, 170 + 80 * wander(T * 0.05, 41));

    // pines: a hush that arrives in long waves through the canopy
    for (let i = 0; i < this.forest.length; i++) {
      const w = clamp(I * (0.75 + 0.5 * wander(T * 0.17, 50 + i)) + 0.05);
      const s = this.forest[i];
      set(s.f.frequency, 2000 + 2600 * w);
      set(s.g.gain, 1.5 * c.forest * Math.pow(w, 1.2));
      pan(s);
    }

    // snow grains on the hood
    set(this.grains.g.gain, 1.6 * c.snowfall * (0.25 + 0.75 * I) * (1 - c.indoor) * (1 - c.cave));

    // outdoors as heard from where you stand: the lee dulls it, walls leave only the low end
    const fc = xlerp(xlerp(xlerp(20000, 2600, c.shelter), 300, c.indoor), 420, c.cave);
    set(this.outLP.frequency, fc);
    set(this.outG.gain, (1 - 0.55 * c.shelter) * (1 - 0.72 * c.indoor) * (1 - 0.7 * c.cave) * (1 - 0.24 * nk));

    // indoors: the wind is a moan in the walls and a pull in the flue; the room has a tone of its own
    const inn = c.indoor * (1 - c.cave);
    set(this.moan[0].f.frequency, 104 + 58 * I + 9 * wander(T * 0.4, 60));
    set(this.moan[1].f.frequency, 240 + 95 * Ik(12) + 14 * wander(T * 0.33, 61));
    set(this.moan[0].g.gain, 5 * inn * (0.15 + I) * (0.6 + 0.4 * wander(T * 0.21, 62)));
    set(this.moan[1].g.gain, 3.2 * inn * Math.pow(I, 1.5) * (0.5 + 0.5 * wander(T * 0.27, 63)));
    // brown noise under 75 Hz is nearly all of its energy: a little is a pull you feel, more is a rumble
    set(this.draft.g.gain, 0.28 * inn * I);
    set(this.room.g.gain, 0.12 * (inn + c.cave));

    // what the engine needs to know: the space, and how much the wind hides
    const mask = clamp(I * 0.55 + st * 0.5) * (1 - 0.8 * c.indoor) * (1 - 0.5 * c.cave);
    const ek = Math.round(c.indoor * 40) * 10000 + Math.round(c.cave * 40) * 100 + Math.round(mask * 40);
    if (ek !== this.envKey) {
      this.envKey = ek;
      this.eng.setEnv(c.indoor, c.cave, mask, at);
    }
    const bk = Math.round(smooth(0.45, 1, c.cold) * 50);
    if (bk !== this.bodyKey) {
      this.bodyKey = bk;
      this.eng.setBody(bk / 50, at);
    }
  }

  private due(name: keyof AmbienceSynth['timers'], dt: number, rate: number, lo: number, hi: number): boolean {
    const t = this.timers;
    if (t[name] <= 0) t[name] = (lo + this.rnd() * (hi - lo)) * (0.3 + 0.7 * this.rnd());
    if (rate <= 0) return false;
    t[name] -= dt * rate;
    if (t[name] > 0) return false;
    t[name] = lo + this.rnd() * (hi - lo);
    return true;
  }

  private around(min: number, max: number, up = 0): Vec3 {
    const a = this.rnd() * Math.PI * 2;
    const r = min + this.rnd() * (max - min);
    const p = this.eng.listenerPos();
    return [p[0] + Math.cos(a) * r, p[1] + up, p[2] + Math.sin(a) * r];
  }

  /** The things that happen now and then, and the body. */
  private events(dt: number, at: number): void {
    const c = this.cur;
    const r = this.rnd;
    const I = clamp(c.wind + c.gust * 0.4);
    const outside = (1 - c.indoor) * (1 - c.cave);

    if (c.forest > 0.25 && outside > 0.5) {
      if (this.due('trunk', dt, c.forest * (0.25 + I), 9, 26)) this.fire('_trunk', { at, pos: this.around(8, 28, 2), gain: 0.45 + 0.5 * I });
      if (this.due('branch', dt, c.forest * (0.4 + 0.6 * c.snowfall + 0.5 * I), 22, 60)) this.fire('branch_snow', { at, pos: this.around(6, 24, 3), gain: 0.8 });
    }
    if (c.indoor > 0.5) {
      if (this.due('timber', dt, 0.3 + 1.2 * I + c.storm, 7, 22)) this.fire('_timber', { at, pos: this.around(2, 5, 1.5), gain: 0.4 + 0.5 * I });
      if (this.due('tick', dt, 0.6 + I, 11, 30)) this.fire('_tick', { at, pos: this.around(2, 4, 2), gain: 0.7 });
    }
    if (c.onIce > 0.25 && outside > 0.5) {
      // the sheet works hardest as the night cold tightens it
      if (this.due('boom', dt, c.onIce * (1 + 0.6 * c.night), 26, 70)) this.fire('ice_boom', { at, pos: this.around(160, 480), gain: 0.5 + 0.5 * r() });
      if (this.due('ping', dt, c.onIce * (1 + 0.6 * c.night), 13, 38)) this.fire('_ice_ping', { at, pos: this.around(110, 380), gain: 0.5 + 0.5 * r() });
    }

    // the body. Breath is always there, small; cold makes it fast and ragged.
    const cold = c.cold;
    const tm = this.timers;
    tm.breath -= dt;
    if (tm.breath <= 0) {
      const rag = smooth(0.4, 0.9, cold);
      tm.breath = lerp(4.3, 1.3, Math.pow(cold, 1.1)) * (1 + (r() * 2 - 1) * (0.06 + 0.22 * rag));
      this.fire('_breath', { at, a: cold, b: lerp(0.014, 0.075, smooth(0.1, 0.9, cold)) });
    }
    if (cold > 0.6 && this.due('chatter', dt, smooth(0.6, 1, cold) * 2 + 0.5, 3, 8)) this.fire('_chatter', { at, a: smooth(0.6, 1, cold) });
    if (cold > 0.4 && this.due('shiver', dt, smooth(0.4, 0.8, cold) + 0.3, 8, 18)) this.fire('shiver', { at, gain: 0.55 + 0.45 * cold });
    if (cold > 0.55) {
      tm.heart -= dt;
      if (tm.heart <= 0) {
        const hb = smooth(0.55, 1, cold);
        tm.heart = 60 / lerp(74, 128, hb);
        this.fire('heartbeat', { at, gain: 0.25 + 0.75 * hb });
      }
    }
  }

  dispose(at: number): void {
    for (const s of this.srcs) {
      try {
        s.src.stop(at);
      } catch {
        /* never started */
      }
    }
  }
}
