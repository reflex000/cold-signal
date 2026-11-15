// The companion bot brain (settings.bots) and the autopilot of the release scenario.
//
// A Mind drives one body with exactly what a remote player sends: one InputCmd per tick (move,
// look, buttons, the entity under the crosshair) and discrete Actions. Companion bots are players
// without a transport: BotBrain runs their minds beside the host (reading the authoritative state)
// and hands their commands to Host.setBotInput / Host.botAct, the same path a client's messages
// take. The autopilot (CS.auto) is a Mind in the 'lead' role driving the LOCAL player through the
// game's own input path and the client session, reading only the client's View.
//
// What a mind does, most urgent first (each step either takes the tick or passes it on):
//   dead      a companion wakes at the last checkpoint after a few seconds (the 'respawn' action)
//   downed    crawl toward the nearest teammate; bandage the wound when it is running out
//   water     swim for the nearest solid edge and hold USE to climb out
//   self      bandage a bad wound, eat when starving, drink the thermos when freezing
//   defend    a wolf going for anyone near: rifle (aimed, never across a teammate), axe at arm's length,
//             a flare between the pack and the group in the dark; otherwise close up on the group
//   revive    a downed teammate within 60 m: go, kneel, hold USE until they are up
//   carry     the leader lifts a heavy log: take the free end and walk it at their pace
//   tower     once all five are found, whoever carries a part takes it to the panel and fits it; crank the
//             generator (two on the handles go faster); shelter in the shed for the hold-out; the winch circle
//   lead      (autopilot) warm up at a fire or build one when cold, sit out a whiteout at a fire, then the
//             next radio part in route order, picking up useful things it passes
//   follow    (companion) build and feed a fire when the group stops in the cold; hand over what the leader
//             lacks (radio parts always: the leader goes where they are needed); gather sticks (picked up, or
//             the dead branches of a pine or fir snapped off: Action 'gather', wood.ts) and chop dead wood
//             while the group is camped; keep a slot beside the leader: closer in bad weather (inside
//             huddle range), never onto thin ice or off a cliff
// Movement goes through botnav.ts (trail, local A*, hazard checks). Simple, readable rules; no cheats:
// a mind reads the state (as any client does) and its body obeys the same simulation as everyone's.
// Owner: TOGETHER (first version: GAME).
import { wrapAngle } from '../core/math';
import type { Host } from '../net/host';
import { CARRY_LIMIT, neutralInput } from '../sim/entities';
import { EYE_STAND } from '../sim/move';
import { padOf, PARTS, PART_ITEM } from '../sim/systems/objective';
import { REVIVE_RANGE } from '../sim/systems/vitals';
import { hasBranches, trunkRadius } from '../sim/systems/wood';
import { BTN, type Action, type DeviceEnt, type Entity, type FireEnt, type InputCmd, type ItemId, type LogEnt, type NetId, type PickupEnt, type PlayerEnt, type ToolId, type WolfEnt } from '../sim/types';
import type { WorldEx } from '../world/index';
import { canWork, iceRisk, Planner, SimReader, steer, Walker, type Reader, type Steer } from './botnav';

const NAMES = ['Mara', 'Tomas', 'Ines'];
/** Extra detail in Mind.doing (tools). */
export let DEBUG_BOTS = false;
export function debugBots(on: boolean): void {
  DEBUG_BOTS = on;
}

export type Role = 'follow' | 'lead';

/** Where a mind's decisions go: a bot's host link, or the local player's input path. */
export interface BodyLink {
  send(cmd: InputCmd): void;
  act(a: Action): void;
}

// --- tuning (seconds, metres, degrees C) ---------------------------------------------------------
const COLD_START = 35.2; // warm up below this core ...
const WARM_ENOUGH = 36.8; // ... until this
const WET_START = 0.35;
const STORM_CAMP = 0.62; // storm at which a group gets to a fire and stays
const STORM_BREAK = 0.5; // ... until it falls back below this
const FIRE_NEAR = 1.7; // where to stand to be warmed by a fire
const FEED_BELOW = 150; // feed a fire with less burn left than this
const STILL_FOR = 5; // the leader standing this long counts as a stop
const THREAT_RANGE = 35;
const SUPPLIES: readonly ItemId[] = ['matches', 'tinder', 'flare', 'ammo', 'cell', 'bandage', 'ration', 'thermos'];
const TOOLS: readonly ItemId[] = ['axe', 'rifle', 'flaregun', 'radio', 'flashlight'];
const ATTACKING = new Set<WolfEnt['mood']>(['charge', 'bite', 'drag', 'feint']);
const CALM = new Set<WolfEnt['mood']>(['flee', 'cower', 'dead', 'rest', 'feed']);

const has = (p: PlayerEnt, item: ItemId): number => p.inv[item] ?? 0;
const dist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/** One body's decisions. */
export class Mind {
  readonly id: NetId;
  role: Role;
  leader: NetId = 0;
  /** What the mind is doing right now (for tools and debugging). */
  doing = 'idle';
  /** Navigation detail for tools (with DEBUG_BOTS). */
  dbg = '';
  private readonly cmd: InputCmd = neutralInput();
  private readonly walker: Walker;
  private readonly sv: Steer = { yaw: 0, mz: 0, sprint: false, jump: false, arrived: false, blocked: false };
  private seq = 0;
  private prevB = 0;
  private t = 0;
  /** Wanted look direction this tick and how fast to turn to it (rad/s). */
  private yaw = 0;
  private pitch = 0;
  private turn = 5;
  private readonly cool = new Map<string, number>();
  private deadT = 0;
  private leaderStill = 0;
  private leaderX = 0;
  private leaderZ = 0;
  private buildYaw = 0;
  private buildTries = 0;
  /** The fire a mind is warming at or tending, and the storm it is sitting out. */
  private camp: NetId = 0;
  private camping = false;
  private stormPrev = 0;
  private stormRise = 0;
  /** Things that could not be reached lately (key -> time to try again), and how often they failed. */
  private readonly skip = new Map<string, number>();
  private readonly fails = new Map<string, number>();
  private chopId: NetId = 0;
  private yawSet = false;
  private lastFlare = -1e9;

  constructor(id: NetId, role: Role, side: number) {
    this.id = id;
    this.role = role;
    this.walker = new Walker(side);
  }

  /** One tick: read, decide, send one command (and maybe an action). */
  tick(r: Reader, pl: Planner, dt: number, link: BodyLink): void {
    const p = r.get(this.id) as PlayerEnt | undefined;
    if (!p || p.kind !== 'player') return;
    this.t += dt;
    const c = this.cmd;
    if (!this.yawSet) {
      this.yaw = p.yaw;
      c.yaw = p.yaw;
      this.yawSet = true;
    }
    c.mx = 0;
    c.mz = 0;
    c.b = 0;
    c.focus = 0;
    this.yaw = c.yaw;
    this.pitch = 0;
    this.turn = 5;
    this.link = link;
    this.trackStorm(r, dt);

    this.decide(r, pl, p, dt);

    // turn toward the wanted look at a human rate; buttons go out with their edges intact
    const dy = wrapAngle(this.yaw - c.yaw);
    const maxTurn = this.turn * dt;
    c.yaw = wrapAngle(c.yaw + Math.max(-maxTurn, Math.min(maxTurn, dy)));
    c.pitch += Math.max(-2.5 * dt, Math.min(2.5 * dt, this.pitch - c.pitch));
    c.seq = ++this.seq;
    this.prevB = c.b;
    link.send(c);
  }

