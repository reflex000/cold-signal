// Timing for the cost tests (test-only; the game never imports this). The suite runs its files in
// parallel on a machine other people's builds and browsers share, so a fixed millisecond budget
// measured once fails whenever the machine is busy. Two rules make a cost test honest under load
// without loosening it:
//   1. The best of several rounds: load only ever adds time, so the fastest round is the cost.
//   2. The budget scales with how slow the machine is right now, measured on a fixed reference
//      workload in the same rounds: `slow` is the reference's best time over its time on an idle
//      machine (REF_IDLE_MS), never below 1. On an idle machine the budget is exactly the one the
//      test was written with; when everything runs twice as slow, so may the code under test.
// Owner: TOGETHER (shared by the sim, net, world and sky tests).

/**
 * Best time of refWork() on the development machine (Node 22, Windows), the minimum of 80 rounds
 * in three runs (2.03 to 2.09 ms). Rounded down, so an idle machine measures `slow` = 1 and every
 * budget is exactly as written; a faster machine also stays at 1.
 */
export const REF_IDLE_MS = 2.0;

interface Body { x: number; z: number; vx: number; vz: number; k: string }
const bodies: Body[] = [];
for (let i = 0; i < 400; i++) bodies.push({ x: i, z: -i, vx: 0, vz: 0, k: 'b' + (i % 37) });
const table = new Map<string, number>();
const field = new Float64Array(4096);
let sink = 0;

/**
 * A fixed piece of work shaped like a simulation tick: math over a typed array, small objects
 * read and written, map lookups, a short-lived array. Returns a number so nothing is optimised away.
 */
export function refWork(): number {
  let s = 0;
  for (let r = 0; r < 20; r++) {
    for (let i = 0; i < field.length; i++) {
      const v = Math.sin(i * 0.013 + r) * Math.sqrt(i + 1);
      field[i] = v;
      s += v;
    }
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.vx += Math.cos(b.z * 0.01 + r) * 0.1;
      b.vz -= Math.sin(b.x * 0.01 - r) * 0.1;
      b.x += b.vx * 0.033;
      b.z += b.vz * 0.033;
      table.set(b.k, (table.get(b.k) ?? 0) + b.x);
    }
    const tmp: number[] = [];
    for (let i = 0; i < 256; i++) tmp.push(field[(i * 31) & 4095]);
    tmp.sort((a, b) => a - b);
    s += tmp[128];
  }
  sink = (sink + s) % 1e6;
  return s;
}

function timeOnce(fn: () => void, reps: number): number {
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

/** How many times slower than idle the machine is right now (>= 1), from the best of `rounds` reference runs. */
export function slowdown(rounds = 7): number {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) best = Math.min(best, timeOnce(refWork, 1));
  return Math.max(1, best / REF_IDLE_MS);
}

export interface Cost {
  /** Best milliseconds per call of `fn` over the rounds. */
  ms: number;
  /** Machine slowdown measured in the same rounds (>= 1): multiply a budget by it. */
  slow: number;
}

/**
 * Milliseconds per call of `fn`: `rounds` rounds of `reps` calls, each round preceded by one
 * reference run, best of each. Warm the code up before calling this.
 */
export function cost(fn: () => void, reps: number, rounds = 5): Cost {
  let best = Infinity, ref = Infinity;
  for (let r = 0; r < rounds; r++) {
    ref = Math.min(ref, timeOnce(refWork, 1));
    best = Math.min(best, timeOnce(fn, reps));
  }
  ref = Math.min(ref, timeOnce(refWork, 1));
  return { ms: best, slow: Math.max(1, ref / REF_IDLE_MS) };
}

/** Test timeout for a long behavioural test (traces of game minutes): generous, since load stretches it. */
export const LONG_TEST_MS = 120_000;
