// Wolves. Packs from world.spawn.packs wake at their wakeAt time (or when someone walks up to the
// den), with more wolves for more players. A pack is one brain: its phase, target, boldness, fear,
// home and timers live in state.vars as 'wolves.<field>.<pack>'. Each wolf plays a part in it and
// moves on its own (WolfEnt.mood, speed, yaw); a wolf's own timers are 'wolves.<field>.<id>' while
// they run.
//   phases   rest (lying up at the den) and roam (the home range, a loose file behind the alpha) ->
//            gather (they howl, come together; other packs answer from afar) -> stalk (the edge of the
//            target's sight, behind cover, closer in the storm and the dark; a wolf that is looked at
//            freezes or slips back) -> circle (15-30 m round the target; now and then one wolf feints
//            in and away) -> attack (one or two charge; a bite hurts and may knock the player down; a
//            downed player is dragged off) -> feed (at a body). A shot scatters the pack.
//   target   isolation, low health, being down, darkness, the whiteout and a dying fire make a player
//            the one; standing in a strong fire's light or by a burning flare makes them safe, and the
//            pack waits at the edge of the light, then gives up.
//   fear     a strong fire's light radius is a wall no wolf enters; a burning flare holds them off and
//            breaks a circle; a gunshot scatters the pack for a while, a kill for longer; the flashlight
//            beam in the face makes a wolf hesitate; an axe blow staggers one. Boldness grows with
//            hunger, night, whiteout and the pack's size against the players beside the target.
//   movement on walkable ground only (no steep slopes, thin ice, open water or walls), smooth turning,
//            walk 1.5 / trot 4 / gallop 11 m/s, pushed out of trees, rocks and walls.
// Dead wolves lie where they fell for DEAD_STAY seconds. Sight lines are checked a few times a second
// per wolf at most: 16 wolves cost a few hundredths of a millisecond a tick.
// Owner: HUNT.
import { clamp, sat, smoothstep, TAU, wrapAngle } from '../../core/math';
import type { Collider, ShelterVol, World } from '../../world/types';
import type { SimCtx, System } from '../api';
import { makeWolf } from '../entities';
import type { NetId, PlayerEnt, WolfEnt, WolfMood } from '../types';
import { nightAt } from './env';
import { eyeHeight } from './items';
import { hurt } from './vitals';

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** Ground speeds of the gaits, m/s. */
export const WOLF_WALK = 1.5;
export const WOLF_TROT = 4;
export const WOLF_GALLOP = 11;
/** Body radius against trees, rocks and walls, metres. */
export const WOLF_RADIUS = 0.38;
/** Hit volumes in the wolf's frame: origin on the ground between the legs, `fwd` along the facing. */
export const WOLF_BODY = { half: 0.45, y: 0.52, r: 0.27 } as const;
export const WOLF_HEAD = { fwd: 0.78, y: 0.66, r: 0.17 } as const;

/** Wolf centre to player centre at which a charge becomes a bite, metres. */
export const BITE_RANGE = 1.45;
/** Health a bite takes: this plus up to 5; an alpha bites 30 % harder, a body on the ground less. */
export const BITE_DAMAGE = 13;
const BITE_LAND = 0.28; // seconds into the bite the jaws close
const BITE_TIME = 0.75;
const LATCH = 1.1; // metres from the wolf's centre to the body it bites
const KNOCK_BASE = 0.05; // knock-down chance per bite on a healthy body ...
const KNOCK_HURT = 0.45; // ... plus this times (1 - health / 100)^2
const DRAG_SPEED = 1.1;
const DRAG_HOLD = 1.0; // metres from the wolf to the body it drags
const DRAG_BITE = 3.5; // seconds between bites while dragging
const DRAG_MAX = 25;
/** Circling radius, metres: the boldest pack circles tightest. */
export const CIRCLE_MIN = 15;
export const CIRCLE_MAX = 30;
const STALK_MIN = 13;
const STALK_MAX = 75;
const FEINT_CLOSE = 4;
const LOSE_RANGE = 260;
/** A burning flare's light, metres: no wolf comes inside it. */
export const FLARE_FEAR = 15;
/** A fire's light radius, metres, at its present heat (12 m at full heat). */
export function fireFear(heat: number): number {
  return 4 + 8 * heat;
}
/** From this heat a fire's light is a wall no wolf crosses; below FIRE_WEAK it holds nobody off. */
export const FIRE_WALL = 0.4;
const FIRE_WEAK = 0.12;
/** Seconds a pack scatters after a rifle shot close by (less from far off), after a kill, after a flare shot. */
export const SCATTER_SHOT = 28;
export const SCATTER_KILL = 75;
const SCATTER_FLARE = 6;
/** Metres a rifle shot and a flare gun carry (and scatter a pack within). */
export const SHOT_HEAR = 220;
export const FLARE_HEAR = 60;
const HOWL_HEAR = 1500;
/** Seconds a dead wolf lies before it is gone. */
export const DEAD_STAY = 300;
const HUNGER_RATE = 1 / 900; // fed to starving in 15 minutes
const FEAR_DECAY = 1 / 120;
const THINK = 15; // ticks between a pack's decisions (half a second)
const HOWL_TIME = 3.2;
const GATHER_TIME = 5.5;
const STALK_TIME = 25;
const CIRCLE_BOLD = 0.42;
const CHARGE_BOLD = 0.66;
/** Boldness a pack earns per second unopposed (stalking, circling), per unanswered feint, and its cap. */
const PRESS_STALK = 0.004;
const PRESS_CIRCLE = 0.008;
const PRESS_FEINT = 0.06;
const PRESS_MAX = 0.4;
const PROTECT_GIVEUP = 60;
const FEED_TIME = 80;
const THIN_ICE = 0.2;
const DEN_DISTURB = 40;
const DISTURB_AFTER = 60;
/** Safety (0..1) from which a player is left alone. */
const SAFE = 0.6;
/** Metres from everyone beyond which a pack that is not hunting lies still. */
const FAR = 400;

/** Pack phases, as stored in 'wolves.ph.<pack>'. */
export const PHASE = { rest: 0, roam: 1, gather: 2, stalk: 3, circle: 4, attack: 5, scatter: 6, feed: 7 } as const;
const PHASE_MOOD: readonly WolfMood[] = ['rest', 'roam', 'roam', 'stalk', 'circle', 'circle', 'flee', 'feed'];
const SPREAD = [0, 0.45, -0.45, 0.9, -0.9, 1.35, -1.35];
const DODGE = [0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4];
const COVER = [0, 0.2, -0.2, 0.4];

// ---------------------------------------------------------------------------------------------
// State in vars
// ---------------------------------------------------------------------------------------------

// Pack fields: phase, seconds in it, target id, boldness, fear, press (boldness earned by going
// unopposed), home x / z and range, waypoint x / z and when it was picked, scare source x / z, scatter seconds left, time of
// the last howl, seconds to the next feint or charge, orbit direction and angle, seconds the target
// has stood in safety, time this pack answers a howl (-1 none), feint start time, last scare time,
// feints this hunt.
const PF = ['ph', 'pt', 'tg', 'bold', 'fear', 'pr', 'hx', 'hz', 'rg', 'wx', 'wz', 'wt', 'sx', 'sz', 'st', 'hw', 'fe', 'or', 'oa', 'prot', 'ans', 'fs', 'sc', 'nf'] as const;
type PField = (typeof PF)[number];
const PDEF: Record<PField, number> = {
  ph: PHASE.roam, pt: 0, tg: 0, bold: 0.3, fear: 0, pr: 0, hx: 0, hz: 0, rg: 150, wx: 0, wz: 0, wt: -1e9, sx: 0, sz: 0, st: 0,
  hw: -1e9, fe: 6, or: 1, oa: 0, prot: 0, ans: -1, fs: -1, sc: -1e9, nf: 0,
};
/** Seconds the alpha heads for one waypoint before it picks another (one it cannot reach, say). */
const WAYPOINT_TIME = 40;
type PackKeys = Record<PField | 'aw', string>;
const packKeyCache = new Map<number, PackKeys>();
function pkeys(k: number): PackKeys {
  let c = packKeyCache.get(k);
  if (!c) {
    c = { aw: 'wolves.aw.' + k } as PackKeys;
    for (const f of PF) c[f] = 'wolves.' + f + '.' + k;
    packKeyCache.set(k, c);
  }
  return c;
}

// Wolf fields: attack cooldown, cower seconds, growl cooldown, flee-from x / z and seconds, feint
// running back out, cover angle while stalking, bite / drag-bite timer, beam hesitation cooldown.
const WF = ['cd', 'stun', 'gr', 'fx', 'fz', 'ft', 'fo', 'co', 'bt', 'hz'] as const;
type WField = (typeof WF)[number];
const COUNTDOWNS = ['cd', 'gr', 'hz'] as const;
type WolfKeys = Record<WField, string>;
const wolfKeyCache = new Map<NetId, WolfKeys>();
function wkeys(id: NetId): WolfKeys {
  let c = wolfKeyCache.get(id);
  if (!c) {
    c = {} as WolfKeys;
    for (const f of WF) c[f] = 'wolves.' + f + '.' + id;
    wolfKeyCache.set(id, c);
  }
  return c;
}
function clearWolfVars(ctx: SimCtx, id: NetId): void {
  const k = wkeys(id), vars = ctx.state.vars;
  for (const f of WF) delete vars[k[f]];
}
const wv = (ctx: SimCtx, id: NetId, f: WField): number => ctx.state.vars[wkeys(id)[f]] ?? 0;
function setWv(ctx: SimCtx, id: NetId, f: WField, v: number): void {
  if (v === 0) delete ctx.state.vars[wkeys(id)[f]];
  else ctx.state.vars[wkeys(id)[f]] = v;
}

/** The runtime view of one pack during a tick: its vars plus scratch. */
interface Pack extends Record<PField, number> {
  k: number;
  was: Float64Array; // the fields as loaded (only the changed ones are written back)
  wolves: WolfEnt[]; // living members, in entity order
  alpha: WolfEnt | null;
  target: PlayerEnt | null;
  think: boolean;
  white: number; // whiteout 0..1 (this tick)
  night: number;
  sight: number; // metres the target sees a wolf at (this tick)
}

function newPack(): Pack {
  const p = { k: 0, was: new Float64Array(PF.length), wolves: [], alpha: null, target: null, think: false, white: 0, night: 0, sight: 0 } as unknown as Pack;
  for (const f of PF) p[f] = PDEF[f];
  return p;
}

function loadPack(ctx: SimCtx, pk: Pack): void {
  const vars = ctx.state.vars, keys = pkeys(pk.k);
  if (vars[keys.ph] === undefined) {
    // A pack nobody set up (wolves spawned by a tool or a test): its home is where it stands.
    let cx = 0, cz = 0;
    for (const w of pk.wolves) {
      cx += w.x;
      cz += w.z;
    }
    const n = Math.max(1, pk.wolves.length);
    for (const f of PF) pk[f] = PDEF[f];
    pk.hx = pk.wx = cx / n;
    pk.hz = pk.wz = cz / n;
    pk.ph = pk.wolves.every((w) => w.mood === 'rest') ? PHASE.rest : PHASE.roam;
    pk.was.fill(NaN); // all of it is new
    return;
  }
  for (let i = 0; i < PF.length; i++) {
    const f = PF[i];
    const v = vars[keys[f]];
    pk[f] = v === undefined ? PDEF[f] : v;
    pk.was[i] = v === undefined ? NaN : v;
  }
}

function savePack(ctx: SimCtx, pk: Pack): void {
  const vars = ctx.state.vars, keys = pkeys(pk.k), was = pk.was;
  for (let i = 0; i < PF.length; i++) {
    const f = PF[i];
    const v = pk[f];
    if (v !== was[i]) vars[keys[f]] = v;
  }
}

