// FX: fire, flares, light, breath, the cold on the goggles, and the small things (muzzle flash,
// sparks, snow puffs, splashes). createFxSystem(engine, world) returns the GfxSystem 'fx'.
//
// Driven by the View (list('fire'), list('flare'), players, wolves, hud, env), by simulation
// events on view.bus 'sim', and by the emitters and lamps of KIT's placed props
// (engine.get('props')). Everything it draws is six instanced meshes (flames, coal beds, puffs,
// glow streaks, debris) plus the pooled lights and three screen overlays.
//
// For other modules:
//   const fx = engine.get<FxSystem>('fx');
//   fx.lights.acquire('spot' | 'point', priority) -> LightHandle   (see lights.ts)
//   fx.burst('muzzle' | 'snow' | 'step' | 'chips' | 'sparks' | 'splash' | 'shards' | 'steam' | 'smoke', x, y, z, dx?, dy?, dz?, k?)
// Owner: FX.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem, Quality } from '../api';
import type { CsEngine } from '../engine';
import type { PropsSystem } from '../../models/instances';
import type { View } from '../../game/view';
import type { SimEvent } from '../../sim/types';
import type { World } from '../../world/types';
import { ATMOS, U } from '../shared';
import { BreathFx } from './breath';
import type { FxCtx } from './ctx';
import { EmitterFx } from './emitters';
import { FireFx } from './fire';
import { CoalPool, FlamePool } from './flame';
import { FlareFx } from './flare';
import { ImpactFx, type BurstKind } from './impacts';
import { LightPool } from './lights';
import { Rand } from './noise';
import { Overlays } from './overlays';
import { DebrisPool, GlowPool, PuffPool, type SimEnv } from './particles';

export type { BurstKind } from './impacts';
export { LightHandle, LightPool, type LightKind } from './lights';

export interface FxSystem extends GfxSystem {
  readonly name: 'fx';
  /** The dynamic light pool: every point / spot light in the game comes from here. */
  readonly lights: LightPool;
  /** A one-shot effect at a world position; (dx, dy, dz) a direction where it matters; k its size. */
  burst(kind: BurstKind, x: number, y: number, z: number, dx?: number, dy?: number, dz?: number, k?: number): void;
  /** Tools and benches: set the goggle overlays directly (null leaves one to the HUD). */
  forceOverlays(frost: number | null, wet: number | null, snow: number | null): void;
  /** Counts for a stats overlay. */
  readonly info: { fires: number; flares: number; puffs: number; glow: number; debris: number };
  /** Tools: wind as fx sees it, the eye adaptation (stops) and every fire's visual state. */
  debug(): Record<string, unknown>;
}

const CAP = { puffs: 1000, glow: 1400, debris: 420, tongues: 192, beds: 24 };

