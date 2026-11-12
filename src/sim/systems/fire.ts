// Fire: campfires laid from three sticks, the cabin stove and the barrel at the wreck.
//   build   'buildFire' lays a campfire in front of the player, on snow or bare ground: not on the
//           ice, the water, a floor, a slope, or inside a wall, a trunk or a rock. Its shelter from
//           the wind comes from world.shelterAt (refreshed as the wind turns).
//   light   USE on an unlit fire, or 'ignite'. One match is always spent. Wind on an open fire makes
//           it likely to fail, tinder (used up with the match) makes it near certain, wet mitts
//           fumble it; a failure says why ('igniteFail'). Embers relight it without a match.
//   feed    USE on a lit fire (a stick, else a split log), or 'feed' with the item. A stick burns
//           40 s, tinder 15 s, a split log 3 min, a heavy log dropped beside it 12 min (wood.ts).
//   burn    wind raises the burn rate; heat ramps up after lighting and sags when the fire is
//           starved or snowed on; a starved open fire dies in a strong gust or heavy snow; a dead
//           fire keeps its embers a while (shorter in snow and wind).
// The wood on a fire is kept as seconds of burning at a calm rate in state.vars ('fire.wood.<id>');
// FireEnt.fuel is what that means at the present rate. The barrel is already burning when the first
// survivor crawls out of the fuselage; the stove is laid but cold.
// Owner: SURVIVAL.
import { clamp, sat } from '../../core/math';
import type { Collider } from '../../world/types';
import type { SimCtx, System } from '../api';
import { makeFire } from '../entities';
import { BTN, type FireEnt, type FireType, type PlayerEnt } from '../types';
import { canReach, focusOf, removeItem, toast } from './items';

export const STICKS_PER_FIRE = 3;
/** Seconds of calm burning each fuel adds. */
export const BURN = { stick: 40, log: 180, tinder: 15 } as const;
/** A fresh campfire: the three sticks it was laid from. */
export const LAY_WOOD = STICKS_PER_FIRE * BURN.stick;
/** Most wood a fire takes, seconds. */
export const MAX_WOOD: Readonly<Record<FireType, number>> = { campfire: 1500, stove: 1800, barrel: 1200 };
/** How far each kind of fire warms, metres (thermal.ts). */
export const WARM_RADIUS: Readonly<Record<FireType, number>> = { campfire: 6, stove: 7, barrel: 5.5 };
/** Seconds of burn left at which a fire counts as starved. */
export const STARVED = 30;
export const EMBER_SECONDS = 180; // after burning down
export const EMBER_KILLED = 75; // after a gust or the snow put it out
/** Seconds the striking motion lasts (PlayerAct 'ignite'). */
export const IGNITE_TIME = 1.2;
/** Where a campfire is laid: metres in front of the player. */
export const LAY_DIST = 1.1;

const HEAT_CAP: Readonly<Record<FireType, number>> = { campfire: 1, stove: 0.95, barrel: 0.9 };
const BARREL_START = 480;
const STOVE_START = 360;
const FIRE_R = 0.45; // footprint of a campfire, metres
const LAY_SLOPE = 28 / 90; // world.slopeAt units (angle / 90 degrees)
const SHELTER_EVERY = 150; // ticks between shelter refreshes of a campfire

const WOOD_KEY = 'fire.wood.';
const V_KINDLED = 'fire.kindled';

const scratch: Collider[] = [];

// ---------------------------------------------------------------------------------------------
// Helpers (also used by thermal.ts, wood.ts and vitals.ts)
// ---------------------------------------------------------------------------------------------

/** Seconds of calm burning stacked on a fire. */
export function woodOf(ctx: SimCtx, f: FireEnt): number {
  return ctx.v(WOOD_KEY + f.id, 0);
}

function setWood(ctx: SimCtx, f: FireEnt, w: number): void {
  if (w > 0) ctx.state.vars[WOOD_KEY + f.id] = w;
  else delete ctx.state.vars[WOOD_KEY + f.id];
  // the visible stack: a three-stick lay is about a third, a heavy log fills it
  f.size = w > 0 ? Math.max(0.06, Math.pow(sat(w / 600), 0.6)) : 0;
}

/** Wind speed the flames feel, m/s (mean plus the gust). */
export function fireWind(ctx: SimCtx): number {
  const e = ctx.state.env;
  return Math.hypot(e.windX, e.windZ) * (1 + 0.6 * e.gust);
}

