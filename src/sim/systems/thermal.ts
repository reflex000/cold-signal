// Body temperature for every player, every tick. What moves `core`:
//   air      env.airTemp is at the crash site's altitude; 0.65 C colder per 100 m of height.
//            Indoors (a shelter volume marked indoor) the walls hold 10 C of it back.
//   wind     the mean wind plus the gust, scaled by 1 - shelter (world.shelterAt: volumes, the lee of
//            the ground and rocks upwind, the canopy). Colder air makes the wind bite harder.
//   wet      falling snow soaks slowly unless sheltered; the water under the ice soaks at once; wet
//            clothes triple the heat lost and only dry by a fire or indoors.
//   work     the body balances at a colder air the harder it works: standing still loses the most,
//            walking less, sprinting or chopping warms in mild air. Lying in the snow loses the most.
//   fire     lit fires within their radius (about 6 m), falling with distance, blown downwind off an
//            open fire (stand upwind and it barely reaches you), blocked by walls.
//   huddle   other players within 2.5 m share warmth.
//   food     hunger rises slowly (faster when cold); a hungry body warms slowly and loses more. A
//            ration resets it; the thermos and a ration warm for a while after (items.ts sets them).
// In deg C per minute, calibrated by thermal.test.ts against DESIGN section 1 (exposed in a full
// storm 37 -> 33 in 4 to 5 minutes, wet in a whiteout about 90 s, a good fire 33 -> 37 in about two):
//   loss = (KT (Tn - T) + KW wind g(T)) * (1 + 2.3 wet) * (1 + 0.2 hunger) * (1 - 0.6 fire) * (1 - 0.35 huddle)
//   gain = (4.5 fire + 0.35 huddle + thermos + ration) * (1 - 0.4 hunger)
// T is the air at the body, wind the felt speed, g(T) = 1 + (colder than -10) / 40, Tn the air the
// body balances at for what it is doing (BALANCE). Measured (thermal.test.ts, dusk; RELEASE retune): full storm
// walking 269 s, standing 237 s; soaked 95 s; moderate storm 37 -> 35 in 5.8 min; clear night the
// same; clear day never; open fire across a 10 m/s wind 33 -> 37 in 122 s (upwind 163, downwind 97).
// Fills core, wet, hunger and what the body feels for the HUD, frost and audio: feels (a wind chill
// temperature, plus the fire and the huddle), shelter, fireHeat, huddle, trend (deg C per minute,
// smoothed). Health, collapse and death follow from core in vitals.ts.
// Owner: SURVIVAL.
import { clamp, sat } from '../../core/math';
import type { World } from '../../world/types';
import type { SimCtx, System } from '../api';
import type { FireEnt, PlayerEnt } from '../types';
import { WARM_RADIUS } from './fire';
import { FOOD_KEY, HOT_KEY } from './items';

/** Degrees C of cooling per metre of height. */
export const LAPSE = 0.65 / 100;
export const CORE_MAX = 37;
export const CORE_MIN = 24;
/** Degrees warmer indoors than out (walls and a roof, no fire). */
export const INDOOR_BONUS = 10;

const KT = 0.020; // deg C / min per degree of air below the balance point (RELEASE balance: was 0.022)
const KW = 0.0275; // deg C / min per m/s of felt wind (RELEASE balance: was 0.030)
/** Air temperature (deg C) the body balances at, by what it is doing. */
export const BALANCE = { still: -4.8, walk: -10.8, sprint: -22.8, work: -16.8, down: -2.8 } as const;
const SELF_WARM_MAX = 0.5; // deg C / min a working body gains in mild air
export const FIRE_GAIN = 4.5; // deg C / min at full fire warmth
const FIRE_CUT = 0.6; // share of the loss a fire's warmth takes away
const FIRE_FEEL = 38; // degrees the fire adds to what the body feels
export const HUDDLE_RANGE = 2.5;
const HUDDLE_GAIN = 0.35;
const HUDDLE_CUT = 0.35;
const HUDDLE_FEEL = 5;
const WET_LOSS = 2.3; // fully wet: 3.3 times the loss (RELEASE: was 2, raised with KT / KW lowered so a soaking stays about 90 s)
// Wet per second in full snowfall, exposed: slow (an eighth wet after four minutes of whiteout), so
// a whiteout alone takes 4 to 5 minutes and a soaking (the lake) is what makes it 90 seconds.
const SOAK = 0.0005;
const DRY_FIRE = 1 / 100; // per second at full fire warmth
const DRY_INDOOR = 1 / 400;
const IMMERSION = 3.5; // deg C / min in the water under the ice
/** Seconds for hunger to go from fed to starving at rest. */
export const HUNGER_TIME = 2700;
export const HOT_RATE = 3; // deg C / min from the thermos while it lasts (items.ts HOT_SECONDS)
export const FOOD_RATE = 0.6; // deg C / min after a ration (items.ts FOOD_SECONDS)
const TREND_TAU = 1.5; // seconds

