// STAND-IN for gfx/forest (FOREST), until the real system replaces it through src/game/visuals.ts.
// world.trees as instanced dark tiered cones with white snow loads (a detailed set near the
// camera, one simple cone per tree beyond), snags as grey broken trunks; world.rocks as instanced
// lumps with snow on their tops, sunk into the ground. The near / far split is rebuilt when the
// camera has moved far enough; nothing is allocated per frame.
// Owner: GAME.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { hash01 } from '../../core/rng';
import type { Frame, GfxSystem, Quality } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import type { World } from '../../world/types';

const { normalWorld, positionWorld, vec3, mix, mx_noise_float, float } = TSL as any;

const TREE_H = 14; // metres at scale 1
const NEAR_TREES = 160; // metres of detailed trees
const NEAR_ROCKS = 160;
const REBUILD = 24; // metres the camera may move before the sets are rebuilt

type RGB = [number, number, number];
const NEEDLE: RGB = [0.022, 0.04, 0.03];
const NEEDLE_LIT: RGB = [0.034, 0.056, 0.04];
const SNOW: RGB = [0.8, 0.83, 0.87];

const blend = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Tiered spruce crown, unit size: base radius 1 near the ground, tip at y = 1. Vertex colours
 * carry the snow lying on each whorl (`snow` 0..1 how much).
 */
function crownGeometry(tiers: number, seg: number, snow: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const LOAD = blend(NEEDLE_LIT, SNOW, 0.35 + 0.55 * snow);
  const ring = (r: number, y: number, c: RGB, twist: number): number => {
    const base = pos.length / 3;
    for (let i = 0; i < seg; i++) {
      const a = ((i + twist) / seg) * Math.PI * 2;
      // a little irregular, so neighbours do not read as clones
      const rr = r * (1 + 0.12 * Math.sin(i * 2.3 + twist * 5));
      pos.push(Math.sin(a) * rr, y, Math.cos(a) * rr);
      col.push(c[0], c[1], c[2]);
    }
    return base;
  };
  const strip = (a: number, b: number) => {
    for (let i = 0; i < seg; i++) {
      const i1 = (i + 1) % seg;
      idx.push(a + i, a + i1, b + i, b + i, a + i1, b + i1);
    }
  };
  const y0 = 0.05, top = 1;
  for (let t = 0; t < tiers; t++) {
    const f = t / tiers;
    const yb = y0 + (top - y0) * f * 0.9;
    const h = (top - y0) * (0.4 - 0.1 * f);
    const r = 1 - f * 0.8;
    const tw = t * 0.37;
    const outer = ring(r, yb, NEEDLE, tw); // drooping branch tips: dark
    const load = ring(r * 0.7, yb + h * 0.22, LOAD, tw + 0.5); // snow lying on the whorl
    const inner = ring(r * 0.3, yb + h * 0.62, t === tiers - 1 ? LOAD : NEEDLE_LIT, tw); // the next tier shades it
    strip(outer, load);
    strip(load, inner);
    if (t === tiers - 1) {
      const tip = pos.length / 3;
      pos.push(0, Math.min(top, yb + h * 1.05), 0);
      col.push(NEEDLE[0], NEEDLE[1], NEEDLE[2]);
      for (let i = 0; i < seg; i++) idx.push(inner + i, inner + ((i + 1) % seg), tip);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** One cone for the far forest: dark sides, a pale tip. Unit size like the crown. */
function farConeGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.72, 0.95, 5, 1, true);
  g.translate(0, 0.05 + 0.475, 0);
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  // as dark as the near crowns seen from afar: the snow loads mostly hide under the next whorl
  const mid = blend(NEEDLE_LIT, SNOW, 0.3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, (p.getY(i) - 0.05) / 0.95));
    const c = t > 0.9 ? mid : NEEDLE;
    col.set([c[0], c[1], c[2]], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function colored(g: THREE.BufferGeometry, c: RGB): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A lumpy unit rock (radius about 1), deterministic per variant. */
function rockGeometry(detail: number, variant: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.78 + 0.34 * hash01(Math.round(x * 97), Math.round(y * 97) + variant * 131, Math.round(z * 97));
    // flatter bottoms and faceted tops read as broken stone rather than balls
    p.setXYZ(i, x * k, y * k * (y < 0 ? 0.7 : 1), z * k);
  }
  // non-indexed: coincident corners got the same push (keyed by position), and the normals stay faceted
  g.computeVertexNormals();
  return g;
}

function treeMaterial(): THREE.MeshStandardNodeMaterial {
  // The vertex colour is read explicitly: with `vertexColors: true` on an instanced, shadow-receiving
  // mesh the colour came out white in r187 (trees brighter than the snow at night). The instance
  // tint is still multiplied in by NodeMaterial.
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  m.colorNode = TSL.vertexColor();
  return m;
}

function rockMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const n = mx_noise_float(positionWorld.mul(0.9));
  const fine = mx_noise_float(positionWorld.mul(5.1));
  const rock = vec3(0.058, 0.056, 0.054).mul(n.mul(0.25).add(fine.mul(0.12)).add(1));
  // snow covers everything but the steep sides, ragged at the edge
  const cap = normalWorld.y.add(n.mul(0.15)).add(fine.mul(0.06)).smoothstep(0.28, 0.55);
  m.colorNode = mix(rock, vec3(SNOW[0], SNOW[1], SNOW[2]), cap);
  m.roughnessNode = mix(float(0.92), float(0.85), cap);
  return m;
}

