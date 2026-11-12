// The model registry. A model file calls register() at module load; everything that draws or
// queries a model calls getModel(). Models are built lazily and cached per (name, variant, opts).
//
//   register('crate', (seed, opts) => { const b = new Builder(seed); ...; return b.build(); },
//            { variants: 4, size: 'prop' });
//   const def = getModel('crate', inst.seed);
//
// A PropInst.seed may be any integer: it is folded onto `meta.variants` distinct builds, so a
// thousand crates share at most that many geometries (and draw batches).
import * as THREE from 'three/webgpu';
import { Builder, MAT, type ModelDef } from './kit';

export type ModelOpts = Record<string, string | number | boolean | undefined>;
export type ModelBuild = (seed: number, opts: ModelOpts) => ModelDef;

export interface ModelMeta {
  /** How many distinct seeds exist; seed is taken modulo this. Default 4; 1 for one-off structures. */
  variants?: number;
  /** Rough class, for budgets and culling distance. item: hand-sized. prop: furniture-sized. structure: buildings, wreckage. */
  size?: 'item' | 'prop' | 'structure';
  /** One line for the viewer and for whoever places it. */
  desc?: string;
  /** Draw distance in metres (default by size: item 60, prop 140, structure: never culled). */
  drawDistance?: number;
  /** False for things that should not cast a sun shadow (flat decals, tiny items). Default true. */
  castShadow?: boolean;
  /** Free-form tags ('fire', 'loot', 'wreck', ...). */
  tags?: string[];
}

interface Entry { name: string; build: ModelBuild; meta: Required<Pick<ModelMeta, 'variants' | 'size' | 'castShadow'>> & ModelMeta }

const entries = new Map<string, Entry>();
const cache = new Map<string, ModelDef>();
const warned = new Set<string>();

/** Register (or replace) a model. Replacing drops its cached builds. */
export function register(name: string, build: ModelBuild, meta: ModelMeta = {}): void {
  if (entries.has(name)) for (const k of [...cache.keys()]) if (k.startsWith(name + '|')) cache.delete(k);
  entries.set(name, { name, build, meta: { variants: 4, size: 'prop', castShadow: true, ...meta } });
}

export function hasModel(name: string): boolean {
  return entries.has(name);
}

/** Names and metadata of every registered model, sorted by name. */
export function listModels(): { name: string; meta: ModelMeta }[] {
  return [...entries.values()].map((e) => ({ name: e.name, meta: e.meta })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function modelMeta(name: string): Entry['meta'] {
  return entries.get(name)?.meta ?? { variants: 1, size: 'prop', castShadow: true };
}

/** The variant index a seed maps to for this model (what the cache and the draw batches key on). */
export function variantOf(name: string, seed: number): number {
  const v = entries.get(name)?.meta.variants ?? 1;
  return ((Math.floor(seed) % v) + v) % v;
}

function optsKey(opts?: ModelOpts): string {
  if (!opts) return '';
  const keys = Object.keys(opts).filter((k) => opts[k] !== undefined).sort();
  return keys.map((k) => k + '=' + String(opts[k])).join(',');
}

/** The cache key of a model build; two calls with the same key return the same ModelDef. */
export function modelKey(name: string, seed = 0, opts?: ModelOpts): string {
  return name + '|' + variantOf(name, seed) + '|' + optsKey(opts);
}

/**
 * The built model. Unknown names warn once and return a magenta placeholder box, so a missing
 * model is obvious in the world instead of invisible.
 */
export function getModel(name: string, seed = 0, opts?: ModelOpts): ModelDef {
  const key = modelKey(name, seed, opts);
  let def = cache.get(key);
  if (def) return def;
  const e = entries.get(name);
  if (!e) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[models] unknown model "${name}": drawing a placeholder`);
    }
    def = placeholder();
  } else {
    try {
      def = e.build(variantOf(name, seed), opts ?? {});
    } catch (err) {
      if (!warned.has(name)) {
        warned.add(name);
        console.error(`[models] "${name}" failed to build`, err);
      }
      def = placeholder();
    }
  }
  def.name = name;
  cache.set(key, def);
  return def;
}

/** Free the GPU buffers of every cached build (the registrations stay). */
export function disposeModels(): void {
  for (const d of cache.values()) {
    d.geometry?.dispose();
    d.glass?.dispose();
    for (const p of Object.values(d.parts)) {
      p.geometry?.dispose();
      p.glass?.dispose();
    }
  }
  cache.clear();
}

function placeholder(): ModelDef {
  const b = new Builder(0);
  b.ink({ color: [1, 0, 0.8], mat: MAT.EMISSIVE, emissive: 1.5, snow: 0 });
  b.box(0.5, 0.5, 0.5, { bevel: 0.01 }).move(0, 0.25, 0);
  b.anchor('top', [0, 0.5, 0]);
  return b.build({ ao: 0 });
}

export type { ModelDef };
export { THREE as _THREE };
