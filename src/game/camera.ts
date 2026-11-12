// The camera: first person at eye height with the body's feel (head bob tied to the stride,
// landing dip, sway that grows with cold and exhaustion, a lean into strong wind, optional shake,
// a fov kick when sprinting), a third-person chase view (dev, photo mode, downed) kept out of the
// terrain and walls, and the slow drift behind the title screen. It fills view.camera and moves
// the engine's PerspectiveCamera (rotation order YXZ: yaw, pitch, roll).
// Owner: GAME.
import type * as THREE from 'three/webgpu';
import { clamp, damp, lerp, smoothstep, wrapAngle } from '../core/math';
import { EYE_CROUCH, EYE_DOWNED, EYE_STAND, EYE_SWIM, PITCH_LIMIT, WALK_SPEED } from '../sim/move';
import type { PlayerEnt } from '../sim/types';
import type { World } from '../world/types';
import type { Camera, View, ViewEnt } from './view';

const DEG = Math.PI / 180;
/** Third-person boom: metres behind the head, and its height above the feet. */
const CHASE_DIST = 3.4;
const CHASE_UP = 1.95;
const PHOTO_DIST = 4.6;
/** Kept this far above the terrain / away from a wall. */
const CLEARANCE = 0.45;

export interface CameraInput {
  /** The local look direction (applied per input event; the newest value, not the last tick's). */
  yaw: number;
  pitch: number;
  /** Seconds of real time. */
  time: number;
  /** Third person requested (dev V); photo mode; title drift. */
  third: boolean;
  photo: boolean;
  title: boolean;
}

export class CameraRig {
  private eye = EYE_STAND;
  private third = 0;
  private fovKick = 0;
  private dip = 0;
  private dipV = 0;
  private shake = 0;
  private lean = 0;
  private boom = CHASE_DIST;
  private lastLanding = 0;
  private titleStart = -1;

  constructor(private readonly world: World) {}

  /** Snap the smoothed values (after a teleport, a load, the end of the title). */
  reset(): void {
    this.third = 0;
    this.dip = this.dipV = 0;
    this.shake = 0;
    this.fovKick = 0;
    this.boom = CHASE_DIST;
    this.titleStart = -1;
  }