  // =========================================================================================== plumbing

  private link: BodyLink | null = null;

  private ready(key: string, every: number): boolean {
    const t = this.cool.get(key) ?? -1e9;
    if (this.t - t < every) return false;
    this.cool.set(key, this.t);
    return true;
  }

  private act(a: Action, key: string, every: number): void {
    if (this.link && this.ready(key, every)) this.link.act(a);
  }

  /** Hold a button this tick. */
  private hold(btn: number): void {
    this.cmd.b |= btn;
  }

  /** A press: down this tick only if it was up the tick before (the sim acts on the edge). */
  private press(btn: number): void {
    if ((this.prevB & btn) === 0) this.cmd.b |= btn;
  }

  private look(p: PlayerEnt, x: number, y: number, z: number, fast = false): void {
    const dx = x - p.x, dz = z - p.z;
    this.yaw = yawTo(dx, dz);
    this.pitch = Math.atan2(y - (p.y + EYE_STAND), Math.max(0.3, Math.hypot(dx, dz)));
    if (fast) this.turn = 9;
  }

  /** Walk toward (x, z); true once within `near`. */
  private go(r: Reader, pl: Planner, p: PlayerEnt, x: number, z: number, near: number, dt: number, run = false, goal?: (x: number, z: number) => boolean): boolean {
    const s = steer(pl, r, this.walker, p, x, z, near, dt, this.sv, { run, goal });
    if (DEBUG_BOTS) {
      const w = this.walker, q = w.path[0];
      this.dbg = ` -> ${x.toFixed(1)},${z.toFixed(1)} path${w.path.length}${q ? `(${q.x.toFixed(1)},${q.z.toFixed(1)})` : ''}${s.blocked ? ' BLOCKED' : ''} stuck${w.stuck}`;
    }
    if (s.arrived) return true;
    this.yaw = s.yaw;
    this.cmd.mz = s.mz;
    if (s.sprint) this.cmd.b |= BTN.SPRINT;
    if (s.jump) this.press(BTN.JUMP);
    return false;
  }

  /**
   * Seconds spent on the thing named `key` (a pickup, a crate, dead wood, a part) without a break: a
   * key not asked about for a second starts again from 0. Several keys run at once (a part and the
   * pickup it lies in).
   */
  private on(key: string): number {
    let s = this.onTimes.get(key);
    if (!s || this.t - s.last > 1) {
      s = { since: this.t, last: this.t };
      this.onTimes.set(key, s);
      if (this.onTimes.size > 64) for (const [k, v] of this.onTimes) if (this.t - v.last > 1) this.onTimes.delete(k);
    }
    s.last = this.t;
    return this.t - s.since;
  }
  private readonly onTimes = new Map<string, { since: number; last: number }>();

  /** Working at `key` has taken too long, or there is no way to it: time to try something else. */
  private giveUp(key: string): boolean {
    const t = this.on(key);
    return t > 30 || (this.sv.blocked && t > 8);
  }

  private equip(p: PlayerEnt, tool: ToolId): boolean {
    if (p.held === tool) return true;
    this.act({ t: 'equip', tool }, 'equip', 0.4);
    return false;
  }

  private trackStorm(r: Reader, dt: number): void {
    const s = r.env().storm;
    this.stormRise += ((s - this.stormPrev) / Math.max(1e-3, dt) - this.stormRise) * Math.min(1, dt / 8);
    this.stormPrev = s;
  }

  // =========================================================================================== decisions

  private decide(r: Reader, pl: Planner, p: PlayerEnt, dt: number): void {
    if (p.life === 'rescued') {
      this.doing = 'aboard';
      return;
    }
    if (p.life === 'dead') {
      this.doing = 'dead';
      this.deadT += dt;
      // the autopilot's death screen is the game's; a companion wakes by itself
      if (this.role === 'follow' && this.deadT > 6) this.act({ t: 'respawn' }, 'respawn', 3);
      return;
    }
    this.deadT = 0;
    if (p.life === 'downed') return this.downed(r, p);
    if (p.swim) return this.swim(r, pl, p);
    this.selfCare(r, p);
    if (this.defend(r, pl, p, dt)) return;
    if (this.revive(r, pl, p, dt)) return;
    if (this.role === 'follow' && this.carry(r, pl, p, dt)) return;
    if (p.carry) this.act({ t: 'release' }, 'release', 1);
    if (this.tower(r, pl, p, dt)) return;
    if (this.role === 'lead') this.lead(r, pl, p, dt);
    else this.follow(r, pl, p, dt);
  }

  // ----------------------------------------------------------------------------------------- body

  private downed(r: Reader, p: PlayerEnt): void {
    this.doing = 'downed';
    const mate = this.nearestMate(r, p, (q) => q.life === 'alive');
    if (mate && dist(mate, p) > 1.5) {
      this.yaw = yawTo(mate.x - p.x, mate.z - p.z);
      this.cmd.mz = 1; // crawl
    }
    if (has(p, 'bandage') > 0 && p.bleed < 45 && p.revive === 0) this.act({ t: 'consume', item: 'bandage' }, 'bandage', 4);
  }

