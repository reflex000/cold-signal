// The first-person animator: from the predicted local player (view.me) and the feel values of the
// rig (view.rig), every frame, where the held tool is (camera space), how its moving parts sit,
// where each hand is and how closed, which small extra a hand holds, the flashlight beam, the
// match flame and how far the rifle scope is up. Everything is recomputed from scratch each frame
// (base pose -> act -> procedural feel -> equip blend), so nothing drifts; only springs (recoil,
// look lag) and a few eased values carry state.
//
// Timing follows the simulation: acts play on a local clock that runs smoothly between snapshots
// and is pulled to me.actT (the axe lands on SWING_HIT, the bolt cycle fills BOLT_TIME, the flare
// cartridge goes in at the sim's moment ...). Constants come from the systems that own the acts
// (sim/systems/tools.ts, wood.ts, items.ts, fire.ts).
//
// Camera space: x right, y up, -z forward, metres; the camera is at the origin (viewmodel FOV).
// Poses are P6 = [x, y, z, pitch, yaw, roll] (Euler YXZ).
import * as THREE from 'three/webgpu';
import type { View } from '../../game/view';
import type { PlayerEnt } from '../../sim/types';
import { CELL_DIM, CELL_SWAP, FLARE_RECOVER, FLARE_RELOAD, RELOAD_CLOSE, RELOAD_OPEN, RELOAD_ROUND, RIFLE_MAG } from '../../sim/systems/tools';
import { SWING_HIT, SWING_TIME } from '../../sim/systems/wood';
import { EAT_TIME } from '../../sim/systems/items';
import { IGNITE_TIME } from '../../sim/systems/fire';
import type { ExtraName, Tool } from '../../models/tools';
import { FLARE_BREECH_Z, FLARE_BORE_Y, FLARE_HINGE, RADIO_NEEDLE_SWEEP, RIFLE_BOLT_LIFT, RIFLE_BOLT_TRAVEL, gripMatrix, toolModel } from '../../models/tools';
import { makeHandPose, type HandPose } from './arms';

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const sat = (v: number): number => clamp(v, 0, 1);
const sstep = (a: number, b: number, v: number): number => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const damp = (a: number, b: number, k: number, dt: number): number => b + (a - b) * Math.exp(-k * dt);
/** Smooth 0 -> 1 -> 0 bump over [a, b]. */
const bump = (a: number, b: number, v: number): number => (v <= a || v >= b ? 0 : Math.sin(((v - a) / (b - a)) * Math.PI));
/** Cheap smooth noise in about [-1, 1]. */
const wob = (t: number, s: number): number => Math.sin(t * 1.31 + s) * 0.55 + Math.sin(t * 2.71 + s * 1.7) * 0.3 + Math.sin(t * 5.13 + s * 2.3) * 0.15;

/** Flare gun barrel open angle (radians about +X, negative opens) and the flashlight cap's travel. */
export const FLARE_OPEN = 0.78;
const CAP_PULL = 0.078;

export type P6 = [number, number, number, number, number, number];

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

function p6(out: P6, a: Readonly<P6>): P6 {
  for (let i = 0; i < 6; i++) out[i] = a[i];
  return out;
}
function mix6(out: P6, a: Readonly<P6>, b: Readonly<P6>, t: number): P6 {
  for (let i = 0; i < 6; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}
function add6(out: P6, d: Readonly<P6>, k = 1): P6 {
  for (let i = 0; i < 6; i++) out[i] += d[i] * k;
  return out;
}

/** Catmull-Rom through keys [t, P6] (t ascending), clamped at the ends. */
function track(out: P6, keys: readonly (readonly [number, Readonly<P6>])[], t: number): P6 {
  const n = keys.length;
  if (t <= keys[0][0]) return p6(out, keys[0][1]);
  if (t >= keys[n - 1][0]) return p6(out, keys[n - 1][1]);
  let i = 0;
  while (i < n - 2 && t > keys[i + 1][0]) i++;
  const k0 = keys[Math.max(0, i - 1)][1], k1 = keys[i][1], k2 = keys[i + 1][1], k3 = keys[Math.min(n - 1, i + 2)][1];
  const u = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
  const u2 = u * u, u3 = u2 * u;
  for (let c = 0; c < 6; c++) {
    const a = k0[c], b = k1[c], cc = k2[c], d = k3[c];
    out[c] = 0.5 * (2 * b + (-a + cc) * u + (2 * a - 5 * b + 4 * cc - d) * u2 + (-a + 3 * b - 3 * cc + d) * u3);
  }
  return out;
}

/**
 * A hand pose from readable directions (camera space): where the fingers point (wrist -> knuckles)
 * and which way the palm faces. side 1 right, -1 left (the hand frame's X is the palm side of a
 * right hand and the back of a left one).
 */
export function hp(side: 1 | -1, x: number, y: number, z: number, fingers: readonly [number, number, number], palm: readonly [number, number, number], out: P6 = [0, 0, 0, 0, 0, 0]): P6 {
  const Y = _hy.set(fingers[0], fingers[1], fingers[2]).normalize();
  const X = _hx.set(palm[0], palm[1], palm[2]);
  X.addScaledVector(Y, -X.dot(Y)).normalize().multiplyScalar(side);
  const Z = _hz.crossVectors(X, Y);
  _hm.makeBasis(X, Y, Z);
  _he.setFromRotationMatrix(_hm, 'YXZ');
  out[0] = x; out[1] = y; out[2] = z; out[3] = _he.x; out[4] = _he.y; out[5] = _he.z;
  return out;
}
const _hx = new THREE.Vector3();
const _hy = new THREE.Vector3();
const _hz = new THREE.Vector3();
const _hm = new THREE.Matrix4();
const _he = new THREE.Euler();

function mat6(out: THREE.Matrix4, a: Readonly<P6>): THREE.Matrix4 {
  _e.set(a[3], a[4], a[5], 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(_v.set(a[0], a[1], a[2]), _q, _one);
}

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _sc = new THREE.Vector3();
/** Blend two rigid matrices (position lerp, rotation slerp) into out (may alias a or b). */
function blendM(out: THREE.Matrix4, a: THREE.Matrix4, b: THREE.Matrix4, t: number): THREE.Matrix4 {
  a.decompose(_pa, _qa, _sc);
  b.decompose(_pb, _qb, _sc);
  _pa.lerp(_pb, t);
  _qa.slerp(_qb, t);
  return out.compose(_pa, _qa, _one);
}

/** A damped spring per P6 channel. */
class Spring6 {
  readonly x: P6 = [0, 0, 0, 0, 0, 0];
  readonly v: P6 = [0, 0, 0, 0, 0, 0];
  constructor(private k: number, private c: number) {}
  kick(d: Readonly<P6>, k = 1): void {
    for (let i = 0; i < 6; i++) this.v[i] += d[i] * k;
  }
  step(dt: number, target: Readonly<P6> | null = null): void {
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < 6; i++) {
        const goal = target ? target[i] : 0;
        this.v[i] += (-this.k * (this.x[i] - goal) - this.c * this.v[i]) * h;
        this.x[i] += this.v[i] * h;
      }
    }
  }
  reset(): void {
    this.x.fill(0);
    this.v.fill(0);
  }
}

// ------------------------------------------------------------------------------------------
// Output
// ------------------------------------------------------------------------------------------

export interface ExtraOut {
  name: ExtraName;
  on: boolean;
  /** Camera-space transform (filled at the end of update). */
  m: THREE.Matrix4;
  /** 'tool': `local` is in the tool's model space; 'cam': `m` was written directly. */
  rel: 'tool' | 'cam';
  local: THREE.Matrix4;
  /** For the glow material (the match head). */
  glow: number;
}