/** What the body is exposed to this tick, for coreRate. */
export interface Exposure {
  air: number; // deg C at the body, indoor bonus included
  wind: number; // felt wind, m/s
  balance: number; // BALANCE for what the body is doing
  wet: number;
  hunger: number;
  fire: number; // 0..1
  huddle: number; // 0..1
  boost: number; // deg C / min from the thermos and food
  swim: boolean;
}

/** Change of core temperature, deg C per minute (before the 37 C ceiling). */
export function coreRate(x: Exposure): number {
  const warmMul = 1 - 0.4 * x.hunger;
  const gain = (FIRE_GAIN * x.fire + HUDDLE_GAIN * x.huddle + x.boost) * warmMul;
  if (x.swim) return gain * 0.3 - IMMERSION;
  const bite = 1 + Math.max(0, -10 - x.air) / 40;
  const raw = KT * (x.balance - x.air) + KW * x.wind * bite;
  if (raw <= 0) return gain + Math.min(SELF_WARM_MAX, -raw) * warmMul;
  return gain - raw * (1 + WET_LOSS * x.wet) * (1 + 0.2 * x.hunger) * (1 - FIRE_CUT * x.fire) * (1 - HUDDLE_CUT * x.huddle);
}

/** Wind chill temperature (deg C) for air T and wind in m/s (the North American index). */
export function windChill(t: number, wind: number): number {
  const kmh = wind * 3.6;
  if (kmh < 4.8 || t > 10) return t;
  const v = Math.pow(kmh, 0.16);
  return 13.12 + 0.6215 * t - 11.37 * v + 0.3965 * t * v;
}

const crashAlt = new WeakMap<World, number>();
/** Height of the crash site, where env.airTemp is measured. */
export function crashAltitude(w: World): number {
  let a = crashAlt.get(w);
  if (a === undefined) {
    a = w.poi('wreck').y;
    crashAlt.set(w, a);
  }
  return a;
}

/** Air temperature at height y, deg C. */
export function airAt(ctx: SimCtx, y: number): number {
  return ctx.state.env.airTemp - LAPSE * (y - crashAltitude(ctx.world));
}

/**
 * Warmth 0..1 one fire gives a body standing at (px, py, pz). `ux, uz` is the unit direction the
 * air moves toward and `speed` the wind, m/s.
 */
export function warmthFrom(ctx: SimCtx, f: FireEnt, px: number, py: number, pz: number, ux: number, uz: number, speed: number): number {
  if (f.heat <= 0.001) return 0;
  const dy = py - f.y;
  if (dy > 2.5 || dy < -2.5) return 0; // another floor
  const dx = px - f.x, dz = pz - f.z;
  const R = WARM_RADIUS[f.type];
  const d2 = dx * dx + dz * dz;
  if (d2 >= R * R) return 0;
  const d = Math.sqrt(d2);
  let c = f.heat * Math.pow(sat(1 - (d - 1) / (R - 1)), 1.4);
  if (f.type !== 'stove' && d > 0.05) {
    // The wind carries the heat off downwind: upwind of an open fire it barely reaches you.
    const w = sat((speed - 3) / 15) * (1 - f.shelter);
    if (w > 0) c *= Math.max(0, 1 - w * (0.5 - 0.35 * ((dx * ux + dz * uz) / d)));
  }
  if (c <= 0.001) return 0;
  if (d > 0.6) {
    // walls in between (the sight line starts just outside the fire's own barrel or stove)
    const k = 0.55 / d;
    if (!ctx.world.lineClear(f.x + dx * k, f.y + 0.5, f.z + dz * k, px, py + 1, pz)) c *= 0.1;
  }
  return c;
}

