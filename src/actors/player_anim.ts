// Procedural animation of the player figure, driven by the entity fields only (so a remote player,
// a bot and the local player in third person all move the same way). Each frame:
//   1. smoothed state weights (crouch, air, swim, carry, aim, downed, dead, tool) and body yaw
//      (the hips follow the movement, the upper body the look);
//   2. feet: a gait phase from the ground speed; a stance foot stays planted in the world, a swing
//      foot travels from its lift-off point to a landing point predicted from the velocity, on the
//      real ground (World.groundAt) with toe-off and heel strike; at rest the feet step only to stay
//      under the body (turning on the spot);
//   3. the upright pose: pelvis (height, bob, sway, twist, lean), spine and head (look pitch / yaw,
//      breathing, shivering), hands from the held tool and the act in progress (two-bone IK from
//      the shoulders, the tool's grip fixing the hand's rotation), legs by two-bone IK to the feet;
//   4. downed / dead: a pose lying in the snow (crawling, propped on the forearms; or still), blended
//      in bone by bone so the figure collapses and gets up again.
// Units: metres, seconds, radians. World space throughout; the figure faces -Z at yaw 0.
import * as THREE from 'three/webgpu';
import type { LogEnt, PlayerEnt, ToolId } from '../sim/types';
import type { World } from '../world/types';
import { ITEM_HAND, ITEM_POINTS, gripBind } from './items';
import { A_POSE, FOREARM, PB, PLAYER_BIND, PLAYER_SKEL, SHIN, THIGH, UPPER_ARM } from './player_model';
import { Hinge, Pose, attach, fk, qAxis, qLook, qXYZ, qYXZ, solveTwoBone } from './rig';

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

/** What the animator may ask about the world around the figure. */
export interface AnimCtx {
  dt: number;
  time: number;
  world: World | null;
  /** The heavy log this player carries, if any. */
  log?: LogEnt | null;
  /** The downed player this one is reviving, if any. */
  revivee?: { x: number; y: number; z: number } | null;
  /** Far away: skip the fine layers (shiver). */
  far?: boolean;
}

interface Foot {
  planted: boolean;
  pos: THREE.Vector3; // ground point under the ankle
  yaw: number;
  from: THREE.Vector3;
  fromYaw: number;
  to: THREE.Vector3;
  toYaw: number;
  t: number; // rest step progress 0..1
  dur: number;
  lift: number;
  pitch: number; // toe-off (+) / heel strike (-)
}

interface HandGoal {
  pos: THREE.Vector3; // wrist target, world
  rot: THREE.Quaternion; // hand world rotation (when not free)
  pole: THREE.Vector3; // where the elbow points
  free: boolean; // relaxed: the hand follows the forearm
}

// ---- bind facts ----
const B = PLAYER_SKEL.bind;
const PELVIS_H = B[PB.pelvis * 3 + 1];
const ANKLE_H = PLAYER_BIND.ankle(1)[1];
const LEG = THIGH + SHIN;

// IK frames: arms bend about +X at bind, legs about -X
const hinge = {
  uparmL: new Hinge(PLAYER_SKEL, PB.uparmL, [1, 0, 0]),
  foarmL: new Hinge(PLAYER_SKEL, PB.foarmL, [1, 0, 0]),
  uparmR: new Hinge(PLAYER_SKEL, PB.uparmR, [1, 0, 0]),
  foarmR: new Hinge(PLAYER_SKEL, PB.foarmR, [1, 0, 0]),
  thighL: new Hinge(PLAYER_SKEL, PB.thighL, [-1, 0, 0]),
  shinL: new Hinge(PLAYER_SKEL, PB.shinL, [-1, 0, 0]),
  thighR: new Hinge(PLAYER_SKEL, PB.thighR, [-1, 0, 0]),
  shinR: new Hinge(PLAYER_SKEL, PB.shinR, [-1, 0, 0]),
};

// grips (item space -> hand bind space)
const GRIP = { [1]: gripBind(1), [-1]: gripBind(-1) } as Record<number, { at: THREE.Vector3; rot: THREE.Quaternion }>;
const GRIP_INV = { [1]: GRIP[1].rot.clone().invert(), [-1]: GRIP[-1].rot.clone().invert() } as Record<number, THREE.Quaternion>;
const GRIP_OFF = {
  [1]: GRIP[1].at.clone().sub(new THREE.Vector3(...PLAYER_BIND.wrist(1))),
  [-1]: GRIP[-1].at.clone().sub(new THREE.Vector3(...PLAYER_BIND.wrist(-1))),
} as Record<number, THREE.Vector3>;
// a relaxed hand: slightly flexed toward the palm
const Q_RELAX = { [1]: qAxis(new THREE.Quaternion(), 0, 0, 1, 0.14), [-1]: qAxis(new THREE.Quaternion(), 0, 0, 1, -0.14) } as Record<number, THREE.Quaternion>;
// bind hand frame (fingers along the arm, palm inward) as a basis, for handFrame()
const HAND_BASIS_T: Record<number, THREE.Matrix4> = {};
for (const side of [1, -1]) {
  const d = new THREE.Vector3(...PLAYER_BIND.armDir(side as 1 | -1));
  const palm = new THREE.Vector3(-side * Math.cos(A_POSE), -Math.sin(A_POSE), 0);
  const third = new THREE.Vector3().crossVectors(d, palm);
  HAND_BASIS_T[side] = new THREE.Matrix4().makeBasis(d, palm, third).transpose();
}
const _hm = new THREE.Matrix4(), _hm2 = new THREE.Matrix4(), _hv = new THREE.Vector3(), _hp = new THREE.Vector3();
/** Hand world rotation with the fingers along `fingers` and the palm facing `palm` (world). */
function handFrame(out: THREE.Quaternion, side: number, fingers: THREE.Vector3, palm: THREE.Vector3): THREE.Quaternion {
  _hv.copy(fingers).normalize();
  _hp.copy(palm).addScaledVector(_hv, -palm.dot(_hv)).normalize();
  const third = new THREE.Vector3();
  third.crossVectors(_hv, _hp);
  _hm.makeBasis(_hv, _hp, third);
  _hm2.multiplyMatrices(_hm, HAND_BASIS_T[side]);
  return out.setFromRotationMatrix(_hm2);
}

const itemPoint = (tool: ToolId, name: string, out: THREE.Vector3): THREE.Vector3 => {
  const p = ITEM_POINTS[tool as Exclude<ToolId, 'hands'>]?.[name];
  return p ? out.set(p[0], p[1], p[2]) : out.set(0, 0, 0);
};

// ---- scratch ----
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _a = new THREE.Vector3(), _bm = new THREE.Vector3(), _ax = new THREE.Vector3(), _y1 = new THREE.Vector3(), _x1 = new THREE.Vector3();
const _o = new THREE.Vector3(), _oa = new THREE.Vector3(), _ok = new THREE.Vector3(), _op = new THREE.Vector3();
const _look = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _root = new THREE.Quaternion();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const TOOL_IDS: ToolId[] = ['hands', 'axe', 'flashlight', 'flaregun', 'rifle', 'radio'];