export interface FpOut {
  /** Anything drawn at all. */
  visible: boolean;
  /** Tool drawn (null: hands only). */
  tool: Tool | null;
  /** Model space -> camera space of the tool. */
  toolM: THREE.Matrix4;
  bolt: { lift: number; back: number };
  hammer: number; // 0 down .. 1 cocked
  trigger: number; // 0 .. 1 pulled
  barrel: number; // flare gun open 0 .. 1
  crank: number; // radians
  needle: number; // radians about +Z of the needle pivot
  /** Flashlight tail cap: its transform in the tool's model space (identity = screwed on). */
  capM: THREE.Matrix4;
  lampGlow: number;
  radioGlow: number;
  hands: [HandPose, HandPose];
  /** Arms drawn at all. */
  arms: boolean;
  extras: ExtraOut[];
  flame: { on: boolean; pos: THREE.Vector3; k: number };
  /** Flashlight lamp position and beam direction (camera space), output 0..1 with flicker, focus 0..1, warm 0..1 (dying cell). */
  beam: { on: boolean; pos: THREE.Vector3; dir: THREE.Vector3; k: number; focus: number; warm: number };
  /** 0..1: the rifle scope over the eye. */
  scope: number;
  /** A spent case to throw (camera space), consumed by the system. */
  eject: { pending: boolean; pos: THREE.Vector3; vel: THREE.Vector3 };
}

const EXTRAS: ExtraName[] = ['matchbox', 'match', 'ration', 'thermos', 'bandage', 'cartridge', 'round', 'cell', 'case'];

// ------------------------------------------------------------------------------------------
// Rest poses (camera space P6 of the tool's model space)
// ------------------------------------------------------------------------------------------

interface ToolPoses {
  idle: P6;
  /** Raised (SECONDARY) where the tool has one. */
  up: P6;
  /** Sprinting: carried lower and turned in. */
  run: P6;
  /** Lowered out of view (equip / unequip / hands busy). */
  away: P6;
  /** Hand closure on the grips [right, left]. */
  curl: [number, number];
  /** Which hands hold it at rest. */
  hands: [boolean, boolean];
}

// The tool's model origin is the main fist (the radio: the centre of the box). The viewmodel FOV
// shows |y| < 0.51 d and |x| < 0.9 d at depth d (16:9): a fist at (0.15, -0.155, -0.36) sits in the
// lower right with the forearm coming in from the corner.
export const POSES: Record<Tool, ToolPoses> = {
  axe: {
    idle: [0.19, -0.2, -0.38, -0.95, 0.15, -0.35],
    up: [0.19, -0.2, -0.38, -0.95, 0.15, -0.35],
    run: [0.22, -0.26, -0.32, -1.25, 0.35, -0.55],
    away: [0.26, -0.6, -0.2, -1.4, 0.3, -0.5],
    curl: [1, 1],
    hands: [true, false],
  },
  flashlight: {
    idle: [0.16, -0.19, -0.38, 0.2, 0.05, -0.15],
    up: [0.1, -0.13, -0.43, 0.07, 0.02, -0.08],
    run: [0.19, -0.24, -0.3, -0.35, 0.3, 0.2],
    away: [0.24, -0.55, -0.18, -0.9, 0.3, 0.2],
    curl: [1, 0.5],
    hands: [true, false],
  },
  flaregun: {
    idle: [0.16, -0.165, -0.36, 0.03, 0.1, -0.05],
    up: [0.16, -0.165, -0.36, 0.03, 0.1, -0.05],
    run: [0.19, -0.25, -0.3, -0.45, 0.35, 0.25],
    away: [0.23, -0.56, -0.18, -0.95, 0.3, 0.3],
    curl: [1, 0.45],
    hands: [true, false],
  },
  rifle: {
    idle: [0.15, -0.23, -0.3, 0.04, 0.1, 0.25],
    up: [0, -0.103, -0.146, 0, 0, 0],
    run: [0.1, -0.24, -0.32, -0.35, 0.7, 0.45],
    away: [0.2, -0.6, -0.12, -0.7, 0.5, 0.5],
    curl: [1, 0.78],
    hands: [true, true],
  },
  radio: {
    idle: [-0.06, -0.12, -0.43, -0.32, 0.28, 0.03],
    up: [-0.035, -0.065, -0.36, -0.16, 0.18, 0.0],
    run: [-0.12, -0.26, -0.3, -0.8, 0.3, 0.2],
    away: [-0.18, -0.58, -0.18, -1.2, 0.3, 0.2],
    curl: [1, 0.18],
    hands: [false, true],
  },
};

/** Default shoulders (camera space) and elbow poles. */
const SHOULDER_R = new THREE.Vector3(0.19, -0.28, 0.07);
const SHOULDER_L = new THREE.Vector3(-0.19, -0.28, 0.07);
const POLE_R = new THREE.Vector3(0.75, -0.65, 0.15);
const POLE_L = new THREE.Vector3(-0.75, -0.65, 0.15);
/** The rifle at the shoulder pulls the right shoulder in and up. */
const SHOULDER_AIM = new THREE.Vector3(-0.035, 0.04, -0.03);

/** Hands off screen (relaxed, low at the sides). */
const REST_R: P6 = hp(1, 0.25, -0.5, -0.1, [-0.15, -0.35, -1], [-1, 0.3, 0]);
const REST_L: P6 = hp(-1, -0.25, -0.5, -0.1, [0.15, -0.35, -1], [1, 0.3, 0]);

interface Grips {
  r: THREE.Matrix4;
  l: THREE.Matrix4;
  a: Record<string, THREE.Matrix4>;
}

export interface FpInputs {
  dt: number;
  time: number;
  view: View;
  /** The carried log's held end in camera space, or null. */
  logEnd: THREE.Vector3 | null;
}

/** Per-frame choices of the tool act. */
interface ActGrip {
  r: boolean;
  l: boolean;
  /** Hand frames in the tool's model space (null: the tool's own grip). */
  rGrip: THREE.Matrix4 | null;
  lGrip: THREE.Matrix4 | null;
  curlR: number;
  curlL: number;
  thumbR: number;
  thumbL: number;
  /** How far the left hand is on its grip (0: still at rest, 1: on it), so it reaches rather than jumps. */
  lk: number;
}

export class FpAnimator {
  readonly out: FpOut;
  private grips = new Map<Tool, Grips>();
  private shown: Tool | null = null;
  private raise = 0;
  private act: PlayerEnt['act'] = 'none';
  private actT = 0;
  private actTool: PlayerEnt['held'] = 'hands';
  private eatWhat: 'ration' | 'thermos' | 'bandage' = 'ration';
  private lastInv = { ration: 0, thermos: 0, bandage: 0 };
  private lastLoaded = 0;
  private loadT = -1;
  private igniteFail = false;
  private recoil = new Spring6(260, 22);
  private lag = new Spring6(90, 14);
  private aim = 0;
  private sprint = 0;
  private crouch = 0;
  private lightOn = false;
  private click = 0;
  private flicker = 1;
  private flickTarget = 1;
  private flickT = 0;
  private needle = 0;
  private crank = 0;
  private crankV = 0;
  private prevYaw = 0;
  private prevPitch = 0;
  private hasPrev = false;
  private dryT = 9;
  private hammer = 1;
  private crawl = 0;
  private swim = 0;
  private carryK = 0;
  private downK = 0;
  private boltEjected = true;
  private wantEject = false;
  private base: P6 = [0, 0, 0, 0, 0, 0];
  private tmp: P6 = [0, 0, 0, 0, 0, 0];
  private tmp2: P6 = [0, 0, 0, 0, 0, 0];
  private handR: P6 = [0, 0, 0, 0, 0, 0];
  private handL: P6 = [0, 0, 0, 0, 0, 0];
  private gripR = new THREE.Matrix4();
  private gripL = new THREE.Matrix4();
  private actGrip: ActGrip = { r: true, l: false, rGrip: null, lGrip: null, curlR: 1, curlL: 0.5, thumbR: 1, thumbL: 0.5, lk: 1 };
  private actHands = { curlR: 0.35, curlL: 0.35, thumbR: 0.4, thumbL: 0.4 };
  private boltPivot = new THREE.Vector3();
  private crankAxle = new THREE.Vector3();
  private capPivot = new THREE.Vector3();

