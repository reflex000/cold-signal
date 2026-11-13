// The clock and the weather. One mountain, one sky: everything here is a function of the seed and
// simulated time, plus the story (the hold-out forces the worst of it) and, in debug, overrides.
//
// A day is 1440 s (one game hour a minute); a new game starts at 16:30, so night falls two
// minutes in. The storm is a slow seeded curve with scripted beats laid over it:
//   0:00         moderate (0.45), so the first minutes are readable
//   6:00-12:00   a clear spell: the first night's aurora, the time to travel
//   ~17, ~33, ~45 min, then about every 13 min: whiteouts (storm > 0.9 for 2 to 4 minutes)
// Debug actions (only when the sim was made with debug): 'storm' [v] (negative clears the
// override), 'clock' [hours], 'lockWeather' [0|1], 'lockClock' [0|1], 'tp' [x, z, y?].
// Owner: SIM.
import { clamp, sat, smoothstep, TAU } from '../../core/math';
import { noise1 } from '../../core/noise';
import { hash01 } from '../../core/rng';
import type { SimCtx, System } from '../api';
import { START_CLOCK } from '../entities';
import type { Env, PlayerEnt } from '../types';

export const DAY_SECONDS = 1440;
const HOURS_PER_SECOND = 24 / DAY_SECONDS;

export const VIS_CLEAR = 4000; // metres
export const VIS_WHITEOUT = 6;
export const WIND_MIN = 2; // m/s
export const WIND_MAX = 22;
/** Storm above this is a whiteout. */
export const WHITEOUT = 0.9;

const V_STORM = 'env.stormOv'; // debug storm override, absent or negative = none
const V_LOCK = 'env.lock';
const V_LOCK_CLOCK = 'env.lockClock';
const V_GUST_T0 = 'env.gustT0'; // start time of the gust in progress
const V_GUST_PK = 'env.gustPk';
const V_GUST_LEN = 'env.gustLen';
const V_GUST_NEXT = 'env.gustNext';
const V_THUNDER = 'env.thunderAt';

// ---------------------------------------------------------------------------------------------
// The storm curve
// ---------------------------------------------------------------------------------------------
const RAMP = 60; // seconds for a whiteout to build or pass (RELEASE balance: was 70)
const LATE_START = 3480; // first of the repeating whiteouts (58 min)
const LATE_PERIOD = 780;

/** Weight of a beat that holds from t0 to t1 with soft shoulders. */
function beat(t: number, t0: number, t1: number, ramp: number): number {
  return smoothstep(t0 - ramp, t0, t) * (1 - smoothstep(t1, t1 + ramp, t));
}

/** Start and length of the k-th whiteout (k = 0, 1, 2 are the scripted ones of the first 50 minutes). */
export function whiteoutWindow(seed: number, k: number): { t0: number; t1: number } {
  const len = 100 + 40 * hash01(seed, 7411, k); // (RELEASE balance: was 125 + 50: a sat-out whiteout pinned a group for 4 to 5 minutes)
  const j = hash01(seed, 7412, k);
  let t0: number;
  if (k === 0) t0 = 990 + 150 * j; // 16.5 .. 19 min: the first full day
  else if (k === 1) t0 = 1900 + 240 * j; // 31.7 .. 35.7 min: the second night
  else if (k === 2) t0 = 2640 + 120 * j; // 44 .. 46 min
  else t0 = LATE_START + (k - 3) * LATE_PERIOD + 300 * j;
  return { t0, t1: t0 + len };
}

/** Storm intensity 0..1 at simulated time t (seconds) for a seed, before story and debug overrides. */
export function stormAt(seed: number, t: number): number {
  // Slow weather: stays between about 0.1 and 0.69, so only a scripted beat makes a whiteout and the
  // storms between the beats are travelling weather more often than not (RELEASE balance: was 0.42 / 0.22 / 0.1).
  let s = 0.4 + 0.2 * noise1(seed ^ 0x51ed, t / 170) + 0.09 * noise1(seed ^ 0x7a3b, t / 53);
  // Opening: a steady moderate storm for the first minutes.
  s += (0.45 - s) * (1 - smoothstep(150, 300, t));
  // The clear spell.
  s += (0.05 - s) * beat(t, 360, 720, 80);
  // Whiteouts. They never overlap, so at most the neighbours of t matter.
  const kLate = t < LATE_START - 2 * RAMP ? -1 : Math.floor((t - LATE_START) / LATE_PERIOD) + 3;
  for (let i = 0; i < 3; i++) {
    const k = kLate < 0 ? i : kLate - 1 + i;
    if (k < 0) continue;
    const w = whiteoutWindow(seed, k);
    const wt = beat(t, w.t0, w.t1, RAMP);
    if (wt > 0) s += (1 - s) * wt;
  }
  return sat(s);
}