function clearPackVars(ctx: SimCtx, k: number): void {
  const vars = ctx.state.vars, keys = pkeys(k);
  for (const f of PF) delete vars[keys[f]];
}

// ---------------------------------------------------------------------------------------------
// Scratch, rebuilt every tick (no state)
// ---------------------------------------------------------------------------------------------

/** Something that frightens wolves: a fire (its light) or a burning flare. */
interface Src { x: number; y: number; z: number; r: number; wall: number; heat: number; flare: boolean; embers: boolean }
const srcs: Src[] = [];
let nSrc = 0;
/** A flashlight beam: eye, unit look direction, range and the cosine of its half angle. */
interface Beam { p: PlayerEnt; ex: number; ey: number; ez: number; dx: number; dy: number; dz: number; range: number; cos: number; level: number }
const beams: Beam[] = [];
let nBeam = 0;
const avoidIce = new Set<number>(); // broken or new thin ice
const cols: Collider[] = [];
const packPool: Pack[] = [];
const active: Pack[] = [];
const byK = new Map<number, Pack>();
const deadList: WolfEnt[] = [];

// Indoor shelter volumes (buildings) wolves never follow anyone into. The cave is a den: not one of them.
let indoorWorld: World | null = null;
let indoorVols: (ShelterVol & { cs: number; sn: number; r2: number })[] = [];
function isIndoor(world: World, x: number, y: number, z: number): boolean {
  if (indoorWorld !== world) {
    indoorWorld = world;
    indoorVols = world.shelters
      .filter((s) => s.indoor && s.poi !== 'cave')
      .map((s) => ({ ...s, cs: Math.cos(s.yaw), sn: Math.sin(s.yaw), r2: s.hx * s.hx + s.hz * s.hz }));
  }
  for (let i = 0; i < indoorVols.length; i++) {
    const s = indoorVols[i];
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz > s.r2 || Math.abs(y - s.y) > s.hy) continue;
    if (Math.abs(dx * s.cs - dz * s.sn) <= s.hx && Math.abs(dx * s.sn + dz * s.cs) <= s.hz) return true;
  }
  return false;
}

function buildSources(ctx: SimCtx): void {
  nSrc = 0;
  const add = (): Src => {
    let s = srcs[nSrc];
    if (!s) srcs[nSrc] = s = { x: 0, y: 0, z: 0, r: 0, wall: 0, heat: 0, flare: false, embers: false };
    nSrc++;
    return s;
  };
  for (const f of ctx.all('fire')) {
    if (!f.lit && f.embers <= 0) continue;
    const s = add();
    s.x = f.x;
    s.y = f.y;
    s.z = f.z;
    s.flare = false;
    s.embers = !f.lit;
    s.heat = f.lit ? f.heat : 0.05;
    s.r = f.lit ? fireFear(f.heat) : 2.5;
    s.wall = f.lit ? smoothstep(FIRE_WEAK, FIRE_WALL, f.heat) : 0;
  }
  for (const f of ctx.all('flare')) {
    if (f.life <= 0) continue;
    const s = add();
    s.x = f.x;
    s.y = f.y;
    s.z = f.z;
    s.flare = true;
    s.embers = false;
    s.heat = 1;
    // in the air it streaks past; on the snow it is a wall of red light
    s.r = f.landed ? FLARE_FEAR : FLARE_FEAR * 0.6;
    s.wall = f.landed ? 1 : 0.6;
  }
  nBeam = 0;
  for (const p of ctx.players()) {
    const lv = p.beam ?? 0;
    if (lv <= 0 || p.held !== 'flashlight' || (p.life !== 'alive' && p.life !== 'downed')) continue;
    let b = beams[nBeam];
    if (!b) beams[nBeam] = b = { p, ex: 0, ey: 0, ez: 0, dx: 0, dy: 0, dz: 0, range: 0, cos: 1, level: 0 };
    nBeam++;
    const cp = Math.cos(p.pitch);
    b.p = p;
    b.ex = p.x;
    b.ey = p.y + eyeHeight(p);
    b.ez = p.z;
    b.dx = -Math.sin(p.yaw) * cp;
    b.dy = Math.sin(p.pitch);
    b.dz = -Math.cos(p.yaw) * cp;
    b.level = lv;
    // raised (SECONDARY), the beam is focused: narrower and longer
    b.range = (16 + 10 * p.aim) * (0.4 + 0.6 * lv);
    b.cos = Math.cos(0.24 - 0.09 * p.aim);
  }
}

/** Broken lake cells and new thin ice (from this sim's state: the scratch is shared by every Sim in the page). */
function buildIce(ctx: SimCtx): void {
  avoidIce.clear();
  const ice = ctx.state.ice;
  for (let i = 0; i < ice.length; i++) {
    const c = ice[i];
    if (c.hole || (c.skin !== undefined && c.skin < THIN_ICE)) avoidIce.add(c.i);
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function setMood(w: WolfEnt, m: WolfMood): void {
  if (w.mood !== m) {
    w.mood = m;
    w.moodT = 0;
  }
}

const len = (x: number, z: number): number => Math.sqrt(x * x + z * z);

/** Can a wolf stand here: walkable ground (no steep slope, no wall, tree or rock), no thin ice or water. */
function passable(ctx: SimCtx, x: number, z: number): boolean {
  const w = ctx.world;
  if (!w.walkable(x, z)) return false;
  const lk = w.lake;
  const span = lk.n * lk.cell;
  if (x < lk.minX || z < lk.minZ || x > lk.minX + span || z > lk.minZ + span) return true; // nowhere near the ice
  const ice = w.iceAt(x, z);
  if (ice > 0) {
    if (ice < THIN_ICE) return false;
    if (avoidIce.size > 0) {
      const i = w.iceCell(x, z);
      if (i >= 0 && avoidIce.has(i)) return false;
    }
  }
  return true;
}

const alive = (p: PlayerEnt | null | undefined): p is PlayerEnt => !!p && (p.life === 'alive' || p.life === 'downed');

/** How safe a player is from wolves this tick, 0..1: inside a strong fire's light or a burning flare's. */
function safetyAt(x: number, z: number): number {
  let s = 0;
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    if (c.wall <= s) continue;
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < c.r * c.r) s = c.wall;
  }
  return s;
}

/** Light falling on a spot from fires and flares, 0..1. */
function lightAt(x: number, z: number): number {
  let l = 0;
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    const d = len(x - c.x, z - c.z);
    const v = c.heat * sat(1 - d / (c.r * 1.4));
    if (v > l) l = v;
  }
  return l;
}

/** 0..1 how much the fire a player stands by is dying (a lit fire gone weak, or only embers left). */
function dyingFire(x: number, z: number): number {
  let v = 0;
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    if (c.flare) continue;
    const d = len(x - c.x, z - c.z);
    if (c.embers) {
      if (d < 5) v = Math.max(v, 1);
    } else if (c.heat < FIRE_WALL && d < c.r + 3) v = Math.max(v, 1 - c.heat / FIRE_WALL);
  }
  return v;
}

/** Is this light a wall to a wolf of a pack this bold? A strong fire or a burning flare always is. */
function wallFor(c: Src, bold: number): boolean {
  return c.wall >= 0.999 || (c.wall > 0 && bold < 0.5 + 0.5 * c.wall);
}