  constructor() {
    this.out = {
      visible: false,
      tool: null,
      toolM: new THREE.Matrix4(),
      bolt: { lift: 0, back: 0 },
      hammer: 1,
      trigger: 0,
      barrel: 0,
      crank: 0,
      needle: -RADIO_NEEDLE_SWEEP,
      capM: new THREE.Matrix4(),
      lampGlow: 0,
      radioGlow: 0,
      hands: [makeHandPose(), makeHandPose()],
      arms: false,
      extras: EXTRAS.map((name) => ({ name, on: false, m: new THREE.Matrix4(), rel: 'cam' as const, local: new THREE.Matrix4(), glow: 0 })),
      flame: { on: false, pos: new THREE.Vector3(), k: 0 },
      beam: { on: false, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), k: 0, focus: 0, warm: 0 },
      scope: 0,
      eject: { pending: false, pos: new THREE.Vector3(), vel: new THREE.Vector3() },
    };
    const bolt = toolModel('rifle', 0).parts.bolt;
    if (bolt) this.boltPivot.copy(bolt.pivot);
    const crank = toolModel('radio', 0).parts.crank;
    if (crank) this.crankAxle.copy(crank.pivot);
    const cap = toolModel('flashlight', 0).parts.cap;
    if (cap) this.capPivot.copy(cap.pivot);
  }

  private gripsOf(tool: Tool): Grips {
    let g = this.grips.get(tool);
    if (!g) {
      const def = toolModel(tool, 0);
      const a: Record<string, THREE.Matrix4> = {};
      for (const name of Object.keys(def.anchors)) a[name] = gripMatrix(def, name);
      g = { r: gripMatrix(def, 'gripR'), l: gripMatrix(def, 'gripL'), a };
      this.grips.set(tool, g);
    }
    return g;
  }

  private extra(name: ExtraName): ExtraOut {
    return this.out.extras[EXTRAS.indexOf(name)];
  }

  /** Hold an extra in the tool's model space (resolved after the tool's final matrix). */
  private holdOnTool(name: ExtraName, local: THREE.Matrix4): void {
    const x = this.extra(name);
    x.on = true;
    x.rel = 'tool';
    x.local.copy(local);
  }

  /** A sim event about the local player. */
  event(t: string, hit?: string): void {
    switch (t) {
      case 'shot':
        if (this.aim > 0.8) this.recoil.kick([0, 0.01, 0.35, 2.2, 0.25, 0.35]);
        else this.recoil.kick([0.04, 0.08, 0.95, 7.5, 0.9, 1.6]);
        this.boltEjected = false;
        break;
      case 'flareShot':
        this.recoil.kick([0.02, 0.12, 0.45, 9, 0.5, 0.8]);
        this.hammer = 0;
        break;
      case 'swing':
        if (hit === 'wood') this.recoil.kick([-0.05, 0.15, 0.6, 5.5, 0.8, 0.6]);
        else if (hit === 'wolf') this.recoil.kick([-0.04, 0.08, 0.35, 3.5, 0.5, 0.4]);
        else if (hit === 'ground') this.recoil.kick([0, 0.25, 0.3, 4.5, 0.2, 0.2]);
        break;
      case 'dry':
        this.dryT = 0;
        this.hammer = 0;
        this.recoil.kick([0, 0.01, 0.04, 0.5, 0, 0]);
        break;
      case 'igniteFail':
        this.igniteFail = true;
        break;
    }
  }

  /** Snap everything (a teleport, a new game). */
  reset(): void {
    this.shown = null;
    this.raise = 0;
    this.recoil.reset();
    this.lag.reset();
    this.hasPrev = false;
    this.act = 'none';
  }

  /** Dev: the tool shown and up at once (bench poses). */
  snap(me: PlayerEnt): void {
    this.shown = me.held === 'hands' ? null : me.held;
    this.raise = 1;
    this.aim = me.aim;
    this.lightOn = me.lightOn;
    this.act = 'none';
    this.actT = 0;
    this.recoil.reset();
    this.lag.reset();
    this.hasPrev = false;
    this.lastInv.ration = me.inv.ration ?? 0;
    this.lastInv.thermos = me.inv.thermos ?? 0;
    this.lastInv.bandage = me.inv.bandage ?? 0;
    this.lastLoaded = me.loaded;
    this.hammer = 1;
    this.dryT = 9;
    this.click = 0;
    this.boltEjected = true;
  }

  update(inp: FpInputs): FpOut {
    const out = this.out;
    const { dt, time, view } = inp;
    const me = view.me;
    const rig = view.rig;
    const cam = view.camera;
    for (const e of out.extras) {
      e.on = false;
      e.rel = 'cam';
      e.glow = 0;
    }
    out.flame.on = false;
    out.eject.pending = false;
    out.trigger = 0;
    out.barrel = 0;
    out.capM.identity();
    out.bolt.lift = 0;
    out.bolt.back = 0;
    out.scope = 0;
    out.beam.on = false;
    out.lampGlow = 0;
    out.radioGlow = 0;
    if (!me || me.life === 'dead' || me.life === 'rescued') {
      out.visible = false;
      out.arms = false;
      this.hasPrev = false;
      return out;
    }

    // ---------------- smoothed inputs ----------------
    this.aim = damp(this.aim, me.aim, 30, dt);
    this.sprint = damp(this.sprint, me.sprint && rig.speed > 3 ? 1 : 0, 8, dt);
    this.crouch = damp(this.crouch, me.crouch ? 1 : 0, 10, dt);
    this.downK = damp(this.downK, me.life === 'downed' ? 1 : 0, 6, dt);
    this.swim = damp(this.swim, me.swim ? 1 : 0, 5, dt);
    this.carryK = damp(this.carryK, me.carry !== 0 && inp.logEnd ? 1 : 0, 7, dt);
    if (this.hasPrev) {
      let dy = cam.yaw - this.prevYaw;
      if (dy > Math.PI) dy -= TAU;
      if (dy < -Math.PI) dy += TAU;
      const dp = cam.pitch - this.prevPitch;
      const wy = clamp(dy / Math.max(dt, 1e-3), -6, 6), wp = clamp(dp / Math.max(dt, 1e-3), -6, 6);
      // the hands trail the turn: they keep pointing a little where the view was (turning right, wy < 0,
      // leaves them left and pointing left), and lean into it
      this.tmp[0] = wy * 0.006; this.tmp[1] = -wp * 0.004; this.tmp[2] = 0;
      this.tmp[3] = -wp * 0.025; this.tmp[4] = -wy * 0.03; this.tmp[5] = wy * 0.02;
      this.lag.step(dt, this.tmp);
    }
    this.prevYaw = cam.yaw;
    this.prevPitch = cam.pitch;
    this.hasPrev = true;
    this.recoil.step(dt);

    // ---------------- act clock ----------------
    if (me.act !== this.act) {
      if (me.act === 'eat') {
        const inv = me.inv;
        if ((inv.bandage ?? 0) < this.lastInv.bandage) this.eatWhat = 'bandage';
        else if ((inv.thermos ?? 0) < this.lastInv.thermos) this.eatWhat = 'thermos';
        else this.eatWhat = 'ration';
      }
      if (me.act === 'ignite') this.igniteFail = false;
      if (me.act === 'reload') this.loadT = -1;
      this.act = me.act;
      this.actT = me.actT;
      this.actTool = me.held;
    } else {
      this.actT += dt;
      const d = me.actT - this.actT;
      if (Math.abs(d) > 0.15) this.actT = me.actT;
      else this.actT += d * Math.min(1, dt * 6);
    }
    this.lastInv.ration = me.inv.ration ?? 0;
    this.lastInv.thermos = me.inv.thermos ?? 0;
    this.lastInv.bandage = me.inv.bandage ?? 0;
    if (me.loaded > this.lastLoaded && this.act === 'reload') this.loadT = this.actT;
    this.lastLoaded = me.loaded;
    this.dryT += dt;

    // ---------------- which tool is up ----------------
    const want: Tool | null = me.held === 'hands' ? null : me.held;
    const handsBusy = me.life !== 'alive' || me.swim || me.carry !== 0 ||
      this.act === 'ignite' || this.act === 'eat' || this.act === 'use' || this.act === 'revive' || this.act === 'climbOut' ||
      (this.act === 'crank' && me.held !== 'radio');
    if (this.shown !== want) {
      // down (0.2 s), then the new one comes up with whatever time is left of this frame
      const r = this.raise - dt / 0.2;
      if (r <= 0) {
        this.shown = want;
        this.lightOn = me.lightOn;
        this.raise = handsBusy ? 0 : Math.min(1, (-r * 0.2) / 0.34);
      } else this.raise = r;
    } else if (handsBusy) this.raise = Math.max(0, this.raise - dt / 0.22);
    else this.raise = Math.min(1, this.raise + dt / 0.34);
    const up = sstep(0, 1, this.raise);
    const tool = this.shown;

    out.hands[0].shoulder.copy(SHOULDER_R);
    out.hands[1].shoulder.copy(SHOULDER_L);
    out.hands[0].pole.copy(POLE_R);
    out.hands[1].pole.copy(POLE_L);
    let rOn = false, lOn = false;
    let curlR = 0.35, curlL = 0.35, thumbR = 0.4, thumbL = 0.4;

    if (tool) {
      const P = POSES[tool];
      const base = this.base;
      const aimK = sstep(0, 1, this.aim);
      mix6(base, P.idle, P.up, aimK);
      mix6(base, base, P.run, this.sprint * (1 - aimK));
      if (tool === 'rifle') out.hands[0].shoulder.addScaledVector(SHOULDER_AIM, aimK);
      // act, then the procedural feel on top, then the equip blend
      const ag = this.toolAct(tool, me, base, dt);
      this.feel(base, view, time, tool === 'rifle' ? aimK : 0);
      mix6(base, P.away, base, up);
      mat6(out.toolM, base);
      // extras held relative to the tool, a spent case thrown
      for (const x of out.extras) if (x.on && x.rel === 'tool') x.m.multiplyMatrices(out.toolM, x.local);
      if (this.wantEject) {
        this.wantEject = false;
        this.ejectCase();
      }
      // the hands on their grips; a free hand rests off screen
      rOn = ag.r;
      lOn = ag.l;
      if (rOn) this.handFromTool(out.hands[0], out.toolM, ag.rGrip ?? this.gripsOf(tool).r);
      else this.setHand(out.hands[0], REST_R);
      if (lOn) {
        this.handFromTool(out.hands[1], out.toolM, ag.lGrip ?? this.gripsOf(tool).l);
        if (ag.lk < 1) this.blendHand(out.hands[1], REST_L, 1 - ag.lk);
      }
      else this.setHand(out.hands[1], REST_L);
      curlR = ag.curlR; curlL = ag.curlL; thumbR = ag.thumbR; thumbL = ag.thumbL;
      this.tools(tool, me, dt, time, up);
    } else {
      this.setHand(out.hands[0], REST_R);
      this.setHand(out.hands[1], REST_L);
    }

    // ---------------- hands acts (the tool is away or going) ----------------
    const k = this.handsActs(me, inp, time);
    if (k > 0) {
      const h = this.actHands;
      curlR = lerp(curlR, h.curlR, k); curlL = lerp(curlL, h.curlL, k);
      thumbR = lerp(thumbR, h.thumbR, k); thumbL = lerp(thumbL, h.thumbL, k);
      this.blendHand(out.hands[0], this.handR, k);
      this.blendHand(out.hands[1], this.handL, k);
    }

    out.hands[0].curl = curlR;
    out.hands[1].curl = curlL;
    out.hands[0].thumb = thumbR;
    out.hands[1].thumb = thumbL;
    out.tool = tool && up > 0.01 ? tool : null;
    const handsIn = (rOn || lOn) && up > 0.01;
    out.arms = handsIn || k > 0.001;
    out.visible = cam.third < 0.5 && (out.tool !== null || out.arms) && out.scope < 0.55;
    return out;
  }

  /** Bob, breath, cold sway, shiver, landing, look lag and recoil on a tool pose. */
  private feel(base: P6, view: View, time: number, aimK: number): void {
    const rig = view.rig;
    const steady = 1 - 0.75 * aimK;
    const ph = rig.bob * TAU;
    const st = rig.stride * (1 - 0.6 * this.crouch) * steady;
    const run = this.sprint;
    // walk / run: a figure of eight, two dips per stride cycle
    base[0] += Math.sin(ph) * 0.011 * st * (1 + run * 0.8);
    base[1] += (Math.cos(ph * 2) * 0.5 - 0.5) * 0.012 * st * (1 + run * 0.9) - 0.004 * st;
    base[3] += Math.cos(ph * 2) * 0.012 * st * (1 + run);
    base[4] += Math.sin(ph) * 0.016 * st * (1 + run);
    base[5] += Math.sin(ph) * 0.02 * st * (1 + run);
    // breathing
    const br = Math.sin(rig.breath * TAU);
    base[1] += br * 0.0028 * steady;
    base[3] += br * 0.006 * steady;
    // idle drift
    base[0] += wob(time * 0.35, 1.1) * 0.0022 * steady;
    base[1] += wob(time * 0.31, 4.2) * 0.0018 * steady;
    base[4] += wob(time * 0.27, 2.5) * 0.004 * steady;
    // cold and exhaustion: a slow wander that grows
    const sw = rig.sway * steady;
    base[0] += wob(time * 0.6, 7.7) * 0.009 * sw;
    base[1] += wob(time * 0.55, 3.1) * 0.007 * sw;
    base[3] += wob(time * 0.7, 5.3) * 0.02 * sw;
    base[4] += wob(time * 0.65, 9.4) * 0.025 * sw;
    // shivering: a fine fast tremor in the hands
    const sh = rig.shiver;
    if (sh > 0.001) {
      base[0] += Math.sin(time * 41.3) * Math.sin(time * 3.7) * 0.0016 * sh;
      base[1] += Math.sin(time * 37.9 + 1.2) * Math.sin(time * 2.9 + 0.4) * 0.0018 * sh;
      base[3] += Math.sin(time * 45.1 + 2.1) * 0.008 * sh;
      base[5] += Math.sin(time * 39.4 + 0.7) * 0.007 * sh;
    }
    // landing: the hands drop and come back up
    base[1] -= rig.landing * 0.05;
    base[3] -= rig.landing * 0.12;
    // crouch: a little lower and closer
    base[1] -= this.crouch * 0.012;
    base[2] += this.crouch * 0.01;
    add6(base, this.lag.x, steady * 0.9 + 0.1);
    add6(base, this.recoil.x);
  }

  // ----------------------------------------------------------------------------------------
  // Tool acts
  // ----------------------------------------------------------------------------------------

  private toolAct(tool: Tool, me: PlayerEnt, base: P6, dt: number): ActGrip {
    const P = POSES[tool];
    const a = this.actGrip;
    a.r = P.hands[0]; a.l = P.hands[1]; a.rGrip = null; a.lGrip = null; a.lk = 1;
    a.curlR = P.curl[0]; a.curlL = P.curl[1]; a.thumbR = 1; a.thumbL = 0.6;
    const mine = this.act !== 'none' && this.actTool === tool;
    const t = this.actT;
    const g = this.gripsOf(tool);
    switch (tool) {
      case 'axe': {
        if (mine && this.act === 'swing') {
          // wind up over the right shoulder, the blade lands on SWING_HIT, follow through, recover
          track(this.tmp, AXE_SWING, t);
          const w = sstep(0, 0.05, t) * (1 - sstep(SWING_TIME - 0.1, SWING_TIME, t));
          mix6(base, base, this.tmp, w);
          // the left hand takes the knob for the blow only (through the wind-up it would reach across the view)
          a.lk = sstep(0.2, 0.28, t) * (1 - sstep(0.6, 0.72, t));
          a.l = a.lk > 0;
          a.lGrip = g.a.gripL;
          // the right hand slides down the haft as the blow comes
          a.rGrip = blendM(this.gripR, g.r, g.a.gripR2 ?? g.r, sstep(0.18, 0.3, t) * (1 - sstep(0.5, 0.7, t)));
        }
        return a;
      }
      case 'flashlight': {
        if (mine && this.act === 'reload') this.cellSwap(t / CELL_SWAP, base, g, a);
        else a.thumbR = 1 - this.click * 0.6;
        return a;
      }
      case 'flaregun': {
        if (mine && this.act === 'shoot') {
          this.out.trigger = 1 - sstep(0.1, 0.5, t / FLARE_RECOVER);
        } else if (mine && this.act === 'reload') {
          this.flareReload(t / FLARE_RELOAD, base, g, a, dt);
        } else if (this.dryT < 0.35) {
          this.out.trigger = bump(0, 0.35, this.dryT);
        } else if (me.flareLoaded > 0) this.hammer = Math.min(1, this.hammer + dt * 4);
        return a;
      }
      case 'rifle':
        this.rifleAct(me, base, g, a, mine, t);
        return a;
      case 'radio': {
        if (mine && this.act === 'crank') {
          a.r = true;
          a.curlR = 1;
          // the knob goes round with the crank; the hand follows it without turning
          const A = this.crankAxle;
          _m.makeTranslation(A.x, A.y, A.z).multiply(_m3.makeRotationX(this.crank)).multiply(_m2.makeTranslation(-A.x, -A.y, -A.z));
          _v.setFromMatrixPosition(g.r).applyMatrix4(_m);
          this.gripR.copy(g.r).setPosition(_v);
          a.rGrip = this.gripR;
          // the turning rocks the radio a little
          base[0] += Math.sin(this.crank) * 0.004;
          base[1] += Math.cos(this.crank) * 0.005;
          base[3] += Math.sin(this.crank) * 0.03;
        }
        return a;
      }
    }
    return a;
  }

  /** Flashlight cell change, s = 0..1: tail to the left hand, unscrew, cap and old cell out, new in, screw on. */
  private cellSwap(s: number, base: P6, g: Grips, a: ActGrip): void {
    track(this.tmp, FLASH_SWAP, s);
    mix6(base, base, this.tmp, sstep(0, 0.14, s) * (1 - sstep(0.86, 1, s)));
    a.l = s > 0.06 && s < 0.94;
    a.curlL = 0.62;
    a.thumbL = 0.7;
    // the cap's path in model space: unscrew (turning), pull off along +Z with the cell, away, back, screw on
    const unscrew = sstep(0.14, 0.3, s) * (1 - sstep(0.7, 0.84, s));
    const pull = sstep(0.3, 0.4, s) * (1 - sstep(0.58, 0.68, s));
    const away = bump(0.4, 0.58, s);
    const turn = (sstep(0.14, 0.3, s) - sstep(0.7, 0.84, s)) * -Math.PI * 3;
    const C = this.capPivot;
    _m.makeTranslation(0, -away * 0.13, unscrew * 0.004 + pull * CAP_PULL + away * 0.05);
    _m.multiply(_m2.makeTranslation(C.x, C.y, C.z)).multiply(_m3.makeRotationZ(turn)).multiply(_m2.makeTranslation(-C.x, -C.y, -C.z));
    this.out.capM.copy(_m);
    // the left hand is rigid with the cap (it wobbles its wrist while unscrewing)
    this.gripL.multiplyMatrices(_m, g.l);
    a.lGrip = this.gripL;
    // the cell rides out in the cap and goes back in (a fresh one)
    if (pull > 0.02) {
      _m2.makeRotationX(Math.PI / 2).setPosition(C.x, C.y, C.z - 0.035);
      this.holdOnTool('cell', _m3.multiplyMatrices(_m, _m2));
    }
  }

  /** Flare gun reload, s = 0..1: in to the middle, barrel drops open, cartridge in, flick shut. */
  private flareReload(s: number, base: P6, g: Grips, a: ActGrip, dt: number): void {
    track(this.tmp, FLARE_LOAD, s);
    const inK = sstep(0, 0.12, s) * (1 - sstep(0.9, 1, s));
    mix6(base, base, this.tmp, inK);
    // (POLISH: lower and further out while it is loaded, so the loading arm does not cross the eye)
    base[1] -= inK * 0.05;
    base[2] -= inK * 0.1;
    const open = sstep(0.16, 0.3, s) * (1 - sstep(0.8, 0.86, s));
    this.out.barrel = open;
    // the open chamber in model space
    const H = FLARE_HINGE;
    _m.makeTranslation(H[0], H[1], H[2]).multiply(_m3.makeRotationX(-FLARE_OPEN * open)).multiply(_m2.makeTranslation(-H[0], -H[1], -H[2]));
    // cartridge: comes up from below, slides into the chamber by the sim's load moment (0.9 / 1.3)
    const ins = sstep(0.5, 0.68, s);
    const rise = sstep(0.32, 0.52, s);
    _m2.makeRotationX(-Math.PI / 2).setPosition(0, FLARE_BORE_Y, FLARE_BREECH_Z + 0.05 * (1 - ins) + 0.0325);
    _m3.multiplyMatrices(_m, _m2);
    if (rise < 1) {
      // from low behind the gun
      _m2.makeRotationFromEuler(_e.set(0.6, 0.4, 0.2)).setPosition(-0.14, -0.2, -0.02);
      blendM(_m3, _m2, _m3, sstep(0, 1, rise));
    }
    const holding = s > 0.32 && s < 0.7;
    if (holding) this.holdOnTool('cartridge', _m3);
    // the left hand beside the cartridge (the gun's left), fingers along it toward the chamber,
    // the palm turned to it: the cartridge sits in the fingertips
    _m2.makeRotationY(Math.PI).setPosition(-0.036, -0.05, -0.012);
    this.gripL.multiplyMatrices(_m3, _m2);
    a.l = s > 0.3 && s < 0.74;
    a.lGrip = this.gripL;
    a.curlL = 0.6;
    a.thumbL = 0.85;
    // the thumb cocks the hammer as it closes
    if (s > 0.86) this.hammer = Math.min(1, this.hammer + dt * 6);
    void g;
  }

  private rifleAct(me: PlayerEnt, base: P6, g: Grips, a: ActGrip, mine: boolean, t: number): void {
    const out = this.out;
    const aimed = this.aim > 0.8;
    if (mine && this.act === 'shoot') {
      out.trigger = 1 - sstep(0.06, 0.25, t);
      if (aimed) {
        // the bolt is worked with the cheek on the stock: only the jolts reach the scope
        base[3] += bump(0.4, 0.62, t) * 0.012 - bump(0.62, 0.8, t) * 0.01;
        base[2] += bump(0.4, 0.62, t) * 0.006;
        return;
      }
      // from the hip: hand to the knob, lift, back (the case flies), forward, down, back to the grip
      const toKnob = sstep(0.16, 0.3, t) * (1 - sstep(0.88, 1.02, t));
      out.bolt.lift = sstep(0.3, 0.4, t) * (1 - sstep(0.76, 0.86, t));
      out.bolt.back = sstep(0.42, 0.56, t) * (1 - sstep(0.62, 0.76, t));
      // the rifle rolls toward the shooter and goes out a little, so the working hand is not in the eye
      base[5] += toKnob * 0.32;
      base[3] += toKnob * 0.08;
      base[0] -= toKnob * 0.015;
      // (POLISH: further out and lower, the working mitt's cuff came up to the eye)
      base[1] -= toKnob * 0.05;
      base[2] -= toKnob * 0.14;
      if (!this.boltEjected && t > 0.54) {
        this.boltEjected = true;
        this.wantEject = true;
      }
      if (toKnob > 0) {
        a.rGrip = this.boltKnobGrip(g, toKnob);
        a.curlR = lerp(1, 0.55, toKnob);
      }
    } else if (mine && this.act === 'reload') {
      // open, rounds in one at a time, close: the right hand works the bolt and thumbs the rounds in
      const open = sstep(0.0, RELOAD_OPEN, t);
      const full = me.loaded >= RIFLE_MAG || (me.inv.ammo ?? 0) <= 0;
      const closing = full && this.loadT >= 0 ? sat((t - this.loadT) / RELOAD_CLOSE) : 0;
      const tilt = open * (1 - sstep(0.4, 1, closing));
      base[1] -= tilt * 0.035;
      base[2] -= tilt * 0.02;
      base[3] += tilt * 0.12;
      base[4] -= tilt * 0.15;
      base[5] += tilt * 0.55;
      out.bolt.lift = sstep(0.05, 0.2, t) * (1 - sstep(0.62, 0.85, closing));
      out.bolt.back = sstep(0.2, 0.38, t) * (1 - sstep(0.15, 0.6, closing));
      const cyc = t < RELOAD_OPEN ? -1 : ((t - RELOAD_OPEN) % RELOAD_ROUND) / RELOAD_ROUND;
      if (closing <= 0 && cyc >= 0) {
        // the right hand: down out of view for a round, up to the open action, thumb it in
        const down = 1 - sstep(0.1, 0.45, cyc), press = sstep(0.75, 0.95, cyc);
        const port = g.a.port;
        _m.copy(port).multiply(_m2.makeTranslation(0.03 + 0.06 * down, -0.035 + 0.15 * down - 0.012 * press, 0.05 + 0.14 * down));
        _m.multiply(_m2.makeRotationFromEuler(_e.set(0.5, -0.6, -1.9)));
        this.gripR.copy(_m);
        a.rGrip = this.gripR;
        a.curlR = 0.45;
        a.thumbR = 0.2 + 0.8 * press;
        if (cyc < 0.92) {
          _m2.makeRotationFromEuler(_e.set(0, 0, Math.PI / 2 - 0.2)).setPosition(-0.006, 0.075, -0.01);
          this.holdOnTool('round', _m3.multiplyMatrices(this.gripR, _m2));
        }
      } else if (t < RELOAD_OPEN || closing > 0) {
        const k = t < RELOAD_OPEN ? sstep(0.0, 0.12, t) : 1 - sstep(0.7, 1, closing);
        a.rGrip = this.boltKnobGrip(g, k);
        a.curlR = lerp(1, 0.55, k);
      }
    } else if (this.dryT < 0.4) {
      out.trigger = bump(0, 0.3, this.dryT);
    }
  }

  /** The right hand on the bolt knob (moving with the bolt), blended from the pistol grip by k. */
  private boltKnobGrip(g: Grips, k: number): THREE.Matrix4 {
    const out = this.out;
    const P = this.boltPivot;
    _m.makeTranslation(P.x, P.y, P.z + out.bolt.back * RIFLE_BOLT_TRAVEL)
      .multiply(_m3.makeRotationZ(out.bolt.lift * RIFLE_BOLT_LIFT))
      .multiply(_m2.makeTranslation(-P.x, -P.y, -P.z));
    this.gripR.multiplyMatrices(_m, g.a.boltKnob);
    if (k < 0.999) {
      blendM(this.gripR, g.r, this.gripR, k);
      // an arc: the hand lifts a little on the way
      this.gripR.elements[13] += Math.sin(k * Math.PI) * 0.025;
    }
    return this.gripR;
  }

  private ejectCase(): void {
    const e = this.out.eject;
    _m.multiplyMatrices(this.out.toolM, this.gripsOf('rifle').a.port);
    e.pos.setFromMatrixPosition(_m);
    e.vel.set(1.5, 1.3, 0.5).applyQuaternion(_q.setFromRotationMatrix(this.out.toolM));
    e.pending = true;
  }

  /** Lamp, needle, crank, hammer and the rifle scope, once the tool's matrix is known. */
  private tools(tool: Tool, me: PlayerEnt, dt: number, time: number, up: number): void {
    const out = this.out;
    out.hammer = this.hammer;
    if (tool === 'flashlight') {
      if (me.lightOn !== this.lightOn) {
        this.lightOn = me.lightOn;
        this.click = 1;
        this.recoil.kick([0, -0.004, 0.01, -0.25, 0, 0]);
      }
      this.click = Math.max(0, this.click - dt * 7);
      const lvl = me.beam ?? (me.lightOn ? 1 : 0);
      // a dying cell: the bulb sags, flickers, sometimes nearly goes out
      const low = me.cellCharge < CELL_DIM ? 1 - me.cellCharge / CELL_DIM : 0;
      this.flickT -= dt;
      if (this.flickT <= 0) {
        const r = Math.abs(Math.sin(time * 91.7 + me.cellCharge * 400));
        this.flickT = 0.03 + 0.06 * r + 0.3 * (1 - low) * r;
        this.flickTarget = low > 0 ? 1 - low * (r > 0.8 ? 0.85 : 0.4 * r) : 1;
      }
      this.flicker = damp(this.flicker, this.flickTarget, low > 0 ? 45 : 8, dt);
      const k = me.lightOn ? lvl * this.flicker : 0;
      _m.multiplyMatrices(out.toolM, this.gripsOf('flashlight').a.lamp);
      out.beam.pos.setFromMatrixPosition(_m);
      out.beam.dir.set(0, 0, -1).applyQuaternion(_q.setFromRotationMatrix(out.toolM)).normalize();
      out.beam.on = k > 0.001 && up > 0.5;
      out.beam.k = k * sstep(0.5, 1, up);
      out.beam.focus = sstep(0, 1, this.aim);
      out.beam.warm = low;
      out.lampGlow = k * 6;
    } else if (tool === 'radio') {
      const charged = me.radioCharge > 0;
      // the needle: the signal, trembling with static when weak; a slow mechanical meter
      const target = charged ? me.radioSig : 0;
      const noise = charged ? (1 - me.radioSig) * 0.07 * wob(time * 9, 3.3) : 0;
      this.needle = damp(this.needle, target + noise, charged ? 5 : 3, dt);
      out.needle = -RADIO_NEEDLE_SWEEP + 2 * RADIO_NEEDLE_SWEEP * clamp(this.needle, 0, 1);
      out.radioGlow = charged ? 0.8 + 0.25 * me.radioSig + 0.05 * Math.sin(time * 50) : 0;
      const cranking = this.act === 'crank' && me.held === 'radio';
      this.crankV = damp(this.crankV, cranking ? 13 : 0, cranking ? 6 : 4, dt);
      this.crank = (this.crank + this.crankV * dt) % TAU;
      out.crank = this.crank;
    } else if (tool === 'rifle') {
      out.scope = sstep(0.8, 0.97, this.aim) * sstep(0.85, 1, up) * (this.act === 'reload' ? 0 : 1);
    }
  }

  // ----------------------------------------------------------------------------------------
  // Hands acts: match, eat, drink, bandage, open, revive, climb out, carry, crawl, swim
  // ----------------------------------------------------------------------------------------

  /** Fills handR / handL and actHands; returns how far the hands are in (0 = no act). */
  private handsActs(me: PlayerEnt, inp: FpInputs, time: number): number {
    const t = this.actT;
    const R = this.handR, L = this.handL;
    const res = this.actHands;
    res.curlR = 0.35; res.curlL = 0.35; res.thumbR = 0.4; res.thumbL = 0.4;
    let k = 0;
    const at = (P: P6, src: Readonly<P6>, x: number, y: number, z: number): void => {
      p6(P, src);
      P[0] = x; P[1] = y; P[2] = z;
    };
    if (this.downK > 0.02) {
      // crawling: the hands reach forward on the snow in turn, low in the view
      this.crawl += inp.dt * (Math.hypot(me.vx, me.vz) > 0.1 ? 2.2 : 0.35);
      for (const side of [1, -1] as const) {
        const ph = this.crawl * Math.PI + (side > 0 ? 0 : Math.PI);
        const reach = Math.sin(ph) * 0.5 + 0.5;
        at(side > 0 ? R : L, side > 0 ? CRAWL_R : CRAWL_L, side * 0.17, -0.165 + Math.max(0, Math.cos(ph)) * 0.035, -0.3 - reach * 0.16);
      }
      res.curlR = res.curlL = 0.25;
      k = this.downK;
    } else if (this.swim > 0.02) {
      // a slow breaststroke at the surface
      const ph = time * 1.4;
      const c = Math.sin(ph) * 0.5 + 0.5;
      for (const side of [1, -1] as const) at(side > 0 ? R : L, side > 0 ? SWIM_R : SWIM_L, side * (0.06 + 0.2 * c), -0.125 + 0.02 * Math.cos(ph), -0.44 + 0.14 * c);
      res.curlR = res.curlL = 0.15;
      k = this.swim;
    } else if (this.carryK > 0.02 && inp.logEnd) {
      // both hands on the end of the log
      const e = inp.logEnd;
      const ex = clamp(e.x, -0.25, 0.25), ey = clamp(e.y, -0.6, -0.14), ez = clamp(e.z, -0.55, -0.22);
      const heave = Math.sin(inp.view.rig.bob * TAU * 2) * 0.006;
      at(R, CARRY_R, ex + 0.075, ey + 0.03 + heave, ez + 0.03);
      at(L, CARRY_L, ex - 0.075, ey + 0.03 + heave, ez + 0.03);
      res.curlR = res.curlL = 0.85;
      k = this.carryK;
    } else if (this.act === 'ignite') {
      k = this.ignite(t, R, L, res);
    } else if (this.act === 'eat') {
      k = this.eat(t, R, L, res);
    } else if (this.act === 'use') {
      // reach to the lid and lift it
      const s = sat(t / 0.6);
      k = sstep(0, 0.25, s);
      const lift = 0.04 * sstep(0.5, 1, s);
      at(R, USE_R, USE_R[0], USE_R[1] + lift, USE_R[2] - 0.03 * s);
      at(L, USE_L, USE_L[0], USE_L[1] + lift, USE_L[2] - 0.03 * s);
      res.curlR = res.curlL = 0.55;
    } else if (this.act === 'revive') {
      // both hands down on the teammate, pressing in a rhythm
      k = sstep(0, 0.35, t);
      const pump = Math.max(0, Math.sin(t * TAU * 1.6)) * 0.03;
      at(R, REVIVE_R, REVIVE_R[0], REVIVE_R[1] - pump, REVIVE_R[2]);
      at(L, REVIVE_L, REVIVE_L[0], REVIVE_L[1] - pump, REVIVE_L[2]);
      res.curlR = res.curlL = 0.2;
    } else if (this.act === 'climbOut') {
      // flat hands on the ice edge, pushing up
      k = sstep(0, 0.3, t);
      const push = sstep(0.3, 1.6, t);
      at(R, CLIMB_R, CLIMB_R[0], CLIMB_R[1] - 0.13 * push, CLIMB_R[2] + 0.1 * push);
      at(L, CLIMB_L, CLIMB_L[0], CLIMB_L[1] - 0.13 * push, CLIMB_L[2] + 0.1 * push);
      res.curlR = res.curlL = 0.1;
    } else if (this.act === 'crank' && me.held !== 'radio') {
      // the generator's crank: both hands on the handle, turning
      k = sstep(0, 0.4, t);
      const a = t * 4.5;
      at(R, CRANK_R, 0.08 + Math.cos(a) * 0.05, -0.2 + Math.sin(a) * 0.05, -0.42);
      at(L, CRANK_L, 0.0 + Math.cos(a) * 0.05, -0.21 + Math.sin(a) * 0.05, -0.42);
      res.curlR = res.curlL = 0.9;
    }
    if (k <= 0.001) return 0;
    this.feelHands(R, inp.view, time);
    this.feelHands(L, inp.view, time);
    return sstep(0, 1, k);
  }

  /** Breath, bob, shiver and landing for bare hands. */
  private feelHands(h: P6, view: View, time: number): void {
    const rig = view.rig;
    h[1] += Math.sin(rig.breath * TAU) * 0.002 + (Math.cos(rig.bob * TAU * 2) - 1) * 0.004 * rig.stride;
    const sh = rig.shiver;
    if (sh > 0.001) {
      h[0] += Math.sin(time * 43.1) * 0.0018 * sh;
      h[1] += Math.sin(time * 39.7 + 1.3) * 0.0016 * sh;
    }
    h[1] -= rig.landing * 0.04;
  }

  /** Strike a match on the box, shelter the flame in cupped hands, take it down to the fire. */
  private ignite(t: number, R: P6, L: P6, res: { curlR: number; curlL: number; thumbR: number; thumbL: number }): number {
    const s = t / IGNITE_TIME;
    const out = this.out;
    track(L, IGN_L, s);
    track(R, IGN_R, s);
    // the whole act a little further out and lower than the keys (the mitts are big this close)
    L[1] -= 0.015; L[2] -= 0.045;
    R[1] -= 0.015; R[2] -= 0.045;
    res.curlL = lerp(0.62, 0.5, sstep(0.45, 0.6, s));
    res.thumbL = 0.5;
    res.curlR = 0.72;
    res.thumbR = 0.9;
    const box = this.extra('matchbox');
    box.on = s < 0.47;
    mat6(_m, L);
    _m2.makeRotationFromEuler(_e.set(0, 0, Math.PI / 2)).setPosition(0.0, 0.055, -0.004);
    box.m.multiplyMatrices(_m, _m2);
    const match = this.extra('match');
    match.on = s < 0.96;
    mat6(_m, R);
    _m2.makeRotationFromEuler(_e.set(0.0, 0, -0.5)).setPosition(0.008, 0.06, -0.024);
    match.m.multiplyMatrices(_m, _m2);
    // the head flares on the strike, burns, and gutters out if the wind takes it
    const lit = sstep(0.3, 0.34, s);
    const dying = this.igniteFail ? sstep(0.55, 0.75, s) : sstep(0.9, 0.98, s);
    const flare = 1 + 2.5 * bump(0.3, 0.42, s);
    const k = lit * (1 - dying);
    match.glow = k * 7 * flare;
    out.flame.on = k > 0.01;
    out.flame.k = k * (0.75 + 0.25 * flare) * (0.85 + 0.15 * Math.sin(t * 37) * Math.sin(t * 23));
    out.flame.pos.set(0, 0.024, 0).applyMatrix4(match.m);
    return sstep(0, 0.15, s) * (1 - sstep(0.9, 1, s));
  }

  /** Eat a ration bar, drink from the thermos, or bandage the left forearm. */
  private eat(t: number, R: P6, L: P6, res: { curlR: number; curlL: number; thumbR: number; thumbL: number }): number {
    const s = t / EAT_TIME;
    const what = this.eatWhat;
    if (what === 'bandage') {
      // the left forearm across in front, the right hand winds the roll round it twice
      p6(L, BANDAGE_L);
      const wind = sat((s - 0.15) / 0.65) * TAU * 2;
      const c = Math.cos(wind), sn = Math.sin(wind);
      // round the left forearm (6 cm behind the left fist, along its fingers' line)
      const fx = BANDAGE_L[0] - 0.07, fy = BANDAGE_L[1] - 0.005, fz = BANDAGE_L[2] + 0.02;
      hp(1, fx + 0.035, fy + sn * 0.065, fz + c * 0.06, [-0.3, -c * 0.6, sn * 0.6 - 0.5], [0, -sn, -c], R);
      res.curlL = 0.35; res.curlR = 0.6; res.thumbR = 0.8;
      const roll = this.extra('bandage');
      roll.on = s < 0.9;
      mat6(_m, R);
      _m2.makeRotationFromEuler(_e.set(0, 0, 0)).setPosition(0.012, 0.075, 0);
      roll.m.multiplyMatrices(_m, _m2);
      return sstep(0, 0.15, s) * (1 - sstep(0.85, 1, s));
    }
    if (what === 'thermos') {
      // up to the mouth, tipped back, a long drink, down
      const tip = sstep(0.18, 0.42, s) * (1 - sstep(0.75, 0.9, s));
      mix6(R, THERMOS_LOW, THERMOS_UP, tip);
      res.curlR = 0.95; res.thumbR = 1;
      const th = this.extra('thermos');
      th.on = true;
      mat6(_m, R);
      // the flask in the fist, its axis through the fist (the handle axis), the cup end out of the thumb side
      _m2.makeRotationX(-Math.PI / 2).setPosition(0.012, 0.0, -0.035);
      th.m.multiplyMatrices(_m, _m2);
      return sstep(0, 0.15, s) * (1 - sstep(0.88, 1, s));
    }
    // a ration: up to the mouth, two bites, down
    const up = sstep(0.1, 0.32, s) * (1 - sstep(0.8, 0.95, s));
    const bite = bump(0.36, 0.5, s) + bump(0.56, 0.7, s);
    mix6(R, RATION_LOW, RATION_UP, up);
    R[1] -= bite * 0.008;
    R[2] += bite * 0.025;
    res.curlR = 0.55; res.thumbR = 0.9;
    const bar = this.extra('ration');
    bar.on = true;
    mat6(_m, R);
    _m2.makeRotationFromEuler(_e.set(0, 0, 0)).setPosition(0.008, 0.07, -0.006);
    bar.m.multiplyMatrices(_m, _m2);
    return sstep(0, 0.15, s) * (1 - sstep(0.88, 1, s));
  }

  // ----------------------------------------------------------------------------------------
  // Hands helpers
  // ----------------------------------------------------------------------------------------

  private handFromTool(h: HandPose, toolM: THREE.Matrix4, grip: THREE.Matrix4): void {
    _m.multiplyMatrices(toolM, grip);
    _m.decompose(h.pos, h.q, _v);
  }

  private setHand(h: HandPose, p: Readonly<P6>): void {
    h.pos.set(p[0], p[1], p[2]);
    _e.set(p[3], p[4], p[5], 'YXZ');
    h.q.setFromEuler(_e);
  }

  /** Move a hand from where it is toward pose p by k. */
  private blendHand(h: HandPose, p: Readonly<P6>, k: number): void {
    _v2.set(p[0], p[1], p[2]);
    h.pos.lerp(_v2, k);
    _e.set(p[3], p[4], p[5], 'YXZ');
    _q2.setFromEuler(_e);
    h.q.slerp(_q2, k);
  }
}