interface Set {
  mesh: THREE.InstancedMesh;
  arr: Float32Array;
  n: number;
}

function makeSet(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, name: string, shadow: boolean, tint: boolean): Set {
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = name;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // instances span the whole map; three would cull by the first ones
  mesh.count = 0;
  if (tint) {
    const c = new THREE.Color();
    for (let i = 0; i < cap; i++) {
      const v = 0.82 + 0.22 * hash01(i, 77);
      mesh.setColorAt(i, c.setRGB(v, v, v * (0.97 + 0.06 * hash01(i, 78))));
    }
  }
  return { mesh, arr: mesh.instanceMatrix.array as Float32Array, n: 0 };
}

/** Write a T * Ry(yaw) * S matrix into a set. */
function put(s: Set, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number): void {
  if (s.n >= s.mesh.instanceMatrix.count) return;
  const e = s.arr, o = s.n * 16;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  e[o] = c * sx; e[o + 1] = 0; e[o + 2] = -sn * sx; e[o + 3] = 0;
  e[o + 4] = 0; e[o + 5] = sy; e[o + 6] = 0; e[o + 7] = 0;
  e[o + 8] = sn * sz; e[o + 9] = 0; e[o + 10] = c * sz; e[o + 11] = 0;
  e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
  s.n++;
}

function finish(s: Set): void {
  s.mesh.count = s.n;
  s.mesh.instanceMatrix.needsUpdate = true;
  s.mesh.instanceMatrix.clearUpdateRanges();
  s.mesh.instanceMatrix.addUpdateRange(0, s.n * 16);
}