// Where floors are (8 m cells): away from them the ground is the terrain itself, which is far cheaper
// to ask for than groundAt (it checks every floor in the world).
const FLOOR_CELL = 8;
let floorWorld: World | null = null;
let floorGrid = new Uint8Array(0);
let floorN = 0;
function nearFloor(world: World, x: number, z: number): boolean {
  if (floorWorld !== world) {
    floorWorld = world;
    floorN = Math.ceil((2 * world.half) / FLOOR_CELL) + 1;
    floorGrid = new Uint8Array(floorN * floorN);
    for (const f of world.floors) {
      const r = Math.sqrt(f.hx * f.hx + f.hz * f.hz) + 1;
      const i0 = Math.max(0, Math.floor((f.x - r + world.half) / FLOOR_CELL)), i1 = Math.min(floorN - 1, Math.floor((f.x + r + world.half) / FLOOR_CELL));
      const j0 = Math.max(0, Math.floor((f.z - r + world.half) / FLOOR_CELL)), j1 = Math.min(floorN - 1, Math.floor((f.z + r + world.half) / FLOOR_CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) floorGrid[j * floorN + i] = 1;
    }
  }
  const i = Math.floor((x + world.half) / FLOOR_CELL), j = Math.floor((z + world.half) / FLOOR_CELL);
  return i >= 0 && j >= 0 && i < floorN && j < floorN && floorGrid[j * floorN + i] === 1;
}

function groundY(ctx: SimCtx, x: number, z: number, y: number): number {
  const w = ctx.world;
  return nearFloor(w, x, z) ? w.groundAt(x, z, y + 0.6).y : w.heightAt(x, z);
}

function emitAt(ctx: SimCtx, t: 'growl' | 'bark' | 'yelp', w: WolfEnt): void {
  ctx.emit({ t, id: w.id, x: w.x, y: w.y, z: w.z });
}

function howl(ctx: SimCtx, w: WolfEnt): void {
  setMood(w, 'howl');
  ctx.emit({ t: 'howl', id: w.id, x: w.x, y: w.y, z: w.z, pack: w.pack });
}

function growl(ctx: SimCtx, w: WolfEnt, every: number): void {
  if (wv(ctx, w.id, 'gr') > 0) return;
  setWv(ctx, w.id, 'gr', every);
  emitAt(ctx, 'growl', w);
}

/** Cower in place, facing the threat at (fx, fz), then run from it for `fleeAfter` seconds (0: back to the pack). */
function cower(ctx: SimCtx, w: WolfEnt, secs: number, fx: number, fz: number, fleeAfter: number): void {
  w.mood = 'cower';
  w.moodT = 0;
  setWv(ctx, w.id, 'stun', secs);
  setWv(ctx, w.id, 'fx', fx);
  setWv(ctx, w.id, 'fz', fz);
  setWv(ctx, w.id, 'ft', fleeAfter);
  setWv(ctx, w.id, 'fo', 0);
  setWv(ctx, w.id, 'bt', 0);
}

/** Run from (fx, fz) for `secs` seconds, then back to what the pack is doing. */
function flee(ctx: SimCtx, w: WolfEnt, fx: number, fz: number, secs: number): void {
  w.mood = 'flee';
  w.moodT = 0;
  setWv(ctx, w.id, 'fx', fx);
  setWv(ctx, w.id, 'fz', fz);
  setWv(ctx, w.id, 'ft', Math.max(0.1, secs));
  setWv(ctx, w.id, 'fo', 0);
  setWv(ctx, w.id, 'bt', 0);
}

/** Back to the part the pack's phase gives it. */
function settle(ctx: SimCtx, w: WolfEnt, pk: Pack): void {
  setWv(ctx, w.id, 'fo', 0);
  setWv(ctx, w.id, 'bt', 0);
  setWv(ctx, w.id, 'ft', 0);
  setWv(ctx, w.id, 'stun', 0);
  setMood(w, PHASE_MOOD[pk.ph]);
  w.target = pk.ph >= PHASE.stalk && pk.ph <= PHASE.attack ? pk.tg : 0;
}

/** Moods a wolf is in for itself, which a change of the pack's phase does not interrupt. */
function busy(ctx: SimCtx, w: WolfEnt): boolean {
  switch (w.mood) {
    case 'feint': case 'charge': case 'bite': case 'drag': case 'cower': case 'howl':
      return true;
    case 'flee':
      return wv(ctx, w.id, 'ft') > 0;
    default:
      return false;
  }
}

function enterPhase(ctx: SimCtx, pk: Pack, ph: number): void {
  pk.ph = ph;
  pk.pt = 0;
  for (const w of pk.wolves) if (!busy(ctx, w)) settle(ctx, w, pk);
}

/** Circling radius for a boldness. */
function circleR(bold: number): number {
  return CIRCLE_MAX - (CIRCLE_MAX - CIRCLE_MIN) * sat((bold - 0.4) / 0.45);
}

function packSize(ctx: SimCtx, base: number): number {
  const n = Math.max(ctx.players().length, ctx.v('sim.players', 1));
  return Math.min(6, Math.max(1, base) + (n >= 3 ? 2 : n >= 2 ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------------------------

/** A walkable spot near (x, z), searching rings out to `reach` metres. */
function spotNear(ctx: SimCtx, x: number, z: number, reach: number): { x: number; z: number } {
  if (passable(ctx, x, z)) return { x, z };
  for (let r = 2; r <= reach; r += 2) {
    const n = Math.max(6, Math.round(r * 1.5));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const sx = x + Math.sin(a) * r, sz = z + Math.cos(a) * r;
      if (passable(ctx, sx, sz)) return { x: sx, z: sz };
    }
  }
  return { x, z };
}

/**
 * Bring pack `k` to life at (x, z) with `n` wolves (fewer if some are already out), home range
 * `range`. With `howl` it starts by gathering, which the others answer. Returns the new wolves.
 */
export function spawnPack(ctx: SimCtx, k: number, x: number, z: number, range: number, n: number, howlNow = true): WolfEnt[] {
  const vars = ctx.state.vars;
  const keys = pkeys(k);
  vars[keys.aw] = 1;
  buildIce(ctx);
  let have = 0;
  for (const w of ctx.all('wolf')) if (w.pack === k && w.mood !== 'dead') have++;
  const c = spotNear(ctx, x, z, 40);
  const out: WolfEnt[] = [];
  for (let i = have; i < n; i++) {
    let sx = c.x, sz = c.z;
    for (let tries = 0; tries < 10; tries++) {
      const a = ctx.rand() * TAU, r = 1.5 + ctx.rand() * 6;
      const qx = c.x + Math.sin(a) * r, qz = c.z + Math.cos(a) * r;
      if (passable(ctx, qx, qz)) {
        sx = qx;
        sz = qz;
        break;
      }
    }
    const y = groundY(ctx, sx, sz, ctx.world.heightAt(sx, sz) + 0.5);
    const w = ctx.spawn<WolfEnt>(makeWolf(sx, y, sz, { pack: k, alpha: i === 0, variant: Math.floor(ctx.rand() * 4096), yaw: ctx.rand() * TAU - Math.PI }));
    w.hunger = 0.45 + 0.25 * ctx.rand();
    w.mood = 'roam';
    out.push(w);
  }
  if (vars[keys.ph] === undefined || have === 0) {
    for (const f of PF) vars[keys[f]] = PDEF[f];
    vars[keys.hx] = vars[keys.wx] = c.x;
    vars[keys.hz] = vars[keys.wz] = c.z;
    vars[keys.rg] = range;
    vars[keys.or] = ctx.rand() < 0.5 ? 1 : -1;
  }
  // the next tick starts the gathering howl (packTick sees hw unset), which the other packs answer
  if (howlNow) {
    vars[keys.ph] = PHASE.gather;
    vars[keys.pt] = 0;
    vars[keys.hw] = -1e9;
  }
  return out;
}

function wake(ctx: SimCtx): void {
  const defs = ctx.world.spawn.packs;
  const t = ctx.state.env.t;
  const vars = ctx.state.vars;
  const checkDen = ctx.state.tick % 30 === 0 && t >= DISTURB_AFTER;
  for (let k = 0; k < defs.length; k++) {
    if (vars[pkeys(k).aw] !== undefined) continue;
    const d = defs[k];
    let go = t >= d.wakeAt;
    if (!go && checkDen) {
      for (const p of ctx.players()) {
        if (p.life === 'alive' && len(p.x - d.x, p.z - d.z) < DEN_DISTURB) go = true;
      }
    }
    if (go) spawnPack(ctx, k, d.x, d.z, d.range, packSize(ctx, d.count), true);
  }
}

// ---------------------------------------------------------------------------------------------
// The pack's brain
// ---------------------------------------------------------------------------------------------

function detectRange(ctx: SimCtx, p: PlayerEnt, hunger: number, night: number): number {
  const env = ctx.state.env;
  let r = (85 + 70 * hunger) * (1 - 0.35 * env.storm);
  if (p.sprint) r += 25;
  if (p.act === 'swing' || p.act === 'shoot') r += 40;
  if ((p.beam ?? 0) > 0) r += 20 * night; // a light moving in the dark
  if (p.life === 'downed') r += 30;
  return r;
}

/** How weak a target looks, 0..1. */
function weakness(p: PlayerEnt, night: number): number {
  if (p.life === 'downed') return 1;
  const dark = night * (1 - lightAt(p.x, p.z));
  return Math.max(1 - p.health / 100, 0.8 * p.isolation, 0.6 * dark);
}

/** The player this pack should hunt (never one who is safe or indoors), or null. */
function chooseTarget(ctx: SimCtx, pk: Pack, hunger: number, exclude: NetId): PlayerEnt | null {
  const a = pk.alpha!;
  const night = pk.night, white = pk.white;
  let best: PlayerEnt | null = null;
  let bs = -Infinity;
  for (const p of ctx.players()) {
    if (!alive(p) || p.swim || p.id === exclude) continue;
    const d = len(p.x - a.x, p.z - a.z);
    const cur = p.id === pk.tg;
    if (d > (cur ? LOSE_RANGE : detectRange(ctx, p, hunger, night))) continue;
    if (safetyAt(p.x, p.z) >= SAFE || isIndoor(ctx.world, p.x, p.y + 1, p.z)) continue;
    const dark = night * (1 - lightAt(p.x, p.z)) * ((p.beam ?? 0) > 0 ? 0.7 : 1);
    const s = p.isolation + 0.7 * (1 - p.health / 100) + (p.life === 'downed' ? 1.4 : 0) + 0.35 * dark +
      0.3 * white * p.isolation + 0.35 * dyingFire(p.x, p.z) - d / 160 + (cur ? 0.35 : 0);
    if (s > bs) {
      bs = s;
      best = p;
    }
  }
  return best;
}

function boldness(ctx: SimCtx, pk: Pack, t: PlayerEnt, hunger: number): number {
  let def = 0;
  for (const p of ctx.players()) if (p.life === 'alive' && len(p.x - t.x, p.z - t.z) < 22) def++;
  let fit = 0;
  for (const w of pk.wolves) if (w.health > 0.4 * maxHealth(w)) fit++;
  // the last stand at the tower: the packs the call brought do not hang back
  const stage = ctx.state.objective.stage;
  const last = stage === 'holdout' || stage === 'rescue' ? 0.15 : 0;
  return sat(0.05 + 0.25 * hunger + 0.15 * pk.night + 0.15 * pk.white + 0.1 * clamp((fit - 2 * def) / 3, -1, 1) +
    0.15 * weakness(t, pk.night) + 0.12 * dyingFire(t.x, t.z) + last + pk.pr - 0.7 * pk.fear);
}

const maxHealth = (w: WolfEnt): number => (w.alpha ? 80 : 60);

/** The most boldness going unopposed earns against this target: little against people together and well. */
function pressCap(t: PlayerEnt | null, pk: Pack): number {
  if (!t) return 0;
  const vuln = t.life === 'downed' ? 1 : Math.max(t.isolation, 1 - t.health / 100);
  // daylight in clear weather keeps them wary
  return PRESS_MAX * (0.35 + 0.65 * vuln) * (0.5 + 0.5 * Math.max(pk.night, pk.white));
}

/**
 * A goal on a ring of radius R round (cx, cz) at angle `want`, reached by going round the ring (no
 * more than `step` radians ahead of where the wolf is now) rather than cutting across it.
 */
function ringGoal(w: WolfEnt, cx: number, cz: number, R: number, want: number, step: number, out: { x: number; z: number }): typeof out {
  const now = Math.atan2(w.x - cx, w.z - cz);
  const a = now + clamp(wrapAngle(want - now), -step, step);
  out.x = cx + Math.sin(a) * R;
  out.z = cz + Math.cos(a) * R;
  return out;
}
const ring = { x: 0, z: 0 };

/** A new waypoint in the home range, one the alpha can walk to in a straight line if it can find one. */
function newWaypoint(ctx: SimCtx, pk: Pack): void {
  const a0 = pk.alpha;
  pk.wt = ctx.state.env.t;
  let fallback = false;
  for (let tries = 0; tries < 10; tries++) {
    const a = ctx.rand() * TAU, r = pk.rg * 0.8 * Math.sqrt(ctx.rand());
    const x = pk.hx + Math.sin(a) * r, z = pk.hz + Math.cos(a) * r;
    if (!passable(ctx, x, z) || isIndoor(ctx.world, x, ctx.world.heightAt(x, z) + 1, z)) continue;
    let open = true;
    if (a0) {
      const n = Math.min(12, Math.ceil(len(x - a0.x, z - a0.z) / 8));
      for (let i = 1; i < n && open; i++) open = passable(ctx, a0.x + ((x - a0.x) * i) / n, a0.z + ((z - a0.z) * i) / n);
    }
    if (open || (tries === 9 && !fallback)) {
      pk.wx = x;
      pk.wz = z;
      return;
    }
    fallback = true;
  }
  pk.wx = pk.hx;
  pk.wz = pk.hz;
}

/** The pack howls: the alpha now, the rest as the gathering runs; packs in earshot answer. */
function startGather(ctx: SimCtx, pk: Pack): void {
  enterPhase(ctx, pk, PHASE.gather);
  pk.hw = ctx.state.env.t;
  pk.nf = 0;
  pk.prot = 0;
  answer(ctx, pk);
}

function answer(ctx: SimCtx, pk: Pack): void {
  const a = pk.alpha;
  if (!a) return;
  const t = ctx.state.env.t;
  for (const o of active) {
    if (o === pk || !o.alpha || o.ans >= 0 || t - o.hw < 20) continue;
    if (len(o.alpha.x - a.x, o.alpha.z - a.z) > HOWL_HEAR) continue;
    o.ans = t + 2.5 + 4 * ctx.rand();
  }
}

/** Wolves that may be sent in: not hurt badly, not cooling off after a bite, not busy. */
function ready(ctx: SimCtx, w: WolfEnt): boolean {
  return w.health > 0.4 * maxHealth(w) && wv(ctx, w.id, 'cd') <= 0 && !busy(ctx, w);
}

function sendFeint(ctx: SimCtx, pk: Pack, t: PlayerEnt): boolean {
  let pick: WolfEnt | null = null;
  for (const w of pk.wolves) {
    if (!ready(ctx, w)) continue;
    if (!pick || (pick.alpha && !w.alpha) || (pick.alpha === w.alpha && w.hunger > pick.hunger)) pick = w;
  }
  if (!pick) return false;
  setMood(pick, 'feint');
  pick.target = t.id;
  setWv(ctx, pick.id, 'fo', 0);
  pk.fs = ctx.state.env.t;
  return true;
}

function sendCharge(ctx: SimCtx, pk: Pack, t: PlayerEnt): boolean {
  // two at once only at a weakened target, by a very bold pack
  const want = t.life === 'downed' ? 1 : pk.bold > 0.85 && t.health < 60 && pk.wolves.length >= 3 ? 2 : 1;
  let sent = 0;
  // a body on the ground: the alpha goes (it drags); otherwise the hungriest first
  for (let pass = 0; pass < 2 && sent < want; pass++) {
    let pick: WolfEnt | null = null;
    for (const w of pk.wolves) {
      if (w.mood === 'charge' || !ready(ctx, w)) continue;
      const pref = t.life === 'downed' ? w.alpha : !w.alpha;
      if (!pick || (pref && !(t.life === 'downed' ? pick.alpha : !pick.alpha)) || w.hunger > pick.hunger + 0.15) pick = w;
    }
    if (!pick) break;
    setMood(pick, 'charge');
    pick.target = t.id;
    growl(ctx, pick, 3);
    sent++;
  }
  return sent > 0;
}

/** Anyone of this pack still on the attack. */
function attacking(pk: Pack): boolean {
  for (const w of pk.wolves) if (w.mood === 'charge' || w.mood === 'bite' || w.mood === 'drag') return true;
  return false;
}

function dragging(pk: Pack, id: NetId): boolean {
  for (const w of pk.wolves) if (w.mood === 'drag' && w.target === id) return true;
  return false;
}

/** Burning flare within `r` of a point. */
function flareNear(x: number, z: number, r: number): Src | null {
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    if (c.flare && len(c.x - x, c.z - z) < r) return c;
  }
  return null;
}

function think(ctx: SimCtx, pk: Pack): void {
  const env = ctx.state.env;
  const t = env.t;
  let hunger = 0;
  for (const w of pk.wolves) hunger += w.hunger;
  hunger /= Math.max(1, pk.wolves.length);
  const a = pk.alpha!;

  switch (pk.ph) {
    case PHASE.scatter: {
      if (pk.st > 0) return;
      const back = pk.tg ? ctx.get<PlayerEnt>(pk.tg) : undefined;
      if (alive(back) && back.kind === 'player' && hunger > 0.35 && len(back.x - a.x, back.z - a.z) < LOSE_RANGE) {
        pk.oa = Math.atan2(a.x - back.x, a.z - back.z);
        enterPhase(ctx, pk, PHASE.stalk);
      } else {
        pk.tg = 0;
        // regroup away from where the shot came from, toward home
        pk.wx = 0.5 * (a.x + pk.hx);
        pk.wz = 0.5 * (a.z + pk.hz);
        pk.wt = ctx.state.env.t;
        enterPhase(ctx, pk, PHASE.roam);
      }
      return;
    }
    case PHASE.feed: {
      const body = pk.tg ? ctx.get<PlayerEnt>(pk.tg) : undefined;
      if (!body || body.kind !== 'player' || body.life !== 'dead' || pk.pt > FEED_TIME) {
        for (const w of pk.wolves) w.hunger = 0.05 * ctx.rand();
        pk.tg = 0;
        pk.pr = 0;
        pk.wx = pk.hx;
        pk.wz = pk.hz;
        pk.wt = ctx.state.env.t;
        enterPhase(ctx, pk, PHASE.rest);
      }
      return;
    }
    case PHASE.rest:
    case PHASE.roam: {
      if (pk.ph === PHASE.roam && pk.night > 0.5 && t - pk.hw > 150 && ctx.rand() < 0.02) {
        // a howl in the night, for nothing but itself; others answer
        howl(ctx, a);
        pk.hw = t;
        answer(ctx, pk);
      }
      const tg = chooseTarget(ctx, pk, hunger, 0);
      const close = tg !== null && len(tg.x - a.x, tg.z - a.z) < 35;
      if (tg && (hunger >= 0.3 || weakness(tg, pk.night) >= 0.5 || close)) {
        pk.tg = tg.id;
        pk.target = tg;
        pk.nf = 0;
        pk.prot = 0;
        if (t - pk.hw < 30) {
          // they have just howled (woken): straight on
          pk.oa = Math.atan2(a.x - tg.x, a.z - tg.z);
          enterPhase(ctx, pk, PHASE.stalk);
        } else startGather(ctx, pk);
        return;
      }
      if (pk.ph === PHASE.rest && (hunger > 0.5 || pk.pt > 150)) enterPhase(ctx, pk, PHASE.roam);
      return;
    }
    case PHASE.gather: {
      const tg = pk.tg ? ctx.get<PlayerEnt>(pk.tg) : undefined;
      if (pk.pt < GATHER_TIME) return;
      if (alive(tg) && tg.kind === 'player') {
        pk.oa = Math.atan2(a.x - tg.x, a.z - tg.z);
        enterPhase(ctx, pk, PHASE.stalk);
      } else enterPhase(ctx, pk, PHASE.roam);
      return;
    }
    default:
      hunt(ctx, pk, hunger);
  }
}

/** Stalk, circle, attack: the target, the boldness and the next step. */
function hunt(ctx: SimCtx, pk: Pack, hunger: number): void {
  const dtThink = THINK * ctx.dt;
  const cur = alive(pk.target) && pk.target.kind === 'player' ? pk.target : null;
  let tg = chooseTarget(ctx, pk, hunger, 0);
  let holding = false;
  if (!tg) {
    // nobody to take; a target standing in the light is waited on at its edge for a while
    if (cur && !cur.swim && safetyAt(cur.x, cur.z) >= SAFE && len(cur.x - pk.alpha!.x, cur.z - pk.alpha!.z) < LOSE_RANGE) {
      pk.prot += dtThink;
      if (pk.prot < PROTECT_GIVEUP) {
        tg = cur;
        holding = true;
      }
    }
    if (!tg) {
      pk.tg = 0;
      pk.target = null;
      pk.prot = 0;
      pk.wx = pk.alpha!.x;
      pk.wz = pk.alpha!.z;
      enterPhase(ctx, pk, PHASE.roam);
      return;
    }
  } else if (!holding) pk.prot = Math.max(0, pk.prot - dtThink);
  if (tg !== cur) {
    pk.tg = tg.id;
    pk.target = tg;
    pk.oa = Math.atan2(pk.alpha!.x - tg.x, pk.alpha!.z - tg.z);
    if (pk.ph === PHASE.attack) enterPhase(ctx, pk, PHASE.circle);
    for (const w of pk.wolves) if (w.target && w.target !== tg.id && (w.mood === 'stalk' || w.mood === 'circle')) w.target = tg.id;
  }
  const bold = boldness(ctx, pk, tg, hunger);
  pk.bold += (bold - pk.bold) * 0.35;

  if (holding) {
    // wait at the edge of the light
    if (pk.ph !== PHASE.stalk) {
      for (const w of pk.wolves) if (w.mood === 'charge' || w.mood === 'feint') flee(ctx, w, tg.x, tg.z, 1.5);
      enterPhase(ctx, pk, PHASE.stalk);
    }
    return;
  }
  if (tg.life === 'downed' && pk.ph !== PHASE.attack) {
    enterPhase(ctx, pk, PHASE.attack);
    sendCharge(ctx, pk, tg);
    return;
  }
  switch (pk.ph) {
    case PHASE.stalk:
      // (not while a flare burns by the target: it holds them off)
      if (pk.bold >= CIRCLE_BOLD && pk.pt >= STALK_TIME && !flareNear(tg.x, tg.z, FLARE_FEAR + 10)) {
        pk.fe = 3 + 4 * ctx.rand();
        enterPhase(ctx, pk, PHASE.circle);
      }
      break;
    case PHASE.circle: {
      const fl = flareNear(tg.x, tg.z, FLARE_FEAR + 10);
      if (fl) {
        // a burning flare breaks the circle: back off past its light and start over
        breakCircle(ctx, pk, fl.x, fl.z);
        break;
      }
      if (pk.bold < CIRCLE_BOLD - 0.15) {
        enterPhase(ctx, pk, PHASE.stalk);
        break;
      }
      if (ctx.rand() < 0.03) pk.or = -pk.or;
      if (pk.fe <= 0) {
        let sent = false;
        // wolves test before they commit: two feints first (one at a hurt or weak target)
        if (pk.bold >= CHARGE_BOLD && pk.nf >= (weakness(tg, pk.night) > 0.85 && tg.health < 70 ? 1 : 2)) {
          sent = sendCharge(ctx, pk, tg);
          if (sent) enterPhase(ctx, pk, PHASE.attack);
        }
        if (!sent) sendFeint(ctx, pk, tg);
        pk.fe = (6 + 6 * ctx.rand()) * (1.3 - 0.5 * pk.bold);
      }
      break;
    }
    case PHASE.attack: {
      const fl = flareNear(tg.x, tg.z, FLARE_FEAR + 6);
      if (fl) {
        breakCircle(ctx, pk, fl.x, fl.z);
        break;
      }
      if (!attacking(pk)) {
        pk.fe = 3 + 4 * ctx.rand();
        enterPhase(ctx, pk, PHASE.circle);
      }
      break;
    }
  }
}

function breakCircle(ctx: SimCtx, pk: Pack, fx: number, fz: number): void {
  pk.pr = Math.max(0, pk.pr - 0.3);
  pk.fear = Math.min(1, pk.fear + 0.3);
  pk.sc = ctx.state.env.t;
  for (const w of pk.wolves) {
    if (w.mood === 'drag' || w.mood === 'bite') continue;
    flee(ctx, w, fx, fz, 2.5 + ctx.rand());
  }
  enterPhase(ctx, pk, PHASE.stalk);
}

// ---------------------------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------------------------

/** Push a wolf at (x, z) out of the colliders around it. Result in mx / mz. */
let mx = 0;
let mz = 0;
function collide(ctx: SimCtx, x: number, z: number, feet: number): void {
  cols.length = 0;
  ctx.world.collidersNear(x, z, WOLF_RADIUS + 0.6, cols);
  const R = WOLF_RADIUS;
  for (let pass = 0; pass < 2; pass++) {
    let hit = false;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.y1 <= feet + 0.35 || c.y0 >= feet + 0.9) continue;
      let nx: number, nz: number, push: number;
      if (c.s === 'c') {
        const dx = x - c.x, dz = z - c.z, rr = c.r + R;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2);
        nx = d > 1e-6 ? dx / d : 1;
        nz = d > 1e-6 ? dz / d : 0;
        push = rr - d;
      } else {
        const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        const dx = x - c.x, dz = z - c.z;
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
        const qx = clamp(lx, -c.hx, c.hx), qz = clamp(lz, -c.hz, c.hz);
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
      hit = true;
    }
    if (!hit) break;
  }
  mx = x;
  mz = z;
}

