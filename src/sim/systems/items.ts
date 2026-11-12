// Items: what a player carries. Taking pickups (a press of USE) and opening crates (a short hold)
// on the entity the client says is under the crosshair (InputCmd.focus, checked here for reach and
// line of sight), carrying limits (entities.ts CARRY_LIMIT), eating, drinking and bandaging, dropping
// and handing things over. Picking up a radio part marks it held in the objective (the rest of the
// objective is the objective system's). A player who leaves sets down everything they carried.
//
// Also the helpers the other survival systems share: the reach check for their own focus kinds,
// putting items into and out of a pack, setting a pickup down on the ground, and toasts.
// Owner: SURVIVAL.
import type { SimCtx, System } from '../api';
import { CARRY_LIMIT, isItemId, makePickup, packRoom } from '../entities';
import { EYE_CROUCH, EYE_DOWNED, EYE_STAND, EYE_SWIM } from '../move';
import { BTN, type CrateEnt, type Entity, type EntityKind, type ItemId, type PartId, type PickupEnt, type PlayerEnt, type ToastKind } from '../types';

/** Metres from the eye to an entity's aim point (the same as game/focus.ts REACH). */
export const REACH = 2.6;
/** The client picked from a view up to ~100 ms old and the player kept moving: a little allowance. */
const REACH_SLACK = 0.5;
/** Aim point height above the entity and its radius, per kind (the shapes game/focus.ts picks with). */
export const AIM: Readonly<Record<string, { r: number; y: number }>> = {
  pickup: { r: 0.28, y: 0.1 },
  crate: { r: 0.45, y: 0.35 },
  fire: { r: 0.6, y: 0.3 },
  wood: { r: 0.5, y: 0.6 },
  log: { r: 0.45, y: 0.25 },
  device: { r: 0.45, y: 0.9 },
  player: { r: 0.5, y: 0.35 },
};
const AIM_DEFAULT = { r: 0.4, y: 0.3 };

/** Seconds USE is held on a crate to open it. */
export const CRATE_HOLD = 0.6;
/** Seconds the eat / drink / bandage motion lasts (PlayerAct 'eat'). */
export const EAT_TIME = 1.6;
/** Metres between two players for a hand-over. */
export const GIVE_RANGE = 3;
export const BANDAGE_HEAL = 35;

// Warmth from the thermos and from food, counted down by thermal.ts: seconds left per player.
export const HOT_KEY = 'thermal.hot.';
export const FOOD_KEY = 'thermal.food.';
export const HOT_SECONDS = 45;
export const FOOD_SECONDS = 60;

const CRATE_KEY = 'items.crate.'; // the crate a player is holding USE on

const PLURAL: Partial<Record<ItemId, string>> = {
  stick: 'sticks', log: 'split logs', tinder: 'tinder', matches: 'matches', flare: 'flare cartridges', ammo: 'rounds',
  cell: 'cells', bandage: 'bandages', ration: 'rations', thermos: 'flasks',
};

const PART_OF: Partial<Record<ItemId, PartId>> = {
  part_battery: 'battery', part_handset: 'handset', part_coil: 'coil', part_tube: 'tube', part_fuse: 'fuse',
};
const TOOL_ITEMS: readonly ItemId[] = ['axe', 'flashlight', 'flaregun', 'rifle', 'radio'];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Eye height above the feet for the player's stance. */
export function eyeHeight(p: PlayerEnt): number {
  return p.swim ? EYE_SWIM : p.life === 'downed' ? EYE_DOWNED : p.crouch ? EYE_CROUCH : EYE_STAND;
}

/**
 * Can `p` reach `e` from where they stand: the eye within REACH of the entity's aim point (plus its
 * radius, a little allowance and `extra`), and nothing solid in between. The sight line stops short
 * of the thing itself, which stands inside its own collider (a crate, the stove).
 */