export function createStandinForest(engine: CsEngine, world: World): GfxSystem {
  const trees = world.trees;
  const rocks = world.rocks;
  const group = new THREE.Group();
  group.name = 'standin-forest';
  const tmat = treeMaterial();
  const rmat = rockMaterial();

  const crownLight = crownGeometry(4, 6, 0.25);
  const crownHeavy = crownGeometry(4, 6, 0.85);
  const trunk = colored(new THREE.CylinderGeometry(0.6, 1, 1, 5, 1, true).translate(0, 0.5, 0), [0.075, 0.058, 0.045]);
  const snag = colored(new THREE.CylinderGeometry(0.35, 1, 1, 5, 1, false).translate(0, 0.5, 0), [0.2, 0.19, 0.18]);
  const far = farConeGeometry();
  const nTrees = trees.length;
  const nearLight = makeSet(crownLight, tmat, 4000, 'standin-crowns', true, true);
  const nearHeavy = makeSet(crownHeavy, tmat, 4000, 'standin-crowns-snowy', true, true);
  const nearTrunks = makeSet(trunk, tmat, 6000, 'standin-trunks', true, false);
  const snags = makeSet(snag, tmat, 3000, 'standin-snags', true, true);
  const farCones = makeSet(far, tmat, nTrees, 'standin-far-trees', false, true);
  const rockNear = makeSet(rockGeometry(1, 0), rmat, 4000, 'standin-rocks', true, false);
  const rockFar = makeSet(rockGeometry(0, 1), rmat, Math.max(1, rocks.length), 'standin-far-rocks', false, false);
  const sets = [farCones, rockFar, nearTrunks, nearLight, nearHeavy, snags, rockNear];
  for (const s of sets) group.add(s.mesh);
  engine.scene.add(group);

  let density = 0.85;
  let cx = NaN, cz = NaN;
  // a per-rock tilt matrix scratch
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const eul = new THREE.Euler();
  const v3 = new THREE.Vector3();
  const s3 = new THREE.Vector3();

  function rebuild(x: number, z: number): void {
    cx = x;
    cz = z;
    for (const s of sets) s.n = 0;
    const r2 = NEAR_TREES * NEAR_TREES;
    for (let i = 0; i < nTrees; i++) {
      if (hash01(i, 913) > density) continue;
      const t = trees[i];
      const h = TREE_H * t.scale;
      const dx = t.x - x, dz = t.z - z;
      const near = dx * dx + dz * dz < r2;
      if (t.kind === 'snag') {
        if (near) put(snags, t.x, t.y - 0.3, t.z, t.yaw, h * 0.022, h * 0.72, h * 0.022);
        continue;
      }
      // crown radius / height: spruce about a seventh, subalpine fir a narrow spire
      const rf = t.kind === 'fir' ? 0.11 : t.kind === 'sapling' ? 0.2 : 0.155;
      // snow load widens the crown a little and pushes it down
      const r = h * rf * (1 + 0.08 * t.snow);
      if (near) {
        put(t.snow > 0.5 ? nearHeavy : nearLight, t.x, t.y - 0.2, t.z, t.yaw, r, h, r);
        if (t.kind !== 'sapling') put(nearTrunks, t.x, t.y - 0.3, t.z, t.yaw, h * 0.018, h * 0.32, h * 0.018);
      } else put(farCones, t.x, t.y - 0.2, t.z, t.yaw, r, h, r);
    }
    const rr2 = NEAR_ROCKS * NEAR_ROCKS;
    for (let i = 0; i < rocks.length; i++) {
      const k = rocks[i];
      const dx = k.x - x, dz = k.z - z;
      const d2 = dx * dx + dz * dz;
      // small stones vanish into the snow at a distance; boulders show to 900 m
      const size = Math.max(k.sx, k.sy, k.sz);
      const reach = size > 2 ? 900 : size > 0.8 ? 500 : 260;
      if (d2 > reach * reach) continue;
      const set = d2 < rr2 ? rockNear : rockFar;
      if (set.n >= set.mesh.instanceMatrix.count) continue;
      eul.set(k.tilt, k.yaw, 0, 'YXZ');
      q.setFromEuler(eul);
      m4.compose(v3.set(k.x, k.y + k.sy * 0.25, k.z), q, s3.set(k.sx, k.sy, k.sz));
      m4.toArray(set.arr, set.n * 16);
      set.n++;
    }
    for (const s of sets) finish(s);
  }

  return {
    name: 'forest',
    setQuality(qu: Quality): void {
      density = qu.treeDensity;
      cx = NaN; // rebuild on the next frame
    },
    update(f: Frame): void {
      const c = f.view.camera;
      const dx = c.x - cx, dz = c.z - cz;
      if (!(dx * dx + dz * dz < REBUILD * REBUILD)) rebuild(c.x, c.z);
    },
    dispose(): void {
      engine.scene.remove(group);
      for (const g of [crownLight, crownHeavy, trunk, snag, far]) g.dispose();
      tmat.dispose();
      rmat.dispose();
    },
  };
}
