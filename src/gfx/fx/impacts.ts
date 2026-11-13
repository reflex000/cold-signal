// Small things, driven by simulation events: the rifle's muzzle flash with its light and smoke,
// what a bullet kicks up where it lands, chips and sparks from the axe, snow puffs from boots in
// deep snow, hard landings, bodies and logs dropped in the snow, things thrown down, wolves running
// through drifts, and the splash and ice shards when the lake ice gives way.
// Every burst also exists as a call (FxSystem.burst) for modules that know a better position.
// Owner: FX.
import * as THREE from 'three/webgpu';
import type { LogEnt, PickupEnt, SimEvent, WolfEnt } from '../../sim/types';
import type { View, ViewEnt } from '../../game/view';
import type { FxCtx } from './ctx';
import type { Tongue } from './flame';
import type { LightHandle } from './lights';
import { PF } from './particles';

export type BurstKind = 'muzzle' | 'snow' | 'step' | 'chips' | 'sparks' | 'splash' | 'shards' | 'steam' | 'smoke';

const _t: Tongue = { x: 0, y: 0, z: 0, h: 0, w: 0, lx: 0, lz: 0, seed: 0, intensity: 1, alpha: 1, temp: 0.2, wobble: 0.3, tr: 1, tg: 1, tb: 1 };
const _e = new THREE.Euler();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();

interface Flash {
  h: LightHandle;
  until: number;
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  at: number;
}

export class ImpactFx {
  private flashes: Flash[] = [];
  private known = new Set<number>();
  private primed = false;
  private wolfAcc = new Map<number, number>();

  constructor(private ctx: FxCtx) {}

  onEvent(ev: SimEvent, view: View | null): void {
    const ctx = this.ctx;
    if (!view) return;
    const cam = view.camera;
    const near = (x: number, z: number, r: number) => (x - cam.x) ** 2 + (z - cam.z) ** 2 < r * r;
    switch (ev.t) {
      case 'step': {
        if (!near(ev.x, ev.z, 40)) break;
        if (ev.surface === 'deep') this.burst('step', ev.x, ev.y, ev.z, 0, 0, 0, ev.run ? 1.4 : 1);
        else if (ev.surface === 'snow' && ev.run) this.burst('step', ev.x, ev.y, ev.z, 0, 0, 0, 0.45);
        break;
      }
      case 'land': {
        const p = view.ents.get(ev.id);
        if (p && near(p.x, p.z, 40) && ev.speed > 2.5) {
          const deep = ctx.world.snowDepthAt(p.x, p.z);
          this.burst('snow', p.x, p.y, p.z, 0, 0, 0, Math.min(2, ev.speed / 5) * (0.5 + deep));
        }
        break;
      }
      case 'shot': {
        this.muzzle(view, ev.by, ev.x, ev.y, ev.z, ev.dx, ev.dy, ev.dz);
        if (ev.hit === 'ground') this.burst('snow', ev.hx, ev.hy, ev.hz, 0, 0, 0, 0.9);
        else if (ev.hit === 'wood') this.burst('chips', ev.hx, ev.hy, ev.hz, -ev.dx, -ev.dy, -ev.dz, 0.8);
        else if (ev.hit === 'wolf') this.burst('snow', ev.hx, ev.hy - 0.4, ev.hz, 0, 0, 0, 0.4);
        break;
      }
      case 'swing': {
        if (!near(ev.x, ev.z, 50)) break;
        const p = view.ents.get(ev.by);
        const dx = p ? ev.x - p.x : 0, dz = p ? ev.z - p.z : 0;
        const l = Math.hypot(dx, dz) || 1;
        if (ev.hit === 'wood') {
          this.burst('chips', ev.x, ev.y, ev.z, -dx / l, 0.3, -dz / l, 1);
          // the blow shakes snow off the bark
          this.burst('snow', ev.x, ev.y + 0.3, ev.z, 0, 0, 0, 0.35);
        } else if (ev.hit === 'ground') {
          this.burst('sparks', ev.x, ev.y, ev.z, -dx / l, 0.6, -dz / l, 1);
          this.burst('snow', ev.x, ev.y, ev.z, 0, 0, 0, 0.6);
        }
        break;
      }
      case 'chopped': {
        if (!near(ev.x, ev.z, 60)) break;
        this.burst('chips', ev.x, ev.y, ev.z, 0, 1, 0, 1.8);
        this.burst('snow', ev.x, ev.y + 1.5, ev.z, 0, 0, 0, 1.2);
        break;
      }
      case 'iceBreak': {
        const y = ctx.world.lake ? ctx.world.lake.level : ctx.ground(ev.x, ev.z);
        this.burst('splash', ev.x, y, ev.z, 0, 0, 0, 1.4);
        this.burst('shards', ev.x, y, ev.z, 0, 0, 0, 1.2);
        break;
      }
      case 'splash': {
        const y = ctx.world.lake ? ctx.world.lake.level : ctx.ground(ev.x, ev.z);
        this.burst('splash', ev.x, y, ev.z, 0, 0, 0, 0.8);
        break;
      }
      case 'iceCreak': {
        if (!near(ev.x, ev.z, 30) || ev.stress < 0.5) break;
        const y = ctx.world.lake ? ctx.world.lake.level : ctx.ground(ev.x, ev.z);
        this.burst('snow', ev.x, y, ev.z, 0, 0, 0, 0.25);
        break;
      }
      case 'wolfDie': {
        if (near(ev.x, ev.z, 60)) this.burst('snow', ev.x, ev.y, ev.z, 0, 0, 0, 1.1);
        break;
      }
      case 'downed': {
        const p = view.ents.get(ev.id);
        if (p && near(p.x, p.z, 40)) this.burst('snow', p.x, p.y, p.z, 0, 0, 0, 0.9);
        break;
      }
      case 'logDrop': {
        const l = view.ents.get(ev.id) as ViewEnt<LogEnt> | undefined;
        if (!l || !near(l.x, l.z, 40)) break;
        const len = Math.max(1, l.len);
        const ax = Math.sin(l.yaw), az = Math.cos(l.yaw);
        for (let i = 0; i < 4; i++) {
          const u = (i / 3 - 0.5) * len;
          this.burst('snow', l.x + ax * u, l.y, l.z + az * u, 0, 0, 0, 0.6);
        }
        break;
      }
    }
  }

