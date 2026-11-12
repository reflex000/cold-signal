// Player movement. stepPlayerMove is a PURE function of (player, command, static world): the
// host runs it once per command and the owning client runs the very same code to predict, so it
// must never read the rest of the simulation state, a clock or a random number.
// It mutates only the movement fields of the player:
//   x y z vx vy vz yaw pitch onGround crouch sprint surface swim stamina
// Owner: SIM.
import { clamp, wrapAngle } from '../core/math';
import type { Collider, World } from '../world/types';
import { BTN, type InputCmd, type PlayerEnt, type SimEvent } from './types';

// --- body (metres). Eye heights are for presentation; the simulation tracks the feet.
export const PLAYER_RADIUS = 0.32;
export const PLAYER_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.15;
export const DOWNED_HEIGHT = 0.7;
export const EYE_STAND = 1.66;
export const EYE_CROUCH = 1.02;
export const EYE_DOWNED = 0.38;
/** Feet below the water surface while swimming. */
export const SWIM_DEPTH = 1.3;
/** Eye above the feet while swimming (keeps the eyes just over the water line). */
export const EYE_SWIM = SWIM_DEPTH + 0.16;
export const STEP_HEIGHT = 0.4;

// --- speeds (m/s)
export const WALK_SPEED = 2.6;
export const SPRINT_SPEED = 4.6;
export const CROUCH_SPEED = 1.3;
export const CRAWL_SPEED = 0.5; // downed
export const DRAG_SPEED = 1.2; // a heavy log, alone
export const SWIM_SPEED = 0.8;
export const JUMP_SPEED = 4.3;
export const GRAVITY = 14;
export const TERMINAL_SPEED = 45;
export const MAX_SLOPE_DEG = 42;
export const PITCH_LIMIT = 1.5;

// --- stamina (0..1)
export const SPRINT_SECONDS = 12; // full to empty
export const SPRINT_MIN_STAMINA = 0.15; // needed to start sprinting again after running dry
export const JUMP_COST = 0.06;
const REGEN_STILL = 1 / 8; // per second
const REGEN_MOVING = 1 / 14;

// --- feel
const ACCEL = 11; // m/s^2 toward the wanted velocity: about a quarter second to walking pace
const DECEL = 13; // m/s^2 when the stick is released
const ICE_ACCEL = 2.2;
const ICE_DECEL = 1.0;
const AIR_ACCEL = 2.5;
const SWIM_ACCEL = 3;
const BACK_FACTOR = 0.8; // backpedalling
const SNOW_FREE = 0.1; // metres of loose snow that cost nothing
const SNOW_MIN = 0.45; // slowest factor, in the deepest drifts
const UPHILL_COST = 0.55; // speed lost per unit of climb (sine of the slope along the heading)
const SLIDE_CONTROL = 3; // m/s^2 of steering while sliding down a steep face
const SLIDE_MAX = 7; // m/s
const EDGE_BAND = 5; // metres over which the world edge pushes back
const EDGE_MARGIN = 1.5; // hard stop this far inside world.half
const COS_MAX_SLOPE = Math.cos((MAX_SLOPE_DEG * Math.PI) / 180);
const ON_TERRAIN_EPS = 0.05;

/** Speed factor from loose snow depth in metres: 1 up to 0.1 m, about 0.6 at 0.5 m. */
export function snowSpeedFactor(depth: number): number {
  return depth <= SNOW_FREE ? 1 : Math.max(SNOW_MIN, 1 - (depth - SNOW_FREE));
}

/** Speed factor from core temperature: full above 33 C, down to 0.75 at 30 C. */
export function coldSpeedFactor(core: number): number {
  return core >= 33 ? 1 : 1 - 0.25 * Math.min(1, (33 - core) / 3);
}

// Scratch shared by every call. It holds no state between calls.
const cols: Collider[] = [];
let outX = 0;
let outZ = 0;

