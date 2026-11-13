// The first-person animator: from the predicted local player (view.me) and the feel values of the
// rig (view.rig), every frame, where the held tool is (camera space), how its moving parts sit,
// where each hand is and how closed, which small extra a hand holds, the flashlight beam, the
// match flame and how far the rifle scope is up. Everything is recomputed from scratch each frame
// (base pose -> act -> procedural layers), so nothing drifts; only springs (recoil, look lag) and a
// few eased values carry state.
//
// Timing follows the simulation: acts are played on a local clock that runs smoothly between
// snapshots and is pulled to me.actT (the axe lands on SWING_HIT, the bolt cycle fills BOLT_TIME,
// the flare cartridge goes in at the sim's moment ...). Constants come from the systems that own
// the acts (sim/systems/tools.ts, wood.ts, items.ts, fire.ts).
//
// Camera space: x right, y up, -z forward, metres; the camera is at the origin (viewmodel FOV).
import * as THREE from 'three/webgpu';
import type { View } from '../../game/view';
import type { PlayerEnt } from '../../sim/types';
import { BOLT_TIME, CELL_DIM, CELL_SWAP, FLARE_RECOVER, FLARE_RELOAD, RELOAD_CLOSE, RELOAD_OPEN, RELOAD_ROUND, RIFLE_MAG } from '../../sim/systems/tools';
import { SWING_HIT, SWING_TIME } from '../../sim/systems/wood';
import { EAT_TIME } from '../../sim/systems/items';
import { IGNITE_TIME } from '../../sim/systems/fire';
import type { ExtraName, Tool } from '../../models/tools';
import { RADIO_NEEDLE_SWEEP, RIFLE_BOLT_LIFT, RIFLE_BOLT_TRAVEL, gripMatrix, toolModel } from '../../models/tools';
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
/** Cheap smooth noise in [-1, 1]. */
const wob = (t: number, s: number): number => Math.sin(t * 1.31 + s) * 0.55 + Math.sin(t * 2.71 + s * 1.7) * 0.3 + Math.sin(t * 5.13 + s * 2.3) * 0.15;

// ------------------------------------------------------------------------------------------
// Pose values: position + Euler (YXZ: yaw, pitch, roll) in camera space
// ------------------------------------------------------------------------------------------

/** [x, y, z, pitch, yaw, roll]. */
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

/** Compose a P6 into a matrix. */
function mat6(out: THREE.Matrix4, a: Readonly<P6>): THREE.Matrix4 {
  _e.set(a[3], a[4], a[5], 'YXZ');
  _q.setFromEuler(_e);
  return out.compose(_v.set(a[0], a[1], a[2]), _q, _one);
}

// ------------------------------------------------------------------------------------------
// Springs
// ------------------------------------------------------------------------------------------

/** A damped spring per channel (6 channels: x, y, z, pitch, yaw, roll). */
class Spring6 {
  readonly x: P6 = [0, 0, 0, 0, 0, 0];
  readonly v: P6 = [0, 0, 0, 0, 0, 0];
  constructor(private k: number, private c: number) {}
  kick(d: Readonly<P6>, k = 1): void {
    for (let i = 0; i < 6; i++) this.v[i] += d[i] * k;
  }
  step(dt: number, target: Readonly<P6> | null = null): void {
    // sub-steps keep a stiff spring stable on a long frame
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let s = 0; s < n; s++) {
      for (let i = 0; i < 6; i++) {
        const goal = target ? target[i] : 0;
        const a = -this.k * (this.x[i] - goal) - this.c * this.v[i];
        this.v[i] += a * h;
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
  /** Camera-space transform. */
  m: THREE.Matrix4;
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
  /** Moving parts. */
  bolt: { lift: number; back: number };
  hammer: number; // 0 down .. 1 cocked
  trigger: number; // 0 .. 1 pulled
  barrel: number; // flare gun open 0 .. 1
  crank: number; // radians
  needle: number; // radians about +Z of the needle pivot
  cap: number; // flashlight tail cap: 0 on .. 1 off and away
  lampGlow: number; // flashlight reflector emissive
  radioGlow: number; // meter backlight
  hands: [HandPose, HandPose];
  /** Arms drawn (false: both hands are off screen and the tool is lowered). */
  arms: boolean;
  extras: ExtraOut[];
  /** Match flame: camera space position, 0..1 strength. */
  flame: { on: boolean; pos: THREE.Vector3; k: number };
  /** Flashlight: lamp position and beam direction (camera space), output 0..1 incl. flicker, focus 0..1. */
  beam: { on: boolean; pos: THREE.Vector3; dir: THREE.Vector3; k: number; focus: number; warm: number };
  /** 0..1: rifle scope over the eye (the system zooms and draws the scope from 0.5). */
  scope: number;
  /** A spent case to throw (camera space position and velocity), consumed by the system. */
  eject: { pending: boolean; pos: THREE.Vector3; vel: THREE.Vector3 };
}

function extraOut(name: ExtraName): ExtraOut {
  return { name, on: false, m: new THREE.Matrix4(), glow: 0 };
}

const EXTRAS: ExtraName[] = ['matchbox', 'match', 'ration', 'thermos', 'bandage', 'cartridge', 'round', 'cell', 'case'];

// ------------------------------------------------------------------------------------------
// Tool rest poses (camera space P6 of the tool's model space: x, y, z, pitch, yaw, roll)
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
  /** Shoulder offsets from the default (x, y, z) for the raised pose. */
  shoulderUp?: [number, number, number];
}

const POSES: Record<Tool, ToolPoses> = {
  axe: {
    idle: [0.2, -0.27, -0.33, -0.42, 0.18, -0.3],
    up: [0.2, -0.27, -0.33, -0.42, 0.18, -0.3],
    run: [0.22, -0.31, -0.28, -0.75, 0.35, -0.55],
    away: [0.26, -0.62, -0.18, -1.0, 0.3, -0.5],
    curl: [1, 1],
  },
  flashlight: {
    idle: [0.16, -0.205, -0.34, 0.035, 0.07, 0.12],
    up: [0.115, -0.135, -0.39, 0.0, 0.025, 0.06],
    run: [0.19, -0.27, -0.27, -0.35, 0.3, 0.4],
    away: [0.24, -0.55, -0.16, -0.9, 0.3, 0.4],
    curl: [1, 0.4],
  },
  flaregun: {
    idle: [0.155, -0.215, -0.31, 0.05, 0.08, 0.06],
    up: [0.155, -0.215, -0.31, 0.05, 0.08, 0.06],
    run: [0.18, -0.28, -0.25, -0.45, 0.35, 0.3],
    away: [0.23, -0.56, -0.16, -0.95, 0.3, 0.3],
    curl: [1, 0.4],
  },
  rifle: {
    idle: [0.165, -0.215, -0.19, 0.12, 0.09, 0.18],
    up: [0, -0.103, -0.146, 0, 0, 0],
    run: [0.13, -0.27, -0.16, -0.25, 0.85, 0.5],
    away: [0.2, -0.6, -0.1, -0.7, 0.5, 0.5],
    curl: [1, 0.78],
    shoulderUp: [-0.03, 0.04, -0.03],
  },
  radio: {
    idle: [-0.075, -0.2, -0.33, -0.48, 0.2, 0.03],
    up: [-0.05, -0.115, -0.3, -0.25, 0.14, 0.02],
    run: [-0.12, -0.3, -0.26, -0.9, 0.3, 0.2],
    away: [-0.18, -0.58, -0.16, -1.2, 0.3, 0.2],
    curl: [1, 0.42],
  },
};

/** Default shoulders (camera space) and elbow poles. */
const SHOULDER_R = new THREE.Vector3(0.19, -0.28, 0.07);
const SHOULDER_L = new THREE.Vector3(-0.19, -0.28, 0.07);
const POLE_R = new THREE.Vector3(0.75, -0.65, 0.15);
const POLE_L = new THREE.Vector3(-0.75, -0.65, 0.15);

/** Hands off screen (relaxed, low at the sides). */
const REST_R: P6 = [0.26, -0.52, -0.12, 0.6, 0.15, -0.4];
const REST_L: P6 = [-0.26, -0.52, -0.12, 0.6, -0.15, 0.4];

// ------------------------------------------------------------------------------------------
// The animator
// ------------------------------------------------------------------------------------------

interface Grips {
  r: THREE.Matrix4;
  l: THREE.Matrix4;
  extra: Record<string, THREE.Matrix4>;
}

export interface FpInputs {
  dt: number;
  time: number;
  view: View;
  /** The carried log's held end in camera space, or null. */
  logEnd: THREE.Vector3 | null;
}

export class FpAnimator {
  readonly out: FpOut;
  private grips = new Map<Tool, Grips>();
  // tool shown and how far it is up
  private shown: Tool | null = null;
  private raise = 0;
  // act clock
  private act: PlayerEnt['act'] = 'none';
  private actT = 0;
  private actTool: PlayerEnt['held'] = 'hands';
  /** What 'eat' is eating: from the inventory change when it starts. */
  private eatWhat: 'ration' | 'thermos' | 'bandage' = 'ration';
  private lastInv = { ration: 0, thermos: 0, bandage: 0 };
  private lastLoaded = 0;
  private loadT = -1;
  private igniteFail = false;
  // springs and eased values
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
  private boltEjected = false;
  private flashFlick = 0;
  // scratch
  private base: P6 = [0, 0, 0, 0, 0, 0];
  private tmp: P6 = [0, 0, 0, 0, 0, 0];
  private tmp2: P6 = [0, 0, 0, 0, 0, 0];
  private handR: P6 = [0, 0, 0, 0, 0, 0];
  private handL: P6 = [0, 0, 0, 0, 0, 0];

