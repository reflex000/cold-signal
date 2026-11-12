// URL parameters of the game page. Everything optional; unknown values fall back to defaults.
//   ?seed=417        world seed                    ?q=mobile|low|medium|high|ultra|auto  quality
//   ?webgl=1         WebGL2 backend (engine reads it too)
//   ?wire=ref|json   loopback wire                 ?lag=120  one-way latency in ms (?jitter=ms)
//   ?bots=n          companions (0..3)             ?still=1  no real-time loop: the CS hook steps the game
//   ?dev=1           dev tools (CS hook, debug actions, V third person)
//   ?touch=1         force touch controls (0 forces them off)
//   ?skipTitle=1     straight into a new game      ?continue=1  straight into the saved game
//   ?nosave=1        never read or write the save (tools)
//   ?fresh=1         ignore stored settings (tools; nothing is written either)
//   ?real=terrain,sky,weather,forest | all | none   which real gfx systems replace stand-ins (see visuals.ts)
//   ?gpu=1           measure GPU time per frame (timestamp queries; CS.stats().gpuMs)
// Owner: GAME.
import type { Settings } from './view';

export interface Params {
  seed: number;
  quality: Settings['quality'] | null;
  webgl: boolean;
  wire: 'ref' | 'json';
  lagMs: number;
  jitterMs: number;
  bots: number | null;
  still: boolean;
  dev: boolean;
  touch: boolean | null;
  skipTitle: boolean;
  cont: boolean;
  noSave: boolean;
  fresh: boolean;
  real: string | null;
  gpu: boolean;
}

export const DEFAULT_SEED = 417;

const QUALITIES: readonly string[] = ['mobile', 'low', 'medium', 'high', 'ultra', 'auto'];

function flag(u: URLSearchParams, name: string): boolean {
  const v = u.get(name);
  return v !== null && v !== '0' && v !== 'false' && v !== 'no';
}

function num(u: URLSearchParams, name: string, def: number, lo: number, hi: number): number {
  const v = u.get(name);
  const n = v === null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}

export function readParams(search: string = typeof location !== 'undefined' ? location.search : ''): Params {
  const u = new URLSearchParams(search);
  const q = u.get('q');
  const t = u.get('touch');
  const still = flag(u, 'still');
  return {
    seed: Math.floor(num(u, 'seed', DEFAULT_SEED, 0, 0x7fffffff)),
    quality: q && QUALITIES.includes(q) ? (q as Settings['quality']) : null,
    webgl: flag(u, 'webgl'),
    wire: u.get('wire') === 'json' ? 'json' : 'ref',
    lagMs: num(u, 'lag', 0, 0, 2000),
    jitterMs: num(u, 'jitter', 0, 0, 1000),
    bots: u.has('bots') ? Math.floor(num(u, 'bots', 0, 0, 3)) : null,
    still,
    // still implies dev: the tool hook needs the debug actions
    dev: still || flag(u, 'dev'),
    touch: t === null ? null : flag(u, 'touch'),
    skipTitle: flag(u, 'skipTitle') || flag(u, 'skiptitle'),
    cont: flag(u, 'continue'),
    noSave: flag(u, 'nosave'),
    fresh: flag(u, 'fresh'),
    real: u.get('real'),
    gpu: flag(u, 'gpu'),
  };
}
