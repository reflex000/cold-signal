// Tools: what the tool in hand does with PRIMARY and SECONDARY and with the 'reload' and
// 'toggleLight' actions ('equip' itself is the players system's).
//   axe        the swing is wood.ts's (act 'swing', SWING_TIME, landing at SWING_HIT, reach AXE_REACH).
//              On the tick before a blade lands, if a wolf is in reach in front, it lands on the wolf
//              now: one 'swing' event (hit 'wolf'), damage, a stagger and a yelp; actT jumps to
//              SWING_HIT so wood does not land the same swing again on wood or snow.
//   flashlight lit only in the hand. 'toggleLight' (F) switches it, taking it out of the pack first.
//              The cell gives CELL_SECONDS (12 min) of light; below CELL_DIM charge the beam dims and
//              at 0 it dies. 'reload' puts in a fresh 'cell'. SECONDARY raises it: a focused beam
//              (narrower, longer, a little hungrier). p.beam is the output now; wolves read it.
//   flare gun  one cartridge (p.flareLoaded). PRIMARY fires a 'flare' on a ballistic arc with drag and
//              the wind (flareShot); it lands (flareLand) and burns FLARE_LIFE (40 s) on the snow,
//              goes out (flareOut) and lies spent for FLARE_SPENT seconds. 'reload' breaks it open
//              and loads a cartridge from the pack. Empty: a dry click.
//   rifle      bolt action, RIFLE_MAG (5) in the magazine (p.loaded). SECONDARY raises it (p.aim);
//              the sway grows with cold, exhaustion and wind (rifleSway, deterministic, so a client
//              can draw it). PRIMARY fires a round along the swayed aim: world.raycast against the
//              terrain, trees, rocks and walls, and the wolves' hit volumes; a hit hurts or kills.
//              The bolt is then worked (BOLT_TIME). Empty: a dry click. 'reload' loads rounds one at
//              a time from 'ammo' (PRIMARY stops it after the round going in). Every shot is heard:
//              packs within SHOT_HEAR scatter. Rounds are never made up: a rifle that leaves the pack
//              unloads into it, and a player who leaves sets the loaded rounds down.
//   radio      PRIMARY held cranks it (CRANK_SECONDS from empty to full). In hand with charge it
//              listens (RADIO_SECONDS of listening per charge): p.radioSig is the strength of the
//              nearest missing radio part, or the tower once none is missing, in the facing
//              direction (a tone that rises as you face it and as you close in); p.radioDist the
//              distance to it, -1 when silent. Raised (SECONDARY) the lobe narrows.
// The acts 'shoot', 'reload' and 'crank' are this system's while 'tools.act.<id>' names the tool
// (the generator's crank may be someone else's).
// Owner: HUNT.
import { clamp, sat, TAU } from '../../core/math';
import type { SimCtx, System } from '../api';
import { CARRY_LIMIT, makeFlare } from '../entities';
import { BTN, type Env, type FlareEnt, type ItemId, type PartId, type PlayerEnt, type ToolId, type WolfEnt } from '../types';
import { eyeHeight, removeItem, spawnPickup, toast } from './items';
import { canEquip } from './players';
import { damageWolf, hearNoise, WOLF_BODY, wolfBodyNear, wolfRayHit } from './wolves';
import { AXE_REACH, SWING_HIT } from './wood';

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** Seconds of light in a full flashlight cell. */
export const CELL_SECONDS = 720;
/** Below this charge the beam dims; it gives out at 0. */
export const CELL_DIM = 0.25;
/** Seconds to change the cell, and when in it the new one goes in. */
export const CELL_SWAP = 1;
const CELL_SWAP_AT = 0.6;
/** Seconds to raise a tool all the way (p.aim 0 -> 1) and to lower it. */
export const AIM_UP = 0.3;
const AIM_DOWN = 0.2;

