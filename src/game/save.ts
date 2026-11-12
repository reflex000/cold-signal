// Save and continue: the host's serialised SimState as JSON in localStorage ('cs.save'), written on
// 'checkpoint' events and when the page hides. Loading is Sim.fromState (game.ts). Storage may be
// missing, blocked or full: every call is guarded and reports what happened.
// Owner: GAME.
import type { SimState } from '../sim/types';
import { STATE_VERSION } from '../sim/entities';

const KEY = 'cs.save';

export interface SaveMeta {
  version: number;
  seed: number;
  tick: number;
  savedAt: number;
}

export class SaveStore {
  constructor(private readonly enabled: boolean) {}

  has(): boolean {
    if (!this.enabled) return false;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return false;
      // cheap check of the head of the JSON: the version must match what this build loads
      const m = /"version":\s*(\d+)/.exec(raw.slice(0, 64));
      return !m || Number(m[1]) === STATE_VERSION;
    } catch {
      return false;
    }
  }

  /** The saved state as JSON, or null. */
  read(): string | null {
    if (!this.enabled) return null;
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  /** Store the serialised SimState (Sim.serialize(): JSON). */
  write(json: string): boolean {
    if (!this.enabled) return false;
    try {
      localStorage.setItem(KEY, json);
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    if (!this.enabled) return;
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to do */
    }
  }

  meta(): SaveMeta | null {
    const raw = this.read();
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as SimState;
      return { version: s.version, seed: s.seed, tick: s.tick, savedAt: 0 };
    } catch {
      return null;
    }
  }
}
