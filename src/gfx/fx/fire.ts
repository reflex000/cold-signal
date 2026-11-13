// Fires: campfires, the barrel at the wreck and the cabin stove (FireEnt), and any 'fire' emitter
// a placed model declares. For each: flame tongues that lick and lean with the wind, a coal bed,
// embers that rise and swirl downwind, smoke that rises then shears off and fades into the fog,
// steam where the snow melts at a campfire's rim, a flickering light from the pool (hot near, cool
// far; the nearest fire casts shadows on 'high'), and for a campfire the stone ring and wood model
// (KIT's 'campfire' in the stage that matches the fire: laid, burning, embers, dead).
//
// Life of a fire: a match flares at the tinder while a player lights it (PlayerEnt act 'ignite'),
// a failed match gutters out in a wisp; once lit, small flames catch and grow over seconds while
// the simulation's heat ramps up; a gust lays the flames over and dims them, a log thrown on
// sends up sparks and a puff of smoke; dying, the flames shrink to the coals, then the coals fade
// under a thin smoke. Snow or wind killing it: a hiss of steam or a spray of sparks.
// Owner: FX.
import * as THREE from 'three/webgpu';
import type { FireEnt, FireType, SimEvent } from '../../sim/types';
import type { View, ViewEnt } from '../../game/view';
import { hasModel } from '../../models/registry';
import { quota, type FxCtx } from './ctx';
import type { Tongue } from './flame';
import { fireFlicker, noise1, type LightHandle } from './lights';
import { hashU } from './noise';
import { PF } from './particles';

interface Look {
  /** Flame base above the entity's y, metres. */
  base: number;
  /** Fuel bed radius and height above the flame base. */
  bed: number;
  bedDy: number;
  /** Full-heat flame height and tongue half width, metres. */
  H: number;
  W: number;
  tongues: number;
  /** Light at full heat: intensity (candela), range (m). */
  light: number;
  range: number;
  embers: number;
  smoke: number;
  steam: boolean;
  shadow: boolean;
}

const LOOK: Record<FireType | 'prop', Look> = {
  campfire: { base: 0.07, bed: 0.2, bedDy: 0.01, H: 1.05, W: 0.13, tongues: 11, light: 4, range: 12, embers: 1, smoke: 1, steam: true, shadow: true },
  barrel: { base: -0.1, bed: 0.25, bedDy: -0.05, H: 0.8, W: 0.13, tongues: 10, light: 3.7, range: 11, embers: 1, smoke: 1.1, steam: false, shadow: true },
  stove: { base: -0.24, bed: 0.15, bedDy: 0.0, H: 0.3, W: 0.07, tongues: 4, light: 1.8, range: 6, embers: 0, smoke: 0.7, steam: false, shadow: false },
  prop: { base: 0.0, bed: 0.2, bedDy: 0.0, H: 0.8, W: 0.11, tongues: 8, light: 3.5, range: 11, embers: 1, smoke: 1, steam: false, shadow: true },
};

// About 1800 K near the flames, deeper orange where the light runs out.
const HOT = new THREE.Color(1.0, 0.44, 0.15);
const FAR = new THREE.Color(0.92, 0.25, 0.05);
const EMBER_HOT = new THREE.Color(1.0, 0.32, 0.08);
const EMBER_FAR = new THREE.Color(0.85, 0.14, 0.03);
const MATCH = new THREE.Color(1.0, 0.72, 0.42);

interface Fire {
  key: string;
  type: FireType | 'prop';
  look: Look;
  ent: number;
  /** Prop emitter it comes from (no entity), else -1. */
  prop: number;
  x: number; y: number; z: number; yaw: number;
  seed: number;
  lit: boolean;
  heat: number;
  size: number;
  fuel: number;
  embersLeft: number;
  shelter: number;
  /** Smoothed visual heat 0..1 and ember glow 0..1. */
  vh: number;
  glow: number;
  gust: number;
  gustKick: number;
  litAt: number;
  outAt: number;
  outWhy: string;
  feedAt: number;
  matchAt: number;
  matchBy: number;
  failAt: number;
  failWhy: string;
  light: LightHandle;
  model: number;
  stage: number;
  /** Where the stove's light sits (in front of its door) and its smoke leaves (the chimney). */
  front: THREE.Vector3 | null;
  chimney: THREE.Vector3 | null;
  acc: { ember: { v: number }; smoke: { v: number }; steam: { v: number }; spark: { v: number } };
  seen: boolean;
}