export const RIFLE_MAG = 5;
/** Seconds after a shot before the next: the bolt worked. */
export const BOLT_TIME = 1.2;
/** Reload: open the bolt, each round pressed in, close it. */
export const RELOAD_OPEN = 0.45;
export const RELOAD_ROUND = 0.4;
export const RELOAD_CLOSE = 0.4;
export const RIFLE_RANGE = 300;
/** Health a round takes from a wolf: body (plus up to RIFLE_SPREAD), head. */
export const RIFLE_DAMAGE = 60;
const RIFLE_SPREAD = 30;
export const HEAD_DAMAGE = 200;
/** Radians of random scatter fired from the hip (none fully raised). */
export const HIP_SPREAD = 0.035;

/** Muzzle speed of a flare, m/s; quadratic drag per metre; gravity. */
export const FLARE_SPEED = 42;
export const FLARE_DRAG = 0.009;
export const FLARE_GRAVITY = 9.81;
/** Seconds to reload the flare gun, and when the cartridge goes in; recovery after a shot. */
export const FLARE_RELOAD = 1.3;
const FLARE_LOAD_AT = 0.9;
export const FLARE_RECOVER = 0.6;
/** Seconds a burnt-out flare lies before it is gone; longest flight before it counts as landed. */
export const FLARE_SPENT = 10;
const FLARE_MAX_FLIGHT = 20;

/** Seconds of cranking from empty to full, and of listening a full charge gives. */
export const CRANK_SECONDS = 10;
export const RADIO_SECONDS = 150;
/** Closer than this the radio is on top of the source; past RADIO_FAR it hears almost nothing. */
const RADIO_NEAR = 12;
const RADIO_FAR = 1600;

/** Health an axe blow takes from a wolf (plus up to AXE_SPREAD). */
export const AXE_DAMAGE = 26;
const AXE_SPREAD = 10;

const RIFLE = 1, FLAREGUN = 2, FLASH = 3, RADIO = 4;
const TOOL_OF: Record<number, ToolId> = { [RIFLE]: 'rifle', [FLAREGUN]: 'flaregun', [FLASH]: 'flashlight', [RADIO]: 'radio' };
const PARTS: readonly PartId[] = ['battery', 'handset', 'coil', 'tube', 'fuse'];

// ---------------------------------------------------------------------------------------------
// Vars: per player 'tools.act.<id>' (tool code of this system's act), 'tools.next.<id>' (actT of the
// next step of a reload, or 1 once a cartridge / cell went in), 'tools.stop.<id>' (stop the rifle
// reload after this round), 'tools.close.<id>' (closing the bolt); per flare 'tools.fly.<id>'
// (seconds in the air) and 'tools.spent.<id>' (seconds burnt out).
// ---------------------------------------------------------------------------------------------

interface Keys { act: string; next: string; stop: string; close: string }
const keyCache = new Map<number, Keys>();
function keysOf(id: number): Keys {
  let k = keyCache.get(id);
  if (!k) keyCache.set(id, (k = { act: 'tools.act.' + id, next: 'tools.next.' + id, stop: 'tools.stop.' + id, close: 'tools.close.' + id }));
  return k;
}

const has = (p: PlayerEnt, item: ItemId): boolean => (p.inv[item] ?? 0) > 0;

function canUse(p: PlayerEnt): boolean {
  return p.life === 'alive' && !p.swim && p.carry === 0;
}

/** The tool code of this system's act in progress, or 0. */
function myAct(ctx: SimCtx, p: PlayerEnt): number {
  return ctx.state.vars[keysOf(p.id).act] ?? 0;
}

function startAct(ctx: SimCtx, p: PlayerEnt, act: 'shoot' | 'reload' | 'crank', tool: number): void {
  const k = keysOf(p.id), vars = ctx.state.vars;
  p.act = act;
  p.actT = 0;
  vars[k.act] = tool;
  delete vars[k.next];
  delete vars[k.stop];
  delete vars[k.close];
}

function endAct(ctx: SimCtx, p: PlayerEnt): void {
  const k = keysOf(p.id), vars = ctx.state.vars;
  if (vars[k.act] !== undefined && (p.act === 'shoot' || p.act === 'reload' || p.act === 'crank')) {
    p.act = 'none';
    p.actT = 0;
  }
  delete vars[k.act];
  delete vars[k.next];
  delete vars[k.stop];
  delete vars[k.close];
}