/** Turn rate, rad/s, at a ground speed: a galloping wolf turns wide. */
const turnRate = (speed: number): number => Math.max(2.1, 6.5 - 0.4 * speed);

/** Put the wolf at (x, z) if it may stand there, keeping it out of every wall of light it fears. */
function place(ctx: SimCtx, pk: Pack, w: WolfEnt, x: number, z: number): boolean {
  const lim = ctx.world.half - 3;
  x = clamp(x, -lim, lim);
  z = clamp(z, -lim, lim);
  collide(ctx, x, z, w.y);
  x = mx;
  z = mz;
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    if (!wallFor(c, pk.bold)) continue;
    const dx = x - c.x, dz = z - c.z;
    const d = len(dx, dz);
    if (d >= c.r) continue;
    // inside the light: out to its edge (from wherever it was already, or straight out)
    const k = d > 1e-3 ? c.r / d : 0;
    x = d > 1e-3 ? c.x + dx * k : c.x + Math.sin(w.yaw) * c.r;
    z = d > 1e-3 ? c.z + dz * k : c.z + Math.cos(w.yaw) * c.r;
  }
  if (!passable(ctx, x, z) && passable(ctx, w.x, w.z)) return false;
  w.x = x;
  w.z = z;
  w.y = groundY(ctx, x, z, w.y);
  return true;
}

/**
 * Steer toward (gx, gz) at `want` m/s (slowing inside `arrive` metres), bending round the light of
 * fires and flares it fears, apart from its pack mates, round what it cannot walk on; it runs where
 * it faces and turns smoothly.
 */