export function canReach(ctx: SimCtx, p: PlayerEnt, e: Entity, extra = 0): boolean {
  const sh = AIM[e.kind] ?? AIM_DEFAULT;
  const ex = p.x, ey = p.y + eyeHeight(p), ez = p.z;
  const tx = e.x - ex, ty = e.y + sh.y - ey, tz = e.z - ez;
  const d = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (d > REACH + sh.r + REACH_SLACK + extra) return false;
  const k = d > 1e-3 ? Math.max(0, d - sh.r - 0.15) / d : 0;
  return k <= 0 || ctx.world.lineClear(ex, ey, ez, ex + tx * k, ey + ty * k, ez + tz * k);
}

/** The entity the player's command points at, if it is of this kind. Reach is not checked. */
export function focusOf<K extends EntityKind>(ctx: SimCtx, p: PlayerEnt, kind: K): Extract<Entity, { kind: K }> | undefined {
  const id = ctx.input(p.id).focus;
  if (!id) return undefined;
  const e = ctx.get(id);
  return e && e.kind === kind ? (e as Extract<Entity, { kind: K }>) : undefined;
}

/** A line on the screen of one player (bots have no screen). */
export function toast(ctx: SimCtx, p: PlayerEnt, kind: ToastKind, text: string, item?: ItemId): void {
  if (p.bot) return;
  ctx.emit(item ? { t: 'toast', to: p.id, kind, text, item } : { t: 'toast', to: p.id, kind, text });
}

/** Text for a pack with no room for `item`. */
export function fullText(item: ItemId): string {
  return CARRY_LIMIT[item] <= 1 ? 'You already carry one.' : `Your pack holds no more ${PLURAL[item] ?? item}.`;
}

/**
 * Put up to `n` of `item` into the pack. Returns how many went in. Emits 'pickup' (the client turns
 * it into the "+n" toast); a radio part becomes 'held' in the objective, with 'partFound' the first
 * time it is found (and again if it was set down and taken back).
 */
export function takeItem(ctx: SimCtx, p: PlayerEnt, item: ItemId, n: number): number {
  const k = Math.min(Math.floor(n), packRoom(p.inv, item));
  if (k <= 0) return 0;
  p.inv[item] = (p.inv[item] ?? 0) + k;
  ctx.emit({ t: 'pickup', by: p.id, item, n: k });
  const part = PART_OF[item];
  if (part) {
    const parts = ctx.state.objective.parts;
    if (parts[part] === 'lost') {
      parts[part] = 'held';
      ctx.emit({ t: 'partFound', by: p.id, part });
    }
  }
  return k;
}

/**
 * Take `n` of `item` out of the pack (the caller checked there are that many). A tool in hand that
 * runs out goes back to bare hands; a radio part nobody carries any more is 'lost' again.
 */
export function removeItem(ctx: SimCtx, p: PlayerEnt, item: ItemId, n: number): void {
  const left = (p.inv[item] ?? 0) - n;
  if (left > 0) p.inv[item] = left;
  else delete p.inv[item];
  if (left <= 0 && p.held === item && TOOL_ITEMS.includes(item)) {
    p.held = 'hands';
    ctx.emit({ t: 'equip', id: p.id, tool: 'hands' });
  }
  const part = PART_OF[item];
  if (part && left <= 0) releasePart(ctx, part, item);
}

function releasePart(ctx: SimCtx, part: PartId, item: ItemId): void {
  const parts = ctx.state.objective.parts;
  if (parts[part] !== 'held') return;
  for (const q of ctx.players()) if ((q.inv[item] ?? 0) > 0) return;
  parts[part] = 'lost';
}