/** Put `n` of `item` back in the pack without a pickup event; what does not fit is set down at the feet. */
function unload(ctx: SimCtx, p: PlayerEnt, item: ItemId, n: number): void {
  const room = Math.max(0, CARRY_LIMIT[item] - (p.inv[item] ?? 0));
  const k = Math.min(n, room);
  if (k > 0) p.inv[item] = (p.inv[item] ?? 0) + k;
  if (n - k > 0) spawnPickup(ctx, item, n - k, p.x, p.z, p.y, p.yaw);
}

// ---------------------------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------------------------

/** Flashlight output for a cell charge: full down to CELL_DIM, then dimming, 0 when flat. */
export function beamLevel(charge: number): number {
  if (charge <= 0) return 0;
  return charge >= CELL_DIM ? 1 : 0.2 + 0.8 * (charge / CELL_DIM);
}

/**
 * The rifle's sway at a tick, radians of yaw and pitch: a slow figure-of-eight drift growing with
 * cold (from 35 C), exhaustion (below 60 % stamina) and the wind on the body; small when raised,
 * large from the hip; a fast tremor when freezing. Deterministic from the player and the tick, so a
 * client can draw the reticle where the round will go.
 */
export function rifleSway(p: PlayerEnt, env: Env, tick: number, out = { yaw: 0, pitch: 0 }): { yaw: number; pitch: number } {
  const t = tick / 30;
  const cold = sat((35 - p.core) / 4);
  const tired = sat(1 - p.stamina / 0.6);
  const wind = Math.hypot(env.windX, env.windZ) * (1 + 0.5 * env.gust) * (1 - p.shelter);
  const amp = (0.004 + 0.03 * (1 - p.aim)) * (1 + 2 * cold + 1.5 * tired + 0.07 * wind);
  const ph = p.id * 1.618;
  out.yaw = amp * (0.7 * Math.sin(t * 1.1 + ph) + 0.3 * Math.sin(t * 2.7 + ph * 2.1));
  out.pitch = amp * 0.8 * (0.7 * Math.sin(t * 1.5 + ph * 0.7) + 0.3 * Math.sin(t * 3.3 + ph * 1.3));
  if (cold > 0.5) {
    const k = (cold - 0.5) * 0.008;
    out.yaw += k * Math.sin(t * 17 + ph);
    out.pitch += k * Math.sin(t * 23 + ph * 1.7);
  }
  return out;
}
const sway = { yaw: 0, pitch: 0 };

// ---------------------------------------------------------------------------------------------
// The axe on a wolf
// ---------------------------------------------------------------------------------------------

/** The nearest living wolf whose body is within the axe's reach in front of the player. */
function wolfInReach(ctx: SimCtx, p: PlayerEnt): WolfEnt | null {
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  let best: WolfEnt | null = null;
  let bd = AXE_REACH + 0.25;
  for (const w of ctx.all('wolf')) {
    if (w.mood === 'dead') continue;
    if (Math.abs(w.x - p.x) > 4 || Math.abs(w.z - p.z) > 4 || Math.abs(w.y - p.y) > 1.6) continue;
    const n = wolfBodyNear(w, p.x, p.z);
    if (n.d > bd) continue;
    const dx = n.x - p.x, dz = n.z - p.z, l = Math.hypot(dx, dz);
    if (l > 0.3 && (dx * fx + dz * fz) / l < 0.42) continue; // not in front (about 65 degrees either side)
    bd = n.d;
    best = w;
  }
  return best;
}