function steer(ctx: SimCtx, pk: Pack, w: WolfEnt, gx: number, gz: number, want: number, arrive: number): void {
  const dt = ctx.dt;
  // a goal inside a wall of light is moved to its edge
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    if (!wallFor(c, pk.bold)) continue;
    const ex = gx - c.x, ez = gz - c.z;
    const ed = len(ex, ez);
    const edge = c.r + 1.5;
    if (ed >= edge) continue;
    if (ed > 1e-3) {
      gx = c.x + (ex / ed) * edge;
      gz = c.z + (ez / ed) * edge;
    } else {
      const ox = w.x - c.x, oz = w.z - c.z, ol = len(ox, oz) || 1;
      gx = c.x + (ox / ol) * edge;
      gz = c.z + (oz / ol) * edge;
    }
  }
  let dx = gx - w.x, dz = gz - w.z;
  const d = len(dx, dz);
  let s = want;
  if (d < arrive) s = want * (d / arrive);
  if (d > 1e-4) {
    dx /= d;
    dz /= d;
  } else {
    dx = -Math.sin(w.yaw);
    dz = -Math.cos(w.yaw);
    s = 0;
  }
  // the light pushes out and round (so a goal beyond a fire is reached by going round it)
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    if (!wallFor(c, pk.bold)) continue;
    const rx = w.x - c.x, rz = w.z - c.z;
    const rd = len(rx, rz);
    if (rd > c.r + 6 || rd < 1e-3) continue;
    const ux = rx / rd, uz = rz / rd;
    const inward = -(dx * ux + dz * uz);
    if (inward <= 0) continue;
    const k = 2.2 * smoothstep(c.r + 6, c.r + 0.5, rd) * c.wall;
    // tangent on the goal's side
    const side = dx * uz - dz * ux >= 0 ? 1 : -1;
    dx += ux * k * inward + uz * side * k;
    dz += uz * k * inward - ux * side * k;
  }
  // keep a little apart from the pack
  for (const o of pk.wolves) {
    if (o === w) continue;
    const ox = w.x - o.x, oz = w.z - o.z;
    const od2 = ox * ox + oz * oz;
    if (od2 > 2.6 || od2 < 1e-6) continue;
    const od = Math.sqrt(od2);
    const k = 0.6 * (1 - od / 1.62);
    dx += (ox / od) * k;
    dz += (oz / od) * k;
  }
  let l = len(dx, dz);
  if (l < 1e-4) {
    dx = -Math.sin(w.yaw);
    dz = -Math.cos(w.yaw);
    l = 1;
  }
  dx /= l;
  dz /= l;
  // look ahead: walk round what cannot be walked on
  if (s > 0.05) {
    const probe = Math.max(1.2, w.speed * 0.45);
    if (!passable(ctx, w.x + dx * probe, w.z + dz * probe)) {
      const side = w.id & 1 ? 1 : -1;
      let found = false;
      for (let i = 0; i < DODGE.length; i++) {
        const a = DODGE[i] * side;
        const ca = Math.cos(a), sa = Math.sin(a);
        const rx = dx * ca + dz * sa, rz = dz * ca - dx * sa;
        if (passable(ctx, w.x + rx * probe, w.z + rz * probe)) {
          dx = rx;
          dz = rz;
          found = true;
          break;
        }
      }
      if (!found) {
        dx = -dx;
        dz = -dz;
        s *= 0.4;
      }
    }
  }
  // turn toward the heading; slow down for a hard turn
  const wantYaw = Math.atan2(-dx, -dz);
  const dyaw = wrapAngle(wantYaw - w.yaw);
  const maxTurn = turnRate(w.speed) * dt;
  w.yaw = wrapAngle(w.yaw + clamp(dyaw, -maxTurn, maxTurn));
  s *= 1 - 0.6 * sat((Math.abs(dyaw) - 0.6) / 2);
  const acc = s > w.speed ? 9 : 16;
  w.speed = w.speed + clamp(s - w.speed, -acc * dt, acc * dt);
  const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
  w.vx = fx * w.speed;
  w.vz = fz * w.speed;
  if (w.speed > 1e-3 && !place(ctx, pk, w, w.x + w.vx * dt, w.z + w.vz * dt)) {
    w.speed *= 0.5;
    w.vx *= 0.5;
    w.vz *= 0.5;
  }
}

/** Stand (sliding to a stop on whatever velocity it had) and turn to look at (lx, lz). */
function hold(ctx: SimCtx, pk: Pack, w: WolfEnt, lx: number, lz: number): void {
  const dt = ctx.dt;
  const v = len(w.vx, w.vz);
  if (v > 1e-3) {
    const nv = Math.max(0, v - 12 * dt);
    w.vx *= nv / v;
    w.vz *= nv / v;
    if (!place(ctx, pk, w, w.x + w.vx * dt, w.z + w.vz * dt)) {
      w.vx = 0;
      w.vz = 0;
    }
  } else {
    w.vx = 0;
    w.vz = 0;
  }
  w.speed = len(w.vx, w.vz);
  const ddx = lx - w.x, ddz = lz - w.z;
  if (ddx * ddx + ddz * ddz > 0.01) {
    const dyaw = wrapAngle(Math.atan2(-ddx, -ddz) - w.yaw);
    const m = turnRate(0) * 0.6 * dt;
    w.yaw = wrapAngle(w.yaw + clamp(dyaw, -m, m));
  }
}

// ---------------------------------------------------------------------------------------------
// What each wolf does this tick
// ---------------------------------------------------------------------------------------------

/** Is the player looking at the wolf (within `cosA` of their facing)? */
function lookedAt(p: PlayerEnt, w: WolfEnt, cosA: number): boolean {
  const dx = w.x - p.x, dz = w.z - p.z;
  const d = len(dx, dz);
  if (d < 1e-3) return true;
  return (-Math.sin(p.yaw) * dx - Math.cos(p.yaw) * dz) / d > cosA;
}

/** Choose a cover angle on the stalking ring: a spot the target cannot see (terrain, a rock, the trees). */
function pickCover(ctx: SimCtx, pk: Pack, w: WolfEnt, t: PlayerEnt, base: number, R: number): void {
  const ey = t.y + eyeHeight(t);
  for (let i = 0; i < COVER.length; i++) {
    const a = base + COVER[i];
    const x = t.x + Math.sin(a) * R, z = t.z + Math.cos(a) * R;
    if (!passable(ctx, x, z)) continue;
    const hidden = ctx.world.forestAt(x, z) > 0.45 || !ctx.world.lineClear(t.x, ey, t.z, x, groundY(ctx, x, z, t.y) + 0.6, z);
    if (hidden) {
      setWv(ctx, w.id, 'co', COVER[i]);
      return;
    }
  }
  setWv(ctx, w.id, 'co', 0);
}

function stalk(ctx: SimCtx, pk: Pack, w: WolfEnt, slot: number, t: PlayerEnt): void {
  let R = clamp(pk.sight * 1.05, STALK_MIN, STALK_MAX);
  // at the edge of a fire's light at least, when that is where the target stands
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    if (wallFor(c, pk.bold) && len(t.x - c.x, t.z - c.z) < c.r) R = Math.max(R, c.r + 3 + len(t.x - c.x, t.z - c.z));
  }
  const base = pk.oa + SPREAD[slot % SPREAD.length];
  if ((ctx.state.tick + w.id * 7) % 30 === 0) pickCover(ctx, pk, w, t, base, R);
  const a = base + wv(ctx, w.id, 'co');
  const d = len(w.x - t.x, w.z - t.z);
  // round the ring when already near it, straight in from far off
  const g = d < R * 1.6 ? ringGoal(w, t.x, t.z, R, a, 0.5, ring) : { x: t.x + Math.sin(a) * R, z: t.z + Math.cos(a) * R };
  if (t.life === 'alive' && d < R * 1.15 && lookedAt(t, w, 0.82)) {
    if (d < R * 0.9) {
      // seen: slip back out of sight
      const k = (R * 1.1) / Math.max(d, 1e-3);
      steer(ctx, pk, w, t.x + (w.x - t.x) * k, t.z + (w.z - t.z) * k, WOLF_TROT, 2);
    } else hold(ctx, pk, w, t.x, t.z); // freeze at the edge
    return;
  }
  const gd = len(g.x - w.x, g.z - w.z);
  if (gd < 1.5) hold(ctx, pk, w, t.x, t.z);
  else steer(ctx, pk, w, g.x, g.z, gd > 15 ? WOLF_TROT : WOLF_WALK, 3);
}

function circle(ctx: SimCtx, pk: Pack, w: WolfEnt, slot: number, n: number, t: PlayerEnt): void {
  const R = circleR(pk.bold) + 1.5 * Math.sin(ctx.state.env.t * 0.7 + w.id);
  const a = pk.oa + (slot * TAU) / Math.max(1, n);
  const d = len(w.x - t.x, w.z - t.z);
  // to its place on the ring the long way round, never across the middle
  const g = d < R * 2 ? ringGoal(w, t.x, t.z, R, a, 0.45, ring) : { x: t.x + Math.sin(a) * R, z: t.z + Math.cos(a) * R };
  const gd = len(g.x - w.x, g.z - w.z);
  steer(ctx, pk, w, g.x, g.z, gd > 25 ? WOLF_GALLOP * 0.7 : WOLF_TROT, 2.5);
  if (d < 12) growl(ctx, w, 6 + 4 * ctx.rand());
}

function feint(ctx: SimCtx, pk: Pack, w: WolfEnt, t: PlayerEnt | null): void {
  if (!alive(t) || safetyAt(t.x, t.z) >= SAFE || w.moodT > 8) {
    settle(ctx, w, pk);
    return;
  }
  const d = len(w.x - t.x, w.z - t.z);
  const R = circleR(pk.bold);
  if (wv(ctx, w.id, 'fo') === 0) {
    steer(ctx, pk, w, t.x, t.z, WOLF_GALLOP * 0.75, 1);
    if (d < FEINT_CLOSE) {
      setWv(ctx, w.id, 'fo', 1);
      emitAt(ctx, ctx.rand() < 0.5 ? 'bark' : 'growl', w);
    }
    return;
  }
  const k = R / Math.max(d, 1e-3);
  steer(ctx, pk, w, t.x + (w.x - t.x) * k, t.z + (w.z - t.z) * k, WOLF_GALLOP * 0.6, 2);
  if (d > R - 2) {
    // nobody answered it (a shot, a flare, a blow, the beam): the pack grows bolder
    if (pk.sc < pk.fs) pk.pr = Math.max(pk.pr, Math.min(pressCap(t, pk), pk.pr + PRESS_FEINT));
    pk.nf++;
    setWv(ctx, w.id, 'cd', 4 + 2 * ctx.rand()); // another goes next time
    settle(ctx, w, pk);
  }
}

function charge(ctx: SimCtx, pk: Pack, w: WolfEnt, t: PlayerEnt | null): void {
  if (!alive(t) || t.swim) {
    settle(ctx, w, pk);
    return;
  }
  if (safetyAt(t.x, t.z) >= SAFE) {
    flee(ctx, w, t.x, t.z, 1.5);
    setWv(ctx, w.id, 'cd', 4);
    return;
  }
  const d = len(w.x - t.x, w.z - t.z);
  if (d <= BITE_RANGE && Math.abs(w.y - t.y) < 1.5) {
    setMood(w, 'bite');
    setWv(ctx, w.id, 'bt', 0);
    return;
  }
  if (w.moodT > 9) {
    setWv(ctx, w.id, 'cd', 3);
    settle(ctx, w, pk);
    return;
  }
  const lead = Math.min(0.6, d / WOLF_GALLOP);
  steer(ctx, pk, w, t.x + t.vx * lead, t.z + t.vz * lead, WOLF_GALLOP, 0.5);
}

/** Jaws close on `t`: health via vitals, a chance to knock them down, a shove. */
function doBite(ctx: SimCtx, w: WolfEnt, t: PlayerEnt): void {
  const down = t.life === 'downed';
  const dmg = (BITE_DAMAGE + 5 * ctx.rand()) * (w.alpha ? 1.3 : 1) * (down ? 0.6 : 1);
  ctx.emit({ t: 'bite', id: w.id, target: t.id });
  hurt(ctx, t, dmg, 'wolf');
  if (t.life !== 'alive' || t.health <= 0) return;
  const h = 1 - t.health / 100;
  if (ctx.rand() < KNOCK_BASE + KNOCK_HURT * h * h + (w.alpha ? 0.04 : 0)) {
    // knocked off their feet: the rest of their health goes and they are down (vitals)
    hurt(ctx, t, t.health, 'wolf');
    return;
  }
  const dx = t.x - w.x, dz = t.z - w.z, l = len(dx, dz) || 1;
  t.vx += (dx / l) * 1.5;
  t.vz += (dz / l) * 1.5;
}

