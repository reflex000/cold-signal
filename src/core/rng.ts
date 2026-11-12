// Deterministic random numbers. Everything in the world and the simulation draws from these,
// never from Math.random().

/** Integer hash of up to three integers -> uint32. */
export function hash32(a: number, b = 0, c = 0): number {
  let h = (a | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= Math.imul(b | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= Math.imul(c | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x165667b1);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash -> float in [0, 1). */
export function hash01(a: number, b = 0, c = 0): number {
  return hash32(a, b, c) / 4294967296;
}

export function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One step of mulberry32 on an explicit state. Returns [newState, value in [0,1)]. */
export function rngStep(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [s, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
}

export class Rng {
  state: number;
  constructor(seed: number | string) {
    this.state = (typeof seed === 'string' ? strHash(seed) : seed) | 0;
  }
  /** Float in [0, 1). */
  next(): number {
    const r = rngStep(this.state);
    this.state = r[0];
    return r[1];
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Integer in [a, b] inclusive. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Approximately normal, mean 0, sd 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }
  /** Independent stream derived from the current state and a tag; does not advance this stream. */
  fork(tag: number | string): Rng {
    return new Rng(hash32(this.state, typeof tag === 'string' ? strHash(tag) : tag));
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}