function axeOnWolves(ctx: SimCtx, p: PlayerEnt): void {
  if (p.act !== 'swing' || p.held !== 'axe' || p.life !== 'alive') return;
  // wood.ts lands the blade on the tick actT crosses SWING_HIT: that is the next one
  if (!(p.actT < SWING_HIT && p.actT + ctx.dt >= SWING_HIT)) return;
  const w = wolfInReach(ctx, p);
  if (!w) return;
  const n = wolfBodyNear(w, p.x, p.z);
  ctx.emit({ t: 'swing', by: p.id, hit: 'wolf', x: n.x, y: w.y + WOLF_BODY.y, z: n.z });
  damageWolf(ctx, w, AXE_DAMAGE + AXE_SPREAD * ctx.rand(), p, 'axe');
  p.actT = SWING_HIT;
}

// ---------------------------------------------------------------------------------------------
// Flashlight
// ---------------------------------------------------------------------------------------------

function flashlight(ctx: SimCtx, p: PlayerEnt): void {
  const dt = ctx.dt;
  const k = keysOf(p.id), vars = ctx.state.vars;
  const swapping = p.act === 'reload' && myAct(ctx, p) === FLASH;
  if (swapping) {
    p.actT += dt;
    if (vars[k.next] === undefined && p.actT >= CELL_SWAP_AT) {
      vars[k.next] = 1;
      if (has(p, 'cell')) {
        removeItem(ctx, p, 'cell', 1);
        p.cellCharge = 1;
      }
    }
    if (p.actT >= CELL_SWAP) endAct(ctx, p);
  }
  if (p.lightOn && !swapping) {
    p.cellCharge = Math.max(0, p.cellCharge - (dt / CELL_SECONDS) * (1 + 0.25 * p.aim));
    if (p.cellCharge <= 0) {
      p.lightOn = false;
      toast(ctx, p, 'warn', 'The flashlight dies.');
    }
  }
  p.beam = p.lightOn && !swapping && p.held === 'flashlight' ? beamLevel(p.cellCharge) : 0;
}

function toggleLight(ctx: SimCtx, p: PlayerEnt): void {
  if (p.life !== 'alive' && p.life !== 'downed') return;
  if (!has(p, 'flashlight')) {
    toast(ctx, p, 'info', 'You have no flashlight.');
    return;
  }
  if (p.held !== 'flashlight') {
    if (!canEquip(p, 'flashlight')) return;
    if (myAct(ctx, p)) endAct(ctx, p);
    p.held = 'flashlight';
    ctx.emit({ t: 'equip', id: p.id, tool: 'flashlight' });
  } else if (p.lightOn) {
    p.lightOn = false;
    p.beam = 0;
    return;
  }
  if (p.cellCharge <= 0) {
    toast(ctx, p, 'info', has(p, 'cell') ? 'The cell is dead. Change it.' : 'The cell is dead.');
    return;
  }
  p.lightOn = true;
  p.beam = beamLevel(p.cellCharge);
}

// ---------------------------------------------------------------------------------------------
// Rifle
// ---------------------------------------------------------------------------------------------

const rayOut = { t: Infinity, head: false };

function fireRifle(ctx: SimCtx, p: PlayerEnt): void {
  p.loaded--;
  ctx.state.stats.shots++;
  startAct(ctx, p, 'shoot', RIFLE);
  const ex = p.x, ey = p.y + eyeHeight(p), ez = p.z;
  rifleSway(p, ctx.state.env, ctx.state.tick, sway);
  let yaw = p.yaw + sway.yaw, pitch = p.pitch + sway.pitch;
  if (p.aim < 1) {
    // from the hip, or not yet up: scatter
    const r = HIP_SPREAD * (1 - p.aim) * Math.sqrt(ctx.rand()), a = ctx.rand() * TAU;
    yaw += Math.cos(a) * r;
    pitch += Math.sin(a) * r;
  }
  const cp = Math.cos(pitch);
  const dx = -Math.sin(yaw) * cp, dy = Math.sin(pitch), dz = -Math.cos(yaw) * cp;
  const hit = ctx.world.raycast(ex, ey, ez, dx, dy, dz, RIFLE_RANGE);
  let tMax = hit ? hit.dist : RIFLE_RANGE;
  let wolf: WolfEnt | null = null;
  let head = false;
  for (const w of ctx.all('wolf')) {
    if (w.mood === 'dead') continue;
    const ox = w.x - ex, oz = w.z - ez, reach = tMax + 2;
    if (ox * ox + oz * oz > reach * reach) continue;
    const t = wolfRayHit(w, ex, ey, ez, dx, dy, dz, tMax, rayOut);
    if (t < tMax) {
      tMax = t;
      wolf = w;
      head = rayOut.head;
    }
  }
  const what = wolf ? 'wolf' : !hit ? 'none' : hit.what === 'tree' || hit.what === 'wall' ? 'wood' : 'ground';
  ctx.emit({ t: 'shot', by: p.id, x: ex, y: ey, z: ez, dx, dy, dz, hx: ex + dx * tMax, hy: ey + dy * tMax, hz: ez + dz * tMax, hit: what });
  if (wolf) damageWolf(ctx, wolf, head ? HEAD_DAMAGE : RIFLE_DAMAGE + RIFLE_SPREAD * ctx.rand(), p, 'rifle');
  hearNoise(ctx, ex, ez, 'rifle');
}

