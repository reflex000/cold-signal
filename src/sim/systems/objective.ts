// The way off the mountain: the stages from the crash to the rescue, the machines at the tower, the
// helicopter and the winch.
//
//   crash    out of the fuselage. The search begins once someone has the radio or a part, walks
//            WRECK_LEAVE metres off, or SEARCH_AFTER seconds pass.
//   search   find the five parts. A part counts as soon as anyone carries it (read from every pack
//            each tick, so a part handed over, dropped or carried by the dead is always right).
//   tower    all five found: take them up to the tower. Back to search if one is lost again.
//   power    someone is at the tower. Hold USE at the panel to fit each carried part (INSTALL_TIME);
//            with all five in, crank the generator (hold USE, or PRIMARY with bare hands): one person
//            charges it in about 40 s, two on the handles 1.8 times as fast; it runs down when nobody
//            cranks. At full charge the set keys and the call goes out over TX_TIME seconds while the
//            charge holds (TX_MIN); sending draws it down, so someone keeps cranking.
//   holdout  the call is out (event 'transmit'): the helicopter is HOLDOUT_ETA seconds away, the env
//            system forces the worst of the storm, and the last packs come (wolves read the stage).
//            HELI_LEAD seconds before it is due the helicopter appears to the south, inbound.
//   rescue   it is due. A flare burning on the ground within SIGNAL_RANGE of the deck marks it
//            (signalled); unmarked it circles, and after SEARCH_MAX seconds finds the tower lights. It
//            comes to a hover over the deck and lowers the winch: players in the winch circle go up one
//            at a time (humans first, the downed first), life 'rescued', and ride aboard.
//   won      every living person is aboard; the helicopter turns away and the ending plays.
//   lost     co-op only: every human player is dead at once. A lost game refuses 'respawn'.
//            Solo play never ends this way: a dead player keeps waking at the last fire they rested
//            at (vitals.ts), or by the wreck, and the clock and the storm keep running.
// Other devices answer USE here too: doors open and close, the cabin bunk is a place to rest (a
// checkpoint), the beacon on the mast lights by itself when the call goes out. Notes are story.ts.
// State: SimState.objective, the devices (panel progress = parts in, data = their bits; generator
// progress = charge; beacon on), the 'heli' entity, vars 'objective.*'.
// Owner: OBJECTIVE.
import { clamp, sat, smoothstep, TAU } from '../../core/math';
import type { World } from '../../world/types';
import type { SimCtx, System } from '../api';
import { makeHeli } from '../entities';
import {
  BTN, type DeviceEnt, type HeliEnt, type ItemId, type NetId, type PartId, type PlayerEnt, type Stage,
} from '../types';
import { eyeHeight, focusOf, REACH, removeItem, toast } from './items';
import { CP } from './vitals';
import { rallyWolves } from './wolves';

export const PARTS: readonly PartId[] = ['battery', 'handset', 'coil', 'tube', 'fuse'];
export const PART_ITEM: Readonly<Record<PartId, ItemId>> = {
  battery: 'part_battery', handset: 'part_handset', coil: 'part_coil', tube: 'part_tube', fuse: 'part_fuse',
};
const PART_WORD: Readonly<Record<PartId, string>> = { battery: 'battery', handset: 'handset', coil: 'antenna coil', tube: 'valve', fuse: 'fuse' };
export const STAGES: readonly Stage[] = ['crash', 'search', 'tower', 'power', 'holdout', 'rescue', 'won', 'lost'];

// --- crash
export const SEARCH_AFTER = 240; // seconds
export const WRECK_LEAVE = 150; // metres from the wreck
// --- power
export const INSTALL_TIME = 2.5; // seconds of USE per part
export const CRANK_RATE = 1 / 30; // charge per second, one person on the crank
export const CRANK_PAIR = 1.8; // two people on the handles (more do not fit)
export const CHARGE_DECAY = 1 / 120; // per second with nobody cranking
export const TX_TIME = 60; // seconds of sending
export const TX_DRAIN = 1 / 50; // charge per second while sending
export const TX_MIN = 0.3; // the set drops out below this charge
export const GEN_ON = 0.25; // charge at which the generator catches ('generator' on) ...
export const GEN_OFF = 0.08; // ... and dies ('generator' off)
// --- the helicopter
export const HOLDOUT_ETA = 180;
export const HELI_LEAD = 60;
export const HELI_SPEED = 26; // m/s inbound
export const SIGNAL_RANGE = 14; // metres from the deck centre
export const SEARCH_MAX = 100;
export const SEARCH_RADIUS = 110;
export const HOVER_ALT = 18; // metres above the deck, standing off from the mast
export const WINCH_RANGE = 3.5; // the winch circle on the deck
export const WINCH_DOWN = 4; // seconds for the hook to come down ...
export const WINCH_UP = 6; // ... and to bring someone up
export const AWAY_TIME = 6; // seconds from the last one aboard to the ending
const HELI_ACCEL = 4.5; // m/s^2
const CLEARANCE = 38; // metres over the ground in flight
const ARRIVE = 200; // metres from the deck where it stops being inbound
// --- other devices
export const BED_TIME = 2; // seconds of USE on the bunk
export const BED_REPEAT = 60;
export const BED_CORE = 34;
const DOOR_SPEED = 1.25; // open amount per second