  constructor() {
    const extras: ExtraOut[] = EXTRAS.map(extraOut);
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
      cap: 0,
      lampGlow: 0,
      radioGlow: 0,
      hands: [makeHandPose(), makeHandPose()],
      arms: false,
      extras,
      flame: { on: false, pos: new THREE.Vector3(), k: 0 },
      beam: { on: false, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1), k: 0, focus: 0, warm: 0 },
      scope: 0,
      eject: { pending: false, pos: new THREE.Vector3(), vel: new THREE.Vector3() },
    };
  }

  /** The grip frames of a tool (model space <- hand frame). */
  private gripsOf(tool: Tool): Grips {
    let g = this.grips.get(tool);
    if (!g) {
      const def = toolModel(tool, 0);
      const extra: Record<string, THREE.Matrix4> = {};
      for (const name of Object.keys(def.anchors)) extra[name] = gripMatrix(def, name);
      g = {
        r: gripMatrix(def, tool === 'radio' ? 'gripR' : 'gripR'),
        l: gripMatrix(def, 'gripL'),
        extra,
      };
      this.grips.set(tool, g);
    }
    return g;
  }

  private extra(name: ExtraName): ExtraOut {
    return this.out.extras[EXTRAS.indexOf(name)];
  }

  /** A sim event about the local player (shot, flareShot, swing, dry, igniteFail). */
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

  update(inp: FpInputs): FpOut {
    const out = this.out;
    const { dt, time, view } = inp;
    const me = view.me;
    const rig = view.rig;
    const cam = view.camera;
    for (const e of out.extras) e.on = false;
    out.flame.on = false;
    out.eject.pending = false;
    out.trigger = 0;
    out.barrel = 0;
    out.cap = 0;
    out.bolt.lift = 0;
    out.bolt.back = 0;
    if (!me || me.life === 'dead' || me.life === 'rescued') {
      out.visible = false;
      out.beam.on = false;
      out.scope = 0;
      this.hasPrev = false;
      return out;
    }

    // ---------------- inputs smoothed ----------------
    this.aim = damp(this.aim, me.aim, 30, dt); // me.aim is already eased by the sim (AIM_UP)
    this.sprint = damp(this.sprint, me.sprint && rig.speed > 3 ? 1 : 0, 8, dt);
    this.crouch = damp(this.crouch, me.crouch ? 1 : 0, 10, dt);
    this.downK = damp(this.downK, me.life === 'downed' ? 1 : 0, 6, dt);
    this.swim = damp(this.swim, me.swim ? 1 : 0, 5, dt);
    this.carryK = damp(this.carryK, me.carry !== 0 && inp.logEnd ? 1 : 0, 7, dt);
    // look lag: the hands trail the view a little when it turns
    if (this.hasPrev) {
      let dy = cam.yaw - this.prevYaw;
      if (dy > Math.PI) dy -= TAU;
      if (dy < -Math.PI) dy += TAU;
      const dp = cam.pitch - this.prevPitch;
      const wy = clamp(dy / Math.max(dt, 1e-3), -6, 6), wp = clamp(dp / Math.max(dt, 1e-3), -6, 6);
      this.tmp[0] = -wy * 0.006; this.tmp[1] = wp * 0.004; this.tmp[2] = 0;
      this.tmp[3] = wp * 0.025; this.tmp[4] = wy * 0.03; this.tmp[5] = wy * 0.02;
      this.lag.step(Math.min(dt, 0.1), this.tmp);
    }
    this.prevYaw = cam.yaw;
    this.prevPitch = cam.pitch;
    this.hasPrev = true;
    this.recoil.step(Math.min(dt, 0.1));

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
      this.raise = Math.max(0, this.raise - dt / 0.2);
      if (this.raise <= 0) {
        this.shown = want;
        this.lightOn = me.lightOn;
      }
    } else if (handsBusy) this.raise = Math.max(0, this.raise - dt / 0.22);
    else this.raise = Math.min(1, this.raise + dt / 0.34);
    const up = sstep(0, 1, this.raise);
    const tool = this.shown;

    // ---------------- per-tool pose ----------------
    out.hands[0].shoulder.copy(SHOULDER_R);
    out.hands[1].shoulder.copy(SHOULDER_L);
    out.hands[0].pole.copy(POLE_R);
    out.hands[1].pole.copy(POLE_L);
    p6(this.handR, REST_R);
    p6(this.handL, REST_L);
    let rUse = false, lUse = false; // hand driven by the tool's grips
    let rTool = false, lTool = false;
    const extraR: { name: ExtraName; m: THREE.Matrix4 } | null = null;
    void extraR;
    out.scope = 0;
    out.beam.on = false;
    out.lampGlow = 0;
    out.radioGlow = 0;
    let curlR = 0.35, curlL = 0.35, thumbR = 0.4, thumbL = 0.4;

    if (tool) {
      const P = POSES[tool];
      const base = this.base;
      // raised / sprint blend
      const aimK = tool === 'rifle' ? this.aimCurve(this.aim) : sstep(0, 1, this.aim);
      mix6(base, P.idle, P.up, aimK);
      mix6(base, base, P.run, this.sprint * (1 - aimK));
      if (tool === 'rifle' && P.shoulderUp) {
        out.hands[0].shoulder.x += P.shoulderUp[0] * aimK;
        out.hands[0].shoulder.y += P.shoulderUp[1] * aimK;
        out.hands[0].shoulder.z += P.shoulderUp[2] * aimK;
      }
      // the procedural feel (bob, breath, sway, shiver, landing, lag, recoil)
      this.feel(base, view, time, tool === 'rifle' ? aimK : 0);
      // the act on top
      const ag = this.toolAct(tool, me, base, time, dt);
      rUse = ag.r;
      lUse = ag.l;
      // lowered for equip / busy hands
      mix6(base, P.away, base, up);
      mat6(out.toolM, base);
      curlR = P.curl[0];
      curlL = P.curl[1];
      thumbR = 1;
      thumbL = 0.6;
      const g = this.gripsOf(tool);
      if (rUse) rTool = true;
      if (lUse) lTool = true;
      // hands from the grips
      if (rTool && !ag.rOverride) this.handFromTool(out.hands[0], out.toolM, ag.rGrip ?? g.r);
      if (lTool && !ag.lOverride) this.handFromTool(out.hands[1], out.toolM, ag.lGrip ?? g.l);
      if (ag.rOverride) this.setHand(out.hands[0], ag.rOverride);
      if (ag.lOverride) this.setHand(out.hands[1], ag.lOverride);
      if (ag.curlR !== undefined) curlR = ag.curlR;
      if (ag.curlL !== undefined) curlL = ag.curlL;
      if (ag.thumbR !== undefined) thumbR = ag.thumbR;
      if (ag.thumbL !== undefined) thumbL = ag.thumbL;
      // a lowered tool takes the hands down with it; a free hand rests off screen
      if (!rTool) this.setHand(out.hands[0], REST_R);
      if (!lTool) this.setHand(out.hands[1], REST_L);
      this.tools(tool, me, dt, time, up);
    } else {
      this.setHand(out.hands[0], REST_R);
      this.setHand(out.hands[1], REST_L);
    }

    // ---------------- hands-only acts (tool away) ----------------
    const handsAct = this.handsActs(me, inp, time, dt, tool !== null && up > 0.02);
    if (handsAct) {
      curlR = handsAct.curlR;
      curlL = handsAct.curlL;
      thumbR = handsAct.thumbR;
      thumbL = handsAct.thumbL;
    }

    out.hands[0].curl = curlR;
    out.hands[1].curl = curlL;
    out.hands[0].thumb = thumbR;
    out.hands[1].thumb = thumbL;
    out.tool = tool && up > 0.01 ? tool : null;
    out.visible = view.camera.third < 0.5 && (out.tool !== null || handsAct !== null);
    out.arms = out.visible && (rTool || lTool || handsAct !== null);
    if (out.scope > 0.55) {
      // looking through the scope: nothing of the viewmodel in front of the eye
      out.visible = false;
    }
    return out;
  }

  /** The rifle's raise: slow start, quick finish (the stock comes up, then the eye goes to the scope). */
  private aimCurve(a: number): number {
    return sstep(0, 1, a);
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
    const sw = rig.sway;
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
    // look lag and recoil
    add6(base, this.lag.x, steady * 0.9 + 0.1);
    add6(base, this.recoil.x);
  }

  // ----------------------------------------------------------------------------------------
  // Tool acts
  // ----------------------------------------------------------------------------------------

  private toolAct(tool: Tool, me: PlayerEnt, base: P6, time: number, dt: number): ActGrip {
    const a = ACT;
    a.r = true; a.l = false; a.rGrip = null; a.lGrip = null; a.rOverride = null; a.lOverride = null;
    a.curlR = undefined; a.curlL = undefined; a.thumbR = undefined; a.thumbL = undefined;
    const mine = this.act !== 'none' && this.actTool === tool;
    const t = this.actT;
    const g = this.gripsOf(tool);
    switch (tool) {
      case 'axe': {
        if (mine && this.act === 'swing') {
          // wind up over the right shoulder, the blade lands on SWING_HIT, follow through, recover
          const k = AXE_SWING;
          track(this.tmp, k, t);
          const w = sstep(0, 0.06, t) * (1 - sstep(SWING_TIME - 0.12, SWING_TIME, t));
          mix6(base, base, this.tmp, w);
          a.l = t > 0.04 && t < SWING_TIME - 0.08;
          a.lGrip = g.extra.gripL;
          a.rGrip = t < 0.3 ? g.r : g.extra.gripR2 ?? g.r;
        }
        return a;
      }
      case 'flashlight': {
        if (mine && this.act === 'reload') {
          // change the cell: tail toward the left hand, unscrew, swap, screw back
          const s = t / CELL_SWAP;
          track(this.tmp, FLASH_SWAP, s);
          mix6(base, base, this.tmp, bump(0, 1, s) > 0 ? sstep(0, 0.15, s) * (1 - sstep(0.85, 1, s)) : 0);
          a.l = s > 0.12 && s < 0.9;
          this.out.cap = sstep(0.22, 0.4, s) * (1 - sstep(0.62, 0.8, s));
          // the left hand holds the cap; the new cell goes in at CELL_SWAP_AT
          a.lGrip = g.l;
          if (s > 0.38 && s < 0.66) {
            const c = this.extra('cell');
            c.on = true;
            // from below into the tube
            const ins = sstep(0.42, 0.6, s);
            _m.makeRotationX(-Math.PI / 2).setPosition(0, -0.06 * (1 - ins), 0.094 - 0.05 * ins + 0.06 * (1 - ins));
            c.m.multiplyMatrices(this.out.toolM, _m);
          }
        }
        return a;
      }
      case 'flaregun': {
        if (mine && this.act === 'shoot') {
          const s = t / FLARE_RECOVER;
          a.thumbR = 1;
          this.out.trigger = 1 - sstep(0.1, 0.5, s);
        } else if (mine && this.act === 'reload') {
          const s = t / FLARE_RELOAD;
          track(this.tmp, FLARE_LOAD, s);
          mix6(base, base, this.tmp, sstep(0, 0.12, s) * (1 - sstep(0.88, 1, s)));
          this.out.barrel = sstep(0.16, 0.3, s) * (1 - sstep(0.76, 0.84, s));
          // the left hand: cartridge from below to the breech, pushed in at the sim's moment
          a.l = s > 0.1 && s < 0.9;
          const gl = _m2;
          this.flareLoadHand(gl, s);
          a.lGrip = gl;
          a.curlL = 0.55;
          a.thumbL = 0.7;
          if (s > 0.28 && s < 0.72) {
            const c = this.extra('cartridge');
            c.on = true;
            // in the left fingers until it is in the chamber
            _m3.makeRotationX(Math.PI / 2 + 0.3).setPosition(0.0, 0.07, -0.012);
            c.m.multiplyMatrices(this.out.toolM, gl).multiply(_m3);
          }
          if (s > 0.86) this.hammer = Math.min(1, this.hammer + dt * 6);
        } else if (this.dryT < 0.35) {
          this.out.trigger = bump(0, 0.35, this.dryT);
        } else if (!mine) this.hammer = damp(this.hammer, me.flareLoaded > 0 ? 1 : this.hammer, 3, dt);
        return a;
      }
      case 'rifle':
        return this.rifleAct(me, base, g, mine, t, dt);
      case 'radio': {
        a.r = false;
        a.l = true;
        a.rGrip = null;
        if (mine && this.act === 'crank') {
          a.r = true;
          a.curlR = 1;
          // the knob goes round with the crank; the hand follows it without turning
          const A = CRANK;
          _m.makeTranslation(A.x, A.y, A.z).multiply(_m3.makeRotationX(this.crank)).multiply(_m2.makeTranslation(-A.x, -A.y, -A.z));
          a.rGrip = _m.multiply(_m2.copy(g.r));
          // the turning shakes the radio a little
          base[0] += Math.sin(this.crank) * 0.004;
          base[1] += Math.cos(this.crank) * 0.005;
          base[3] += Math.sin(this.crank) * 0.03;
        }
        void time;
        return a;
      }
    }
    return a;
  }

  private rifleAct(me: PlayerEnt, base: P6, g: Grips, mine: boolean, t: number, dt: number): ActGrip {
    const a = ACT;
    a.l = true;
    const out = this.out;
    const aimed = this.aim > 0.8;
    if (mine && this.act === 'shoot') {
      out.trigger = 1 - sstep(0.06, 0.25, t);
      if (aimed) {
        // stay on the scope: the bolt is worked with the cheek down (only the jolts show)
        base[3] += bump(0.4, 0.62, t) * 0.012 - bump(0.62, 0.8, t) * 0.01;
        base[2] += bump(0.4, 0.62, t) * 0.006;
      } else {
        // bolt cycle from the hip: hand to the knob, lift, back (eject), forward, down, back to the grip
        const s = t;
        const toKnob = sstep(0.16, 0.3, s) * (1 - sstep(0.88, 1.02, s));
        out.bolt.lift = sstep(0.3, 0.4, s) * (1 - sstep(0.76, 0.86, s));
        out.bolt.back = sstep(0.42, 0.56, s) * (1 - sstep(0.62, 0.76, s));
        // the rifle rolls toward the shooter while the bolt is worked
        base[5] += toKnob * 0.32;
        base[3] += toKnob * 0.08;
        base[0] -= toKnob * 0.015;
        if (!this.boltEjected && s > 0.54) {
          this.boltEjected = true;
          this.ejectCase();
        }
        if (toKnob > 0) {
          a.rGrip = this.boltKnobGrip(g, toKnob);
          a.curlR = lerp(1, 0.6, toKnob);
        }
      }
    } else if (mine && this.act === 'reload') {
      // open, rounds in one at a time, close: the right hand works the bolt and presses the rounds
      const open = sstep(0.0, RELOAD_OPEN, t);
      const full = me.loaded >= RIFLE_MAG || (me.inv.ammo ?? 0) <= 0;
      const closing = full && this.loadT >= 0 ? sat((t - this.loadT) / RELOAD_CLOSE) : 0;
      const inTilt = open * (1 - sstep(0.4, 1, closing));
      // the rifle comes down and rolls the open action toward the eye
      base[1] -= inTilt * 0.035;
      base[2] -= inTilt * 0.02;
      base[3] += inTilt * 0.12;
      base[4] -= inTilt * 0.15;
      base[5] += inTilt * 0.55;
      out.bolt.lift = sstep(0.05, 0.2, t) * (1 - sstep(0.62, 0.85, closing));
      out.bolt.back = sstep(0.2, 0.38, t) * (1 - sstep(0.15, 0.6, closing));
      // round cycle (RELOAD_ROUND each, the first lands at RELOAD_OPEN + RELOAD_ROUND)
      const cyc = t < RELOAD_OPEN ? -1 : ((t - RELOAD_OPEN) % RELOAD_ROUND) / RELOAD_ROUND;
      if (closing <= 0 && cyc >= 0) {
        const port = g.extra.port;
        // the right hand: down out of view for a round, up to the open action, thumb it in
        const down = 1 - sstep(0.1, 0.45, cyc), press = sstep(0.75, 0.95, cyc);
        _m.copy(port);
        _m.multiply(_m2.makeTranslation(0.025 + 0.05 * down, -0.02 + 0.12 * down - 0.012 * press, 0.04 + 0.12 * down));
        _m.multiply(_m2.makeRotationFromEuler(_e.set(0.4, -0.9, -1.6)));
        a.rGrip = _m;
        a.curlR = 0.5;
        a.thumbR = 0.2 + 0.8 * press;
        const r = this.extra('round');
        r.on = cyc < 0.92;
        _m2.makeRotationFromEuler(_e.set(0, 0, Math.PI / 2 - 0.2)).setPosition(-0.004, 0.065, -0.006);
        r.m.multiplyMatrices(out.toolM, _m).multiply(_m2);
      } else if (t < RELOAD_OPEN || closing > 0) {
        // on the bolt knob while opening and closing
        const k = t < RELOAD_OPEN ? sstep(0.0, 0.12, t) : 1 - sstep(0.7, 1, closing);
        a.rGrip = this.boltKnobGrip(g, k);
        a.curlR = lerp(1, 0.6, k);
      }
    } else if (this.dryT < 0.4) {
      out.trigger = bump(0, 0.3, this.dryT);
    }
    void dt;
    return a;
  }

  /** The right hand's grip on the bolt knob (moving with the bolt), blended from the pistol grip by k. */
  private boltKnobGrip(g: Grips, k: number): THREE.Matrix4 {
    const out = this.out;
    const P = BOLT;
    _m.makeTranslation(P.x, P.y, P.z + out.bolt.back * RIFLE_BOLT_TRAVEL)
      .multiply(_m3.makeRotationZ(out.bolt.lift * RIFLE_BOLT_LIFT))
      .multiply(_m2.makeTranslation(-P.x, -P.y, -P.z));
    _m.multiply(g.extra.boltKnob);
    if (k >= 0.999) return _m;
    // blend the two frames (position lerp, rotation slerp)
    const pa = _v.setFromMatrixPosition(g.r), pb = _v2.setFromMatrixPosition(_m);
    _q.setFromRotationMatrix(g.r);
    _q2.setFromRotationMatrix(_m);
    _q.slerp(_q2, k);
    pa.lerp(pb, k);
    // an arc: lift the hand a little on the way
    pa.y += Math.sin(k * Math.PI) * 0.03;
    return _m.compose(pa, _q, _one);
  }

  /** The left hand's frame (tool model space) during the flare gun reload at phase s. */
  private flareLoadHand(out: THREE.Matrix4, s: number): void {
    // below the gun -> hold the barrel down -> fetch the cartridge -> to the breech -> push in -> close
    track(this.tmp2, FLARE_LHAND, s);
    mat6(out, this.tmp2);
  }

  private ejectCase(): void {
    const e = this.out.eject;
    // the port in camera space
    const port = this.gripsOf('rifle').extra.port;
    _m.multiplyMatrices(this.out.toolM, port);
    e.pos.setFromMatrixPosition(_m);
    e.vel.set(1.6, 1.4, 0.4).applyQuaternion(_q.setFromRotationMatrix(this.out.toolM));
    e.pending = true;
  }

  /** Lamp, needle, crank, hammer and the rifle scope, after the tool pose is known. */
  private tools(tool: Tool, me: PlayerEnt, dt: number, time: number, up: number): void {
    const out = this.out;
    out.hammer = this.hammer;
    if (tool === 'flashlight') {
      // a click of the thumb on the switch
      if (me.lightOn !== this.lightOn) {
        this.lightOn = me.lightOn;
        this.click = 1;
        this.recoil.kick([0, -0.004, 0.01, -0.25, 0, 0]);
      }
      this.click = Math.max(0, this.click - dt * 7);
      const beamLvl = me.beam ?? (me.lightOn ? 1 : 0);
      // low cell: the filament sags, flickers, sometimes nearly dies
      const low = me.cellCharge < CELL_DIM ? 1 - me.cellCharge / CELL_DIM : 0;
      this.flickT -= dt;
      if (this.flickT <= 0) {
        const r = Math.abs(Math.sin(time * 91.7 + me.cellCharge * 400)) ;
        this.flickT = 0.04 + 0.25 * (1 - low) * r + 0.03 * r;
        this.flickTarget = low > 0 ? 1 - low * (r > 0.82 ? 0.85 : 0.35 * r) : 1;
      }
      this.flicker = damp(this.flicker, this.flickTarget, low > 0 ? 40 : 8, dt);
      this.flashFlick = low;
      const k = me.lightOn ? beamLvl * this.flicker : 0;
      const lamp = this.gripsOf('flashlight').extra.lamp;
      _m.multiplyMatrices(out.toolM, lamp);
      out.beam.pos.setFromMatrixPosition(_m);
      out.beam.dir.set(0, 0, -1).applyQuaternion(_q.setFromRotationMatrix(out.toolM)).normalize();
      out.beam.on = k > 0.001 && up > 0.6;
      out.beam.k = k * sstep(0.6, 1, up);
      out.beam.focus = sstep(0, 1, this.aim);
      out.beam.warm = low;
      out.lampGlow = k * 6;
    } else if (tool === 'radio') {
      const charged = me.radioCharge > 0;
      // the needle: the signal, with static when weak; a slow mechanical meter
      const target = charged ? me.radioSig : 0;
      const noise = charged ? (1 - me.radioSig) * 0.06 * wob(time * 9, 3.3) : 0;
      this.needle = damp(this.needle, target + noise, charged ? 5 : 3, dt);
      out.needle = -RADIO_NEEDLE_SWEEP + 2 * RADIO_NEEDLE_SWEEP * clamp(this.needle, 0, 1);
      // backlight and lamp: lit while there is charge
      out.radioGlow = charged ? 0.8 + 0.25 * me.radioSig + 0.05 * Math.sin(time * 50) : 0;
      // the crank turns while cranking, coasts to a stop
      const cranking = this.act === 'crank' && me.held === 'radio';
      this.crankV = damp(this.crankV, cranking ? 13 : 0, cranking ? 6 : 4, dt);
      this.crank = (this.crank + this.crankV * dt) % TAU;
      out.crank = this.crank;
    } else if (tool === 'rifle') {
      out.scope = sstep(0.82, 0.98, this.aim) * sstep(0.85, 1, up) * (this.act === 'reload' ? 0 : 1);
    }
  }

  // ----------------------------------------------------------------------------------------
  // Hands acts: match, eat, drink, bandage, open, revive, climb out, carry, crawl, swim
  // ----------------------------------------------------------------------------------------

  private handsActs(me: PlayerEnt, inp: FpInputs, time: number, dt: number, toolUp: boolean): HandsResult | null {
    const out = this.out;
    const t = this.actT;
    const R = this.handR, L = this.handL;
    const res = HANDS;
    res.curlR = 0.35; res.curlL = 0.35; res.thumbR = 0.4; res.thumbL = 0.4;
    let k = 0; // how far the hands are in
    if (me.life === 'downed' || this.downK > 0.05) {
      // crawling: the hands reach forward on the snow in turn, low in the view
      this.crawl += dt * (Math.hypot(me.vx, me.vz) > 0.1 ? 2.2 : 0.4);
      const ph = this.crawl;
      for (const side of [1, -1] as const) {
        const P = side > 0 ? R : L;
        const c = Math.sin(ph * Math.PI + (side > 0 ? 0 : Math.PI));
        const reach = c * 0.5 + 0.5;
        P[0] = side * 0.17; P[1] = -0.24 + Math.max(0, Math.cos(ph * Math.PI + (side > 0 ? 0 : Math.PI))) * 0.04; P[2] = -0.2 - reach * 0.18;
        P[3] = -1.25; P[4] = side * -0.25; P[5] = side * -1.35;
      }
      res.curlR = res.curlL = 0.25;
      k = this.downK;
    } else if (this.swim > 0.05) {
      // a slow breaststroke at the surface
      const ph = time * 1.4;
      for (const side of [1, -1] as const) {
        const P = side > 0 ? R : L;
        const c = (Math.sin(ph) * 0.5 + 0.5);
        P[0] = side * (0.08 + 0.22 * c); P[1] = -0.22 + 0.02 * Math.cos(ph); P[2] = -0.4 + 0.18 * c;
        P[3] = -1.4; P[4] = 0; P[5] = side * (-1.4 - 0.4 * c);
      }
      res.curlR = res.curlL = 0.15;
      k = this.swim;
    } else if (this.carryK > 0.02 && inp.logEnd) {
      // both hands on the log end in front
      const e = inp.logEnd;
      const ex = clamp(e.x, -0.25, 0.25), ey = clamp(e.y, -0.6, -0.16), ez = clamp(e.z, -0.55, -0.22);
      R[0] = ex + 0.07; R[1] = ey + 0.035; R[2] = ez + 0.02; R[3] = -0.35; R[4] = 0.5; R[5] = -0.4;
      L[0] = ex - 0.07; L[1] = ey + 0.035; L[2] = ez + 0.02; L[3] = -0.35; L[4] = -0.5; L[5] = 0.4;
      // the strain of the weight: a slow heave with the stride
      R[1] += Math.sin(inp.view.rig.bob * TAU * 2) * 0.006;
      L[1] += Math.sin(inp.view.rig.bob * TAU * 2 + 0.5) * 0.006;
      res.curlR = res.curlL = 0.85;
      k = this.carryK;
    } else if (this.act === 'ignite') {
      k = this.ignite(t, R, L, res, dt);
    } else if (this.act === 'eat') {
      k = this.eat(t, R, L, res);
    } else if (this.act === 'use') {
      // reach to the lid and lift it
      const s = sat(t / 0.6);
      k = sstep(0, 0.25, s);
      R[0] = 0.11; R[1] = -0.25 + 0.04 * sstep(0.5, 1, s); R[2] = -0.42 - 0.04 * s; R[3] = -0.9; R[4] = 0.35; R[5] = -0.6;
      L[0] = -0.11; L[1] = -0.25 + 0.04 * sstep(0.5, 1, s); L[2] = -0.42 - 0.04 * s; L[3] = -0.9; L[4] = -0.35; L[5] = 0.6;
      res.curlR = res.curlL = 0.6;
    } else if (this.act === 'revive') {
      // both hands down on the teammate, pressing in a rhythm
      k = sstep(0, 0.35, t);
      const pump = Math.max(0, Math.sin(t * TAU * 1.6)) * 0.035;
      R[0] = 0.06; R[1] = -0.33 - pump; R[2] = -0.38; R[3] = -1.35; R[4] = 0.2; R[5] = -0.3;
      L[0] = -0.06; L[1] = -0.33 - pump; L[2] = -0.38; L[3] = -1.35; L[4] = -0.2; L[5] = 0.3;
      res.curlR = res.curlL = 0.2;
    } else if (this.act === 'climbOut') {
      // flat hands on the ice edge, pushing up
      k = sstep(0, 0.3, t);
      const push = sstep(0.3, 1.6, t);
      R[0] = 0.17; R[1] = -0.2 - 0.12 * push; R[2] = -0.36 + 0.1 * push; R[3] = -1.45; R[4] = 0.3; R[5] = -1.45;
      L[0] = -0.17; L[1] = -0.2 - 0.12 * push; L[2] = -0.36 + 0.1 * push; L[3] = -1.45; L[4] = -0.3; L[5] = 1.45;
      res.curlR = res.curlL = 0.1;
    } else if (this.act === 'crank' && me.held !== 'radio') {
      // the generator's crank: a big two-handed wheel, just out of the bottom of the view
      k = sstep(0, 0.4, t);
      const a = t * 4.5;
      R[0] = 0.08 + Math.cos(a) * 0.05; R[1] = -0.3 + Math.sin(a) * 0.05; R[2] = -0.4; R[3] = -0.6; R[4] = 0.4; R[5] = -0.8;
      L[0] = 0.0 + Math.cos(a) * 0.05; L[1] = -0.31 + Math.sin(a) * 0.05; L[2] = -0.4; L[3] = -0.6; L[4] = -0.2; L[5] = 0.8;
      res.curlR = res.curlL = 0.9;
    }
    if (k <= 0.001) return null;
    if (toolUp) k = Math.min(k, 1); // the tool is going down at the same time
    // from rest to the act pose
    mix6(this.tmp, REST_R, R, sstep(0, 1, k));
    this.applyFeelHands(this.tmp, inp.view, time);
    this.setHand(out.hands[0], this.tmp);
    mix6(this.tmp, REST_L, L, sstep(0, 1, k));
    this.applyFeelHands(this.tmp, inp.view, time);
    this.setHand(out.hands[1], this.tmp);
    return res;
  }

  /** Breath, bob and shiver for bare hands. */
  private applyFeelHands(h: P6, view: View, time: number): void {
    const rig = view.rig;
    const br = Math.sin(rig.breath * TAU);
    h[1] += br * 0.002 + (Math.cos(rig.bob * TAU * 2) - 1) * 0.004 * rig.stride;
    const sh = rig.shiver;
    if (sh > 0.001) {
      h[0] += Math.sin(time * 43.1) * 0.0018 * sh;
      h[1] += Math.sin(time * 39.7 + 1.3) * 0.0016 * sh;
    }
    h[1] -= rig.landing * 0.04;
  }

  /** Strike a match on the box, shelter the flame in the cupped hands, take it down to the fire. */
  private ignite(t: number, R: P6, L: P6, res: HandsResult, dt: number): number {
    const s = t / IGNITE_TIME;
    const out = this.out;
    // left hand: the box held across the palm in front of the chest
    track(L, IGN_L, s);
    track(R, IGN_R, s);
    res.curlL = lerp(0.62, 0.55, sstep(0.45, 0.6, s));
    res.thumbL = 0.5;
    res.curlR = 0.75;
    res.thumbR = 0.9;
    const box = this.extra('matchbox');
    box.on = s < 0.47;
    mat6(_m, L);
    _m2.makeRotationFromEuler(_e.set(0, 0, Math.PI / 2)).setPosition(-0.0, 0.055, -0.004);
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
    match.glow = k * 7 * flare + (1 - lit) * 0;
    out.flame.on = k > 0.01;
    out.flame.k = k * (0.75 + 0.25 * flare) * (0.85 + 0.15 * Math.sin(this.actT * 37) * Math.sin(this.actT * 23));
    _v.set(0, 0.024, 0).applyMatrix4(match.m);
    out.flame.pos.copy(_v);
    void dt;
    return sstep(0, 0.15, s) * (1 - sstep(0.9, 1, s));
  }

  /** Eat a ration bar, drink from the thermos, or bandage the left forearm. */
  private eat(t: number, R: P6, L: P6, res: HandsResult): number {
    const s = t / EAT_TIME;
    const what = this.eatWhat;
    if (what === 'bandage') {
      // left forearm across in front, the right hand winds the roll round it twice
      L[0] = -0.04; L[1] = -0.2; L[2] = -0.33; L[3] = -0.3; L[4] = -1.25; L[5] = 0.25;
      const wind = sat((s - 0.15) / 0.65) * TAU * 2;
      const c = Math.cos(wind), sn = Math.sin(wind);
      R[0] = 0.04 + 0.01 * Math.sin(wind * 0.5); R[1] = -0.2 + sn * 0.055; R[2] = -0.33 + c * 0.05;
      R[3] = -0.6 + sn * 0.5; R[4] = 0.7; R[5] = -0.9 + c * 0.4;
      res.curlL = 0.4; res.curlR = 0.65; res.thumbR = 0.8;
      const roll = this.extra('bandage');
      roll.on = s < 0.9;
      mat6(_m, R);
      _m2.makeRotationFromEuler(_e.set(0, 0.0, 0.2)).setPosition(0.005, 0.07, -0.01);
      roll.m.multiplyMatrices(_m, _m2);
      return sstep(0, 0.15, s) * (1 - sstep(0.85, 1, s));
    }
    if (what === 'thermos') {
      // up to the mouth, tipped back, a long drink, down
      const tip = sstep(0.2, 0.45, s) * (1 - sstep(0.75, 0.9, s));
      R[0] = lerp(0.12, 0.03, tip); R[1] = lerp(-0.26, -0.12, tip); R[2] = lerp(-0.34, -0.2, tip);
      R[3] = lerp(-0.2, 0.75, tip); R[4] = 0.5; R[5] = lerp(-1.3, -1.45, tip);
      res.curlR = 0.95; res.thumbR = 1;
      const th = this.extra('thermos');
      th.on = true;
      mat6(_m, R);
      _m2.makeRotationFromEuler(_e.set(0, 0, Math.PI / 2)).setPosition(0.0, 0.0, 0.03);
      th.m.multiplyMatrices(_m, _m2);
      return sstep(0, 0.15, s) * (1 - sstep(0.88, 1, s));
    }
    // a ration: up to the mouth, two bites, down
    const up = sstep(0.1, 0.3, s) * (1 - sstep(0.8, 0.95, s));
    const bite = bump(0.35, 0.5, s) + bump(0.55, 0.7, s);
    R[0] = lerp(0.12, 0.025, up); R[1] = lerp(-0.25, -0.115, up) - bite * 0.01; R[2] = lerp(-0.34, -0.17, up) + bite * 0.02;
    R[3] = lerp(-0.3, 0.2, up); R[4] = lerp(0.3, 0.7, up); R[5] = lerp(-1.0, -1.35, up);
    res.curlR = 0.7; res.thumbR = 0.9;
    const bar = this.extra('ration');
    bar.on = true;
    mat6(_m, R);
    _m2.makeRotationFromEuler(_e.set(0.0, 0.0, -0.4)).setPosition(0.0, 0.055, -0.012);
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
}

