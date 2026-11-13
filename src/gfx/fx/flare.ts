// Signal flares (FlareEnt). In flight: a fierce red point with a short jet, a trail of sparks and
// thin smoke, and a red light that sweeps the slope below. On the ground: a magenta-red light over
// the snow that sputters, a white-hot core in a small red jet, sparks spilling round it, steam
// from the melting snow and dense pink-grey smoke drifting low downwind. In its last seconds it
// sputters and dies; a last wisp of smoke rises from the casing.
// Owner: FX.
import * as THREE from 'three/webgpu';
import type { FlareEnt, SimEvent } from '../../sim/types';
import type { View, ViewEnt } from '../../game/view';
import { quota, type FxCtx } from './ctx';
import type { Tongue } from './flame';
import { noise1, type LightHandle } from './lights';
import { hashU } from './noise';
import { PF } from './particles';

const RED = new THREE.Color(1.0, 0.12, 0.2);
const RED_FAR = new THREE.Color(1.0, 0.05, 0.13);

interface Flare {
  id: number;
  seed: number;
  light: LightHandle;
  x: number; y: number; z: number;
  has: boolean;
  out: number; // time it went out, -1 while burning
  acc: { spark: { v: number }; smoke: { v: number }; steam: { v: number } };
  seen: boolean;
}

const _t: Tongue = { x: 0, y: 0, z: 0, h: 0, w: 0, lx: 0, lz: 0, seed: 0, intensity: 1, alpha: 1, temp: 0, wobble: 1, tr: 1, tg: 0.3, tb: 0.42 };

export class FlareFx {
  private flares = new Map<number, Flare>();

  constructor(private ctx: FxCtx) {}

  get count(): number {
    return this.flares.size;
  }

  onEvent(ev: SimEvent, view: View | null): void {
    if (ev.t === 'flareShot') {
      // the gun's own flash and a puff at the shooter's hand
      const p = view?.ents.get(ev.by);
      const fl = view?.ents.get(ev.id) as ViewEnt<FlareEnt> | undefined;
      const x = fl ? fl.x : p ? p.x : 0, y = fl ? fl.y : p ? p.y + 1.4 : 0, z = fl ? fl.z : p ? p.z : 0;
      if (fl || p) this.gunPuff(x, y, z, fl ? fl.vx : 0, fl ? fl.vy : 1, fl ? fl.vz : 0);
    } else if (ev.t === 'flareOut') {
      const f = this.flares.get(ev.id);
      if (f) this.wisp(f);
    }
  }

  update(view: View | null): void {
    for (const f of this.flares.values()) f.seen = false;
    if (view) for (const e of view.list('flare') as ViewEnt<FlareEnt>[]) this.step(e);
    for (const [id, f] of this.flares) {
      if (!f.seen) {
        f.light.release();
        this.flares.delete(id);
      }
    }
  }

