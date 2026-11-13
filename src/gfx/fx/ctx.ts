// What every fx part shares: the pools it draws with, the light pool, the world, the clock and
// the wind of this frame. Built once by index.ts; the per-frame fields are rewritten each update.
// Owner: FX.
import type * as THREE from 'three/webgpu';
import type { Quality } from '../api';
import type { CsEngine } from '../engine';
import type { PropsSystem } from '../../models/instances';
import type { View } from '../../game/view';
import type { World } from '../../world/types';
import type { CoalPool, FlamePool } from './flame';
import type { LightPool } from './lights';
import type { Rand } from './noise';
import type { DebrisPool, GlowPool, PuffPool } from './particles';

export interface FxCtx {
  readonly engine: CsEngine;
  readonly world: World;
  readonly camera: THREE.PerspectiveCamera;
  readonly lights: LightPool;
  readonly puffs: PuffPool;
  readonly glow: GlowPool;
  readonly debris: DebrisPool;
  readonly flames: FlamePool;
  readonly coals: CoalPool;
  readonly rand: Rand;
  quality: Quality;
  /** quality.particleBudget: scale on every emission rate and burst size. */
  budget: number;
  /** Render clock and frame step, seconds. */
  time: number;
  dt: number;
  view: View | null;
  /** Wind of this frame (m/s, mean plus gust), its speed and the gust 0..1. */
  windX: number;
  windZ: number;
  windSpeed: number;
  gust: number;
  /** Snowfall 0..1 and storm 0..1 of this frame. */
  snowfall: number;
  storm: number;
  /** KIT's props system (placed models, their emitters and lamps), once it exists. */
  props: PropsSystem | null;
  /** Walkable ground height under a point (terrain or a floor), for particles. */
  ground(x: number, z: number, y?: number): number;
}

/** Emit `rate` per second over dt with a carried fraction; returns how many to spawn now. */
export function quota(acc: { v: number }, rate: number, dt: number): number {
  acc.v += Math.max(0, rate) * dt;
  const n = Math.floor(acc.v);
  acc.v -= n;
  return n;
}