export class PlayerAnimator {
  readonly pose = new Pose(PLAYER_SKEL);
  private readonly ground = new Pose(PLAYER_SKEL);
  private init = false;
  private bodyYaw = 0;
  private turning = false;
  private phase = 0;
  private spd = 0;
  private lastX = 0;
  private lastZ = 0;
  private velX = 0;
  private velZ = 0;
  private air = 0;
  private wasGround = true;
  private landHit = 0;
  private wCrouch = 0;
  private wAir = 0;
  private wSwim = 0;
  private wCarry = 0;
  private wDown = 0;
  private wDead = 0;
  private wMove = 0;
  private wRun = 0;
  private wDeep = 0;
  private sink = 0;
  private readonly wTool: Record<ToolId, number> = { hands: 1, axe: 0, flashlight: 0, flaregun: 0, rifle: 0, radio: 0 };
  private wAim = 0;
  private wRevive = 0;
  private wBend = 0;
  private lean = 0;
  private breath = 0;
  private crawl = 0;
  private recoil = 0;
  private lastAct = 'none';
  private lastActT = 0;
  private headYaw = 0;
  private headPitch = 0;
  private packLag = 0;
  private packVel = 0;
  private fallSide = 1;
  private clavL = 0;
  private clavR = 0;
  /** At rest the weight sits on one leg (+1 right, -1 left), switching now and then. */
  private standSide = 1;
  private wIdle = 0;
  private readonly seed: number;
  private readonly feet: Foot[] = [0, 1].map(() => ({
    planted: true, pos: new THREE.Vector3(), yaw: 0, from: new THREE.Vector3(), fromYaw: 0, to: new THREE.Vector3(), toYaw: 0, t: 1, dur: 0.3, lift: 0.08, pitch: 0,
  }));
  private readonly hands: HandGoal[] = [0, 1].map(() => ({ pos: new THREE.Vector3(), rot: new THREE.Quaternion(), pole: new THREE.Vector3(), free: true }));
  private readonly relaxed = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly gripRot = new THREE.Quaternion();
  private readonly gripPos = new THREE.Vector3();
  /** World transform of the held item's space (fist centre, item axes), for lights and effects. */
  readonly grip = { pos: new THREE.Vector3(), rot: new THREE.Quaternion(), tool: 'hands' as ToolId };

  constructor(seed = 0) {
    this.seed = seed;
    this.breath = (seed * 2.399) % TAU;
  }

  /** Dev: a snapshot of the gait state (bench / tool diagnostics). */
  debugState(): Record<string, unknown> {
    const r = (v: number): number => Math.round(v * 100) / 100;
    return {
      phase: r(this.phase), spd: r(this.spd), vel: [r(this.velX), r(this.velZ)], bodyYaw: r(this.bodyYaw), run: r(this.wRun), move: r(this.wMove),
      pelvisY: r(this.pose.p[PB.pelvis].y), feet: this.feet.map((f) => ({ x: r(f.pos.x), y: r(f.pos.y), z: r(f.pos.z), planted: f.planted, t: r(f.t) })),
    };
  }