interface ActGrip {
  r: boolean;
  l: boolean;
  rGrip: THREE.Matrix4 | null;
  lGrip: THREE.Matrix4 | null;
  rOverride: P6 | null;
  lOverride: P6 | null;
  curlR?: number;
  curlL?: number;
  thumbR?: number;
  thumbL?: number;
}
const ACT: ActGrip = { r: true, l: false, rGrip: null, lGrip: null, rOverride: null, lOverride: null };

interface HandsResult { curlR: number; curlL: number; thumbR: number; thumbL: number }
const HANDS: HandsResult = { curlR: 0.35, curlL: 0.35, thumbR: 0.4, thumbL: 0.4 };

/** Rifle bolt pivot and radio crank axle (model space), from the models. */
const BOLT = new THREE.Vector3();
const CRANK = new THREE.Vector3();
{
  // filled lazily on first use: the models register on import
  const fill = (): void => {
    const r = toolModel('rifle', 0).parts.bolt;
    if (r) BOLT.copy(r.pivot);
    const c = toolModel('radio', 0).parts.crank;
    if (c) CRANK.copy(c.pivot);
  };
  queueMicrotask(fill);
}

// ------------------------------------------------------------------------------------------
// Keyframes (P6 of the tool / hands in camera space; t in seconds or as a fraction of the act)
// ------------------------------------------------------------------------------------------

