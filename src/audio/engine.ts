// The mixer: buses, the three reverbs, the master compressor and limiter, and the voice pool.
// It runs unchanged on a live AudioContext and on an OfflineAudioContext (tools/audio-check.mjs).
//
//   voice -> strip (level * distance, air low-pass, panner) -> bus.sfx | bus.ambience | bus.ui
//                    '-> local send (the space you are in)   '-> far send (the mountain)
//   bus.ambience + bus.sfx + reverb returns -> body filter (cold) -> width -> duck -> sum
//   bus.music -> duck (less) -> sum          bus.ui -> sum
//   sum -> compressor -> make-up -> soft limiter -> master volume -> out
import { type Ctx, type Kit, type Space, Scope, clamp, dB, lerp, limiterCurve, makeBuffers, makeIR, makeWaves, mulberry, smooth, xlerp } from './dsp';
import { MIX } from './mix';

/** body: the listener's own breath, heart and teeth. It bypasses the cold filter: as the world dulls, the body is what is left. */
export type BusName = 'sfx' | 'ui' | 'ambience' | 'body';
export type Vec3 = [number, number, number];

/** What a builder is told about the moment it is played. */
export interface PlayCtx {
  /** metres from the listener; 0 when the sound is not spatial */
  dist: number;
  spatial: boolean;
  /** two free numbers (footsteps: speed, depth; loops: the starting param) */
  a: number;
  b: number;
}

interface DefBase {
  bus?: BusName;
  /** distance at which the sound is at its written level (m) */
  ref?: number;
  /** how fast it falls beyond that (1 = inverse distance) */
  roll?: number;
  /** 0 = first to be dropped ... 3 = never stolen by lesser sounds */
  pri?: number;
  /** default reverb sends; the builder may change s.local / s.far */
  local?: number;
  far?: number;
  /** 0 = air and wind do not dull or mask it (the listener's own body) */
  air?: number;
}
export interface SoundDef extends DefBase {
  /** Build the voice into s.out starting at s.t. Returns its length in seconds. */
  build(s: Scope, x: PlayCtx): number;
}
export interface LoopCtl {
  /** param in 0..1 changed (or set for the first time) */
  param?(v: number, at: number): void;
}
export interface LoopDef extends DefBase {
  build(s: Scope, x: PlayCtx): LoopCtl;
}

export interface PlayOpts {
  pos?: Vec3;
  gain?: number;
  pitch?: number;
  delay?: number;
  /** context time to start at (offline rendering and scheduled ambience events) */
  at?: number;
  a?: number;
  b?: number;
}

export interface EngineOpts {
  /** phones: equal-power panning, short impulse responses, fewer voices */
  lite: boolean;
  seed: number;
  /** where the master goes (default ctx.destination) */
  dest?: AudioNode;
  /** offline rendering: impulse responses are built at once, no analyser, no same-frame de-duplication */
  offline?: boolean;
  /** hard cap on sounding voices (default 30, phones 14) */
  maxVoices?: number;
  /** linear gain that cancels the compressor's built-in make-up (see measureCompGain) */
  compGain?: number;
}

interface Strip {
  in: GainNode;
  lp: BiquadFilterNode;
  pan: PannerNode | null;
  tail: AudioNode;
  sl: GainNode;
  sf: GainNode;
  kind: 0 | 1 | 2; // flat, equal-power, HRTF
}

interface Voice {
  name: string;
  def: DefBase;
  strip: Strip;
  scope: Scope;
  bus: AudioNode;
  end: number;
  born: number;
  pri: number;
  /** caller's gain times the mix trim */
  level: number;
  /** the mix table's level for this sound (linear) */
  trim: number;
  pos: Vec3 | null;
  loop: boolean;
  /** taken by the voice cap before it was done */
  stolen: boolean;
}

/** What Engine.loop hands back. */
export interface EngineLoop {
  set(p: { pos?: Vec3; gain?: number; pitch?: number; param?: number }): void;
  stop(fade?: number): void;
  /** false once the voice cap has taken the loop: start it again when there is room */
  alive(): boolean;
  readonly spatial: boolean;
}

// Glue and safety, not loudness: below about -15 dBFS the master is untouched, so the bed and the
// small close sounds keep their dynamics; a shot or a stack of voices is held down and the soft
// limiter after it catches what the 3 ms attack lets through.
const COMP = { threshold: -12, knee: 6, ratio: 4, attack: 0.003, release: 0.25 };

