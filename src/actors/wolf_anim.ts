// Procedural animation of the wolf, from WolfEnt fields (speed, mood, moodT, target, health, fear)
// and the presentation events the system forwards (yelp -> flinch, growl -> snarl, bark, bite).
//
// Gaits share one phase; each foot has a footfall time per gait, blended by speed:
//   walk (lateral sequence)  HL 0    FL 0.25  HR 0.5   FR 0.75   duty 0.66
//   trot (diagonal pairs)    HL 0    FR 0.02  HR 0.5   FL 0.52   duty 0.42
//   rotary gallop            HL 0    HR 0.1   FR 0.42  FL 0.52   duty 0.27  (back flexes, then stretches)
// A stance foot stays planted in the world; a swing foot flies to a landing point predicted from the
// velocity. Legs are solved as the dog's three segments: the paw's pastern / metatarsus angle sets
// the wrist / hock, then two-bone IK from the shoulder (elbow back) or the hip (knee forward); the
// shoulder blade swings with the foreleg. The body pitches with the ground under the front and
// hind feet. Moods change the body (stalking crouch, cowering, charging low), the head (looks at the
// target), ears, jaw and tail (a damped chain), and three poses replace standing: lying at rest,
// sitting to howl, dead on its side.
import * as THREE from 'three/webgpu';
import type { Entity, WolfEnt, WolfMood } from '../sim/types';
import { Hinge, Pose, fk, qAxis, qLook, qXYZ, qYXZ, solveTwoBone } from './rig';
import { WB, WOLF_BIND, WOLF_SKEL, eyeBind } from './wolf_model';
import type { AnimCtx } from './player_anim';

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const damp = (a: number, b: number, rate: number, dt: number): number => b + (a - b) * Math.exp(-rate * dt);
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const dampAngle = (a: number, b: number, rate: number, dt: number): number => a + wrap(b - a) * (1 - Math.exp(-rate * dt));
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const S = WOLF_SKEL;
const Bj = S.bind;
const len = (a: number, b: number): number => Math.hypot(Bj[a * 3] - Bj[b * 3], Bj[a * 3 + 1] - Bj[b * 3 + 1], Bj[a * 3 + 2] - Bj[b * 3 + 2]);
const F_UP = len(WB.fUpL, WB.fLowL), F_LOW = len(WB.fLowL, WB.fFootL), F_FOOT = len(WB.fFootL, WB.fToeL);
const H_UP = len(WB.thighL, WB.shankL), H_LOW = len(WB.shankL, WB.metaL), H_META = len(WB.metaL, WB.toeL);
const PAW_H = WOLF_BIND.FPAW_L[1];

// feet: 0 FL, 1 FR, 2 HL, 3 HR
const FRONT = [true, true, false, false];
const SIDE = [-1, 1, -1, 1];
const REST_Z = [WOLF_BIND.FPAW_L[2], WOLF_BIND.FPAW_L[2], WOLF_BIND.HPAW_L[2], WOLF_BIND.HPAW_L[2]];
const REST_X = [WOLF_BIND.FPAW_L[0], -WOLF_BIND.FPAW_L[0], WOLF_BIND.HPAW_L[0], -WOLF_BIND.HPAW_L[0]];
//                FL    FR    HL   HR
const OFF_WALK = [0.25, 0.75, 0.0, 0.5];
const OFF_TROT = [0.52, 1.02, 0.0, 0.5];
const OFF_GALLOP = [0.52, 0.42, 0.0, 0.1];

const hingeOf = (b: number, x: number): Hinge => new Hinge(S, b, [x, 0, 0]);
const H = {
  fUp: [hingeOf(WB.fUpL, 1), hingeOf(WB.fUpR, 1)],
  fLow: [hingeOf(WB.fLowL, 1), hingeOf(WB.fLowR, 1)],
  fFoot: [hingeOf(WB.fFootL, 1), hingeOf(WB.fFootR, 1)],
  fToe: [hingeOf(WB.fToeL, 1), hingeOf(WB.fToeR, 1)],
  hUp: [hingeOf(WB.thighL, -1), hingeOf(WB.thighR, -1)],
  hLow: [hingeOf(WB.shankL, -1), hingeOf(WB.shankR, -1)],
  hMeta: [hingeOf(WB.metaL, -1), hingeOf(WB.metaR, -1)],
  hToe: [hingeOf(WB.toeL, -1), hingeOf(WB.toeR, -1)],
};
const LEG_BONES = [
  { scap: WB.scapL, up: WB.fUpL, low: WB.fLowL, foot: WB.fFootL, toe: WB.fToeL },
  { scap: WB.scapR, up: WB.fUpR, low: WB.fLowR, foot: WB.fFootR, toe: WB.fToeR },
  { scap: -1, up: WB.thighL, low: WB.shankL, foot: WB.metaL, toe: WB.toeL },
  { scap: -1, up: WB.thighR, low: WB.shankR, foot: WB.metaR, toe: WB.toeR },
];

const EYE_L = eyeBind(-1);