export function createFxSystem(engine: CsEngine, world: World): FxSystem {
  const scene = engine.scene;
  const camera = engine.camera;
  let quality: Quality = engine.quality;

  const lights = new LightPool(scene, quality);
  const puffs = new PuffPool(CAP.puffs);
  const glow = new GlowPool(CAP.glow);
  const debris = new DebrisPool(CAP.debris);
  const flames = new FlamePool(CAP.tongues);
  const coals = new CoalPool(CAP.beds);
  const group = new THREE.Group();
  group.name = 'fx';
  group.add(coals.mesh, puffs.mesh, debris.mesh, glow.mesh, flames.mesh);
  scene.add(group);

  const ctx: FxCtx = {
    engine,
    world,
    camera,
    lights,
    puffs,
    glow,
    debris,
    flames,
    coals,
    rand: new Rand(0x51f15e),
    quality,
    budget: quality.particleBudget,
    time: 0,
    dt: 0,
    view: null,
    windX: 0,
    windZ: 0,
    windSpeed: 0,
    gust: 0,
    snowfall: 0,
    storm: 0,
    props: null,
    ground(x: number, z: number, y?: number): number {
      try {
        return y === undefined ? world.heightAt(x, z) : world.groundAt(x, z, y + 0.5).y;
      } catch {
        return 0;
      }
    },
  };

  const fire = new FireFx(ctx);
  const flare = new FlareFx(ctx);
  const breath = new BreathFx(ctx);
  const impacts = new ImpactFx(ctx);
  const emitters = new EmitterFx(ctx);
  const overlays = new Overlays(engine, quality);
  const simEnv: SimEnv = { windX: 0, windZ: 0, time: 0 };

  // ---- events ----
  let bus: View['bus'] | null = null;
  let unsub: (() => void) | null = null;
  const onSim = (ev: SimEvent): void => {
    const view = ctx.view;
    try {
      fire.onEvent(ev);
      flare.onEvent(ev, view);
      impacts.onEvent(ev, view);
    } catch (e) {
      console.error('[fx] event handler failed', ev.t, e);
    }
  };

  // ---- the light pool hands out its lights right before the scene is drawn ----
  // (three's WebGPU renderer calls scene.onBeforeRender(renderer, scene, camera, renderTarget))
  const prevBefore = scene.onBeforeRender as unknown as (...a: unknown[]) => void;
  let lastAssign = -10;
  const before = function (this: THREE.Scene, ...a: unknown[]): void {
    prevBefore.apply(this, a);
    if (a[2] === camera) {
      lights.assign(camera);
      lastAssign = lights.frame;
    }
  };
  scene.onBeforeRender = before as unknown as typeof scene.onBeforeRender;

  const info = { fires: 0, flares: 0, puffs: 0, glow: 0, debris: 0 };
  let lastTime = -1;

  // ---- GAME's stand-in markers draw their own flames, stones and fire lights for fires and
  // flares: hand them a view whose list() is empty for those kinds (their file is GAME's; this
  // only wraps the call, as FIGURES does for players and wolves, with its own flag so both chain).
  const EMPTY: never[] = [];
  let markersMuted = false;
  function muteMarkers(): void {
    const m = engine.get('markers') as (GfxSystem & { __fxMuted?: boolean }) | undefined;
    if (!m) return;
    markersMuted = true;
    if (m.__fxMuted) return;
    const orig = m.update.bind(m);
    let seen: View | null = null;
    let proxy: View | null = null;
    const frame: Frame = { dt: 0, time: 0, view: null as unknown as View };
    m.update = (f: Frame): void => {
      if (!f.view) return orig(f);
      if (f.view !== seen) {
        seen = f.view;
        const real = f.view;
        proxy = Object.create(real, {
          list: { value: (k: string) => (k === 'fire' || k === 'flare' ? EMPTY : real.list(k as never)) },
        }) as View;
      }
      frame.dt = f.dt;
      frame.time = f.time;
      frame.view = proxy as View;
      orig(frame);
    };
    m.__fxMuted = true;
  }

  // ---- the eye adapts to firelight ----
  // The sky's auto exposure adapts to moonlit snow; next to a fire at night that would blow the
  // fire's pool out to white. The firelight around the camera lowers the sky's exposureBias (its
  // documented knob) by up to 1.25 stops, added to whatever bias others set (we only ever take
  // back our own share).
  let adapt = 0;
  let written = 0;
  const _cam = new THREE.Vector3();
  function adaptEyes(dt: number): void {
    const sky = engine.get<GfxSystem & { exposureBias?: number }>('sky');
    if (!sky || typeof sky.exposureBias !== 'number') return;
    camera.getWorldPosition(_cam);
    let E = 0;
    for (const h of lights.active) {
      if (h.kind !== 'point' || h.priority > 1.6 || !h.on) continue; // fires, flares, lamps
      const d2 = h.position.distanceToSquared(_cam) + 0.6;
      const x = Math.min(1, Math.sqrt(d2) / Math.max(0.1, h.range));
      const win = Math.max(0, 1 - x * x * x * x);
      E += (h.intensity * win * win) / d2;
    }
    const lit = (0.86 * E) / Math.PI;
    const key = Math.max(1e-4, ATMOS.luminance);
    const target = -Math.min(1.25, 0.45 * Math.log2(1 + lit / key));
    adapt += (target - adapt) * (1 - Math.exp(-dt * 0.9));
    const base = sky.exposureBias - written;
    sky.exposureBias = base + adapt;
    written = adapt;
  }

  /** One simulation step: emitters, events already queued, particles. Draw lists start over. */
  function simulate(view: View | null, dt: number, time: number): void {
    ctx.dt = dt;
    ctx.time = time;
    // wind and weather of the frame: the interpolated environment, else the shared uniforms
    if (view && view.env) {
      const g = view.env.gust || 0;
      ctx.windX = view.env.windX * (1 + 0.5 * g);
      ctx.windZ = view.env.windZ * (1 + 0.5 * g);
      ctx.gust = g;
      ctx.snowfall = view.env.snowfall;
      ctx.storm = view.env.storm;
    } else {
      const d = U.windDir.value as THREE.Vector2;
      const s = U.windSpeed.value as number;
      ctx.windX = d.x * s;
      ctx.windZ = d.y * s;
      ctx.gust = U.gust.value;
      ctx.snowfall = U.snowfall.value;
      ctx.storm = U.storm.value;
    }
    ctx.windSpeed = Math.hypot(ctx.windX, ctx.windZ);
    if (!ctx.props) ctx.props = (engine.get<PropsSystem>('props') as PropsSystem | undefined) ?? null;

    flames.begin();
    coals.begin();
    fire.update(view);
    flare.update(view);
    flare.tickFlashes();
    breath.update(view);
    impacts.update(view);
    impacts.drawTongues();
    emitters.update(view);
    simEnv.windX = ctx.windX;
    simEnv.windZ = ctx.windZ;
    simEnv.time = time;
    puffs.step(dt, simEnv);
    glow.step(dt, simEnv);
    debris.step(dt, simEnv);
  }

  const sys: FxSystem = {
    name: 'fx',
    lights,
    info,

    update(f: Frame): void {
      const view = (f.view ?? null) as View | null;
      ctx.view = view;
      if (!markersMuted) muteMarkers();
      if (view && view.bus !== bus) {
        unsub?.();
        bus = view.bus;
        unsub = bus.on('sim', onSim);
      }
      // the pause menu and photo mode hold a frozen moment: the render clock stops, so does fx
      const frozen = !!view && (view.mode === 'pause' || view.mode === 'photo');
      const dt = frozen ? 0 : Math.min(0.1, Math.max(0, f.dt));
      // Frames that were never drawn (a hitch, or a tool stepping many frames per picture): let
      // the fires keep burning through the gap, in small steps, up to a few seconds.
      const gap = lastTime < 0 ? 0 : Math.min(3, f.time - lastTime - dt);
      lastTime = f.time;
      const caught = gap > dt * 0.5;
      if (caught) {
        let left = gap;
        while (left > 1e-4) {
          const h = Math.min(1 / 30, left);
          left -= h;
          simulate(view, h, f.time - dt - left);
        }
      }
      lights.tick(dt);
      simulate(view, dt, f.time);
      puffs.write(camera);
      glow.write(f.time);
      debris.write();
      flames.end();
      coals.end();
      overlays.update(view, caught ? dt + gap : dt, ctx.windX, ctx.windZ, ctx.storm, ctx.snowfall);
      adaptEyes(caught ? dt + gap : dt);

      // a harness that never draws through the scene's onBeforeRender still gets its lights
      if (lights.frame - lastAssign > 2) {
        lights.assign(camera);
        lastAssign = lights.frame;
      }
      info.fires = fire.count;
      info.flares = flare.count;
      info.puffs = puffs.n;
      info.glow = glow.n;
      info.debris = debris.n;
    },

    setQuality(q: Quality): void {
      quality = q;
      ctx.quality = q;
      ctx.budget = q.particleBudget;
      lights.setQuality(q);
      overlays.setQuality(q);
    },

    burst(kind, x, y, z, dx = 0, dy = 0, dz = 0, k = 1): void {
      impacts.burst(kind, x, y, z, dx, dy, dz, k);
    },

    forceOverlays(frost, wet, snow): void {
      overlays.force(frost, wet, snow);
    },

    debug(): Record<string, unknown> {
      const r = (v: number) => Math.round(v * 100) / 100;
      return { wind: r(ctx.windSpeed), gust: r(ctx.gust), storm: r(ctx.storm), adapt: r(adapt), tongues: flames.count, fires: fire.debug(), lights: lights.active.map((h) => ({ kind: h.kind, i: r(h.intensity), lit: h.lit, p: h.priority })) };
    },

    dispose(): void {
      unsub?.();
      unsub = null;
      const sky = engine.get<GfxSystem & { exposureBias?: number }>('sky');
      if (sky && typeof sky.exposureBias === 'number') sky.exposureBias -= written;
      written = 0;
      if ((scene.onBeforeRender as unknown) === before) scene.onBeforeRender = prevBefore as unknown as typeof scene.onBeforeRender;
      fire.dispose();
      flare.dispose();
      breath.dispose();
      impacts.dispose();
      emitters.dispose();
      overlays.dispose();
      puffs.dispose();
      glow.dispose();
      debris.dispose();
      flames.dispose();
      coals.dispose();
      lights.dispose();
      scene.remove(group);
    },
  };
  return sys;
}