/** One step of the reload: rounds go in one at a time until the magazine is full, the pack is empty or PRIMARY stops it. */
function reloadRifle(ctx: SimCtx, p: PlayerEnt): void {
  const k = keysOf(p.id), vars = ctx.state.vars;
  p.actT += ctx.dt;
  const next = vars[k.next] ?? RELOAD_OPEN + RELOAD_ROUND;
  if (p.actT < next) return;
  if (vars[k.close]) {
    endAct(ctx, p);
    return;
  }
  if (has(p, 'ammo') && p.loaded < RIFLE_MAG) {
    removeItem(ctx, p, 'ammo', 1);
    p.loaded++;
  }
  if (p.loaded >= RIFLE_MAG || !has(p, 'ammo') || vars[k.stop]) {
    vars[k.close] = 1;
    vars[k.next] = p.actT + RELOAD_CLOSE;
  } else vars[k.next] = next + RELOAD_ROUND;
}

function rifle(ctx: SimCtx, p: PlayerEnt): void {
  const mine = myAct(ctx, p) === RIFLE;
  if (mine && p.act === 'shoot') {
    p.actT += ctx.dt;
    if (p.actT >= BOLT_TIME) endAct(ctx, p);
  } else if (mine && p.act === 'reload') reloadRifle(ctx, p);
  if (p.held !== 'rifle' || !canUse(p) || !ctx.pressed(p.id, BTN.PRIMARY)) return;
  if (p.act === 'reload' && myAct(ctx, p) === RIFLE) {
    // stop after the round going in, to shoot
    if (p.loaded > 0 || has(p, 'ammo')) ctx.state.vars[keysOf(p.id).stop] = 1;
    return;
  }
  if (p.act !== 'none') return;
  if (p.loaded <= 0) {
    ctx.emit({ t: 'dry', by: p.id });
    return;
  }
  fireRifle(ctx, p);
}

// ---------------------------------------------------------------------------------------------
// Flare gun and flares
// ---------------------------------------------------------------------------------------------

function fireFlare(ctx: SimCtx, p: PlayerEnt): void {
  p.flareLoaded = 0;
  startAct(ctx, p, 'shoot', FLAREGUN);
  const ex = p.x, ey = p.y + eyeHeight(p), ez = p.z;
  const cp = Math.cos(p.pitch);
  const dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
  let sx = ex + dx * 0.6, sy = ey + dy * 0.6 - 0.08, sz = ez + dz * 0.6;
  if (!ctx.world.lineClear(ex, ey, ez, sx, sy, sz)) {
    sx = ex;
    sy = ey;
    sz = ez;
  }
  const f = ctx.spawn<FlareEnt>(makeFlare(sx, sy, sz, dx * FLARE_SPEED + p.vx, dy * FLARE_SPEED, dz * FLARE_SPEED + p.vz, p.id));
  f.yaw = p.yaw;
  ctx.emit({ t: 'flareShot', by: p.id, id: f.id });
  hearNoise(ctx, ex, ez, 'flare');
}