/** Axe swing, seconds (SWING_TIME 0.8, the blade lands at SWING_HIT 0.32). */
const AXE_SWING: readonly (readonly [number, P6])[] = [
  [0.0, [0.2, -0.27, -0.33, -0.42, 0.18, -0.3]],
  [0.1, [0.19, -0.08, -0.16, 0.55, 0.32, -0.55]],
  [0.18, [0.16, 0.02, -0.08, 1.05, 0.42, -0.75]],
  [SWING_HIT - 0.06, [0.08, -0.12, -0.32, -0.55, 0.12, -0.25]],
  [SWING_HIT, [0.02, -0.24, -0.4, -1.5, -0.02, 0.05]],
  [SWING_HIT + 0.08, [0.0, -0.28, -0.38, -1.62, -0.05, 0.08]],
  [0.55, [0.1, -0.3, -0.36, -1.0, 0.08, -0.12]],
  [SWING_TIME, [0.2, -0.27, -0.33, -0.42, 0.18, -0.3]],
];

/** Flashlight cell swap, fraction of CELL_SWAP: tail turned to the left hand. */
const FLASH_SWAP: readonly (readonly [number, P6])[] = [
  [0.0, [0.16, -0.205, -0.34, 0.035, 0.07, 0.12]],
  [0.15, [0.07, -0.24, -0.33, 0.25, 1.05, 0.2]],
  [0.5, [0.06, -0.25, -0.32, 0.4, 1.15, 0.25]],
  [0.85, [0.07, -0.24, -0.33, 0.25, 1.05, 0.2]],
  [1.0, [0.16, -0.205, -0.34, 0.035, 0.07, 0.12]],
];

