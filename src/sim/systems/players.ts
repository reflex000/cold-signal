// Players: each tick, every player's latest command goes through the shared movement function
// (the same one the owning client predicts with); footsteps, jumps and landings become events.
// Also the starting kit and the 'equip' action.
// Owner: SIM.
import type { System } from '../api';
import { movePlayer, strideLength, WALK_SPEED, type Gait } from '../move';
import type { NetId, PlayerEnt, ToolId } from '../types';

const TOOLS: readonly ToolId[] = ['hands', 'axe', 'flashlight', 'flaregun', 'rifle', 'radio'];

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

  join(_ctx, p) {
    // What everyone crawls out of the fuselage with. (join runs only for a new body: a client that
    // takes back a player from a save is handed the existing entity, pack and all.)
    p.inv.flashlight = 1;
    p.inv.matches = 6;
    p.held = 'hands';
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