  /** Per frame: muzzle lights, things dropped into the snow, wolves running in drifts. */
  update(view: View | null): void {
    const ctx = this.ctx;
    const t = ctx.time;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const k = Math.max(0, 1 - (t - f.at) / (f.until - f.at));
      f.h.intensity = 40 * k * k;
      if (t >= f.until) {
        f.h.release();
        this.flashes.splice(i, 1);
      }
    }
    if (!view) return;
    // pickups that appear on the ground near someone: dropped or thrown down
    const pickups = view.list('pickup') as ViewEnt<PickupEnt>[];
    const cam = view.camera;
    let fresh = 0;
    for (const p of pickups) if (!this.known.has(p.id)) fresh++;
    const populate = !this.primed || fresh > 6;
    for (const p of pickups) {
      if (this.known.has(p.id)) continue;
      this.known.add(p.id);
      if (populate || p.lie === 'shelf' || p.age > 0.6) continue;
      if ((p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 > 30 * 30) continue;
      this.burst('snow', p.x, p.y, p.z, 0, 0, 0, p.item === 'log' || p.item === 'stick' ? 0.5 : 0.3);
    }
    if (this.known.size > pickups.length + 256) {
      this.known.clear();
      for (const p of pickups) this.known.add(p.id);
    }
    this.primed = true;
    // wolves kicking up powder in deep snow
    if (ctx.dt > 0) {
      for (const w of view.list('wolf') as ViewEnt<WolfEnt>[]) {
        if (w.mood === 'dead' || w.speed < 2.5) continue;
        if ((w.x - cam.x) ** 2 + (w.z - cam.z) ** 2 > 50 * 50) continue;
        const deep = ctx.world.snowDepthAt(w.x, w.z);
        if (deep < 0.2) continue;
        const a = (this.wolfAcc.get(w.id) ?? 0) + ctx.dt * w.speed * 0.9 * Math.max(0.3, ctx.budget);
        const n = Math.min(3, Math.floor(a));
        this.wolfAcc.set(w.id, a - n);
        for (let i = 0; i < n; i++) this.burst('step', w.x + ctx.rand.sym(0.3), w.y, w.z + ctx.rand.sym(0.3), 0, 0, 0, 0.7 + deep);
      }
      if (this.wolfAcc.size > 64) this.wolfAcc.clear();
    }
  }