/** 0..1 how hard the wind works on a fire with this shelter. */
function windOn(speed: number, shelter: number): number {
  return sat((speed - 2) / 18) * (1 - shelter);
}

/** Burn rate multiplier: 1 in calm air, up to 2.3 in a gale on an open fire. */
export function burnRate(ctx: SimCtx, f: FireEnt): number {
  return 1 + 1.3 * windOn(fireWind(ctx), f.shelter);
}

function light(ctx: SimCtx, f: FireEnt, by: PlayerEnt, heat0: number, struck: boolean): void {
  f.lit = true;
  f.embers = 0;
  f.heat = Math.max(f.heat, heat0);
  f.fuel = woodOf(ctx, f) / burnRate(ctx, f);
  ctx.emit({ t: 'fireLit', id: f.id, by: by.id });
  if (struck) ctx.state.stats.firesLit++;
}

function goOut(ctx: SimCtx, f: FireEnt, why: 'fuel' | 'wind' | 'snow', embers: number): void {
  f.lit = false;
  f.embers = embers;
  f.heat = Math.min(f.heat, 0.12);
  ctx.emit({ t: 'fireOut', id: f.id, why });
}

/**
 * Put `seconds` of wood on a fire (capped at what it takes). Glowing embers catch at once.
 * Emits 'fireFed'. Used for pack items here and for heavy logs by wood.ts.
 */
export function feedFire(ctx: SimCtx, f: FireEnt, seconds: number, by: PlayerEnt, item: 'stick' | 'log' | 'tinder'): void {
  setWood(ctx, f, Math.min(MAX_WOOD[f.type], woodOf(ctx, f) + seconds));
  ctx.emit({ t: 'fireFed', id: f.id, by: by.id, item });
  if (f.lit) f.fuel = woodOf(ctx, f) / burnRate(ctx, f);
  else if (f.embers > 0) light(ctx, f, by, 0.2, false);
}

/** Feed one item from the pack. False (with a toast) when it cannot. */
function feed(ctx: SimCtx, p: PlayerEnt, f: FireEnt, item: 'stick' | 'log' | 'tinder'): boolean {
  if ((p.inv[item] ?? 0) <= 0) {
    toast(ctx, p, 'info', item === 'stick' ? 'You have no sticks.' : item === 'log' ? 'You have no split logs.' : 'You have no tinder.');
    return false;
  }
  if (woodOf(ctx, f) + BURN[item] > MAX_WOOD[f.type]) {
    toast(ctx, p, 'info', 'It will not take any more wood.');
    return false;
  }
  removeItem(ctx, p, item, 1);
  feedFire(ctx, f, BURN[item], p, item);
  return true;
}

/** USE on a fire that wants wood: a stick if there is one, else a split log. Tinder is kept for lighting. */
function feedBest(ctx: SimCtx, p: PlayerEnt, f: FireEnt): void {
  if ((p.inv.stick ?? 0) > 0) feed(ctx, p, f, 'stick');
  else if ((p.inv.log ?? 0) > 0) feed(ctx, p, f, 'log');
  else toast(ctx, p, 'info', 'You have no wood.');
}

/** Chance that a struck match lights this fire for this player, and what most stands against it. */
export function igniteOdds(ctx: SimCtx, f: FireEnt, p: PlayerEnt, tinder: boolean): { chance: number; why: 'wind' | 'wet' | 'luck' } {
  const wind = sat((fireWind(ctx) - 3) / 11) * (1 - f.shelter);
  const windLoss = 0.8 * wind * (tinder ? 0.12 : 1);
  const wetLoss = 0.4 * sat(p.wet);
  const chance = clamp((tinder ? 0.995 : 0.93) - windLoss - wetLoss, 0.02, 0.995);
  const why = wetLoss >= windLoss && wetLoss > 0.08 ? 'wet' : windLoss > 0.08 ? 'wind' : 'luck';
  return { chance, why };
}