const _t: Tongue = { x: 0, y: 0, z: 0, h: 0, w: 0, lx: 0, lz: 0, seed: 0, intensity: 1, alpha: 1, temp: 0, wobble: 1, tr: 1, tg: 1, tb: 1 };
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class FireFx {
  private fires = new Map<string, Fire>();

  constructor(private ctx: FxCtx) {}

  /** Number of fires being drawn (for the bench HUD). */
  get count(): number {
    return this.fires.size;
  }

  /** Tools: the visual state of every fire. */
  debug(): { key: string; type: string; vh: number; glow: number; gust: number; lit: boolean; heat: number; size: number }[] {
    const r = (v: number) => Math.round(v * 100) / 100;
    return [...this.fires.values()].map((f) => ({ key: f.key, type: f.type, vh: r(f.vh), glow: r(f.glow), gust: r(f.gust), lit: f.lit, heat: r(f.heat), size: r(f.size) }));
  }

  onEvent(ev: SimEvent): void {
    const t = this.ctx.time;
    switch (ev.t) {
      case 'fireLit': {
        const f = this.fires.get('e' + ev.id);
        if (f) {
          f.litAt = t;
          f.matchAt = -1;
        }
        break;
      }
      case 'igniteFail': {
        const f = this.fires.get('e' + ev.id);
        if (f) {
          f.failAt = t;
          f.failWhy = ev.why;
        }
        break;
      }
      case 'fireFed': {
        const f = this.fires.get('e' + ev.id);
        if (f) {
          f.feedAt = t;
          this.feedBurst(f, ev.item === 'log' ? 1.4 : 1);
        }
        break;
      }
      case 'fireOut': {
        const f = this.fires.get('e' + ev.id);
        if (f) {
          f.outAt = t;
          f.outWhy = ev.why;
          this.outBurst(f, ev.why);
        }
        break;
      }
      case 'gust':
        for (const f of this.fires.values()) f.gustKick = Math.max(f.gustKick, Math.min(1, ev.strength));
        break;
    }
  }

  update(view: View | null): void {
    const ctx = this.ctx;
    for (const f of this.fires.values()) f.seen = false;
    if (view) {
      for (const e of view.list('fire') as ViewEnt<FireEnt>[]) this.syncEnt(e, view);
    }
    this.syncProps();
    for (const [k, f] of this.fires) {
      if (!f.seen) {
        this.drop(f);
        this.fires.delete(k);
        continue;
      }
      this.step(f, view);
    }
    void ctx;
  }

  // ---------------------------------------------------------------------------------------------
  // Keeping the list
  // ---------------------------------------------------------------------------------------------

  private make(key: string, type: FireType | 'prop', seed: number): Fire {
    const look = LOOK[type];
    const light = this.ctx.lights.acquire('point', 1);
    light.shadow = look.shadow;
    light.color.copy(HOT);
    light.colorFar = FAR.clone();
    const f: Fire = {
      key, type, look, ent: 0, prop: -1, x: 0, y: 0, z: 0, yaw: 0, seed,
      lit: false, heat: 0, size: 0.5, fuel: 0, embersLeft: 0, shelter: 0,
      vh: 0, glow: 0, gust: 0, gustKick: 0,
      litAt: -100, outAt: -100, outWhy: '', feedAt: -100, matchAt: -1, matchBy: 0, failAt: -100, failWhy: '',
      light, model: -1, stage: -1, front: null, chimney: null,
      acc: { ember: { v: 0 }, smoke: { v: 0 }, steam: { v: 0 }, spark: { v: 0 } },
      seen: true,
    };
    this.fires.set(key, f);
    return f;
  }

  private drop(f: Fire): void {
    f.light.release();
    const props = this.ctx.props;
    if (props && f.model >= 0) props.remove(f.model);
    f.model = -1;
  }

  private syncEnt(e: ViewEnt<FireEnt>, view: View): void {
    const key = 'e' + e.id;
    let f = this.fires.get(key);
    const fresh = !f;
    if (!f) {
      f = this.make(key, e.type, (hashU(e.id * 7 + 3) * 1000) | 0);
      f.ent = e.id;
      // a fire that is burning when first seen has been burning a while: no catching phase
      f.vh = e.lit ? e.heat : 0;
      f.glow = e.lit ? 1 : Math.min(1, e.embers / 180);
    }
    f.seen = true;
    if (!f.lit && e.lit && !fresh) {
      if (this.ctx.time - f.litAt > 1) f.litAt = this.ctx.time;
      f.matchAt = -1;
    }
    if (f.lit && !e.lit && this.ctx.time - f.outAt > 1) {
      f.outAt = this.ctx.time;
      f.outWhy = f.outWhy || 'fuel';
    }
    f.type = e.type;
    f.look = LOOK[e.type];
    f.x = e.x; f.y = e.y; f.z = e.z; f.yaw = e.yaw;
    f.lit = e.lit;
    f.heat = e.heat;
    f.size = e.size;
    f.fuel = e.fuel;
    f.embersLeft = e.embers;
    f.shelter = e.shelter;
    // a player striking a match at this fire
    if (!e.lit) {
      let striking = 0;
      for (const p of view.list('player')) {
        if (p.act !== 'ignite' || p.life !== 'alive') continue;
        const d2 = (p.x - e.x) ** 2 + (p.z - e.z) ** 2;
        if (d2 < 2.6 * 2.6) {
          striking = p.id;
          if (f.matchAt < 0 || this.ctx.time - f.matchAt > 1.6) {
            f.matchAt = this.ctx.time - Math.min(p.actT, 1.2);
            f.matchBy = p.id;
            this.strikeBurst(f, p.x, p.z);
          }
          break;
        }
      }
      if (!striking && f.matchAt >= 0 && this.ctx.time - f.matchAt > 1.6) f.matchAt = -1;
    }
    if (e.type === 'stove') this.placeStove(f, view);
    this.syncModel(f);
  }

  private syncProps(): void {
    const props = this.ctx.props;
    if (!props) return;
    const list = props.emitters('fire');
    for (let i = 0; i < list.length; i++) {
      const em = list[i];
      // an entity fire at the same spot owns the visual
      let owned = false;
      for (const f of this.fires.values()) {
        if (f.ent && (f.x - em.position.x) ** 2 + (f.z - em.position.z) ** 2 < 1.2 * 1.2) {
          owned = true;
          break;
        }
      }
      if (owned) continue;
      const key = 'p' + em.prop + ':' + i;
      let f = this.fires.get(key);
      if (!f) {
        f = this.make(key, 'prop', (hashU(em.prop * 13 + i) * 1000) | 0);
        f.prop = em.prop;
        f.vh = 0.8;
        f.glow = 1;
      }
      f.seen = true;
      const strength = typeof em.def.strength === 'number' ? (em.def.strength as number) : 1;
      f.x = em.position.x;
      f.y = em.position.y;
      f.z = em.position.z;
      f.lit = strength > 0.5;
      f.heat = Math.min(1, strength);
      f.size = Math.min(1, em.size / 0.22);
      f.embersLeft = 180 * strength;
      f.shelter = 0.4;
    }
  }

  /** The stove: light in front of its door (toward the room), smoke from the chimney emitter. */
  private placeStove(f: Fire, view: View): void {
    if (f.front && f.chimney) return;
    let cx = f.x, cz = f.z + 1;
    const pois = view.world.pois;
    let best = Infinity;
    for (const p of pois) {
      const d = (p.x - f.x) ** 2 + (p.z - f.z) ** 2;
      if (d < best && d < 30 * 30) {
        best = d;
        cx = p.x;
        cz = p.z;
      }
    }
    const dx = cx - f.x, dz = cz - f.z;
    const l = Math.hypot(dx, dz) || 1;
    f.front = new THREE.Vector3(f.x + (dx / l) * 0.55, f.y + 0.05, f.z + (dz / l) * 0.55);
    const props = this.ctx.props;
    let chim: THREE.Vector3 | null = null;
    if (props) {
      let bd = 6 * 6;
      for (const em of props.emitters('smoke')) {
        const d = (em.position.x - f.x) ** 2 + (em.position.z - f.z) ** 2;
        if (d < bd && em.position.y > f.y + 1) {
          bd = d;
          chim = em.position;
        }
      }
    }
    // no chimney emitter: above the roof over the stove (cabin roofs are about 3.5 m over the floor)
    f.chimney = chim ? chim.clone() : new THREE.Vector3(f.x, f.y + 3.4, f.z);
  }

  private syncModel(f: Fire): void {
    if (f.type !== 'campfire') return;
    const props = this.ctx.props;
    if (!props || !hasModel('campfire')) return;
    const stage = f.lit ? (f.size < 0.12 && f.heat < 0.3 ? 2 : 1) : f.embersLeft > 0.5 ? 2 : f.fuel > 0.5 ? 0 : 3;
    if (stage === f.stage && f.model >= 0) return;
    if (f.model >= 0) props.remove(f.model);
    f.model = props.add({ model: 'campfire', seed: f.seed, x: f.x, y: f.y, z: f.z, yaw: f.yaw, scale: 1 }, { stage });
    f.stage = stage;
  }

  // ---------------------------------------------------------------------------------------------
  // One fire, one frame
  // ---------------------------------------------------------------------------------------------

  private step(f: Fire, view: View | null): void {
    const ctx = this.ctx;
    const t = ctx.time, dt = ctx.dt;
    const L = f.look;
    const budget = ctx.budget;
    const open = 1 - f.shelter;
    // wind on this fire
    const windK = smooth(2, 14, ctx.windSpeed) * open;
    f.gustKick = Math.max(0, f.gustKick - dt * 0.7);
    const gustTarget = Math.min(1, (ctx.gust * smooth(3, 12, ctx.windSpeed) + f.gustKick) * open);
    f.gust += (gustTarget - f.gust) * Math.min(1, dt * (gustTarget > f.gust ? 6 : 1.5));
    const g = f.gust;

    // visual heat: catching after a match, the sim's heat, a dip after feeding, the dying fall
    const age = t - f.litAt;
    const catching = age < 0 ? 0 : age < 0.5 ? 0.06 : 0.06 + 0.32 * smooth(0.5, 6, age);
    const fedDip = t - f.feedAt < 6 ? 1 - 0.28 * Math.exp(-(t - f.feedAt) * 1.6) + 0.12 * smooth(2.5, 4.5, t - f.feedAt) * (1 - smooth(4.5, 6, t - f.feedAt)) : 1;
    const target = f.lit ? Math.min(1, Math.max(f.heat, catching) * fedDip) : 0;
    const fall = f.outWhy === 'wind' ? 5 : f.outWhy === 'snow' ? 2.2 : 0.45;
    f.vh += (target - f.vh) * Math.min(1, dt * (target > f.vh ? 1.4 : fall));
    if (f.vh < 0.002) f.vh = 0;
    const emberFrac = f.lit ? 1 : Math.min(1, f.embersLeft / 180);
    const glowTarget = f.lit ? 0.55 + 0.45 * f.vh : emberFrac * (f.outWhy === 'snow' ? 0.5 : 0.85);
    f.glow += (glowTarget - f.glow) * Math.min(1, dt * 0.8);
    const vh = f.vh;
    const flick = fireFlicker(t, f.seed, g);

    // ---- flames ----
    const bx = f.x, by = f.y + L.base, bz = f.z;
    // a healthy fire's flames stand a good deal higher than its stack of wood
    const H = L.H * (0.28 + 0.72 * vh) * (0.75 + 0.25 * Math.max(0.15, f.size)) * (1 - 0.42 * g) * (0.82 + 0.18 * flick);
    const wl = ctx.windSpeed > 0.01 ? 1 / ctx.windSpeed : 0;
    const leanK = Math.min(1.5, (ctx.windSpeed * open) / 7) * (1 + g * 0.9);
    const lx = ctx.windX * wl * leanK, lz = ctx.windZ * wl * leanK;
    if (vh > 0.004) {
      const n = L.tongues;
      const spread = L.bed * (0.55 + 0.45 * Math.max(0.2, f.size));
      for (let j = 0; j < n; j++) {
        const hj = hashU(f.seed * 31 + j * 17);
        const hk = hashU(f.seed * 57 + j * 29 + 5);
        const a = f.seed * 0.37 + j * 2.39996;
        const edge = j >= n - 2; // low, wide licks at the edge of the bed
        // a sunflower spread over the bed: tall in the middle, shorter toward the rim
        const rn = j === 0 ? 0 : edge ? 1 : Math.sqrt(j / (n - 2)) * (0.85 + 0.3 * hj);
        const r = spread * Math.min(1.1, rn);
        // each tongue breathes on its own: flare-ups and slumps
        const dance = 0.62 + 0.55 * noise1(t * (1.4 + hk * 1.3) + j * 3.7, f.seed + j);
        const hf = j === 0 ? 1 : edge ? 0.3 + 0.15 * hk : (1 - 0.42 * rn) * (0.78 + 0.34 * hj);
        _t.x = bx + Math.cos(a) * r;
        _t.y = by + (edge ? 0.0 : 0.01);
        _t.z = bz + Math.sin(a) * r;
        _t.h = H * hf * dance;
        _t.w = L.W * (0.7 + 0.55 * hk) * (j === 0 ? 1.3 : edge ? 1.15 : 1) * (0.55 + 0.45 * Math.min(1, vh * 1.6));
        _t.lx = lx * (0.8 + 0.4 * hk);
        _t.lz = lz * (0.8 + 0.4 * hj);
        _t.seed = (f.seed % 97) * 0.13 + j * 1.618;
        // many tongues overlap (additive): each one is a little dimmer than a lone flame
        _t.intensity = (0.4 + 0.45 * vh) * (0.85 + 0.25 * flick) * (j === 0 ? 1.1 : 1);
        _t.alpha = Math.min(1, vh * 6) * (edge ? 0.8 : 1);
        // a small, starved fire burns cooler and redder
        _t.temp = -0.2 * (1 - smooth(0.05, 0.5, vh)) + (j === 0 ? 0.04 : 0);
        _t.wobble = 0.7 + 0.6 * g + 0.3 * hk;
        _t.tr = 1; _t.tg = 1; _t.tb = 1;
        ctx.flames.add(_t);
      }
    }

    // ---- the match ----
    let matchK = 0;
    let mx = 0, my = 0, mz = 0;
    if (f.matchAt >= 0 && !f.lit) {
      const ma = t - f.matchAt;
      const failing = t - f.failAt < 1 ? smooth(0, 0.5, t - f.failAt) : 0;
      matchK = (ma < 0.15 ? 2.2 : 1) * (1 - failing) * (ma > 3 ? 0 : 1);
      if (view) {
        const p = view.ents.get(f.matchBy);
        const dx = p ? p.x - bx : 1, dz = p ? p.z - bz : 0;
        const l = Math.hypot(dx, dz) || 1;
        mx = bx + (dx / l) * 0.14;
        mz = bz + (dz / l) * 0.14;
        my = by + 0.05;
      }
      if (matchK > 0) {
        const blown = f.failWhy === 'wind' ? failing : 0;
        _t.x = mx; _t.y = my; _t.z = mz;
        _t.h = 0.05 * (ma < 0.15 ? 1.8 : 1) * (0.85 + 0.15 * flick);
        _t.w = 0.016;
        _t.lx = lx * 0.4 + (ctx.windX * wl) * blown * 2;
        _t.lz = lz * 0.4 + (ctx.windZ * wl) * blown * 2;
        _t.seed = 7.7;
        _t.intensity = 0.9 * matchK;
        _t.alpha = 1;
        _t.temp = 0.1;
        _t.wobble = 0.4;
        _t.tr = 1; _t.tg = 1; _t.tb = 1;
        ctx.flames.add(_t);
      }
    }
    // a failed match: a wisp of smoke as it goes out
    if (t - f.failAt < 0.05 && t - f.failAt >= 0 && f.failAt > 0) this.wisp(mx || bx, (my || by) + 0.05, mz || bz, 3);

    // ---- coal bed ----
    if (f.glow > 0.01) {
      ctx.coals.add({
        x: bx, y: f.y + L.base + L.bedDy, z: bz,
        radius: L.bed * (f.type === 'campfire' ? 1.15 : 1),
        glow: (1.4 + 3.2 * f.glow) * (1 + g * 0.7) * (0.9 + 0.1 * flick),
        live: Math.min(1, 0.2 + f.glow),
        seed: (f.seed % 50) * 0.1,
      });
    }

    // ---- light ----
    const lh = f.light;
    const emberLight = f.lit ? 0 : 1.4 * emberFrac * emberFrac;
    let intensity = L.light * (0.2 + 0.8 * vh) * flick + emberLight;
    // the light sits in the upper flames, clear of the wood: a point source inside the stack
    // would burn white hot spots onto the sticks
    let px = bx + lx * 0.35 * H, py = by + 0.32 + 0.55 * H, pz = bz + lz * 0.35 * H;
    // the flame's centre wanders a little: the shadows breathe
    px += (noise1(t * 3.1, f.seed + 3) - 0.5) * 0.06;
    pz += (noise1(t * 2.7, f.seed + 9) - 0.5) * 0.06;
    if (vh < 0.05) {
      lh.color.copy(EMBER_HOT);
      lh.colorFar!.copy(EMBER_FAR);
      py = by + 0.15;
    } else {
      lh.color.copy(HOT);
      lh.colorFar!.copy(FAR);
    }
    if (matchK > 0) {
      // the match is the only light until the fire takes
      const mk = 2.2 * matchK * (0.9 + 0.1 * flick);
      if (mk > intensity) {
        intensity = mk;
        px = mx; py = my + 0.05; pz = mz;
        lh.color.copy(MATCH);
        lh.colorFar!.copy(HOT);
      }
    }
    if (f.type === 'stove' && f.front) {
      px = f.front.x;
      py = f.front.y + 0.1 * vh;
      pz = f.front.z;
    }
    lh.position.set(px, py, pz);
    lh.intensity = intensity;
    lh.range = L.range * (0.45 + 0.55 * Math.max(vh, matchK > 0 ? 0.2 : 0, emberFrac * 0.3));
    lh.on = intensity > 0.03;

    // ---- particles ----
    if (dt <= 0) return;
    // embers rising from the bed, more in a gust and after feeding
    if (L.embers > 0) {
      const fed = t - f.feedAt < 1.5 ? 18 : 0;
      const rate = (vh > 0.02 ? 4 + 16 * vh : f.glow * 1.2) * (1 + g * 2.5) * budget * L.embers + fed * budget;
      const n = Math.min(12, quota(f.acc.ember, rate, dt));
      for (let i = 0; i < n; i++) this.ember(f, bx, by, bz, vh, g);
    }
    // smoke: thick while catching, after feeding and when killed; thin from embers
    {
      let rate = vh > 0.02 ? 3 + 9 * vh : 0;
      let thick = 0;
      if (f.lit && age < 25) {
        rate += 3.5 * (1 - age / 25);
        thick = Math.max(thick, 1 - age / 25);
      }
      if (t - f.feedAt < 5) {
        rate += 3 * (1 - (t - f.feedAt) / 5);
        thick = Math.max(thick, 0.8 * (1 - (t - f.feedAt) / 5));
      }
      if (!f.lit && t - f.outAt < 8) {
        const k = 1 - (t - f.outAt) / 8;
        rate += (f.outWhy === 'snow' ? 7 : f.outWhy === 'wind' ? 3 : 2.5) * k;
        thick = Math.max(thick, k * (f.outWhy === 'fuel' ? 0.3 : 0.9));
      }
      if (!f.lit && f.glow > 0.02) rate += 1.6 * f.glow;
      rate += ctx.snowfall * 2 * vh;
      rate *= L.smoke * budget * (1 + 1.2 * smooth(4, 16, ctx.windSpeed * (1 - f.shelter * 0.7)));
      const n = Math.min(8, quota(f.acc.smoke, rate, dt));
      for (let i = 0; i < n; i++) this.smoke(f, bx, by, bz, H, vh, thick);
    }
    // steam where the snow melts at the rim of a campfire
    if (L.steam && (vh > 0.02 || f.glow > 0.2)) {
      const fresh = f.lit ? Math.max(0, 1 - age / 90) : 0;
      const rate = (0.5 + 2.2 * ctx.snowfall + 3 * fresh) * Math.max(vh, f.glow * 0.4) * budget;
      const n = Math.min(4, quota(f.acc.steam, rate, dt));
      for (let i = 0; i < n; i++) this.steam(f, 0.42 + 0.14 * ctx.rand.next());
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------------------------

  private ember(f: Fire, bx: number, by: number, bz: number, vh: number, g: number): void {
    const P = this.ctx.glow;
    const R = this.ctx.rand;
    const s = P.spec();
    const a = R.next() * Math.PI * 2;
    const r = Math.sqrt(R.next()) * f.look.bed * 0.8;
    s.x = bx + Math.cos(a) * r;
    s.y = by + 0.04 + R.next() * 0.25 * (0.4 + vh);
    s.z = bz + Math.sin(a) * r;
    const up = (1.1 + R.next() * 2.4) * (0.45 + 0.75 * vh);
    s.vx = R.sym(0.35) + this.ctx.windX * 0.15 * g;
    s.vy = up;
    s.vz = R.sym(0.35) + this.ctx.windZ * 0.15 * g;
    // most die within a metre or two; a few ride the plume higher
    const long = R.next() < 0.15;
    s.life = long ? 2 + R.next() * 1.6 : 0.6 + R.next() * 1.3;
    s.s0 = 0.004 + R.next() * 0.008;
    s.s1 = s.s0 * 0.6;
    s.op = 25 + R.next() * 45;
    s.gy = f.y - 0.5;
    s.y0 = by;
    s.grav = 0.5;
    s.lift = 1.1 * (0.5 + vh);
    s.tau = 0.6;
    s.drag = 0.45;
    s.shear = 0.8;
    s.turb = 2.6;
    s.fin = 0.02;
    s.fout = 0.4;
    s.flags = PF.COOL | PF.TWINKLE;
    s.ex = 0.022;
    P.emit(s);
  }

  private smoke(f: Fire, bx: number, by: number, bz: number, H: number, vh: number, thick: number): void {
    const ctx = this.ctx;
    const P = ctx.puffs;
    const R = ctx.rand;
    const s = P.spec();
    let sx = bx, sy = by + 0.15 + 0.55 * H, sz = bz;
    if (f.type === 'barrel') sy = by + 0.25 + 0.55 * H;
    if (f.type === 'stove' && f.chimney) {
      sx = f.chimney.x;
      sy = f.chimney.y;
      sz = f.chimney.z;
    }
    // in a strong wind the plume never rises: it is pressed into a low, denser streak
    const windy = smooth(4, 16, ctx.windSpeed * (1 - f.shelter * 0.7));
    s.x = sx + R.sym(0.07);
    s.y = sy + R.sym(0.05) - windy * 0.25 * H;
    s.z = sz + R.sym(0.07);
    s.vx = R.sym(0.12) + ctx.windX * 0.3 * windy;
    s.vy = (0.55 + R.next() * 0.35 + vh * 0.5) * (1 - 0.6 * windy);
    s.vz = R.sym(0.12) + ctx.windZ * 0.3 * windy;
    s.life = (6 + R.next() * 5) * (1 - thick * 0.15) * (1 - 0.4 * windy);
    s.s0 = (0.07 + R.next() * 0.06) * (1 + windy);
    s.s1 = (0.7 + R.next() * 0.6) * (1 + thick * 0.25) * (1 + windy * 0.4);
    s.grow = 0.55 - windy * 0.15;
    s.rot = R.next() * 6.283;
    s.spin = R.sym(0.35);
    // thin wood smoke is blue-grey; thick smoke from damp wood or a smothered fire is warmer grey
    const k = 0.62 - thick * 0.14;
    s.r = k;
    s.g = k + 0.015 - thick * 0.01;
    s.b = k + 0.06 - thick * 0.05;
    s.op = (0.07 + R.next() * 0.06) * (1 + thick * 1.5) * (1 + windy * 1.4) * (f.type === 'stove' ? 0.8 : 1);
    s.gy = ctx.ground(sx, sz, sy);
    s.y0 = sy;
    s.lift = (0.7 + vh * 0.5) * (1 - 0.7 * windy);
    s.tau = 2.6;
    s.drag = 0.1;
    s.shear = 0.55;
    s.turb = 0.32;
    s.fin = 0.06;
    s.fout = 0.62;
    s.ex = 0;
    P.emit(s);
  }

  private steam(f: Fire, ring: number): void {
    const ctx = this.ctx;
    const P = ctx.puffs;
    const R = ctx.rand;
    const s = P.spec();
    const a = R.next() * Math.PI * 2;
    s.x = f.x + Math.cos(a) * ring;
    s.z = f.z + Math.sin(a) * ring;
    s.y = f.y + 0.04;
    // drawn in and up by the fire's draught
    s.vx = -Math.cos(a) * 0.12;
    s.vz = -Math.sin(a) * 0.12;
    s.vy = 0.3 + R.next() * 0.3;
    s.life = 1.1 + R.next() * 1.4;
    s.s0 = 0.035 + R.next() * 0.03;
    s.s1 = 0.2 + R.next() * 0.16;
    s.grow = 0.7;
    s.rot = R.next() * 6.283;
    s.spin = R.sym(0.6);
    s.r = 0.92; s.g = 0.93; s.b = 0.95;
    s.op = 0.09 + R.next() * 0.08;
    s.gy = f.y;
    s.y0 = f.y;
    s.lift = 0.5;
    s.tau = 1;
    s.drag = 0.5;
    s.shear = 0.3;
    s.turb = 0.3;
    s.fin = 0.15;
    s.fout = 0.6;
    s.ex = 1;
    P.emit(s);
  }

  /** A few small grey puffs (a match going out, a snuffed wick). */
  private wisp(x: number, y: number, z: number, n: number): void {
    const P = this.ctx.puffs;
    const R = this.ctx.rand;
    for (let i = 0; i < n; i++) {
      const s = P.spec();
      s.x = x + R.sym(0.02); s.y = y + i * 0.03; s.z = z + R.sym(0.02);
      s.vy = 0.25 + R.next() * 0.2;
      s.life = 1.6 + R.next();
      s.s0 = 0.02; s.s1 = 0.12 + R.next() * 0.06; s.grow = 0.6;
      s.rot = R.next() * 6.283; s.spin = R.sym(0.8);
      s.r = s.g = 0.7; s.b = 0.74;
      s.op = 0.22;
      s.y0 = y;
      s.drag = 0.6; s.shear = 0.4; s.turb = 0.4; s.lift = 0.2;
      s.fin = 0.1; s.fout = 0.7;
      s.ex = 1;
      P.emit(s);
    }
  }

  /** Sparks and a sulphur puff when a match is struck. */
  private strikeBurst(f: Fire, px: number, pz: number): void {
    const ctx = this.ctx;
    const dx = px - f.x, dz = pz - f.z;
    const l = Math.hypot(dx, dz) || 1;
    const x = f.x + (dx / l) * 0.14, z = f.z + (dz / l) * 0.14, y = f.y + f.look.base + 0.05;
    const R = ctx.rand;
    for (let i = 0; i < 7; i++) {
      const s = ctx.glow.spec();
      s.x = x; s.y = y; s.z = z;
      s.vx = R.sym(0.9); s.vy = 0.4 + R.next() * 1.2; s.vz = R.sym(0.9);
      s.life = 0.15 + R.next() * 0.3;
      s.s0 = 0.003; s.s1 = 0.002;
      s.op = 60;
      s.r = 1; s.g = 0.75; s.b = 0.4;
      s.grav = 4;
      s.flags = PF.COOL;
      s.ex = 0.03;
      ctx.glow.emit(s);
    }
    this.wisp(x, y + 0.03, z, 2);
  }

  /** Wood thrown on: sparks and embers fly, a puff of smoke. */
  private feedBurst(f: Fire, k: number): void {
    const ctx = this.ctx;
    const R = ctx.rand;
    const bx = f.x, by = f.y + f.look.base, bz = f.z;
    const n = Math.round((14 + 16 * f.vh) * k * Math.max(0.4, ctx.budget));
    for (let i = 0; i < n; i++) {
      const s = ctx.glow.spec();
      const a = R.next() * Math.PI * 2;
      const sp = 0.6 + R.next() * 1.8;
      s.x = bx + R.sym(0.1); s.y = by + 0.1; s.z = bz + R.sym(0.1);
      s.vx = Math.cos(a) * sp * 0.6; s.vy = 1.8 + R.next() * 3.2; s.vz = Math.sin(a) * sp * 0.6;
      s.life = 0.5 + R.next() * 1.6;
      s.s0 = 0.005 + R.next() * 0.007; s.s1 = s.s0 * 0.5;
      s.op = 40 + R.next() * 50;
      s.gy = f.y; s.y0 = by;
      s.grav = 2.2; s.lift = 0.8; s.tau = 0.5;
      s.drag = 0.3; s.shear = 0.6; s.turb = 2;
      s.fin = 0.01; s.fout = 0.4;
      s.flags = PF.COOL | PF.TWINKLE;
      s.ex = 0.04;
      ctx.glow.emit(s);
    }
    for (let i = 0; i < 3; i++) this.smoke(f, bx, by - 0.1, bz, 0.3, 0.2, 0.9);
  }

  /** The fire killed: steam and hiss under snow, a spray of embers in the wind. */
  private outBurst(f: Fire, why: string): void {
    const ctx = this.ctx;
    const R = ctx.rand;
    const bx = f.x, by = f.y + f.look.base, bz = f.z;
    if (why === 'snow') {
      for (let i = 0; i < 10 * Math.max(0.5, ctx.budget); i++) {
        const s = ctx.puffs.spec();
        s.x = bx + R.sym(0.15); s.y = by + 0.05 + R.next() * 0.1; s.z = bz + R.sym(0.15);
        s.vx = R.sym(0.2); s.vy = 0.7 + R.next() * 0.6; s.vz = R.sym(0.2);
        s.life = 2 + R.next() * 2;
        s.s0 = 0.08; s.s1 = 0.5 + R.next() * 0.3; s.grow = 0.5;
        s.rot = R.next() * 6.283; s.spin = R.sym(0.5);
        s.r = 0.88; s.g = 0.89; s.b = 0.92;
        s.op = 0.25;
        s.y0 = by; s.gy = f.y;
        s.lift = 0.4; s.tau = 1.5; s.drag = 0.3; s.shear = 0.5; s.turb = 0.4;
        s.fin = 0.05; s.fout = 0.6; s.ex = 1;
        ctx.puffs.emit(s);
      }
    } else if (why === 'wind') {
      for (let i = 0; i < 18 * Math.max(0.5, ctx.budget); i++) {
        const s = ctx.glow.spec();
        s.x = bx + R.sym(0.15); s.y = by + 0.1 + R.next() * 0.2; s.z = bz + R.sym(0.15);
        s.vx = ctx.windX * (0.6 + R.next() * 0.6); s.vy = 0.5 + R.next(); s.vz = ctx.windZ * (0.6 + R.next() * 0.6);
        s.life = 0.6 + R.next() * 1.2;
        s.s0 = 0.006; s.s1 = 0.003;
        s.op = 35 + R.next() * 30;
        s.gy = f.y; s.y0 = by;
        s.grav = 0.8; s.drag = 1.2; s.turb = 2.5;
        s.fin = 0.01; s.fout = 0.5;
        s.flags = PF.COOL | PF.TWINKLE;
        s.ex = 0.04;
        ctx.glow.emit(s);
      }
    }
  }

  dispose(): void {
    for (const f of this.fires.values()) this.drop(f);
    this.fires.clear();
  }
}
