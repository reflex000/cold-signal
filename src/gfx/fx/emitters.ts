// What placed models ask for (KIT emitters and lamps): standalone smoke (a smouldering engine),
// steam, spark showers (a torn cable), lamp glow, warning beacons, and the lamps themselves
// (LightDef: the cabin lamp, the tower's lamps) through the light pool.
// Emitters next to a fire belong to that fire (fire.ts draws its smoke and sparks; a stove's
// chimney smokes only while the stove burns). Tower lamps and beacons stay dark until the
// generator runs.
// Owner: FX.
import type { DeviceEnt, FireEnt } from '../../sim/types';
import type { View } from '../../game/view';
import type { PlacedLight } from '../../models/instances';
import { quota, type FxCtx } from './ctx';
import { fireFlicker, type LightHandle } from './lights';
import { hashU } from './noise';
import { PF } from './particles';

interface Lamp {
  key: string;
  handle: LightHandle;
  seen: boolean;
}

export class EmitterFx {
  private acc = new Map<string, { v: number }>();
  private lamps = new Map<string, Lamp>();
  private beacons = new Map<string, LightHandle>();

  constructor(private ctx: FxCtx) {}

  update(view: View | null): void {
    const ctx = this.ctx;
    const props = ctx.props;
    if (!props) return;
    const fires = view ? view.list('fire') : [];
    const powered = view ? this.powered(view) : false;
    const nearFire = (x: number, z: number, r: number, type?: FireEnt['type']): FireEnt | null => {
      for (const f of fires) if ((!type || f.type === type) && (f.x - x) ** 2 + (f.z - z) ** 2 < r * r) return f;
      return null;
    };
    const t = ctx.time;
    const R = ctx.rand;
    const camX = ctx.camera.position.x, camZ = ctx.camera.position.z;

    // ---- smoke, steam, sparks ----
    for (const type of ['smoke', 'steam', 'spark'] as const) {
      const list = props.emitters(type);
      for (let i = 0; i < list.length; i++) {
        const em = list[i];
        const p = em.position;
        if ((p.x - camX) ** 2 + (p.z - camZ) ** 2 > 220 * 220) continue;
        // a fire's own emitters and a stove's chimney are drawn by the fire
        if (nearFire(p.x, p.z, 1.3)) continue;
        if (type === 'smoke' && nearFire(p.x, p.z, 6, 'stove')) continue;
        const strength = typeof em.def.strength === 'number' ? (em.def.strength as number) : 1;
        if (strength <= 0) continue;
        const key = type + em.prop + ':' + i;
        let a = this.acc.get(key);
        if (!a) this.acc.set(key, (a = { v: hashU(em.prop + i) }));
        if (type === 'smoke') {
          const n = Math.min(4, quota(a, 2.2 * strength * ctx.budget, ctx.dt));
          for (let k = 0; k < n; k++) {
            const s = ctx.puffs.spec();
            s.x = p.x + R.sym(em.size); s.y = p.y; s.z = p.z + R.sym(em.size);
            s.vx = em.dir.x * 0.6 + R.sym(0.1); s.vy = em.dir.y * 0.6 + 0.3; s.vz = em.dir.z * 0.6 + R.sym(0.1);
            s.life = 7 + R.next() * 4;
            s.s0 = em.size * 0.6; s.s1 = 1.2 + R.next() * 0.6; s.grow = 0.55;
            s.rot = R.next() * 6.283; s.spin = R.sym(0.3);
            s.r = 0.42; s.g = 0.41; s.b = 0.42;
            s.op = 0.22 * Math.min(1.5, strength);
            s.y0 = p.y; s.gy = ctx.ground(p.x, p.z, p.y);
            s.lift = 0.6; s.tau = 3; s.drag = 0.1; s.shear = 0.5; s.turb = 0.3;
            s.fin = 0.06; s.fout = 0.6;
            ctx.puffs.emit(s);
          }
        } else if (type === 'steam') {
          const n = Math.min(3, quota(a, 3 * strength * ctx.budget, ctx.dt));
          for (let k = 0; k < n; k++) {
            const s = ctx.puffs.spec();
            s.x = p.x + R.sym(em.size); s.y = p.y; s.z = p.z + R.sym(em.size);
            s.vx = em.dir.x * 0.5; s.vy = em.dir.y * 0.5 + 0.2; s.vz = em.dir.z * 0.5;
            s.life = 1.4 + R.next();
            s.s0 = em.size * 0.5; s.s1 = 0.35 + R.next() * 0.2; s.grow = 0.6;
            s.rot = R.next() * 6.283; s.spin = R.sym(0.6);
            s.r = s.g = 0.92; s.b = 0.95;
            s.op = 0.14 * Math.min(1.5, strength);
            s.y0 = p.y; s.gy = p.y - 1;
            s.lift = 0.4; s.drag = 0.6; s.shear = 0.3; s.turb = 0.3;
            s.fin = 0.1; s.fout = 0.6; s.ex = 1;
            ctx.puffs.emit(s);
          }
        } else {
          // sparks come in short showers at irregular intervals
          const phase = (t * (0.35 + hashU(em.prop * 7 + i) * 0.3) + hashU(i * 13 + em.prop)) % 1;
          if (phase < 0.08) {
            const n = Math.min(5, quota(a, 70 * strength * ctx.budget, ctx.dt));
            for (let k = 0; k < n; k++) {
              const s = ctx.glow.spec();
              s.x = p.x; s.y = p.y; s.z = p.z;
              s.vx = em.dir.x * 2 + R.sym(1.5); s.vy = em.dir.y * 2 + R.next() * 1.5; s.vz = em.dir.z * 2 + R.sym(1.5);
              s.life = 0.3 + R.next() * 0.5;
              s.s0 = 0.004; s.s1 = 0.002;
              s.op = 60 + R.next() * 50;
              s.r = 1; s.g = 0.8; s.b = 0.55;
              s.gy = ctx.ground(p.x, p.z, p.y); s.grav = 9;
              s.fin = 0.01; s.fout = 0.5;
              s.flags = PF.BOUNCE | PF.COOL;
              s.ex = 0.025;
              ctx.glow.emit(s);
            }
          }
        }
      }
    }

    // ---- lamps (LightDef) ----
    for (const l of this.lamps.values()) l.seen = false;
    const lights = props.lights();
    for (let i = 0; i < lights.length; i++) this.lamp(lights[i], i, powered, t);
    for (const [k, l] of this.lamps) {
      if (!l.seen) {
        l.handle.release();
        this.lamps.delete(k);
      }
    }

    // ---- lamp glass glow ('light') and beacons ----
    const glowList = props.emitters('light');
    for (let i = 0; i < glowList.length; i++) {
      const em = glowList[i];
      if (this.isTower(em.prop) && !powered) continue;
      if ((em.position.x - camX) ** 2 + (em.position.z - camZ) ** 2 > 300 * 300) continue;
      const s = ctx.glow.spec();
      s.x = em.position.x; s.y = em.position.y; s.z = em.position.z;
      s.life = Math.max(0.02, ctx.dt * 1.5);
      s.s0 = s.s1 = Math.max(0.02, em.size);
      s.op = 6;
      s.r = 1; s.g = 0.78; s.b = 0.5;
      s.fin = s.fout = 0.001;
      ctx.glow.emit(s);
    }
    const beacons = props.emitters('beacon');
    const live = new Set<string>();
    for (let i = 0; i < beacons.length; i++) {
      const em = beacons[i];
      const key = 'b' + em.prop + ':' + i;
      live.add(key);
      let h = this.beacons.get(key);
      if (!h) {
        h = ctx.lights.acquire('point', 0.6);
        h.color.setRGB(1, 0.08, 0.05);
        this.beacons.set(key, h);
      }
      // a slow aviation blink: 1.5 s period, 0.35 s on
      const on = powered && ((t + hashU(i) * 1.5) % 1.5) < 0.35;
      h.on = on;
      h.position.copy(em.position);
      h.intensity = 6;
      h.range = 14;
      if (on) {
        const s = ctx.glow.spec();
        s.x = em.position.x; s.y = em.position.y; s.z = em.position.z;
        s.life = Math.max(0.02, ctx.dt * 1.5);
        s.s0 = s.s1 = Math.max(0.03, em.size);
        s.op = 40;
        s.r = 1; s.g = 0.1; s.b = 0.06;
        s.fin = s.fout = 0.001;
        ctx.glow.emit(s);
      }
    }
    for (const [k, h] of this.beacons) {
      if (!live.has(k)) {
        h.release();
        this.beacons.delete(k);
      }
    }
    if (this.acc.size > 512) this.acc.clear();
  }