/** Move the horizontal velocity toward (tx, tz) by at most `step` m/s. */
function approachVel(p: PlayerEnt, tx: number, tz: number, step: number): void {
  const dx = tx - p.vx, dz = tz - p.vz;
  const d = Math.hypot(dx, dz);
  if (d <= step || d < 1e-9) {
    p.vx = tx;
    p.vz = tz;
  } else {
    const k = step / d;
    p.vx += dx * k;
    p.vz += dz * k;
  }
}

/** Soft world edge: outward travel fades to nothing across the band, then a hard stop. */
function edgeAxis(from: number, to: number, half: number): number {
  const hard = half - EDGE_MARGIN;
  const soft = hard - EDGE_BAND;
  const a = Math.abs(to);
  if (a <= soft) return to;
  const s = to < 0 ? -1 : 1;
  const d = (to - from) * s; // outward travel this step
  if (d > 0) {
    const k = Math.min(1, (a - soft) / EDGE_BAND);
    to -= s * d * k;
  }
  return to > hard ? hard : to < -hard ? -hard : to;
}

/**
 * Push a vertical cylinder (the player) out of the static colliders around (x, z) and take the
 * velocity into them away, so the player slides along walls and round trunks. Colliders whose
 * top is within a step of the feet are walked over; those above the head are ignored.
 * Result in outX / outZ.
 */
function collide(p: PlayerEnt, x: number, z: number, feet: number, height: number, world: World): void {
  cols.length = 0;
  world.collidersNear(x, z, PLAYER_RADIUS + 0.6, cols);
  const n = cols.length;
  if (n > 0) {
    const R = PLAYER_RADIUS;
    for (let pass = 0; pass < 3; pass++) {
      let hit = false;
      for (let i = 0; i < n; i++) {
        const c = cols[i];
        if (c.y1 <= feet + STEP_HEIGHT || c.y0 >= feet + height) continue;
        let nx: number, nz: number, push: number;
        if (c.s === 'c') {
          const dx = x - c.x, dz = z - c.z, rr = c.r + R;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            nx = dx / d;
            nz = dz / d;
          } else {
            nx = 1;
            nz = 0;
          }
          push = rr - d;
        } else {
          // Box frame: local +X is (cos yaw, -sin yaw), local +Z is (sin yaw, cos yaw), as Object3D.rotation.y.
          const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
          const dx = x - c.x, dz = z - c.z;
          const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
          const qx = lx < -c.hx ? -c.hx : lx > c.hx ? c.hx : lx;
          const qz = lz < -c.hz ? -c.hz : lz > c.hz ? c.hz : lz;
          const ex = lx - qx, ez = lz - qz;
          const d2 = ex * ex + ez * ez;
          if (d2 >= R * R) continue;
          let nlx: number, nlz: number;
          if (d2 > 1e-12) {
            const d = Math.sqrt(d2);
            nlx = ex / d;
            nlz = ez / d;
            push = R - d;
          } else {
            // Centre inside the box: leave through the nearest face.
            const px = c.hx - Math.abs(lx), pz = c.hz - Math.abs(lz);
            if (px < pz) {
              nlx = lx < 0 ? -1 : 1;
              nlz = 0;
              push = px + R;
            } else {
              nlx = 0;
              nlz = lz < 0 ? -1 : 1;
              push = pz + R;
            }
          }
          nx = nlx * cs + nlz * sn;
          nz = -nlx * sn + nlz * cs;
        }
        x += nx * push;
        z += nz * push;
        const vn = p.vx * nx + p.vz * nz;
        if (vn < 0) {
          p.vx -= vn * nx;
          p.vz -= vn * nz;
        }
        hit = true;
      }
      if (!hit) break;
    }
  }
  outX = x;
  outZ = z;
}

function regenStamina(p: PlayerEnt, rate: number, dt: number): void {
  // Cold muscles recover slowly: full rate above 35 C, about a third at 31 C.
  const cold = p.core >= 35 ? 1 : 1 - 0.65 * Math.min(1, (35 - p.core) / 4);
  p.stamina = Math.min(1, p.stamina + rate * cold * dt);
}