function ignite(ctx: SimCtx, p: PlayerEnt, f: FireEnt): void {
  if (f.lit) return;
  if (woodOf(ctx, f) <= 0) {
    toast(ctx, p, 'info', 'There is nothing on it to burn.');
    return;
  }
  if (f.embers > 0) {
    // blow on the embers: no match needed
    light(ctx, f, p, 0.2, false);
    startAct(p);
    return;
  }
  if ((p.inv.matches ?? 0) <= 0) {
    toast(ctx, p, 'warn', 'You have no matches.', 'matches');
    return;
  }
  removeItem(ctx, p, 'matches', 1);
  const tinder = (p.inv.tinder ?? 0) > 0;
  if (tinder) {
    removeItem(ctx, p, 'tinder', 1);
    setWood(ctx, f, Math.min(MAX_WOOD[f.type], woodOf(ctx, f) + BURN.tinder));
  }
  const odds = igniteOdds(ctx, f, p, tinder);
  startAct(p);
  if (ctx.rand() < odds.chance) light(ctx, f, p, 0.12, true);
  else {
    ctx.emit({ t: 'igniteFail', id: f.id, by: p.id, why: odds.why });
    toast(ctx, p, 'info', odds.why === 'wind' ? 'The wind took the match.' : odds.why === 'wet' ? 'Your wet mitts fumble the match.' : 'The match broke.');
  }
}

function startAct(p: PlayerEnt): void {
  if (p.act === 'none' || p.act === 'ignite') {
    p.act = 'ignite';
    p.actT = 0;
  }
}

/** Does a circle of radius r at x, z overlap the collider (in its height band)? */
function overlaps(c: Collider, x: number, z: number, r: number): boolean {
  const dx = x - c.x, dz = z - c.z;
  if (c.s === 'c') return dx * dx + dz * dz < (c.r + r) * (c.r + r);
  // the box frame: same rotation as Object3D.rotation.y (see testworld inRect)
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  return Math.abs(lx) < c.hx + r && Math.abs(lz) < c.hz + r;
}

/** Why a campfire cannot be laid at x, z for this player, or null when it can. */
export function layProblem(ctx: SimCtx, p: PlayerEnt, x: number, z: number): string | null {
  const w = ctx.world;
  if (Math.abs(x) > w.half - 2 || Math.abs(z) > w.half - 2) return 'There is no room here.';
  if (p.swim || w.iceAt(x, z) > 0) return 'Not on the ice.';
  const g = w.groundAt(x, z, p.y + 0.5);
  if (g.surface === 'ice' || g.surface === 'water') return 'Not on the ice.';
  if (g.surface === 'wood' || g.surface === 'metal') return 'Not on the floor.';
  if (Math.abs(g.y - p.y) > 0.9 || w.slopeAt(x, z) > LAY_SLOPE) return 'The ground is too steep here.';
  scratch.length = 0;
  w.collidersNear(x, z, FIRE_R, scratch);
  for (const c of scratch) {
    if (c.y1 < g.y + 0.05 || c.y0 > g.y + 1.2) continue;
    if (overlaps(c, x, z, FIRE_R)) return 'There is no room here.';
  }
  if (!w.lineClear(p.x, p.y + 1, p.z, x, g.y + 0.3, z)) return 'There is no room here.';
  for (const f of ctx.all('fire')) {
    if ((f.x - x) * (f.x - x) + (f.z - z) * (f.z - z) < 1.5 * 1.5 && Math.abs(f.y - g.y) < 2) return 'There is a fire here already.';
  }
  return null;
}

function build(ctx: SimCtx, p: PlayerEnt): void {
  if (p.life !== 'alive' || p.carry !== 0) return;
  if ((p.inv.stick ?? 0) < STICKS_PER_FIRE) {
    toast(ctx, p, 'info', 'You need three sticks to lay a fire.', 'stick');
    return;
  }
  const x = p.x - Math.sin(p.yaw) * LAY_DIST, z = p.z - Math.cos(p.yaw) * LAY_DIST;
  const why = layProblem(ctx, p, x, z);
  if (why) {
    toast(ctx, p, 'info', why);
    return;
  }
  const w = ctx.world, env = ctx.state.env;
  const y = w.groundAt(x, z, p.y + 0.5).y;
  const shelter = sat(w.shelterAt(x, y + 0.5, z, env.windX, env.windZ).amount);
  const f = ctx.spawn<FireEnt>(makeFire('campfire', x, y, z, { shelter, by: p.id, yaw: p.yaw }));
  removeItem(ctx, p, 'stick', STICKS_PER_FIRE);
  setWood(ctx, f, LAY_WOOD);
  f.fuel = LAY_WOOD / burnRate(ctx, f);
  ctx.emit({ t: 'fireBuilt', id: f.id, by: p.id });
}