  /** The rifle: a flash at the muzzle (estimated from the shooter's view), its light, smoke. */
  private muzzle(view: View, by: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    let mx = x + dx * 0.85, my = y + dy * 0.85 - 0.05, mz = z + dz * 0.85;
    if (by === view.myId && view.camera.third < 0.5) {
      // first person: the muzzle sits ahead of the eye, a little right and low unless aiming
      const cam = view.camera;
      const aim = view.me ? view.me.aim : 0;
      _e.set(cam.pitch, cam.yaw, 0, 'YXZ');
      _f.set(0, 0, -1).applyEuler(_e);
      _r.set(1, 0, 0).applyEuler(_e);
      const side = 0.13 * (1 - aim), drop = 0.12 * (1 - aim) + 0.05;
      mx = cam.x + _f.x * 0.95 + _r.x * side;
      my = cam.y + _f.y * 0.95 - drop;
      mz = cam.z + _f.z * 0.95 + _r.z * side;
    }
    this.burst('muzzle', mx, my, mz, dx, dy, dz, 1);
  }

  /** One-shot effects. (dx, dy, dz) is a direction where it matters; k scales the size. */
  burst(kind: BurstKind, x: number, y: number, z: number, dx = 0, dy = 0, dz = 0, k = 1): void {
    const ctx = this.ctx;
    const R = ctx.rand;
    const b = Math.max(0.35, ctx.budget);
    switch (kind) {
      case 'muzzle': {
        // the flash: a white-yellow core and short tongues along the bore, two frames long
        const s0 = ctx.glow.spec();
        s0.x = x; s0.y = y; s0.z = z;
        s0.life = 0.05; s0.s0 = 0.07; s0.s1 = 0.1;
        s0.op = 180 * k; s0.r = 1; s0.g = 0.72; s0.b = 0.38;
        s0.fin = 0.001; s0.fout = 0.9;
        ctx.glow.emit(s0);
        for (let i = 0; i < 6; i++) {
          const s = ctx.glow.spec();
          const sp = 6 + R.next() * 10;
          s.x = x; s.y = y; s.z = z;
          s.vx = dx * sp + R.sym(2); s.vy = dy * sp + R.sym(2); s.vz = dz * sp + R.sym(2);
          s.life = 0.04 + R.next() * 0.05;
          s.s0 = 0.01; s.s1 = 0.006;
          s.op = 90; s.r = 1; s.g = 0.6; s.b = 0.25;
          s.fin = 0.001; s.fout = 0.8;
          s.ex = 0.02;
          ctx.glow.emit(s);
        }
        const iy = Math.max(0.05, Math.abs(dy) + 0.02);
        for (let i = 0; i < 3; i++) {
          _t.x = x; _t.y = y; _t.z = z;
          _t.h = 0.16 + R.next() * 0.1;
          _t.w = 0.03 + R.next() * 0.02;
          _t.lx = (dx / iy) * (dy < 0 ? -1 : 1);
          _t.lz = (dz / iy) * (dy < 0 ? -1 : 1);
          _t.seed = R.next() * 10;
          _t.intensity = 2.2;
          _t.alpha = 1;
          _t.temp = 0.25;
          _t.wobble = 0.2;
          this.pendingTongues.push({ ..._t, until: ctx.time + 0.045 });
        }
        // smoke rolling out of the barrel
        for (let i = 0; i < 5; i++) {
          const s = ctx.puffs.spec();
          const u = i / 4;
          s.x = x + dx * 0.08 * i; s.y = y + dy * 0.08 * i; s.z = z + dz * 0.08 * i;
          s.vx = dx * (2.2 - u * 1.6) + R.sym(0.15); s.vy = dy * (2.2 - u * 1.6) + 0.05; s.vz = dz * (2.2 - u * 1.6) + R.sym(0.15);
          s.life = 1.6 + R.next() * 1.4;
          s.s0 = 0.04; s.s1 = 0.3 + R.next() * 0.25; s.grow = 0.45;
          s.rot = R.next() * 6.283; s.spin = R.sym(0.8);
          s.r = 0.72; s.g = 0.72; s.b = 0.74;
          s.op = 0.22;
          s.y0 = y; s.gy = ctx.ground(x, z, y);
          s.drag = 2.2; s.shear = 0.5; s.turb = 0.5; s.lift = 0.1;
          s.fin = 0.02; s.fout = 0.7;
          ctx.puffs.emit(s);
        }
        const h = ctx.lights.acquire('point', 8);
        h.fadeIn = 0;
        h.color.setRGB(1, 0.72, 0.42);
        h.colorFar = new THREE.Color(1, 0.5, 0.25);
        h.position.set(x, y, z);
        h.intensity = 40;
        h.range = 14;
        h.on = true;
        this.flashes.push({ h, at: ctx.time, until: ctx.time + 0.07, x, y, z, dx, dy, dz });
        break;
      }
      case 'snow':
      case 'step': {
        // powder kicked up: a low cloud that hugs the ground and blows away, a few clumps
        const big = kind === 'snow';
        const n = Math.max(1, Math.round((big ? 7 : 3) * k * b));
        const gy = y;
        for (let i = 0; i < n; i++) {
          const s = ctx.puffs.spec();
          const a = R.next() * Math.PI * 2;
          const sp = (big ? 0.6 + R.next() * 1.4 : 0.3 + R.next() * 0.6) * Math.sqrt(k);
          s.x = x + R.sym(0.12); s.y = y + 0.05 + R.next() * 0.1; s.z = z + R.sym(0.12);
          s.vx = Math.cos(a) * sp; s.vy = (big ? 0.6 : 0.35) + R.next() * 0.6 * k; s.vz = Math.sin(a) * sp;
          s.life = (big ? 1.4 : 0.9) + R.next() * 1.0;
          s.s0 = 0.06 * Math.sqrt(k); s.s1 = (big ? 0.5 : 0.28) * Math.sqrt(k) * (0.7 + R.next() * 0.6); s.grow = 0.45;
          s.rot = R.next() * 6.283; s.spin = R.sym(0.6);
          s.r = 0.9; s.g = 0.92; s.b = 0.96;
          s.op = (big ? 0.42 : 0.3) * Math.min(1, 0.6 + 0.4 * k);
          s.gy = gy; s.y0 = gy;
          s.grav = 1.2; s.drag = 1.2; s.shear = 0.6; s.turb = 0.4;
          s.fin = 0.03; s.fout = 0.7;
          s.flags = PF.HUG;
          s.ex = 0.6;
          ctx.puffs.emit(s);
        }
        if (big) {
          const m = Math.round(5 * k * b);
          for (let i = 0; i < m; i++) {
            const s = ctx.debris.spec();
            const a = R.next() * Math.PI * 2;
            const sp = 0.8 + R.next() * 1.6;
            s.x = x; s.y = y + 0.05; s.z = z;
            s.vx = Math.cos(a) * sp; s.vy = 1.2 + R.next() * 1.8; s.vz = Math.sin(a) * sp;
            s.life = 0.8 + R.next() * 0.8;
            s.s0 = s.s1 = 0.015 + R.next() * 0.02;
            s.rot = R.next() * 6.28; s.spin = R.sym(4);
            s.r = 0.88; s.g = 0.9; s.b = 0.95;
            s.op = 0.9;
            s.gy = gy; s.grav = 9.8; s.drag = 0.3;
            s.fin = 0.01; s.fout = 0.3;
            s.flags = PF.BOUNCE;
            s.ex = 6;
            ctx.debris.emit(s);
          }
        }
        break;
      }
      case 'chips': {
        const n = Math.round(9 * k * b);
        for (let i = 0; i < n; i++) {
          const s = ctx.debris.spec();
          const sp = 1.5 + R.next() * 2.5;
          s.x = x; s.y = y; s.z = z;
          s.vx = dx * sp + R.sym(1.4); s.vy = Math.abs(dy) * sp + 0.8 + R.next() * 1.5; s.vz = dz * sp + R.sym(1.4);
          s.life = 1.2 + R.next() * 1.2;
          s.s0 = s.s1 = 0.01 + R.next() * 0.018;
          s.rot = R.next() * 6.28; s.spin = R.sym(10);
          // pale fresh wood and dark bark
          const pale = R.next() < 0.6;
          s.r = pale ? 0.62 : 0.2; s.g = pale ? 0.48 : 0.14; s.b = pale ? 0.3 : 0.09;
          s.op = 1;
          s.gy = ctx.ground(x, z, y); s.grav = 9.8; s.drag = 0.4;
          s.fin = 0.01; s.fout = 0.25;
          s.flags = PF.BOUNCE;
          s.ex = 14;
          ctx.debris.emit(s);
        }
        break;
      }
      case 'sparks': {
        const n = Math.round(10 * k * b);
        for (let i = 0; i < n; i++) {
          const s = ctx.glow.spec();
          const sp = 2 + R.next() * 4;
          s.x = x; s.y = y; s.z = z;
          s.vx = dx * sp + R.sym(1.5); s.vy = Math.abs(dy) * sp + R.next() * 1.5; s.vz = dz * sp + R.sym(1.5);
          s.life = 0.15 + R.next() * 0.3;
          s.s0 = 0.004; s.s1 = 0.002;
          s.op = 70 + R.next() * 40;
          s.r = 1; s.g = 0.78; s.b = 0.45;
          s.gy = ctx.ground(x, z, y); s.grav = 9;
          s.fin = 0.01; s.fout = 0.6;
          s.flags = PF.BOUNCE | PF.COOL;
          s.ex = 0.025;
          ctx.glow.emit(s);
        }
        break;
      }
      case 'splash': {
        // black water thrown up, falling back as drops; mist
        const n = Math.round(26 * k * b);
        for (let i = 0; i < n; i++) {
          const s = ctx.debris.spec();
          const a = R.next() * Math.PI * 2;
          const sp = 0.6 + R.next() * 2.2;
          s.x = x + R.sym(0.3); s.y = y + 0.05; s.z = z + R.sym(0.3);
          s.vx = Math.cos(a) * sp; s.vy = 2 + R.next() * 3.2 * k; s.vz = Math.sin(a) * sp;
          s.life = 0.7 + R.next() * 0.7;
          s.s0 = 0.012 + R.next() * 0.02; s.s1 = s.s0 * 0.7;
          s.rot = R.next() * 6.28; s.spin = R.sym(2);
          s.r = 0.16; s.g = 0.2; s.b = 0.24;
          s.op = 0.85;
          s.gy = y - 0.05; s.grav = 9.8; s.drag = 0.2;
          s.fin = 0.01; s.fout = 0.25;
          s.flags = PF.TWINKLE;
          s.ex = 3;
          ctx.debris.emit(s);
        }
        for (let i = 0; i < Math.round(6 * k * b); i++) {
          const s = ctx.puffs.spec();
          s.x = x + R.sym(0.4); s.y = y + 0.1; s.z = z + R.sym(0.4);
          s.vx = R.sym(0.4); s.vy = 0.5 + R.next() * 0.5; s.vz = R.sym(0.4);
          s.life = 1.4 + R.next();
          s.s0 = 0.1; s.s1 = 0.6 + R.next() * 0.3; s.grow = 0.5;
          s.rot = R.next() * 6.283; s.spin = R.sym(0.5);
          s.r = 0.86; s.g = 0.9; s.b = 0.94;
          s.op = 0.25;
          s.gy = y; s.y0 = y;
          s.drag = 0.8; s.shear = 0.5; s.turb = 0.3;
          s.fin = 0.05; s.fout = 0.6; s.ex = 1;
          ctx.puffs.emit(s);
        }
        break;
      }
      case 'shards': {
        const n = Math.round(22 * k * b);
        for (let i = 0; i < n; i++) {
          const s = ctx.debris.spec();
          const a = R.next() * Math.PI * 2;
          const sp = 0.8 + R.next() * 2.4;
          s.x = x + R.sym(0.3); s.y = y + 0.02; s.z = z + R.sym(0.3);
          s.vx = Math.cos(a) * sp; s.vy = 0.8 + R.next() * 2.4 * k; s.vz = Math.sin(a) * sp;
          s.life = 1.6 + R.next() * 1.4;
          s.s0 = s.s1 = 0.025 + R.next() * 0.06;
          s.rot = R.next() * 6.28; s.spin = R.sym(5);
          s.r = 0.72; s.g = 0.82; s.b = 0.9;
          s.op = 0.8;
          s.gy = y; s.grav = 9.8; s.drag = 0.25;
          s.fin = 0.01; s.fout = 0.3;
          s.flags = PF.BOUNCE | PF.TWINKLE;
          s.ex = 8;
          ctx.debris.emit(s);
        }
        break;
      }
      case 'steam': {
        for (let i = 0; i < Math.round(5 * k * b); i++) {
          const s = ctx.puffs.spec();
          s.x = x + R.sym(0.1); s.y = y; s.z = z + R.sym(0.1);
          s.vy = 0.4 + R.next() * 0.4;
          s.life = 1.2 + R.next();
          s.s0 = 0.04; s.s1 = 0.3 * k; s.grow = 0.6;
          s.rot = R.next() * 6.283; s.spin = R.sym(0.6);
          s.r = s.g = 0.92; s.b = 0.95;
          s.op = 0.16;
          s.y0 = y; s.gy = y;
          s.lift = 0.4; s.drag = 0.6; s.shear = 0.3; s.turb = 0.3;
          s.fin = 0.1; s.fout = 0.6; s.ex = 1;
          ctx.puffs.emit(s);
        }
        break;
      }
      case 'smoke': {
        for (let i = 0; i < Math.round(5 * k * b); i++) {
          const s = ctx.puffs.spec();
          s.x = x + R.sym(0.1); s.y = y + i * 0.05; s.z = z + R.sym(0.1);
          s.vx = dx * 0.5; s.vy = 0.3 + R.next() * 0.3 + dy * 0.5; s.vz = dz * 0.5;
          s.life = 3 + R.next() * 2;
          s.s0 = 0.06; s.s1 = 0.6 * k; s.grow = 0.55;
          s.rot = R.next() * 6.283; s.spin = R.sym(0.4);
          s.r = s.g = 0.6; s.b = 0.64;
          s.op = 0.25;
          s.y0 = y; s.gy = ctx.ground(x, z, y);
          s.lift = 0.3; s.drag = 0.4; s.shear = 0.5; s.turb = 0.3;
          s.fin = 0.05; s.fout = 0.6;
          ctx.puffs.emit(s);
        }
        break;
      }
    }
  }

  /** Muzzle tongues live two frames: drawn by the fx system each frame until they expire. */
  readonly pendingTongues: (Tongue & { until: number })[] = [];

  drawTongues(): void {
    const t = this.ctx.time;
    for (let i = this.pendingTongues.length - 1; i >= 0; i--) {
      const p = this.pendingTongues[i];
      if (t > p.until) {
        this.pendingTongues.splice(i, 1);
        continue;
      }
      this.ctx.flames.add(p);
    }
  }

  dispose(): void {
    for (const f of this.flashes) f.h.release();
    this.flashes.length = 0;
    this.known.clear();
  }
}