function bite(ctx: SimCtx, pk: Pack, w: WolfEnt, t: PlayerEnt | null): void {
  if (!alive(t)) {
    settle(ctx, w, pk);
    return;
  }
  const d = len(w.x - t.x, w.z - t.z);
  if (wv(ctx, w.id, 'bt') === 0 && w.moodT >= BITE_LAND) {
    setWv(ctx, w.id, 'bt', 1);
    if (d <= BITE_RANGE + 0.6) doBite(ctx, w, t);
  }
  if (w.moodT < BITE_TIME) {
    if (d > BITE_RANGE + 0.6) {
      // they got away from the jaws: after them
      steer(ctx, pk, w, t.x, t.z, Math.min(WOLF_GALLOP, len(t.vx, t.vz) + 3), 0.6);
      return;
    }
    // the lunge ends at the body: latched on a jaw's length from it, moving with it, facing it
    const dt = ctx.dt;
    const k = d > 1e-3 ? Math.min(1, LATCH / d) : 0;
    const cx = t.x + (w.x - t.x) * k, cz = t.z + (w.z - t.z) * k;
    w.vx = t.vx;
    w.vz = t.vz;
    w.speed = len(t.vx, t.vz);
    place(ctx, pk, w, cx + t.vx * dt, cz + t.vz * dt);
    const dyaw = wrapAngle(Math.atan2(-(t.x - w.x), -(t.z - w.z)) - w.yaw);
    const m = turnRate(0) * dt;
    w.yaw = wrapAngle(w.yaw + clamp(dyaw, -m, m));
    return;
  }
  setWv(ctx, w.id, 'bt', 0);
  setWv(ctx, w.id, 'cd', 4 + 3 * ctx.rand());
  if (t.life === 'downed' && !dragging(pk, t.id)) {
    setMood(w, 'drag');
    w.target = t.id;
    growl(ctx, w, 4);
    return;
  }
  // break off and come round again
  flee(ctx, w, t.x, t.z, 2.2 + 0.8 * ctx.rand());
}

/** Pull a downed player away from help and light, toward home; a bite now and then. */
function drag(ctx: SimCtx, pk: Pack, w: WolfEnt, t: PlayerEnt | null): void {
  if (!t || t.life !== 'downed' || t.swim || w.moodT > DRAG_MAX) {
    setWv(ctx, w.id, 'bt', 0);
    settle(ctx, w, pk);
    return;
  }
  const dt = ctx.dt;
  let ax = 0, az = 0;
  for (const q of ctx.players()) {
    if (q === t || q.life !== 'alive') continue;
    const qx = w.x - q.x, qz = w.z - q.z, qd = len(qx, qz);
    if (qd < 40 && qd > 1e-3) {
      ax += qx / qd / (qd + 1);
      az += qz / qd / (qd + 1);
    }
  }
  for (let i = 0; i < nSrc; i++) {
    const c = srcs[i];
    const qx = w.x - c.x, qz = w.z - c.z, qd = len(qx, qz);
    if (qd < c.r + 15 && qd > 1e-3) {
      ax += (qx / qd / (qd + 1)) * 2;
      az += (qz / qd / (qd + 1)) * 2;
    }
  }
  if (len(ax, az) < 0.005) {
    ax = pk.hx - w.x;
    az = pk.hz - w.z;
  }
  const l = len(ax, az) || 1;
  let dx = ax / l, dz = az / l;
  // the jaws: a bite every few seconds
  const bt = wv(ctx, w.id, 'bt') + dt;
  if (bt >= DRAG_BITE) {
    setWv(ctx, w.id, 'bt', 1e-6);
    doBite(ctx, w, t);
    if (t.life !== 'downed') {
      settle(ctx, w, pk);
      return;
    }
  } else setWv(ctx, w.id, 'bt', bt);
  // walk backward, the body in the jaws
  let moved = false;
  const side = w.id & 1 ? 1 : -1;
  for (let i = -1; i < 4 && !moved; i++) {
    const a = i < 0 ? 0 : DODGE[i] * side;
    const ca = Math.cos(a), sa = Math.sin(a);
    const rx = dx * ca + dz * sa, rz = dz * ca - dx * sa;
    const nx = w.x + rx * DRAG_SPEED * dt, nz = w.z + rz * DRAG_SPEED * dt;
    const bx = nx - rx * DRAG_HOLD, bz = nz - rz * DRAG_HOLD;
    if (!passable(ctx, nx, nz) || !passable(ctx, bx, bz)) continue;
    w.x = nx;
    w.z = nz;
    w.y = groundY(ctx, nx, nz, w.y);
    w.vx = rx * DRAG_SPEED;
    w.vz = rz * DRAG_SPEED;
    w.speed = DRAG_SPEED;
    t.x = bx;
    t.z = bz;
    t.y = groundY(ctx, bx, bz, t.y);
    t.vx = 0;
    t.vz = 0;
    dx = rx;
    dz = rz;
    moved = true;
  }
  if (!moved) {
    w.vx = w.vz = 0;
    w.speed = 0;
  }
  // facing the body
  const dyaw = wrapAngle(Math.atan2(dx, dz) - w.yaw);
  const m = turnRate(DRAG_SPEED) * dt;
  w.yaw = wrapAngle(w.yaw + clamp(dyaw, -m, m));
}

function roam(ctx: SimCtx, pk: Pack, w: WolfEnt, slot: number): void {
  const a = pk.alpha!;
  if (pk.ph === PHASE.gather) {
    // come together round the alpha
    if (w === a) {
      hold(ctx, pk, w, w.x - Math.sin(w.yaw), w.z - Math.cos(w.yaw));
      return;
    }
    const ang = (slot / Math.max(1, pk.wolves.length - 1)) * TAU;
    const gx = a.x + Math.sin(ang) * 2.5, gz = a.z + Math.cos(ang) * 2.5;
    const gd = len(gx - w.x, gz - w.z);
    steer(ctx, pk, w, gx, gz, gd > 20 ? WOLF_GALLOP * 0.6 : WOLF_TROT, 2);
    if (gd < 1.2) hold(ctx, pk, w, a.x, a.z);
    return;
  }
  if (w === a) {
    const d = len(pk.wx - w.x, pk.wz - w.z);
    if (d < 6 || ctx.state.env.t - pk.wt > WAYPOINT_TIME) newWaypoint(ctx, pk);
    const hungry = w.hunger > 0.7;
    steer(ctx, pk, w, pk.wx, pk.wz, d > 80 || hungry ? WOLF_TROT : WOLF_WALK, 3);
    return;
  }
  // a loose file behind the alpha
  const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
  const back = 2.2 + 1.8 * slot, lat = (slot % 2 ? 1 : -1) * 1.1;
  const gx = a.x - fx * back - fz * lat, gz = a.z - fz * back + fx * lat;
  const gd = len(gx - w.x, gz - w.z);
  steer(ctx, pk, w, gx, gz, gd > 25 ? WOLF_GALLOP * 0.6 : gd > 4 ? WOLF_TROT : Math.max(WOLF_WALK, a.speed), 2.5);
}

function rest(ctx: SimCtx, pk: Pack, w: WolfEnt, slot: number): void {
  const ang = (slot / Math.max(1, pk.wolves.length)) * TAU + 0.6;
  const gx = pk.hx + Math.sin(ang) * 2.2, gz = pk.hz + Math.cos(ang) * 2.2;
  const gd = len(gx - w.x, gz - w.z);
  if (gd > 1.5) steer(ctx, pk, w, gx, gz, gd > 30 ? WOLF_TROT : WOLF_WALK, 2);
  else hold(ctx, pk, w, pk.hx, pk.hz);
}

function feed(ctx: SimCtx, pk: Pack, w: WolfEnt, slot: number): void {
  const body = pk.tg ? ctx.get<PlayerEnt>(pk.tg) : undefined;
  if (!body || body.kind !== 'player') {
    hold(ctx, pk, w, w.x, w.z);
    return;
  }
  const ang = (slot / Math.max(1, pk.wolves.length)) * TAU;
  const gx = body.x + Math.sin(ang) * 1.3, gz = body.z + Math.cos(ang) * 1.3;
  const gd = len(gx - w.x, gz - w.z);
  if (gd > 0.6) steer(ctx, pk, w, gx, gz, gd > 15 ? WOLF_TROT : WOLF_WALK, 1.5);
  else hold(ctx, pk, w, body.x, body.z);
  for (const q of ctx.players()) {
    if (q.life === 'alive' && len(q.x - w.x, q.z - w.z) < 12) growl(ctx, w, 5 + 3 * ctx.rand());
  }
}

function fleeTick(ctx: SimCtx, pk: Pack, w: WolfEnt): void {
  let fx: number, fz: number;
  let ft = wv(ctx, w.id, 'ft');
  if (ft > 0) {
    fx = wv(ctx, w.id, 'fx');
    fz = wv(ctx, w.id, 'fz');
    ft -= ctx.dt;
    if (ft <= 0) {
      settle(ctx, w, pk);
      return;
    }
    setWv(ctx, w.id, 'ft', ft);
  } else if (pk.ph === PHASE.scatter) {
    fx = pk.sx;
    fz = pk.sz;
  } else {
    settle(ctx, w, pk);
    return;
  }
  const dx = w.x - fx, dz = w.z - fz;
  const d = len(dx, dz) || 1;
  if (ft <= 0 && d > 140) {
    // far enough: stand and watch where it came from
    hold(ctx, pk, w, fx, fz);
    return;
  }
  steer(ctx, pk, w, w.x + (dx / d) * 25, w.z + (dz / d) * 25, w.moodT < 4 ? WOLF_GALLOP : WOLF_TROT, 1);
}

/** A flashlight beam on the wolf's face: it hesitates. */
function beamCheck(ctx: SimCtx, pk: Pack, w: WolfEnt): void {
  if (wv(ctx, w.id, 'hz') > 0) return;
  const m = w.mood;
  if (m !== 'charge' && m !== 'stalk' && m !== 'circle' && m !== 'feint' && m !== 'roam') return;
  const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
  const hx = w.x + fx * WOLF_HEAD.fwd, hy = w.y + WOLF_HEAD.y, hz = w.z + fz * WOLF_HEAD.fwd;
  for (let i = 0; i < nBeam; i++) {
    const b = beams[i];
    const dx = hx - b.ex, dy = hy - b.ey, dz = hz - b.ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > b.range || d < 0.3) continue;
    if ((dx * b.dx + dy * b.dy + dz * b.dz) / d < b.cos) continue;
    // in the face: the wolf must be looking back along the beam
    if ((fx * dx + fz * dz) / Math.max(1e-3, len(dx, dz)) > -0.2) continue;
    if (!ctx.world.lineClear(b.ex, b.ey, b.ez, hx, hy, hz)) continue;
    pk.sc = ctx.state.env.t;
    if (m === 'charge') {
      if (ctx.rand() < 0.7 * b.level * (1.15 - pk.bold)) {
        cower(ctx, w, 0.8 + 0.5 * ctx.rand(), b.ex, b.ez, 1.6);
        setWv(ctx, w.id, 'hz', 4);
        pk.pr = Math.max(0, pk.pr - 0.06);
      } else setWv(ctx, w.id, 'hz', 1);
    } else {
      cower(ctx, w, 0.6 + 0.4 * ctx.rand(), b.ex, b.ez, 1);
      setWv(ctx, w.id, 'hz', 5);
      pk.pr = Math.max(0, pk.pr - 0.02);
    }
    return;
  }
}