function swimStep(p: PlayerEnt, wx: number, wz: number, world: World, dt: number): void {
  const speed = SWIM_SPEED * coldSpeedFactor(p.core);
  approachVel(p, wx * speed, wz * speed, SWIM_ACCEL * dt);
  const nx = edgeAxis(p.x, p.x + p.vx * dt, world.half);
  const nz = edgeAxis(p.z, p.z + p.vz * dt, world.half);
  collide(p, nx, nz, p.y, PLAYER_HEIGHT, world);
  p.x = outX;
  p.z = outZ;
  // Float chest-deep: a damped pull toward the swimming depth, no gravity.
  const target = world.lake.level - SWIM_DEPTH;
  p.vy = clamp((target - p.y) * 5, -4, 2);
  p.y += p.vy * dt;
  p.onGround = false;
  p.crouch = false;
  p.sprint = false;
  p.surface = 'water';
  regenStamina(p, REGEN_MOVING * 0.5, dt);
}

export function stepPlayerMove(p: PlayerEnt, cmd: InputCmd, world: World, dt: number): void {
  p.yaw = wrapAngle(cmd.yaw);
  p.pitch = clamp(cmd.pitch, -PITCH_LIMIT, PITCH_LIMIT);

  if (p.life === 'rescued') {
    // On the winch or aboard: the helicopter owns the position. Only the look moves.
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.sprint = false;
    return;
  }

  const alive = p.life === 'alive';
  const downed = p.life === 'downed';
  const b = alive || downed ? cmd.b : 0;

  // Wanted direction on the ground plane. Yaw 0 faces north (-Z); positive yaw turns left.
  let wx = 0, wz = 0;
  if (alive || downed) {
    const mx = clamp(cmd.mx, -1, 1), mz = clamp(cmd.mz, -1, 1);
    const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
    wx = c * mx - s * mz;
    wz = -s * mx - c * mz;
    const l = Math.hypot(wx, wz);
    if (l > 1) {
      wx /= l;
      wz /= l;
    }
  }
  let wish = Math.hypot(wx, wz);

  // --- in the water under the ice -------------------------------------------------------------
  if (p.swim && world.iceAt(p.x, p.z) <= 0) {
    // Reached the shore: stand up on the bank.
    p.swim = false;
    p.y = world.groundAt(p.x, p.z, world.heightAt(p.x, p.z)).y;
    p.vy = 0;
    p.onGround = true;
  }
  if (p.swim) {
    swimStep(p, wx, wz, world, dt);
    return;
  }

  // --- what is underfoot ----------------------------------------------------------------------
  const onTerrain = p.onGround && p.y <= world.heightAt(p.x, p.z) + ON_TERRAIN_EPS;
  let steep = false;
  let dhx = 0, dhz = 0; // unit downhill direction
  let sinS = 0, cosS = 1;
  if (onTerrain) {
    const n = world.normalAt(p.x, p.z);
    const h = Math.hypot(n.x, n.z);
    if (h > 1e-5) {
      dhx = n.x / h;
      dhz = n.z / h;
      sinS = h;
      cosS = n.y;
      steep = n.y < COS_MAX_SLOPE;
    }
  }

  // --- stance and pace ------------------------------------------------------------------------
  const carrying = p.carry !== 0;
  const crouch = alive && !carrying && (b & BTN.CROUCH) !== 0;
  const sprint =
    alive && !carrying && !crouch && !steep && (b & BTN.SPRINT) !== 0 && cmd.mz > 0.3 && wish > 0.5 &&
    p.stamina > (p.sprint ? 0 : SPRINT_MIN_STAMINA);

  let speed = downed ? CRAWL_SPEED : carrying ? (p.carryPair ? WALK_SPEED : DRAG_SPEED) : crouch ? CROUCH_SPEED : sprint ? SPRINT_SPEED : WALK_SPEED;
  speed *= coldSpeedFactor(p.core);
  if (cmd.mz < 0 && !downed) speed *= 1 - (1 - BACK_FACTOR) * Math.min(1, -cmd.mz);

  let accel = ACCEL, decel = DECEL;
  if (p.onGround) {
    if (p.surface === 'ice') {
      accel = ICE_ACCEL;
      decel = ICE_DECEL;
    } else if (onTerrain && (p.surface === 'snow' || p.surface === 'deep')) {
      speed *= snowSpeedFactor(world.snowDepthAt(p.x, p.z));
    }
    if (onTerrain && wish > 1e-3 && !steep) {
      const climb = (-(wx * dhx + wz * dhz) / wish) * sinS;
      if (climb > 0) speed *= 1 - UPHILL_COST * climb;
    }
  } else {
    accel = AIR_ACCEL;
    decel = 0;
  }

  // --- horizontal velocity --------------------------------------------------------------------
  if (steep) {
    // Too steep to stand on: no pushing uphill, a little steering, and gravity takes over.
    const up = -(wx * dhx + wz * dhz);
    if (up > 0) {
      wx += up * dhx;
      wz += up * dhz;
      wish = Math.hypot(wx, wz);
    }
    approachVel(p, wx * speed * 0.5, wz * speed * 0.5, SLIDE_CONTROL * dt);
    const a = GRAVITY * sinS * cosS * dt;
    p.vx += dhx * a;
    p.vz += dhz * a;
    const hs = Math.hypot(p.vx, p.vz);
    if (hs > SLIDE_MAX) {
      p.vx *= SLIDE_MAX / hs;
      p.vz *= SLIDE_MAX / hs;
    }
  } else if (wish > 1e-3) {
    approachVel(p, wx * speed, wz * speed, accel * dt);
  } else if (decel > 0) {
    approachVel(p, 0, 0, decel * dt);
  }

  // --- jump -----------------------------------------------------------------------------------
  // Level-triggered (this function cannot see the previous command): holding the button hops
  // again on landing until stamina runs short. Input layers should send JUMP as a pulse.
  let jumped = false;
  if (p.onGround && alive && !carrying && !steep && (b & BTN.JUMP) !== 0 && p.stamina >= JUMP_COST) {
    p.vy = JUMP_SPEED;
    p.stamina -= JUMP_COST;
    jumped = true;
  }

  // --- move, collide, slide -------------------------------------------------------------------
  let nx = edgeAxis(p.x, p.x + p.vx * dt, world.half);
  let nz = edgeAxis(p.z, p.z + p.vz * dt, world.half);
  collide(p, nx, nz, p.y, downed ? DOWNED_HEIGHT : crouch ? CROUCH_HEIGHT : PLAYER_HEIGHT, world);
  nx = outX;
  nz = outZ;

  let g = world.groundAt(nx, nz, p.y);

  // Walking onto ground that is too steep: drop the uphill part of the step and slide along the foot of it.
  if (p.onGround && !jumped && g.y > p.y && g.y <= world.heightAt(nx, nz) + ON_TERRAIN_EPS) {
    const n = world.normalAt(nx, nz);
    if (n.y < COS_MAX_SLOPE) {
      const h = Math.hypot(n.x, n.z);
      const ux = -n.x / h, uz = -n.z / h;
      const d = (nx - p.x) * ux + (nz - p.z) * uz;
      if (d > 0) {
        nx -= d * ux;
        nz -= d * uz;
        const v = p.vx * ux + p.vz * uz;
        if (v > 0) {
          p.vx -= v * ux;
          p.vz -= v * uz;
        }
        g = world.groundAt(nx, nz, p.y);
      }
    }
  }

  // A rise taller than a step is a wall of terrain: stay put and lose the speed into it.
  if (g.y - p.y > STEP_HEIGHT + 1e-6) {
    const n = world.normalAt(nx, nz);
    const h = Math.hypot(n.x, n.z);
    if (h > 1e-5) {
      const ux = -n.x / h, uz = -n.z / h;
      const v = p.vx * ux + p.vz * uz;
      if (v > 0) {
        p.vx -= v * ux;
        p.vz -= v * uz;
      }
    } else {
      p.vx = 0;
      p.vz = 0;
    }
    nx = p.x;
    nz = p.z;
    g = world.groundAt(nx, nz, p.y);
    if (g.y - p.y > STEP_HEIGHT) {
      // Buried (teleported or pushed into the ground): lift out.
      p.y = g.y;
      p.vy = 0;
      p.onGround = true;
      jumped = false;
    }
  }
  p.x = nx;
  p.z = nz;

  // --- vertical -------------------------------------------------------------------------------
  if (p.onGround && !jumped) {
    if (p.y - g.y <= STEP_HEIGHT) {
      // Follow the ground down slopes and steps.
      p.y = g.y;
      p.vy = 0;
    } else {
      p.onGround = false; // walked off an edge
      p.vy = 0;
    }
  } else {
    p.onGround = false;
  }
  if (!p.onGround) {
    p.vy = Math.max(p.vy - GRAVITY * dt, -TERMINAL_SPEED);
    p.y += p.vy * dt;
    if (p.y <= g.y) {
      p.y = g.y;
      p.vy = 0;
      p.onGround = true;
    }
  }
  if (p.onGround) p.surface = g.surface;
  p.crouch = crouch;

  // --- stamina --------------------------------------------------------------------------------
  const hs = Math.hypot(p.vx, p.vz);
  const running = sprint && hs > 0.5;
  if (running) p.stamina = Math.max(0, p.stamina - dt / SPRINT_SECONDS);
  else regenStamina(p, hs < 0.3 ? REGEN_STILL : REGEN_MOVING, dt);
  p.sprint = running;
}

