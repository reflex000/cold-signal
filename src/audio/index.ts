// Sound for Cold Signal. Everything is synthesised at run time with the Web Audio API.
//
//   const audio = createAudio();
//   button.onclick = () => audio.unlock();        // browsers only start audio from a gesture
//   each frame: audio.setListener(...); audio.setAmbience({...}); audio.update(dt);
//
// Before unlock() every call is accepted and remembered (volumes, ambience, listener, music mood,
// loops); one-shots asked for in the last moments before the context came up are played, older
// ones are dropped. Nothing throws when audio is unavailable: the game just runs silent.
//
// Layout: dsp.ts (noise, impulse responses, the per-voice builder), engine.ts (buses, reverbs,
// master dynamics, voice pool, spatial placement), sfx.ts / loops.ts (the sounds), mix.ts (one
// level per sound), ambience.ts (wind, place, body), music/ (the score), scenes.ts (listening
// scenes for the bench page and the checker), check.ts (offline rendering and measurement for
// tools/audio-check.mjs; not imported by the game).
import type { Surface } from '../sim/types';
import type { Ambience, AudioApi, LoopHandle, LoopName, MusicMood, SfxName } from './api';
import { AmbienceSynth } from './ambience';
import { clamp } from './dsp';
import { Engine, type EngineLoop, type PlayOpts, type Vec3, measureCompGain } from './engine';
import { LOOPS } from './loops';
import { createMusic } from './music/index';
import { SFX, STEPS } from './sfx';

export type { Ambience, AudioApi, LoopHandle, LoopName, MusicMood, SfxName } from './api';
export { LOOP_NAMES } from './loops';
export { SFX_NAMES, STEP_NAMES } from './sfx';

type Music = ReturnType<typeof createMusic>;

export interface CoreOptions {
  /** phones: fewer voices, equal-power panning, short impulse responses */
  lite: boolean;
  seed: number;
  /** from measureCompGain(sampleRate) */
  compGain?: number;
  /** where the master goes (default ctx.destination) */
  dest?: AudioNode;
  /** rendering on an OfflineAudioContext */
  offline?: boolean;
  maxVoices?: number;
  /** false: no wind, no body (the check tool renders single sounds in still air) */
  ambience?: boolean;
  /** false: no score */
  music?: boolean;
}

/** The whole synth on a context that is already running (or offline). createAudio() wraps one of these. */
export interface AudioCore extends AudioApi {
  readonly engine: Engine;
  readonly ambience: AmbienceSynth | null;
  dispose(): void;
}