  /** Snap state to the entity (first frame, teleports). */
  reset(e: PlayerEnt, ctx: AnimCtx): void {
    this.bodyYaw = e.yaw;
    this.lastX = e.x;
    this.lastZ = e.z;
    this.velX = e.vx;
    this.velZ = e.vz;
    this.wDown = e.life === 'downed' ? 1 : 0;
    this.wDead = e.life === 'dead' ? 1 : 0;
    this.wCrouch = e.crouch ? 1 : 0;
    this.wSwim = e.swim ? 1 : 0;
    this.headYaw = 0;
    this.headPitch = e.pitch;
    for (const k of TOOL_IDS) this.wTool[k] = k === e.held ? 1 : 0;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      this.restPoint(e, i === 0 ? -1 : 1, f.pos);
      f.pos.y = this.groundY(ctx, f.pos.x, f.pos.z, e.y);
      f.yaw = e.yaw;
      f.planted = true;
      f.t = 1;
      f.pitch = 0;
    }
    this.init = true;
  }

  private groundY(ctx: AnimCtx, x: number, z: number, yRef: number): number {
    if (!ctx.world) return yRef;
    const g = ctx.world.groundAt(x, z, yRef + 0.45).y;
    // never trust a ground far from the body (a ledge, a wall top): stay near the body's height
    return Math.abs(g - yRef) > 0.6 ? yRef : g;
  }

  /** Where a foot rests under the body. */
  private restPoint(e: { x: number; z: number; y: number }, s: number, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.bodyYaw), sn = Math.sin(this.bodyYaw);
    // the free leg (not carrying the weight) rests a little forward and out
    const free = this.wIdle * smooth(-0.2, 0.6, -s * this.standSide);
    const lx = s * (0.115 + 0.035 * this.wCrouch + 0.03 * this.wAim * this.wTool.rifle + 0.02 * free);
    const lz = s * 0.025 - 0.02 * this.wCrouch + s * 0.08 * this.wAim * this.wTool.rifle - 0.08 * free;
    // local (x right, z back) -> world: right = (cos, 0, -sin), back = (sin, 0, cos)
    return out.set(e.x + lx * c + lz * sn, e.y, e.z - lx * sn + lz * c);
  }

  update(e: PlayerEnt, ctx: AnimCtx): void {
    if (!this.init) this.reset(e, ctx);
    // the time since the last update; the animation integrates at most 0.1 s of it
    const gap = Math.max(0, ctx.dt);
    const dt = Math.min(gap, 0.1);
    if (Math.hypot(e.x - this.lastX, e.z - this.lastZ) > 4) this.reset(e, ctx);

    // ---------------- state weights ----------------
    const down = e.life === 'downed', dead = e.life === 'dead';
    const upright = !down && !dead;
    // ground actually covered this frame: the gait advances by distance, so the feet keep up with the
    // body while it speeds up or slows down
    const jx = e.x - this.lastX, jz = e.z - this.lastZ;
    this.lastX = e.x;
    this.lastZ = e.z;
    this.moved = Math.hypot(jx, jz);
    // more ground than this update's time explains (frames skipped by a hitch or a tool, a late snapshot):
    // the excess carries the feet along with the body, which keeps the stride instead of leaving the
    // planted feet behind; the entity's own velocity stands in for the drawn motion
    const ev = Math.hypot(e.vx, e.vz);
    const absorb = Math.max(ev, this.spd) * dt + 0.06;
    const skip = this.moved > Math.max(0.3, absorb * 1.5);
    if (skip) {
      const k = 1 - absorb / this.moved;
      this.carryFeet(jx * k, jz * k, e.y, ctx);
      this.moved = absorb;
      this.velX = e.vx;
      this.velZ = e.vz;
      this.spd = ev;
    } else if (gap > 1e-4) {
      // velocity from the motion actually drawn (an interpolated remote player's snapshot velocity can
      // disagree with its position: blocked by a tree, a late snapshot), the entity's own as a hint
      const mvx = jx / gap, mvz = jz / gap;
      const hint = Math.abs(e.vx) + Math.abs(e.vz) > 1e-4 && Math.hypot(mvx, mvz) < 0.05 ? 0.25 : 0;
      this.velX = damp(this.velX, mvx + (e.vx - mvx) * hint, 12, dt);
      this.velZ = damp(this.velZ, mvz + (e.vz - mvz) * hint, 12, dt);
    }
    const speed = Math.hypot(this.velX, this.velZ);
    this.spd = damp(this.spd, speed, 10, dt);
    const onGround = e.onGround || e.swim;
    const act = upright ? e.act : 'none';
    this.wCrouch = damp(this.wCrouch, (e.crouch || act === 'ignite') && upright && !e.swim ? 1 : 0, 9, dt);
    this.wSwim = damp(this.wSwim, e.swim ? 1 : 0, 4, dt);
    this.wCarry = damp(this.wCarry, e.carry !== 0 && upright ? 1 : 0, 6, dt);
    this.wDown = damp(this.wDown, down ? 1 : 0, down ? 3.2 : 2.4, dt);
    this.wDead = damp(this.wDead, dead ? 1 : 0, 3.2, dt);
    this.wAim = damp(this.wAim, upright ? clamp(e.aim, 0, 1) : 0, 14, dt);
    this.wRevive = damp(this.wRevive, act === 'revive' && ctx.revivee ? 1 : 0, 6, dt);
    this.wBend = damp(this.wBend, act === 'use' ? 1 : act === 'climbOut' ? 0.6 : 0, 6, dt);
    for (const k of TOOL_IDS) this.wTool[k] = damp(this.wTool[k], k === e.held ? 1 : 0, 9, dt);
    const moving = upright && onGround && !e.swim && this.spd > 0.22 && this.wRevive < 0.5;
    this.wMove = damp(this.wMove, moving ? 1 : 0, 7, dt);
    // standing at rest: the weight on one leg, changing sides every several seconds
    const idleNow = upright && !moving && e.onGround && !e.swim && !e.crouch && act === 'none' && this.wRevive < 0.1 && e.carry === 0;
    this.wIdle = damp(this.wIdle, idleNow ? 1 : 0, 1.6, dt);
    const sideWant = Math.sin(ctx.time * 0.11 + this.seed * 1.7) + 0.4 * Math.sin(ctx.time * 0.27 + this.seed) > 0 ? 1 : -1;
    this.standSide = damp(this.standSide, sideWant, 1.1, dt);
    // the sim's 2.6 m/s 'walk' is past the walk-run transition: walking it would need a stance longer than
    // the legs reach, so above ~2.1 m/s the gait leans into a light jog (shorter stance, a moment of flight)
    this.wRun = damp(this.wRun, smooth(2.1, 3.4, this.spd), 5, dt);
    if (!onGround) this.air += dt;
    if (onGround && !this.wasGround && this.air > 0.12) {
      this.landHit = Math.max(this.landHit, clamp(this.air * 1.4, 0.25, 1));
      for (const f of this.feet) {
        f.planted = false;
        f.t = 1;
      }
    }
    if (onGround) this.air = 0;
    this.wasGround = onGround;
    this.wAir = damp(this.wAir, !onGround ? 1 : 0, 14, dt);
    this.landHit = damp(this.landHit, 0, 5, dt);
    // deep snow: the feet sink into the drift and the knees come up high
    let depth = e.surface === 'deep' ? 0.35 : 0;
    if (ctx.world && (e.surface === 'snow' || e.surface === 'deep')) depth = ctx.world.snowDepthAt(e.x, e.z);
    const sinkTo = upright && e.onGround && !e.swim ? clamp(depth * 0.42, 0, 0.26) : 0;
    this.sink = damp(this.sink, sinkTo, 3, dt);
    this.wDeep = damp(this.wDeep, smooth(0.05, 0.22, sinkTo), 3, dt);
    // recoil: an impulse on the first frame of a shot
    if (act === 'shoot' && (this.lastAct !== 'shoot' || e.actT < this.lastActT)) this.recoil = 1;
    this.recoil = damp(this.recoil, 0, 9, dt);
    this.lastAct = act;
    this.lastActT = e.actT;
    if ((down || dead) && Math.max(this.wDown, this.wDead) < 0.05) this.fallSide = Math.sin(e.id * 12.9898 + 1) > 0 ? 1 : -1;

    // ---------------- body yaw ----------------
    let target = e.yaw;
    if (this.wRevive > 0.01 && ctx.revivee) target = Math.atan2(-(ctx.revivee.x - e.x), -(ctx.revivee.z - e.z));
    else if (speed > 0.3 && upright) {
      const mv = Math.atan2(-this.velX, -this.velZ);
      const rel = wrap(mv - e.yaw);
      if (Math.abs(rel) <= 1.9) target = e.yaw + clamp(rel, -0.75, 0.75);
      else target = e.yaw + clamp(wrap(rel - Math.PI * Math.sign(rel)), -0.6, 0.6);
      this.turning = false;
    } else if (upright) {
      // at rest the hips follow the look only past a threshold, then turn all the way (the feet step)
      const d = wrap(e.yaw - this.bodyYaw);
      if (Math.abs(d) > 0.95 || (this.wAim > 0.5 && Math.abs(d) > 0.3)) this.turning = true;
      if (this.turning) {
        target = e.yaw;
        if (Math.abs(d) < 0.05) this.turning = false;
      } else target = this.bodyYaw;
    } else target = this.bodyYaw;
    // after a skip the body has had the whole gap to turn
    this.bodyYaw = dampAngle(this.bodyYaw, target, speed > 0.3 ? 7 : 5, skip ? gap : dt);

    // ---------------- gait ----------------
    // stride and stance sized to the leg: a stance foot travels duty * 2 * stepLen past the hips, which must
    // stay within about +-0.4 m or the hips dive at every double support
    const stepLen = clamp(0.32 + 0.17 * this.spd, 0.4, 1.35) * (1 - 0.25 * this.wCrouch) * (1 - 0.22 * this.wDeep);
    if (moving) this.phase = (this.phase + Math.min(0.5 * stepLen, Math.max(this.moved, this.spd * dt * 0.5)) / (2 * stepLen)) % 1;
    const duty = lerp(lerp(0.6, 0.55, smooth(1.2, 2.4, this.spd)), 0.36, this.wRun);
    this.updateFeet(e, ctx, dt, moving, stepLen, duty);

    // ---------------- lean, breath ----------------
    const accel = (speed - this.spd) * 3;
    this.lean = damp(this.lean, clamp(this.spd * 0.035 + this.wRun * 0.08 + accel * 0.05, -0.1, 0.32), 5, dt);
    this.breath += dt * TAU * (0.24 + 0.5 * (1 - e.stamina) + (e.sprint ? 0.25 : 0) + 0.15 * this.wRun);

    // ---------------- poses ----------------
    this.upright(e, ctx, dt, act);
    const wl = Math.max(this.wDown, this.wDead);
    if (wl > 0.002) {
      this.lying(e, ctx, dt);
      const k = wl * wl * (3 - 2 * wl);
      for (let b = 0; b < PLAYER_SKEL.n; b++) {
        this.pose.p[b].lerp(this.ground.p[b], k);
        this.pose.q[b].slerp(this.ground.q[b], k);
      }
    }
    // the held item follows its hand
    const tool = e.held;
    this.grip.tool = tool;
    if (tool !== 'hands') {
      const side = ITEM_HAND[tool];
      const hb = side > 0 ? PB.handR : PB.handL;
      this.grip.rot.multiplyQuaternions(this.pose.q[hb], GRIP[side].rot);
      this.grip.pos.copy(GRIP_OFF[side]).applyQuaternion(this.pose.q[hb]).add(this.pose.p[hb]);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Feet
  // ------------------------------------------------------------------------------------------

  private wasMoving = false;
  private moved = 0;

  /** Move the feet (planted, swinging, landing) along with a jump of the body. */
  private carryFeet(dx: number, dz: number, y: number, ctx: AnimCtx): void {
    for (const f of this.feet) {
      for (const p of [f.pos, f.from, f.to]) {
        p.x += dx;
        p.z += dz;
        p.y = this.groundY(ctx, p.x, p.z, y);
      }
    }
  }

  private updateFeet(e: PlayerEnt, ctx: AnimCtx, dt: number, moving: boolean, stepLen: number, duty: number): void {
    const vx = this.velX, vz = this.velZ;
    const spd = Math.max(this.spd, 0.3);
    const T = (2 * stepLen) / spd;
    const c = Math.cos(this.bodyYaw), s = Math.sin(this.bodyYaw);
    const vl0 = Math.hypot(vx, vz) || 1;
    if (moving && !this.wasMoving) {
      // setting off: the foot furthest behind (along the motion) lifts first, the other is planted
      const back = (f: Foot): number => ((f.pos.x - e.x) * vx + (f.pos.z - e.z) * vz) / vl0;
      this.phase = back(this.feet[0]) <= back(this.feet[1]) ? duty : (duty + 0.5) % 1;
      for (const f of this.feet) if (f.t < 1) f.t = 1;
    }
    this.wasMoving = moving;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const side = i === 0 ? -1 : 1;
      if (this.wAir > 0.5 || e.swim) {
        f.planted = false;
        f.t = 1;
        continue;
      }
      if (moving) {
        const ph = (this.phase + (i === 0 ? 0 : 0.5)) % 1;
        if (ph < duty) {
          if (!f.planted) {
            f.planted = true;
            f.pos.copy(f.to);
            f.yaw = f.toYaw;
          }
          // never leave a planted foot beyond the leg's reach (a stop, a turn, a lag in the snapshots):
          // well behind the hips it steps at once (the other foot is down); past 0.46 m it slides after it
          const dx = f.pos.x - e.x, dz = f.pos.z - e.z;
          const d = Math.hypot(dx, dz);
          const behind = -(dx * vx + dz * vz) / (Math.hypot(vx, vz) || 1);
          const other = this.feet[1 - i];
          if (behind > 0.4 && other.planted) {
            this.phase = (duty - (i === 0 ? 0 : 0.5) + 1.0001) % 1;
            continue;
          }
          // the body turned away from a planted foot (setting off sideways): it pivots on the heel
          if (Math.abs(wrap(this.bodyYaw - f.yaw)) > 0.4) f.yaw = dampAngle(f.yaw, this.bodyYaw, 8, dt);
          if (d > 0.46) {
            f.pos.x = e.x + (dx / d) * 0.46;
            f.pos.z = e.z + (dz / d) * 0.46;
          }
          f.pitch = damp(f.pitch, 0, 14, dt);
          // late stance: the heel lifts (sooner and higher when the foot is far behind the hips)
          if (ph > duty - 0.12) f.pitch = Math.max(f.pitch, smooth(duty - 0.12, duty, ph) * 0.45 * (0.6 + this.wRun));
          f.pitch = Math.max(f.pitch, smooth(0.28, 0.44, behind) * 0.6);
        } else {
          const t = (ph - duty) / (1 - duty);
          if (f.planted) {
            f.planted = false;
            f.from.copy(f.pos);
            f.fromYaw = f.yaw;
          }
          // landing point: where the body will be at touchdown, plus half the stance travel ahead
          // (never further than the leg reaches)
          const tRem = (1 - ph) * T;
          const lead = Math.min(0.38, (duty * T * this.spd) / 2);
          const vl = Math.hypot(vx, vz) || 1;
          const lx = side * (0.11 + 0.03 * this.wCrouch);
          f.to.set(e.x + vx * tRem + (vx / vl) * lead + lx * c, 0, e.z + vz * tRem + (vz / vl) * lead - lx * s);
          f.to.y = this.groundY(ctx, f.to.x, f.to.z, e.y);
          f.toYaw = this.bodyYaw + side * 0.08;
          const u = t * t * (3 - 2 * t);
          f.pos.lerpVectors(f.from, f.to, u);
          f.yaw = f.fromYaw + wrap(f.toYaw - f.fromYaw) * u;
          // lift: higher running and in deep snow (knees up out of the drift)
          const lift = lerp(0.09, 0.2, this.wRun) + this.wDeep * 0.22 + this.wCrouch * 0.02;
          f.pos.y += Math.sin(Math.PI * Math.pow(t, 0.8)) * lift;
          // toe-off early in the swing, heel strike late
          f.pitch = t < 0.35 ? lerp(0.45 * (0.6 + this.wRun), 0.1, t / 0.35) : -0.32 * smooth(0.55, 0.92, t) * (1 - smooth(0.96, 1, t));
        }
        f.t = 1;
        continue;
      }
      // ---- at rest: step only to stay under the body ----
      const rest = this.restPoint(e, side, _v4);
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / f.dur);
        const u = f.t * f.t * (3 - 2 * f.t);
        f.to.copy(rest);
        f.to.y = this.groundY(ctx, rest.x, rest.z, e.y);
        f.toYaw = this.bodyYaw + side * 0.1;
        f.pos.lerpVectors(f.from, f.to, u);
        f.pos.y += Math.sin(Math.PI * f.t) * f.lift;
        f.yaw = f.fromYaw + wrap(f.toYaw - f.fromYaw) * u;
        f.pitch = Math.sin(Math.PI * f.t) * 0.2;
        f.planted = f.t >= 1;
        continue;
      }
      if (!f.planted) {
        // out of a run or a jump: finish with a step to the rest point
        f.from.copy(f.pos);
        f.fromYaw = f.yaw;
        f.t = 0;
        f.dur = 0.22;
        f.lift = 0.05;
        continue;
      }
      // the free leg's heel lifts a little off the snow
      const free = this.wIdle * smooth(-0.2, 0.6, -side * this.standSide);
      f.pitch = damp(f.pitch, 0.12 * free, 6, dt);
      f.pos.y = damp(f.pos.y, this.groundY(ctx, f.pos.x, f.pos.z, e.y), 20, dt);
      const err = Math.hypot(f.pos.x - rest.x, f.pos.z - rest.z);
      if (this.wIdle > 0.05 && err < 0.2) {
        // settling: shuffle the last few centimetres as the weight moves
        const k = Math.min(1, dt * 1.4 * this.wIdle);
        f.pos.x += (rest.x - f.pos.x) * k;
        f.pos.z += (rest.z - f.pos.z) * k;
      }
      const yawErr = Math.abs(wrap(f.yaw - this.bodyYaw - side * 0.1));
      const other = this.feet[1 - i];
      if ((err > 0.2 || yawErr > 0.55) && other.planted && other.t >= 1) {
        // the foot further off steps first
        const otherRest = this.restPoint(e, -side, _v3);
        const otherErr = Math.hypot(other.pos.x - otherRest.x, other.pos.z - otherRest.z);
        if (otherErr > err + 0.05 && i === 0) continue;
        f.from.copy(f.pos);
        f.fromYaw = f.yaw;
        f.t = 0;
        f.dur = 0.3;
        f.lift = 0.07 + this.wDeep * 0.15;
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Upright pose
  // ------------------------------------------------------------------------------------------

  private upright(e: PlayerEnt, ctx: AnimCtx, dt: number, act: string): void {
    const pose = this.pose;
    const t = ctx.time;
    const ph = this.phase;
    const move = this.wMove, run = this.wRun, crouch = this.wCrouch, swim = this.wSwim, aim = this.wAim, kneel = this.wRevive;
    const rifleAim = aim * this.wTool.rifle;
    const cold = smooth(35.5, 32, e.core);
    const shiverK = smooth(35.6, 33.5, e.core) * (1 - smooth(32, 30.5, e.core)) * (ctx.far ? 0 : 1);
    const tired = 1 - e.stamina;

    _root.setFromAxisAngle(UP, this.bodyYaw);
    _fwd.set(0, 0, -1).applyQuaternion(_root);
    _right.set(1, 0, 0).applyQuaternion(_root);
    const rootY = e.y - this.sink;

    // ---- pelvis ----
    const walkBob = -Math.cos(ph * 2 * TAU);
    const runBob = Math.cos((ph - 0.44) * 2 * TAU);
    const bob = move * lerp(walkBob * 0.022, runBob * 0.038, run) * (1 - crouch * 0.5);
    let h = PELVIS_H - 0.3 * crouch - 0.04 * this.wDeep - 0.17 * this.landHit + bob - 0.025 * rifleAim - 0.12 * this.wBend;
    const f0 = this.feet[0], f1 = this.feet[1];
    if (this.wAir < 0.5 && swim < 0.5) {
      // a foot below the body (downhill, a step): the pelvis drops so it still reaches
      const low = Math.min(f0.pos.y - (f0.planted ? 0 : 0.05), f1.pos.y - (f1.planted ? 0 : 0.05)) - e.y;
      h += clamp(low, -0.25, 0) * 0.85;
    }
    if (this.wAir < 0.5 && swim < 0.5 && kneel < 0.5) {
      // the hips sink so both ankles stay within reach (long strides dip at double support)
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        const side = i === 0 ? -1 : 1;
        const hx = e.x + _right.x * side * 0.092, hz = e.z + _right.z * side * 0.092;
        const d = Math.hypot(f.pos.x - hx, f.pos.z - hz);
        const reach = LEG * 0.985;
        const maxHip = f.pos.y - this.sink + ANKLE_H + Math.sqrt(Math.max(0, reach * reach - d * d));
        const maxH = maxHip + 0.03 - rootY;
        // a little dip only: past it the trailing foot pushes off on its toes instead
        if (h > maxH) h = Math.max(h - 0.07, maxH);
      }
    }
    h += this.wAir * 0.03;
    h = lerp(h, 1.04, swim);
    h = lerp(h, 0.5, kneel);
    // walking: the hips sway over the stance foot; at rest they sit over the supporting leg
    const sway = move * (1 - run) * -Math.sin(ph * TAU) * 0.022 + this.wIdle * 0.034 * this.standSide;
    const pz = 0.05 * crouch + 0.05 * kneel + 0.06 * this.wBend - this.lean * 0.05;
    _v.set(sway, h, pz + B[PB.pelvis * 3 + 2]).applyQuaternion(_root);
    pose.p[PB.pelvis].set(e.x, rootY, e.z).add(_v);
    const pelvisTwist = move * -Math.cos(ph * TAU) * lerp(0.12, 0.2, run) + rifleAim * 0.38;
    const pelvisPitch = -(this.lean * 0.5 + 0.28 * crouch + 0.1 * this.wDeep + 0.15 * kneel + 0.2 * this.wBend) + swim * 0.12;
    // the free side's hip drops (contrapposto); the spine counters it below
    const pelvisRoll = move * (1 - run) * Math.sin(ph * TAU) * 0.05 + this.wIdle * 0.055 * this.standSide;
    qYXZ(_q, pelvisTwist, pelvisPitch, pelvisRoll);
    pose.q[PB.pelvis].multiplyQuaternions(_root, _q);

    // ---- spine, chest, neck, head ----
    const lookYaw = clamp(wrap(e.yaw - this.bodyYaw - pelvisTwist), -1.6, 1.6);
    const lookPitch = clamp(e.pitch, -1.2, 1.2);
    this.headYaw = damp(this.headYaw, lookYaw, 16, dt);
    this.headPitch = damp(this.headPitch, lookPitch, 16, dt);
    const ly = this.headYaw, lp = this.headPitch;
    const breath = Math.sin(this.breath) * (0.012 + 0.02 * tired + 0.01 * this.wIdle) * (ctx.far ? 0.5 : 1);
    const shiver = shiverK * (Math.sin(t * 61 + this.seed) * 0.5 + Math.sin(t * 47.3 + this.seed * 2) * 0.5) * 0.02;
    const hunch = cold * 0.14 + tired * 0.08;
    const bend = this.lean * 0.4 + 0.2 * crouch + 0.12 * this.wDeep + hunch * 0.5 + 0.18 * kneel + 0.5 * this.wBend - swim * 0.1;
    const counter = -pelvisTwist * 0.9;
    qYXZ(_q, ly * 0.2 + counter * 0.5, -bend * 0.5 + lp * 0.1, -pelvisRoll * 0.6);
    fk(pose, PB.spine, _q);
    qYXZ(_q, ly * 0.25 + counter * 0.5, -bend * 0.5 + lp * 0.2 + breath, shiver);
    fk(pose, PB.chest, _q);
    qYXZ(_q, ly * 0.25, -hunch * 0.3 + lp * 0.3 - bend * 0.1, -shiver * 0.7);
    fk(pose, PB.neck, _q);
    // the head keeps the eyes level against the body's bend; on the rifle it drops onto the stock
    const headPitch = lp * 0.4 + bend * 0.75 + this.lean * 0.3 - pelvisPitch * 0.4 + hunch * 0.3 - rifleAim * 0.12;
    qYXZ(_q, ly * 0.3, headPitch, -rifleAim * 0.14 + shiver * 0.5);
    fk(pose, PB.head, _q);

    // ---- clavicles (how high the hands went last frame decides the shrug) ----
    for (const side of [-1, 1]) {
      const amt = side < 0 ? this.clavL : this.clavR;
      qXYZ(_q, 0, side * amt * 0.25, side * (amt * 0.3 + breath * 1.5 + cold * 0.12));
      fk(pose, side < 0 ? PB.clavL : PB.clavR, _q);
    }
    attach(pose, PB.uparmL);
    attach(pose, PB.uparmR);

    // ---- hands ----
    this.computeHands(e, ctx, dt, act);
    this.solveArm(pose, -1, this.hands[0]);
    this.solveArm(pose, 1, this.hands[1]);

    // ---- pack: lags a little behind the chest ----
    const chestUp = pose.p[PB.chest].y;
    for (let left = dt; left > 1e-6; left -= 0.03) {
      // sub-stepped: the spring is stiff for a long frame
      const h = Math.min(left, 0.03);
      this.packVel += ((chestUp - this.packLag) * 120 - this.packVel * 14) * h;
      this.packLag += this.packVel * h;
    }
    if (Math.abs(this.packLag - chestUp) > 0.3) {
      this.packLag = chestUp;
      this.packVel = 0;
    }
    qXYZ(_q, clamp((this.packLag - chestUp) * 4, -0.08, 0.08), 0, 0);
    fk(pose, PB.pack, _q);

    // ---- legs ----
    this.solveLeg(e, ctx, -1, rootY);
    this.solveLeg(e, ctx, 1, rootY);
  }

  // ------------------------------------------------------------------------------------------
  // Hands: relaxed swing, the tool, then acts that take both hands
  // ------------------------------------------------------------------------------------------

  private computeHands(e: PlayerEnt, ctx: AnimCtx, dt: number, act: string): void {
    const pose = this.pose;
    const chest = pose.q[PB.chest];
    const cp = pose.p[PB.chest];
    const move = this.wMove, run = this.wRun, swim = this.wSwim;
    const ph = this.phase;
    const t = ctx.time;
    const at = e.actT;
    const cold = smooth(35.5, 32, e.core);
    const look = _look.set(-Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(e.yaw) * Math.cos(e.pitch));
    const C = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => out.set(x, y, z).applyQuaternion(chest).add(cp);
    const CD = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 => out.set(x, y, z).applyQuaternion(chest).normalize();
    let clavL = 0, clavR = 0;

    // ---------- relaxed arms: a pendulum from each shoulder ----------
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const g = this.hands[i];
      const sh = pose.p[side < 0 ? PB.uparmL : PB.uparmR];
      // the right arm swings forward with the left leg (phase 0)
      const sw = move * Math.cos(ph * TAU) * side * lerp(0.28, 0.75, run) * (1 - 0.6 * this.wCrouch) + this.wDeep * 0.1;
      // the parka's bulk holds the arms out; cold pulls them in
      // the parka holds the arms off the body; at rest a little more, with a slow drift
      const splay = 0.2 + 0.08 * this.wDeep + 0.1 * run - cold * 0.08 + this.wIdle * (0.05 + 0.015 * Math.sin(t * 0.7 + side + this.seed));
      const elbow = lerp(0.38, 1.45, run) + move * 0.12 * Math.max(0, Math.cos(ph * TAU) * side) + cold * 0.5 + this.wCrouch * 0.3;
      // upper arm in body space (x right, y up, z back): down, out, swung forward by sw
      const ux = side * Math.sin(splay), uy = -Math.cos(splay) * Math.cos(sw), uz = -Math.cos(splay) * Math.sin(sw);
      // the forearm turned forward from the upper arm by the elbow angle
      const fx = ux * 0.6, fy = uy * Math.cos(elbow), fz = uz * Math.cos(elbow) - Math.sin(elbow);
      const fl = Math.hypot(fx, fy, fz) || 1;
      _v.set(ux * UPPER_ARM + (fx / fl) * FOREARM, uy * UPPER_ARM + (fy / fl) * FOREARM, uz * UPPER_ARM + (fz / fl) * FOREARM);
      _v.x -= side * cold * 0.08;
      _v.applyQuaternion(_root);
      g.pos.copy(sh).add(_v);
      if (swim > 0.01) {
        // treading water: sculling out in front
        const sc = Math.sin(t * 2.4 + side) * 0.18;
        _v2.set(side * (0.32 + sc), -0.05, -0.2 + Math.cos(t * 2.4 + side) * 0.08).applyQuaternion(_root);
        _v.copy(sh).add(_v2);
        g.pos.lerp(_v, swim);
      }
      g.pole.set(side * 0.35, -0.3, 1).applyQuaternion(_root).normalize();
      g.free = true;
      this.relaxed[i].copy(g.pos);
    }

    // ---------- the tool in hand ----------
    const tool = e.held;
    const wTool = tool === 'hands' ? 0 : this.wTool[tool];
    const aim = this.wAim;
    if (tool !== 'hands' && wTool > 0.01 && this.wCarry < 0.99 && swim < 0.99) {
      const side = ITEM_HAND[tool];
      const gripP = _v4, itemAxis = _a, itemKn = _bm;
      let otherOn = 0;
      _op.set(-side * 0.7, -0.6, 0.3);
      if (tool === 'rifle') {
        // low ready across the body <-> shouldered along the look; a shot kicks it back and up
        const r = this.recoil;
        const lowP = C(0.16, -0.24, -0.17, _v);
        const lowD = CD(-0.34, -0.42, -0.85, _v2);
        const kick = _y1.copy(look);
        kick.y += r * 0.12;
        kick.normalize();
        const butt = C(0.12, 0.16 + r * 0.01, -0.13 + r * 0.05, _x1);
        const aimP = _ax.copy(butt).addScaledVector(kick, 0.27).addScaledVector(UP, -0.02);
        gripP.lerpVectors(lowP, aimP, aim);
        itemKn.copy(lowD).lerp(kick, aim).normalize(); // barrel = item +Y
        if (act === 'reload') {
          const k = smooth(0, 0.15, at);
          gripP.lerp(C(0.1, -0.12, -0.3, _v2), k);
          itemKn.lerp(CD(-0.25, 0.3, -0.92, _v2), k).normalize();
        }
        itemAxis.set(0, 1, 0).addScaledVector(itemKn, -itemKn.y).normalize(); // grip axis up toward the receiver
        this.setGrip(side, gripP, itemAxis, itemKn);
        // the left hand under the fore-end, thumb along the barrel, palm up
        itemPoint('rifle', 'fore', _o).applyQuaternion(this.gripRot).add(this.gripPos);
        _oa.copy(itemKn);
        _ok.copy(_right).multiplyScalar(0.7).addScaledVector(UP, 0.5);
        otherOn = 1;
        _op.set(-0.5, -0.85, 0.1);
        // working the bolt (after a shot, and while reloading): the right hand leaves the grip
        let bolt = 0, cyc = 0;
        if (act === 'shoot') {
          bolt = smooth(0.3, 0.42, at) * (1 - smooth(0.95, 1.12, at));
          cyc = Math.sin(clamp((at - 0.4) / 0.55, 0, 1) * Math.PI);
        } else if (act === 'reload') {
          bolt = smooth(0.05, 0.25, at);
          cyc = 0.5 + 0.5 * Math.sin(at * 7.8);
        }
        if (bolt > 0.01) {
          itemPoint('rifle', 'bolt', _v2).applyQuaternion(this.gripRot).add(this.gripPos);
          _v2.addScaledVector(itemKn, -0.07 * cyc).addScaledVector(UP, 0.03 * cyc);
          this.hands[1].pos.lerp(this.wristFor(1, _v2, this.hands[1].rot, _v), bolt);
        }
        clavR = 0.45 * aim;
        clavL = 0.25 * aim;
      } else if (tool === 'axe') {
        // carried at the right side, head forward; the swing is two-handed
        gripP.copy(C(0.26, -0.43, -0.07, _v));
        itemAxis.copy(CD(0.05, 0.22, -1, _v2));
        itemKn.copy(CD(0.12, -1, 0.1, _x1));
        if (act === 'swing') {
          const s = at / 0.8;
          const w = smooth(0, 0.12, s) * (1 - smooth(0.82, 1, s));
          // wind-up over the right shoulder, the strike down in front, follow through low
          const strike = smooth(0.3, 0.42, s);
          const up = smooth(0.0, 0.3, s) * (1 - strike);
          _v.lerpVectors(C(0.17, 0.33, 0.05, _y1), C(0.02, -0.3, -0.44, _ax), strike);
          gripP.lerp(_v, w);
          _v.lerpVectors(CD(0.15, 0.6, 0.8, _y1), CD(-0.05, -0.55, -0.85, _ax), strike).normalize();
          itemAxis.lerp(_v, w).normalize();
          _v.lerpVectors(CD(0, 0.15, 1, _y1), CD(0, -0.9, -0.35, _ax), strike).normalize();
          itemKn.lerp(_v, w).normalize();
          clavR = 0.6 * up;
          clavL = 0.4 * up;
          // the left hand at the end of the handle
          qLook(_q3, itemAxis, itemKn);
          itemPoint('axe', 'end', _o).applyQuaternion(_q3).add(gripP);
          _oa.copy(itemAxis);
          _ok.copy(itemKn);
          otherOn = w;
          _op.set(-0.7, -0.55, 0.3);
        }
        this.setGrip(side, gripP, itemAxis, itemKn);
      } else if (tool === 'flashlight') {
        // in front of the chest, the beam where the eyes look; raised: up by the shoulder
        gripP.lerpVectors(C(0.15, -0.12, -0.3, _v), C(0.17, 0.13, -0.34, _v2), aim);
        itemAxis.copy(look);
        itemKn.set(0, -1, 0).addScaledVector(look, look.y).normalize();
        if (act === 'reload') {
          // a fresh cell: the torch turned up, the left hand at its tail
          const k = smooth(0, 0.15, at) * (1 - smooth(0.85, 1, at));
          gripP.lerp(C(0.1, -0.18, -0.28, _v2), k);
          itemAxis.lerp(CD(-0.3, 0.6, -0.4, _v2), k).normalize();
          qLook(_q3, itemAxis, itemKn);
          itemPoint('flashlight', 'tail', _o).applyQuaternion(_q3).add(gripP);
          _oa.copy(itemAxis);
          _ok.copy(itemKn);
          otherOn = k;
        }
        this.setGrip(side, gripP, itemAxis, itemKn);
        clavR = 0.15 + 0.3 * aim;
      } else if (tool === 'flaregun') {
        // pointed at the snow ahead at the side; raised: the arm out along the look, a kick on firing
        const r = this.recoil;
        const kick = _y1.copy(look);
        kick.y += r * 0.45;
        kick.normalize();
        gripP.lerpVectors(C(0.22, -0.3, -0.17, _v), C(0.16, 0.16, -0.5, _x1), aim).addScaledVector(UP, r * 0.05);
        itemKn.copy(CD(0.05, -0.75, -0.65, _v2)).lerp(kick, aim).normalize(); // barrel = item +Y
        if (act === 'reload') gripP.lerp(C(0.08, -0.16, -0.3, _v2), smooth(0, 0.2, at) * (1 - smooth(1.1, 1.3, at)));
        itemAxis.set(0, 1, 0).addScaledVector(itemKn, -itemKn.y).normalize();
        this.setGrip(side, gripP, itemAxis, itemKn);
        clavR = 0.45 * aim;
        if (act === 'reload') {
          // the left hand breaks it open and loads the cartridge
          itemPoint('flaregun', 'muzzle', _o).applyQuaternion(this.gripRot).add(this.gripPos);
          _oa.copy(UP);
          _ok.copy(itemKn);
          otherOn = smooth(0.2, 0.4, at) * (1 - smooth(0.9, 1.2, at));
        }
      } else if (tool === 'radio') {
        // up in front in the left fist by its handle (raised: up toward the ear); the right hand cranks
        gripP.copy(C(-0.06, -0.06 + 0.14 * aim, -0.3 - 0.04 * aim, _v));
        itemAxis.copy(CD(1, 0, -0.15, _v2)); // the handle runs across the body
        itemKn.copy(CD(0, -1, 0, _x1)); // the box hangs below
        this.setGrip(side, gripP, itemAxis, itemKn);
        const cranking = act === 'crank' ? 1 : 0;
        const ang = t * TAU * 1.6;
        const rr = 0.035 * cranking;
        itemPoint('radio', 'crankAxle', _o).applyQuaternion(this.gripRot).add(this.gripPos);
        const ra = _y1.set(-1, 0, 0).applyQuaternion(this.gripRot);
        const r1 = _ax.set(0, 1, 0).applyQuaternion(this.gripRot);
        const r2 = _x1.crossVectors(ra, r1);
        _o.addScaledVector(r1, Math.cos(ang) * rr).addScaledVector(r2, Math.sin(ang) * rr).addScaledVector(ra, 0.05);
        _oa.copy(ra);
        _ok.copy(r1);
        otherOn = 0.35 + 0.65 * cranking;
        _op.set(0.7, -0.6, 0.3);
        clavL = 0.2 + 0.25 * aim;
      }
      // the supporting hand
      if (otherOn > 0.001) {
        const oi = side > 0 ? 0 : 1;
        const os = -side;
        const g = this.hands[oi];
        qLook(_q3, _oa, _ok);
        _q2.multiplyQuaternions(_q3, GRIP_INV[os]);
        const wrist = this.wristFor(os, _o, _q2, _v);
        const w = otherOn * wTool;
        g.pos.lerp(wrist, w);
        g.rot.copy(_q2);
        g.free = w < 0.5;
        _op.applyQuaternion(_root).normalize();
        g.pole.lerp(_op, w).normalize();
      }
      // easing in from the relaxed arm while the tool comes out
      if (wTool < 0.999) this.hands[side > 0 ? 1 : 0].pos.lerp(this.relaxed[side > 0 ? 1 : 0], 1 - wTool);
    }

    // ---------- acts that take both hands ----------
    let busy = 0;
    const handsTo = (l: THREE.Vector3 | null, r: THREE.Vector3 | null, w: number): void => {
      if (w <= 0.001) return;
      if (l) this.hands[0].pos.lerp(l, w);
      if (r) this.hands[1].pos.lerp(r, w);
      busy = Math.max(busy, w);
    };
    if (act === 'use' || act === 'ignite' || act === 'eat' || act === 'climbOut') {
      const k = smooth(0, 0.18, at);
      if (act === 'use') {
        // reach forward and down
        const reach = 0.42 + 0.18 * Math.sin(Math.min(1, at / 0.6) * Math.PI);
        handsTo(C(-0.11, -0.42, -reach, _v), C(0.11, -0.4, -reach, _v2), k);
      } else if (act === 'ignite') {
        // crouched over the fire: the left hand cups the box, the right strikes across it
        const strike = Math.sin(clamp(at / 0.35, 0, 1) * Math.PI);
        handsTo(C(-0.06, -0.52, -0.4, _v), C(0.06 + strike * 0.08, -0.49 + strike * 0.04, -0.38, _v2), k);
      } else if (act === 'eat') {
        // the right hand to the mouth and back, twice
        const lift = 0.5 - 0.5 * Math.cos(clamp(at / 0.8, 0, 2) * Math.PI);
        _v2.lerpVectors(C(0.08, -0.15, -0.3, _x1), C(0.03, 0.27, -0.15, _y1), lift);
        handsTo(C(-0.08, -0.12, -0.28, _v), _v2, k);
      } else {
        // climbing out of the water: both hands on the ice ahead, pulling
        const pull = smooth(0, 1.6, at);
        handsTo(C(-0.25, 0.1 - pull * 0.4, -0.55, _v), C(0.25, 0.1 - pull * 0.4, -0.55, _v2), k);
      }
    }
    if (this.wRevive > 0.01 && ctx.revivee) {
      // kneeling at the downed teammate, both hands pressing on the back
      const r = ctx.revivee;
      const press = Math.max(0, Math.sin(t * 7)) * 0.04;
      _v.set(r.x, this.groundY(ctx, r.x, r.z, r.y) + 0.24 - press, r.z);
      handsTo(_v2.copy(_v).addScaledVector(_right, -0.1), _x1.copy(_v).addScaledVector(_right, 0.1), this.wRevive);
    }
    if (this.wCarry > 0.01 && ctx.log) {
      // both hands at the end of the heavy log
      const lg = ctx.log;
      const hx = -Math.sin(lg.yaw), hz = -Math.cos(lg.yaw);
      const half = Math.max(0.6, lg.len / 2) - 0.12;
      const ax = lg.x + hx * half, az = lg.z + hz * half, bx = lg.x - hx * half, bz = lg.z - hz * half;
      const useA = (ax - e.x) ** 2 + (az - e.z) ** 2 < (bx - e.x) ** 2 + (bz - e.z) ** 2;
      // the carried end rides at hip height (the log entity itself sits on the ground)
      _v.set(useA ? ax : bx, Math.max(lg.y + 0.22, e.y + (e.carryPair ? 0.82 : 0.7)), useA ? az : bz);
      _v2.set(hz, 0, -hx).multiplyScalar(0.09);
      handsTo(_x1.copy(_v).sub(_v2), _y1.copy(_v).add(_v2), this.wCarry);
      for (let i = 0; i < 2; i++) this.hands[i].pole.lerp(_ax.set(i === 0 ? -0.6 : 0.6, -0.5, 0.4).applyQuaternion(_root), this.wCarry).normalize();
    }
    if (busy > 0.5) for (const g of this.hands) g.free = true;

    // shrug when the hands are high
    for (let i = 0; i < 2; i++) {
      const sh = pose.p[i === 0 ? PB.uparmL : PB.uparmR];
      const hi = clamp((this.hands[i].pos.y - sh.y + 0.25) * 2, 0, 1) * 0.5;
      if (i === 0) clavL = Math.max(clavL, hi);
      else clavR = Math.max(clavR, hi);
    }
    this.clavL = damp(this.clavL, clavL, 10, dt);
    this.clavR = damp(this.clavR, clavR, 10, dt);
  }

  /** Put the fist of hand `side` at world `at`: item -Z along `axis`, item +Y toward `knuckles`. */
  private setGrip(side: 1 | -1, at: THREE.Vector3, axis: THREE.Vector3, knuckles: THREE.Vector3): void {
    const g = this.hands[side > 0 ? 1 : 0];
    qLook(this.gripRot, axis, knuckles);
    this.gripPos.copy(at);
    g.rot.multiplyQuaternions(this.gripRot, GRIP_INV[side]);
    this.wristFor(side, at, g.rot, g.pos);
    g.free = false;
    g.pole.set(side * 0.6, -0.75, 0.25).applyQuaternion(_root).normalize();
  }

  /** Wrist position that puts the fist of hand `side` (hand rotation `rot`) at `fist`. */
  private wristFor(side: number, fist: THREE.Vector3, rot: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
    _x1.copy(GRIP_OFF[side]).applyQuaternion(rot);
    return out.copy(fist).sub(_x1);
  }

  // ------------------------------------------------------------------------------------------
  // IK
  // ------------------------------------------------------------------------------------------

  private solveArm(P: Pose, side: 1 | -1, g: HandGoal): void {
    const up = side > 0 ? PB.uparmR : PB.uparmL, fo = side > 0 ? PB.foarmR : PB.foarmL, ha = side > 0 ? PB.handR : PB.handL;
    const A = P.p[up];
    solveTwoBone(A, g.pos, UPPER_ARM, FOREARM, g.pole, _bm, _ax);
    _y1.subVectors(_bm, A).normalize();
    (side > 0 ? hinge.uparmR : hinge.uparmL).rotation(P.q[up], _ax, _y1);
    P.p[fo].copy(_bm);
    _y1.subVectors(g.pos, _bm).normalize();
    (side > 0 ? hinge.foarmR : hinge.foarmL).rotation(P.q[fo], _ax, _y1);
    P.p[ha].copy(_bm).addScaledVector(_y1, FOREARM);
    if (g.free) P.q[ha].multiplyQuaternions(P.q[fo], Q_RELAX[side]);
    else P.q[ha].copy(g.rot);
  }

  private solveLeg(e: PlayerEnt, ctx: AnimCtx, side: 1 | -1, rootY: number): void {
    const pose = this.pose;
    const f = this.feet[side > 0 ? 1 : 0];
    const th = side > 0 ? PB.thighR : PB.thighL, sh = side > 0 ? PB.shinR : PB.shinL, ft = side > 0 ? PB.footR : PB.footL;
    attach(pose, th);
    const hip = pose.p[th];
    if (this.wAir > 0.01 || this.wSwim > 0.01) {
      // dangling under the body: legs a little bent, one ahead (gait at take-off), slow kicks swimming
      const kick = this.wSwim > 0.5 ? Math.sin(ctx.time * 3 + side) * 0.15 : Math.cos(this.phase * TAU) * side * 0.12;
      _v2.set(side * 0.13, -LEG * 0.86 - ANKLE_H * 0.8, -kick).applyQuaternion(_root).add(pose.p[PB.pelvis]);
      f.pos.lerp(_v2, Math.max(this.wAir, this.wSwim));
    }
    // foot frame: facing the foot's yaw, laid half way onto the slope
    _fwd.set(-Math.sin(f.yaw), 0, -Math.cos(f.yaw));
    _up.set(0, 1, 0);
    if (ctx.world && f.planted && this.wAir < 0.5) {
      const n = ctx.world.normalAt(f.pos.x, f.pos.z);
      _up.set(n.x * 0.5, 1, n.z * 0.5).normalize();
    }
    _fwd.addScaledVector(_up, -_fwd.dot(_up)).normalize();
    qLook(_q, _fwd, _up);
    // toe-off (pitch > 0) rolls about the ball, heel strike about the heel
    const p = f.pitch;
    _right.crossVectors(_fwd, _up).normalize();
    qAxis(_q2, _right.x, _right.y, _right.z, -p);
    pose.q[ft].multiplyQuaternions(_q2, _q);
    const lever = p > 0 ? 0.13 : -0.07;
    const ankle = _v3.set(0, ANKLE_H, 0).applyQuaternion(_q);
    if (Math.abs(p) > 1e-4) {
      _v4.copy(_fwd).multiplyScalar(lever);
      ankle.sub(_v4).applyQuaternion(_q2).add(_v4);
    }
    ankle.add(f.pos);
    // deep snow: the boots go down into the drift with the body (the legs stay straight, the snow hides the
    // boots) instead of standing on its surface with bent knees
    ankle.y -= this.sink;
    // the knee points where the hips face (a little toward the foot): never sideways off a turned foot
    const pole = _v2.set(-Math.sin(this.bodyYaw), 0, -Math.cos(this.bodyYaw)).multiplyScalar(0.7).addScaledVector(_fwd, 0.3).addScaledVector(_right, side * 0.12);
    if (this.wRevive > 0.01) {
      // kneeling: the left knee down, its shin back along the snow; the right foot planted ahead
      const k = this.wRevive;
      const c = Math.cos(this.bodyYaw), s = Math.sin(this.bodyYaw);
      if (side < 0) _a.set(e.x - 0.12 * c + 0.42 * s, rootY + 0.1, e.z + 0.12 * s + 0.42 * c);
      else _a.set(e.x + 0.15 * c - 0.2 * s, rootY + ANKLE_H, e.z - 0.15 * s - 0.2 * c);
      ankle.lerp(_a, k);
      if (side < 0) {
        qLook(_q3, _v.set(0, -1, 0).addScaledVector(_fwd, 0.6), _v4.copy(_fwd).negate().addScaledVector(UP, 0.3));
        pose.q[ft].slerp(_q3, k);
      }
    }
    solveTwoBone(hip, ankle, THIGH, SHIN, pole, _bm, _ax);
    _y1.subVectors(_bm, hip).normalize();
    (side > 0 ? hinge.thighR : hinge.thighL).rotation(pose.q[th], _ax, _y1);
    pose.p[sh].copy(_bm);
    _y1.subVectors(ankle, _bm).normalize();
    (side > 0 ? hinge.shinR : hinge.shinL).rotation(pose.q[sh], _ax, _y1);
    pose.p[ft].copy(_bm).addScaledVector(_y1, SHIN);
  }

  // ------------------------------------------------------------------------------------------
  // Lying in the snow: downed (propped on the forearms, crawling) or dead (still)
  // ------------------------------------------------------------------------------------------

  private lying(e: PlayerEnt, ctx: AnimCtx, dt: number): void {
    const P = this.ground;
    const dead = this.wDead > this.wDown;
    if (!dead && this.spd > 0.05) this.crawl += (this.spd / 0.55) * dt;
    const cr = this.crawl * TAU;
    const crawlK = dead ? 0 : smooth(0.05, 0.25, this.spd);
    const yaw = this.bodyYaw;
    const gy = this.groundY(ctx, e.x, e.z, e.y);
    // face down, head toward the facing: the figure's up axis lies along the facing
    _root.setFromAxisAngle(UP, yaw);
    qAxis(_q, 1, 0, 0, -Math.PI / 2 + (dead ? 0.02 : 0.06));
    const lie = _q3.multiplyQuaternions(_root, _q);
    if (dead) {
      // a little on one side
      qAxis(_q2, 0, 1, 0, this.fallSide * 0.35);
      lie.multiply(_q2);
    }
    _v.set(0, 0.15, 0.36).applyQuaternion(_root);
    P.p[PB.pelvis].set(e.x, gy, e.z).add(_v);
    qYXZ(_q, 0, 0, crawlK * Math.sin(cr) * 0.08);
    P.q[PB.pelvis].multiplyQuaternions(lie, _q);
    // the spine curls up onto the forearms (downed) or lies flat (dead)
    const prop = dead ? 0 : 0.32 + 0.06 * e.revive;
    const breath = Math.sin(this.breath) * (dead ? 0 : 0.025);
    qYXZ(_q, crawlK * Math.sin(cr) * 0.1, prop * 0.4, 0);
    fk(P, PB.spine, _q);
    qYXZ(_q, crawlK * Math.sin(cr) * 0.08, prop * 0.6 + breath, 0);
    fk(P, PB.chest, _q);
    qYXZ(_q, dead ? 0 : -crawlK * Math.sin(cr) * 0.1, dead ? -0.1 : 0.45, 0);
    fk(P, PB.neck, _q);
    // the head: up to look ahead (downed), turned on its cheek (dead)
    qYXZ(_q, dead ? this.fallSide * 1.15 : 0, dead ? 0.1 : 0.55, dead ? this.fallSide * 0.35 : 0);
    fk(P, PB.head, _q);
    _q.identity();
    fk(P, PB.clavL, _q);
    fk(P, PB.clavR, _q);
    fk(P, PB.pack, _q);
    attach(P, PB.uparmL);
    attach(P, PB.uparmR);
    const fwd = _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = _right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    // arms: forearms on the snow ahead of the shoulders, reaching in turn while crawling
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const sh = P.p[side < 0 ? PB.uparmL : PB.uparmR];
      const reach = crawlK * Math.sin(cr + (side > 0 ? Math.PI : 0)) * 0.16;
      const g = this.hands[i];
      if (dead) {
        const up = side === this.fallSide;
        g.pos.copy(sh).addScaledVector(fwd, up ? 0.42 : -0.36).addScaledVector(right, side * (up ? 0.24 : 0.14));
      } else g.pos.copy(sh).addScaledVector(fwd, 0.34 + reach).addScaledVector(right, side * 0.06);
      g.pos.y = gy + 0.06 + (dead ? 0 : Math.max(0, reach) * 0.15);
      g.pole.set(side * 0.8, -0.6, 0).applyQuaternion(_root).normalize();
      handFrame(g.rot, side, fwd, _v2.set(0, -1, 0));
      g.free = false;
      this.solveArm(P, side as 1 | -1, g);
    }
    // legs: straight back along the snow, a knee drawn up in turn while crawling
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const th = side > 0 ? PB.thighR : PB.thighL, sh = side > 0 ? PB.shinR : PB.shinL, ft = side > 0 ? PB.footR : PB.footL;
      attach(P, th);
      const hip = P.p[th];
      const draw = crawlK * Math.max(0, Math.sin(cr + (side > 0 ? 0 : Math.PI))) * 0.28 + (dead && side === this.fallSide ? 0.3 : 0);
      const ankle = _v.copy(hip).addScaledVector(fwd, -(LEG * 0.92 - draw)).addScaledVector(right, side * (0.1 + draw * 0.4));
      ankle.y = gy + 0.09;
      const pole = _v2.set(0, -1, 0).addScaledVector(right, side * 0.4);
      solveTwoBone(hip, ankle, THIGH, SHIN, pole, _bm, _ax);
      _y1.subVectors(_bm, hip).normalize();
      (side > 0 ? hinge.thighR : hinge.thighL).rotation(P.q[th], _ax, _y1);
      P.p[sh].copy(_bm);
      _y1.subVectors(ankle, _bm).normalize();
      (side > 0 ? hinge.shinR : hinge.shinL).rotation(P.q[sh], _ax, _y1);
      P.p[ft].copy(_bm).addScaledVector(_y1, SHIN);
      // toes dug into the snow, soles up
      qLook(P.q[ft], _v3.set(0, -1, 0).addScaledVector(fwd, -0.35), _v4.copy(fwd).negate());
    }
  }
}