function wolfTick(ctx: SimCtx, pk: Pack, w: WolfEnt, slot: number): void {
  const dt = ctx.dt;
  w.moodT += dt;
  w.hunger = Math.min(1, w.hunger + HUNGER_RATE * dt);
  w.fear = Math.max(0, Math.max(w.fear - dt / 25, pk.fear * 0.8));
  const vars = ctx.state.vars, k = wkeys(w.id);
  // timers
  for (const f of COUNTDOWNS) {
    const v = vars[k[f]];
    if (v !== undefined) {
      if (v - dt <= 0) delete vars[k[f]];
      else vars[k[f]] = v - dt;
    }
  }
  if (nBeam > 0 && (ctx.state.tick + w.id) % 3 === 0) beamCheck(ctx, pk, w);
  const t = w.target ? ctx.get<PlayerEnt>(w.target) ?? null : null;
  const tp = t && t.kind === 'player' ? t : null;
  const target = pk.target;
  switch (w.mood) {
    case 'cower': {
      hold(ctx, pk, w, wv(ctx, w.id, 'fx'), wv(ctx, w.id, 'fz'));
      if (w.moodT >= wv(ctx, w.id, 'stun')) {
        const after = wv(ctx, w.id, 'ft');
        setWv(ctx, w.id, 'stun', 0);
        if (after > 0) flee(ctx, w, wv(ctx, w.id, 'fx'), wv(ctx, w.id, 'fz'), after);
        else settle(ctx, w, pk);
      }
      return;
    }
    case 'flee':
      fleeTick(ctx, pk, w);
      return;
    case 'howl':
      hold(ctx, pk, w, w.x - Math.sin(w.yaw), w.z - Math.cos(w.yaw));
      if (w.moodT >= HOWL_TIME) settle(ctx, w, pk);
      return;
    case 'feint':
      feint(ctx, pk, w, tp);
      return;
    case 'charge':
      charge(ctx, pk, w, tp);
      return;
    case 'bite':
      bite(ctx, pk, w, tp);
      return;
    case 'drag':
      drag(ctx, pk, w, tp);
      return;
    default:
      break;
  }
  // the pack's phase: the gathering howl, one wolf after another
  if (pk.ph === PHASE.gather) {
    const at = w === pk.alpha ? 0 : 0.6 + 0.45 * slot;
    if (pk.pt >= at && pk.pt - dt < at) {
      howl(ctx, w);
      return;
    }
  }
  const mood = PHASE_MOOD[pk.ph];
  if (w.mood !== mood) setMood(w, mood);
  const hunting = pk.ph >= PHASE.stalk && pk.ph <= PHASE.attack;
  w.target = hunting ? pk.tg : 0;
  switch (mood) {
    case 'rest':
      rest(ctx, pk, w, slot);
      break;
    case 'roam':
      roam(ctx, pk, w, slot);
      break;
    case 'stalk':
      if (alive(target)) stalk(ctx, pk, w, slot, target);
      else hold(ctx, pk, w, w.x, w.z);
      break;
    case 'circle':
      if (alive(target)) circle(ctx, pk, w, slot, pk.wolves.length, target);
      else hold(ctx, pk, w, w.x, w.z);
      break;
    case 'feed':
      feed(ctx, pk, w, slot);
      break;
    case 'flee':
      fleeTick(ctx, pk, w);
      break;
    default:
      hold(ctx, pk, w, w.x, w.z);
  }
}

/** Per tick, before the wolves move: timers, the target, the orbit, howls owed, and (twice a second) the brain. */
function packTick(ctx: SimCtx, pk: Pack): void {
  const env = ctx.state.env;
  const dt = ctx.dt;
  pk.pt += dt;
  pk.fear = Math.max(0, pk.fear - FEAR_DECAY * dt);
  if (pk.st > 0) pk.st = Math.max(0, pk.st - dt);
  if (pk.fe > 0) pk.fe -= dt;
  pk.night = nightAt(env.clock);
  pk.white = smoothstep(0.55, 0.95, env.storm);
  pk.sight = Math.min(env.visibility * 0.9, 170 - 140 * pk.night + 25 * env.aurora * pk.night);
  const tg = pk.tg ? ctx.get<PlayerEnt>(pk.tg) : undefined;
  pk.target = tg && tg.kind === 'player' ? tg : null;
  // unopposed, the pack grows bolder by the minute, the more so at a lone or hurt target
  if (pk.ph === PHASE.stalk || pk.ph === PHASE.circle) {
    if (env.t - pk.sc > 10) pk.pr = Math.max(0, Math.min(pressCap(pk.target, pk), pk.pr + (pk.ph === PHASE.circle ? PRESS_CIRCLE : PRESS_STALK) * dt));
    if (pk.target) pk.oa += pk.ph === PHASE.circle ? (pk.or * WOLF_TROT * 0.55 * dt) / circleR(pk.bold) : 0;
  } else if (pk.ph === PHASE.attack && pk.target) pk.oa += (pk.or * WOLF_TROT * 0.55 * dt) / circleR(pk.bold);
  else if (pk.ph === PHASE.roam || pk.ph === PHASE.rest) pk.pr *= Math.exp(-dt / 60);
  // a pack just woken (or rallied) opens with the gathering howl
  if (pk.ph === PHASE.gather && pk.hw <= -1e8 && pk.alpha) startGather(ctx, pk);
  if (pk.ans >= 0 && env.t >= pk.ans && pk.alpha) {
    pk.ans = -1;
    pk.hw = env.t;
    if (!busy(ctx, pk.alpha) && pk.ph !== PHASE.scatter) howl(ctx, pk.alpha);
  }
  // a downed target that died: the pack feeds
  if (pk.target && pk.target.life === 'dead' && pk.ph >= PHASE.stalk && pk.ph <= PHASE.attack) {
    for (const w of pk.wolves) if (w.mood === 'drag' || w.mood === 'bite' || w.mood === 'charge' || w.mood === 'feint') settle(ctx, w, pk);
    enterPhase(ctx, pk, PHASE.feed);
  }
  if (pk.think) think(ctx, pk);
  pk.oa = wrapAngle(pk.oa);
}

// ---------------------------------------------------------------------------------------------
// What other systems call
// ---------------------------------------------------------------------------------------------

const segOut = { t: Infinity, head: false };
/**
 * First hit of a ray (unit direction) on a living wolf's body or head within maxT, or Infinity.
 * `out.head` says whether the head took it. The body is a capsule along the facing, the head a ball.
 */
export function wolfRayHit(w: WolfEnt, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out = segOut): number {
  out.t = Infinity;
  out.head = false;
  if (w.mood === 'dead') return Infinity;
  const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
  // head
  const hx = w.x + fx * WOLF_HEAD.fwd - ox, hy = w.y + WOLF_HEAD.y - oy, hz = w.z + fz * WOLF_HEAD.fwd - oz;
  const ht = hx * dx + hy * dy + hz * dz;
  if (ht > 0 && ht < maxT + WOLF_HEAD.r) {
    const q2 = hx * hx + hy * hy + hz * hz - ht * ht;
    const r2 = WOLF_HEAD.r * WOLF_HEAD.r;
    if (q2 < r2) {
      const t = ht - Math.sqrt(r2 - q2);
      if (t >= 0 && t <= maxT) {
        out.t = t;
        out.head = true;
      }
    }
  }
  // body: closest approach between the ray and the spine segment
  const ax = w.x + fx * WOLF_BODY.half, ay = w.y + WOLF_BODY.y, az = w.z + fz * WOLF_BODY.half;
  const ux = -2 * fx * WOLF_BODY.half, uz = -2 * fz * WOLF_BODY.half; // a -> b along the spine (uy = 0)
  const wx = ox - ax, wy = oy - ay, wz = oz - az;
  const b = dx * ux + dz * uz, c = ux * ux + uz * uz, d0 = dx * wx + dy * wy + dz * wz, e = ux * wx + uz * wz;
  const den = c - b * b;
  let s = den > 1e-9 ? (e - b * d0) / den : 0;
  s = clamp(s, 0, 1);
  // ray parameter closest to that spine point
  const px = ax + ux * s, py = ay, pz = az + uz * s;
  let t = (px - ox) * dx + (py - oy) * dy + (pz - oz) * dz;
  if (t < 0) t = 0;
  const qx = ox + dx * t - px, qy = oy + dy * t - py, qz = oz + dz * t - pz;
  const q2 = qx * qx + qy * qy + qz * qz;
  const r2 = WOLF_BODY.r * WOLF_BODY.r;
  if (q2 < r2) {
    const tb = Math.max(0, t - Math.sqrt(r2 - q2));
    if (tb <= maxT && tb < out.t) {
      out.t = tb;
      out.head = false;
    }
  }
  return out.t;
}

/** Distance on the ground from a point to a wolf's body (its spine less the body radius), and the nearest spine point. */
export const bodyNear = { d: 0, x: 0, z: 0 };
export function wolfBodyNear(w: WolfEnt, px: number, pz: number): typeof bodyNear {
  const fx = -Math.sin(w.yaw), fz = -Math.cos(w.yaw);
  const h = WOLF_BODY.half + 0.25; // the head and chest count
  const s = clamp((px - w.x) * fx + (pz - w.z) * fz, -WOLF_BODY.half, h);
  bodyNear.x = w.x + fx * s;
  bodyNear.z = w.z + fz * s;
  bodyNear.d = len(px - bodyNear.x, pz - bodyNear.z) - WOLF_BODY.r;
  return bodyNear;
}

/** Pack vars written from outside the tick (shots, blows, tools). */
function pset(ctx: SimCtx, k: number, f: PField, v: number): void {
  ctx.state.vars[pkeys(k)[f]] = v;
}
function pget(ctx: SimCtx, k: number, f: PField): number {
  return ctx.state.vars[pkeys(k)[f]] ?? PDEF[f];
}

/** Every wolf of pack `k` runs from (x, z) for at least `secs` seconds; the pack is afraid. */
function scatterPack(ctx: SimCtx, k: number, x: number, z: number, secs: number, fear: number): void {
  if (ctx.state.vars[pkeys(k).ph] === undefined) {
    // a pack nobody set up yet: give it a home where it is first
    let cx = 0, cz = 0, n = 0;
    for (const w of ctx.all('wolf')) {
      if (w.pack !== k || w.mood === 'dead') continue;
      cx += w.x;
      cz += w.z;
      n++;
    }
    if (n === 0) return;
    for (const f of PF) pset(ctx, k, f, PDEF[f]);
    pset(ctx, k, 'hx', cx / n);
    pset(ctx, k, 'hz', cz / n);
  }
  pset(ctx, k, 'ph', PHASE.scatter);
  pset(ctx, k, 'pt', 0);
  pset(ctx, k, 'st', Math.max(pget(ctx, k, 'st'), secs));
  pset(ctx, k, 'sx', x);
  pset(ctx, k, 'sz', z);
  pset(ctx, k, 'fear', Math.min(1, pget(ctx, k, 'fear') + fear));
  pset(ctx, k, 'pr', 0);
  pset(ctx, k, 'sc', ctx.state.env.t);
  for (const w of ctx.all('wolf')) {
    if (w.pack !== k || w.mood === 'dead') continue;
    setWv(ctx, w.id, 'ft', 0);
    setWv(ctx, w.id, 'stun', 0);
    setWv(ctx, w.id, 'fo', 0);
    setWv(ctx, w.id, 'bt', 0);
    w.mood = 'flee';
    w.moodT = 0;
  }
}

/**
 * A loud noise at (x, z): a rifle shot scatters every pack with a wolf within SHOT_HEAR (longer the
 * closer it was); the flare gun's bang startles those within FLARE_HEAR.
 */