const warned = new Set<string>();
function warnOnce(what: string): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[audio] ${what}`);
}

const okPos = (p: readonly number[] | undefined): p is Vec3 => !!p && p.length >= 3 && isFinite(p[0] + p[1] + p[2]);
const okNum = (v: number | undefined, d: number): number => (typeof v === 'number' && isFinite(v) ? v : d);

interface LoopState {
  pos?: Vec3;
  gain: number;
  pitch: number;
  param: number;
}

/**
 * What the game holds for a loop. It outlives the voice behind it: the voice is made when the
 * context is up, made again if the voice cap took it, and remade spatial if it is given a
 * position after starting without one.
 */
class Loop implements LoopHandle {
  real: EngineLoop | null = null;
  stopped = false;
  retryAt = 0;
  readonly st: LoopState;
  constructor(readonly name: LoopName, st: LoopState, private owner: { start(l: Loop): void; drop(l: Loop): void }) {
    this.st = st;
  }
  set(p: { pos?: [number, number, number]; gain?: number; pitch?: number; param?: number }): void {
    if (this.stopped || !p) return;
    const st = this.st;
    let respawn = false;
    if (okPos(p.pos)) {
      respawn = !st.pos && !!this.real;
      st.pos = [p.pos[0], p.pos[1], p.pos[2]];
    }
    if (p.gain !== undefined) st.gain = Math.max(0, okNum(p.gain, st.gain));
    if (p.pitch !== undefined) st.pitch = clamp(okNum(p.pitch, st.pitch), 0.25, 4);
    if (p.param !== undefined) st.param = clamp(okNum(p.param, st.param));
    if (respawn && this.real) {
      this.real.stop(0.1);
      this.real = null;
      this.owner.start(this);
    } else this.real?.set({ pos: okPos(p.pos) ? st.pos : undefined, gain: p.gain !== undefined ? st.gain : undefined, pitch: p.pitch !== undefined ? st.pitch : undefined, param: p.param !== undefined ? st.param : undefined });
  }
  stop(fadeSeconds?: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.real?.stop(okNum(fadeSeconds, 0.3));
    this.real = null;
    this.owner.drop(this);
  }
}

/** A loop the synth does not know: accepts everything, sounds nothing. */
const DEAD_LOOP: LoopHandle = { set() {}, stop() {} };

export function buildAudio(ctx: BaseAudioContext, o: CoreOptions): AudioCore {
  const engine = new Engine(ctx, { lite: o.lite, seed: o.seed, dest: o.dest, offline: o.offline, compGain: o.compGain, maxVoices: o.maxVoices });
  const play = (name: string, p: PlayOpts): void => {
    const def = SFX[name];
    if (def) engine.play(name, def, p);
  };
  const ambience = o.ambience === false ? null : new AmbienceSynth(engine, play, ctx.currentTime, o.seed ^ 0x5bd1e995);
  let music: Music | null = null;
  if (o.music !== false) {
    try {
      music = createMusic(ctx, engine.bus.music);
    } catch (e) {
      warnOnce(`the score failed to start: ${(e as Error).message}`);
    }
  }
  const loops = new Set<Loop>();
  const owner = {
    start(l: Loop): void {
      const def = LOOPS[l.name];
      if (!def || l.stopped) return;
      l.real = engine.loop(l.name, def, { pos: l.st.pos, gain: l.st.gain, param: l.st.param });
      if (l.real && l.st.pitch !== 1) l.real.set({ pitch: l.st.pitch });
      l.retryAt = ctx.currentTime + 0.5;
    },
    drop(l: Loop): void {
      loops.delete(l);
    },
  };

  const core: AudioCore = {
    engine,
    ambience,
    ready: true,
    async unlock() {},
    setVolumes(v) {
      engine.setVolumes(okNum(v.master, 1), okNum(v.music, 1), okNum(v.sfx, 1));
    },
    setListener(px, py, pz, fx, fy, fz) {
      engine.setListener(px, py, pz, fx, fy, fz);
    },
    sfx(name, opts) {
      const def = SFX[name];
      if (!def || name.charCodeAt(0) === 95) {
        warnOnce(`unknown sfx '${name}'`);
        return;
      }
      try {
        engine.play(name, def, { pos: okPos(opts?.pos) ? opts.pos : undefined, gain: okNum(opts?.gain, 1), pitch: okNum(opts?.pitch, 1), delay: okNum(opts?.delay, 0) });
      } catch (e) {
        warnOnce(`sfx '${name}' failed: ${(e as Error).message}`);
      }
    },
    loop(name, opts) {
      if (!LOOPS[name]) {
        warnOnce(`unknown loop '${name}'`);
        return DEAD_LOOP;
      }
      const l = new Loop(name, { pos: okPos(opts?.pos) ? [opts.pos[0], opts.pos[1], opts.pos[2]] : undefined, gain: Math.max(0, okNum(opts?.gain, 1)), pitch: 1, param: clamp(okNum(opts?.param, 0)) }, owner);
      loops.add(l);
      try {
        owner.start(l);
      } catch (e) {
        warnOnce(`loop '${name}' failed: ${(e as Error).message}`);
      }
      return l;
    },
    footstep(surface, speed01, opts) {
      const def = STEPS[surface];
      if (!def) {
        warnOnce(`unknown surface '${surface}'`);
        return;
      }
      try {
        engine.play('step_' + surface, def, { pos: okPos(opts?.pos) ? opts.pos : undefined, gain: okNum(opts?.gain, 1), a: clamp(okNum(speed01, 0.5)), b: clamp(okNum(opts?.depth, surface === 'deep' ? 0.6 : 0)) });
      } catch (e) {
        warnOnce(`footstep '${surface}' failed: ${(e as Error).message}`);
      }
    },
    setAmbience(a) {
      ambience?.set(a);
    },
    setMusic(mood, opts) {
      music?.setMood(mood, opts);
    },
    setDuck(amount) {
      engine.setDuck(okNum(amount, 0));
    },
    update(dt) {
      const d = clamp(okNum(dt, 0), 0, 0.25);
      const now = ctx.currentTime;
      ambience?.tick(d, now);
      engine.update();
      music?.update(d);
      // a loop the voice cap refused or took comes back when there is room
      for (const l of loops) {
        if (l.real && !l.real.alive()) l.real = null;
        if (!l.real && now >= l.retryAt) {
          try {
            owner.start(l);
          } catch {
            l.retryAt = now + 2;
          }
        }
      }
    },
    suspend() {},
    resume() {},
    meter() {
      return engine.meter();
    },
    dispose() {
      for (const l of [...loops]) l.stop(0.05);
      ambience?.dispose(ctx.currentTime + 0.1);
      (music as { dispose?: () => void } | null)?.dispose?.();
    },
  };
  return core;
}

/** Phones and small machines: cheaper panning, shorter reverbs, fewer voices. */
export function detectLite(): boolean {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    const mem = nav.deviceMemory;
    const cores = nav.hardwareConcurrency;
    return coarse || (typeof mem === 'number' && mem <= 2) || (typeof cores === 'number' && cores <= 2);
  } catch {
    return false;
  }
}

export interface AudioOptions {
  /** force the phone profile on or off (default: detectLite()) */
  lite?: boolean;
}

/** One-shots asked for this long before the context came up are still played (the click that unlocked). */
const LATE_SFX_MS = 350;

export function createAudio(options: AudioOptions = {}): AudioApi {
  let ctx: AudioContext | null = null;
  let core: AudioCore | null = null;
  let unlocking: Promise<void> | null = null;
  let failed = false;
  /** the game asked for silence (pause on a phone, app in the background) */
  let held = false;
  let hooked = false;

  // what the game has asked for so far: applied when the context comes up
  const vol = { master: 1, music: 1, sfx: 1 };
  let duck = 0;
  let listener: [number, number, number, number, number, number] | null = null;
  const amb: Partial<Ambience> = {};
  let mood: { mood: MusicMood; intensity?: number } | null = null;
  const lateSfx: { at: number; run: (c: AudioCore) => void }[] = [];
  /** loops asked for before the context was up */
  const early = new Set<EarlyLoop>();

  interface EarlyLoop extends LoopHandle {
    name: LoopName;
    st: { pos?: [number, number, number]; gain?: number; pitch?: number; param?: number };
    real: LoopHandle | null;
    dead: boolean;
  }

  const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);

  /** Bring the context to the state the page and the game want. Called from gestures and visibility changes. */
  function settle(): void {
    if (!ctx) return;
    const want = !held && visible();
    const state = ctx.state as string;
    if (want && state !== 'running' && state !== 'closed') ctx.resume().catch(() => {});
    else if (!want && state === 'running') ctx.suspend().catch(() => {});
  }

  function hook(): void {
    if (hooked || typeof document === 'undefined') return;
    hooked = true;
    document.addEventListener('visibilitychange', settle);
    // a phone call, the lock screen, another app taking the output: the context comes back
    // 'suspended' or 'interrupted' and only a gesture may wake it
    const wake = (): void => {
      if (ctx && (ctx.state as string) !== 'running') settle();
    };
    for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) window.addEventListener(ev, wake, { capture: true, passive: true });
    window.addEventListener('pageshow', settle);
    window.addEventListener('focus', settle);
  }

  async function start(): Promise<void> {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not available');
    const lite = options.lite ?? detectLite();
    // everything up to the first await runs inside the gesture: that is what unlocks audio on phones
    const c = new AC({ latencyHint: lite ? 'balanced' : 'interactive' });
    ctx = c;
    const wake = c.resume();
    try {
      // iOS wants a buffer played from the gesture itself
      const b = c.createBuffer(1, 1, c.sampleRate);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch {
      /* not needed elsewhere */
    }
    hook();
    c.onstatechange = () => {
      // an interruption that ends on its own (a notification sound) leaves us suspended: try once
      if ((c.state as string) !== 'running') setTimeout(settle, 250);
    };
    await wake.catch(() => {});
    const compGain = await measureCompGain(c.sampleRate);
    const built = buildAudio(c, { lite, seed: (Math.random() * 0x7fffffff) | 0, compGain });
    built.engine.buildSpaces();
    built.setVolumes(vol);
    built.setDuck(duck);
    if (listener) built.setListener(...listener);
    built.setAmbience(amb);
    if (mood) built.setMusic(mood.mood, mood.intensity === undefined ? undefined : { intensity: mood.intensity });
    for (const l of early) {
      if (!l.dead) l.real = built.loop(l.name, l.st);
      if (l.real && l.st.pitch !== undefined) l.real.set({ pitch: l.st.pitch });
    }
    early.clear();
    const t = nowMs();
    for (const q of lateSfx) if (t - q.at < LATE_SFX_MS) q.run(built);
    lateSfx.length = 0;
    core = built;
    settle();
  }

  const queue = (run: (c: AudioCore) => void): void => {
    // only while the context is coming up; before any gesture there is nothing to be late for
    if (!unlocking || failed) return;
    if (lateSfx.length < 8) lateSfx.push({ at: nowMs(), run });
  };

  return {
    get ready(): boolean {
      return core !== null;
    },
    unlock(): Promise<void> {
      if (failed) return Promise.resolve();
      if (core) {
        held = false;
        settle();
        return Promise.resolve();
      }
      if (!unlocking) {
        unlocking = start().catch((e) => {
          failed = true;
          warnOnce(`no sound: ${(e as Error).message}`);
          try {
            void ctx?.close();
          } catch {
            /* already closed */
          }
          ctx = null;
        });
      } else if (ctx && (ctx.state as string) !== 'running') ctx.resume().catch(() => {});
      return unlocking;
    },
    setVolumes(v) {
      vol.master = clamp(okNum(v.master, vol.master));
      vol.music = clamp(okNum(v.music, vol.music));
      vol.sfx = clamp(okNum(v.sfx, vol.sfx));
      core?.setVolumes(vol);
    },
    setListener(px, py, pz, fx, fy, fz) {
      if (core) core.setListener(px, py, pz, fx, fy, fz);
      else listener = [px, py, pz, fx, fy, fz];
    },
    sfx(name: SfxName, opts) {
      if (core) core.sfx(name, opts);
      else {
        const o = opts ? { ...opts } : undefined;
        queue((c) => c.sfx(name, o));
      }
    },
    loop(name: LoopName, opts): LoopHandle {
      if (core) return core.loop(name, opts);
      if (!LOOPS[name]) {
        warnOnce(`unknown loop '${name}'`);
        return DEAD_LOOP;
      }
      const h: EarlyLoop = {
        name,
        st: { ...opts },
        real: null,
        dead: false,
        set(p) {
          if (h.real) h.real.set(p);
          else Object.assign(h.st, p);
        },
        stop(f) {
          h.dead = true;
          early.delete(h);
          h.real?.stop(f);
        },
      };
      early.add(h);
      return h;
    },
    footstep(surface: Surface, speed01: number, opts) {
      if (core) core.footstep(surface, speed01, opts);
      else {
        const o = opts ? { ...opts } : undefined;
        queue((c) => c.footstep(surface, speed01, o));
      }
    },
    setAmbience(a) {
      if (core) core.setAmbience(a);
      else Object.assign(amb, a);
    },
    setMusic(m, opts) {
      mood = { mood: m, intensity: opts?.intensity };
      core?.setMusic(m, opts);
    },
    setDuck(amount) {
      duck = clamp(okNum(amount, 0));
      core?.setDuck(duck);
    },
    update(dt) {
      // while the context is asleep its clock stands still: scheduling against it would pile up
      if (core && ctx && ctx.state === 'running') core.update(dt);
    },
    suspend() {
      held = true;
      settle();
    },
    resume() {
      held = false;
      settle();
    },
    meter() {
      return core ? core.meter() : { peak: 0, rms: 0, voices: 0 };
    },
  };
}
