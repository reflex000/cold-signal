// Helpers shared by the simulation and net tests (vitest). Not used by the game.
// Owner: SIM.
import { BTN, type InputCmd } from './types';

export function cmd(seq: number, o: Partial<InputCmd> = {}): InputCmd {
  return { seq, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, focus: 0, ...o };
}

/**
 * A scripted command for player `k` at tick `n`: walks, turns, strafes, sprints, crouches, backs up
 * and jumps, so a few hundred ticks exercise most of the movement code. Writes into `out`.
 */
export function scriptCmd(k: number, n: number, out: InputCmd = cmd(0)): InputCmd {
  const phase = Math.floor(n / 45) % 8;
  out.yaw = 0.7 * k + n * 0.013 * (k % 2 === 1 ? 1 : -1);
  out.pitch = 0.3 * Math.sin(n * 0.05);
  out.mx = phase === 3 ? 0.6 : phase === 6 ? -0.6 : 0;
  out.mz = phase === 5 ? 0 : phase === 7 ? -0.5 : 1;
  out.b = (phase === 1 || phase === 2 ? BTN.SPRINT : 0) | (phase === 4 ? BTN.CROUCH : 0) | (n % 50 === 17 ? BTN.JUMP : 0);
  out.focus = 0;
  return out;
}

/**
 * Where a value is not plain JSON: undefined, NaN or infinite numbers, functions, Maps, typed
 * arrays, class instances, sparse arrays. Returns the offending paths (empty when it is safe).
 */
export function jsonIssues(v: unknown, path = '$', out: string[] = []): string[] {
  if (v === null) return out;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return out;
    case 'number':
      if (!Number.isFinite(v)) out.push(`${path}: ${v}`);
      return out;
    case 'object': {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (!(i in v)) out.push(`${path}[${i}]: hole`);
          else jsonIssues(v[i], `${path}[${i}]`, out);
        }
        return out;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        out.push(`${path}: ${(proto && proto.constructor && proto.constructor.name) || 'object'} is not a plain object`);
        return out;
      }
      for (const k of Object.keys(v as object)) jsonIssues((v as Record<string, unknown>)[k], `${path}.${k}`, out);
      return out;
    }
    default:
      out.push(`${path}: ${typeof v}`);
      return out;
  }
}