/**
 * Where each kind of device is aimed at, above its anchor, and how big it is (game/focus.ts picks
 * with the same table; items.ts AIM.device is the generic fallback).
 */
export const DEVICE_AIM: Readonly<Record<DeviceEnt['type'], { r: number; y: number }>> = {
  panel: { r: 0.45, y: 0.05 },
  generator: { r: 0.45, y: 0.05 },
  door: { r: 0.5, y: 1 },
  beacon: { r: 0.3, y: 0.3 },
  bed: { r: 0.6, y: 0.05 },
  note: { r: 0.3, y: 0.03 },
};
const REACH_SLACK = 0.5;

/** Can `p` reach device `d`: the eye within reach of its aim point and nothing solid in between. */
export function deviceReach(ctx: SimCtx, p: PlayerEnt, d: DeviceEnt, extra = 0): boolean {
  const sh = DEVICE_AIM[d.type] ?? DEVICE_AIM.panel;
  const ex = p.x, ey = p.y + eyeHeight(p), ez = p.z;
  const tx = d.x - ex, ty = d.y + sh.y - ey, tz = d.z - ez;
  const dist = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (dist > REACH + sh.r + REACH_SLACK + extra) return false;
  const k = dist > 1e-3 ? Math.max(0, dist - sh.r - 0.15) / dist : 0;
  return k <= 0 || ctx.world.lineClear(ex, ey, ez, ex + tx * k, ey + ty * k, ez + tz * k);
}

/** The device of a type (the world has one panel, one generator, one beacon). */
export function deviceOf(ctx: SimCtx, type: DeviceEnt['type']): DeviceEnt | undefined {
  for (const d of ctx.all('device')) if (d.type === type) return d;
  return undefined;
}

interface Pad { x: number; y: number; z: number; fx: number; fz: number }
const pads = new WeakMap<World, Pad>();
/**
 * The pickup deck in front of the mast: where the flare goes and the winch comes down. From the
 * world's anchors (src/world WorldEx 'tower:mast.deck'), else the tower itself. fx, fz: the deck's
 * front, away from the mast.
 */