  private swim(r: Reader, pl: Planner, p: PlayerEnt): void {
    this.doing = 'climb out';
    // the nearest edge that holds: hold USE while swimming at it (climbing needs to be within reach)
    let best: { x: number; z: number } | null = null, bd = Infinity;
    for (let rad = 0.6; rad <= 6 && !best; rad += 0.4) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = p.x + Math.sin(a) * rad, z = p.z + Math.cos(a) * rad;
        if (iceRisk(r, x, z) < 0.9 && pl.walk.at(x, z) && rad < bd) {
          bd = rad;
          best = { x, z };
        }
      }
    }
    if (best) {
      this.yaw = yawTo(best.x - p.x, best.z - p.z);
      this.cmd.mz = 1;
    }
    this.hold(BTN.USE);
  }

  private selfCare(r: Reader, p: PlayerEnt): void {
    if (p.act !== 'none') return;
    const fireNear = this.litFire(r, p.x, p.z, 4) !== null;
    if (p.health < 55 && has(p, 'bandage') > 0) this.act({ t: 'consume', item: 'bandage' }, 'consume', 3);
    else if (p.hunger > 0.7 && has(p, 'ration') > 0) this.act({ t: 'consume', item: 'ration' }, 'consume', 3);
    else if (p.core < 34.3 && !fireNear && has(p, 'thermos') > 0) this.act({ t: 'consume', item: 'thermos' }, 'consume', 3);
  }

  // ----------------------------------------------------------------------------------------- wolves

  /** The wolf most worth stopping: one going for someone near (feint, charge, bite, drag), or any right on me. */
  private threat(r: Reader, p: PlayerEnt): WolfEnt | null {
    let best: WolfEnt | null = null, bs = Infinity;
    for (const w of r.list('wolf')) {
      if (CALM.has(w.mood)) continue;
      const d = dist(w, p);
      if (d > THREAT_RANGE) continue;
      const target = w.target ? (r.get(w.target) as PlayerEnt | undefined) : undefined;
      const onUs = target !== undefined && target.kind === 'player' && dist(target, p) < 25;
      const score = ATTACKING.has(w.mood) && onUs ? d * 0.5 : d < 6 ? d : Infinity;
      if (score < bs) {
        bs = score;
        best = w;
      }
    }
    return best;
  }

  /** No teammate stands in the line of fire toward (x, z) at distance d. */
  private clearShot(r: Reader, p: PlayerEnt, x: number, z: number, d: number): boolean {
    const ux = (x - p.x) / d, uz = (z - p.z) / d;
    for (const q of r.list('player')) {
      if (q.id === p.id || q.life === 'dead' || q.life === 'rescued') continue;
      const qx = q.x - p.x, qz = q.z - p.z;
      const along = qx * ux + qz * uz;
      if (along <= 0 || along > d + 3) continue;
      if (Math.abs(qx * uz - qz * ux) < 1.4) return false;
    }
    return true;
  }

  private defend(r: Reader, pl: Planner, p: PlayerEnt, dt: number): boolean {
    const w = this.threat(r, p);
    if (!w) return false;
    const d = dist(w, p);
    this.doing = 'defend';
    const wy = w.y + 0.45;
    const night = r.env().clock > 18.8 || r.env().clock < 6.5;
    // rifle: aimed fire at an attacking wolf, never across a teammate
    if (has(p, 'rifle') > 0 && (p.loaded > 0 || has(p, 'ammo') > 0) && ATTACKING.has(w.mood) && d < 70) {
      if (!this.equip(p, 'rifle')) return true;
      if (p.loaded === 0) {
        if (p.act === 'none') this.act({ t: 'reload' }, 'reload', 2);
        this.look(p, w.x, wy, w.z, true);
        return true;
      }
      this.look(p, w.x, wy, w.z, true);
      this.hold(BTN.SECONDARY);
      const aimed = Math.abs(wrapAngle(this.yaw - this.cmd.yaw)) < 0.05;
      if (p.aim > 0.85 && aimed && p.act === 'none' && this.clearShot(r, p, w.x, w.z, d)) this.press(BTN.PRIMARY);
      return true;
    }
    // axe: at arm's length
    if (has(p, 'axe') > 0 && d < 3.2) {
      if (!this.equip(p, 'axe')) return true;
      this.look(p, w.x, wy, w.z, true);
      this.press(BTN.PRIMARY);
      return true;
    }
    // a flare between the pack and the group, in the dark, at most one burning at a time (40 s)
    if (has(p, 'flaregun') > 0 && (p.flareLoaded > 0 || has(p, 'flare') > 0) && night && d < 18 && this.t - this.lastFlare > 45) {
      if (!this.equip(p, 'flaregun')) return true;
      if (p.flareLoaded < 1) {
        if (p.act === 'none') this.act({ t: 'reload' }, 'reload', 2);
        return true;
      }
      // aim at the snow halfway to the wolf: it lands between us
      const mx = (p.x + w.x) / 2, mz = (p.z + w.z) / 2;
      this.look(p, mx, r.world.heightAt(mx, mz), mz, true);
      if (Math.abs(wrapAngle(this.yaw - this.cmd.yaw)) < 0.08 && p.act === 'none') {
        this.press(BTN.PRIMARY);
        this.lastFlare = this.t;
      }
      return true;
    }
    // nothing to fight with: close up on the group (wolves pick the isolated), axe out if there is one
    if (has(p, 'axe') > 0) this.equip(p, 'axe');
    const mate = this.nearestMate(r, p, (q) => q.life === 'alive');
    if (mate && dist(mate, p) > 2.2) this.go(r, pl, p, mate.x, mate.z, 2, dt, true);
    else this.look(p, w.x, wy, w.z);
    return true;
  }

  // ----------------------------------------------------------------------------------------- teammates

  private nearestMate(r: Reader, p: PlayerEnt, ok: (q: PlayerEnt) => boolean): PlayerEnt | null {
    let best: PlayerEnt | null = null, bd = Infinity;
    for (const q of r.list('player')) {
      if (q.id === p.id || !ok(q)) continue;
      const d = dist(q, p);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  private revive(r: Reader, pl: Planner, p: PlayerEnt, dt: number): boolean {
    const d = this.nearestMate(r, p, (q) => q.life === 'downed' && !q.swim);
    if (!d || dist(d, p) > 60) return false;
    // someone else closer is already on it
    if (d.reviver && d.reviver !== p.id) {
      const other = r.get(d.reviver) as PlayerEnt | undefined;
      if (other && other.kind === 'player' && dist(other, d) < 2) return false;
    }
    this.doing = 'revive';
    if (p.held !== 'hands' && dist(d, p) < 6) this.equip(p, 'hands');
    if (!this.go(r, pl, p, d.x, d.z, REVIVE_RANGE - 0.5, dt, true)) return true;
    this.look(p, d.x, d.y + 0.3, d.z);
    this.cmd.focus = d.id;
    this.hold(BTN.USE);
    return true;
  }

  /** Take the free end of the log the leader lifted, and walk it at their pace. */
  private carry(r: Reader, pl: Planner, p: PlayerEnt, dt: number): boolean {
    const L = r.get(this.leader) as PlayerEnt | undefined;
    if (!L || L.kind !== 'player' || L.life !== 'alive') return false;
    if (p.carry) {
      const log = r.get(p.carry) as LogEnt | undefined;
      if (!log || L.carry !== p.carry) {
        this.act({ t: 'release' }, 'release', 1);
        return true;
      }
      this.doing = 'carry';
      // keep the log's length to the leader, on the line we already hold
      const d = dist(L, p);
      const ux = (p.x - L.x) / Math.max(0.01, d), uz = (p.z - L.z) / Math.max(0.01, d);
      const tx = L.x + ux * log.len, tz = L.z + uz * log.len;
      if (d > log.len + 0.5) this.go(r, pl, p, tx, tz, 0.3, dt);
      this.look(p, L.x, L.y + 1.2, L.z);
      return true;
    }
    if (!L.carry) return false;
    const log = r.get(L.carry) as LogEnt | undefined;
    if (!log || log.kind !== 'log' || (log.a && log.b)) return false;
    this.doing = 'carry: take an end';
    const ux = Math.sin(log.yaw), uz = Math.cos(log.yaw), h = 0.5 * log.len;
    const front = log.a === 0; // the free end
    const ex = log.x + (front ? ux : -ux) * h, ez = log.z + (front ? uz : -uz) * h;
    if (p.held !== 'hands') this.equip(p, 'hands');
    if (this.go(r, pl, p, ex, ez, 1.2, dt, true)) this.act({ t: 'carry', log: log.id }, 'carry', 1);
    return true;
  }

  // ----------------------------------------------------------------------------------------- the tower

  private device(r: Reader, type: DeviceEnt['type']): DeviceEnt | null {
    for (const d of r.list('device')) if (d.type === type) return d;
    return null;
  }

  private partsIn(r: Reader): number {
    const parts = r.objective().parts;
    let n = 0;
    for (const k of PARTS) if (parts[k] === 'installed') n++;
    return n;
  }

  private tower(r: Reader, pl: Planner, p: PlayerEnt, dt: number): boolean {
    const o = r.objective();
    const stage = o.stage;
    if (stage === 'won' || stage === 'lost') return false;
    // the end: everyone into the winch circle
    if (stage === 'rescue') {
      const pad = padOf(r.world);
      this.doing = 'winch';
      if (this.go(r, pl, p, pad.x, pad.z, 1.6, dt, true)) this.look(p, pad.x, pad.y + 18, pad.z);
      return true;
    }
    const carried = PARTS.find((k) => has(p, PART_ITEM[k]) > 0);
    const atTower = dist(p, r.world.poi('tower')) < 90;
    // every part found: whoever carries one takes it to the panel, from wherever they are
    if (carried && (stage === 'tower' || stage === 'power')) {
      const panel = this.device(r, 'panel');
      if (!panel) return false;
      this.doing = 'install ' + carried;
      if (this.useDevice(r, pl, p, panel, dt)) this.hold(BTN.USE);
      return true;
    }
    if (stage === 'power' && this.partsIn(r) === 5 && atTower) {
      const gen = this.device(r, 'generator');
      if (!gen) return false;
      this.doing = 'crank';
      if (p.held !== 'hands') this.equip(p, 'hands');
      if (this.useDevice(r, pl, p, gen, dt)) this.hold(BTN.USE);
      return true;
    }
    if (stage === 'holdout' && atTower) {
      // the worst of the storm: shelter in the shed, out again for the helicopter
      const door = r.world.anchors['tower:shed.door'];
      const panel = this.device(r, 'panel');
      if (panel && door) {
        this.doing = 'hold out';
        if (this.go(r, pl, p, panel.x + (door.x - panel.x) * 0.45, panel.z + (door.z - panel.z) * 0.45, 0.8, dt)) this.look(p, door.x, door.y + 1.4, door.z);
        return true;
      }
    }
    return false;
  }

  /** Walk to within reach of a device and aim at it; true once there (focus set). */
  private useDevice(r: Reader, pl: Planner, p: PlayerEnt, d: DeviceEnt, dt: number): boolean {
    // in the host's reach, not only near: a wall in between puts a device a metre away out of reach
    if (dist(d, p) > 1.35 || !canWork(r.world, p.x, p.y, p.z, d)) {
      this.go(r, pl, p, d.x, d.z, 1.3, dt, false, pl.workSpot(d, 0, 1.3));
      return false;
    }
    this.look(p, d.x, d.y + 0.1, d.z);
    this.cmd.focus = d.id;
    return true;
  }

  // ----------------------------------------------------------------------------------------- fire

  private litFire(r: Reader, x: number, z: number, within: number): FireEnt | null {
    let best: FireEnt | null = null, bd = within;
    for (const f of r.list('fire')) {
      if (!f.lit) continue;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  }

  /** An unlit fire with wood on it (or embers) near (x, z). */
  private laidFire(r: Reader, x: number, z: number, within: number): FireEnt | null {
    let best: FireEnt | null = null, bd = within;
    for (const f of r.list('fire')) {
      if (f.lit || (f.size <= 0.01 && f.embers <= 0)) continue;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  }

  /** Can a campfire go down at (x, z) (the sim checks again): not on ice, floors, steep ground or in a wall. */
  private layable(r: Reader, pl: Planner, p: PlayerEnt, x: number, z: number): boolean {
    const w = r.world;
    if (w.iceAt(x, z) > 0 || !pl.walk.at(x, z)) return false;
    const g = w.groundAt(x, z, p.y + 0.5);
    if (g.surface === 'ice' || g.surface === 'water' || g.surface === 'wood' || g.surface === 'metal') return false;
    if (Math.abs(g.y - p.y) > 0.8 || w.slopeAt(x, z) > 0.28) return false;
    for (const f of r.list('fire')) if (Math.hypot(f.x - x, f.z - z) < 1.6) return false;
    return w.lineClear(p.x, p.y + 1, p.z, x, g.y + 0.3, z);
  }

  /**
   * Tend the fire at `f`: stand by it, light it if it is laid, feed it when low. Returns true while
   * busy with it (standing there counts).
   */
  private tend(r: Reader, pl: Planner, p: PlayerEnt, f: FireEnt, dt: number): boolean {
    // By the fire is near it, in its reach and in its warmth: on its side of any wall. Just behind
    // the cabin wall the stove is 2 m away, and the host refuses the match and the wall keeps the heat.
    if (dist(f, p) > FIRE_NEAR + 0.4 || !canWork(r.world, p.x, p.y, p.z, f)) {
      this.go(r, pl, p, f.x, f.z, FIRE_NEAR, dt, true, pl.workSpot(f, 1.0, FIRE_NEAR));
      return true;
    }
    this.look(p, f.x, f.y + 0.2, f.z);
    if (!f.lit) {
      if (f.size <= 0.01) {
        // burnt down to embers: wood on the embers catches by itself; no wood, no fire
        const item = has(p, 'stick') > 0 ? 'stick' : has(p, 'log') > 0 ? 'log' : null;
        if (f.embers <= 0 || !item) return false;
        this.act({ t: 'feed', fire: f.id, item }, 'feed', 0.8);
        return true;
      }
      // a laid fire lights with a match (or by blowing on its embers); with neither it is no use
      if (has(p, 'matches') === 0 && f.embers <= 0) return false;
      this.act({ t: 'ignite', fire: f.id }, 'ignite', 1.6);
      return true;
    }
    if (f.fuel < FEED_BELOW && p.act === 'none') {
      // three sticks stay in the pack for the next fire, unless this one is all that stands between
      // us and a storm or a freezing body; split logs burn longest and go first when it runs low
      const reserve = this.camping || r.env().storm > 0.6 || p.core < 34.8 ? 0 : 3;
      const sticks = has(p, 'stick') > reserve;
      const item = has(p, 'log') > 0 && (f.fuel < 90 || !sticks) ? 'log' : sticks ? 'stick' : null;
      if (item) this.act({ t: 'feed', fire: f.id, item }, 'feed', 0.8);
    }
    return true;
  }

  /**
   * Lay a campfire at a spot near (x, z), chosen once and kept until it is done or given up (the
   * request moves with whoever asks; the spot must not). Stands 1.1 m short of it (buildFire lays the
   * fire that far in front), faces it, holds still a moment so the host has the same facing, and asks.
   * True while working at it.
   */
  private build(r: Reader, pl: Planner, p: PlayerEnt, x: number, z: number, dt: number): boolean {
    if (has(p, 'stick') < 3 || p.carry || this.buildTries >= 12) return false;
    let s = this.buildSpot;
    if (!s || Math.hypot(s.x - x, s.z - z) > 4) {
      s = this.buildSpot = { x, z };
      this.buildYaw = Math.atan2(p.x - x, p.z - z); // first try: from the side we come from
    }
    const sx = s.x + Math.sin(this.buildYaw) * 1.1, sz = s.z + Math.cos(this.buildYaw) * 1.1;
    if (!pl.passable(r, sx, sz) || !this.layable(r, pl, p, s.x, s.z)) {
      // another stand, or (every third try) another spot a little way off
      this.buildYaw += 1.1;
      this.buildTries++;
      if (this.buildTries % 3 === 0) s.x += 1.6 * Math.sin(this.buildTries), s.z += 1.6 * Math.cos(this.buildTries);
      return this.buildTries < 12;
    }
    if (!this.go(r, pl, p, sx, sz, 0.3, dt)) {
      this.aligned = 0;
      if (this.giveUp('build' + this.buildTries)) this.buildTries++;
      return true;
    }
    this.look(p, s.x, r.world.heightAt(s.x, s.z), s.z, true);
    this.aligned = Math.abs(wrapAngle(this.yaw - p.yaw)) < 0.05 ? this.aligned + dt : 0;
    if (this.aligned > 0.4 && p.act === 'none' && this.ready('buildFire', 2.5)) {
      this.link?.act({ t: 'buildFire' });
      this.buildTries++;
      this.buildYaw += 0.7; // if it is refused, the next try faces another way
    }
    return true;
  }

  private buildSpot: { x: number; z: number } | null = null;
  private aligned = 0;

  /**
   * Get warm at a fire near (cx, cz): tend a lit one, light a laid one, build one, or fetch sticks
   * to build one. False when none of that is possible here.
   */
  private warmAt(r: Reader, pl: Planner, p: PlayerEnt, cx: number, cz: number, dt: number, reach = 30): boolean {
    const lit = this.litFire(r, cx, cz, reach);
    if (lit) {
      this.camp = lit.id;
      this.buildTries = 0;
      return this.tend(r, pl, p, lit, dt);
    }
    const laid = this.laidFire(r, cx, cz, Math.min(reach, 15));
    if (laid && (has(p, 'matches') > 0 || laid.embers > 0)) {
      this.buildSpot = null;
      return this.tend(r, pl, p, laid, dt);
    }
    if (has(p, 'matches') === 0 && !laid) return false;
    if (this.buildTries >= 12) {
      // this place would not take a fire: try again somewhere else in a while
      if (this.t - this.buildFailT > 45) {
        this.buildTries = 0;
        this.buildSpot = null;
      } else {
        if (this.buildFailT < this.t - 46) this.buildFailT = this.t;
        return false;
      }
    }
    if (has(p, 'stick') >= 3) {
      this.doing = 'build a fire';
      // on a frozen lake the fire goes on the nearest shore
      let bx = cx, bz = cz;
      if (r.world.iceAt(bx, bz) > 0) {
        const s = pl.shore(p.x, p.z);
        bx = s.x;
        bz = s.z;
      }
      if (this.build(r, pl, p, bx, bz, dt)) return true;
      this.buildFailT = this.t;
      return false;
    }
    // no sticks: pick up some close by, snap the dead branches off a tree near, fetch them from further
    // afield, or cut them from dead wood with the axe
    return (
      this.fetch(r, pl, p, 'stick', 12, dt) || this.snap(r, pl, p, p.x, p.z, 20, dt) || this.fetch(r, pl, p, 'stick', 40, dt) ||
      this.chop(r, pl, p, p.x, p.z, 30, dt) || this.fetch(r, pl, p, 'stick', 120, dt) || this.chop(r, pl, p, p.x, p.z, 70, dt)
    );
  }

  private buildFailT = -1e9;

  // ----------------------------------------------------------------------------------------- gathering

  /** The nearest pickup of `item` within `within` m that a body can reach (not on thin ice). */
  private pickupNear(r: Reader, pl: Planner, x: number, z: number, item: ItemId | null, within: number, wanted?: (pk: PickupEnt) => boolean): PickupEnt | null {
    let best: PickupEnt | null = null, bd = within;
    for (const pk of r.list('pickup')) {
      if (item ? pk.item !== item : !(wanted && wanted(pk))) continue;
      const d = Math.hypot(pk.x - x, pk.z - z);
      if (d >= bd || this.skip.has('pk' + pk.id) && this.t < (this.skip.get('pk' + pk.id) ?? 0)) continue;
      if (iceRisk(r, pk.x, pk.z) > 0.25) continue;
      bd = d;
      best = pk;
    }
    return best;
  }

  /** Walk to a pickup and press USE on it. True while busy. */
  private take(r: Reader, pl: Planner, p: PlayerEnt, pk: PickupEnt, dt: number): boolean {
    const key = 'pk' + pk.id;
    // the host's reach (canWork), kept to 2.4 m across for the ~100 ms the view is behind: exactly
    // the host's sight line, so a log on the woodshed's stack is not taken through its back wall
    if (dist(pk, p) > 2.4 || !canWork(r.world, p.x, p.y, p.z, pk)) {
      this.go(r, pl, p, pk.x, pk.z, 0.9, dt, false, pl.workSpot(pk, 0, 2.4));
      // cannot get there: forget it for a while (a pickup that keeps failing, for good)
      if (this.giveUp(key)) {
        const n = (this.fails.get(key) ?? 0) + 1;
        this.fails.set(key, n);
        this.skip.set(key, this.t + (n >= 2 ? 1e9 : 150));
      }
      return true;
    }
    this.look(p, pk.x, pk.y + 0.1, pk.z);
    this.cmd.focus = pk.id;
    this.press(BTN.USE);
    return true;
  }

  /** Fetch `item` from the nearest pickup within `within` m. False when there is none. */
  private fetch(r: Reader, pl: Planner, p: PlayerEnt, item: ItemId, within: number, dt: number): boolean {
    const pk = this.pickupNear(r, pl, p.x, p.z, item, within);
    if (!pk) return false;
    this.doing = 'fetch ' + item;
    return this.take(r, pl, p, pk, dt);
  }

  /** Useful things lying within `within` m: tools not yet carried, supplies with room, sticks when short. */
  private scavenge(r: Reader, pl: Planner, p: PlayerEnt, within: number, dt: number): boolean {
    const want = (pk: PickupEnt): boolean => {
      if (pk.item.startsWith('part_')) return true;
      if (TOOLS.includes(pk.item)) return has(p, pk.item) === 0 && (pk.item !== 'flashlight');
      if (SUPPLIES.includes(pk.item)) return has(p, pk.item) < 6;
      if (pk.item === 'stick') return has(p, 'stick') < 9;
      if (pk.item === 'log') return has(p, 'log') < 2;
      return false;
    };
    const pk = this.pickupNear(r, pl, p.x, p.z, null, within, want);
    if (pk) {
      this.doing = 'take ' + pk.item;
      return this.take(r, pl, p, pk, dt);
    }
    // a closed crate close by (a suitcase, a locker, a crate): a short hold of USE opens it
    for (const c of r.list('crate')) {
      if (c.open) continue;
      if (dist(c, p) > within || iceRisk(r, c.x, c.z) > 0.25) continue;
      const key = 'cr' + c.id;
      if (this.skip.has(key) && this.t < (this.skip.get(key) ?? 0)) continue;
      this.doing = 'open ' + c.type;
      const reachable = (x: number, z: number) => Math.hypot(x - c.x, z - c.z) < 1.6 && r.world.lineClear(x, p.y + 1.5, z, c.x, c.y + 0.4, c.z);
      if (dist(c, p) > 1.6 || !reachable(p.x, p.z)) {
        this.go(r, pl, p, c.x, c.z, 1.0, dt, false, reachable);
        if (this.giveUp(key)) this.skip.set(key, this.t + 120);
        return true;
      }
      this.look(p, c.x, c.y + 0.35, c.z);
      this.cmd.focus = c.id;
      this.hold(BTN.USE);
      return true;
    }
    return false;
  }

  /**
   * Snap the dead branches off the nearest unstripped pine, fir or snag within `within` m of (x, z), as a
   * person does: walk up to the trunk, face it, ask (Action 'gather') and hold USE while the host times
   * it. True while busy; false when there is no such tree (or the pack has no room for sticks).
   */
  private snap(r: Reader, pl: Planner, p: PlayerEnt, x: number, z: number, within: number, dt: number): boolean {
    if (p.carry || has(p, 'stick') >= CARRY_LIMIT.stick - 1) return false;
    const w = r.world;
    let i = this.snapTree;
    // the tree picked before, if it is still unstripped and still near where this asks about
    if (i >= 0 && (r.gathered(i) || this.skipped('tr' + i) || Math.hypot(w.trees[i].x - x, w.trees[i].z - z) > within + 2)) i = -1;
    if (i < 0) {
      const near = this.treeScratch;
      near.length = 0;
      w.treesIn(x - within, z - within, x + within, z + within, near);
      let bd = within;
      for (let k = 0; k < near.length; k++) {
        const t = w.trees[near[k]];
        if (!hasBranches(t) || r.gathered(near[k]) || this.skipped('tr' + near[k]) || iceRisk(r, t.x, t.z) > 0) continue;
        const d = Math.hypot(t.x - x, t.z - z);
        if (d < bd) {
          bd = d;
          i = near[k];
        }
      }
    }
    this.snapTree = i;
    if (i < 0) return false;
    const t = w.trees[i];
    const tr = trunkRadius(t);
    const key = 'tr' + i;
    this.doing = 'snap branches';
    // a spot by the trunk, with nothing in between, the feet near its foot
    const by = (sx: number, sz: number): boolean => {
      const d = Math.hypot(sx - t.x, sz - t.z) - tr;
      if (d < 0.3 || d > 1.3) return false;
      const gy = w.groundAt(sx, sz, t.y + 1).y;
      return Math.abs(gy - t.y) < 1.5 && w.lineClear(sx, gy + EYE_STAND, sz, t.x, t.y + 1.2, t.z);
    };
    if (Math.hypot(p.x - t.x, p.z - t.z) - tr > 1.5 || Math.abs(p.y - t.y) > 2) {
      this.go(r, pl, p, t.x, t.z, tr + 1.3, dt, false, by);
      if (this.giveUp(key)) {
        this.skip.set(key, this.t + 300);
        this.snapTree = -1;
      }
      return true;
    }
    this.look(p, t.x, t.y + 1.2, t.z);
    if (Math.abs(wrapAngle(this.yaw - this.cmd.yaw)) < 0.3) {
      // turned to it: ask, then hold on (the host lets go of a hold whose USE stops)
      if (p.act === 'none') this.act({ t: 'gather', tree: i }, 'gather', 1.5);
      this.hold(BTN.USE);
    }
    if (this.giveUp(key)) {
      this.skip.set(key, this.t + 300);
      this.snapTree = -1;
    }
    return true;
  }

  private snapTree = -1;
  private readonly treeScratch: number[] = [];
  private skipped(key: string): boolean {
    const until = this.skip.get(key);
    return until !== undefined && this.t < until;
  }

  /** Chop the nearest dead wood near (x, z) with the axe (USE on it chops). True while busy. */
  private chop(r: Reader, pl: Planner, p: PlayerEnt, x: number, z: number, within: number, dt: number): boolean {
    if (has(p, 'axe') === 0 || p.stamina < 0.2) return false;
    let target = this.chopId ? (r.get(this.chopId) as Entity | undefined) : undefined;
    if (!target || target.kind !== 'wood') {
      target = undefined;
      let bd = within;
      for (const w of r.list('wood')) {
        const d = Math.hypot(w.x - x, w.z - z);
        if (d < bd && iceRisk(r, w.x, w.z) === 0 && !(this.skip.has('wd' + w.id) && this.t < (this.skip.get('wd' + w.id) ?? 0))) {
          bd = d;
          target = w;
        }
      }
    }
    if (!target || target.kind !== 'wood') {
      this.chopId = 0;
      return false;
    }
    this.chopId = target.id;
    this.doing = 'chop ' + target.type;
    const w = target;
    if (dist(w, p) > 1.7) {
      this.go(r, pl, p, w.x, w.z, 1.5, dt);
      if (this.giveUp("wd" + w.id)) {
        this.skip.set('wd' + w.id, this.t + 180);
        this.chopId = 0;
      }
      return true;
    }
    this.look(p, w.x, w.y + 0.5, w.z);
    this.cmd.focus = w.id;
    this.hold(BTN.USE);
    return true;
  }

  // ----------------------------------------------------------------------------------------- lead (autopilot)

  /** The parts still lying somewhere, in the order the route passes them. */
  private partGoals(r: Reader): { part: string; pk: PickupEnt | null; x: number; z: number }[] {
    const o = r.objective();
    const out: { part: string; pk: PickupEnt | null; x: number; z: number; k: number }[] = [];
    const spots = r.world.spawn.parts;
    for (const part of PARTS) {
      if (o.parts[part] !== 'lost') continue;
      const item = PART_ITEM[part];
      let pk: PickupEnt | null = null;
      for (const q of r.list('pickup')) if (q.item === item) pk = q;
      const s = pk ?? spots[part];
      out.push({ part, pk, x: s.x, z: s.z, k: 0 });
    }
    return out;
  }

  private routeOrder = new Map<string, number>();

  private lead(r: Reader, pl: Planner, p: PlayerEnt, dt: number): void {
    const env = r.env();
    // 1. the cold and the storm come first
    const stormy = env.storm > 0.85 || (env.storm > STORM_CAMP && this.stormRise > 0.0005);
    if (stormy) this.camping = true;
    else if (this.camping && env.storm < STORM_BREAK) this.camping = false;
    const cold = p.core < COLD_START || p.wet > WET_START;
    if (this.camping || cold || (this.camp && (p.core < WARM_ENOUGH || p.wet > 0.15) && this.litFire(r, p.x, p.z, 6))) {
      this.doing = this.camping ? 'sit out the storm' : 'warm up';
      // stock up on sticks close by while a well-fed fire burns and the body can spare it
      const lit = this.litFire(r, p.x, p.z, 8);
      if (lit && lit.fuel > 240 && p.core > 35.6 && env.storm < 0.8 && has(p, 'stick') < 6) {
        const pk = this.pickupNear(r, pl, lit.x, lit.z, 'stick', 14);
        if (pk && this.take(r, pl, p, pk, dt)) return;
        if (!pk && this.snap(r, pl, p, lit.x, lit.z, 10, dt)) return;
      }
      if (this.warmAt(r, pl, p, p.x, p.z, dt, 40)) return;
      // no fire can be made here: back to the nearest one burning (the camp we left), however far
      const back = this.litFire(r, p.x, p.z, 260);
      if (back && this.tend(r, pl, p, back, dt)) return;
    } else this.camp = 0;

    // 2. keep the fire-making kit: sticks
    // (further afield while the sky darkens: the next fire may have to be made in a whiteout)
    if (has(p, 'stick') < 6 && this.fetch(r, pl, p, 'stick', env.storm > 0.45 || has(p, 'stick') < 3 ? 25 : 12, dt)) return;
    // a pine or fir right by the way gives its dead branches in a second
    if (has(p, 'stick') < 6 && this.snap(r, pl, p, p.x, p.z, 4, dt)) return;
    // with fewer than a fire's worth, a detour is worth it: a whiteout without a fire is how people die up here
    if (has(p, 'stick') < 3 && r.objective().stage !== 'holdout' && (this.fetch(r, pl, p, 'stick', 60, dt) || this.snap(r, pl, p, p.x, p.z, 25, dt) || this.chop(r, pl, p, p.x, p.z, 30, dt))) return;

    // 3. useful things on the way
    if (this.scavenge(r, pl, p, 9, dt)) return;

    // 4. the next radio part (or, with all five found, the tower)
    const goals = this.partGoals(r);
    if (this.routeOrder.size === 0) {
      for (const part of PARTS) {
        const s = r.world.spawn.parts[part];
        this.routeOrder.set(part, pl.trailIndex(s.x, s.z));
      }
    }
    goals.sort((a, b) => (this.routeOrder.get(a.part) ?? 0) - (this.routeOrder.get(b.part) ?? 0));
    const g = goals.find((q) => !(this.skip.has(q.part) && this.t < (this.skip.get(q.part) ?? 0)));
    if (g) {
      this.doing = 'find the ' + g.part + (DEBUG_BOTS ? ` ${g.x.toFixed(0)},${g.z.toFixed(0)}${g.pk ? ' pk' : ''} d${dist(g, p).toFixed(0)}` : '');
      if (dist(g, p) < 14 && g.pk) {
        this.take(r, pl, p, g.pk, dt);
        if (this.on("part" + g.part) > 75) this.skip.set(g.part, this.t + 90);
        return;
      }
      this.go(r, pl, p, g.x, g.z, 3, dt, false);
      return;
    }
    const stage = r.objective().stage;
    if (stage === 'tower' || stage === 'search' || stage === 'power' || stage === 'holdout') {
      const door = r.world.anchors['tower:shed.door'];
      const t = door ?? r.world.poi('tower');
      this.doing = 'to the tower';
      this.go(r, pl, p, t.x, t.z, 2.5, dt, false);
    }
  }

  // ----------------------------------------------------------------------------------------- follow (companion)

  private follow(r: Reader, pl: Planner, p: PlayerEnt, dt: number): void {
    const L = r.get(this.leader) as PlayerEnt | undefined;
    if (!L || L.kind !== 'player' || (L.life !== 'alive' && L.life !== 'downed')) {
      // nobody to follow: look after yourself
      this.doing = 'wait';
      if (p.core < COLD_START) this.warmAt(r, pl, p, p.x, p.z, dt, 40);
      return;
    }
    const env = r.env();
    // is the leader stopped?
    const moved = Math.hypot(L.x - this.leaderX, L.z - this.leaderZ);
    if (moved > 0.08 * Math.max(1, dt * 30)) this.leaderStill = 0;
    else this.leaderStill += dt;
    this.leaderX = L.x;
    this.leaderZ = L.z;
    const still = this.leaderStill > STILL_FOR;
    const night = env.clock > 18.8 || env.clock < 6.5;
    const bad = env.storm > 0.55 || night || L.core < 35.6 || p.core < 35.6;
    const indoor = r.world.shelterAt(L.x, L.y + 1, L.z, env.windX, env.windZ).indoor;

    // a fire for the group when it stops in the cold (or my own when I am freezing)
    const wantFire = still && !indoor && (L.core < 36.4 || p.core < 36 || env.storm > 0.5 || night || L.wet > 0.2);
    if (wantFire || p.core < 33.8) {
      const lit = this.litFire(r, L.x, L.z, 7);
      if (lit) {
        if (lit.fuel < FEED_BELOW && (has(p, 'stick') > 0 || has(p, 'log') > 0)) {
          this.doing = 'feed the fire';
          this.tend(r, pl, p, lit, dt);
          return;
        }
        // the fire is going: gather wood near it while warm enough, else warm up beside it
        if (p.core > 35.8 && dist(L, p) < 25) {
          if (has(p, 'stick') < 8 && (this.fetch(r, pl, p, 'stick', 16, dt) || this.snap(r, pl, p, lit.x, lit.z, 16, dt))) return;
          if (has(p, 'log') < 2 && this.chop(r, pl, p, lit.x, lit.z, 18, dt)) return;
        }
        this.doing = 'warm by the fire';
        this.tend(r, pl, p, lit, dt);
        return;
      }
      const laid = this.laidFire(r, L.x, L.z, 6);
      if (laid && (has(p, 'matches') > 0 || laid.embers > 0)) {
        this.doing = 'light the fire';
        if (this.tend(r, pl, p, laid, dt)) return;
      }
      if (has(p, 'stick') >= 3 && has(p, 'matches') > 0 && this.buildTries < 12) {
        this.doing = 'build a fire';
        // lay it 1.5 m from the leader on my side
        const d = Math.max(0.5, dist(L, p));
        const ux = (p.x - L.x) / d, uz = (p.z - L.z) / d;
        if (this.build(r, pl, p, L.x + ux * 1.5, L.z + uz * 1.5, dt)) return;
      } else if (has(p, 'stick') < 3 && (this.fetch(r, pl, p, 'stick', 20, dt) || this.snap(r, pl, p, L.x, L.z, 15, dt))) return;
    } else {
      this.buildTries = 0;
      this.buildSpot = null;
    }

    // hand over what the leader lacks
    if (this.give(r, pl, p, L, dt)) return;

    // gather on the way: sticks when short, supplies close by, while the leader is near
    if (dist(L, p) < 14 && !(L.life === 'downed')) {
      if (has(p, 'stick') < 6 && (this.fetch(r, pl, p, 'stick', 8, dt) || this.snap(r, pl, p, p.x, p.z, 4, dt))) return;
      if (this.scavenge(r, pl, p, 6, dt)) return;
    }

    // keep a slot beside and a little behind the leader; closer in bad weather (huddle range 2.5 m)
    this.doing = 'follow';
    const ly = L.yaw;
    const back = bad ? 1.5 : 2.6;
    const side = (bad ? 0.9 : 1.6) * this.walkerSide();
    let tx = L.x + Math.sin(ly) * back + Math.cos(ly) * side;
    let tz = L.z + Math.cos(ly) * back - Math.sin(ly) * side;
    if (!pl.passable(r, tx, tz)) {
      const q = pl.nearestPassable(r, tx, tz, 5);
      if (q) {
        tx = q.x;
        tz = q.z;
      } else {
        tx = p.x;
        tz = p.z;
      }
    }
    // on the ice keep apart (two close together load the same cells)
    if (r.world.iceAt(p.x, p.z) > 0 && dist(L, p) < 4.5 && r.world.iceAt(L.x, L.z) > 0) {
      const d = Math.max(0.1, dist(L, p));
      tx = L.x + ((p.x - L.x) / d) * 5;
      tz = L.z + ((p.z - L.z) / d) * 5;
    }
    const far = dist(L, p) > 16;
    // a slot that cannot be reached (behind a rock, over a drift edge): walk to the leader instead
    if (this.sv.blocked || this.walker.stuck >= 2) this.slotBlocked += dt;
    else this.slotBlocked = Math.max(0, this.slotBlocked - dt);
    if (this.slotBlocked > 4) {
      tx = L.x;
      tz = L.z;
      if (dist(L, p) < 2.4) this.slotBlocked = 0;
    }
    if (this.go(r, pl, p, tx, tz, this.slotBlocked > 4 ? 2.2 : still ? 1.2 : 0.8, dt, far)) {
      // there: face where the leader looks, or toward them when they stopped
      if (still) this.look(p, L.x, L.y + 1.4, L.z);
      else this.yaw = this.cmd.yaw + wrapAngle(ly - this.cmd.yaw) * 0.08;
    }
  }

  private slotBlocked = 0;

  private walkerSide(): number {
    return this.walker.side >= 0 ? 1 : -1;
  }

  /** Hand the leader what they need and I can spare. True while walking over to do it. */
  private give(r: Reader, pl: Planner, p: PlayerEnt, L: PlayerEnt, dt: number): boolean {
    if (L.life !== 'alive' || !this.ready('giveCheck', 1)) return this.giving !== null && this.giveTo(r, pl, p, L, dt);
    this.giving = null;
    const lacks = (item: ItemId) => L.inv[item] ?? 0;
    // a radio part goes to the leader, who goes where the parts are needed
    const part = PARTS.find((k) => has(p, PART_ITEM[k]) > 0);
    if (part && L.carry === 0) this.giving = { item: PART_ITEM[part], n: 1 };
    else if (lacks('matches') < 2 && has(p, 'matches') >= 4) this.giving = { item: 'matches', n: 2 };
    else if (L.health < 60 && lacks('bandage') === 0 && has(p, 'bandage') > 0) this.giving = { item: 'bandage', n: 1 };
    else if (lacks('rifle') > 0 && lacks('ammo') + L.loaded < 3 && has(p, 'ammo') > 0 && has(p, 'rifle') === 0) this.giving = { item: 'ammo', n: has(p, 'ammo') };
    else if (lacks('stick') < 3 && has(p, 'stick') >= 5) this.giving = { item: 'stick', n: 3 };
    else if (L.core < 34.6 && lacks('thermos') === 0 && has(p, 'thermos') > 0) this.giving = { item: 'thermos', n: 1 };
    else if (L.hunger > 0.7 && lacks('ration') === 0 && has(p, 'ration') > 0) this.giving = { item: 'ration', n: 1 };
    else if (lacks('flaregun') > 0 && lacks('flare') === 0 && L.flareLoaded === 0 && has(p, 'flare') > 0 && has(p, 'flaregun') === 0) this.giving = { item: 'flare', n: 1 };
    return this.giving !== null && this.giveTo(r, pl, p, L, dt);
  }

  private giving: { item: ItemId; n: number } | null = null;

  private giveTo(r: Reader, pl: Planner, p: PlayerEnt, L: PlayerEnt, dt: number): boolean {
    const g = this.giving;
    if (!g || has(p, g.item) < 1) {
      this.giving = null;
      return false;
    }
    this.doing = 'hand over ' + g.item;
    if (!this.go(r, pl, p, L.x, L.z, 2.2, dt)) return true;
    this.look(p, L.x, L.y + 1.2, L.z);
    this.act({ t: 'give', to: L.id, item: g.item, n: Math.min(g.n, has(p, g.item)) }, 'give', 2);
    this.giving = null;
    return true;
  }
}

// =================================================================================================== the brain

interface Bot {
  id: NetId;
  mind: Mind;
}

/** The companions of a session (and the shared planner the autopilot uses too). */
export class BotBrain {
  private host: Host | null = null;
  private bots: Bot[] = [];
  private leader: NetId = 0;
  private reader: SimReader | null = null;
  readonly planner: Planner;
  private readonly link: BodyLink & { id: NetId } = {
    id: 0,
    send: (cmd) => this.host?.setBotInput(this.link.id, cmd),
    act: (a) => {
      this.host?.botAct(this.link.id, a);
    },
  };

  constructor(private readonly world: WorldEx) {
    this.planner = new Planner(world);
  }

  attach(host: Host | null, leader: NetId): void {
    this.host = host;
    this.leader = leader;
    this.bots = [];
    this.reader = host ? new SimReader(this.world, host.sim.ctx) : null;
  }

  setLeader(id: NetId): void {
    this.leader = id;
    for (const b of this.bots) b.mind.leader = id;
  }

  get count(): number {
    return this.bots.length;
  }

  /** Ids of the bots in play. */
  ids(): NetId[] {
    return this.bots.map((b) => b.id);
  }

  /** What each bot is doing (tools, debugging). */
  doing(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const b of this.bots) out[String(b.id)] = b.mind.doing + (DEBUG_BOTS ? b.mind.dbg : '');
    return out;
  }

  /** Add or remove bots until there are `n` (0..3). */
  set(n: number): void {
    const host = this.host;
    if (!host) return;
    n = Math.max(0, Math.min(3, Math.floor(n)));
    while (this.bots.length > n) {
      const b = this.bots.pop()!;
      host.removeBot(b.id);
    }
    while (this.bots.length < n) {
      const i = this.bots.length;
      const p = host.addBot(NAMES[i] ?? 'Bot ' + (i + 1));
      const mind = new Mind(p.id, 'follow', i % 2 ? 1 : -1);
      mind.leader = this.leader;
      this.bots.push({ id: p.id, mind });
    }
  }

  /** Once per host tick, before host.tick(): every bot decides and sends its command. */
  tick(dt: number): void {
    const host = this.host, r = this.reader;
    if (!host || !r || this.bots.length === 0) return;
    this.planner.fires = litFires(r, this.planner.fires);
    for (const b of this.bots) {
      this.link.id = b.id;
      b.mind.tick(r, this.planner, dt, this.link);
    }
  }
}

/** The lit fires as x, z pairs (for the planner's keep-out rings). */
export function litFires(r: Reader, out: number[]): number[] {
  out.length = 0;
  for (const f of r.list('fire')) if (f.lit || f.embers > 0) out.push(f.x, f.z);
  return out;
}