/** Flare gun reload, fraction of FLARE_RELOAD: in to the middle, break open, load, snap shut. */
const FLARE_LOAD: readonly (readonly [number, P6])[] = [
  [0.0, [0.155, -0.215, -0.31, 0.05, 0.08, 0.06]],
  [0.14, [0.08, -0.22, -0.3, 0.3, 0.55, 0.55]],
  [0.3, [0.07, -0.21, -0.3, 0.42, 0.6, 0.7]],
  [0.7, [0.07, -0.21, -0.3, 0.42, 0.6, 0.7]],
  [0.8, [0.08, -0.205, -0.3, 0.2, 0.55, 0.55]],
  [0.86, [0.09, -0.2, -0.3, 0.45, 0.5, 0.45]],
  [1.0, [0.155, -0.215, -0.31, 0.05, 0.08, 0.06]],
];

/** The left hand during the flare gun reload, in the gun's model space (P6 of the hand frame). */
const FLARE_LHAND: readonly (readonly [number, P6])[] = [
  [0.1, [-0.03, -0.2, 0.05, 0.2, 0.3, 0.6]],
  [0.18, [-0.004, 0.08, -0.11, 0.0, -Math.PI / 2, 0.0]],
  [0.3, [0.0, 0.06, -0.12, 0.0, -Math.PI / 2, 0.0]],
  [0.45, [-0.05, -0.12, 0.06, 0.6, 0.2, 0.8]],
  [0.62, [-0.01, 0.06, 0.05, 1.2, 0.3, 1.0]],
  [0.72, [-0.004, 0.085, 0.035, 1.35, 0.25, 1.1]],
  [0.8, [-0.004, 0.08, -0.11, 0.0, -Math.PI / 2, 0.0]],
  [0.9, [-0.04, -0.15, 0.04, 0.3, 0.2, 0.6]],
];