/** Visibility in metres for a storm intensity: 4 km clear, about 400 m at 0.45, 6 m in a whiteout. */
export function visibilityFor(storm: number): number {
  return VIS_CLEAR * Math.exp(Math.log(VIS_WHITEOUT / VIS_CLEAR) * Math.pow(sat(storm), 1.3));
}

/** 0 by day .. 1 at night, from the hour. Dusk is 17:30 to 19:30, dawn 5:30 to 7:30. */
export function nightAt(clock: number): number {
  return clock >= 12 ? smoothstep(17.5, 19.5, clock) : 1 - smoothstep(5.5, 7.5, clock);
}

// ---------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------

/** Everything that follows from the storm, the hour and the time. Does not touch storm, clock or gust. */
function derive(ctx: SimCtx, lockWind: boolean): void {
  const env = ctx.state.env;
  const seed = ctx.state.seed;
  const t = env.t;
  const storm = env.storm;

  if (!lockWind) {
    // The storm comes down off the ridge: air moves roughly toward the south-east, and wanders.
    const dir0 = (0.125 + (hash01(seed, 9001) - 0.5) * 0.14) * TAU;
    const dir = dir0 + 0.7 * noise1(seed ^ 0x1b9d, t / 420) + 0.25 * noise1(seed ^ 0x2c7f, t / 75);
    const speed = clamp(WIND_MIN + (WIND_MAX - WIND_MIN) * Math.pow(storm, 1.15) * (0.92 + 0.08 * noise1(seed ^ 0x3e11, t / 31)), WIND_MIN, WIND_MAX);
    env.windX = Math.cos(dir) * speed;
    env.windZ = Math.sin(dir) * speed;
  }

  const flurry = 0.88 + 0.12 * noise1(seed ^ 0x4d05, t / 47);
  env.snowfall = sat(smoothstep(0.08, 0.85, storm) * flurry + (storm > 0.85 ? (storm - 0.85) * 2 : 0));
  env.visibility = visibilityFor(storm);
  env.cloud = sat(0.1 + 1.45 * storm + 0.12 * noise1(seed ^ 0x5f29, t / 140));

  const night = nightAt(env.clock);
  // Warmest in the early afternoon (-8), coldest before dawn (-24); a storm takes 6 more.
  const warmth = 0.5 + 0.5 * Math.cos(((env.clock - 14) / 24) * TAU);
  env.airTemp = -24 + 16 * warmth - 6 * storm;
  // Aurora: clear nights only, breathing slowly.
  const clear = 1 - smoothstep(0.12, 0.4, env.cloud);
  env.aurora = sat(night * night * clear * (0.65 + 0.35 * noise1(seed ^ 0x6a41, t / 95)));
}

function stormTarget(ctx: SimCtx): number {
  const st = ctx.state;
  const ov = st.vars[V_STORM];
  if (ov !== undefined && ov >= 0) return sat(ov);
  let s = stormAt(st.seed, st.env.t);
  const stage = st.objective.stage;
  // The hold-out is fought in the worst of it; it does not let go until the winch is down.
  if (stage === 'holdout') s = 1;
  else if (stage === 'rescue') s = Math.max(s, 0.8);
  return s;
}

function gusts(ctx: SimCtx): void {
  const st = ctx.state, env = st.env, t = env.t;
  let next = ctx.v(V_GUST_NEXT, -1);
  if (next < 0) {
    next = t + 4 + 6 * ctx.rand();
    ctx.setV(V_GUST_NEXT, next);
  }
  if (t >= next) {
    const peak = sat((0.3 + 0.7 * ctx.rand()) * (0.3 + 0.75 * env.storm));
    ctx.setV(V_GUST_T0, t);
    ctx.setV(V_GUST_PK, peak);
    ctx.setV(V_GUST_LEN, 2.5 + 3 * ctx.rand());
    // Calm air: a gust every 20 s or so. In a storm they come every few seconds.
    ctx.setV(V_GUST_NEXT, t + (22 - 16 * env.storm) * (0.5 + ctx.rand()));
    ctx.emit({ t: 'gust', strength: peak });
  }
  const t0 = ctx.v(V_GUST_T0, -1);
  if (t0 < 0) {
    env.gust = 0;
    return;
  }
  const len = ctx.v(V_GUST_LEN, 3);
  const u = (t - t0) / len;
  // Hits fast (the first fifth), lets go slowly.
  env.gust = u >= 1 ? 0 : ctx.v(V_GUST_PK, 0) * smoothstep(0, 0.2, u) * (1 - smoothstep(0.3, 1, u));
}

