// CONTRACT for sound. Everything is synthesised with the Web Audio API; there are no audio files.
// Owner: MAIN (interface); AUDIO implements src/audio/index.ts `createAudio(): AudioApi`.
import type { Surface } from '../sim/types';

export type SfxName =
  // interface
  | 'ui_hover' | 'ui_click' | 'ui_open' | 'ui_close' | 'toast' | 'objective' | 'part_found'
  // body
  | 'jump' | 'land' | 'hurt' | 'bite' | 'downed' | 'revived' | 'death' | 'shiver' | 'gasp' | 'cough' | 'eat' | 'drink' | 'bandage' | 'heartbeat'
  // items and tools
  | 'pickup' | 'pickup_wood' | 'open_crate' | 'equip' | 'axe_swing' | 'axe_wood' | 'axe_flesh' | 'wood_split' | 'tree_fall'
  | 'rifle_shot' | 'rifle_bolt' | 'rifle_dry' | 'rifle_reload' | 'bullet_snow' | 'bullet_wood'
  | 'flare_shot' | 'flare_land' | 'light_click' | 'radio_crank' | 'radio_blip' | 'match_strike' | 'match_fail'
  // fire
  | 'fire_catch' | 'fire_feed' | 'fire_die' | 'fire_pop'
  // wolves
  | 'howl' | 'howl_far' | 'growl' | 'bark' | 'yelp' | 'wolf_die' | 'paws'
  // world
  | 'ice_creak' | 'ice_crack' | 'ice_break' | 'ice_boom' | 'splash' | 'gust' | 'branch_snow' | 'door' | 'log_lift' | 'log_drop'
  | 'generator_start' | 'generator_stop' | 'panel_install' | 'transmit' | 'metal_creak' | 'thunder';

export type LoopName =
  | 'fire' // param = heat 0..1
  | 'flare' // param = life 0..1
  | 'generator' // param = charge 0..1
  | 'radio_static' // param = signal 0..1 (clear tone rises out of the noise)
  | 'heli' // param = closeness 0..1
  | 'stove'
  | 'beacon'
  | 'wolf_breath'; // param = closeness

export type MusicMood = 'none' | 'title' | 'calm' | 'cold' | 'night' | 'stalked' | 'attack' | 'whiteout' | 'shelter' | 'tower' | 'holdout' | 'rescue' | 'death';

export interface LoopHandle {
  set(p: { pos?: [number, number, number]; gain?: number; pitch?: number; param?: number }): void;
  stop(fadeSeconds?: number): void;
}

export interface Ambience {
  wind: number; // 0..1 mean wind strength
  gust: number; // 0..1
  storm: number; // 0..1
  snowfall: number; // 0..1
  shelter: number; // 0..1 (lee of rocks / trees)
  indoor: number; // 0..1 (muffles the wind, adds room tone and creaks)
  forest: number; // 0..1 (wind in pines)
  height: number; // metres above the crash site (thinner, harder wind on the ridge)
  night: number; // 0..1
  onIce: number; // 0..1 (distant ice booms)
  cold: number; // 0..1 how cold the player is (shiver, breath, heartbeat, muffling)
  windDir: [number, number]; // world XZ unit vector the wind moves toward
  cave?: number; // 0..1 inside the cave (stone reverb, the wind left at the mouth). Optional, added by AUDIO.
}

export interface AudioApi {
  /** Call from a user gesture. Safe to call again. */
  unlock(): Promise<void>;
  readonly ready: boolean;
  setVolumes(v: { master: number; music: number; sfx: number }): void;
  /** Listener position, forward vector and velocity-less; up is +Y. */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number): void;
  /** One-shot. Without pos it is not spatial. `dist` hints for far sounds (howls, shots) let the synth pick a far variant. */
  sfx(name: SfxName, opts?: { pos?: [number, number, number]; gain?: number; pitch?: number; delay?: number }): void;
  loop(name: LoopName, opts?: { pos?: [number, number, number]; gain?: number; param?: number }): LoopHandle;
  footstep(surface: Surface, speed01: number, opts?: { pos?: [number, number, number]; gain?: number; depth?: number }): void;
  setAmbience(a: Partial<Ambience>): void;
  setMusic(mood: MusicMood, opts?: { intensity?: number }): void;
  /** Duck everything (pause menu) 0..1. */
  setDuck(amount: number): void;
  update(dt: number): void;
  suspend(): void;
  resume(): void;
  /** For tests: peak and RMS of the master bus over the last ~200 ms, and active voice count. */
  meter(): { peak: number; rms: number; voices: number };
}
