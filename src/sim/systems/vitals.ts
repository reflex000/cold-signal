// Health and what happens when it runs out.
//   falls      damage on landing by impact speed: nothing below about a 2 m drop, death from about
//              13 m onto hard ground (the south cliff is 15 to 40 m); deep snow softens it a little.
//   cold       below 31 C (severe) health drains; at 30 C the body collapses.
//   downed     cold collapse or health 0 (wolves, falls): 90 s to bleed out, crawling (move.ts).
//   revive     another player holds USE on the downed one for 5 s within 1.5 m: up with health 30
//              and a little warmth. Alone (no other living person), a bandage gets you up once per
//              checkpoint; with teammates around it stops the bleeding (the timer starts again).
//   death      when the timer runs out. 'respawn' puts a dead player back at the last checkpoint
//              with low warmth and health; in co-op the others keep playing.
//   checkpoint resting warm (core 36+) and still beside a lit fire for 6 s; the spot is kept in
//              state.vars and 'checkpoint' is emitted (the game saves). Again at the same fire only
//              after 3 minutes.
//   isolation  how alone each player is, 0 with a teammate within 8 m .. 1 beyond 60 m or solo
//              (the wolves read it).
// Owner: SURVIVAL.
import { smoothstep } from '../../core/math';
import type { SimCtx, System } from '../api';
import { GRAVITY } from '../move';
import { BTN, type FireEnt, type HurtCause, type PlayerEnt, type Surface } from '../types';
import { focusOf, removeItem, toast } from './items';

export const BLEED_TIME = 90;
export const REVIVE_TIME = 5;
export const REVIVE_RANGE = 1.5;
export const REVIVE_HEALTH = 30;
/** Core temperatures, deg C. */
export const SEVERE_CORE = 31;
export const COLLAPSE_CORE = 30;
/** Health lost per second at 30 C (scales from 0 at 31 C). */
export const COLD_DRAIN = 1.2;
/** Landing speeds, m/s: harmless up to SAFE (a 2 m drop), certain death at LETHAL (13 m onto rock). */
export const SAFE_IMPACT = 7.5;
export const LETHAL_IMPACT = 19;
export const REST_TIME = 6;
export const REST_CORE = 36;
export const REST_RANGE = 3.5;
export const CHECKPOINT_REPEAT = 180;
export const RESPAWN_HEALTH = 35;
export const RESPAWN_CORE = 33.5;
const REVIVE_SLACK = 0.35; // the reviver's client saw the body ~100 ms ago
const REGEN = 2 / 60; // health per second while resting warm by a fire

const AIR_KEY = 'vitals.air.'; // vertical speed while airborne
const COLD_KEY = 'vitals.cold.'; // cold damage not yet reported
const REST_KEY = 'vitals.rest.'; // seconds resting warm at a fire
const SELF_KEY = 'vitals.self.'; // 1 once the solo self-revive is spent (until the next checkpoint)
export const CP = { x: 'vitals.cpX', y: 'vitals.cpY', z: 'vitals.cpZ', fire: 'vitals.cpFire', t: 'vitals.cpT' } as const;

const reviving = new Set<number>(); // scratch: downed players someone is reviving this tick

/** Health lost on landing at `impact` m/s on `surface`. 100 or more kills outright. */
export function fallDamage(impact: number, surface: Surface): number {
  const cushion = surface === 'deep' ? 1.5 : surface === 'snow' ? 0.7 : 0;
  const v = impact - cushion;
  if (v <= SAFE_IMPACT) return 0;
  return 100 * Math.pow((v - SAFE_IMPACT) / (LETHAL_IMPACT - SAFE_IMPACT), 1.6);
}

/** Down: 90 s to bleed out. `cold` only picks the words of the toast. */
function goDown(ctx: SimCtx, p: PlayerEnt, cold: boolean): void {
  p.life = 'downed';
  p.health = Math.max(0, p.health);
  p.bleed = BLEED_TIME;
  p.revive = 0;
  p.reviver = 0;
  p.act = 'none';
  p.actT = 0;
  ctx.emit({ t: 'downed', id: p.id });
  ctx.state.stats.downs++;
  // the HUD's downed panel says the rest (crawl, the timer, who can help); the hurt events before
  // this tell the death screen why
  if (cold) toast(ctx, p, 'warn', 'The cold takes your legs.');
}