function teleport(ctx: SimCtx, p: PlayerEnt, x: number, z: number, y: number | undefined): void {
  const w = ctx.world;
  const lim = w.half - 4;
  p.x = clamp(x, -lim, lim);
  p.z = clamp(z, -lim, lim);
  // Land on a floor if there is one near the terrain (inside a cabin), else on the ground.
  p.y = w.groundAt(p.x, p.z, y !== undefined && Number.isFinite(y) ? y : w.heightAt(p.x, p.z) + 3).y;
  p.vx = p.vy = p.vz = 0;
  p.onGround = true;
  p.swim = false;
}

export const env: System = {
  name: 'env',

  init(ctx) {
    const e: Env = ctx.state.env;
    e.t = 0;
    e.clock = START_CLOCK;
    e.day = 0;
    e.storm = stormAt(ctx.state.seed, 0);
    e.gust = 0;
    e.snowAccum = 0;
    derive(ctx, false);
  },

  step(ctx) {
    const st = ctx.state, e = st.env, dt = ctx.dt;
    e.t = st.tick * dt;

    if (!st.vars[V_LOCK_CLOCK]) {
      e.clock += dt * HOURS_PER_SECOND;
      if (e.clock >= 24) {
        e.clock -= 24;
        e.day++;
      }
    }

    const locked = !!st.vars[V_LOCK];
    if (!locked) {
      // The curve itself never moves faster than this; the limit only shapes the story's jumps.
      const target = stormTarget(ctx);
      const maxStep = 0.04 * dt;
      e.storm = e.storm < target ? Math.min(target, e.storm + maxStep) : Math.max(target, e.storm - maxStep);
      gusts(ctx);
    } else {
      e.gust = 0;
    }

    derive(ctx, locked);

    // Wind-packed snow lays down faster than it falls.
    e.snowAccum += e.snowfall * (0.0004 + 0.0004 * e.storm) * dt;

    // Thunder snow: rare, only in the heart of a whiteout.
    if (e.storm > 0.93 && !locked) {
      const at = ctx.v(V_THUNDER, -1);
      if (at < 0 || at < e.t - 600) ctx.setV(V_THUNDER, e.t + 25 + 60 * ctx.rand());
      else if (e.t >= at) {
        ctx.emit({ t: 'thunderSnow' });
        ctx.setV(V_THUNDER, e.t + 50 + 90 * ctx.rand());
      }
    }
  },

  action(ctx, p, a) {
    if (a.t !== 'debug' || !ctx.debug) return false;
    const st = ctx.state, e = st.env;
    const arg = a.args ?? [];
    const a0 = arg[0];
    switch (a.cmd) {
      case 'storm':
        if (a0 === undefined || !(a0 >= 0)) delete st.vars[V_STORM];
        else {
          st.vars[V_STORM] = sat(a0);
          e.storm = sat(a0); // at once: this is for tools and screenshots
        }
        derive(ctx, false);
        return true;
      case 'clock':
        if (a0 !== undefined && Number.isFinite(a0)) e.clock = ((a0 % 24) + 24) % 24;
        derive(ctx, !!st.vars[V_LOCK]);
        return true;
      case 'lockWeather':
        if (a0) st.vars[V_LOCK] = 1;
        else delete st.vars[V_LOCK];
        return true;
      case 'lockClock':
        if (a0) st.vars[V_LOCK_CLOCK] = 1;
        else delete st.vars[V_LOCK_CLOCK];
        return true;
      case 'tp':
        if (a0 !== undefined && Number.isFinite(a0) && Number.isFinite(arg[1])) teleport(ctx, p, a0, arg[1], arg[2]);
        return true;
      default:
        return false;
    }
  },
};
