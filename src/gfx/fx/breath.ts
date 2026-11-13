// Breath vapour. Every living player in the cold breathes out a small cloud: the rhythm comes from
// exertion (the same rate as the view rig: faster when tired or sprinting), the clouds are bigger
// and denser the colder it feels, they leave the face with the player's own motion, slow down and
// drift with the wind, and the pool lights (fires, flares, flashlights) light them like smoke. The
// local player's own breath, in first person, rises from just under the camera into the bottom of
// the view. Wolves pant small clouds when they run.
// Owner: FX.
import * as THREE from 'three/webgpu';
import type { PlayerEnt, WolfEnt } from '../../sim/types';
import type { View, ViewEnt } from '../../game/view';
import type { FxCtx } from './ctx';
import { hashU } from './noise';

interface Breather {
  phase: number;
  /** Seconds left of the current exhale (0 = not breathing out). */
  out: number;
  acc: number;
  seen: boolean;
}

const _fwd = new THREE.Vector3();
const _e = new THREE.Euler();
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class BreathFx {
  private who = new Map<number, Breather>();

  constructor(private ctx: FxCtx) {}

  update(view: View | null): void {
    const ctx = this.ctx;
    if (!view || ctx.dt <= 0) return;
    for (const b of this.who.values()) b.seen = false;
    const cam = view.camera;
    const firstPerson = cam.third < 0.5;
    for (const p of view.list('player') as ViewEnt<PlayerEnt>[]) {
      if (p.life === 'dead' || p.life === 'rescued' || p.swim) continue;
      const mine = p.id === view.myId;
      const dx = p.x - cam.x, dz = p.z - cam.z;
      if (!mine && dx * dx + dz * dz > 45 * 45) continue;
      // visible breath below ~8 C felt; full clouds in deep cold
      const feels = Number.isFinite(p.feels) ? p.feels : view.env.airTemp;
      const cold = smooth(9, -18, feels);
      if (cold <= 0.01) continue;
      let b = this.who.get(p.id);
      if (!b) {
        b = { phase: hashU(p.id * 3 + 1), out: 0, acc: 0, seen: true };
        this.who.set(p.id, b);
      }
      b.seen = true;
      const prev = b.phase;
      if (mine) b.phase = view.rig.breath;
      else {
        const rate = 0.22 + 0.55 * (1 - p.stamina) + (p.sprint ? 0.25 : 0) + (p.life === 'downed' ? 0.2 : 0);
        b.phase = (b.phase + rate * ctx.dt) % 1;
      }
      const exertion = Math.min(1, (p.sprint ? 0.6 : 0) + (1 - p.stamina) * 0.6 + Math.min(0.4, Math.hypot(p.vx, p.vz) / 8));
      // breathe out when the cycle passes its middle
      if ((prev < 0.5 && b.phase >= 0.5) || (prev > b.phase && b.phase >= 0.5)) b.out = 0.42 + 0.25 * (1 - exertion);
      if (b.out <= 0) continue;
      b.out -= ctx.dt;
      b.acc += ctx.dt * (16 + 10 * exertion) * Math.max(0.35, ctx.budget);
      const n = Math.min(4, Math.floor(b.acc));
      b.acc -= n;
      for (let i = 0; i < n; i++) {
        if (mine && firstPerson) this.ownPuff(view, p, cold, exertion);
        else this.puff(p, cold, exertion);
      }
    }
    for (const [id, b] of this.who) if (!b.seen) this.who.delete(id);
    this.wolves(view);
  }

  /** Another player's breath (or the local one in third person). */
  private puff(p: ViewEnt<PlayerEnt>, cold: number, ex: number): void {
    const ctx = this.ctx;
    const R = ctx.rand;
    const down = p.life === 'downed';
    const eye = down ? 0.32 : p.crouch ? 1.05 : 1.58;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const pitch = p.pitch || 0;
    const cp = Math.cos(pitch * 0.6), spitch = Math.sin(pitch * 0.6);
    const s = ctx.puffs.spec();
    s.x = p.x + fx * 0.2 * cp + R.sym(0.02);
    s.y = p.y + eye - 0.07 + spitch * 0.15;
    s.z = p.z + fz * 0.2 * cp + R.sym(0.02);
    const sp = 0.55 + 0.6 * ex + R.next() * 0.25;
    s.vx = p.vx + fx * sp * cp + R.sym(0.08);
    s.vy = (p.vy || 0) * 0.5 + spitch * sp - 0.06 + R.sym(0.05);
    s.vz = p.vz + fz * sp * cp + R.sym(0.08);
    this.vapour(s, cold, ex, p.y);
    ctx.puffs.emit(s);
  }

  /** The local player's own breath, seen from inside the hood. */
  private ownPuff(view: View, p: ViewEnt<PlayerEnt>, cold: number, ex: number): void {
    const ctx = this.ctx;
    const R = ctx.rand;
    const cam = view.camera;
    _e.set(cam.pitch, cam.yaw, 0, 'YXZ');
    _fwd.set(0, 0, -1).applyEuler(_e);
    const s = ctx.puffs.spec();
    // out of the scarf just under the eye, into the lower part of the view
    s.x = cam.x + _fwd.x * 0.16 + R.sym(0.015);
    s.y = cam.y - 0.12 + _fwd.y * 0.1;
    s.z = cam.z + _fwd.z * 0.16 + R.sym(0.015);
    const sp = 0.5 + 0.5 * ex + R.next() * 0.2;
    s.vx = p.vx + _fwd.x * sp + R.sym(0.06);
    s.vy = _fwd.y * sp * 0.6 - 0.1 + R.sym(0.04);
    s.vz = p.vz + _fwd.z * sp + R.sym(0.06);
    this.vapour(s, cold, ex, p.y);
    // close to the eye a cloud covers a lot of the picture: keep it faint and small
    s.op *= 0.55;
    s.s1 *= 0.8;
    ctx.puffs.emit(s);
  }

  private vapour(s: ReturnType<FxCtx['puffs']['spec']>, cold: number, ex: number, gy: number): void {
    const R = this.ctx.rand;
    s.life = 1.0 + cold * 1.2 + R.next() * 0.5;
    s.s0 = 0.025 + R.next() * 0.015;
    s.s1 = (0.14 + 0.22 * cold) * (1 + 0.35 * ex) * (0.8 + R.next() * 0.4);
    s.grow = 0.5;
    s.rot = R.next() * 6.283;
    s.spin = R.sym(0.9);
    s.r = 0.86; s.g = 0.88; s.b = 0.92;
    s.op = (0.07 + 0.14 * cold) * (0.8 + R.next() * 0.4);
    s.gy = gy;
    s.y0 = s.y;
    // warm, moist air: slows fast, rises a little, then belongs to the wind
    s.drag = 1.6;
    s.shear = 0.4;
    s.lift = 0.12;
    s.tau = 1.5;
    s.turb = 0.25;
    s.fin = 0.05;
    s.fout = 0.75;
    s.ex = 1;
  }

  private wolfAcc = new Map<number, number>();

  /** Running wolves pant small clouds. */
  private wolves(view: View): void {
    const ctx = this.ctx;
    const cam = view.camera;
    const cold = smooth(9, -18, view.env.airTemp);
    if (cold <= 0.01) return;
    for (const w of view.list('wolf') as ViewEnt<WolfEnt>[]) {
      if (w.mood === 'dead') continue;
      const dx = w.x - cam.x, dz = w.z - cam.z;
      if (dx * dx + dz * dz > 35 * 35) continue;
      const pant = w.speed > 3 || w.mood === 'charge' || w.mood === 'howl';
      const rate = (pant ? 3.2 : 0.6) * Math.max(0.3, ctx.budget);
      const a = (this.wolfAcc.get(w.id) ?? hashU(w.id)) + rate * ctx.dt;
      const n = Math.floor(a);
      this.wolfAcc.set(w.id, a - n);
      const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
      const head = w.mood === 'howl' ? 1.0 : 0.62;
      for (let i = 0; i < n; i++) {
        const s = ctx.puffs.spec();
        s.x = w.x + fx * 0.85; s.y = w.y + head; s.z = w.z + fz * 0.85;
        s.vx = w.vx + fx * 0.4; s.vy = w.mood === 'howl' ? 0.5 : -0.05; s.vz = w.vz + fz * 0.4;
        this.vapour(s, cold, pant ? 0.8 : 0.1, w.y);
        s.s1 *= 0.7;
        s.op *= 0.8;
        ctx.puffs.emit(s);
      }
    }
    if (this.wolfAcc.size > 64) this.wolfAcc.clear();
  }

  dispose(): void {
    this.who.clear();
  }
}