function setupComp(c: DynamicsCompressorNode): void {
  c.threshold.value = COMP.threshold;
  c.knee.value = COMP.knee;
  c.ratio.value = COMP.ratio;
  c.attack.value = COMP.attack;
  c.release.value = COMP.release;
}

/**
 * Browsers add an undocumented make-up gain to DynamicsCompressorNode that depends on its
 * settings. Measure it once with a quiet tone so the master stays at unity below the threshold.
 */
export async function measureCompGain(sampleRate: number): Promise<number> {
  try {
    // the node settles over the first ~0.3 s of a context: measure the last third of 0.75 s
    const n = Math.floor(sampleRate * 0.75);
    const oc = new OfflineAudioContext(1, n, sampleRate);
    const o = oc.createOscillator();
    o.frequency.value = 440;
    const g = oc.createGain();
    g.gain.value = 0.02;
    const c = oc.createDynamicsCompressor();
    setupComp(c);
    o.connect(g).connect(c).connect(oc.destination);
    o.start();
    const d = (await oc.startRendering()).getChannelData(0);
    let s = 0;
    const from = Math.floor(n * 0.66);
    for (let i = from; i < n; i++) s += d[i] * d[i];
    const rms = Math.sqrt(s / (n - from));
    const k = rms / (0.02 * Math.SQRT1_2);
    return k > 0.5 && k < 8 ? k : 1.6;
  } catch {
    return 1.6;
  }
}

export class Engine {
  readonly ctx: Ctx;
  readonly kit: Kit;
  readonly lite: boolean;
  readonly offline: boolean;
  readonly bus: Record<BusName | 'music', GainNode>;
  /** everything before the compressor, at unity: the level the synths were written at */
  readonly raw: GainNode;
  readonly maxVoices: number;

  private localIn: GainNode;
  private farIn: GainNode;
  private spaces = {} as Record<Space, { conv: ConvolverNode; local: GainNode; far: GainNode }>;
  private spacesBuilt = false;
  private sfxVol: GainNode;
  private musicVol: GainNode;
  private bodyLP: BiquadFilterNode;
  private widthA: GainNode[] = [];
  private widthB: GainNode[] = [];
  private duckLP: BiquadFilterNode;
  private duckG: GainNode;
  private musicDuck: GainNode;
  private makeup: GainNode;
  private masterVol: GainNode;
  private analyser: AnalyserNode | null = null;
  private meterBuf: Float32Array<ArrayBuffer> | null = null;

  private voices: Voice[] = [];
  private pool: Strip[][] = [[], [], []];
  private hrtfLive = 0;
  private readonly maxHrtf: number;
  private last = new Map<string, number>();