interface Foot {
  planted: boolean;
  pos: THREE.Vector3; // ground point under the paw
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number; // swing progress 0..1 (or rest step)
  dur: number;
  lift: number;
  swing: number; // 0..1 how folded the paw is (swing)
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _ax = new THREE.Vector3(), _y1 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _root = new THREE.Quaternion();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _y2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class WolfAnimator {
  readonly pose = new Pose(S);
  private readonly alt = new Pose(S);
  private readonly scale: number;
  private init = false;
  private yaw = 0;
  private phase = 0;
  private spd = 0;
  private velX = 0;
  private velZ = 0;
  private lastX = 0;
  private lastZ = 0;
  private wTrot = 0;
  private wGallop = 0;
  private wMove = 0;
  // mood weights
  private wStalk = 0;
  private wCower = 0;
  private wCharge = 0;
  private wFlee = 0;
  private wRest = 0;
  private wSit = 0;
  private wDead = 0;
  private wFeed = 0;
  private wBite = 0;
  private wDrag = 0;
  private wAlert = 0;
  private sleep = 0;
  // head / face / tail
  private headYaw = 0;
  private headPitch = 0;
  private jaw = 0;
  private ears = 0;
  private flinch = 0;
  private flinchSide = 1;
  private snarl = 0;
  private bark = 0;
  private snap = 0;
  private breath = 0;
  private readonly tail = [0, 0, 0, 0]; // pitch per segment (spring)
  private readonly tailV = [0, 0, 0, 0];
  private tailYaw = 0;
  private bodyPitch = 0;
  private hipY = 0;
  private chestY = 0;
  private deadSide = 1;
  private readonly seed: number;
  private readonly feet: Foot[] = [0, 1, 2, 3].map(() => ({ planted: true, pos: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, dur: 0.25, lift: 0.06, swing: 0 }));
  private lastMood: WolfMood = 'roam';

  constructor(variant: number, alpha: boolean) {
    const v = ((variant % 997) + 997) % 997;
    this.seed = v * 0.618;
    this.scale = (0.94 + ((v * 37) % 100) / 100 * 0.1) * (alpha ? 1.05 : 1);
    this.pose.scale = this.alt.scale = this.scale;
    this.breath = (v * 1.7) % TAU;
    this.deadSide = v % 2 ? 1 : -1;
  }

  /** The presentation events of this wolf (forwarded by the system). */
  event(t: 'yelp' | 'growl' | 'bark' | 'bite' | 'howl', fromX = 0, fromZ = 0): void {
    if (t === 'yelp') {
      this.flinch = 1;
      // jump away from where the hurt came from
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      this.flinchSide = (fromX - this.lastX) * rx + (fromZ - this.lastZ) * rz > 0 ? -1 : 1;
    } else if (t === 'growl') this.snarl = 1;
    else if (t === 'bark') this.bark = 1;
    else if (t === 'bite') this.snap = 1;
  }

  private groundY(ctx: AnimCtx, x: number, z: number, yRef: number): number {
    if (!ctx.world) return yRef;
    const g = ctx.world.groundAt(x, z, yRef + 0.5).y;
    return Math.abs(g - yRef) > 0.8 ? yRef : g;
  }

  private restPoint(e: { x: number; y: number; z: number }, i: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const k = this.scale;
    const wide = 1 + 0.15 * this.wStalk + 0.25 * this.wCower;
    const lx = REST_X[i] * k * wide, lz = REST_Z[i] * k;
    return out.set(e.x + lx * c + lz * s, e.y, e.z - lx * s + lz * c);
  }

  reset(e: WolfEnt, ctx: AnimCtx): void {
    this.yaw = e.yaw;
    this.lastX = e.x;
    this.lastZ = e.z;
    this.velX = e.vx;
    this.velZ = e.vz;
    this.wDead = e.mood === 'dead' ? 1 : 0;
    this.wRest = e.mood === 'rest' ? 1 : 0;
    this.wSit = e.mood === 'howl' ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      const f = this.feet[i];
      this.restPoint(e, i, f.pos);
      f.pos.y = this.groundY(ctx, f.pos.x, f.pos.z, e.y);
      f.planted = true;
      f.t = 1;
      f.swing = 0;
    }
    this.hipY = e.y;
    this.chestY = e.y;
    this.init = true;
  }