/** Lighting a match: left hand with the box, right hand with the match (fraction of IGNITE_TIME). */
const IGN_L: readonly (readonly [number, P6])[] = [
  [0.0, [-0.12, -0.33, -0.3, 0.2, 0.3, 1.2]],
  [0.18, [-0.03, -0.215, -0.33, 0.25, 0.45, 1.45]],
  [0.42, [-0.025, -0.215, -0.33, 0.25, 0.45, 1.45]],
  [0.55, [-0.03, -0.2, -0.33, 0.1, 0.9, 1.35]],
  [0.75, [-0.02, -0.26, -0.4, -0.35, 0.9, 1.3]],
  [0.95, [-0.04, -0.33, -0.45, -0.6, 0.8, 1.2]],
  [1.0, [-0.08, -0.4, -0.4, -0.4, 0.5, 1.2]],
];
const IGN_R: readonly (readonly [number, P6])[] = [
  [0.0, [0.12, -0.33, -0.3, 0.2, -0.3, -1.2]],
  [0.18, [0.06, -0.205, -0.31, 0.5, -0.5, -0.9]],
  [0.27, [0.025, -0.2, -0.31, 0.5, -0.5, -0.9]],
  [0.34, [0.09, -0.19, -0.32, 0.45, -0.6, -0.8]],
  [0.5, [0.04, -0.19, -0.33, 0.3, -0.8, -1.0]],
  [0.75, [0.035, -0.25, -0.41, -0.2, -0.8, -1.0]],
  [0.95, [0.02, -0.33, -0.47, -0.5, -0.7, -1.0]],
  [1.0, [0.08, -0.4, -0.4, -0.3, -0.4, -1.1]],
];