  private L = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1 };
  /** 0..1 how much the wind hides distant sounds */
  private mask = 0;
  private indoor = 0;
  private cave = 0;

  constructor(ctx: Ctx, o: EngineOpts) {
    this.ctx = ctx;
    this.lite = o.lite;
    this.offline = !!o.offline;
    this.maxVoices = o.maxVoices ?? (o.lite ? 14 : 30);
    this.maxHrtf = this.offline || o.lite ? 0 : 8;
    const rnd = mulberry(o.seed);
    this.kit = { ctx, rnd, B: makeBuffers(ctx, rnd, o.lite ? 4 : 7), W: makeWaves(ctx), lite: o.lite };

    const G = (v = 1) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this.bus = { sfx: G(), ui: G(), ambience: G(), body: G(), music: G() };

    // the world: ambience + sfx + reverb, dulled and narrowed by cold, ducked by menus
    const world = G();
    world.channelCount = 2;
    world.channelCountMode = 'explicit';
    this.bus.sfx.connect(world);
    this.bus.ambience.connect(world);
    this.bodyLP = ctx.createBiquadFilter();
    this.bodyLP.type = 'lowpass';
    this.bodyLP.frequency.value = 19000;
    this.bodyLP.Q.value = 0.5;
    world.connect(this.bodyLP);
    // width: L' = a L + b R, R' = a R + b L
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.bodyLP.connect(split);
    for (let ch = 0; ch < 2; ch++) {
      const a = G(1);
      const b = G(0);
      split.connect(a, ch);
      split.connect(b, ch);
      a.connect(merge, 0, ch);
      b.connect(merge, 0, 1 - ch);
      this.widthA.push(a);
      this.widthB.push(b);
    }
    this.duckLP = ctx.createBiquadFilter();
    this.duckLP.type = 'lowpass';
    this.duckLP.frequency.value = 20000;
    this.duckG = G();
    this.sfxVol = G();
    merge.connect(this.duckLP).connect(this.duckG).connect(this.sfxVol);
    this.bus.body.connect(this.duckLP);

    this.musicDuck = G();
    this.musicVol = G();
    this.bus.music.connect(this.musicDuck).connect(this.musicVol);
    const uiVol = G();
    this.bus.ui.connect(uiVol);
    // the interface follows the sfx slider
    this.sfxVolUi = uiVol;

    this.raw = G();
    this.sfxVol.connect(this.raw);
    this.musicVol.connect(this.raw);
    uiVol.connect(this.raw);

    // nothing under 25 Hz reaches the dynamics: thumps and shaped pulses carry subsonic energy and
    // offsets that no speaker plays and that would only pump the compressor
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = 25;
    hpf.Q.value = 0.707;
    const comp = ctx.createDynamicsCompressor();
    setupComp(comp);
    this.makeup = G(1 / (o.compGain ?? 1.6));
    // the limiter curve is written for a half-scale input: it sees up to +6 dBFS and never passes 0.97
    const half = G(0.5);
    const lim = ctx.createWaveShaper();
    lim.curve = limiterCurve();
    this.masterVol = G();
    this.raw.connect(hpf).connect(comp).connect(this.makeup).connect(half).connect(lim).connect(this.masterVol);
    this.masterVol.connect(o.dest ?? ctx.destination);
    if (!this.offline) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 8192;
      this.masterVol.connect(this.analyser);
      this.meterBuf = new Float32Array(this.analyser.fftSize);
    }

    // reverbs: sends are mono taps of each voice, returns land on the sfx bus. The impulse
    // responses carry unit energy, so a send of 1 into a return of 1 gives back as much power as
    // went in: the returns here set the wet level of a send of 1.
    this.localIn = G();
    this.farIn = G();
    this.wet = G();
    this.wet.connect(this.bus.sfx);
    const ret: Record<Space, number> = { room: 0.45, cave: 0.6, mountain: 0.5 };
    for (const k of ['room', 'cave', 'mountain'] as Space[]) {
      const conv = ctx.createConvolver();
      conv.normalize = false;
      const local = G(0);
      const far = G(0);
      this.localIn.connect(local).connect(conv);
      this.farIn.connect(far).connect(conv);
      conv.connect(G(ret[k])).connect(this.wet);
      this.spaces[k] = { conv, local, far };
    }
    this.setEnv(0, 0, 0, 0);
    if (this.offline) this.buildSpaces();
  }

  private sfxVolUi: GainNode;
  /** every reverb return passes through here */
  private wet: GainNode;

  /** Scale all reverb returns (1 normal, 0 dry: the check tool measures voices without their space). */
  setWet(k: number): void {
    this.wet.gain.value = Math.max(0, k);
  }

  /** Impulse responses take a moment to compute: live, do them one per task after the unlock gesture. */
  buildSpaces(): void {
    if (this.spacesBuilt) return;
    this.spacesBuilt = true;
    const order: Space[] = ['mountain', 'room', 'cave'];
    const one = (k: Space) => {
      this.spaces[k].conv.buffer = makeIR(this.ctx, k, this.lite, mulberry(k.length * 7919 + 13));
    };
    if (this.offline) {
      order.forEach(one);
      return;
    }
    let i = 0;
    const step = () => {
      one(order[i++]);
      if (i < order.length) setTimeout(step, 30);
    };
    setTimeout(step, 0);
  }

  setCompGain(k: number): void {
    this.makeup.gain.setTargetAtTime(1 / k, this.ctx.currentTime, 0.05);
  }

  setVolumes(master: number, music: number, sfx: number): void {
    const t = this.ctx.currentTime;
    // sliders feel linear when the gain is a power curve
    const c = (v: number) => Math.pow(clamp(v), 1.6);
    this.masterVol.gain.setTargetAtTime(c(master), t, 0.03);
    this.musicVol.gain.setTargetAtTime(c(music), t, 0.03);
    this.sfxVol.gain.setTargetAtTime(c(sfx), t, 0.03);
    this.sfxVolUi.gain.setTargetAtTime(c(sfx), t, 0.03);
  }

  setDuck(amount: number): void {
    const a = clamp(amount);
    const t = this.ctx.currentTime;
    this.duckG.gain.setTargetAtTime(1 - 0.8 * a, t, 0.12);
    this.duckLP.frequency.setTargetAtTime(xlerp(20000, 700, a), t, 0.12);
    this.musicDuck.gain.setTargetAtTime(1 - 0.45 * a, t, 0.12);
  }

  /** Cold narrows and dulls the world. k in 0..1. */
  setBody(k: number, at = this.ctx.currentTime): void {
    const w = 1 - 0.65 * k;
    this.bodyLP.frequency.setTargetAtTime(xlerp(19000, 2400, k), at, 0.3);
    for (const g of this.widthA) g.gain.setTargetAtTime((1 + w) / 2, at, 0.3);
    for (const g of this.widthB) g.gain.setTargetAtTime((1 - w) / 2, at, 0.3);
  }

  /** Which space answers: indoor (cabin room), cave, and how much the wind masks distance. */
  setEnv(indoor: number, cave: number, mask: number, at = this.ctx.currentTime): void {
    this.indoor = indoor;
    this.cave = cave;
    this.mask = clamp(mask);
    const S = this.spaces;
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, at, 0.25);
    const out = (1 - indoor) * (1 - cave);
    set(S.room.local, indoor * (1 - cave));
    set(S.room.far, 0);
    set(S.cave.local, cave);
    set(S.cave.far, cave * 0.7);
    set(S.mountain.local, 0.1 * out);
    set(S.mountain.far, (1 - 0.85 * indoor) * (1 - 0.6 * cave) * (1 - 0.45 * this.mask));
  }

  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number): void {
    const L = this.L;
    const len = Math.hypot(fx, fy, fz);
    if (!(len > 1e-6) || !isFinite(px + py + pz)) return;
    L.x = px;
    L.y = py;
    L.z = pz;
    L.fx = fx / len;
    L.fy = fy / len;
    L.fz = fz / len;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    // up must not be parallel to forward
    const steep = Math.abs(L.fy) > 0.98;
    const ux = steep ? -L.fx : 0;
    const uy = steep ? 0 : 1;
    const uz = steep ? -L.fz - (L.fx === 0 && L.fz === 0 ? 1 : 0) : 0;
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, t, 0.02);
      l.positionY.setTargetAtTime(py, t, 0.02);
      l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(L.fx, t, 0.02);
      l.forwardY.setTargetAtTime(L.fy, t, 0.02);
      l.forwardZ.setTargetAtTime(L.fz, t, 0.02);
      l.upX.setTargetAtTime(ux, t, 0.02);
      l.upY.setTargetAtTime(uy, t, 0.02);
      l.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      // older Firefox
      (l as any).setPosition(px, py, pz);
      (l as any).setOrientation(L.fx, L.fy, L.fz, ux, uy, uz);
    }
  }

  /** Listener's forward and right on the ground plane (for panning the wind). */
  heading(): { fx: number; fz: number } {
    const h = Math.hypot(this.L.fx, this.L.fz) || 1;
    return { fx: this.L.fx / h, fz: this.L.fz / h };
  }
  listenerPos(): Vec3 {
    return [this.L.x, this.L.y, this.L.z];
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  meter(): { peak: number; rms: number; voices: number } {
    let peak = 0;
    let rms = 0;
    if (this.analyser && this.meterBuf) {
      this.analyser.getFloatTimeDomainData(this.meterBuf);
      const d = this.meterBuf;
      let s = 0;
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
        s += d[i] * d[i];
      }
      rms = Math.sqrt(s / d.length);
    }
    return { peak, rms, voices: this.voices.length };
  }

  // ---------------------------------------------------------------------------------------
  // voices

  private strip(spatial: boolean): Strip {
    const kind: 0 | 1 | 2 = !spatial ? 0 : this.hrtfLive < this.maxHrtf ? 2 : 1;
    if (kind === 2) this.hrtfLive++;
    const cached = this.pool[kind].pop();
    if (cached) return cached;
    const ctx = this.ctx;
    const inp = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    lp.frequency.value = 20000;
    inp.connect(lp);
    let pan: PannerNode | null = null;
    let tail: AudioNode = lp;
    if (spatial) {
      pan = ctx.createPanner();
      pan.panningModel = kind === 2 ? 'HRTF' : 'equalpower';
      // distance is ours (level, air, wind masking): the panner only places the sound
      pan.distanceModel = 'linear';
      pan.rolloffFactor = 0;
      lp.connect(pan);
      tail = pan;
    }
    const sl = ctx.createGain();
    const sf = ctx.createGain();
    lp.connect(sl).connect(this.localIn);
    lp.connect(sf).connect(this.farIn);
    return { in: inp, lp, pan, tail, sl, sf, kind };
  }

  private release(v: Voice): void {
    try {
      v.scope.out.disconnect();
      v.strip.tail.disconnect(v.bus);
    } catch {
      /* already gone */
    }
    if (v.strip.kind === 2) this.hrtfLive--;
    this.pool[v.strip.kind].push(v.strip);
  }

  /** Place a voice: level by distance, air absorption, wind masking, reverb sends, panner. */
  private place(v: Voice, at: number, glide: number): void {
    const s = v.strip;
    let g = v.level;
    let fc = 20000;
    let farK = 1;
    if (v.pos) {
      const d = Math.hypot(v.pos[0] - this.L.x, v.pos[1] - this.L.y, v.pos[2] - this.L.z);
      const ref = v.def.ref ?? 3;
      const air = v.def.air ?? 1;
      const att = ref / (ref + (v.def.roll ?? 1) * Math.max(0, d - ref));
      const hide = 1 - this.mask * air * 0.85 * smooth(ref * 2, ref * 14, d);
      g *= att * hide;
      // air eats the top: about an octave every hundred metres, faster in blowing snow
      fc = clamp(21000 * Math.exp((-d * air) / lerp(170, 75, this.mask)), 450, 20000);
      // the echo falls off more slowly than the direct sound: that is what "far" sounds like
      farK = Math.min(3.5, 1 / Math.sqrt(Math.max(att, 0.02)));
      if (s.pan) {
        const p = s.pan;
        if (p.positionX) {
          if (glide > 0) {
            p.positionX.setTargetAtTime(v.pos[0], at, glide);
            p.positionY.setTargetAtTime(v.pos[1], at, glide);
            p.positionZ.setTargetAtTime(v.pos[2], at, glide);
          } else {
            p.positionX.cancelScheduledValues(0);
            p.positionY.cancelScheduledValues(0);
            p.positionZ.cancelScheduledValues(0);
            p.positionX.setValueAtTime(v.pos[0], at);
            p.positionY.setValueAtTime(v.pos[1], at);
            p.positionZ.setValueAtTime(v.pos[2], at);
          }
        } else (p as any).setPosition(v.pos[0], v.pos[1], v.pos[2]);
      }
    }
    const set = (p: AudioParam, val: number) => {
      if (glide > 0) p.setTargetAtTime(val, at, glide);
      else {
        p.cancelScheduledValues(0);
        p.setValueAtTime(val, at);
      }
    };
    set(s.in.gain, g);
    set(s.lp.frequency, fc);
    set(s.sl.gain, v.scope.local);
    set(s.sf.gain, v.scope.far * farK);
  }

  private steal(pri: number, now: number): boolean {
    let worst = -1;
    let score = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      // loops count as one priority step higher; among equals the oldest goes
      const sc = (v.pri + (v.loop ? 1 : 0)) * 1000 + v.born - now;
      if (sc < score) {
        score = sc;
        worst = i;
      }
    }
    if (worst < 0) return false;
    const v = this.voices[worst];
    if (v.pri + (v.loop ? 1 : 0) > pri) return false;
    v.strip.in.gain.cancelScheduledValues(0);
    v.strip.in.gain.setTargetAtTime(0, now, 0.008);
    v.scope.stopAll(now + 0.05);
    v.end = now + 0.06;
    v.pri = 99; // on its way out: do not pick it again
    v.stolen = true;
    v.loop = false;
    return true;
  }

  private start(name: string, def: DefBase, o: PlayOpts, loop: boolean, build: (s: Scope, x: PlayCtx) => number): Voice | null {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t = Math.max(now, o.at ?? now) + Math.max(0, o.delay ?? 0);
    // the same sound twice in one frame is one sound
    if (!this.offline && !loop && !o.delay) {
      const prev = this.last.get(name);
      if (prev !== undefined && t - prev < 0.012) return null;
      this.last.set(name, t);
    }
    let live = 0;
    for (const v of this.voices) if (v.pri < 99) live++;
    if (live >= this.maxVoices && !this.steal(def.pri ?? 1, now)) return null;
    const spatial = !!o.pos && isFinite(o.pos[0] + o.pos[1] + o.pos[2]);
    const strip = this.strip(spatial);
    const out = ctx.createGain();
    out.connect(strip.in);
    const scope = new Scope(this.kit, t, out, clamp(o.pitch ?? 1, 0.25, 4));
    scope.local = def.local ?? 0;
    scope.far = def.far ?? 0;
    const pos = spatial ? ([o.pos![0], o.pos![1], o.pos![2]] as Vec3) : null;
    const dist = pos ? Math.hypot(pos[0] - this.L.x, pos[1] - this.L.y, pos[2] - this.L.z) : 0;
    const bus = this.bus[def.bus ?? 'sfx'];
    const trim = dB(MIX[name] ?? 0);
    const v: Voice = { name, def, strip, scope, bus, end: Infinity, born: now, pri: def.pri ?? 1, level: Math.max(0, o.gain ?? 1) * trim, trim, pos, loop, stolen: false };
    let dur: number;
    try {
      dur = build(scope, { dist, spatial, a: o.a ?? 0, b: o.b ?? 0 });
    } catch (e) {
      scope.stopAll(0);
      out.disconnect();
      if (strip.kind === 2) this.hrtfLive--;
      this.pool[strip.kind].push(strip);
      throw e;
    }
    v.end = loop ? Infinity : t + dur + 0.08;
    this.place(v, Math.max(now, t - 0.002), 0);
    strip.tail.connect(bus);
    this.voices.push(v);
    return v;
  }

  /** Returns the length the builder asked for (seconds), or null when the voice cap or de-duplication dropped it. */
  play(name: string, def: SoundDef, o: PlayOpts = {}): number | null {
    let dur: number | null = null;
    this.start(name, def, o, false, (s, x) => (dur = def.build(s, x)));
    return dur;
  }

  loop(name: string, def: LoopDef, o: PlayOpts & { param?: number } = {}): EngineLoop | null {
    let ctl: LoopCtl = {};
    const v = this.start(name, def, { ...o, a: o.param ?? 0 }, true, (s, x) => {
      ctl = def.build(s, x);
      return Infinity;
    });
    if (!v) return null;
    const ctx = this.ctx;
    // fade in: a loop never starts with a click
    const g = v.scope.out.gain;
    g.setValueAtTime(0, v.scope.t);
    g.linearRampToValueAtTime(1, v.scope.t + 0.12);
    ctl.param?.(clamp(o.param ?? 0), v.scope.t);
    let stopped = false;
    return {
      spatial: !!v.pos,
      alive: () => !v.stolen,
      set: (p) => {
        if (stopped || v.stolen) return;
        const now = ctx.currentTime;
        if (p.pos && v.pos) {
          v.pos[0] = p.pos[0];
          v.pos[1] = p.pos[1];
          v.pos[2] = p.pos[2];
        }
        if (p.gain !== undefined) v.level = Math.max(0, p.gain) * v.trim;
        if (p.pos || p.gain !== undefined) this.place(v, now, 0.06);
        if (p.pitch !== undefined) {
          const cents = 1200 * Math.log2(clamp(p.pitch, 0.25, 4));
          for (const s of v.scope.srcs) s.detune.setTargetAtTime(cents, now, 0.06);
        }
        if (p.param !== undefined) ctl.param?.(clamp(p.param), now);
      },
      stop: (fade = 0.3) => {
        if (stopped || v.stolen) return;
        stopped = true;
        const now = ctx.currentTime;
        const f = Math.max(0.02, fade);
        g.cancelScheduledValues(now);
        g.setTargetAtTime(0, now, f / 4);
        v.scope.stopAll(now + f + 0.05);
        v.end = now + f + 0.1;
        v.loop = false;
      },
    };
  }

  /** Free finished voices and keep spatial loops placed as the listener moves. */
  update(): void {
    const now = this.ctx.currentTime;
    const vs = this.voices;
    for (let i = vs.length - 1; i >= 0; i--) {
      const v = vs[i];
      if (v.end <= now) {
        this.release(v);
        vs[i] = vs[vs.length - 1];
        vs.pop();
      } else if (v.loop && v.pos) this.place(v, now, 0.08);
    }
    if (this.last.size > 64) this.last.clear();
  }
}
