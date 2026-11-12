// The placed things of world.props. Models registered in src/models (crate, barrel, luggage,
// trail_marker ...) go to KIT's props system; the structures that have no model yet (fuselage,
// cabin, hut, tower ...) are drawn as STAND-INS from their blueprints (src/world/blueprints.ts),
// so the walls you see are exactly the walls the simulation collides with; a few small things
// with neither (sign posts, fence posts, debris panels) get simple shapes. One merged mesh.
// Owner: GAME.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash01 } from '../../core/rng';
import type { GfxSystem } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import { createPropsSystem, type PropsSystem } from '../../models/instances';
import { hasModel } from '../../models/registry';
import { blueprint, placeBlueprint } from '../../world/index';
import type { PropInst, World } from '../../world/types';
import '../../models/props';

const { attribute, normalWorld, vec3, mix, mx_noise_float, positionWorld, float } = TSL as any;

type RGB = [number, number, number];
const ALUMINIUM: RGB = [0.42, 0.44, 0.47];
const WOOD: RGB = [0.15, 0.105, 0.07];
const DARK_METAL: RGB = [0.12, 0.125, 0.13];
const STONE: RGB = [0.06, 0.058, 0.055];
const FURNITURE: RGB = [0.19, 0.14, 0.095];
const FLOOR: RGB = [0.16, 0.12, 0.085];
const CLOTH: RGB = [0.42, 0.17, 0.07];

const MODEL_COLOR: Record<string, RGB> = {
  fuselage: ALUMINIUM, wing: ALUMINIUM, tail_section: ALUMINIUM, engine_nacelle: [0.3, 0.31, 0.33], seat_row: [0.12, 0.16, 0.26],
  cabin: WOOD, woodshed: WOOD, fishing_hut: [0.2, 0.11, 0.08], cave_rocks: STONE, tent_torn: CLOTH,
  survey_mast: DARK_METAL, tower_mast: DARK_METAL, tower_shed: [0.24, 0.25, 0.24], generator: [0.19, 0.22, 0.15],
};

function paint(g: THREE.BufferGeometry, c: RGB, snow: number): THREE.BufferGeometry {
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  const sn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
    sn[i] = snow;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSnow', new THREE.BufferAttribute(sn, 1));
  return g;
}

/** A box from y0 to y1, centred on (x, z), rotated by yaw (three.js rotation.y). */
function box(x: number, z: number, hx: number, hz: number, yaw: number, y0: number, y1: number, c: RGB, snow: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(hx * 2, Math.max(0.02, y1 - y0), hz * 2);
  g.rotateY(yaw);
  g.translate(x, (y0 + y1) / 2, z);
  return paint(g, c, snow);
}

function post(x: number, z: number, r: number, y0: number, y1: number, c: RGB, snow: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, Math.max(0.02, y1 - y0), 8);
  g.translate(x, (y0 + y1) / 2, z);
  return paint(g, c, snow);
}

/** Small things with neither a model nor a blueprint. */
function simple(p: PropInst, out: THREE.BufferGeometry[]): void {
  const s = p.scale || 1;
  const lean = (hash01(p.seed, 3) - 0.5) * 0.12;
  if (p.model === 'sign_post') {
    const g = new THREE.BoxGeometry(0.1, 1.9, 0.1).translate(0, 0.95, 0);
    const b = new THREE.BoxGeometry(0.85, 0.28, 0.04).translate(0, 1.6, 0.06);
    for (const [geo, c] of [[g, WOOD], [b, [0.34, 0.25, 0.12] as RGB]] as const) {
      geo.rotateZ(lean);
      geo.rotateY(p.yaw);
      geo.translate(p.x, p.y - 0.15, p.z);
      out.push(paint(geo, c, 1));
    }
  } else if (p.model === 'fence_post') {
    const g = new THREE.BoxGeometry(0.11, 1.35 * s, 0.11).translate(0, 0.6 * s, 0);
    g.rotateX(lean);
    g.rotateY(p.yaw);
    g.translate(p.x, p.y - 0.1, p.z);
    out.push(paint(g, WOOD, 1));
  } else if (p.model === 'debris_panel') {
    const g = new THREE.BoxGeometry(1.5 * s, 0.035, 0.9 * s);
    g.rotateX((hash01(p.seed, 5) - 0.5) * 0.5);
    g.rotateZ((hash01(p.seed, 6) - 0.5) * 0.4);
    g.rotateY(p.yaw);
    g.translate(p.x, p.y + 0.08, p.z);
    out.push(paint(g, ALUMINIUM, 1));
  } else {
    const g = new THREE.BoxGeometry(0.4 * s, 0.4 * s, 0.4 * s).translate(0, 0.2 * s, 0);
    g.rotateY(p.yaw);
    g.translate(p.x, p.y, p.z);
    out.push(paint(g, DARK_METAL, 1));
  }
}