function die(ctx: SimCtx, p: PlayerEnt): void {
  p.life = 'dead';
  p.health = 0;
  p.bleed = 0;
  p.revive = 0;
  p.reviver = 0;
  p.act = 'none';
  p.actT = 0;
  ctx.emit({ t: 'died', id: p.id });
}

/** Back on their feet with health 30 and a little warmth. */
function getUp(ctx: SimCtx, p: PlayerEnt, by: number): void {
  p.life = 'alive';
  p.health = REVIVE_HEALTH;
  p.core = Math.max(p.core + 1.2, 32);
  p.bleed = 0;
  p.revive = 0;
  p.reviver = 0;
  p.act = 'none';
  p.actT = 0;
  delete ctx.state.vars[COLD_KEY + p.id];
  ctx.emit({ t: 'revived', id: p.id, by });
}

/** Damage from a cause other than the slow cold drain. */
export function hurt(ctx: SimCtx, p: PlayerEnt, amount: number, cause: HurtCause): void {
  if (amount <= 0 || (p.life !== 'alive' && p.life !== 'downed')) return;
  const lethal = amount >= 100;
  ctx.emit({ t: 'hurt', id: p.id, amount: Math.round(Math.min(amount, Math.max(p.health, 1)) * 10) / 10, cause });
  if (p.life === 'downed') {
    if (lethal) die(ctx, p);
    else p.bleed = Math.max(0, p.bleed - amount * 0.5);
    return;
  }
  p.health = Math.max(0, p.health - amount);
  if (lethal) die(ctx, p);
  else if (p.health <= 0) goDown(ctx, p, cause === 'cold');
}

function land(ctx: SimCtx, p: PlayerEnt): void {
  const vars = ctx.state.vars, key = AIR_KEY + p.id;
  if (p.onGround || p.swim || p.life === 'dead' || p.life === 'rescued') {
    const vy0 = vars[key];
    if (vy0 === undefined) return;
    delete vars[key];
    // the same impact move.ts reports in 'land': the speed before the landing tick plus its gravity
    if (!p.swim && p.onGround) hurt(ctx, p, fallDamage(GRAVITY * ctx.dt - vy0, p.surface), 'fall');
    return;
  }
  vars[key] = p.vy;
}

function coldDrain(ctx: SimCtx, p: PlayerEnt): void {
  const vars = ctx.state.vars, key = COLD_KEY + p.id;
  if (p.core >= SEVERE_CORE) {
    if (vars[key] !== undefined) delete vars[key];
    return;
  }
  const loss = COLD_DRAIN * Math.min(1, SEVERE_CORE - p.core) * ctx.dt;
  p.health = Math.max(0, p.health - loss);
  const acc = (vars[key] ?? 0) + loss;
  // reported in small lumps, so the HUD pulses rather than flickers
  if (acc >= 2 || p.health <= 0 || p.core <= COLLAPSE_CORE) {
    ctx.emit({ t: 'hurt', id: p.id, amount: Math.round(Math.max(acc, 0.1) * 10) / 10, cause: 'cold' });
    delete vars[key];
  } else vars[key] = acc;
}