// ---------------------------------------------------------------------------------------------
// Footfalls. The stride follows the ground actually covered, so it stays in step with the speed
// in deep snow, on a climb and in a crouch. Shared by the host (players system) and the client's
// prediction, which plays its own steps without waiting for the round trip.
// ---------------------------------------------------------------------------------------------
export interface Gait {
  /** Metres covered since the last footfall. */
  dist: number;
  /** The foot that falls next. */
  left: boolean;
}

/** Metres per footfall at a ground speed: about 2.3 steps a second walking, 3 sprinting. */
export function strideLength(speed: number): number {
  return 0.6 + 0.2 * (speed < 0 ? 0 : speed > 5 ? 5 : speed);
}

/** Landing speeds below this are just a step. */
export const LAND_MIN_SPEED = 1.5;

/**
 * stepPlayerMove plus the events it causes ('step', 'jump', 'land'). Returns the metres moved on
 * the ground plane this tick.
 */
export function movePlayer(p: PlayerEnt, cmd: InputCmd, world: World, dt: number, gait: Gait, emit: (ev: SimEvent) => void): number {
  const x0 = p.x, z0 = p.z, wasGround = p.onGround, vy0 = p.vy, wasSwim = p.swim;
  stepPlayerMove(p, cmd, world, dt);
  const d = Math.hypot(p.x - x0, p.z - z0);

  if (wasGround && !p.onGround && p.vy > 1) emit({ t: 'jump', id: p.id });
  if (!wasGround && p.onGround && !wasSwim) {
    const impact = GRAVITY * dt - vy0;
    if (impact > LAND_MIN_SPEED) emit({ t: 'land', id: p.id, speed: impact });
    gait.dist = 0;
  }

  const speed = d / dt;
  if (speed < 0.3) {
    // Standing: the first footfall after setting off comes half a stride in.
    gait.dist = 0.5 * strideLength(WALK_SPEED);
  } else if (p.onGround || p.swim) {
    gait.dist += d;
    const len = strideLength(speed);
    if (gait.dist >= len) {
      gait.dist = 0;
      emit({ t: 'step', id: p.id, x: p.x, y: p.y, z: p.z, surface: p.surface, run: p.sprint, left: gait.left });
      gait.left = !gait.left;
    }
  }
  return d;
}