  private step(e: ViewEnt<FlareEnt>): void {
    const ctx = this.ctx;
    const t = ctx.time, dt = ctx.dt;
    let f = this.flares.get(e.id);
    if (!f) {
      const light = ctx.lights.acquire('point', 1.5);
      light.color.copy(RED);
      light.colorFar = RED_FAR.clone();
      f = { id: e.id, seed: (hashU(e.id * 5 + 1) * 1000) | 0, light, x: e.x, y: e.y, z: e.z, has: false, out: -1, acc: { spark: { v: 0 }, smoke: { v: 0 }, steam: { v: 0 } }, seen: true };
      this.flares.set(e.id, f);
    }
    f.seen = true;
    const burning = e.life > 0;
    if (!burning && f.out < 0) {
      f.out = t;
      this.wisp(f);
    }
    if (burning) f.out = -1;
    const px = f.has ? f.x : e.x, py = f.has ? f.y : e.y, pz = f.has ? f.z : e.z;
    f.x = e.x; f.y = e.y; f.z = e.z;
    f.has = true;
    const lh = f.light;
    if (!burning) {
      lh.on = false;
      return;
    }
    // sputter: a fierce steady burn with stumbles, worse at the end
    const end = Math.min(1, e.life / 4);
    const stumble = Math.max(0, noise1(t * 4.7, f.seed) - 0.72) * 2.6;
    const sp = (0.82 + 0.18 * noise1(t * 13, f.seed + 7) + 0.1 * (noise1(t * 29, f.seed + 3) - 0.5)) * (1 - stumble * (0.5 + 0.5 * (1 - end))) * (0.25 + 0.75 * end);
    const k = Math.max(0.05, sp);
    const flying = !e.landed;
    const hx = e.x, hy = e.y + (flying ? 0 : 0.03), hz = e.z;

    // the head: a white-hot core and a short jet (up on the ground, trailing in flight)
    {
      const s = ctx.glow.spec();
      s.x = hx; s.y = hy + (flying ? 0 : 0.02); s.z = hz;
      s.life = Math.max(0.02, dt * 1.5);
      s.s0 = s.s1 = flying ? 0.06 : 0.05;
      s.op = (flying ? 220 : 180) * k;
      s.r = 1; s.g = 0.55; s.b = 0.6;
      s.fin = 0.001; s.fout = 0.001;
      ctx.glow.emit(s);
      const v = Math.hypot(e.vx, e.vy, e.vz);
      _t.x = hx; _t.y = hy; _t.z = hz;
      if (flying && v > 0.5) {
        // trailing jet: lean the tongue against the motion
        const iy = Math.max(0.08, -e.vy / v + 0.15);
        _t.lx = (-e.vx / v) / iy;
        _t.lz = (-e.vz / v) / iy;
        _t.h = 0.22;
      } else {
        _t.lx = ctx.windX * 0.04;
        _t.lz = ctx.windZ * 0.04;
        _t.h = 0.24 * (0.8 + 0.4 * k);
      }
      _t.w = 0.045;
      _t.seed = f.seed * 0.01;
      _t.intensity = 1.6 * k;
      _t.alpha = 1;
      _t.temp = 0.12;
      _t.wobble = 0.8;
      ctx.flames.add(_t);
    }

    // the light: sweeps the slope in flight, lies red over the snow when down
    lh.position.set(hx, hy + (flying ? 0 : 0.4), hz);
    lh.intensity = (flying ? 60 : 30) * k;
    lh.range = flying ? 45 : 24;
    lh.on = true;

    if (dt <= 0) return;
    const R = ctx.rand;
    const budget = ctx.budget;
    // sparks: along the trail in flight, spilling round the head on the ground
    {
      const n = Math.min(10, quota(f.acc.spark, (flying ? 70 : 26) * budget * (0.4 + 0.6 * k), dt));
      for (let i = 0; i < n; i++) {
        const u = R.next();
        const s = ctx.glow.spec();
        s.x = px + (hx - px) * u; s.y = py + (hy - py) * u; s.z = pz + (hz - pz) * u;
        if (flying) {
          s.vx = e.vx * 0.2 + R.sym(0.6); s.vy = e.vy * 0.2 + R.sym(0.6); s.vz = e.vz * 0.2 + R.sym(0.6);
          s.life = 0.3 + R.next() * 0.5;
        } else {
          const a = R.next() * Math.PI * 2;
          const sp2 = 0.4 + R.next() * 1.3;
          s.vx = Math.cos(a) * sp2; s.vy = 0.8 + R.next() * 1.6; s.vz = Math.sin(a) * sp2;
          s.life = 0.25 + R.next() * 0.45;
        }
        s.s0 = 0.004 + R.next() * 0.004; s.s1 = 0.002;
        s.op = 45 + R.next() * 50;
        s.r = 1; s.g = 0.35; s.b = 0.4;
        s.gy = flying ? -1e9 : e.y; s.y0 = s.y;
        s.grav = 5; s.drag = 0.4;
        s.fin = 0.01; s.fout = 0.5;
        s.flags = PF.BOUNCE;
        s.ex = 0.03;
        ctx.glow.emit(s);
      }
    }
    // smoke: a thin trail in flight; dense, low and drifting on the ground
    {
      const n = Math.min(6, quota(f.acc.smoke, (flying ? 16 : 11) * budget * (0.5 + 0.5 * k), dt));
      for (let i = 0; i < n; i++) {
        const u = R.next();
        const s = ctx.puffs.spec();
        s.x = px + (hx - px) * u + R.sym(0.03);
        s.y = py + (hy - py) * u + (flying ? 0 : 0.08);
        s.z = pz + (hz - pz) * u + R.sym(0.03);
        s.vx = R.sym(0.15); s.vy = flying ? 0 : 0.3 + R.next() * 0.3; s.vz = R.sym(0.15);
        s.life = flying ? 3 + R.next() * 2 : 8 + R.next() * 5;
        s.s0 = flying ? 0.05 : 0.06;
        s.s1 = flying ? 0.5 + R.next() * 0.3 : 0.9 + R.next() * 0.7;
        s.grow = 0.55;
        s.rot = R.next() * 6.283; s.spin = R.sym(0.3);
        s.r = 0.8; s.g = 0.72; s.b = 0.74;
        s.op = flying ? 0.12 : 0.13 + R.next() * 0.08;
        s.gy = ctx.ground(s.x, s.z, s.y); s.y0 = s.y;
        // flare smoke is dense: it hardly rises and rolls away downwind
        s.lift = flying ? 0 : 0.25; s.tau = 2;
        s.drag = flying ? 0.5 : 0.25; s.shear = 0.5; s.turb = 0.35;
        // thin where it leaves the flare (the head stays readable), thickest a metre on
        s.fin = flying ? 0.05 : 0.14; s.fout = 0.55;
        s.flags = flying ? 0 : PF.HUG;
        s.ex = 0;
        ctx.puffs.emit(s);
      }
    }
    // steam from the snow it lies in
    if (!flying) {
      const n = Math.min(2, quota(f.acc.steam, 1.4 * budget, dt));
      for (let i = 0; i < n; i++) {
        const s = ctx.puffs.spec();
        s.x = hx + R.sym(0.08); s.y = e.y + 0.02; s.z = hz + R.sym(0.08);
        s.vy = 0.35 + R.next() * 0.3;
        s.life = 1 + R.next();
        s.s0 = 0.03; s.s1 = 0.22 + R.next() * 0.1; s.grow = 0.7;
        s.rot = R.next() * 6.283; s.spin = R.sym(0.6);
        s.r = 0.92; s.g = 0.92; s.b = 0.94;
        s.op = 0.12;
        s.y0 = e.y; s.gy = e.y;
        s.lift = 0.5; s.drag = 0.6; s.shear = 0.3; s.turb = 0.3;
        s.fin = 0.15; s.fout = 0.6; s.ex = 1;
        ctx.puffs.emit(s);
      }
    }
  }