/** The nearest lit fire a player could rest at, or undefined. */
function restingFire(ctx: SimCtx, p: PlayerEnt): FireEnt | undefined {
  let best: FireEnt | undefined;
  let bd = REST_RANGE * REST_RANGE;
  for (const f of ctx.all('fire')) {
    if (!f.lit || f.heat < 0.2 || Math.abs(f.y - p.y) > 2) continue;
    const d = (f.x - p.x) * (f.x - p.x) + (f.z - p.z) * (f.z - p.z);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

function rest(ctx: SimCtx, p: PlayerEnt): void {
  const vars = ctx.state.vars, key = REST_KEY + p.id;
  const f = p.core >= REST_CORE && !p.swim && Math.hypot(p.vx, p.vz) < 0.8 ? restingFire(ctx, p) : undefined;
  if (!f) {
    if (vars[key] !== undefined) delete vars[key];
    return;
  }
  const r = Math.min(REST_TIME, (vars[key] ?? 0) + ctx.dt);
  vars[key] = r;
  if (r < REST_TIME) return;
  const t = ctx.state.env.t;
  if (vars[CP.fire] === f.id && t - (vars[CP.t] ?? -1e9) < CHECKPOINT_REPEAT) return;
  vars[CP.x] = p.x;
  vars[CP.y] = p.y;
  vars[CP.z] = p.z;
  vars[CP.fire] = f.id;
  vars[CP.t] = t;
  // a new checkpoint gives everyone their solo self-revive back
  for (const q of ctx.players()) delete vars[SELF_KEY + q.id];
  ctx.emit({ t: 'checkpoint' });
}

/** A free spot to stand near x, z (not inside anything, not in a fire, not on another player). */
function freeSpot(ctx: SimCtx, p: PlayerEnt, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const w = ctx.world;
  const fires = ctx.all('fire'), players = ctx.players();
  const ok = (sx: number, sz: number): boolean => {
    if (!w.walkable(sx, sz)) return false;
    if (Math.abs(w.groundAt(sx, sz, y + 0.5).y - y) > 1.5) return false;
    for (const f of fires) if ((f.x - sx) * (f.x - sx) + (f.z - sz) * (f.z - sz) < 0.9 * 0.9) return false;
    for (const q of players) if (q !== p && q.life !== 'dead' && (q.x - sx) * (q.x - sx) + (q.z - sz) * (q.z - sz) < 0.7 * 0.7) return false;
    return true;
  };
  const a0 = p.slot * 1.7;
  for (const r of [0, 1.2, 2.2, 3.2]) {
    const n = r === 0 ? 1 : 8;
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / n) * Math.PI * 2;
      const sx = x + Math.sin(a) * r, sz = z + Math.cos(a) * r;
      if (ok(sx, sz)) return { x: sx, y: w.groundAt(sx, sz, y + 0.5).y, z: sz };
    }
  }
  return { x, y: w.groundAt(x, z, y + 0.5).y, z };
}

function respawn(ctx: SimCtx, p: PlayerEnt): void {
  const vars = ctx.state.vars, w = ctx.world;
  const has = vars[CP.x] !== undefined;
  let x: number, y: number, z: number;
  if (has) {
    x = vars[CP.x];
    y = vars[CP.y] ?? w.heightAt(vars[CP.x], vars[CP.z] ?? 0);
    z = vars[CP.z] ?? 0;
  } else {
    const spots = w.spawn.players;
    const s = spots.length > 0 ? spots[p.slot % spots.length] : { x: 0, y: w.heightAt(0, 0), z: 0 };
    x = s.x;
    y = s.y;
    z = s.z;
  }
  const s = freeSpot(ctx, p, x, y, z);
  p.x = s.x;
  p.y = s.y;
  p.z = s.z;
  p.vx = p.vy = p.vz = 0;
  p.onGround = true;
  p.swim = false;
  p.life = 'alive';
  p.health = RESPAWN_HEALTH;
  p.core = RESPAWN_CORE;
  p.wet = 0;
  p.stamina = 0.6;
  p.bleed = 0;
  p.revive = 0;
  p.reviver = 0;
  p.act = 'none';
  p.actT = 0;
  p.trend = 0;
  p.surface = w.groundAt(s.x, s.z, s.y + 0.1).surface;
  delete vars[AIR_KEY + p.id];
  delete vars[COLD_KEY + p.id];
  delete vars[REST_KEY + p.id];
  toast(ctx, p, 'info', has ? 'You wake by the fire.' : 'You wake by the wreck.');
}

/** Alone: no other living person (companion bots do not count). */
function alone(ctx: SimCtx, p: PlayerEnt): boolean {
  for (const q of ctx.players()) if (q !== p && !q.bot && q.life === 'alive') return false;
  return true;
}

