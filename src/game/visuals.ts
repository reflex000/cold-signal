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
import { createIceVisuals } from './icevis';
import { createInteriorLight } from './interior';
import { createHeliVisual } from './heli';
import type { WorldEx } from '../world/index';
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

const LABEL: Record<VisualName, string> = {
  sky: 'Lighting the sky',
  weather: 'Bringing in the storm',
  terrain: 'Laying the snow',
  forest: 'Growing the forest',
};

/**
 * Add every visual system to the engine. Resolves once all are in (call engine.warmup() after).
 * With `pause` (e.g. one animation frame) the browser gets to draw between systems and inside the
 * long structure build, so the loading line keeps moving; `onProgress` reports 0..1 and a label.
 */
export async function addVisualSystems(
  engine: CsEngine, world: World, want: Set<VisualName>,
  onProgress?: (f: number, label: string) => void, pause?: () => Promise<void>,
): Promise<VisualReport> {
  const used = {} as Record<VisualName, 'real' | 'standin'>;
  let k = 0;
  for (const name of NAMES) {
    onProgress?.((k++ / NAMES.length) * 0.5, LABEL[name]);
    if (pause) await pause();
    let sys: GfxSystem | null = want.has(name) ? await real(name, engine, world) : null;
    used[name] = sys ? 'real' : 'standin';
    if (!sys) sys = standin(name, engine, world);
    engine.add(sys);
  }
  onProgress?.(0.5, 'Building the places');
  if (pause) await pause();
  const structures = await createStandinStructures(engine, world, (f) => onProgress?.(0.5 + f * 0.45, 'Building the places'), pause);
  onProgress?.(0.95, 'Last things');
  if (pause) await pause();
  engine.add(structures);
  engine.add(structures.props);
  engine.add(createStructureDriver(structures.props));
  engine.add(createIceVisuals(engine, world)); // TOGETHER: open water and new ice on the lake (view.ice)
  engine.add(createHeliVisual(structures.props)); // TOGETHER: the rescue helicopter (a KIT model flown where the HeliEnt is)
  engine.add(createStandinMarkers(engine));
  onProgress?.(0.97, 'Lighting the fires');
  if (pause) await pause();
  try { engine.add((await import('../gfx/fx')).createFxSystem(engine, world)); } catch (e) { console.warn('[visuals] src/gfx/fx failed to start:', e); } // FX: fire, flares, light pool, breath, goggle overlays
  engine.add(createInteriorLight(engine, world as WorldEx)); // TOGETHER: daylight in the rooms, the eye adapting indoors (uses FX's light pool)
  onProgress?.(0.99, 'Waking the others');
  if (pause) await pause();
  try { engine.add((await import('../actors')).createActorsSystem(engine, world)); } catch (e) { console.warn('[visuals] src/actors failed to start:', e); } // FIGURES: players and wolves, animated (the markers stop drawing them)
  try { engine.add((await import('../gfx/snow')).createSnowSystem(engine, world)); } catch (e) { console.warn('[visuals] src/gfx/snow failed to start:', e); } // SNOW: footprints, paw tracks, drags and hollows in the snow (U.trailTex)
  return { used };
}
