// The placed things of world.props, all drawn by KIT's props system with the one shared prop
// material, so every structure sits in the same light, snow, fog and baked ridge shadow as the
// models. Models registered in src/models (crate, barrel, luggage, trail_marker ...) are used as
// they are. The structures that have no model yet (fuselage, cabin, hut, tower ...) are STAND-INS
// built with the kit Builder from their blueprints (src/world/blueprints.ts): one bevelled box per
// collider, a slab per floor, a roof over every indoor shelter, so the walls you see are exactly
// the walls the simulation collides with. Sign posts, fence posts and debris panels, which have
// neither, get simple kit shapes. Stand-ins register as 'standin:<model>' so a real model
// registered under the plain name (M4) takes over without touching this file.
// Owner: GAME.
import type { GfxSystem } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import { createPropsSystem, type PropsSystem } from '../../models/instances';
import { Builder, MAT, PAL, hex, type MatId, type RGB } from '../../models/kit';
import { hasModel, register } from '../../models/registry';
import type { Blueprint, SolidKind } from '../../world/blueprints';
import { blueprint } from '../../world/index';
import type { PropInst, World } from '../../world/types';
import '../../models/props';

interface Look {
  color: RGB;
  mat: MatId;
  wear: number;
  rough?: number;
}

const ALUMINIUM: Look = { color: PAL.liveryWhite, mat: MAT.PAINT, wear: 0.55 };
const LOOK: Record<string, Look> = {
  fuselage: ALUMINIUM,
  tail_section: ALUMINIUM,
  wing: { color: PAL.liveryGrey, mat: MAT.PAINT, wear: 0.6 },
  engine_nacelle: { color: PAL.steelDark, mat: MAT.METAL, wear: 0.7 },
  seat_row: { color: PAL.seatBlue, mat: MAT.CLOTH, wear: 0.5 },
  cabin: { color: PAL.timberDark, mat: MAT.WOOD, wear: 0.6 },
  woodshed: { color: PAL.timber, mat: MAT.WOOD, wear: 0.75 },
  fishing_hut: { color: hex(0x5b4334), mat: MAT.WOOD, wear: 0.7 },
  cave_rocks: { color: PAL.rock, mat: MAT.ROCK, wear: 0.3 },
  tent_torn: { color: PAL.canvasOlive, mat: MAT.CLOTH, wear: 0.8 },
  survey_mast: { color: PAL.galvanised, mat: MAT.METAL, wear: 0.6 },
  tower_mast: { color: PAL.galvanised, mat: MAT.METAL, wear: 0.65 },
  tower_shed: { color: PAL.concrete, mat: MAT.ROCK, wear: 0.4 },
  generator: { color: PAL.olive, mat: MAT.PAINT, wear: 0.7 },
};
const OTHER: Look = { color: PAL.steelDark, mat: MAT.PAINT, wear: 0.6 };
const FURNITURE: Look = { color: PAL.timber, mat: MAT.WOOD, wear: 0.5 };
const STONE: Look = { color: PAL.rock, mat: MAT.ROCK, wear: 0.3 };
const FLOOR: Look = { color: PAL.plywood, mat: MAT.WOOD, wear: 0.7 };
const CONCRETE: Look = { color: PAL.concrete, mat: MAT.ROCK, wear: 0.5 };

function lookOf(model: string, kind: SolidKind, tag: string): Look {
  if (kind === 'rock' || tag === 'rock') return STONE;
  if (kind === 'furniture') {
    if (tag === 'stove' || tag === 'genset' || tag === 'panel' || tag === 'elt rack') return { color: PAL.iron, mat: MAT.METAL, wear: 0.6 };
    if (tag === 'seat') return LOOK.seat_row;
    return FURNITURE;
  }
  return LOOK[model] ?? OTHER;
}

