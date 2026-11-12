// Ground cover around the camera: twigs lying on the snow, small stones, dry grass tufts and shrub
// tips poking through. Sparse, placed by a hash of the world cell (the same cell always holds the
// same thing), never on the packed trail, the lake ice or a floor.
//
// GRID. A square of N x N cells (cell CELL m) centred on the camera, stored toroidally: world cell
// (i, j) lives in slot (i mod N, j mod N). When the camera crosses a cell border only the slots
// whose world cell changed are refilled, in place, in preallocated arrays: nothing is allocated per
// frame. Each slot holds at most one item, in one of two instance buffers: stones (drawn with the
// rock material, one draw) or plants (cards for twigs / grass / shrubs, one draw).
import * as THREE from 'three/webgpu';
import {
  Fn, attribute, cameraWorldMatrix, cos, float, fract, length, mix, normalLocal, normalViewGeometry, normalize, positionLocal, property,
  select, sin, smoothstep, step, texture, uniform, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { U } from '../shared';
import type { World } from '../../world/types';
import { hash01 } from '../../core/rng';
import { ForestMaterial, ditherNoise, gustAt, snowCoverage, snowShade, type N } from './common';
import { R, getFoliageAtlas, regionUV } from './textures';
import { ROCK_VARIANTS, RU, createRockMaterial, rockAssets } from './rocks';

const CELL = 1.6;

export const CU = {
  end: uniform(22), // m: cover fades out toward this distance
};

// item types in the plant geometry
const T_TWIG = 0, T_GRASS = 1, T_SHRUB = 2;

/** The plant cards of all three types in one geometry; the vertex shader keeps the instance's type. */
function plantGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [], uv: number[] = [], aT: number[] = [], idx: number[] = [];
  const quad = (type: number, p: number[][], r: typeof R.grass, sway: number[]): void => {
    const b = pos.length / 3;
    const uvs = [[0, 1], [1, 1], [1, 0], [0, 0]];
    for (let k = 0; k < 4; k++) {
      pos.push(p[k][0], p[k][1], p[k][2]);
      const [u, v] = regionUV(r, uvs[k][0], uvs[k][1]);
      uv.push(u, v);
      aT.push(type, sway[k], 0, 0);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  // twig: two cards lying on the snow, slightly raised at one end (unit length along +Z)
  for (const [a, w] of [[0, 0.55], [0.5, 0.4]]) {
    const c = Math.cos(a), s = Math.sin(a);
    const pt = (x: number, z: number, y: number): number[] => [x * c + z * s, y, z * c - x * s];
    const dead = { ...R.dead };
    quad(T_TWIG, [pt(-w / 2, -0.5, 0.02), pt(w / 2, -0.5, 0.02), pt(w / 2, 0.5, 0.06), pt(-w / 2, 0.5, 0.06)], dead, [0, 0, 0, 0]);
  }
  // grass: three vertical cards in a star, base at y = 0, unit height
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const c = Math.cos(a) * 0.5, s = Math.sin(a) * 0.5;
    quad(T_GRASS, [[-c, 0, -s], [c, 0, s], [c, 1, s], [-c, 1, -s]], R.grass, [0, 0, 1, 1]);
  }
  // shrub tip: two crossed cards
  for (let k = 0; k < 2; k++) {
    const a = (k / 2) * Math.PI + 0.4;
    const c = Math.cos(a) * 0.55, s = Math.sin(a) * 0.55;
    quad(T_SHRUB, [[-c, 0, -s], [c, 0, s], [c, 1, s], [-c, 1, -s]], R.shrub, [0, 0, 1, 1]);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 4));
  g.setIndex(idx);
  return g;
}

function plantMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new ForestMaterial();
  m.name = 'forest-cover';
  m.side = THREE.DoubleSide;
  m.alphaTest = 0.5;
  m.metalness = 0;
  const vT: N = varyingProperty('vec4', 'cT'); // type, height01, rnd, fade
  const vUV: N = varyingProperty('vec2', 'cUV');
  m.positionNode = Fn(() => {
    const cA: N = attribute('cA', 'vec4'); // x, y, z, size (0 = empty slot)
    const cB: N = attribute('cB', 'vec4'); // yaw, type, rnd, texture variant
    const aT: N = attribute('aT', 'vec4');
    const same: N = step(abs1(aT.x.sub(cB.y)), 0.5);
    const p: N = positionLocal.mul(cA.w);
    const c: N = cos(cB.x), s: N = sin(cB.x);
    const w: N = vec3(p.x.mul(c).add(p.z.mul(s)), p.y, p.z.mul(c).sub(p.x.mul(s)));
    // the tops of grass and shrubs sway (they are short and stiff: small amplitude, quick)
    const g: N = gustAt(cA.xz);
    const ph: N = cB.z.mul(6.28);
    const amp: N = U.windSpeed.mul(0.012).add(0.01).mul(g.add(0.3)).mul(aT.y).mul(cA.w);
    const sway: N = vec3(U.windDir.x, 0, U.windDir.y).mul(sin(U.time.mul(3.1).add(ph)).mul(0.6).add(0.5).mul(amp));
    const d: N = length(vec3(U.camPos).sub(cA.xyz));
    const fade: N = smoothstep(CU.end.sub(5), CU.end, d);
    const keep: N = same.mul(step(0.001, cA.w)).mul(step(fade, 0.999));
    vT.assign(vec4(cB.y, aT.y, cB.z, fade));
    // shrub cards carry the juniper shoot instead on some instances (the regions sit side by side)
    vUV.assign(attribute('uv', 'vec2').add(vec2(select(cB.y.equal(T_SHRUB), cB.w.mul(0.25), float(0)), 0)));
    // lying twigs face up, standing cards are lit like the ground around them
    normalLocal.assign(normalize(vec3(0, 1, 0)));
    return mix(cA.xyz, cA.xyz.add(w).add(sway), keep);
  })();
  const pRough: N = property('float', 'csCRough');
  const pEmis: N = property('vec3', 'csCEmis');
  m.colorNode = Fn(() => {
    const tex: N = texture(getFoliageAtlas(), vUV);
    const a: N = tex.a.sub(0.5).div(tex.a.fwidth().max(0.0001)).add(0.5).clamp(0, 1);
    const type: N = vT.x.add(0.5).floor();
    const rnd: N = vT.z;
    // dark and dull: bark, dead stems and shoots in snow light (the textures are drawn brighter)
    const dull: N = select(type.equal(T_GRASS), float(0.85), float(0.55));
    const col: N = tex.rgb.mul(float(0.8).add(fract(rnd.mul(17.3)).mul(0.4))).mul(dull);
    // twigs lie half sunk in the snow: a dusting over them; grass and shrub bases are buried
    const nW: N = normalize(normalViewGeometry).transformDirection(cameraWorldMatrix);
    const sh = snowShade(nW);
    const twigSnow: N = select(type.equal(T_TWIG), snowCoverage(float(0.7), fract(rnd.mul(41.7)).mul(0.6).add(tex.g.mul(2))), float(0));
    const baseSnow: N = select(type.equal(T_TWIG), float(0), smoothstep(0.14, 0.0, vT.y));
    const c: N = twigSnow.max(baseSnow);
    const n: N = ditherNoise();
    pRough.assign(mix(0.85, 0.88, c));
    pEmis.assign(sh.emissive.mul(c));
    return vec4(mix(col, sh.color, c), a.mul(step(vT.w, n)));
  })();
  m.roughnessNode = pRough;
  m.emissiveNode = pEmis;
  m.normalNode = normalize(normalViewGeometry);
  return m;
}

function abs1(x: N): N {
  return x.abs();
}

export interface CoverLayer {
  group: THREE.Group;
  update(camX: number, camZ: number): void;
  setAmount(groundCover: number): void;
  dispose(): void;
}