/** Set `n` of `item` down on the ground (or a floor) at x, z, near height y0. */
export function spawnPickup(ctx: SimCtx, item: ItemId, n: number, x: number, z: number, y0: number, yaw: number): PickupEnt {
  const g = ctx.world.groundAt(x, z, y0 + 0.5);
  const lie = g.surface === 'snow' || g.surface === 'deep' ? 'snow' : 'ground';
  return ctx.spawn<PickupEnt>(makePickup(item, n, x, g.y, z, { yaw, lie }));
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

function take(ctx: SimCtx, p: PlayerEnt, pk: PickupEnt): void {
  const k = takeItem(ctx, p, pk.item, pk.n);
  if (k <= 0) {
    toast(ctx, p, 'warn', fullText(pk.item), pk.item);
    return;
  }
  if (k >= pk.n) ctx.remove(pk.id);
  else {
    pk.n -= k;
    ctx.touch(pk);
    toast(ctx, p, 'warn', fullText(pk.item), pk.item);
  }
}

function openCrate(ctx: SimCtx, p: PlayerEnt, c: CrateEnt): void {
  c.open = true;
  ctx.emit({ t: 'open', by: p.id, id: c.id });
  let spilled = 0;
  // What does not fit is set down between the crate and the player, where it can be seen.
  const dx = p.x - c.x, dz = p.z - c.z;
  const dl = Math.hypot(dx, dz) || 1;
  const ux = dx / dl, uz = dz / dl;
  for (const l of c.loot) {
    const k = takeItem(ctx, p, l.item, l.n);
    if (k < l.n) {
      const side = (spilled - 0.5) * 0.45;
      spawnPickup(ctx, l.item, l.n - k, c.x + ux * 0.75 - uz * side, c.z + uz * 0.75 + ux * side, c.y, c.yaw + spilled);
      spilled++;
    }
  }
  if (spilled > 0) toast(ctx, p, 'warn', 'Your pack is full. The rest is on the ground.');
  c.loot = [];
  ctx.touch(c);
}

/** Hold USE on a closed crate to open it. Progress is PlayerAct 'use' and actT (the HUD ring reads it). */
function crateHold(ctx: SimCtx, p: PlayerEnt): void {
  const key = CRATE_KEY + p.id;
  const holdingId = ctx.state.vars[key];
  const c = ctx.held(p.id, BTN.USE) ? focusOf(ctx, p, 'crate') : undefined;
  const ok = c !== undefined && !c.open && canReach(ctx, p, c);
  if (ok && holdingId === c.id && p.act === 'use') {
    p.actT += ctx.dt;
    if (p.actT >= CRATE_HOLD) {
      openCrate(ctx, p, c);
      p.act = 'none';
      p.actT = 0;
      delete ctx.state.vars[key];
    }
    return;
  }
  if (holdingId !== undefined) {
    // let go, looked away or walked off: start over
    delete ctx.state.vars[key];
    if (p.act === 'use') {
      p.act = 'none';
      p.actT = 0;
    }
  }
  if (ok && p.act === 'none') {
    p.act = 'use';
    p.actT = ctx.dt;
    ctx.state.vars[key] = c.id;
  }
}

function consume(ctx: SimCtx, p: PlayerEnt, item: 'bandage' | 'ration' | 'thermos'): void {
  if ((p.inv[item] ?? 0) <= 0) {
    toast(ctx, p, 'info', `You have no ${PLURAL[item]}.`);
    return;
  }
  if (item === 'bandage' && p.health >= 100) {
    toast(ctx, p, 'info', 'You are not hurt.');
    return;
  }
  removeItem(ctx, p, item, 1);
  if (item === 'bandage') p.health = Math.min(100, p.health + BANDAGE_HEAL);
  else if (item === 'ration') {
    p.hunger = 0;
    ctx.setV(FOOD_KEY + p.id, FOOD_SECONDS);
  } else ctx.setV(HOT_KEY + p.id, HOT_SECONDS);
  if (p.act === 'none') {
    p.act = 'eat';
    p.actT = 0;
  }
}

function drop(ctx: SimCtx, p: PlayerEnt, item: ItemId, n: number): void {
  removeItem(ctx, p, item, n);
  // just in front of the feet, unless a wall is there
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
  let x = p.x + fx * 0.7, z = p.z + fz * 0.7;
  if (!ctx.world.lineClear(p.x, p.y + 1, p.z, x, p.y + 0.3, z)) {
    x = p.x;
    z = p.z;
  }
  spawnPickup(ctx, item, n, x, z, p.y, p.yaw);
}

function give(ctx: SimCtx, p: PlayerEnt, to: PlayerEnt, item: ItemId, n: number): void {
  const d = Math.hypot(to.x - p.x, to.y - p.y, to.z - p.z);
  if (d > GIVE_RANGE + 0.25) {
    toast(ctx, p, 'info', `${to.name} is too far away.`);
    return;
  }
  // into the other pack first, so a radio part is never "lost" in between
  const k = takeItem(ctx, to, item, n);
  if (k <= 0) {
    toast(ctx, p, 'info', `${to.name} cannot carry any more of that.`);
    return;
  }
  removeItem(ctx, p, item, k);
  toast(ctx, p, 'info', k < n ? `${to.name} had room for ${k}.` : `Handed to ${to.name}.`);
}

export const items: System = {
  name: 'items',

  step(ctx) {
    const list = ctx.players();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p.life !== 'alive') {
        if (ctx.state.vars[CRATE_KEY + p.id] !== undefined) delete ctx.state.vars[CRATE_KEY + p.id];
        if (p.act === 'use' || p.act === 'eat') {
          p.act = 'none';
          p.actT = 0;
        }
        continue;
      }
      if (p.act === 'eat') {
        p.actT += ctx.dt;
        if (p.actT >= EAT_TIME) {
          p.act = 'none';
          p.actT = 0;
        }
      }
      if (ctx.pressed(p.id, BTN.USE)) {
        const pk = focusOf(ctx, p, 'pickup');
        if (pk && canReach(ctx, p, pk)) take(ctx, p, pk);
      }
      crateHold(ctx, p);
    }
  },

  action(ctx, p, a) {
    switch (a.t) {
      case 'consume': {
        const item = a.item;
        if (item !== 'bandage' && item !== 'ration' && item !== 'thermos') return true;
        if (p.life === 'downed') return false; // a bandage while down is the vitals system's
        if (p.life === 'alive') consume(ctx, p, item);
        return true;
      }
      case 'drop': {
        if (p.life !== 'alive' || !isItemId(a.item)) return true;
        const n = Math.min(p.inv[a.item] ?? 0, Math.floor(num(a.n)));
        if (n > 0) drop(ctx, p, a.item, n);
        return true;
      }
      case 'give': {
        if (p.life !== 'alive' || !isItemId(a.item)) return true;
        const to = ctx.get(a.to);
        if (!to || to.kind !== 'player' || to.id === p.id || (to.life !== 'alive' && to.life !== 'downed')) return true;
        const n = Math.min(p.inv[a.item] ?? 0, Math.floor(num(a.n)));
        if (n > 0) give(ctx, p, to, a.item, n);
        return true;
      }
      default:
        return false;
    }
  },

  leave(ctx, p) {
    // Nothing a player carried leaves the mountain with them: it is set down where they stood.
    let k = 0;
    for (const item of Object.keys(p.inv) as ItemId[]) {
      const n = p.inv[item] ?? 0;
      if (!isItemId(item) || n <= 0) continue;
      const a = k * 2.39996 + 0.5;
      spawnPickup(ctx, item, n, p.x + Math.sin(a) * 0.7, p.z + Math.cos(a) * 0.7, p.y, a);
      k++;
    }
    const carried = Object.keys(p.inv) as ItemId[];
    p.inv = {};
    for (const item of carried) {
      const part = PART_OF[item];
      if (part) releasePart(ctx, part, item);
    }
    delete ctx.state.vars[CRATE_KEY + p.id];
  },
};