export function hearNoise(ctx: SimCtx, x: number, z: number, kind: 'rifle' | 'flare'): void {
  const R = kind === 'rifle' ? SHOT_HEAR : FLARE_HEAR;
  const near = new Map<number, number>();
  for (const w of ctx.all('wolf')) {
    if (w.mood === 'dead') continue;
    const d = len(w.x - x, w.z - z);
    if (d > R) continue;
    const o = near.get(w.pack);
    if (o === undefined || d < o) near.set(w.pack, d);
  }
  for (const [k, d] of near) {
    const f = sat(d / R);
    if (kind === 'rifle') scatterPack(ctx, k, x, z, SCATTER_SHOT * (1.15 - 0.6 * f), 0.45 * (1 - 0.5 * f));
    else scatterPack(ctx, k, x, z, SCATTER_FLARE, 0.2);
  }
}

/**
 * Hurt a wolf (axe or rifle). It yelps and, from an axe, staggers back and runs; a wounded wolf runs
 * further. At 0 it dies ('wolfDie'), and its pack scatters for longer. Returns true if it died.
 */
export function damageWolf(ctx: SimCtx, w: WolfEnt, amount: number, by: PlayerEnt | null, how: 'axe' | 'rifle'): boolean {
  if (w.mood === 'dead' || amount <= 0) return false;
  w.health = Math.max(0, w.health - amount);
  const sx = by ? by.x : w.x, sz = by ? by.z : w.z;
  pset(ctx, w.pack, 'sc', ctx.state.env.t);
  pset(ctx, w.pack, 'pr', 0);
  if (w.health <= 0) {
    killWolf(ctx, w, by, sx, sz);
    return true;
  }
  ctx.emit({ t: 'yelp', id: w.id, x: w.x, y: w.y, z: w.z });
  w.fear = Math.min(1, w.fear + 0.6);
  pset(ctx, w.pack, 'fear', Math.min(1, pget(ctx, w.pack, 'fear') + (how === 'axe' ? 0.15 : 0.35)));
  if (how === 'axe') {
    // staggered: knocked back a step, a moment, then away
    const dx = w.x - sx, dz = w.z - sz, d = len(dx, dz) || 1;
    w.vx = (dx / d) * 4.5;
    w.vz = (dz / d) * 4.5;
    w.speed = 4.5;
    cower(ctx, w, 0.45, sx, sz, 2.2 + ctx.rand());
    setWv(ctx, w.id, 'cd', 5);
  } else {
    flee(ctx, w, sx, sz, 8 + 4 * ctx.rand());
    setWv(ctx, w.id, 'cd', 12);
  }
  return false;
}

function killWolf(ctx: SimCtx, w: WolfEnt, by: PlayerEnt | null, sx: number, sz: number): void {
  w.mood = 'dead';
  w.moodT = 0;
  w.speed = 0;
  w.vx = 0;
  w.vz = 0;
  w.target = 0;
  w.health = 0;
  clearWolfVars(ctx, w.id);
  ctx.emit({ t: 'wolfDie', id: w.id, x: w.x, y: w.y, z: w.z });
  ctx.state.stats.wolvesKilled++;
  if (by) by.kills++;
  let left = 0;
  for (const o of ctx.all('wolf')) if (o.pack === w.pack && o.mood !== 'dead') left++;
  if (left === 0) clearPackVars(ctx, w.pack);
  else scatterPack(ctx, w.pack, sx, sz, SCATTER_KILL, 0.8);
}

/**
 * Wake every pack still asleep and set them all on the players nearest (x, z): for the story's
 * last stand (the hold-out). Each pack gathers with a howl, then stalks.
 */
export function rallyWolves(ctx: SimCtx, x: number, z: number): void {
  const defs = ctx.world.spawn.packs;
  for (let k = 0; k < defs.length; k++) {
    if (ctx.state.vars[pkeys(k).aw] === undefined) spawnPack(ctx, k, defs[k].x, defs[k].z, defs[k].range, packSize(ctx, defs[k].count), true);
  }
  let best: PlayerEnt | null = null;
  let bd = Infinity;
  for (const p of ctx.players()) {
    if (!alive(p)) continue;
    const d = len(p.x - x, p.z - z);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  const seen = new Set<number>();
  for (const w of ctx.all('wolf')) {
    if (w.mood === 'dead') continue;
    w.hunger = Math.max(w.hunger, 0.8);
    if (seen.has(w.pack)) continue;
    seen.add(w.pack);
    if (ctx.state.vars[pkeys(w.pack).ph] === undefined) {
      for (const f of PF) pset(ctx, w.pack, f, PDEF[f]);
      pset(ctx, w.pack, 'hx', w.x);
      pset(ctx, w.pack, 'hz', w.z);
    }
    pset(ctx, w.pack, 'tg', best ? best.id : 0);
    pset(ctx, w.pack, 'ph', best ? PHASE.gather : PHASE.roam);
    pset(ctx, w.pack, 'pt', 0);
    pset(ctx, w.pack, 'st', 0);
    pset(ctx, w.pack, 'hw', -1e9);
    // the home range moves to the fight, so a pack that loses the trail comes back to it
    pset(ctx, w.pack, 'hx', x);
    pset(ctx, w.pack, 'hz', z);
    pset(ctx, w.pack, 'wx', x);
    pset(ctx, w.pack, 'wz', z);
    pset(ctx, w.pack, 'rg', 120);
  }
}

/** The pack phase of pack `k` (PHASE), or -1 if it is not out. For tools, tests and the story. */
export function packPhase(ctx: SimCtx, k: number): number {
  const v = ctx.state.vars[pkeys(k).ph];
  return v === undefined ? -1 : v;
}

/** The player pack `k` is after, or 0. */
export function packTarget(ctx: SimCtx, k: number): NetId {
  return ctx.state.vars[pkeys(k).tg] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

function group(ctx: SimCtx, list: readonly WolfEnt[]): void {
  active.length = 0;
  byK.clear();
  deadList.length = 0;
  let used = 0;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (w.mood === 'dead') {
      deadList.push(w);
      continue;
    }
    let pk = byK.get(w.pack);
    if (!pk) {
      pk = packPool[used] ?? (packPool[used] = newPack());
      used++;
      pk.k = w.pack;
      pk.wolves.length = 0;
      pk.alpha = null;
      pk.target = null;
      byK.set(w.pack, pk);
      active.push(pk);
    }
    pk.wolves.push(w);
  }
  active.sort((a, b) => a.k - b.k);
  for (const pk of active) {
    // one living alpha: the marked one, else the strongest steps up
    let alpha: WolfEnt | null = null;
    for (const w of pk.wolves) {
      if (!w.alpha) continue;
      if (!alpha) alpha = w;
      else w.alpha = false;
    }
    if (!alpha) {
      for (const w of pk.wolves) if (!alpha || w.health > alpha.health) alpha = w;
      alpha!.alpha = true;
    }
    pk.alpha = alpha;
  }
}

/**
 * A pack at rest, roaming or feeding farther than FAR from everyone lies still (nobody can see or hear
 * it; it costs nothing). It keeps getting hungry; it wakes the moment someone comes within FAR.
 */
function idleFar(ctx: SimCtx, pk: Pack): boolean {
  if (pk.ph !== PHASE.rest && pk.ph !== PHASE.roam && pk.ph !== PHASE.feed) return false;
  const a = pk.alpha;
  if (!a) return false;
  for (const p of ctx.players()) if (alive(p) && len(p.x - a.x, p.z - a.z) < FAR) return false;
  const dt = ctx.dt;
  for (const w of pk.wolves) {
    w.moodT += dt;
    w.hunger = Math.min(1, w.hunger + HUNGER_RATE * dt);
    w.speed = 0;
    w.vx = 0;
    w.vz = 0;
  }
  return true;
}

export const wolves: System = {
  name: 'wolves',

  step(ctx) {
    buildIce(ctx);
    wake(ctx);
    const list = ctx.all('wolf');
    if (list.length === 0) return;
    group(ctx, list);
    // with nobody alive on the mountain the wolves have nothing to do
    let anyone = false;
    for (const p of ctx.players()) if (alive(p)) anyone = true;
    if (anyone) {
      buildSources(ctx);
      const tick = ctx.state.tick;
      for (const pk of active) {
        loadPack(ctx, pk);
        pk.think = (tick + pk.k * 5) % THINK === 0;
      }
      for (const pk of active) {
        packTick(ctx, pk);
        const ws = pk.wolves;
        if (idleFar(ctx, pk)) continue;
        const ai = pk.alpha ? ws.indexOf(pk.alpha) : -1;
        for (let i = 0; i < ws.length; i++) {
          // the alpha leads (slot 0); the others take the slots after it in entity order
          const w = ws[i];
          wolfTick(ctx, pk, w, i === ai ? 0 : i < ai ? i + 1 : i);
        }
      }
      for (const pk of active) savePack(ctx, pk);
    }
    // the dead lie a while
    for (const w of deadList) {
      w.moodT += ctx.dt;
      w.speed = 0;
      if (w.moodT >= DEAD_STAY) {
        clearWolfVars(ctx, w.id);
        wolfKeyCache.delete(w.id);
        ctx.remove(w.id);
      }
    }
  },

  action(ctx, p, a) {
    if (a.t !== 'debug' || !ctx.debug) return false;
    const arg = a.args ?? [];
    switch (a.cmd) {
      case 'wolves': {
        // a pack at (x, z) (default: 60 m in front of the player), n wolves, awake and gathering
        const x = Number.isFinite(arg[0]) ? arg[0] : p.x - Math.sin(p.yaw) * 60;
        const z = Number.isFinite(arg[1]) ? arg[1] : p.z - Math.cos(p.yaw) * 60;
        const n = Number.isFinite(arg[2]) ? clamp(Math.floor(arg[2]), 1, 8) : 4;
        const k = Math.max(ctx.world.spawn.packs.length, ctx.v('wolves.next', ctx.world.spawn.packs.length));
        ctx.setV('wolves.next', k + 1);
        spawnPack(ctx, k, x, z, 150, n, true);
        return true;
      }
      case 'wolvesWake': {
        const defs = ctx.world.spawn.packs;
        for (let k = 0; k < defs.length; k++) {
          if (ctx.state.vars[pkeys(k).aw] === undefined) spawnPack(ctx, k, defs[k].x, defs[k].z, defs[k].range, packSize(ctx, defs[k].count), true);
        }
        return true;
      }
      case 'wolvesRally':
        rallyWolves(ctx, Number.isFinite(arg[0]) ? arg[0] : p.x, Number.isFinite(arg[1]) ? arg[1] : p.z);
        return true;
      case 'wolvesClear': {
        for (const w of ctx.all('wolf')) ctx.remove(w.id);
        for (const key of Object.keys(ctx.state.vars)) if (key.startsWith('wolves.') && !key.startsWith('wolves.aw.')) delete ctx.state.vars[key];
        wolfKeyCache.clear();
        return true;
      }
      default:
        return false;
    }
  },

  leave(ctx, p) {
    // nobody hunts, drags or feeds on someone who has gone
    for (const w of ctx.all('wolf')) {
      if (w.target !== p.id) continue;
      w.target = 0;
      if (w.mood !== 'dead') setMood(w, 'roam');
      setWv(ctx, w.id, 'fo', 0);
      setWv(ctx, w.id, 'bt', 0);
    }
    for (const key of Object.keys(ctx.state.vars)) {
      if (key.startsWith('wolves.tg.') && ctx.state.vars[key] === p.id) {
        const k = Number(key.slice('wolves.tg.'.length));
        ctx.state.vars[key] = 0;
        const ph = ctx.state.vars[pkeys(k).ph];
        if (ph !== undefined && ph !== PHASE.scatter) {
          ctx.state.vars[pkeys(k).ph] = PHASE.roam;
          ctx.state.vars[pkeys(k).pt] = 0;
        }
      }
    }
  },
};

/** For tests and tools: a human-readable phase name. */
export function phaseName(ph: number): string {
  for (const [k, v] of Object.entries(PHASE)) if (v === ph) return k;
  return ph < 0 ? 'none' : String(ph);
}
