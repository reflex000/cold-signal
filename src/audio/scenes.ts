// Listening scenes: one moment of the game each, played through the same AudioApi the game uses.
// The bench page's scene row (dev/audio.html) and tools/audio-check.mjs (offline, via check.ts)
// both run these, so what is measured is what is auditioned.
//
//   const run = new SceneRunner(audio, SCENES[0]);   // sets listener, ambience, loops, music
//   each frame: run.tick(dt);                          // drives slow changes, fires the events
//   run.stop();
//
// Positions are metres around a listener standing at the origin; yaw follows the game's
// convention (0 faces north, -Z; counter-clockwise seen from above).
import type { AudioApi, LoopHandle, LoopName, MusicMood, SfxName } from './api';
import { AMBIENCE_DEFAULT, type AmbienceEx } from './ambience';
import { mulberry } from './dsp';

type V3 = [number, number, number];

export interface SceneEvent {
  /** seconds after the scene starts */
  t: number;
  sfx: SfxName;
  pos?: V3;
  gain?: number;
  /** then again about this often (jittered by +-40%); omitted: once */
  every?: number;
}

export interface Scene {
  id: string;
  label: string;
  /** the place and the weather; unset fields take AMBIENCE_DEFAULT */
  amb: Partial<AmbienceEx>;
  /** slow changes over time t (seconds): gusts sweeping through, the cold coming on */
  drive?: (t: number) => Partial<AmbienceEx>;
  loops?: { name: LoopName; param?: number; pos?: V3; gain?: number }[];
  events?: SceneEvent[];
  music?: MusicMood;
  musicIntensity?: number;
  /** listener heading, degrees */
  yaw?: number;
}

/** A swell every `p` seconds: 0 most of the time, rising to 1 and falling again. */
const swell = (t: number, p: number, phase = 0): number => Math.pow(Math.abs(Math.sin(Math.PI * (t / p + phase))), 3);

export const SCENES: readonly Scene[] = [
  {
    id: 'dusk',
    label: 'calm dusk',
    amb: { wind: 0.22, storm: 0.04, snowfall: 0.08, forest: 0.35, height: 40, night: 0.35, cold: 0.15, windDir: [0.8, 0.6] },
    drive: (t) => ({ gust: 0.35 * swell(t, 13) }),
    events: [{ t: 6, sfx: 'howl_far', pos: [-260, 60, -330], every: 40 }],
    music: 'calm',
    musicIntensity: 0.4,
  },
  {
    id: 'ridge',
    label: 'whiteout on the ridge',
    amb: { wind: 0.95, storm: 1, snowfall: 1, height: 620, night: 0.25, cold: 0.75, windDir: [0.5, 0.85] },
    drive: (t) => ({ gust: 0.9 * swell(t, 7.5, 0.2) }),
    events: [
      { t: 3, sfx: 'metal_creak', pos: [6, 8, -10], every: 9 },
      { t: 10, sfx: 'gust', every: 11 },
    ],
    music: 'whiteout',
    musicIntensity: 0.6,
    yaw: 30,
  },
  {
    id: 'cabin',
    label: 'by the fire in the cabin',
    amb: { wind: 0.65, storm: 0.55, snowfall: 0.7, indoor: 1, shelter: 1, forest: 0.6, night: 0.75, cold: 0.05, windDir: [1, 0] },
    drive: (t) => ({ gust: 0.6 * swell(t, 9) }),
    loops: [{ name: 'stove', pos: [1.6, 0.5, -1.2] }],
    music: 'shelter',
    musicIntensity: 0.4,
  },
  {
    id: 'stalked',
    label: 'stalked at night',
    amb: { wind: 0.35, storm: 0.25, snowfall: 0.35, forest: 0.75, night: 1, cold: 0.5, windDir: [-0.6, 0.8] },
    drive: (t) => ({ gust: 0.4 * swell(t, 11) }),
    loops: [
      { name: 'fire', param: 0.45, pos: [0.5, 0.2, 2.2] },
      { name: 'wolf_breath', param: 0.55, pos: [-7, 0.6, -9] },
    ],
    events: [
      { t: 1, sfx: 'howl_far', pos: [300, 80, -200], every: 30 },
      { t: 6, sfx: 'howl', pos: [45, 6, -70], every: 26 },
      { t: 12, sfx: 'growl', pos: [-5, 0.5, -6], every: 14 },
      { t: 15, sfx: 'paws', pos: [8, 0, -12], every: 9 },
      { t: 17.5, sfx: 'bark', pos: [9, 0.5, -10], every: 16 },
    ],
    music: 'stalked',
    musicIntensity: 0.6,
  },
  {
    id: 'ice',
    label: 'on the ice',
    amb: { wind: 0.45, storm: 0.1, snowfall: 0.05, onIce: 1, night: 0.6, cold: 0.4, windDir: [0.9, -0.4] },
    drive: (t) => ({ gust: 0.45 * swell(t, 12, 0.5) }),
    events: [
      { t: 3, sfx: 'ice_creak', pos: [4, -0.2, 5], every: 11 },
      { t: 8, sfx: 'ice_boom', pos: [-220, -2, -340], every: 20 },
      { t: 14, sfx: 'ice_crack', pos: [35, -0.2, -60], every: 25 },
    ],
    music: 'cold',
    musicIntensity: 0.4,
  },
  {
    id: 'cave',
    label: 'in the cave',
    amb: { wind: 0.7, storm: 0.6, snowfall: 0.4, cave: 1, shelter: 1, night: 0.5, cold: 0.3, windDir: [0, 1] },
    drive: (t) => ({ gust: 0.7 * swell(t, 8) }),
    loops: [{ name: 'fire', param: 0.6, pos: [0, 0.2, 2.5] }],
    events: [{ t: 10, sfx: 'growl', pos: [-4, 0.5, -14], every: 20 }],
    music: 'shelter',
    musicIntensity: 0.3,
  },
];

type SceneApi = Pick<AudioApi, 'setAmbience' | 'loop' | 'sfx' | 'setListener' | 'setMusic'>;

export class SceneRunner {
  /** seconds since the scene started */
  t = 0;
  private handles: LoopHandle[] = [];
  private next: number[];
  private rnd = mulberry(417);

  constructor(private api: SceneApi, readonly scene: Scene, opts: { music?: boolean } = {}) {
    const s = scene;
    const yaw = ((s.yaw ?? 0) * Math.PI) / 180;
    api.setListener(0, 1.7, 0, -Math.sin(yaw), 0, -Math.cos(yaw));
    api.setAmbience({ ...AMBIENCE_DEFAULT, windDir: [...AMBIENCE_DEFAULT.windDir], ...s.amb, ...(s.drive?.(0) ?? {}) });
    for (const l of s.loops ?? []) this.handles.push(api.loop(l.name, { pos: l.pos, gain: l.gain, param: l.param }));
    if (opts.music !== false) api.setMusic(s.music ?? 'none', { intensity: s.musicIntensity });
    this.next = (s.events ?? []).map((e) => e.t);
  }

  tick(dt: number): void {
    this.t += dt;
    const s = this.scene;
    if (s.drive) this.api.setAmbience(s.drive(this.t));
    const ev = s.events ?? [];
    for (let i = 0; i < ev.length; i++) {
      if (this.t < this.next[i]) continue;
      const e = ev[i];
      this.api.sfx(e.sfx, { pos: e.pos, gain: e.gain });
      this.next[i] = e.every ? this.t + e.every * (0.6 + 0.8 * this.rnd()) : Infinity;
    }
  }

  stop(fade = 1): void {
    for (const h of this.handles) h.stop(fade);
    this.handles.length = 0;
  }
}