/** A kit model of a blueprint: one bevelled box per collider, floors, roofs over indoor rooms. */
function buildBlueprint(model: string, bp: Blueprint, seed: number) {
  const b = new Builder(seed);
  const paint = (l: Look, snow: number): void => {
    b.ink({ color: l.color, mat: l.mat, wear: l.wear, rough: l.rough, snow, vary: 0.06 });
  };
  for (const x of bp.boxes) {
    const h = Math.max(0.03, x.y1 - x.y0);
    const l = lookOf(model, x.kind, x.tag);
    paint(l, x.kind === 'furniture' ? 0 : 1);
    const bevel = Math.min(0.03, Math.min(x.hx, x.hz, h / 2) * 0.4);
    b.box(x.hx * 2, h, x.hz * 2, { bevel })
      .rotY(x.yaw)
      .move(x.x, (x.y0 + x.y1) / 2, x.z);
  }
  for (const p of bp.posts) {
    const h = Math.max(0.03, p.y1 - p.y0);
    paint(lookOf(model, p.kind, p.tag), p.kind === 'furniture' ? 0 : 1);
    b.cyl(p.r, h, { sides: p.r > 0.2 ? 14 : 8 }).move(p.x, (p.y0 + p.y1) / 2, p.z);
  }
  for (const f of bp.floors) {
    const l = f.tag === 'concrete pad' ? CONCRETE : f.tag === 'cave floor' ? STONE : FLOOR;
    paint(l, l === FLOOR ? 0 : 1);
    b.box(f.hx * 2, 0.12, f.hz * 2, { bevel: 0.01 })
      .rotY(f.yaw)
      .move(f.x, f.y - 0.06, f.z);
  }
  for (const s of bp.shelters) {
    if (!s.indoor) continue;
    // a roof over the room so the inside is in shade (blueprints have no roofs: they are not walls)
    const top = s.y + s.hy;
    paint(model === 'cave_rocks' ? STONE : LOOK[model] ?? OTHER, 1);
    b.box(s.hx * 2 + 0.5, 0.16, s.hz * 2 + 0.5, { bevel: 0.02 })
      .rotY(s.yaw)
      .move(s.x, top + 0.08, s.z);
  }
  return b.build({ ground: true });
}

/** Simple kit shapes for placed things with neither a model nor a blueprint. */
function buildSimple(kind: string, seed: number) {
  const b = new Builder(seed);
  const r = b.rng;
  const lean = r.range(-0.06, 0.06);
  if (kind === 'sign_post') {
    b.ink({ color: PAL.timberDark, mat: MAT.WOOD, wear: 0.7, snow: 1, vary: 0.08 });
    const post = b.box(0.1, 2.05, 0.1, { bevel: 0.012 }).move(0, 0.875, 0);
    b.ink({ color: PAL.signYellow, mat: MAT.PAINT, wear: 0.75, snow: 1 });
    const board = b.box(0.85, 0.28, 0.035, { bevel: 0.008 }).move(0, 1.45, 0.07);
    post.rotZ(lean);
    board.rotZ(lean);
  } else if (kind === 'fence_post') {
    b.ink({ color: PAL.timberDark, mat: MAT.WOOD, wear: 0.8, snow: 1, vary: 0.1 });
    b.box(0.11, 1.45, 0.11, { bevel: 0.012 }).move(0, 0.625, 0).rotX(lean);
  } else if (kind === 'debris_panel') {
    b.ink({ color: r.chance(0.5) ? PAL.liveryWhite : PAL.liveryGrey, mat: MAT.PAINT, wear: 0.7, snow: 1 });
    b.box(1.5, 0.035, 0.9, { bevel: 0.006 })
      .crumple(0.05)
      .rotX(r.range(-0.25, 0.25))
      .rotZ(r.range(-0.2, 0.2))
      .move(0, 0.08, 0);
  } else {
    b.ink({ color: PAL.steelDark, mat: MAT.PAINT, wear: 0.6, snow: 1 });
    b.box(0.4, 0.4, 0.4, { bevel: 0.01 }).move(0, 0.2, 0);
  }
  return b.build({ ground: true });
}

const SIMPLE = new Set(['sign_post', 'fence_post', 'debris_panel']);

/** The registered model that draws a placed prop (registering a stand-in the first time). */
function modelFor(p: PropInst): string {
  if (hasModel(p.model)) return p.model;
  const name = 'standin:' + p.model;
  if (hasModel(name)) return name;
  const bp = blueprint(p.model);
  if (bp) {
    register(name, (seed) => buildBlueprint(p.model, bp, seed), { variants: 1, size: 'structure', desc: `stand-in for ${p.model} (blueprint boxes)` });
  } else {
    const kind = SIMPLE.has(p.model) ? p.model : 'box';
    register(name, (seed) => buildSimple(kind, seed), { variants: 4, size: 'prop', desc: `stand-in for ${p.model}` });
  }
  return name;
}

export interface StandinStructures extends GfxSystem {
  readonly props: PropsSystem;
}

/** Adds KIT's props system with every placed model and stand-in. */
export function createStandinStructures(engine: CsEngine, world: World): StandinStructures {
  const list: PropInst[] = world.props.map((p) => {
    const model = modelFor(p);
    return model === p.model ? p : { ...p, model };
  });
  // Barrels are drawn cold: a burning barrel is a FireEnt, and its flames come from the fire's own visual.
  const props = createPropsSystem({ scene: engine.scene, camera: engine.camera }, list, {
    shadows: true,
    opts: (inst) => (inst.model === 'barrel' ? { lit: false } : undefined),
  });
  return {
    name: 'structures',
    props,
    update(): void {
      // static: the props system culls and updates itself
    },
    dispose(): void {
      props.dispose?.();
    },
  };
}