/** A fire close enough to act on through an action (no focus): the same reach as USE. */
function nearFire(ctx: SimCtx, p: PlayerEnt, id: number): FireEnt | undefined {
  const f = ctx.get(id);
  return f && f.kind === 'fire' && p.life === 'alive' && canReach(ctx, p, f) ? f : undefined;
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

function burn(ctx: SimCtx, f: FireEnt): void {
  const env = ctx.state.env, dt = ctx.dt;
  if (f.type === 'campfire' && (ctx.tick + f.id) % SHELTER_EVERY === 0) {
    f.shelter = sat(ctx.world.shelterAt(f.x, f.y + 0.5, f.z, env.windX, env.windZ).amount);
  }
  const speed = fireWind(ctx);
  const wind = windOn(speed, f.shelter);
  const rate = 1 + 1.3 * wind;
  const snow = env.snowfall * (1 - f.shelter);
  let wood = woodOf(ctx, f);
  if (f.lit) {
    wood -= rate * dt;
    if (wood <= 0) {
      setWood(ctx, f, 0);
      f.fuel = 0;
      goOut(ctx, f, 'fuel', EMBER_SECONDS);
      return;
    }
    setWood(ctx, f, wood);
    const left = wood / rate;
    f.fuel = left;
    // Heat follows the wood on it, less what the snow and a gale take; up slowly, down quicker.
    const stack = Math.pow(sat(wood / 150), 0.6);
    const target = (0.2 + 0.8 * stack) * HEAT_CAP[f.type] * (1 - 0.3 * snow) * (1 - 0.25 * wind);
    f.heat += (target - f.heat) * Math.min(1, dt / (f.heat < target ? 22 : 7));
    // A starved open fire: once a second a strong gust or heavy snow may finish it.
    if (left < STARVED && f.shelter < 0.5 && (ctx.tick + f.id) % 30 === 0) {
      const weak = (0.4 + 0.6 * (1 - left / STARVED)) * (1 - f.shelter);
      const gustP = env.gust > 0.45 && speed > 11 ? (env.gust - 0.45) * 1.6 * weak : 0;
      const snowP = env.snowfall > 0.7 ? (env.snowfall - 0.7) * 0.5 * weak : 0;
      if (gustP + snowP > 0) {
        const r = ctx.rand();
        if (r < gustP) goOut(ctx, f, 'wind', EMBER_KILLED);
        else if (r < gustP + snowP) goOut(ctx, f, 'snow', EMBER_KILLED);
      }
    }
    return;
  }
  if (f.embers > 0) {
    f.embers = Math.max(0, f.embers - dt * (1 + 1.5 * snow + wind));
    // glowing coals still give a little warmth
    f.heat = 0.12 * Math.min(1, f.embers / 60);
  } else f.heat = 0;
  f.fuel = wood / rate;
}

export const fire: System = {
  name: 'fire',

  init(ctx) {
    // The stove is laid with wood and waits for a match; the barrel is lit when someone arrives.
    for (const f of ctx.all('fire')) {
      if (f.type === 'stove') {
        setWood(ctx, f, STOVE_START);
        f.fuel = STOVE_START;
      }
    }
  },

  join(ctx) {
    if (ctx.v(V_KINDLED)) return;
    ctx.setV(V_KINDLED, 1);
    for (const f of ctx.all('fire')) {
      if (f.type !== 'barrel' || f.lit) continue;
      setWood(ctx, f, Math.max(woodOf(ctx, f), BARREL_START));
      f.lit = true;
      f.heat = 0.75;
      f.embers = 0;
      f.fuel = woodOf(ctx, f) / burnRate(ctx, f);
    }
  },

  step(ctx) {
    const fires = ctx.all('fire');
    for (let i = 0; i < fires.length; i++) burn(ctx, fires[i]);

    const list = ctx.players();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.act === 'ignite') {
        p.actT += ctx.dt;
        if (p.actT >= IGNITE_TIME || p.life !== 'alive') {
          p.act = 'none';
          p.actT = 0;
        }
      }
      if (p.life !== 'alive' || !ctx.pressed(p.id, BTN.USE)) continue;
      const f = focusOf(ctx, p, 'fire');
      if (!f || !canReach(ctx, p, f)) continue;
      if (f.lit || woodOf(ctx, f) <= 0) feedBest(ctx, p, f);
      else ignite(ctx, p, f);
    }
  },

  action(ctx, p, a) {
    switch (a.t) {
      case 'buildFire':
        build(ctx, p);
        return true;
      case 'ignite': {
        const f = nearFire(ctx, p, a.fire);
        if (f) ignite(ctx, p, f);
        return true;
      }
      case 'feed': {
        const f = nearFire(ctx, p, a.fire);
        if (f && (a.item === 'stick' || a.item === 'log' || a.item === 'tinder')) feed(ctx, p, f, a.item);
        return true;
      }
      default:
        return false;
    }
  },
};