  update(e: WolfEnt, ctx: AnimCtx, target: Entity | null, cam: THREE.Vector3): void {
    if (!this.init) this.reset(e, ctx);
    const dt = clamp(ctx.dt, 0, 0.1);
    if (Math.hypot(e.x - this.lastX, e.z - this.lastZ) > 6) this.reset(e, ctx);
    const mood = e.mood;
    const dead = mood === 'dead';
    // velocity: the entity's own, else from motion
    const mvx = dt > 0 ? (e.x - this.lastX) / dt : 0, mvz = dt > 0 ? (e.z - this.lastZ) / dt : 0;
    const hasVel = Math.abs(e.vx) + Math.abs(e.vz) > 1e-4;
    this.velX = damp(this.velX, hasVel ? e.vx : mvx, 10, dt);
    this.velZ = damp(this.velZ, hasVel ? e.vz : mvz, 10, dt);
    this.lastX = e.x;
    this.lastZ = e.z;
    const v = dead ? 0 : Math.max(Math.hypot(this.velX, this.velZ), Number.isFinite(e.speed) ? e.speed * 0.98 : 0);
    this.spd = damp(this.spd, v, 8, dt);

    // ---- mood weights ----
    const rate = 4;
    const w = (cur: number, on: boolean, r = rate): number => damp(cur, on ? 1 : 0, r, dt);
    this.wStalk = w(this.wStalk, mood === 'stalk');
    this.wCower = w(this.wCower, mood === 'cower');
    this.wCharge = w(this.wCharge, mood === 'charge' || mood === 'feint');
    this.wFlee = w(this.wFlee, mood === 'flee');
    this.wRest = w(this.wRest, mood === 'rest' && this.spd < 0.4, 2.2);
    this.wSit = w(this.wSit, mood === 'howl' && this.spd < 0.4, 3);
    this.wDead = w(this.wDead, dead, 3.5);
    this.wFeed = w(this.wFeed, mood === 'feed');
    this.wBite = w(this.wBite, mood === 'bite', 9);
    this.wDrag = w(this.wDrag, mood === 'drag');
    this.wAlert = w(this.wAlert, mood === 'stalk' || mood === 'circle' || mood === 'feint' || mood === 'charge' || mood === 'bite');
    this.sleep = damp(this.sleep, mood === 'rest' && e.moodT > 25 ? 1 : 0, 0.5, dt);
    if (mood !== this.lastMood && mood === 'bite') this.snap = 0;
    this.lastMood = mood;
    this.flinch = damp(this.flinch, 0, 4.5, dt);
    this.snarl = damp(this.snarl, mood === 'stalk' && target && Math.hypot(target.x - e.x, target.z - e.z) < 8 ? 0.6 : 0, 1.5, dt);
    this.bark = damp(this.bark, 0, 7, dt);
    this.snap = damp(this.snap, 0, 6, dt);

    // ---- facing ----
    let yawT = e.yaw;
    if (this.wDrag > 0.5 && v > 0.2) yawT = Math.atan2(this.velX, this.velZ); // backing away, facing the prey
    this.yaw = dampAngle(this.yaw, yawT, this.wDead > 0.5 ? 0 : 5 + this.spd * 0.6, dt);

    // ---- gait ----
    this.wTrot = damp(this.wTrot, smooth(1.8, 2.8, this.spd), 4, dt);
    this.wGallop = damp(this.wGallop, smooth(6.0, 7.6, this.spd), 3, dt);
    const moving = this.spd > 0.15 && this.wRest < 0.5 && this.wSit < 0.5 && this.wDead < 0.5;
    this.wMove = damp(this.wMove, moving ? 1 : 0, 6, dt);
    const stride = (0.75 + 0.3 * this.spd) * this.scale * (1 - 0.25 * this.wStalk - 0.2 * this.wCower);
    if (moving) this.phase = (this.phase + (this.spd / stride) * dt) % 1;
    const duty = lerp(lerp(0.66, 0.42, this.wTrot), 0.27, this.wGallop);
    this.updateFeet(e, ctx, dt, moving, stride, duty);
    this.breath += dt * TAU * (0.3 + 0.9 * smooth(2, 8, this.spd) + 0.4 * this.wBite);

    // ---- poses ----
    this.stand(e, ctx, dt, target, cam);
    const special = Math.max(this.wRest, this.wSit, this.wDead);
    if (special > 0.003) {
      if (this.wDead >= this.wRest && this.wDead >= this.wSit) this.lyingDead(e, ctx);
      else if (this.wSit > this.wRest) this.sitting(e, ctx);
      else this.lyingRest(e, ctx);
      const k = special * special * (3 - 2 * special);
      for (let b = 0; b < S.n; b++) {
        this.pose.p[b].lerp(this.alt.p[b], k);
        this.pose.q[b].slerp(this.alt.q[b], k);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Feet
  // ------------------------------------------------------------------------------------------

  private updateFeet(e: WolfEnt, ctx: AnimCtx, dt: number, moving: boolean, stride: number, duty: number): void {
    const vx = this.velX, vz = this.velZ;
    const spd = Math.max(this.spd, 0.3);
    const T = stride / spd;
    const vl = Math.hypot(vx, vz) || 1;
    for (let i = 0; i < 4; i++) {
      const f = this.feet[i];
      if (moving) {
        const off = lerp(lerp(OFF_WALK[i], OFF_TROT[i], this.wTrot), OFF_GALLOP[i], this.wGallop);
        const ph = (((this.phase - off) % 1) + 1) % 1;
        if (ph < duty) {
          if (!f.planted) {
            f.planted = true;
            f.pos.copy(f.to);
          }
          f.swing = damp(f.swing, 0, 14, dt);
        } else {
          const t = (ph - duty) / (1 - duty);
          if (f.planted) {
            f.planted = false;
            f.from.copy(f.pos);
          }
          const tRem = (1 - ph) * T;
          const lead = (duty * T * this.spd) / 2;
          this.restPoint(e, i, f.to);
          f.to.x += vx * tRem + (vx / vl) * lead;
          f.to.z += vz * tRem + (vz / vl) * lead;
          f.to.y = this.groundY(ctx, f.to.x, f.to.z, e.y);
          const u = t * t * (3 - 2 * t);
          f.pos.lerpVectors(f.from, f.to, u);
          const lift = (lerp(lerp(0.05, 0.085, this.wTrot), 0.11, this.wGallop) + 0.03 * this.wStalk) * this.scale;
          f.pos.y += Math.sin(Math.PI * Math.pow(t, 0.75)) * lift;
          f.swing = Math.sin(Math.PI * Math.min(1, t * 1.1));
        }
        f.t = 1;
        continue;
      }
      // standing: step only to stay under the body
      const rest = this.restPoint(e, i, _v4);
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / f.dur);
        const u = f.t * f.t * (3 - 2 * f.t);
        f.to.copy(rest);
        f.to.y = this.groundY(ctx, rest.x, rest.z, e.y);
        f.pos.lerpVectors(f.from, f.to, u);
        f.pos.y += Math.sin(Math.PI * f.t) * f.lift;
        f.swing = Math.sin(Math.PI * f.t) * 0.6;
        f.planted = f.t >= 1;
        continue;
      }
      if (!f.planted) {
        f.from.copy(f.pos);
        f.t = 0;
        f.dur = 0.2;
        f.lift = 0.04;
        continue;
      }
      f.swing = damp(f.swing, 0, 10, dt);
      f.pos.y = damp(f.pos.y, this.groundY(ctx, f.pos.x, f.pos.z, e.y), 20, dt);
      const err = Math.hypot(f.pos.x - rest.x, f.pos.z - rest.z);
      // one foot at a time, the diagonal partner may go together
      let busy = false;
      for (let j = 0; j < 4; j++) if (j !== i && this.feet[j].t < 1 && SIDE[j] === SIDE[i]) busy = true;
      if (err > 0.13 * this.scale && !busy) {
        f.from.copy(f.pos);
        f.t = 0;
        f.dur = 0.22;
        f.lift = 0.05 * this.scale;
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Standing / moving
  // ------------------------------------------------------------------------------------------

  private stand(e: WolfEnt, ctx: AnimCtx, dt: number, target: Entity | null, cam: THREE.Vector3): void {
    const P = this.pose;
    const k = this.scale;
    const ph = this.phase;
    const t = ctx.time;
    const gal = this.wGallop * this.wMove, trot = this.wTrot * this.wMove * (1 - this.wGallop), walk = this.wMove * (1 - this.wTrot);
    _root.setFromAxisAngle(UP, this.yaw);
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // ground under the front and hind feet -> body pitch and heights
    const f = this.feet;
    const fy = (f[0].pos.y + f[1].pos.y) * 0.5 - (f[0].planted ? 0 : 0.03) - (f[1].planted ? 0 : 0.03);
    const hy = (f[2].pos.y + f[3].pos.y) * 0.5 - (f[2].planted ? 0 : 0.03) - (f[3].planted ? 0 : 0.03);
    const gF = this.groundY(ctx, e.x + _fwd.x * 0.3 * k, e.z + _fwd.z * 0.3 * k, e.y);
    const gH = this.groundY(ctx, e.x - _fwd.x * 0.42 * k, e.z - _fwd.z * 0.42 * k, e.y);
    const frontG = lerp(gF, fy, 0.5), hindG = lerp(gH, hy, 0.5);
    this.chestY = damp(this.chestY, frontG, 14, dt);
    this.hipY = damp(this.hipY, hindG, 14, dt);
    const pitchT = Math.atan2(this.chestY - this.hipY, 0.64 * k);
    this.bodyPitch = damp(this.bodyPitch, clamp(pitchT, -0.5, 0.5), 10, dt);

    // crouches by mood; the gallop gathers and stretches
    const crouch = 0.15 * this.wStalk + 0.26 * this.wCower + 0.05 * this.wCharge + 0.06 * this.wDrag + 0.04 * this.wFeed;
    const flexG = Math.sin((ph - 0.1) * TAU); // + gathered (hind feet under), - stretched
    const bob = walk * 0.008 * Math.cos(ph * 2 * TAU) + trot * 0.022 * Math.cos(ph * 2 * TAU) + gal * 0.05 * Math.cos((ph - 0.3) * TAU);
    const hipH = (Bj[WB.pelvis * 3 + 1] - crouch * 0.9 - 0.08 * this.wCower) * k + bob;
    // pelvis at its height over the hind ground, centred between front and back
    _v.set(0, 0, Bj[WB.pelvis * 3 + 2] * k).applyQuaternion(_root);
    P.p[WB.pelvis].set(e.x + _v.x, this.hipY + hipH, e.z + _v.z);
    // flinch: a hop sideways, the hind end swinging away
    const fl = this.flinch;
    P.p[WB.pelvis].addScaledVector(_right, this.flinchSide * fl * fl * 0.12);
    P.p[WB.pelvis].y += fl * Math.sin(fl * Math.PI) * 0.06;
    // lunge: the hind legs drive the body forward and up toward the bite
    const bite = this.wBite;
    const lunge = bite * smooth(0, 0.18, e.moodT) * (1 - smooth(0.5, 0.9, e.moodT));
    P.p[WB.pelvis].addScaledVector(_fwd, lunge * 0.22 * k);
    // body rotation: slope pitch, gallop flex at the pelvis, a roll with the walk, the flinch twist
    const roll = walk * Math.sin(ph * TAU) * 0.04 + this.flinchSide * fl * 0.2;
    const pelvisPitch = this.bodyPitch * 0.9 + gal * flexG * 0.14 + 0.08 * this.wCower - lunge * 0.1;
    qYXZ(_q, this.flinchSide * fl * 0.35 + walk * Math.cos(ph * TAU) * 0.06, pelvisPitch, roll);
    P.q[WB.pelvis].multiplyQuaternions(_root, _q);
    // spine: the gallop's arch; stalking keeps the back level while the chest drops
    const arch = gal * flexG * 0.22;
    const dropChest = 0.1 * this.wStalk + 0.06 * this.wCower + 0.05 * this.wCharge - lunge * 0.35;
    qXYZ(_q, -arch * 0.5 + dropChest * 0.25, walk * Math.cos(ph * TAU) * -0.05, -roll * 0.4);
    fk(P, WB.spine1, _q);
    qXYZ(_q, -arch * 0.5 + dropChest * 0.4, walk * Math.cos(ph * TAU) * -0.04, -roll * 0.3);
    fk(P, WB.spine2, _q);
    qXYZ(_q, this.bodyPitch * 0.1 + arch * 0.3 + dropChest * 0.3 + Math.sin(this.breath) * 0.012, 0, -roll * 0.3);
    fk(P, WB.chest, _q);

    // ---- head: toward the target (or the way it goes), by mood ----
    let lookYaw = 0, lookPitch = 0;
    const aimAt = target ?? null;
    if (aimAt && (this.wAlert > 0.1 || this.wBite > 0.1 || this.wCower > 0.1)) {
      const hx = aimAt.x - e.x, hz = aimAt.z - e.z;
      const ty = aimAt.kind === 'player' ? ((aimAt as { life?: string }).life === 'alive' ? 1.2 : 0.25) : 0.6;
      lookYaw = clamp(wrap(Math.atan2(-hx, -hz) - this.yaw), -1.3, 1.3);
      const d = Math.hypot(hx, hz) || 1;
      lookPitch = clamp(Math.atan2(aimAt.y + ty - (e.y + 0.9 * k), d), -0.6, 0.6);
    } else if (this.wMove < 0.5 && this.wRest < 0.5) {
      // idle: a slow look around, now and then toward the camera
      lookYaw = Math.sin(t * 0.23 + this.seed) * 0.5 + Math.sin(t * 0.61 + this.seed * 3) * 0.2;
      lookPitch = Math.sin(t * 0.37 + this.seed) * 0.08;
      void cam;
    }
    if (this.wCower > 0.1) lookYaw += 0.4 * this.wCower * Math.sign(lookYaw || 1);
    this.headYaw = damp(this.headYaw, lookYaw, 5, dt);
    this.headPitch = damp(this.headPitch, lookPitch, 5, dt);
    // carriage: neck low and forward when stalking / charging / cowering, the nod of the walk
    const low = 0.32 * this.wStalk + 0.35 * this.wCharge * smooth(4, 9, this.spd) + 0.45 * this.wCower + 0.75 * this.wFeed + 0.35 * this.wDrag + 0.15 * this.wFlee;
    const nod = walk * Math.cos(ph * 2 * TAU) * 0.05 + trot * Math.cos(ph * 2 * TAU) * 0.03 + gal * flexG * -0.12;
    const up = lunge * 0.55 + this.flinch * 0.3;
    const hp = this.headPitch;
    qXYZ(_q, -low * 0.55 + nod + up * 0.4 + hp * 0.25 - this.bodyPitch * 0.3, this.headYaw * 0.3, 0);
    fk(P, WB.neck1, _q);
    qXYZ(_q, -low * 0.35 + nod * 0.5 + up * 0.3 + hp * 0.35, this.headYaw * 0.35, 0);
    fk(P, WB.neck2, _q);
    // the head stays near level as the neck drops (eyes on the prey)
    qXYZ(_q, low * 0.75 - nod * 0.5 + hp * 0.4 - up * 0.2 - this.bodyPitch * 0.2, this.headYaw * 0.35, 0);
    fk(P, WB.head, _q);

    // ---- jaw, ears ----
    const pant = smooth(3, 8, this.spd) * (0.08 + 0.04 * Math.sin(this.breath * 2));
    const biteOpen = bite * (smooth(0, 0.15, e.moodT) * (1 - smooth(0.25, 0.32, e.moodT)) * 0.65 + smooth(0.32, 0.6, e.moodT) * 0.12);
    const jawT = Math.max(pant, this.snarl * 0.28, this.bark * 0.45, biteOpen, this.snap * 0.5 * (1 - this.snap));
    this.jaw = damp(this.jaw, jawT, 18, dt);
    qXYZ(_q, -this.jaw, 0, 0);
    fk(P, WB.jaw, _q);
    // ears: forward and up when alert, laid back in fear, flattened in the charge and the bite
    const back = Math.max(this.wCower, this.wFlee * 0.8, this.wCharge * smooth(5, 9, this.spd) * 0.7, bite * 0.9, this.flinch, this.snarl * 0.6);
    this.ears = damp(this.ears, back, 8, dt);
    const twitch = Math.max(0, Math.sin(t * 1.3 + this.seed * 5)) > 0.995 ? 0.25 : 0;
    for (const side of [-1, 1]) {
      qXYZ(_q, -this.ears * 1.0 + twitch, side * (this.ears * 0.5 - this.wAlert * 0.1), side * this.ears * 0.35);
      fk(P, side < 0 ? WB.earL : WB.earR, _q);
    }

    // ---- tail: a damped chain, carried by mood ----
    const baseT = 0.55 * this.wAlert + 0.95 * this.wCharge * smooth(4, 9, this.spd) - 0.55 * this.wCower - 0.4 * this.wFlee + 0.2 * smooth(1, 3, this.spd) - 0.25 * this.wFeed;
    for (let i = 0; i < 4; i++) {
      const want = i === 0 ? baseT : baseT * 0.15 - (this.wCower + this.wFlee) * 0.25;
      // spring toward the carriage; the body's bounce excites it
      this.tailV[i] += ((want - this.tail[i]) * 60 - this.tailV[i] * 9) * dt + (gal * flexG + trot * Math.cos(ph * 2 * TAU) * 0.5) * dt * 2 * (i + 1) * 0.3;
      this.tail[i] += this.tailV[i] * dt;
    }
    const swish = (walk * 0.12 + trot * 0.1) * Math.sin(ph * TAU) + Math.sin(t * 0.8 + this.seed) * 0.04 * (1 - this.wMove);
    this.tailYaw = damp(this.tailYaw, swish, 6, dt);
    const tb = [WB.tail1, WB.tail2, WB.tail3, WB.tail4];
    for (let i = 0; i < 4; i++) {
      // a positive rotation about X lowers a bone that points back and down: negate to raise
      qXYZ(_q, -this.tail[i], this.tailYaw * (i + 1) * 0.5, 0);
      fk(P, tb[i], _q);
    }

    // ---- legs ----
    for (let i = 0; i < 4; i++) this.leg(P, i, ctx);
  }

  /** Solve one leg toward its foot (ground point + paw height). */
  private leg(P: Pose, i: number, ctx: AnimCtx): void {
    const k = this.scale;
    const L = LEG_BONES[i];
    const side = SIDE[i];
    const si = side < 0 ? 0 : 1;
    const f = this.feet[i];
    const front = FRONT[i];
    // the paw joint over the ground point; folds under while it swings
    const paw = _v.copy(f.pos);
    paw.y += PAW_H * k;
    const sw = f.swing;
    if (front) {
      // shoulder blade swings with the leg: forward when the paw is ahead of its rest
      const lz = (f.pos.x - P.p[WB.chest].x) * _fwd.x + (f.pos.z - P.p[WB.chest].z) * _fwd.z;
      const swingA = clamp((lz + 0.27 * k) * 1.4, -0.5, 0.6);
      qXYZ(_q, -swingA * 0.45, 0, 0);
      fk(P, L.scap, _q);
      fk(P, L.up, _q.identity());
      // wrist: above and a little behind the paw, folding back in the swing
      _a.set(0, F_FOOT * k, 0.03 * k).applyAxisAngle(_v2.set(1, 0, 0), sw * 1.4).applyQuaternion(_root);
      const wrist = _v3.copy(paw).add(_a);
      const pole = _v2.copy(_fwd).multiplyScalar(-1).addScaledVector(_right, side * 0.1);
      solveTwoBone(P.p[L.up], wrist, F_UP * k, F_LOW * k, pole, _b, _ax);
      _y1.subVectors(_b, P.p[L.up]).normalize();
      H.fUp[si].rotation(P.q[L.up], _ax, _y1);
      P.p[L.low].copy(_b);
      _y1.subVectors(wrist, _b).normalize();
      H.fLow[si].rotation(P.q[L.low], _ax, _y1);
      P.p[L.foot].copy(_b).addScaledVector(_y1, F_LOW * k);
      _y1.subVectors(paw, P.p[L.foot]).normalize();
      H.fFoot[si].rotation(P.q[L.foot], _ax, _y1);
      P.p[L.toe].copy(P.p[L.foot]).addScaledVector(_y1, F_FOOT * k);
      // toes flat on the ground, curled in the swing
      _y1.copy(_fwd).multiplyScalar(Math.cos(sw * 1.2)).addScaledVector(UP, -0.3 - Math.sin(sw * 1.2)).normalize();
      H.fToe[si].rotation(P.q[L.toe], _ax, _y1);
    } else {
      fk(P, L.up, _q.identity());
      // hock: above and behind the paw (the metatarsus raked back), more in the swing
      _a.set(0, H_META * k * 0.98, 0.04 * k).applyAxisAngle(_v2.set(1, 0, 0), -sw * 0.5).applyQuaternion(_root);
      const hock = _v3.copy(paw).add(_a);
      const pole = _v2.copy(_fwd).addScaledVector(_right, side * 0.1);
      solveTwoBone(P.p[L.up], hock, H_UP * k, H_LOW * k, pole, _b, _ax);
      _y1.subVectors(_b, P.p[L.up]).normalize();
      H.hUp[si].rotation(P.q[L.up], _ax, _y1);
      P.p[L.low].copy(_b);
      _y1.subVectors(hock, _b).normalize();
      H.hLow[si].rotation(P.q[L.low], _ax, _y1);
      P.p[L.foot].copy(_b).addScaledVector(_y1, H_LOW * k);
      _y1.subVectors(paw, P.p[L.foot]).normalize();
      H.hMeta[si].rotation(P.q[L.foot], _ax, _y1);
      P.p[L.toe].copy(P.p[L.foot]).addScaledVector(_y1, H_META * k);
      _y1.copy(_fwd).multiplyScalar(Math.cos(sw)).addScaledVector(UP, -0.3 - Math.sin(sw)).normalize();
      H.hToe[si].rotation(P.q[L.toe], _ax, _y1);
    }
    void ctx;
  }

  // ------------------------------------------------------------------------------------------
  // Special poses (into `alt`, blended over the standing pose)
  // ------------------------------------------------------------------------------------------

  /** Body frame helper: pelvis at local (0, h, z) with pitch and roll, spine pitches. */
  private body(e: WolfEnt, gy: number, h: number, z: number, pitch: number, roll: number, spine: [number, number, number]): void {
    const P = this.alt;
    const k = this.scale;
    _root.setFromAxisAngle(UP, this.yaw);
    _v.set(0, 0, z * k).applyQuaternion(_root);
    P.p[WB.pelvis].set(e.x + _v.x, gy + h * k, e.z + _v.z);
    qYXZ(_q, 0, pitch, roll);
    P.q[WB.pelvis].multiplyQuaternions(_root, _q);
    qXYZ(_q, spine[0], 0, 0);
    fk(P, WB.spine1, _q);
    qXYZ(_q, spine[1], 0, 0);
    fk(P, WB.spine2, _q);
    qXYZ(_q, spine[2], 0, 0);
    fk(P, WB.chest, _q);
  }

  private headAlt(neck1: number, neck2: number, head: number, yaw: number, jaw: number, ears: number, tail: number[], tailYaw: number): void {
    const P = this.alt;
    qXYZ(_q, neck1, yaw * 0.35, 0);
    fk(P, WB.neck1, _q);
    qXYZ(_q, neck2, yaw * 0.35, 0);
    fk(P, WB.neck2, _q);
    qXYZ(_q, head, yaw * 0.3, 0);
    fk(P, WB.head, _q);
    qXYZ(_q, -jaw, 0, 0);
    fk(P, WB.jaw, _q);
    for (const side of [-1, 1]) {
      qXYZ(_q, -ears, side * ears * 0.4, side * ears * 0.3);
      fk(P, side < 0 ? WB.earL : WB.earR, _q);
    }
    const tb = [WB.tail1, WB.tail2, WB.tail3, WB.tail4];
    for (let i = 0; i < 4; i++) {
      qXYZ(_q, -tail[i], tailYaw, 0);
      fk(P, tb[i], _q);
    }
  }

  /** Set a leg of `alt` straight to explicit joint targets: paw ground point and the wrist / hock offset. */
  private legAlt(i: number, paw: THREE.Vector3, mid: THREE.Vector3, pole: THREE.Vector3, toeDir: THREE.Vector3): void {
    const P = this.alt;
    const k = this.scale;
    const L = LEG_BONES[i];
    const si = SIDE[i] < 0 ? 0 : 1;
    const front = FRONT[i];
    if (front) {
      fk(P, L.scap, _q.identity());
      fk(P, L.up, _q);
    } else fk(P, L.up, _q.identity());
    const l1 = (front ? F_UP : H_UP) * k, l2 = (front ? F_LOW : H_LOW) * k, l3 = (front ? F_FOOT : H_META) * k;
    solveTwoBone(P.p[L.up], mid, l1, l2, pole, _b, _ax);
    _y1.subVectors(_b, P.p[L.up]).normalize();
    (front ? H.fUp : H.hUp)[si].rotation(P.q[L.up], _ax, _y1);
    P.p[L.low].copy(_b);
    _y1.subVectors(mid, _b).normalize();
    (front ? H.fLow : H.hLow)[si].rotation(P.q[L.low], _ax, _y1);
    P.p[L.foot].copy(_b).addScaledVector(_y1, l2);
    _y1.subVectors(paw, P.p[L.foot]).normalize();
    (front ? H.fFoot : H.hMeta)[si].rotation(P.q[L.foot], _ax, _y1);
    P.p[L.toe].copy(P.p[L.foot]).addScaledVector(_y1, l3);
    (front ? H.fToe : H.hToe)[si].rotation(P.q[L.toe], _ax, _y2.copy(toeDir).normalize());
  }

  /** Lying at rest like a sphinx: forelegs ahead, hind legs folded to one side; asleep, the head down. */
  private lyingRest(e: WolfEnt, ctx: AnimCtx): void {
    const k = this.scale;
    const gy = this.groundY(ctx, e.x, e.z, e.y);
    const sl = this.sleep;
    this.body(e, gy, 0.27, 0.36, 0.06, 0.12, [0.0, -0.03, -0.05]);
    const t = ctx.time;
    const look = (1 - sl) * (Math.sin(t * 0.2 + this.seed) * 0.6);
    this.headAlt(-0.3 - 0.55 * sl, -0.1 - 0.3 * sl, 0.25 + 0.2 * sl, look, 0, 0.1, [-0.6, 0.3, 0.3, 0.2], 0.5);
    const P = this.alt;
    // forelegs flat on the snow, paws ahead of the chest
    for (const i of [0, 1]) {
      const side = SIDE[i];
      const sh = P.p[LEG_BONES[i].up];
      const paw = _v.copy(sh).addScaledVector(_fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 0.42 * k).addScaledVector(_right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), side * 0.02 * k);
      paw.y = gy + 0.03 * k;
      const wrist = _v3.copy(paw).addScaledVector(_fwd, -0.09 * k);
      wrist.y = gy + 0.04 * k;
      this.legAlt(i, paw, wrist, _v2.set(0, 1, 0).addScaledVector(_fwd, 0.2), _v4.copy(_fwd));
    }
    // hind legs folded, both to the right side, hocks on the snow
    for (const i of [2, 3]) {
      const side = SIDE[i];
      const hip = P.p[LEG_BONES[i].up];
      const hock = _v3.copy(hip).addScaledVector(_fwd, -0.06 * k).addScaledVector(_right, (0.14 + side * 0.04) * k);
      hock.y = gy + 0.05 * k;
      const paw = _v.copy(hock).addScaledVector(_fwd, 0.17 * k).addScaledVector(_right, 0.02 * k);
      paw.y = gy + 0.03 * k;
      this.legAlt(i, paw, hock, _v2.copy(_fwd).addScaledVector(_right, 0.6), _v4.copy(_fwd));
    }
  }

  /** Sitting on the haunches to howl, muzzle to the sky. */
  private sitting(e: WolfEnt, ctx: AnimCtx): void {
    const k = this.scale;
    const gy = this.groundY(ctx, e.x, e.z, e.y);
    // howling comes in waves: the head rises and falls, the jaw opens on each call
    const call = 0.5 + 0.5 * Math.sin(e.moodT * 0.9);
    this.body(e, gy, 0.2, 0.3, 0.75, 0, [0.1, 0.05, 0.0]);
    this.headAlt(0.15 + 0.25 * call, 0.25 + 0.2 * call, 0.15 + 0.25 * call, 0, 0.12 + 0.18 * call, 0.6, [-1.1, 0.4, 0.3, 0.1], 0.2);
    const P = this.alt;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // forelegs straight down under the chest
    for (const i of [0, 1]) {
      const side = SIDE[i];
      const sh = P.p[LEG_BONES[i].up];
      const paw = _v.copy(sh).addScaledVector(_fwd, 0.02 * k).addScaledVector(_right, side * 0.01 * k);
      paw.y = gy + 0.035 * k;
      const wrist = _v3.copy(paw);
      wrist.y += F_FOOT * k;
      this.legAlt(i, paw, wrist, _v2.copy(_fwd).negate(), _v4.copy(_fwd));
    }
    // hind legs folded: hocks on the snow behind, paws forward under the body
    for (const i of [2, 3]) {
      const side = SIDE[i];
      const hip = P.p[LEG_BONES[i].up];
      const hock = _v3.copy(hip).addScaledVector(_fwd, -0.12 * k).addScaledVector(_right, side * 0.07 * k);
      hock.y = gy + 0.04 * k;
      const paw = _v.copy(hock).addScaledVector(_fwd, 0.19 * k);
      paw.y = gy + 0.03 * k;
      this.legAlt(i, paw, hock, _v2.copy(_fwd).addScaledVector(UP, 0.5), _v4.copy(_fwd));
    }
  }

  /** Dead on its side in the snow, legs out, still. */
  private lyingDead(e: WolfEnt, ctx: AnimCtx): void {
    const k = this.scale;
    const gy = this.groundY(ctx, e.x, e.z, e.y);
    const s = this.deadSide;
    this.body(e, gy, 0.15, 0.36, 0.02, s * 1.45, [0.05, 0.02, 0.0]);
    this.headAlt(0.05, 0.1, 0.05, s * 0.15, 0.1, 0.4, [0.3, 0.15, 0.1, 0.05], s * 0.3);
    const P = this.alt;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // legs stretched out along the snow, away from the belly side
    for (let i = 0; i < 4; i++) {
      const L = LEG_BONES[i];
      const base = P.p[L.up];
      const out = _v2.copy(_right).multiplyScalar(-s);
      const paw = _v.copy(base).addScaledVector(out, 0.55 * k).addScaledVector(_fwd, (FRONT[i] ? 0.12 : -0.08) * k);
      paw.y = gy + 0.04 * k + (SIDE[i] === -s ? 0.08 * k : 0);
      const mid = _v3.lerpVectors(base, paw, 0.72);
      mid.y += 0.02 * k;
      this.legAlt(i, paw, mid, _v4.copy(FRONT[i] ? _fwd : _fwd).multiplyScalar(FRONT[i] ? -1 : 1), _a.copy(out));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------------------------

  /** World position between the eyes (on the left eye; both are close enough for shine). */
  eyePos(out: THREE.Vector3): THREE.Vector3 {
    const b = WB.head;
    const B = S.bind;
    out.set(EYE_L.at[0] * 0 - B[b * 3], EYE_L.at[1] - B[b * 3 + 1], EYE_L.at[2] - B[b * 3 + 2]).multiplyScalar(this.scale);
    return out.applyQuaternion(this.pose.q[b]).add(this.pose.p[b]);
  }

  /** World direction the eyes look (the head's forward). */
  headDir(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, -0.2, -1).normalize().applyQuaternion(this.pose.q[WB.head]);
  }

  /** World position of a named bone ('head', 'jaw', 'chest', ...). */
  point(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const b = S.index[name];
    return b === undefined ? null : out.copy(this.pose.p[b]);
  }

  /** The scale this wolf is drawn at (bones carry it). */
  get size(): number {
    return this.scale;
  }
}

void qAxis;
void qLook;
void _q2;
void _q3;