// ------------------------------------------------------------------------------------------
// Keyframes (P6 of the tool / hands in camera space; t in seconds or as a fraction of the act)
// ------------------------------------------------------------------------------------------

/** Axe swing, seconds (SWING_TIME 0.8, the blade lands at SWING_HIT 0.32). */
const AXE_IDLE = POSES.axe.idle;
const AXE_SWING: readonly (readonly [number, Readonly<P6>])[] = [
  [0.0, AXE_IDLE],
  // up over the right shoulder, out of the picture
  [0.1, [0.32, 0.04, -0.2, 0.5, 0.45, -0.75]],
  [0.19, [0.36, 0.17, -0.06, 1.4, 0.7, -0.9]],
  // the head comes down through the picture from the top right
  [SWING_HIT - 0.06, [0.2, 0.0, -0.36, -0.2, 0.25, -0.5]],
  [SWING_HIT, [0.05, -0.2, -0.42, -1.52, 0.02, -0.05]],
  [SWING_HIT + 0.08, [0.03, -0.24, -0.4, -1.68, -0.02, 0.0]],
  [0.55, [0.12, -0.24, -0.39, -1.25, 0.1, -0.2]],
  [SWING_TIME, AXE_IDLE],
];

/** Flashlight cell swap, fraction of CELL_SWAP: lamp to the right, the tail toward the left hand. */
const FLASH_IDLE = POSES.flashlight.idle;
const FLASH_SWAP: readonly (readonly [number, Readonly<P6>])[] = [
  [0.0, FLASH_IDLE],
  [0.15, [0.1, -0.2, -0.43, 0.15, -1.05, -0.1]],
  [0.5, [0.09, -0.21, -0.42, 0.25, -1.15, -0.15]],
  [0.85, [0.1, -0.2, -0.43, 0.15, -1.05, -0.1]],
  [1.0, FLASH_IDLE],
];