function flaregun(ctx: SimCtx, p: PlayerEnt): void {
  const mine = myAct(ctx, p) === FLAREGUN;
  if (mine && p.act === 'shoot') {
    p.actT += ctx.dt;
    if (p.actT >= FLARE_RECOVER) endAct(ctx, p);
  } else if (mine && p.act === 'reload') {
    const k = keysOf(p.id), vars = ctx.state.vars;
    p.actT += ctx.dt;
    if (vars[k.next] === undefined && p.actT >= FLARE_LOAD_AT) {
      vars[k.next] = 1;
      if (has(p, 'flare') && p.flareLoaded < 1) {
        removeItem(ctx, p, 'flare', 1);
        p.flareLoaded = 1;
      }
    }
    if (p.actT >= FLARE_RELOAD) endAct(ctx, p);
  }
  if (p.held !== 'flaregun' || !canUse(p) || !ctx.pressed(p.id, BTN.PRIMARY) || p.act !== 'none') return;
  if (p.flareLoaded < 1) {
    ctx.emit({ t: 'dry', by: p.id });
    return;
  }
  fireFlare(ctx, p);
}

const flyKey = (id: number) => 'tools.fly.' + id;
const spentKey = (id: number) => 'tools.spent.' + id;

/** One tick of a flare in the air: gravity, drag against the moving air (stronger aloft), landing. */
function fly(ctx: SimCtx, f: FlareEnt): void {
  const env = ctx.state.env, dt = ctx.dt, w = ctx.world, vars = ctx.state.vars;
  const rvx = f.vx - env.windX * 1.2, rvy = f.vy, rvz = f.vz - env.windZ * 1.2;
  const rv = Math.hypot(rvx, rvy, rvz);
  f.vx -= FLARE_DRAG * rv * rvx * dt;
  f.vy -= (FLARE_DRAG * rv * rvy + FLARE_GRAVITY) * dt;
  f.vz -= FLARE_DRAG * rv * rvz * dt;
  const x0 = f.x, y0 = f.y, z0 = f.z;
  const x1 = x0 + f.vx * dt, y1 = y0 + f.vy * dt, z1 = z0 + f.vz * dt;
  const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
  const sl = Math.hypot(sx, sy, sz);
  const fk = flyKey(f.id);
  const ft = (vars[fk] ?? 0) + dt;
  vars[fk] = ft;
  let landed = false;
  let gx = x1, gy = y1, gz = z1;
  if (sl > 1e-6) {
    const hit = w.raycast(x0, y0, z0, sx, sy, sz, sl);
    if (hit) {
      // off a trunk, a rock or a wall it drops to the snow at its foot
      const back = hit.what === 'ground' ? 0.05 : 0.35;
      gx = hit.x - (sx / sl) * back;
      gz = hit.z - (sz / sl) * back;
      gy = hit.y;
      landed = true;
    }
  }
  const lim = w.half - 2;
  if (!landed) {
    if (y1 <= w.groundAt(x1, z1, y1).y) landed = true;
    else if (Math.abs(x1) > lim || Math.abs(z1) > lim || ft > FLARE_MAX_FLIGHT) {
      gx = clamp(x1, -lim, lim);
      gz = clamp(z1, -lim, lim);
      gy = w.heightAt(gx, gz) + 50;
      landed = true;
    }
  }
  if (landed) {
    f.x = gx;
    f.z = gz;
    f.y = w.groundAt(gx, gz, gy + 0.3).y;
    f.vx = 0;
    f.vy = 0;
    f.vz = 0;
    f.landed = true;
    delete vars[fk];
    ctx.emit({ t: 'flareLand', id: f.id, x: f.x, y: f.y, z: f.z });
    return;
  }
  f.x = x1;
  f.y = y1;
  f.z = z1;
  if (Math.hypot(f.vx, f.vz) > 0.5) f.yaw = Math.atan2(-f.vx, -f.vz);
}