function bandageWhileDown(ctx: SimCtx, p: PlayerEnt): void {
  if ((p.inv.bandage ?? 0) <= 0) {
    toast(ctx, p, 'info', 'You have no bandages.');
    return;
  }
  if (!alone(ctx, p)) {
    removeItem(ctx, p, 'bandage', 1);
    p.bleed = BLEED_TIME;
    toast(ctx, p, 'info', 'The bleeding stops. Hold on.');
    return;
  }
  if (ctx.v(SELF_KEY + p.id) > 0) {
    toast(ctx, p, 'info', 'You have no strength left to get up. Rest at a fire first.');
    return;
  }
  removeItem(ctx, p, 'bandage', 1);
  ctx.setV(SELF_KEY + p.id, 1);
  getUp(ctx, p, p.id);
  toast(ctx, p, 'info', 'You bind the wound and get to your feet.');
}

/** Revivers holding USE on a downed teammate within reach. */
function revives(ctx: SimCtx, players: readonly PlayerEnt[]): void {
  reviving.clear();
  const dt = ctx.dt;
  for (let i = 0; i < players.length; i++) {
    const r = players[i];
    if (r.life !== 'alive') continue;
    const d = ctx.held(r.id, BTN.USE) ? focusOf(ctx, r, 'player') : undefined;
    const ok = d !== undefined && d.id !== r.id && d.life === 'downed' && !reviving.has(d.id) &&
      Math.hypot(d.x - r.x, d.z - r.z) <= REVIVE_RANGE + REVIVE_SLACK && Math.abs(d.y - r.y) < 1.2 &&
      (r.act === 'none' || r.act === 'revive');
    if (!ok) {
      if (r.act === 'revive') {
        r.act = 'none';
        r.actT = 0;
      }
      continue;
    }
    if (r.act !== 'revive') {
      r.act = 'revive';
      r.actT = 0;
    }
    r.actT += dt;
    reviving.add(d.id);
    d.reviver = r.id;
    d.revive = Math.min(1, d.revive + dt / REVIVE_TIME);
    if (d.revive >= 1) {
      getUp(ctx, d, r.id);
      ctx.state.stats.revives++;
      r.act = 'none';
      r.actT = 0;
    }
  }
}

export const vitals: System = {
  name: 'vitals',

  step(ctx) {
    const players = ctx.players();
    const dt = ctx.dt;
    revives(ctx, players);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      land(ctx, p);
      if (p.life === 'alive') {
        coldDrain(ctx, p);
        // health taken by anything (the cold here, wolves, a fall) or the cold collapse
        if (p.health <= 0 || p.core <= COLLAPSE_CORE) goDown(ctx, p, p.core < SEVERE_CORE);
        else {
          if (p.health < 100 && p.core >= 36.5 && p.fireHeat >= 0.3 && p.hunger < 0.8) p.health = Math.min(100, p.health + REGEN * dt);
          rest(ctx, p);
        }
      } else if (p.life === 'downed') {
        if (!reviving.has(p.id)) {
          if (p.revive > 0) p.revive = Math.max(0, p.revive - dt / 1.5);
          if (p.revive === 0) p.reviver = 0;
          p.bleed = Math.max(0, p.bleed - dt);
        }
        if (p.bleed <= 0) die(ctx, p);
      }
      // isolation: the distance to the nearest living teammate
      let near = Infinity;
      for (let j = 0; j < players.length; j++) {
        const q = players[j];
        if (q === p || q.life !== 'alive') continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d < near) near = d;
      }
      p.isolation = near === Infinity ? 1 : smoothstep(8, 60, near);
    }
  },

  action(ctx, p, a) {
    if (a.t === 'consume' && a.item === 'bandage' && p.life === 'downed') {
      bandageWhileDown(ctx, p);
      return true;
    }
    if (a.t === 'respawn') {
      if (p.life === 'dead') respawn(ctx, p);
      return true;
    }
    return false;
  },

  leave(ctx, p) {
    const vars = ctx.state.vars;
    delete vars[AIR_KEY + p.id];
    delete vars[COLD_KEY + p.id];
    delete vars[REST_KEY + p.id];
    delete vars[SELF_KEY + p.id];
    for (const q of ctx.players()) {
      if (q.reviver === p.id) {
        q.reviver = 0;
        q.revive = 0;
      }
    }
  },
};