  /** Add a short positional shake, 0..1 (landing hard, a gunshot close by). */
  kick(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  update(dt: number, view: View, inp: CameraInput, cam3: THREE.PerspectiveCamera): void {
    const out = view.camera;
    const me = view.me;
    if (inp.title || !me) {
      this.titleDrift(view, inp.time, out);
      out.fov = 55;
      out.third = 1;
    } else {
      this.player(dt, view, me, inp, out);
    }
    // apply to the renderer's camera
    cam3.position.set(out.x, out.y, out.z);
    cam3.rotation.set(out.pitch, out.yaw, out.roll, 'YXZ');
    if (Math.abs(cam3.fov - out.fov) > 0.01) {
      cam3.fov = out.fov;
      cam3.updateProjectionMatrix();
    }
  }

  private player(dt: number, view: View, me: ViewEnt<PlayerEnt>, inp: CameraInput, out: Camera): void {
    const rig = view.rig;
    const settings = view.settings;
    const env = view.env;

    // --- eye height follows the stance smoothly (crouching takes about a fifth of a second)
    const downed = me.life === 'downed' || me.life === 'dead';
    const target = me.swim ? EYE_SWIM : downed ? EYE_DOWNED : me.crouch ? EYE_CROUCH : EYE_STAND;
    this.eye = damp(this.eye, target, me.swim ? 4 : 11, dt);

    // --- landing: a damped spring pushed down by the impact
    if (rig.landing > this.lastLanding + 0.05) {
      this.dipV -= 1.6 * rig.landing;
      if (settings.shake && rig.landing > 0.45) this.kick(rig.landing * 0.5);
    }
    this.lastLanding = rig.landing;
    const k = 120, c = 16;
    this.dipV += (-k * this.dip - c * this.dipV) * dt;
    this.dip += this.dipV * dt;
    this.dip = clamp(this.dip, -0.35, 0.1);

    // --- head bob tied to the stride: two dips per cycle (one per footfall), a sway once per cycle
    const phase = rig.bob * Math.PI * 2;
    // rig.stride is speed / sprint speed: about 0.57 walking, 1 sprinting
    const amp = rig.stride * 1.75 * (me.crouch ? 0.6 : 1);
    const bobY = -0.032 * amp * (0.5 - 0.5 * Math.cos(phase * 2));
    const bobX = 0.022 * amp * Math.sin(phase);
    const bobRoll = 0.006 * amp * Math.sin(phase);

    // --- cold and exhaustion: a slow wander of the view; shivering: a fine tremor
    const t = inp.time;
    const sw = rig.sway;
    const wanderYaw = sw * (0.012 * Math.sin(t * 0.71) + 0.007 * Math.sin(t * 1.93 + 1.3));
    const wanderPitch = sw * (0.009 * Math.sin(t * 0.93 + 0.4) + 0.005 * Math.sin(t * 2.41));
    const sh = rig.shiver;
    const tremor = sh * 0.0025;
    const shivYaw = tremor * Math.sin(t * 37.1) * Math.sin(t * 3.1);
    const shivPitch = tremor * Math.sin(t * 41.7 + 2) * Math.sin(t * 2.3 + 1);

    // --- lean into strong wind: roll toward the side the wind comes from
    const yaw = inp.yaw;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw); // camera right
    const ws = Math.hypot(env.windX, env.windZ) * (1 + env.gust * 0.6);
    const side = ws > 0.01 ? (env.windX * rx + env.windZ * rz) / ws : 0;
    const strength = smoothstep(8, 22, ws) * (1 - clamp(me.shelter, 0, 1));
    this.lean = damp(this.lean, side * strength * 1.8 * DEG, 2.5, dt);

    // --- shake decays fast
    this.shake = damp(this.shake, 0, 7, dt);
    const sk = settings.shake ? this.shake : 0;
    const shakeX = sk * 0.03 * Math.sin(t * 61), shakeY = sk * 0.03 * Math.sin(t * 53 + 1.7);

    // --- recoil pitches the view up for a moment
    const recoil = rig.recoil * 0.035;

    // --- fov: kick when sprinting
    this.fovKick = damp(this.fovKick, me.sprint && rig.speed > WALK_SPEED * 1.1 ? 1 : 0, 4, dt);
    const fov = settings.fov + 6 * this.fovKick;

    // --- first-person pose
    const fx = me.x + rx * (bobX + shakeX);
    const fz = me.z + rz * (bobX + shakeX);
    const fy = me.y + this.eye + bobY + this.dip + shakeY;
    const fyaw = yaw + wanderYaw + shivYaw;
    const fpitch = clamp(inp.pitch + wanderPitch + shivPitch + recoil, -PITCH_LIMIT, PITCH_LIMIT);
    const froll = bobRoll + this.lean;

    // --- third person: requested (dev), photo mode, or down in the snow
    const want = inp.photo || inp.third || downed ? 1 : 0;
    this.third = damp(this.third, want, 6, dt);
    if (this.third < 0.002 && want === 0) this.third = 0;
    if (this.third === 0) {
      out.x = fx;
      out.y = fy;
      out.z = fz;
      out.yaw = fyaw;
      out.pitch = fpitch;
      out.roll = froll;
      out.fov = fov;
      out.third = 0;
      return;
    }
    // Boom from the head, behind the look direction, kept out of terrain and walls.
    const headY = me.y + (downed ? 0.5 : Math.min(this.eye, EYE_STAND) + 0.1);
    const pitch = clamp(inp.pitch, -1.2, 1.2);
    const dist = inp.photo ? PHOTO_DIST : CHASE_DIST;
    const fwx = -Math.sin(yaw) * Math.cos(pitch), fwy = Math.sin(pitch), fwz = -Math.cos(yaw) * Math.cos(pitch);
    // the boom points back and a little up from the head
    let bx = -fwx, by = -fwy + (CHASE_UP - EYE_STAND) / dist, bz = -fwz;
    const bl = Math.hypot(bx, by, bz);
    bx /= bl;
    by /= bl;
    bz /= bl;
    let len = dist;
    const hit = this.world.raycast(me.x, headY, me.z, bx, by, bz, dist + CLEARANCE);
    if (hit) len = Math.max(0.6, hit.dist - CLEARANCE);
    // the boom comes in fast and goes out slowly
    this.boom = len < this.boom ? len : damp(this.boom, len, 3, dt);
    let cx = me.x + bx * this.boom, cy = headY + by * this.boom, cz = me.z + bz * this.boom;
    const ground = this.world.heightAt(cx, cz) + CLEARANCE;
    if (cy < ground) cy = ground;
    // look at a point ahead of the head along the look direction
    const lx = me.x + fwx * 2, ly = headY + fwy * 2, lz = me.z + fwz * 2;
    const dx = lx - cx, dy = ly - cy, dz = lz - cz;
    const tyaw = Math.atan2(-dx, -dz);
    const tpitch = Math.atan2(dy, Math.hypot(dx, dz));
    const a = smoothstep(0, 1, this.third);
    out.x = lerp(fx, cx, a);
    out.y = lerp(fy, cy, a);
    out.z = lerp(fz, cz, a);
    out.yaw = fyaw + wrapAngle(tyaw - fyaw) * a;
    out.pitch = lerp(fpitch, tpitch, a);
    out.roll = lerp(froll, 0, a);
    out.fov = lerp(fov, settings.fov, a);
    out.third = this.third;
  }

  /** Behind the title: a slow walk-around of the wreck, eye-level and kept above the snow. */
  private titleDrift(view: View, time: number, out: Camera): void {
    const w = this.world;
    if (this.titleStart < 0) this.titleStart = time;
    const t = time - this.titleStart;
    const p = w.poi('wreck');
    // An arc on the uphill side looking down over the fuselage toward the valley.
    const a = p.yaw + Math.PI + 0.55 + 0.35 * Math.sin(t * 0.021);
    const r = 24 + 3 * Math.sin(t * 0.033);
    const cx = p.x + Math.sin(a) * r, cz = p.z + Math.cos(a) * r;
    const cy = Math.max(w.heightAt(cx, cz) + 2.2, p.y + 2.6);
    const tx = p.x, tz = p.z, ty = p.y + 1.4;
    const dx = tx - cx, dy = ty - cy, dz = tz - cz;
    out.x = cx;
    out.y = cy;
    out.z = cz;
    out.yaw = Math.atan2(-dx, -dz);
    out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    out.roll = 0;
    void view;
  }
}
