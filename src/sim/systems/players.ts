// Players: each tick, every player's latest command goes through the shared movement function
// (the same one the owning client predicts with); footsteps, jumps and landings become events.
// Also the starting kit and the 'equip' action.
// Owner: SIM.
import { wrapAngle } from '../../core/math';
import type { World } from '../../world/types';
import type { System } from '../api';
import { movePlayer, strideLength, WALK_SPEED, type Gait } from '../move';
import type { NetId, PlayerEnt, ToolId } from '../types';

const TOOLS: readonly ToolId[] = ['hands', 'axe', 'flashlight', 'flaregun', 'rifle', 'radio'];
/** Matches each survivor crawls out with (RELEASE balance: was 6; every player brings their own, so a group
 *  of two started with twelve and ended the hour with twenty left over). */
export const START_MATCHES = 4;

/**
 * Where each slot opens a new game: inside the broken fuselage, down the aisle, looking at the torn end and
 * the dusk beyond it (fuselage-local x, z; the break is at z = -9, world/blueprints.ts FUSELAGE).
 */
const CABIN_SLOTS: readonly (readonly [number, number])[] = [[0.15, -4.4], [-0.7, -5.6], [0.72, -6.3], [-0.5, -3.4]];

/** The opening spot of a slot in this world, or null in a world with no fuselage (the test worlds). */
export function cabinStart(world: World, slot: number): { x: number; y: number; z: number; yaw: number } | null {
  const f = world.props.find((p) => p.model === 'fuselage');
  if (!f) return null;
  const [lx, lz] = CABIN_SLOTS[slot % CABIN_SLOTS.length];
  // a prop's yaw is a three.js rotation: local (x, z) turns to (x cos + z sin, -x sin + z cos), and a
  // player whose yaw equals it faces the prop's local -Z, out through the break
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  const x = f.x + lx * c + lz * s, z = f.z - lx * s + lz * c;
  return { x, y: world.groundAt(x, z, f.y + 1.5).y, z, yaw: wrapAngle(f.yaw) };
}

// The stride of each player lives in state.vars so footsteps continue in step after a load:
// 'players.stride.<id>' metres since the last footfall, 'players.foot.<id>' 1 when the left foot is next.
interface Keys { stride: string; foot: string }
const keyCache = new Map<NetId, Keys>(); // derived strings only, no state
function keysOf(id: NetId): Keys {
  let k = keyCache.get(id);
  if (!k) keyCache.set(id, (k = { stride: 'players.stride.' + id, foot: 'players.foot.' + id }));
  return k;
}

const gait: Gait = { dist: 0, left: false }; // scratch
const REST_STRIDE = 0.5 * strideLength(WALK_SPEED);

export function canEquip(p: PlayerEnt, tool: ToolId): boolean {
  if (!TOOLS.includes(tool)) return false;
  if (tool === 'hands') return true;
  return p.life === 'alive' && p.carry === 0 && !p.swim && (p.inv[tool] ?? 0) > 0;
}

export const players: System = {
  name: 'players',

  join(ctx, p) {
    // What everyone crawls out of the fuselage with. (join runs only for a new body: a client that
    // takes back a player from a save is handed the existing entity, pack and all.)
    p.inv.flashlight = 1;
    p.inv.matches = START_MATCHES;
    p.held = 'hands';
    // A new game (no tick run yet) opens inside the fuselage; anyone joining later takes their slot outside.
    if (ctx.state.tick === 0) {
      const at = cabinStart(ctx.world, p.slot);
      if (at) {
        p.x = at.x;
        p.y = at.y;
        p.z = at.z;
        p.yaw = at.yaw;
        p.pitch = 0;
      }
    }
  },

  leave(ctx, p) {
    const k = keysOf(p.id);
    delete ctx.state.vars[k.stride];
    delete ctx.state.vars[k.foot];
    keyCache.delete(p.id);
  },

  step(ctx) {
    const list = ctx.players();
    const vars = ctx.state.vars;
    const emit = ctx.emit; // closes over the sim, not `this`
    let moved = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const cmd = ctx.input(p.id);
      const k = keysOf(p.id);
      const d0 = vars[k.stride] ?? REST_STRIDE;
      const l0 = vars[k.foot] === 1;
      gait.dist = d0;
      gait.left = l0;
      const d = movePlayer(p, cmd, ctx.world, ctx.dt, gait, emit);
      p.seq = cmd.seq;
      if (gait.dist !== d0) vars[k.stride] = gait.dist;
      if (gait.left !== l0) vars[k.foot] = gait.left ? 1 : 0;
      if (p.life === 'alive' || p.life === 'downed') moved += d;
    }
    ctx.state.stats.distance += moved;
  },

  action(ctx, p, a) {
    if (a.t !== 'equip') return false;
    if (a.tool !== p.held && canEquip(p, a.tool)) {
      p.held = a.tool;
      ctx.emit({ t: 'equip', id: p.id, tool: a.tool });
    }
    return true;
  },
};