/** Flare gun reload, fraction of FLARE_RELOAD: in to the middle, open, load, flick shut. */
const FLARE_IDLE = POSES.flaregun.idle;
const FLARE_LOAD: readonly (readonly [number, Readonly<P6>])[] = [
  [0.0, FLARE_IDLE],
  // muzzle down: the barrel drops open and the chamber faces up, the cartridge goes in from above
  [0.14, [0.07, -0.21, -0.45, -0.45, 0.35, 0.3]],
  [0.3, [0.05, -0.22, -0.47, -0.6, 0.4, 0.4]],
  [0.7, [0.05, -0.22, -0.47, -0.6, 0.4, 0.4]],
  [0.8, [0.07, -0.21, -0.45, -0.3, 0.38, 0.35]],
  [0.86, [0.1, -0.19, -0.42, 0.25, 0.3, 0.25]],
  [1.0, FLARE_IDLE],
];

/** Lighting a match: the left hand holds the box, the right the match (fraction of IGNITE_TIME). */
const IGN_L: readonly (readonly [number, Readonly<P6>])[] = [
  [0.0, hp(-1, -0.14, -0.32, -0.3, [0.3, 0.2, -1], [0.3, 1, 0])],
  [0.18, hp(-1, -0.035, -0.135, -0.37, [0.45, 0.12, -1], [0.2, 1, 0.25])],
  [0.42, hp(-1, -0.033, -0.134, -0.37, [0.45, 0.12, -1], [0.2, 1, 0.25])],
  [0.55, hp(-1, -0.025, -0.125, -0.36, [0.6, 0.35, -1], [0.85, 0.3, 0.3])],
  [0.75, hp(-1, -0.02, -0.17, -0.42, [0.5, 0.0, -1], [0.85, 0.2, 0.2])],
  [0.95, hp(-1, -0.03, -0.24, -0.48, [0.4, -0.3, -1], [0.8, 0.1, 0.2])],
  [1.0, hp(-1, -0.1, -0.33, -0.4, [0.2, -0.3, -1], [0.6, 0.4, 0])],
];
const IGN_R: readonly (readonly [number, Readonly<P6>])[] = [
  [0.0, hp(1, 0.14, -0.32, -0.3, [-0.3, 0.2, -1], [-0.3, -0.5, 0])],
  [0.18, hp(1, 0.05, -0.115, -0.35, [-0.7, 0.1, -1], [-0.2, -1, 0.1])],
  [0.27, hp(1, 0.048, -0.114, -0.35, [-0.7, 0.1, -1], [-0.2, -1, 0.1])],
  [0.34, hp(1, 0.1, -0.105, -0.36, [-0.6, 0.25, -1], [-0.2, -1, 0.1])],
  [0.5, hp(1, 0.03, -0.11, -0.37, [-0.5, 0.35, -1], [-0.85, -0.3, 0.2])],
  [0.75, hp(1, 0.025, -0.165, -0.43, [-0.4, 0.0, -1], [-0.85, -0.2, 0.2])],
  [0.95, hp(1, 0.02, -0.235, -0.49, [-0.3, -0.3, -1], [-0.8, -0.1, 0.2])],
  [1.0, hp(1, 0.1, -0.33, -0.4, [-0.2, -0.3, -1], [-0.6, 0.4, 0])],
];

