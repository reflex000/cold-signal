// THE SEAM between the game and the visual world. addVisualSystems() adds, in order: sky (light),
// weather (fog, snowfall; reads the light the sky wrote), terrain, forest, the placed structures
// and props (KIT's props system, one prop material for models and blueprint stand-ins alike), and
// the entity markers. Sky / weather / terrain / forest are the real systems from
// src/gfx/<name>/index.ts (DEFAULT_REAL); ?real=none or ?real=terrain,sky picks others for tests.
// A real system that fails to load or throws while being created falls back to its stand-in in
// src/game/standin/, with one console warning. Everything is added before engine.warmup().
// Owner: GAME.
import type { GfxSystem } from '../gfx/api';
import type { CsEngine } from '../gfx/engine';
import type { World } from '../world/types';
import { createStandinForest } from './standin/forest';
import { createStandinMarkers } from './standin/markers';
import { createStandinSky } from './standin/sky';
import { createStandinStructures } from './standin/structures';
import { createStandinTerrain } from './standin/terrain';
import { createStandinWeather } from './standin/weather';
// STRUCTURES: registers the wreck and every place's models under their blueprint names (so they replace the stand-ins) and drives their doors, crank, panel and lights.
import { createStructureDriver } from '../models/structures';

export type VisualName = 'sky' | 'weather' | 'terrain' | 'forest';
const NAMES: readonly VisualName[] = ['sky', 'weather', 'terrain', 'forest'];

/** Real systems used when the URL does not say (?real=...). */
const DEFAULT_REAL: readonly VisualName[] = ['sky', 'weather', 'terrain', 'forest'];

const FACTORY: Record<VisualName, string> = {
  sky: 'createSkySystem',
  weather: 'createWeatherSystem',
  terrain: 'createTerrainSystem',
  forest: 'createForestSystem',
};

// Resolved by Vite when this file is transformed: only modules that exist are listed, and each
// loads only when asked for, so a missing (or unfinished) module costs nothing.
const REAL_MODULES = import.meta.glob(['../gfx/sky/index.ts', '../gfx/weather/index.ts', '../gfx/terrain/index.ts', '../gfx/forest/index.ts']);

function standin(name: VisualName, engine: CsEngine, world: World): GfxSystem {
  switch (name) {
    case 'sky':
      return createStandinSky(engine);
    case 'weather':
      return createStandinWeather(engine);
    case 'terrain':
      return createStandinTerrain(engine, world);
    case 'forest':
      return createStandinForest(engine, world);
  }
}

/** Which real systems to try: `?real=` (comma list, 'all' or 'none'), else DEFAULT_REAL. */
export function realSelection(param: string | null): Set<VisualName> {
  if (param === null) return new Set(DEFAULT_REAL);
  if (param === 'all') return new Set(NAMES);
  if (param === 'none' || param === '') return new Set();
  return new Set(param.split(',').map((s) => s.trim()).filter((s): s is VisualName => (NAMES as readonly string[]).includes(s)));
}

export interface VisualReport {
  /** What drew each part of the world. */
  used: Record<VisualName, 'real' | 'standin'>;
}

async function real(name: VisualName, engine: CsEngine, world: World): Promise<GfxSystem | null> {
  const load = REAL_MODULES[`../gfx/${name}/index.ts`];
  if (!load) return null;
  try {
    const mod = (await load()) as Record<string, unknown>;
    const make = mod[FACTORY[name]];
    if (typeof make !== 'function') {
      console.warn(`[visuals] src/gfx/${name} has no ${FACTORY[name]}(): using the stand-in`);
      return null;
    }
    const sys = (make as (e: CsEngine, w: World) => GfxSystem | Promise<GfxSystem>)(engine, world);
    return await sys;
  } catch (e) {
    console.warn(`[visuals] src/gfx/${name} failed to start, using the stand-in:`, e);
    return null;
  }
}

/** Add every visual system to the engine. Resolves once all are in (call engine.warmup() after). */
export async function addVisualSystems(engine: CsEngine, world: World, want: Set<VisualName>): Promise<VisualReport> {
  const used = {} as Record<VisualName, 'real' | 'standin'>;
  for (const name of NAMES) {
    let sys: GfxSystem | null = want.has(name) ? await real(name, engine, world) : null;
    used[name] = sys ? 'real' : 'standin';
    if (!sys) sys = standin(name, engine, world);
    engine.add(sys);
  }
  const structures = createStandinStructures(engine, world);
  engine.add(structures);
  engine.add(structures.props);
  engine.add(createStructureDriver(structures.props));
  engine.add(createStandinMarkers(engine));
  try { engine.add((await import('../gfx/fx')).createFxSystem(engine, world)); } catch (e) { console.warn('[visuals] src/gfx/fx failed to start:', e); } // FX: fire, flares, light pool, breath, goggle overlays
  try { engine.add((await import('../actors')).createActorsSystem(engine, world)); } catch (e) { console.warn('[visuals] src/actors failed to start:', e); } // FIGURES: players and wolves, animated (the markers stop drawing them)
  return { used };
}