export function padOf(world: World): Pad {
  let p = pads.get(world);
  if (!p) {
    const anchors = (world as { anchors?: Record<string, { x: number; y: number; z: number; yaw: number }> }).anchors;
    const a = anchors ? anchors['tower:mast.deck'] : undefined;
    if (a) p = { x: a.x, y: a.y, z: a.z, fx: Math.sin(a.yaw), fz: Math.cos(a.yaw) };
    else {
      const t = world.poi('tower');
      p = { x: t.x, y: t.y, z: t.z, fx: 0, fz: 1 };
    }
    pads.set(world, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Vars
// ---------------------------------------------------------------------------------------------
const V = {
  tx: 'objective.txOn', // 1 once the set has keyed (the generator reached full charge in 'power')
  heli: 'objective.heli', // id of the helicopter
  hook: 'objective.hook', // player on the winch line, 0 none
  hookT: 'objective.hookT', // seconds into the hook's run down or up
  hookUp: 'objective.hookUp', // 1 while bringing someone up
  hookX: 'objective.hookX', hookY: 'objective.hookY', hookZ: 'objective.hookZ', // where they were hooked
  hoverT: 'objective.hoverT', // seconds settled at the hover point
  awayT: 'objective.awayT',
  bedT: 'objective.bedT', // env.t of the last rest on the bunk
  rally: 'objective.rally', // how many times the packs have been sent at the tower (1 at the call, 2 with the rotors)
} as const;
interface Keys { install: string; crank: string; bed: string; said: string }
const keyCache = new Map<NetId, Keys>();
function keysOf(id: NetId): Keys {
  let k = keyCache.get(id);
  if (!k) keyCache.set(id, (k = { install: 'objective.install.' + id, crank: 'objective.crank.' + id, bed: 'objective.bed.' + id, said: 'objective.said.' + id }));
  return k;
}

// ---------------------------------------------------------------------------------------------
// Stages and parts
// ---------------------------------------------------------------------------------------------

function setStage(ctx: SimCtx, stage: Stage, text?: string): void {
  const o = ctx.state.objective;
  if (o.stage === stage) return;
  o.stage = stage;
  ctx.emit({ t: 'stage', stage });
  if (text) ctx.emit({ t: 'toast', to: 0, kind: 'objective', text });
}

const tell = (ctx: SimCtx, text: string): void => ctx.emit({ t: 'toast', to: 0, kind: 'objective', text });

/** Parts not yet installed are 'held' while anyone carries one, else 'lost'. */
function syncParts(ctx: SimCtx): void {
  const parts = ctx.state.objective.parts;
  const players = ctx.players();
  for (const part of PARTS) {
    if (parts[part] === 'installed') continue;
    const item = PART_ITEM[part];
    let by = 0;
    for (const p of players) {
      if ((p.inv[item] ?? 0) > 0) {
        by = p.id;
        break;
      }
    }
    if (by && parts[part] === 'lost') {
      parts[part] = 'held';
      ctx.emit({ t: 'partFound', by, part });
    } else if (!by && parts[part] === 'held') parts[part] = 'lost';
  }
}

export function partsIn(ctx: SimCtx): number {
  const parts = ctx.state.objective.parts;
  let n = 0;
  for (const part of PARTS) if (parts[part] === 'installed') n++;
  return n;
}

const allFound = (ctx: SimCtx): boolean => {
  const parts = ctx.state.objective.parts;
  for (const part of PARTS) if (parts[part] === 'lost') return false;
  return true;
};

function anyoneNear(ctx: SimCtx, x: number, z: number, r: number): boolean {
  for (const p of ctx.players()) if (p.life === 'alive' && Math.hypot(p.x - x, p.z - z) <= r) return true;
  return false;
}

function stages(ctx: SimCtx): void {
  const st = ctx.state, o = st.objective, w = ctx.world;
  switch (o.stage) {
    case 'crash': {
      let go = st.env.t >= SEARCH_AFTER || !allNone(ctx);
      const wreck = w.poi('wreck');
      for (const p of ctx.players()) {
        if ((p.inv.radio ?? 0) > 0 || (p.life === 'alive' && Math.hypot(p.x - wreck.x, p.z - wreck.z) > WRECK_LEAVE)) go = true;
      }
      if (go) setStage(ctx, 'search', 'The radio is dead. Its five parts are out on the mountain.');
      break;
    }
    case 'search':
      if (allFound(ctx)) setStage(ctx, 'tower', 'All five parts. Take them up to the signal tower.');
      break;
    case 'tower':
    case 'power': {
      if (!allFound(ctx)) {
        setStage(ctx, 'search');
        break;
      }
      if (o.stage === 'tower') {
        const t = w.poi('tower');
        if (anyoneNear(ctx, t.x, t.z, t.radius)) setStage(ctx, 'power', 'The tower. Fit the parts to the transmitter, then crank the generator.');
      }
      break;
    }
    default:
      break;
  }
}

/** No part has been found yet. */
function allNone(ctx: SimCtx): boolean {
  const parts = ctx.state.objective.parts;
  for (const part of PARTS) if (parts[part] !== 'lost') return false;
  return true;
}

/** Co-op only: every human player dead at once. */
function checkLost(ctx: SimCtx): void {
  let humans = 0, dead = 0;
  for (const p of ctx.players()) {
    if (p.bot) continue;
    humans++;
    if (p.life === 'dead') dead++;
  }
  if (humans >= 2 && dead === humans) setStage(ctx, 'lost', 'No one is left on the mountain.');
}

// ---------------------------------------------------------------------------------------------
// The panel, the generator, the call
// ---------------------------------------------------------------------------------------------

/** The device a player is working with USE: the one in focus, or the panel / crank right in front of them. */
function deviceFor(ctx: SimCtx, p: PlayerEnt, d: DeviceEnt | undefined): DeviceEnt | undefined {
  if (!d) return undefined;
  const f = focusOf(ctx, p, 'device');
  if (f) return f.id === d.id && deviceReach(ctx, p, d) ? d : undefined;
  if (ctx.input(p.id).focus !== 0) return undefined; // looking at something else
  return Math.hypot(d.x - p.x, d.z - p.z) <= 1.3 && Math.abs(d.y - p.y) < 2 && deviceReach(ctx, p, d) ? d : undefined;
}

function missingText(ctx: SimCtx): string {
  const parts = ctx.state.objective.parts;
  const left = PARTS.filter((q) => parts[q] !== 'installed').map((q) => 'the ' + PART_WORD[q]);
  if (left.length === 0) return 'All five parts are in.';
  const list = left.length === 1 ? left[0] : left.slice(0, -1).join(', ') + ' and ' + left[left.length - 1];
  return `Still missing: ${list}.`;
}

function syncPanel(ctx: SimCtx, panel: DeviceEnt | undefined): void {
  if (!panel) return;
  const parts = ctx.state.objective.parts;
  let bits = 0, n = 0;
  for (let k = 0; k < PARTS.length; k++) {
    if (parts[PARTS[k]] === 'installed') {
      bits |= 1 << k;
      n++;
    }
  }
  const on = !!ctx.v(V.tx);
  if (panel.data !== bits || panel.progress !== n / 5 || panel.on !== on) {
    panel.data = bits;
    panel.progress = n / 5;
    panel.on = on;
    ctx.touch(panel);
  }
}

/** Hold USE at the panel: one carried part per INSTALL_TIME, the next while the hold goes on. */
function installing(ctx: SimCtx, p: PlayerEnt, panel: DeviceEnt | undefined): void {
  const vars = ctx.state.vars, k = keysOf(p.id);
  const stage = ctx.state.objective.stage;
  const at = ctx.held(p.id, BTN.USE) && p.life === 'alive' && !p.swim ? deviceFor(ctx, p, panel) : undefined;
  const can = at !== undefined && (stage === 'search' || stage === 'tower' || stage === 'power');
  const carried = can ? PARTS.find((q) => (p.inv[PART_ITEM[q]] ?? 0) > 0) : undefined;
  if (at && ctx.pressed(p.id, BTN.USE) && !carried) toast(ctx, p, 'info', missingText(ctx));
  if (!carried || (p.act !== 'none' && vars[k.install] === undefined)) {
    if (vars[k.install] !== undefined) {
      delete vars[k.install];
      if (p.act === 'use') {
        p.act = 'none';
        p.actT = 0;
      }
    }
    return;
  }
  if (vars[k.install] === undefined) {
    vars[k.install] = at!.id;
    p.act = 'use';
    p.actT = 0;
  }
  p.actT += ctx.dt;
  if (p.actT < INSTALL_TIME) return;
  const parts = ctx.state.objective.parts;
  parts[carried] = 'installed'; // first, so taking it out of the pack does not mark it lost
  removeItem(ctx, p, PART_ITEM[carried], 1);
  ctx.emit({ t: 'partInstalled', by: p.id, part: carried });
  p.actT = 0;
  if (partsIn(ctx) === 5) tell(ctx, 'All five parts are in. Crank the generator.');
}

/** Hold USE (or PRIMARY with bare hands) at the crank. Returns true while this player is cranking. */
function cranking(ctx: SimCtx, p: PlayerEnt, gen: DeviceEnt | undefined): boolean {
  const vars = ctx.state.vars, k = keysOf(p.id);
  const use = ctx.held(p.id, BTN.USE), primary = ctx.held(p.id, BTN.PRIMARY) && p.held === 'hands';
  const at = (use || primary) && p.life === 'alive' && !p.swim && p.carry === 0 ? deviceFor(ctx, p, gen) : undefined;
  const ready = at !== undefined && partsIn(ctx) === 5;
  if (at && !ready && (ctx.pressed(p.id, BTN.USE) || (primary && ctx.pressed(p.id, BTN.PRIMARY)))) {
    toast(ctx, p, 'info', 'The crank turns, but there is nothing to power. ' + missingText(ctx));
  }
  if (!ready || (p.act !== 'none' && vars[k.crank] === undefined)) {
    if (vars[k.crank] !== undefined) {
      delete vars[k.crank];
      if (p.act === 'crank') {
        p.act = 'none';
        p.actT = 0;
      }
    }
    return false;
  }
  if (vars[k.crank] === undefined) {
    vars[k.crank] = 1;
    p.act = 'crank';
    p.actT = 0;
  }
  p.actT += ctx.dt;
  return true;
}

function power(ctx: SimCtx, gen: DeviceEnt | undefined, crankers: number): void {
  const st = ctx.state, o = st.objective, dt = ctx.dt;
  const sending = o.stage === 'power' && !!ctx.v(V.tx) && partsIn(ctx) === 5;
  let rate = crankers >= 2 ? CRANK_RATE * CRANK_PAIR : crankers === 1 ? CRANK_RATE : -CHARGE_DECAY;
  if (sending && o.generator >= TX_MIN) rate -= TX_DRAIN;
  o.generator = sat(o.generator + rate * dt);
  if (o.generator < 1e-6) o.generator = 0;
  // the set keys the first time the generator is full
  if (o.stage === 'power' && !ctx.v(V.tx) && partsIn(ctx) === 5 && o.generator >= 1) ctx.setV(V.tx, 1);
  if (gen) {
    // the device mirrors the charge (sent when it moves by a little) and whether it is running
    let on = gen.on;
    if (!on && o.generator >= GEN_ON) on = true;
    else if (on && o.generator < GEN_OFF) on = false;
    let dirty = false;
    if (on !== gen.on) {
      gen.on = on;
      ctx.emit({ t: 'generator', on });
      dirty = true;
    }
    const g = o.generator;
    if (Math.abs(gen.progress - g) >= 0.004 || ((g === 0 || g === 1) && gen.progress !== g)) {
      gen.progress = g;
      dirty = true;
    }
    if (dirty) ctx.touch(gen);
  }
  // the call
  if (sending && o.generator >= TX_MIN) {
    o.transmit = Math.min(1, o.transmit + dt / TX_TIME);
    if (o.transmit >= 1) {
      ctx.emit({ t: 'transmit' });
      o.eta = HOLDOUT_ETA;
      setStage(ctx, 'holdout', 'A helicopter is coming. Three minutes. Hold the tower.');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Other devices: doors and the bunk
// ---------------------------------------------------------------------------------------------

function doors(ctx: SimCtx): void {
  const dt = ctx.dt;
  for (const d of ctx.all('device')) {
    if (d.type !== 'door') continue;
    const target = d.on ? 1 : 0;
    if (d.progress !== target) {
      d.progress = d.on ? Math.min(1, d.progress + DOOR_SPEED * dt) : Math.max(0, d.progress - DOOR_SPEED * dt);
      ctx.touch(d);
    }
  }
}

function useDoor(ctx: SimCtx, p: PlayerEnt): void {
  if (!ctx.pressed(p.id, BTN.USE)) return;
  const d = focusOf(ctx, p, 'device');
  if (!d || d.type !== 'door' || !deviceReach(ctx, p, d)) return;
  d.on = !d.on;
  ctx.touch(d);
  ctx.emit({ t: 'door', id: d.id, open: d.on });
}

/** Hold USE on the bunk: rest a while, and wake here if the worst happens (the shared checkpoint). */
function rest(ctx: SimCtx, p: PlayerEnt): void {
  const vars = ctx.state.vars, k = keysOf(p.id);
  const d = ctx.held(p.id, BTN.USE) ? focusOf(ctx, p, 'device') : undefined;
  const ok = d !== undefined && d.type === 'bed' && p.carry === 0 && deviceReach(ctx, p, d);
  if (!ok || (p.act !== 'none' && vars[k.bed] === undefined)) {
    if (vars[k.bed] !== undefined) {
      delete vars[k.bed];
      if (p.act === 'use') {
        p.act = 'none';
        p.actT = 0;
      }
    }
    return;
  }
  if (vars[k.bed] === undefined) {
    const t = ctx.state.env.t, last = vars[V.bedT];
    if (p.core < BED_CORE) {
      if (ctx.pressed(p.id, BTN.USE)) toast(ctx, p, 'info', 'Too cold to rest. Get warm first.');
      return;
    }
    if (last !== undefined && t - last < BED_REPEAT) {
      if (ctx.pressed(p.id, BTN.USE)) toast(ctx, p, 'info', 'You have only just rested.');
      return;
    }
    vars[k.bed] = d!.id;
    p.act = 'use';
    p.actT = 0;
  }
  p.actT += ctx.dt;
  if (p.actT < BED_TIME) return;
  // the cabin floor beside the bunk (vitals finds a free spot round it when someone wakes)
  vars[CP.x] = d!.x;
  vars[CP.y] = d!.y - 0.5;
  vars[CP.z] = d!.z;
  vars[CP.fire] = -d!.id; // not a fire: never equal to one
  vars[CP.t] = ctx.state.env.t;
  vars[V.bedT] = ctx.state.env.t;
  delete vars[k.bed];
  p.act = 'none';
  p.actT = 0;
  ctx.emit({ t: 'checkpoint' });
  toast(ctx, p, 'info', 'You rest a while on the bunk.');
}

// ---------------------------------------------------------------------------------------------
// The helicopter
// ---------------------------------------------------------------------------------------------

function heliOf(ctx: SimCtx): HeliEnt | undefined {
  const id = ctx.v(V.heli);
  const h = id ? ctx.get<HeliEnt>(id) : undefined;
  return h && h.kind === 'heli' ? h : undefined;
}

function setPhase(ctx: SimCtx, h: HeliEnt, phase: HeliEnt['phase']): void {
  if (h.phase === phase) return;
  h.phase = phase;
  h.t = 0;
  ctx.emit({ t: 'heli', phase });
}

/** Steer toward a point: arrive slowing within `slow` metres, never faster than `max`, keep off the ground. */
function fly(ctx: SimCtx, h: HeliEnt, tx: number, ty: number, tz: number, max: number, slow: number): void {
  const dt = ctx.dt, w = ctx.world;
  const dx = tx - h.x, dy = ty - h.y, dz = tz - h.z;
  const d = Math.hypot(dx, dy, dz);
  const speed = max * Math.min(1, d / slow);
  let wx = 0, wy = 0, wz = 0;
  if (d > 1e-3) {
    wx = (dx / d) * speed;
    wy = (dy / d) * speed;
    wz = (dz / d) * speed;
  }
  const ax = wx - h.vx, ay = wy - h.vy, az = wz - h.vz;
  const a = Math.hypot(ax, ay, az);
  const k = a > HELI_ACCEL * dt ? (HELI_ACCEL * dt) / a : 1;
  h.vx += ax * k;
  h.vy += ay * k;
  h.vz += az * k;
  h.x += h.vx * dt;
  h.y += h.vy * dt;
  h.z += h.vz * dt;
  // never into the mountain: in flight it keeps CLEARANCE over the ground ahead
  if (h.phase !== 'hover' && h.phase !== 'winch') {
    const ahead = Math.max(w.heightAt(h.x, h.z), w.heightAt(h.x + h.vx * 4, h.z + h.vz * 4)) + CLEARANCE;
    if (h.y < ahead) {
      h.y += Math.min(ahead - h.y, 6 * dt);
      if (h.vy < 0) h.vy = 0;
    }
  }
  const hs = Math.hypot(h.vx, h.vz);
  if (hs > 2) {
    // yaw 0 faces north (-Z), counter-clockwise positive: the nose follows the flight
    const want = Math.atan2(-h.vx, -h.vz);
    let dyaw = want - h.yaw;
    dyaw -= TAU * Math.round(dyaw / TAU);
    h.yaw += clamp(dyaw, -0.9 * dt, 0.9 * dt);
    h.yaw -= TAU * Math.round(h.yaw / TAU);
  }
}

function spawnHeli(ctx: SimCtx): HeliEnt {
  const w = ctx.world, pad = padOf(w), wreck = w.poi('wreck');
  // up the mountain from the valley base, past the wreck
  let dx = wreck.x - pad.x, dz = wreck.z - pad.z;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d;
  dz /= d;
  const far = HELI_SPEED * HELI_LEAD;
  const x = pad.x + dx * far, z = pad.z + dz * far;
  const y = Math.max(pad.y + 150, w.heightAt(x, z) + 120);
  const h = ctx.spawn<HeliEnt>(makeHeli(x, y, z, Math.atan2(dx, dz)));
  h.vx = -dx * HELI_SPEED;
  h.vz = -dz * HELI_SPEED;
  ctx.setV(V.heli, h.id);
  ctx.emit({ t: 'heli', phase: 'inbound' });
  tell(ctx, 'Rotors, far off to the south. Mark the deck with a flare.');
  return h;
}

/** A flare burning on the ground near the deck while the helicopter is up. */
function flareOnDeck(ctx: SimCtx): boolean {
  const pad = padOf(ctx.world);
  for (const f of ctx.all('flare')) {
    if (f.landed && f.life > 0 && Math.hypot(f.x - pad.x, f.z - pad.z) <= SIGNAL_RANGE && Math.abs(f.y - pad.y) < 6) return true;
  }
  return false;
}

/** Can this player be taken up: on their feet or down, in the winch circle. */
function inCircle(p: PlayerEnt, pad: Pad): boolean {
  return (p.life === 'alive' || p.life === 'downed') && !p.swim && Math.hypot(p.x - pad.x, p.z - pad.z) <= WINCH_RANGE && Math.abs(p.y - pad.y) < 2;
}

/** Next to go up: humans before companions, the downed first, then the nearest the centre. */
function nextUp(ctx: SimCtx, pad: Pad): PlayerEnt | undefined {
  let best: PlayerEnt | undefined, bs = Infinity;
  for (const p of ctx.players()) {
    if (!inCircle(p, pad)) continue;
    const s = (p.bot ? 100 : 0) + (p.life === 'downed' ? 0 : 10) + Math.hypot(p.x - pad.x, p.z - pad.z);
    if (s < bs) {
      bs = s;
      best = p;
    }
  }
  return best;
}

/** Where people ride: the cabin door, under the rotor. */
const belly = (h: HeliEnt) => ({ x: h.x, y: h.y - 1.6, z: h.z });

function winch(ctx: SimCtx, h: HeliEnt, pad: Pad): void {
  const vars = ctx.state.vars, dt = ctx.dt;
  const hookId = vars[V.hook] ?? 0;
  const t = (vars[V.hookT] ?? 0) + dt;
  vars[V.hookT] = t;
  if (vars[V.hookUp]) {
    const p = hookId ? ctx.get<PlayerEnt>(hookId) : undefined;
    if (p && p.kind === 'player') {
      const u = smoothstep(0, 1, Math.min(1, t / WINCH_UP));
      const b = belly(h);
      const sx = vars[V.hookX] ?? p.x, sy = vars[V.hookY] ?? p.y, sz = vars[V.hookZ] ?? p.z;
      p.x = sx + (b.x - sx) * u;
      p.y = sy + (b.y - sy) * u;
      p.z = sz + (b.z - sz) * u;
    }
    if (t >= WINCH_UP || !p) {
      vars[V.hook] = 0;
      vars[V.hookUp] = 0;
      vars[V.hookT] = 0;
      delete vars[V.hookX];
      delete vars[V.hookY];
      delete vars[V.hookZ];
      if (p) ctx.emit({ t: 'toast', to: 0, kind: 'info', text: `${p.name} is aboard.` });
    }
    return;
  }
  if (t < WINCH_DOWN) return;
  const p = nextUp(ctx, pad);
  if (!p) return;
  p.life = 'rescued';
  p.act = 'none';
  p.actT = 0;
  p.vx = p.vy = p.vz = 0;
  p.bleed = 0;
  p.revive = 0;
  p.reviver = 0;
  vars[V.hook] = p.id;
  vars[V.hookUp] = 1;
  vars[V.hookT] = 0;
  vars[V.hookX] = p.x;
  vars[V.hookY] = p.y;
  vars[V.hookZ] = p.z;
  toast(ctx, p, 'info', 'The hook clips on. You are going up.');
}

/** Everyone who should go has gone: every living human aboard, no companion left waiting in the circle. */
function allAboard(ctx: SimCtx, pad: Pad): boolean {
  let humans = 0;
  for (const p of ctx.players()) {
    if (p.life === 'dead') continue;
    if (!p.bot) humans++;
    if (p.life === 'rescued') continue;
    if (!p.bot || inCircle(p, pad)) return false;
  }
  return humans > 0;
}

function heli(ctx: SimCtx): void {
  const st = ctx.state, o = st.objective, vars = st.vars, dt = ctx.dt;
  const w = ctx.world, pad = padOf(w);
  if (o.stage === 'holdout') {
    if (o.eta < 0) o.eta = HOLDOUT_ETA; // however the hold-out began, the clock starts with it
    // the last packs wake and come for the tower: when the call goes out, and again with the rotors
    if (ctx.v(V.rally) < 1) {
      ctx.setV(V.rally, 1);
      rallyWolves(ctx, pad.x, pad.z);
    }
    o.eta = Math.max(0, o.eta - dt);
    if (o.eta <= HELI_LEAD && !heliOf(ctx)) {
      spawnHeli(ctx);
      if (ctx.v(V.rally) < 2) {
        ctx.setV(V.rally, 2);
        rallyWolves(ctx, pad.x, pad.z);
      }
    }
    if (o.eta <= 0) setStage(ctx, 'rescue', o.signalled ? 'The helicopter is here.' : 'The helicopter is here, looking for the deck.');
  } else if (o.stage === 'rescue' && !heliOf(ctx)) spawnHeli(ctx);
  const h = heliOf(ctx);
  if (!h) return;
  h.t += dt;
  if (!o.signalled && (o.stage === 'holdout' || o.stage === 'rescue') && flareOnDeck(ctx)) {
    o.signalled = true;
    tell(ctx, 'They have seen the flare.');
  }
  const hover = { x: pad.x + pad.fx * 5, y: pad.y + HOVER_ALT, z: pad.z + pad.fz * 5 };
  const dPad = Math.hypot(h.x - pad.x, h.z - pad.z);
  switch (h.phase) {
    case 'inbound':
      fly(ctx, h, hover.x, Math.max(hover.y + 50, pad.y + 60), hover.z, HELI_SPEED, 160);
      if (dPad < ARRIVE && o.stage === 'rescue') setPhase(ctx, h, o.signalled ? 'hover' : 'search');
      break;
    case 'search': {
      // round the tower, searchlight down, until the deck is marked or it finds the lights
      const a = Math.atan2(h.z - pad.z, h.x - pad.x) + 0.45;
      fly(ctx, h, pad.x + Math.cos(a) * SEARCH_RADIUS, pad.y + 60, pad.z + Math.sin(a) * SEARCH_RADIUS, 22, 40);
      if (!o.signalled && h.t >= SEARCH_MAX) {
        o.signalled = true;
        tell(ctx, 'The crew has found the tower lights.');
      }
      if (o.signalled) setPhase(ctx, h, 'hover');
      break;
    }
    case 'hover': {
      fly(ctx, h, hover.x, hover.y, hover.z, 16, 60);
      const d = Math.hypot(h.x - hover.x, h.y - hover.y, h.z - hover.z);
      const settled = d < 4 && Math.hypot(h.vx, h.vy, h.vz) < 2;
      const s = settled ? ctx.v(V.hoverT) + dt : 0;
      ctx.setV(V.hoverT, s);
      if (s >= 2) {
        delete vars[V.hoverT];
        vars[V.hookT] = 0;
        vars[V.hookUp] = 0;
        vars[V.hook] = 0;
        setPhase(ctx, h, 'winch');
        tell(ctx, 'The winch is coming down. Get onto the deck.');
      }
      break;
    }
    case 'winch':
      fly(ctx, h, hover.x, hover.y, hover.z, 6, 20);
      winch(ctx, h, pad);
      if (!vars[V.hook] && allAboard(ctx, pad)) {
        setPhase(ctx, h, 'away');
        vars[V.awayT] = 0;
      }
      break;
    case 'away': {
      // climb out to the south-east, the way it came
      fly(ctx, h, pad.x + 900, pad.y + 260, pad.z + 900, 34, 100);
      const t = ctx.v(V.awayT) + dt;
      vars[V.awayT] = t;
      if (t >= AWAY_TIME && o.stage === 'rescue') setStage(ctx, 'won');
      break;
    }
  }
  // the people aboard ride with it
  const hookId = vars[V.hook] ?? 0;
  const b = belly(h);
  for (const p of ctx.players()) {
    if (p.life !== 'rescued' || p.id === hookId) continue;
    p.x = b.x;
    p.y = b.y;
    p.z = b.z;
  }
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

function beacon(ctx: SimCtx): void {
  const b = deviceOf(ctx, 'beacon');
  if (!b) return;
  const s = ctx.state.objective.stage;
  const on = !!ctx.v(V.tx) || s === 'holdout' || s === 'rescue' || s === 'won';
  if (b.on !== on) {
    b.on = on;
    ctx.touch(b);
  }
}

function debug(ctx: SimCtx, cmd: string, args: number[]): boolean {
  const o = ctx.state.objective;
  const a0 = args[0];
  switch (cmd) {
    case 'obj.stage': {
      const s = STAGES[Math.floor(a0 ?? -1)];
      if (!s) return true;
      if (s === 'holdout') {
        o.eta = HOLDOUT_ETA;
        o.transmit = 1;
      } else if (s === 'rescue') o.eta = 0;
      setStage(ctx, s);
      return true;
    }
    case 'obj.eta':
      if (o.stage === 'holdout' && Number.isFinite(a0)) o.eta = clamp(a0, 0, HOLDOUT_ETA);
      return true;
    case 'obj.gen':
      if (Number.isFinite(a0)) o.generator = sat(a0);
      return true;
    default:
      return false;
  }
}

export const objective: System = {
  name: 'objective',

  step(ctx) {
    // nobody on the mountain (an empty session): everything waits for someone to come back
    if (ctx.players().length === 0) return;
    const o = ctx.state.objective;
    syncParts(ctx);
    const terminal = o.stage === 'won' || o.stage === 'lost';
    if (!terminal) stages(ctx);
    const panel = deviceOf(ctx, 'panel'), gen = deviceOf(ctx, 'generator');
    let crankers = 0;
    for (const p of ctx.players()) {
      if (p.life !== 'alive' || p.swim || terminal) {
        const k = keysOf(p.id), vars = ctx.state.vars;
        if (vars[k.install] !== undefined || vars[k.crank] !== undefined || vars[k.bed] !== undefined) {
          delete vars[k.install];
          delete vars[k.crank];
          delete vars[k.bed];
          if (p.life === 'alive' && (p.act === 'use' || p.act === 'crank')) {
            p.act = 'none';
            p.actT = 0;
          }
        }
        continue;
      }
      // nothing held and nothing under way: no device work for this player this tick
      if ((ctx.input(p.id).b & (BTN.USE | BTN.PRIMARY)) === 0 && p.act !== 'use' && p.act !== 'crank') continue;
      installing(ctx, p, panel);
      if (cranking(ctx, p, gen)) crankers++;
      useDoor(ctx, p);
      rest(ctx, p);
    }
    syncPanel(ctx, panel);
    if (!terminal || o.generator > 0) power(ctx, gen, Math.min(2, crankers));
    beacon(ctx);
    doors(ctx);
    heli(ctx);
    if (!terminal) checkLost(ctx);
  },

  action(ctx, p, a) {
    if (a.t === 'respawn') {
      // the run is over: nobody wakes again
      if (ctx.state.objective.stage !== 'lost') return false;
      toast(ctx, p, 'info', 'There is no one left to wake. The mountain has you all.');
      return true;
    }
    if (a.t === 'debug' && ctx.debug) return debug(ctx, a.cmd, a.args ?? []);
    return false;
  },

  leave(ctx, p) {
    const k = keysOf(p.id), vars = ctx.state.vars;
    delete vars[k.install];
    delete vars[k.crank];
    delete vars[k.bed];
    delete vars[k.said];
    if (vars[V.hook] === p.id) {
      vars[V.hook] = 0;
      vars[V.hookUp] = 0;
      vars[V.hookT] = 0;
    }
    keyCache.delete(p.id);
  },
};