function material(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
  const sn = attribute('aSnow', 'float');
  const n = mx_noise_float(positionWorld.mul(1.7));
  const top = normalWorld.y.add(n.mul(0.1)).smoothstep(0.6, 0.8).mul(sn);
  const base = TSL.vertexColor().mul(n.mul(0.08).add(1));
  m.colorNode = mix(base, vec3(0.8, 0.83, 0.87), top);
  m.roughnessNode = mix(float(0.78), float(0.86), top);
  return m;
}

export interface StandinStructures extends GfxSystem {
  readonly props: PropsSystem;
}

/** Adds KIT's props system for the registered models and one merged mesh for the rest. */
export function createStandinStructures(engine: CsEngine, world: World): StandinStructures {
  const kit: PropInst[] = [];
  const parts: THREE.BufferGeometry[] = [];
  for (const p of world.props) {
    if (hasModel(p.model)) {
      kit.push(p);
      continue;
    }
    const bp = blueprint(p.model);
    if (!bp) {
      simple(p, parts);
      continue;
    }
    const c = MODEL_COLOR[p.model] ?? DARK_METAL;
    const pl = placeBlueprint(bp, { x: p.x, y: p.y, z: p.z, yaw: p.yaw });
    for (const col of pl.colliders) {
      const kind = (col as { kind?: string }).kind;
      const cc = kind === 'furniture' ? FURNITURE : kind === 'rock' ? STONE : c;
      const snow = kind === 'furniture' ? 0 : 1;
      if (col.s === 'b') parts.push(box(col.x, col.z, col.hx, col.hz, col.yaw, col.y0, col.y1, cc, snow));
      else parts.push(post(col.x, col.z, col.r, col.y0, col.y1, cc, snow));
    }
    for (const f of pl.floors) parts.push(box(f.x, f.z, f.hx, f.hz, f.yaw, f.y - 0.12, f.y, FLOOR, 0));
    for (const s of pl.shelters) {
      if (!s.indoor) continue;
      // a roof over the room so the inside is in shade (blueprints have no roofs: they are not walls)
      const top = s.y + s.hy;
      parts.push(box(s.x, s.z, s.hx + 0.25, s.hz + 0.25, s.yaw, top, top + 0.16, p.model === 'cave_rocks' ? STONE : c, 1));
    }
  }
  const scene = engine.scene;
  let mesh: THREE.Mesh | null = null;
  const mat = material();
  if (parts.length) {
    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    if (merged) {
      merged.computeBoundingSphere();
      mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'standin-structures';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }
  // Barrels are drawn cold: a burning barrel is a FireEnt, and its flames come from the fire's own visual.
  const props = createPropsSystem({ scene, camera: engine.camera }, kit, {
    shadows: true,
    opts: (inst) => (inst.model === 'barrel' ? { lit: false } : undefined),
  });
  return {
    name: 'structures',
    props,
    update(): void {
      // static
    },
    dispose(): void {
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
      }
      mat.dispose();
    },
  };
}