  /** The gun's flash: a bright red pop, sparks and a puff of smoke. */
  private gunPuff(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const ctx = this.ctx;
    const R = ctx.rand;
    const v = Math.hypot(vx, vy, vz) || 1;
    const dx = vx / v, dy = vy / v, dz = vz / v;
    const s0 = ctx.glow.spec();
    s0.x = x; s0.y = y; s0.z = z;
    s0.life = 0.08; s0.s0 = 0.09; s0.s1 = 0.14;
    s0.op = 160; s0.r = 1; s0.g = 0.4; s0.b = 0.35;
    s0.fin = 0.001; s0.fout = 0.9;
    ctx.glow.emit(s0);
    for (let i = 0; i < 4; i++) {
      const s = ctx.puffs.spec();
      s.x = x + dx * 0.1 * i; s.y = y + dy * 0.1 * i; s.z = z + dz * 0.1 * i;
      s.vx = dx * (1.2 - i * 0.25) + R.sym(0.1); s.vy = dy * (1.2 - i * 0.25) + 0.1; s.vz = dz * (1.2 - i * 0.25) + R.sym(0.1);
      s.life = 1.6 + R.next() * 1.2;
      s.s0 = 0.05; s.s1 = 0.35 + R.next() * 0.2; s.grow = 0.5;
      s.rot = R.next() * 6.283; s.spin = R.sym(0.6);
      s.r = 0.78; s.g = 0.74; s.b = 0.75;
      s.op = 0.28;
      s.y0 = y;
      s.drag = 1.4; s.shear = 0.4; s.turb = 0.4;
      s.fin = 0.03; s.fout = 0.7;
      ctx.puffs.emit(s);
    }
    const h = ctx.lights.acquire('point', 8);
    h.fadeIn = 0;
    h.color.setRGB(1, 0.25, 0.22);
    h.position.set(x, y, z);
    h.intensity = 30;
    h.range = 10;
    h.on = true;
    this.flashes.push({ h, until: ctx.time + 0.07 });
  }

  private flashes: { h: LightHandle; until: number }[] = [];

  /** Release the gun flashes whose time is up (called every frame by the fx system). */
  tickFlashes(): void {
    const t = this.ctx.time;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      if (t >= this.flashes[i].until) {
        this.flashes[i].h.release();
        this.flashes.splice(i, 1);
      }
    }
  }

  private wisp(f: Flare): void {
    const ctx = this.ctx;
    const R = ctx.rand;
    for (let i = 0; i < 6; i++) {
      const s = ctx.puffs.spec();
      s.x = f.x + R.sym(0.03); s.y = f.y + 0.05 + i * 0.04; s.z = f.z + R.sym(0.03);
      s.vy = 0.3 + R.next() * 0.25;
      s.life = 3 + R.next() * 2;
      s.s0 = 0.04; s.s1 = 0.4 + R.next() * 0.2; s.grow = 0.6;
      s.rot = R.next() * 6.283; s.spin = R.sym(0.4);
      s.r = 0.7; s.g = 0.68; s.b = 0.7;
      s.op = 0.2;
      s.y0 = f.y; s.gy = f.y;
      s.lift = 0.3; s.drag = 0.4; s.shear = 0.5; s.turb = 0.3;
      s.fin = 0.1; s.fout = 0.7;
      ctx.puffs.emit(s);
    }
  }

  dispose(): void {
    for (const f of this.flares.values()) f.light.release();
    this.flares.clear();
    for (const fl of this.flashes) fl.h.release();
    this.flashes.length = 0;
  }
}