// hands-only poses (fingers / palm directions, camera space)
const USE_R = hp(1, 0.11, -0.19, -0.48, [-0.25, -0.35, -1], [0, -1, 0.2]);
const USE_L = hp(-1, -0.11, -0.19, -0.48, [0.25, -0.35, -1], [0, -1, 0.2]);
const REVIVE_R = hp(1, 0.08, -0.23, -0.46, [-0.15, -0.8, -0.6], [0, -0.6, -0.8]);
const REVIVE_L = hp(-1, -0.08, -0.23, -0.46, [0.15, -0.8, -0.6], [0, -0.6, -0.8]);
const CLIMB_R = hp(1, 0.16, -0.15, -0.38, [0, -0.15, -1], [0, -1, 0]);
const CLIMB_L = hp(-1, -0.16, -0.15, -0.38, [0, -0.15, -1], [0, -1, 0]);
const CARRY_R = hp(1, 0, 0, 0, [-0.2, -0.45, -1], [-1, -0.1, 0]);
const CARRY_L = hp(-1, 0, 0, 0, [0.2, -0.45, -1], [1, -0.1, 0]);
const CRAWL_R = hp(1, 0, 0, 0, [-0.15, -0.35, -1], [0, -1, 0.1]);
const CRAWL_L = hp(-1, 0, 0, 0, [0.15, -0.35, -1], [0, -1, 0.1]);
const SWIM_R = hp(1, 0, 0, 0, [0.1, -0.1, -1], [0.6, -0.6, 0]);
const SWIM_L = hp(-1, 0, 0, 0, [-0.1, -0.1, -1], [-0.6, -0.6, 0]);
const RATION_LOW = hp(1, 0.12, -0.22, -0.4, [-0.4, 0.4, -1], [-0.7, -0.4, 0.2]);
const RATION_UP = hp(1, 0.035, -0.14, -0.25, [-0.3, 0.75, -0.5], [-0.95, 0, 0.3]);
const THERMOS_LOW = hp(1, 0.12, -0.22, -0.4, [-0.5, 0.5, -0.9], [-1, 0, 0.2]);
const THERMOS_UP = hp(1, 0.02, -0.15, -0.18, [-1, 0.15, 0.1], [0.1, -0.7, -0.7]);
const BANDAGE_L = hp(-1, -0.02, -0.17, -0.42, [1, 0.12, -0.25], [0, -1, 0.1]);
const CRANK_R = hp(1, 0, 0, 0, [-0.4, -0.2, -1], [-0.6, -0.8, 0]);
const CRANK_L = hp(-1, 0, 0, 0, [0.4, -0.2, -1], [0.6, -0.8, 0]);
