// SNOW: footprints, paw tracks, drags and hollows pressed into the snow, filling in with fresh
// snowfall and blowing over in the wind.
//
//   tracks.ts   sim events + motion -> records (what pressed the snow, how deep, where)
//   records.ts  the persistent store of records (the whole route), with the fill clock
//   painter.ts  the GPU windows: one RGBA8 atlas [near | far], instanced procedural stamps
//   sample.ts   reading it in a material (the terrain calls trailFragment / trailVertex / trailShadow)
//
// Publishes U.trailTex / trailOrigin / trailSize / trailOn (= 2: SNOW's encoding) and
// U.trailFar / trailAtlas / trailTexel / trailFill (see src/gfx/shared.ts). Reads View (bus 'sim'
// events, players, wolves, logs, env, camera) and never touches game state. Owner: SNOW.
import type { Engine, Frame, GfxSystem, Quality } from '../api';
import type { View } from '../../game/view';
import type { SimEvent } from '../../sim/types';
import type { World } from '../../world/types';
import { U } from '../shared';
import { snowTier, type SnowTier } from './config';
import { Painter, type PainterStats } from './painter';
import { RecordStore } from './records';
import { Tracks } from './tracks';

export { DEPTH_MAX, RIM_MAX } from './config';

export interface SnowSystem extends GfxSystem {
  /** Metres the snow is pressed below its surface at world (x, z) right now (0 if untouched). */
  pressAt(x: number, z: number): number;
  /** Metres of snow laid into hollows since the session began (new snow plus wind drift). */
  readonly fill: number;
  readonly stats: PainterStats & { records: number };
  /** Drop every record (a new session). */
  clear(): void;
}

/**
 * The fill clock: metres of snow that have settled into hollows. Falling snow (env.snowAccum,
 * metres laid down by the sim) and, above ~6 m/s, snow the wind carries along the ground, which
 * fills prints and knocks rims down even under a clear sky.
 */
class SnowFill {
  value = 0;
  private accum = -1;
  private t = -1;
  update(view: View): number {
    const e = view.env;
    if (!e) return this.value;
    const a = Math.max(0, e.snowAccum || 0);
    const t = e.t || 0;
    if (this.accum < 0 || a < this.accum - 1e-6 || t < this.t - 1e-3) {
      // first frame, or a new session: no history to fill
      this.accum = a;
      this.t = t;
      return this.value;
    }
    const dt = Math.min(600, t - this.t);
    // drifting snow starts near 6 m/s and grows fast with the wind (a whiteout gale fills a print in minutes)
    const ws = Math.hypot(e.windX, e.windZ) * (1 + 0.5 * (e.gust || 0));
    const drift = 0.8e-5 * Math.pow(Math.max(0, ws - 6), 1.5);
    this.value += a - this.accum + drift * Math.max(0, dt);
    this.accum = a;
    this.t = t;
    return this.value;
  }
}

export function createSnowSystem(engine: Engine, world: World): SnowSystem {
  const store = new RecordStore();
  const tracks = new Tracks(store, world);
  let tier: SnowTier = snowTier(engine.quality);
  const painter = new Painter(engine.renderer, tier);
  const fillClock = new SnowFill();
  let bus: View['bus'] | null = null;
  let unsub: (() => void) | null = null;
  let view: View | null = null;
  const stats = Object.assign(painter.stats, { records: 0 });

  function publish(): void {
    U.trailTex.value = painter.texture;
    const [w, h] = painter.atlasSize;
    U.trailTexel.value.set(1 / w, 1 / h);
    const [nu, fo, fu, fv] = painter.layout();
    U.trailAtlas.value.set(nu, fo, fu, fv);
    U.trailSize.value = painter.near.size;
    U.trailOn.value = 2;
    const far = painter.far;
    U.trailFar.value.set(far ? far.ox : 0, far ? far.oz : 0, far ? far.size : 256, far ? 1 : 0);
  }
  // Published before any material compiles (the terrain binds this texture at warm-up).
  publish();

  const onSim = (e: SimEvent): void => {
    tracks.onEvent(e, view, fillClock.value);
  };

  const sys: SnowSystem = {
    name: 'snow',
    get fill() {
      return fillClock.value;
    },
    stats,

    update(f: Frame): void {
      const v = (f.view ?? null) as View | null;
      if (!v) return;
      view = v;
      if (v.bus !== bus) {
        unsub?.();
        bus = v.bus;
        unsub = bus.on('sim', onSim);
        store.clear();
        tracks.reset();
        painter.invalidate();
      }
      const fill = fillClock.update(v);
      const frozen = v.mode === 'pause' || v.mode === 'photo';
      const dt = frozen ? 0 : Math.min(0.25, Math.max(0, f.dt));
      if (!frozen) tracks.frame(v, fill, dt);

      // near window: centred a little ahead of the camera, where prints are looked at
      const c = v.camera;
      const lead = painter.near.size * 0.18;
      const cx = c.x - Math.sin(c.yaw) * lead, cz = c.z - Math.cos(c.yaw) * lead;
      painter.update(store, cx, cz, c.x, c.z, fill, tracks.fresh, dt);
      tracks.fresh.length = 0;

      const near = painter.near, far = painter.far;
      U.trailOrigin.value.set(near.ox, near.oz);
      const dN = painter.decrements(near, fill);
      const n0 = dN[0], n1 = dN[1], n2 = dN[2];
      const f0 = far ? painter.decrements(far, fill)[0] : 0;
      U.trailFill.value.set(n0, n1, n2, f0);
      if (far) U.trailFar.value.set(far.ox, far.oz, far.size, 1);
      stats.records = store.count;
    },

    setQuality(q: Quality): void {
      const t = snowTier(q);
      if (t.nearN === tier.nearN && t.farN === tier.farN && t.shadows === tier.shadows) return;
      tier = t;
      painter.build(t);
      publish();
    },

    pressAt(x: number, z: number): number {
      return store.pressAt(x, z, fillClock.value);
    },

    clear(): void {
      store.clear();
      tracks.reset();
      painter.invalidate();
    },

    dispose(): void {
      unsub?.();
      unsub = null;
      if (U.trailTex.value === painter.texture) U.trailOn.value = 0;
      painter.dispose();
    },
  };
  // for tools and benches (reading the atlas back, counting records)
  Object.defineProperty(sys, 'debug', { value: { painter, store, tracks }, enumerable: false });
  return sys;
}