  private lamp(pl: PlacedLight, i: number, powered: boolean, t: number): void {
    const key = 'l' + pl.prop + ':' + i;
    let l = this.lamps.get(key);
    if (!l) {
      const h = this.ctx.lights.acquire('point', 0.9);
      l = { key, handle: h, seen: true };
      this.lamps.set(key, l);
    }
    l.seen = true;
    const d = pl.def;
    const h = l.handle;
    const on = this.isTower(pl.prop) ? powered : true;
    h.on = on && d.intensity > 0;
    h.position.copy(pl.position);
    h.color.setRGB(d.color[0], d.color[1], d.color[2]);
    h.colorFar = null;
    const flick = d.flicker > 0 ? 1 - d.flicker + d.flicker * fireFlicker(t, (hashU(pl.prop * 3 + i) * 997) | 0, 0) : 1;
    h.intensity = d.intensity * flick;
    h.range = d.range;
  }

  private isTower(prop: number): boolean {
    const inst = this.ctx.props?.inst(prop);
    return !!inst && inst.poi === 'tower';
  }

  /** The tower has power: the generator device runs or the objective has charge. */
  private powered(view: View): boolean {
    for (const d of view.list('device') as DeviceEnt[]) if (d.type === 'generator' && d.on) return true;
    return view.objective ? view.objective.generator > 0.05 : false;
  }

  dispose(): void {
    for (const l of this.lamps.values()) l.handle.release();
    this.lamps.clear();
    for (const h of this.beacons.values()) h.release();
    this.beacons.clear();
  }
}