export function createCover(world: World): CoverLayer {
  const group = new THREE.Group();
  group.name = 'forest-cover';
  const N = 40; // slots per side at most (radius ~32 m); the active radius comes from quality
  const slots = N * N;
  const stoneA = new Float32Array(slots * 4), stoneB = new Float32Array(slots * 4), stoneC = new Float32Array(slots * 4);
  const plantA = new Float32Array(slots * 4), plantB = new Float32Array(slots * 4);
  const cellI = new Int32Array(slots).fill(0x7fffffff), cellJ = new Int32Array(slots).fill(0x7fffffff);

  const stoneGeo = new THREE.InstancedBufferGeometry();
  const ra = rockAssets();
  stoneGeo.index = ra.geo.far.index;
  stoneGeo.setAttribute('position', ra.geo.far.attributes.position);
  stoneGeo.setAttribute('normal', ra.geo.far.attributes.normal);
  const sA = new THREE.InstancedBufferAttribute(stoneA, 4), sB = new THREE.InstancedBufferAttribute(stoneB, 4), sC = new THREE.InstancedBufferAttribute(stoneC, 4);
  for (const a of [sA, sB, sC]) a.setUsage(THREE.DynamicDrawUsage);
  stoneGeo.setAttribute('rA', sA);
  stoneGeo.setAttribute('rB', sB);
  stoneGeo.setAttribute('rC', sC);
  stoneGeo.instanceCount = slots;
  const stones = new THREE.Mesh(stoneGeo, createRockMaterial('pebble'));
  stones.frustumCulled = false;
  stones.receiveShadow = true;
  stones.castShadow = false;
  stones.name = 'forest-cover-stones';
  group.add(stones);

  const plantGeo = plantGeometry();
  const pA = new THREE.InstancedBufferAttribute(plantA, 4), pB = new THREE.InstancedBufferAttribute(plantB, 4);
  pA.setUsage(THREE.DynamicDrawUsage);
  pB.setUsage(THREE.DynamicDrawUsage);
  plantGeo.setAttribute('cA', pA);
  plantGeo.setAttribute('cB', pB);
  plantGeo.instanceCount = slots;
  const plants = new THREE.Mesh(plantGeo, plantMaterial());
  plants.frustumCulled = false;
  plants.receiveShadow = true;
  plants.castShadow = false;
  plants.name = 'forest-cover-plants';
  group.add(plants);

  const masks = world.masks;
  const mN = masks.n, mExt = masks.extent, mCell = (2 * mExt) / (mN - 1);
  const maskAt = (ch: number, x: number, z: number): number => {
    const i = Math.min(mN - 1, Math.max(0, Math.round((x + mExt) / mCell)));
    const j = Math.min(mN - 1, Math.max(0, Math.round((z + mExt) / mCell)));
    return masks.data[(j * mN + i) * 4 + ch] / 255;
  };

  let amount = 0.6;
  let active = 0; // slots per side in use
  let dirty = true;

  function clump(x: number, z: number): number {
    const fx = x / 14, fz = z / 14;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const a = hash01(i, j, 0x7c1), b = hash01(i + 1, j, 0x7c1), c = hash01(i, j + 1, 0x7c1), d = hash01(i + 1, j + 1, 0x7c1);
    const n = a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
    return Math.min(1, Math.max(0, (n - 0.25) * 1.8));
  }

  function fill(slot: number, ci: number, cj: number): void {
    cellI[slot] = ci;
    cellJ[slot] = cj;
    const o = slot * 4;
    stoneC[o] = stoneC[o + 1] = stoneC[o + 2] = 0;
    plantA[o + 3] = 0;
    const h = (k: number): number => hash01(ci * 7 + k * 1000003, cj, 0x51ed);
    const x = (ci + h(1)) * CELL, z = (cj + h(2)) * CELL;
    if (Math.abs(x) > world.half - 2 || Math.abs(z) > world.half - 2) return;
    if (maskAt(3, x, z) > 0.2 || maskAt(2, x, z) > 0.35) return; // trail, ice
    const f = world.forestAt(x, z);
    const sd = world.snowDepthAt(x, z);
    const rk = maskAt(1, x, z);
    const thin = 1 - Math.min(1, sd / 0.55);
    const wTwig = (0.15 + 1.3 * f) * (0.4 + 0.6 * thin);
    const wStone = (0.12 + 1.6 * rk) * (0.25 + 0.75 * thin);
    const wGrass = (1 - f) * thin * 0.9 + 0.02;
    const wShrub = (f * (1 - f) * 2.2 + 0.08) * (0.5 + 0.5 * thin);
    const total = wTwig + wStone + wGrass + wShrub;
    // overall density: sparse; deep snow buries most of it
    // in clumps: a coarse value noise (14 m) thins whole patches
    const p = Math.min(0.75, (0.16 + 0.22 * total) * (0.35 + 0.65 * amount)) * clump(x, z);
    if (h(3) > p) return;
    const y = world.heightAt(x, z);
    if (world.groundAt(x, z, y + 4).y > y + 0.05) return; // a floor: inside a building
    let pick = h(4) * total;
    const yaw = h(5) * Math.PI * 2;
    const rnd = h(6);
    if ((pick -= wStone) < 0) {
      const s = 0.06 + 0.3 * h(7) * h(7);
      stoneA.set([x, y - s * 0.45, z, rnd], o);
      stoneB.set([yaw, (h(8) - 0.5) * 0.8, Math.floor(h(9) * ROCK_VARIANTS), 0], o);
      stoneC.set([s * (0.8 + 0.4 * h(10)), s * (0.5 + 0.4 * h(11)), s * (0.7 + 0.5 * h(12)), 0], o);
      return;
    }
    let type: number, size: number, sink: number, tv = 0;
    if ((pick -= wTwig) < 0) {
      type = T_TWIG;
      size = 0.25 + 0.5 * h(13);
      sink = 0.02;
    } else if ((pick -= wGrass) < 0) {
      type = T_GRASS;
      size = 0.16 + 0.3 * h(13);
      sink = 0.05 + 0.1 * h(14);
    } else {
      type = T_SHRUB;
      size = 0.22 + 0.33 * h(13);
      sink = 0.06 + 0.16 * h(14);
      tv = h(15) < 0.35 + 0.5 * f ? 1 : 0; // a conifer shoot under the trees, bare twigs in the open
    }
    plantA.set([x, y - sink, z, size], o);
    plantB.set([yaw, type, rnd, tv], o);
  }

  let lastI = 0x7fffffff, lastJ = 0x7fffffff;
  function update(camX: number, camZ: number): void {
    if (active === 0) return;
    const ci = Math.floor(camX / CELL), cj = Math.floor(camZ / CELL);
    if (ci === lastI && cj === lastJ && !dirty) return;
    lastI = ci;
    lastJ = cj;
    const h = active >> 1;
    let changed = dirty;
    for (let sj = 0; sj < active; sj++) {
      for (let si = 0; si < active; si++) {
        // the world cell this slot stands for in the window around the camera
        const i = ci - h + ((((si - (ci - h)) % active) + active) % active);
        const j = cj - h + ((((sj - (cj - h)) % active) + active) % active);
        const slot = sj * N + si;
        if (cellI[slot] !== i || cellJ[slot] !== j) {
          fill(slot, i, j);
          changed = true;
        }
      }
    }
    if (changed) {
      sA.needsUpdate = sB.needsUpdate = sC.needsUpdate = true;
      pA.needsUpdate = pB.needsUpdate = true;
      dirty = false;
    }
  }

  function setAmount(gc: number): void {
    amount = Math.max(0, Math.min(1, gc));
    const radius = amount <= 0 ? 0 : 9 + 22 * amount;
    active = Math.min(N, Math.ceil((2 * radius) / CELL) | 1);
    if (amount <= 0) active = 0;
    CU.end.value = radius;
    RU.coverEnd.value = radius;
    cellI.fill(0x7fffffff);
    stoneC.fill(0);
    plantA.fill(0);
    dirty = true;
    group.visible = active > 0;
    sA.needsUpdate = sB.needsUpdate = sC.needsUpdate = true;
    pA.needsUpdate = pB.needsUpdate = true;
  }

  return {
    group,
    update,
    setAmount,
    dispose(): void {
      stoneGeo.dispose();
      plantGeo.dispose();
      (stones.material as THREE.Material).dispose();
      (plants.material as THREE.Material).dispose();
    },
  };
}