function flares(ctx: SimCtx): void {
  const list = ctx.all('flare');
  const dt = ctx.dt, vars = ctx.state.vars;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f.landed) fly(ctx, f);
    else if (f.life > 0) {
      f.life = Math.max(0, f.life - dt);
      if (f.life <= 0) ctx.emit({ t: 'flareOut', id: f.id });
    } else {
      const k = spentKey(f.id);
      const s = (vars[k] ?? 0) + dt;
      if (s >= FLARE_SPENT) {
        delete vars[k];
        ctx.remove(f.id);
      } else vars[k] = s;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Radio
// ---------------------------------------------------------------------------------------------

// Where each missing part lies: its pickup, found once a tick when someone listens.
let partState: unknown = null;
let partTick = -1;
const partAt = new Map<PartId, { x: number; z: number }>();

function partPositions(ctx: SimCtx): void {
  if (partState === ctx.state && partTick === ctx.state.tick) return;
  partState = ctx.state;
  partTick = ctx.state.tick;
  partAt.clear();
  for (const pk of ctx.all('pickup')) {
    if (!pk.item.startsWith('part_')) continue;
    const part = pk.item.slice(5) as PartId;
    if (!partAt.has(part)) partAt.set(part, { x: pk.x, z: pk.z });
  }
}

/** What the radio hears: the nearest missing part, or the tower panel once none is missing. */
const src = { x: 0, z: 0 };
function radioSource(ctx: SimCtx, p: PlayerEnt): typeof src | null {
  const parts = ctx.state.objective.parts;
  let lost = false;
  let bd = Infinity;
  for (const part of PARTS) {
    if (parts[part] !== 'lost') continue;
    if (!lost) partPositions(ctx);
    lost = true;
    const at = partAt.get(part) ?? ctx.world.spawn.parts[part];
    if (!at) continue;
    const d = Math.hypot(at.x - p.x, at.z - p.z);
    if (d < bd) {
      bd = d;
      src.x = at.x;
      src.z = at.z;
    }
  }
  if (lost) return bd < Infinity ? src : null;
  for (const d of ctx.all('device')) {
    if (d.type === 'panel') {
      src.x = d.x;
      src.z = d.z;
      return src;
    }
  }
  const t = ctx.world.poi('tower');
  if (!t) return null;
  src.x = t.x;
  src.z = t.z;
  return src;
}

/** Signal strength 0..1 heard by a radio at (x, z) facing `yaw` from a source at distance d. */
export function radioSignal(dx: number, dz: number, yaw: number, raised: number, charge: number, storm: number): number {
  const d = Math.hypot(dx, dz);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let c = d > 1e-3 ? (dx * fx + dz * fz) / d : 1;
  // right on top of it the tone fills every direction
  c = 1 - (1 - c) * sat(d / 25);
  const lobe = Math.pow(0.5 * (1 + c), 6 + 10 * raised);
  const close = 0.15 + 0.85 * sat(1 - Math.log(Math.max(d, RADIO_NEAR) / RADIO_NEAR) / Math.log(RADIO_FAR / RADIO_NEAR));
  return sat(lobe * close * sat(charge / 0.08) * (1 - 0.25 * storm));
}

function radio(ctx: SimCtx, p: PlayerEnt): void {
  const dt = ctx.dt;
  const cranking = p.act === 'crank' && myAct(ctx, p) === RADIO;
  if (p.held === 'radio' && canUse(p) && ctx.held(p.id, BTN.PRIMARY) && (p.act === 'none' || cranking)) {
    if (!cranking) startAct(ctx, p, 'crank', RADIO);
    p.actT += dt;
    p.radioCharge = Math.min(1, p.radioCharge + dt / CRANK_SECONDS);
  } else if (cranking) endAct(ctx, p);
  if (p.held === 'radio' && p.life === 'alive' && !p.swim && p.radioCharge > 0) {
    p.radioCharge = Math.max(0, p.radioCharge - dt / RADIO_SECONDS);
    const s = radioSource(ctx, p);
    if (s) {
      p.radioSig = radioSignal(s.x - p.x, s.z - p.z, p.yaw, p.aim, p.radioCharge, ctx.state.env.storm);
      p.radioDist = Math.hypot(s.x - p.x, s.z - p.z);
      return;
    }
  }
  p.radioSig = 0;
  p.radioDist = -1;
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

/** Whatever changed hands since last tick: an act whose tool is gone, rounds in a rifle no longer carried, a light put away. */
function tidy(ctx: SimCtx, p: PlayerEnt): void {
  const code = myAct(ctx, p);
  if (code) {
    if (p.act !== 'shoot' && p.act !== 'reload' && p.act !== 'crank') endAct(ctx, p); // someone else ended it (downed)
    else if (p.held !== TOOL_OF[code] || !canUse(p)) endAct(ctx, p);
  }
  if (p.loaded > 0 && !has(p, 'rifle')) {
    unload(ctx, p, 'ammo', p.loaded);
    p.loaded = 0;
  }
  if (p.flareLoaded > 0 && !has(p, 'flaregun')) {
    unload(ctx, p, 'flare', 1);
    p.flareLoaded = 0;
  }
  if (p.lightOn && (p.held !== 'flashlight' || p.swim || p.life === 'dead' || p.life === 'rescued' || !has(p, 'flashlight'))) p.lightOn = false;
}

function aim(ctx: SimCtx, p: PlayerEnt): void {
  const up = canUse(p) && ctx.held(p.id, BTN.SECONDARY) && !p.sprint && p.act !== 'reload' &&
    (p.held === 'rifle' || p.held === 'flashlight' || p.held === 'radio');
  p.aim = up ? Math.min(1, p.aim + ctx.dt / AIM_UP) : Math.max(0, p.aim - ctx.dt / AIM_DOWN);
}

function reload(ctx: SimCtx, p: PlayerEnt): void {
  if (!canUse(p) || p.act !== 'none') return;
  switch (p.held) {
    case 'rifle':
      if (p.loaded >= RIFLE_MAG) return;
      if (!has(p, 'ammo')) {
        toast(ctx, p, 'info', 'You have no rounds.');
        return;
      }
      startAct(ctx, p, 'reload', RIFLE);
      ctx.state.vars[keysOf(p.id).next] = RELOAD_OPEN + RELOAD_ROUND;
      ctx.emit({ t: 'reload', by: p.id });
      return;
    case 'flaregun':
      if (p.flareLoaded >= 1) return;
      if (!has(p, 'flare')) {
        toast(ctx, p, 'info', 'You have no flare cartridges.');
        return;
      }
      startAct(ctx, p, 'reload', FLAREGUN);
      return;
    case 'flashlight':
      if (p.cellCharge >= 0.98) return;
      if (!has(p, 'cell')) {
        toast(ctx, p, 'info', 'You have no spare cells.');
        return;
      }
      startAct(ctx, p, 'reload', FLASH);
      return;
    default:
      return;
  }
}

export const tools: System = {
  name: 'tools',

  step(ctx) {
    const list = ctx.players();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      tidy(ctx, p);
      axeOnWolves(ctx, p);
      aim(ctx, p);
      flashlight(ctx, p);
      rifle(ctx, p);
      flaregun(ctx, p);
      radio(ctx, p);
    }
    flares(ctx);
  },

  action(ctx, p, a) {
    if (a.t === 'reload') {
      reload(ctx, p);
      return true;
    }
    if (a.t === 'toggleLight') {
      toggleLight(ctx, p);
      return true;
    }
    return false;
  },

  leave(ctx, p) {
    // the pack was set down by items.leave; the rounds in the guns go down beside it
    if (p.loaded > 0) {
      spawnPickup(ctx, 'ammo', p.loaded, p.x + 0.45, p.z - 0.2, p.y, p.yaw);
      p.loaded = 0;
    }
    if (p.flareLoaded > 0) {
      spawnPickup(ctx, 'flare', 1, p.x - 0.45, p.z - 0.2, p.y, p.yaw);
      p.flareLoaded = 0;
    }
    endAct(ctx, p);
    keyCache.delete(p.id);
  },
};