/** Seconds left on a timed warmth var; counts it down. Returns true while it lasts. */
function tick(vars: Record<string, number>, key: string, dt: number): boolean {
  const left = vars[key];
  if (left === undefined) return false;
  if (left - dt <= 0) delete vars[key];
  else vars[key] = left - dt;
  return true;
}

const ex: Exposure = { air: 0, wind: 0, balance: 0, wet: 0, hunger: 0, fire: 0, huddle: 0, boost: 0, swim: false };

function body(ctx: SimCtx, p: PlayerEnt, players: readonly PlayerEnt[], fires: readonly FireEnt[], ux: number, uz: number, speed: number, trendK: number): void {
  const env = ctx.state.env, vars = ctx.state.vars, dt = ctx.dt;
  const sh = ctx.world.shelterAt(p.x, p.y + 1, p.z, env.windX, env.windZ);
  const shelter = sat(sh.amount);
  const indoor = sh.indoor;
  p.shelter = shelter;

  let keep = 1;
  for (let i = 0; i < fires.length; i++) {
    const c = warmthFrom(ctx, fires[i], p.x, p.y, p.z, ux, uz, speed);
    if (c > 0) keep *= 1 - c;
  }
  const fire = sat(1 - keep);
  p.fireHeat = fire;

  let hs = 0;
  for (let i = 0; i < players.length; i++) {
    const q = players[i];
    if (q === p || (q.life !== 'alive' && q.life !== 'downed')) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (d < HUDDLE_RANGE) hs += (1 - d / HUDDLE_RANGE) * 0.7;
  }
  const huddle = sat(hs);
  p.huddle = huddle;

  const moving = Math.hypot(p.vx, p.vz) > 0.4;
  ex.air = airAt(ctx, p.y) + (indoor ? INDOOR_BONUS : 0);
  ex.wind = speed * (1 - shelter);
  ex.balance = p.life === 'downed' ? BALANCE.down : p.sprint ? BALANCE.sprint : p.act === 'swing' ? BALANCE.work : moving ? BALANCE.walk : BALANCE.still;
  ex.wet = p.wet;
  ex.hunger = p.hunger;
  ex.fire = fire;
  ex.huddle = huddle;
  ex.boost = (tick(vars, HOT_KEY + p.id, dt) ? HOT_RATE : 0) + (tick(vars, FOOD_KEY + p.id, dt) ? FOOD_RATE : 0);
  ex.swim = p.swim;
  let rate = coreRate(ex);
  if (rate > 0 && p.core >= CORE_MAX) rate = 0;
  p.core = clamp(p.core + (rate * dt) / 60, CORE_MIN, CORE_MAX);
  p.trend += (rate - p.trend) * trendK;

  if (p.swim) p.wet = 1;
  else {
    const soak = indoor ? 0 : env.snowfall * (1 - shelter) * SOAK;
    const dry = fire * DRY_FIRE + (indoor ? DRY_INDOOR : 0);
    p.wet = sat(p.wet + (soak - dry) * dt);
  }
  const shiver = 1 + 0.8 * sat((36 - p.core) / 5);
  p.hunger = sat(p.hunger + (dt / HUNGER_TIME) * shiver * (p.sprint ? 1.5 : 1));
  p.feels = windChill(ex.air, ex.wind) + FIRE_FEEL * fire + HUDDLE_FEEL * huddle;
}

export const thermal: System = {
  name: 'thermal',

  step(ctx) {
    const st = ctx.state, env = st.env;
    const players = ctx.players();
    const fires = ctx.all('fire');
    const wl = Math.hypot(env.windX, env.windZ);
    const ux = wl > 1e-6 ? env.windX / wl : 0, uz = wl > 1e-6 ? env.windZ / wl : 0;
    const speed = wl * (1 + 0.5 * env.gust);
    const trendK = 1 - Math.exp(-ctx.dt / TREND_TAU);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.life === 'dead' || p.life === 'rescued') {
        p.fireHeat = 0;
        p.huddle = 0;
        p.trend = 0;
        continue;
      }
      body(ctx, p, players, fires, ux, uz, speed, trendK);
      if (p.life === 'alive' && p.core < st.stats.coldest) st.stats.coldest = p.core;
    }
  },

  leave(ctx, p) {
    delete ctx.state.vars[HOT_KEY + p.id];
    delete ctx.state.vars[FOOD_KEY + p.id];
  },
};
