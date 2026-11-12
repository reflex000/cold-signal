// THE FOREST: world.trees (about 32k spruce, fir, saplings and snags), world.rocks (about 10k) and
// ground cover around the camera, as one GfxSystem named 'forest'.
//
//   import { createForestSystem } from './gfx/forest';
//   engine.add(createForestSystem(engine, world));   // before engine.warmup()
//
// WHAT IS DRAWN, at most 11 draws in the main pass (+ shadow casters per cascade):
//   spruce full, fir full, snag    3D trees near (to ~0.38 * quality.treeNear), cast shadows
//   spruce mid, fir mid            simplified 3D trees to quality.treeNear, cast shadows
//   impostors                      every tree, one static buffer; beyond treeNear (vertex-culled)
//   rocks near / mid / far         one draw each for all eight variants (near and mid cast)
//   cover stones / cover plants    around the camera (quality.groundCover)
// Each 3D level gets the instances of its distance band every frame, frustum-visible first: the
// main pass draws only those, the shadow passes draw them all (onBeforeShadow / onAfterShadow swap
// geometry.instanceCount), so trees behind the camera still cast their shadows into view. The exact
// crossfades are per instance in the shaders (treemat.ts). Bake of the impostor atlas: at creation,
// with the engine's renderer (impostor.ts), typically well under a second.
//
// Saplings are drawn as small spruce or fir, sunk into the snow. Collision is World's, not ours.
import * as THREE from 'three/webgpu';
import type { Engine, Frame, GfxSystem, Quality } from '../api';
import type { World } from '../../world/types';
import { hash01 } from '../../core/rng';
import { FU, createProxyMaterial, createTreeDepthMaterial, createTreeMaterial } from './treemat';
import { SNAG_H, TREE_H, proxyGeometry, treeGeometry, type GeoKind, type GeoLod } from './treegen';
import { bakeImpostors, createImpostorDepthMaterial, createImpostorMaterial, impostorGeometry, type ImpostorAtlas } from './impostor';
import { RU, createRockMaterial, rockAssets } from './rocks';
import { createCover, type CoverLayer } from './cover';

export { FU } from './treemat';
export { RU } from './rocks';

export interface ForestSystem extends GfxSystem {
  readonly group: THREE.Group;
  /** Draw statistics of the last frame (instances per level). */
  readonly counts: { full: number; mid: number; snag: number; rockNear: number; rockMid: number; impostorBakeMs: number };
  /** The baked impostor atlas (albedo + coverage, aux = normal xz, AO, snow potential), for debugging. */
  readonly impostorAtlas: { albedo: THREE.Texture; aux: THREE.Texture } | null;
  /** Bench / debug: tint by level of detail. */
  setLodTint(on: boolean): void;
  /** Bench: freeze the wind (0) or scale it. */
  setWindScale(k: number): void;
}

const CHUNK = 32;

/** A growable pair of instance buffers (two vec4 per instance) on an InstancedBufferGeometry. */
class InstanceSet {
  geo: THREE.InstancedBufferGeometry;
  a: THREE.InstancedBufferAttribute;
  b: THREE.InstancedBufferAttribute;
  c: THREE.InstancedBufferAttribute | null;
  cap = 0;
  nVis = 0;
  nAll = 0;
  private hid = 0;
  constructor(base: THREE.BufferGeometry, private names: [string, string, string?], cap: number) {
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    for (const k of Object.keys(base.attributes)) this.geo.setAttribute(k, base.attributes[k]);
    this.a = this.b = null as unknown as THREE.InstancedBufferAttribute;
    this.c = null;
    this.alloc(cap);
    this.geo.instanceCount = 0; // the default is Infinity: a draw before the first update would be invalid
  }
  private alloc(cap: number): void {
    const old = this.cap ? [this.a.array as Float32Array, this.b.array as Float32Array, this.c?.array as Float32Array | undefined] : null;
    this.cap = cap;
    const mk = (name: string, prev?: Float32Array): THREE.InstancedBufferAttribute => {
      const arr = new Float32Array(cap * 4);
      if (prev) arr.set(prev.subarray(0, Math.min(prev.length, arr.length)));
      const at = new THREE.InstancedBufferAttribute(arr, 4);
      at.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, at);
      return at;
    };
    this.a = mk(this.names[0], old?.[0]);
    this.b = mk(this.names[1], old?.[1]);
    this.c = this.names[2] ? mk(this.names[2], old?.[2]) : null;
  }
  begin(): void {
    this.nVis = 0;
    this.hid = 0;
  }
  /** Add one instance: visible ones fill from the front, hidden ones from the back. */
  push(src: Float32Array, srcB: Float32Array, srcC: Float32Array | null, i: number, visible: boolean): void {
    if (this.nVis + this.hid >= this.cap) this.grow();
    const k = visible ? this.nVis++ : this.cap - 1 - this.hid++;
    const A = this.a.array as Float32Array, B = this.b.array as Float32Array;
    const o = k * 4, s = i * 4;
    A[o] = src[s]; A[o + 1] = src[s + 1]; A[o + 2] = src[s + 2]; A[o + 3] = src[s + 3];
    B[o] = srcB[s]; B[o + 1] = srcB[s + 1]; B[o + 2] = srcB[s + 2]; B[o + 3] = srcB[s + 3];
    if (srcC && this.c) {
      const C = this.c.array as Float32Array;
      C[o] = srcC[s]; C[o + 1] = srcC[s + 1]; C[o + 2] = srcC[s + 2]; C[o + 3] = srcC[s + 3];
    }
  }
  private grow(): void {
    // keep both ends: move the hidden tail to the end of the bigger arrays
    const oldCap = this.cap;
    const tails = [this.a, this.b, this.c].map((at) => (at ? (at.array as Float32Array).slice((oldCap - this.hid) * 4) : null));
    this.alloc(oldCap * 2);
    [this.a, this.b, this.c].forEach((at, n) => {
      const t = tails[n];
      if (at && t) (at.array as Float32Array).set(t, (this.cap - this.hid) * 4);
    });
  }
  /** Close the frame: hidden instances right after the visible ones, upload, set the main-pass count. */
  end(): void {
    const n = this.nVis + this.hid;
    this.close(this.a, n);
    this.close(this.b, n);
    if (this.c) this.close(this.c, n);
    this.nAll = n;
    this.geo.instanceCount = this.nVis;
  }
  private close(at: THREE.InstancedBufferAttribute, n: number): void {
    const arr = at.array as Float32Array;
    if (this.hid > 0) arr.copyWithin(this.nVis * 4, (this.cap - this.hid) * 4, this.cap * 4);
    at.clearUpdateRanges();
    at.addUpdateRange(0, Math.max(4, n * 4));
    at.needsUpdate = true;
  }
}

/** A mesh drawn only into shadow maps: its main-pass instance count is zero (no draw at all). */
function makeShadowOnly(set: InstanceSet, mat: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(set.geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  let inShadow = false;
  mesh.onBeforeShadow = () => {
    inShadow = true;
    set.geo.instanceCount = set.nAll;
  };
  mesh.onAfterShadow = () => {
    inShadow = false;
    set.geo.instanceCount = 0;
  };
  mesh.onBeforeRender = () => {
    if (!inShadow) set.geo.instanceCount = 0;
  };
  return mesh;
}

function makeMesh(set: InstanceSet, mat: THREE.Material, name: string, order: number, shadowAll: boolean): THREE.Mesh {
  const mesh = new THREE.Mesh(set.geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = order;
  if (shadowAll) {
    // shadow passes draw the off-screen instances too
    mesh.onBeforeShadow = () => {
      set.geo.instanceCount = set.nAll;
    };
    mesh.onAfterShadow = () => {
      set.geo.instanceCount = set.nVis;
    };
  }
  return mesh;
}

export function createForestSystem(engine: Engine, world: World): ForestSystem {
  const group = new THREE.Group();
  group.name = 'forest';
  engine.scene.add(group);

  // ---------------- trees: static instance data for all of them ----------------
  const trees = world.trees;
  const nT = trees.length;
  const tA = new Float32Array(nT * 4); // x, y (sunk), z, scale
  const tB = new Float32Array(nT * 4); // yaw, kind*8+variant, snow, rnd
  const tKind = new Uint8Array(nT); // 0 spruce, 1 fir, 2 snag
  const tH = new Float32Array(nT); // height m
  for (let i = 0; i < nT; i++) {
    const t = trees[i];
    const r1 = hash01(i, 0x5a17), r2 = hash01(i, 0x77e1), r3 = hash01(i, 0x13c5);
    const kind = t.kind === 'pine' ? 0 : t.kind === 'fir' ? 1 : t.kind === 'snag' ? 2 : r1 < 0.55 ? 1 : 0;
    const H = (kind === 2 ? SNAG_H : TREE_H) * t.scale;
    const sd = world.snowDepthAt(t.x, t.z);
    let sink: number;
    if (t.kind === 'sapling') sink = sd + H * (0.12 + 0.32 * r2);
    else if (kind === 2) sink = 0.2 + 0.5 * sd;
    else {
      sink = 0.15 + 0.7 * sd;
      // some young trees stand half buried in drifts
      if (t.scale < 0.7 && sd > 0.45 && r3 < 0.4) sink += H * (0.18 + 0.2 * r2);
    }
    tA[i * 4] = t.x;
    tA[i * 4 + 1] = t.y - sink;
    tA[i * 4 + 2] = t.z;
    tA[i * 4 + 3] = t.scale;
    tB[i * 4] = t.yaw;
    tB[i * 4 + 1] = kind * 8 + (t.variant & 7);
    tB[i * 4 + 2] = Math.max(0, Math.min(1, t.snow));
    tB[i * 4 + 3] = hash01(i, 0x2b3d);
    tKind[i] = kind;
    tH[i] = H;
  }

  // chunk grid (CSR) over the world for candidate lookups
  const ext = world.half + 64;
  const GN = Math.ceil((2 * ext) / CHUNK);
  const buildGrid = (n: number, xz: (i: number) => [number, number]): { start: Int32Array; items: Int32Array } => {
    const count = new Int32Array(GN * GN + 1);
    const cellOf = (i: number): number => {
      const [x, z] = xz(i);
      const ci = Math.min(GN - 1, Math.max(0, Math.floor((x + ext) / CHUNK)));
      const cj = Math.min(GN - 1, Math.max(0, Math.floor((z + ext) / CHUNK)));
      return cj * GN + ci;
    };
    for (let i = 0; i < n; i++) count[cellOf(i) + 1]++;
    for (let c = 0; c < GN * GN; c++) count[c + 1] += count[c];
    const fillp = count.slice(0, GN * GN);
    const items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[fillp[cellOf(i)]++] = i;
    return { start: count, items };
  };
  const tGrid = buildGrid(nT, (i) => [tA[i * 4], tA[i * 4 + 2]]);

  // ---------------- 3D tree levels ----------------
  // each level: a depth prepass (cheap alpha test) and the lit pass (depth EQUAL) on one instance
  // set; conifers cast through shadow-only proxies, snags through their own depth pass
  const meshes: THREE.Mesh[] = [];
  const casters: THREE.Mesh[] = [];
  const fullDepth: THREE.Mesh[] = [];
  const level = (kind: GeoKind, lod: GeoLod): InstanceSet => {
    const set = new InstanceSet(treeGeometry(kind, lod), ['iA', 'iB'], 1024);
    // prepasses go first of everything (render order -2): the terrain and whatever else stands
    // behind the trees is then rejected by early depth testing instead of being shaded
    const depth = makeMesh(set, createTreeDepthMaterial(kind, lod), `forest-${kind}-${lod}-depth`, lod === 'full' ? -2 : -1, kind === 'snag' || lod === 'full');
    if (lod === 'full' && kind !== 'snag') fullDepth.push(depth);
    const lit = makeMesh(set, createTreeMaterial(kind, lod), `forest-${kind}-${lod}`, 2, false);
    lit.castShadow = false;
    depth.receiveShadow = false;
    if (kind === 'snag') casters.push(depth);
    meshes.push(depth, lit);
    group.add(depth, lit);
    return set;
  };
  const spruceFull = level('spruce', 'full');
  const firFull = level('fir', 'full');
  const snagSet = level('snag', 'full');
  const spruceMid = level('spruce', 'mid');
  const firMid = level('fir', 'mid');
  const proxy = (kind: 'spruce' | 'fir'): InstanceSet => {
    const set = new InstanceSet(proxyGeometry(kind), ['iA', 'iB'], 1024);
    const mesh = makeShadowOnly(set, createProxyMaterial(kind), `forest-${kind}-proxy`);
    meshes.push(mesh);
    casters.push(mesh);
    group.add(mesh);
    return set;
  };
  const spruceProxy = proxy('spruce');
  const firProxy = proxy('fir');
  let shadowRange = 110; // quality.shadowDistance
  let realShadows = false; // high / ultra: the full meshes cast their own (card) shadows

  // ---------------- impostors ----------------
  let atlas: ImpostorAtlas | null = null;
  try {
    atlas = bakeImpostors(engine.renderer);
  } catch (e) {
    console.error('[forest] impostor bake failed; far trees are off', e);
  }
  let impostors: THREE.Mesh | null = null;
  let impostorDepth: THREE.Mesh | null = null;
  if (atlas) {
    const g = impostorGeometry();
    g.setAttribute('iA', new THREE.InstancedBufferAttribute(tA, 4));
    g.setAttribute('iB', new THREE.InstancedBufferAttribute(tB, 4));
    g.instanceCount = nT;
    impostorDepth = new THREE.Mesh(g, createImpostorDepthMaterial(atlas));
    impostorDepth.name = 'forest-impostors-depth';
    impostorDepth.frustumCulled = false;
    impostorDepth.castShadow = false;
    impostorDepth.renderOrder = -1;
    impostors = new THREE.Mesh(g, createImpostorMaterial(atlas));
    impostors.name = 'forest-impostors';
    impostors.frustumCulled = false;
    impostors.receiveShadow = true;
    impostors.castShadow = false;
    impostors.renderOrder = 4;
    group.add(impostorDepth, impostors);
  }

  // ---------------- rocks ----------------
  const rocks = world.rocks;
  const nR = rocks.length;
  const rA = new Float32Array(nR * 4), rB = new Float32Array(nR * 4), rC = new Float32Array(nR * 4);
  for (let i = 0; i < nR; i++) {
    const r = rocks[i];
    const sd = world.snowDepthAt(r.x, r.z);
    const sink = (0.24 + 0.12 * hash01(i, 0x6b1)) * r.sy + 0.35 * sd;
    rA.set([r.x, r.y - sink, r.z, hash01(i, 0x19f)], i * 4);
    rB.set([r.yaw, r.tilt, r.variant & 7, 0], i * 4);
    rC.set([r.sx, r.sy, r.sz, 0], i * 4);
  }
  const rGrid = buildGrid(nR, (i) => [rA[i * 4], rA[i * 4 + 2]]);
  const ra = rockAssets();
  const rockNear = new InstanceSet(ra.geo.near, ['rA', 'rB', 'rC'], 512);
  const rockMid = new InstanceSet(ra.geo.mid, ['rA', 'rB', 'rC'], 1024);
  const rockNearMesh = makeMesh(rockNear, createRockMaterial('near'), 'forest-rocks-near', 1, true);
  const rockMidMesh = makeMesh(rockMid, createRockMaterial('mid'), 'forest-rocks-mid', 3, true);
  casters.push(rockNearMesh, rockMidMesh);
  group.add(rockNearMesh, rockMidMesh);
  const farGeo = new THREE.InstancedBufferGeometry();
  farGeo.index = ra.geo.tiny.index;
  farGeo.setAttribute('position', ra.geo.far.attributes.position);
  farGeo.setAttribute('normal', ra.geo.far.attributes.normal);
  farGeo.setAttribute('rA', new THREE.InstancedBufferAttribute(rA, 4));
  farGeo.setAttribute('rB', new THREE.InstancedBufferAttribute(rB, 4));
  farGeo.setAttribute('rC', new THREE.InstancedBufferAttribute(rC, 4));
  farGeo.instanceCount = nR;
  const rockFar = new THREE.Mesh(farGeo, createRockMaterial('far'));
  rockFar.name = 'forest-rocks-far';
  rockFar.frustumCulled = false;
  rockFar.receiveShadow = true;
  rockFar.castShadow = false;
  rockFar.renderOrder = 3;
  group.add(rockFar);

  // ---------------- ground cover ----------------
  const cover: CoverLayer = createCover(world);
  cover.group.renderOrder = 2;
  for (const c of cover.group.children) c.renderOrder = 2;
  group.add(cover.group);

  // ---------------- per frame ----------------
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const camPos = new THREE.Vector3();
  const lastMat = new Float32Array(16).fill(NaN);
  const lastProj = new Float32Array(16).fill(NaN);
  let force = true;
  const counts = { full: 0, mid: 0, snag: 0, rockNear: 0, rockMid: 0, impostorBakeMs: atlas ? atlas.ms : 0 };

  function changed(cam: THREE.Camera): boolean {
    const m = cam.matrixWorld.elements, p = (cam as THREE.PerspectiveCamera).projectionMatrix.elements;
    let diff = force;
    for (let k = 0; k < 16; k++) {
      if (Math.abs(m[k] - lastMat[k]) > 1e-5 || Math.abs(p[k] - lastProj[k]) > 1e-6 || Number.isNaN(lastMat[k])) {
        diff = true;
        break;
      }
    }
    if (diff) {
      for (let k = 0; k < 16; k++) {
        lastMat[k] = m[k];
        lastProj[k] = p[k];
      }
    }
    force = false;
    return diff;
  }

  function gather(grid: { start: Int32Array; items: Int32Array }, x: number, z: number, r: number, fn: (i: number) => void): void {
    const i0 = Math.max(0, Math.floor((x - r + ext) / CHUNK)), i1 = Math.min(GN - 1, Math.floor((x + r + ext) / CHUNK));
    const j0 = Math.max(0, Math.floor((z - r + ext) / CHUNK)), j1 = Math.min(GN - 1, Math.floor((z + r + ext) / CHUNK));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * GN + i;
        for (let q = grid.start[c]; q < grid.start[c + 1]; q++) fn(grid.items[q]);
      }
    }
  }

  // per-frame parameters of the candidate visitors (hoisted: no closure per frame)
  let fullMax = 0, midMin = 0, nearMax = 0, thinFrom = 0, dens = 1, proxyMin = 0, proxyMax = 0;
  const visitTree = (i: number): void => {
    const o = i * 4;
    const H = tH[i];
    const cx = tA[o] - camPos.x, cy = tA[o + 1] + H * 0.45 - camPos.y, cz = tA[o + 2] - camPos.z;
    const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (d > nearMax) return;
    if (d > thinFrom && tB[o + 3] >= dens) return; // thinned away at this distance
    sphere.center.set(tA[o], tA[o + 1] + H * 0.5, tA[o + 2]);
    sphere.radius = H * 0.62 + 2;
    const vis = frustum.intersectsSphere(sphere);
    const k = tKind[i];
    if (k === 2) {
      snagSet.push(tA, tB, null, i, vis);
      return;
    }
    if (d < fullMax) (k === 0 ? spruceFull : firFull).push(tA, tB, null, i, vis);
    if (d > midMin) (k === 0 ? spruceMid : firMid).push(tA, tB, null, i, vis);
    if (d < proxyMax && d > proxyMin) (k === 0 ? spruceProxy : firProxy).push(tA, tB, null, i, true);
  };

  function updateTrees(): void {
    const near = FU.nearEnd.value as number;
    const fEnd = FU.fullEnd.value as number, fBand = FU.fullBand.value as number;
    thinFrom = FU.thin1.value as number;
    dens = FU.density.value as number;
    fullMax = fEnd + fBand * 0.5 + 1;
    midMin = fEnd - fBand * 0.5 - 1;
    nearMax = near + 1;
    proxyMax = Math.min(shadowRange + 10, near - (FU.nearBand.value as number) + 1);
    // with real (card) shadows from the full meshes, proxies only stand in beyond them
    proxyMin = realShadows ? fEnd - fBand : -1;
    spruceFull.begin(); firFull.begin(); snagSet.begin(); spruceMid.begin(); firMid.begin();
    spruceProxy.begin(); firProxy.begin();
    gather(tGrid, camPos.x, camPos.z, nearMax + 12, visitTree);
    spruceFull.end(); firFull.end(); snagSet.end(); spruceMid.end(); firMid.end();
    spruceProxy.end(); firProxy.end();
    spruceProxy.geo.instanceCount = 0;
    firProxy.geo.instanceCount = 0;
    counts.full = spruceFull.nAll + firFull.nAll;
    counts.mid = spruceMid.nAll + firMid.nAll;
    counts.snag = snagSet.nAll;
  }

  let rNearMax = 0, rMidMin = 0, rMidMax = 0;
  const visitRock = (i: number): void => {
    const o = i * 4;
    const cx = rA[o] - camPos.x, cy = rA[o + 1] - camPos.y, cz = rA[o + 2] - camPos.z;
    const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (d > rMidMax) return;
    const s = Math.max(rC[o], rC[o + 1], rC[o + 2]);
    sphere.center.set(rA[o], rA[o + 1], rA[o + 2]);
    sphere.radius = s * 1.4 + 1;
    const vis = frustum.intersectsSphere(sphere);
    if (d < rNearMax) rockNear.push(rA, rB, rC, i, vis);
    if (d > rMidMin) rockMid.push(rA, rB, rC, i, vis);
  };

  function updateRocks(): void {
    const nEnd = RU.nearEnd.value as number, nBand = RU.nearBand.value as number, mEnd = RU.midEnd.value as number;
    rNearMax = nEnd + nBand * 0.5 + 1;
    rMidMin = nEnd - nBand * 0.5 - 1;
    rMidMax = mEnd + 1;
    rockNear.begin();
    rockMid.begin();
    gather(rGrid, camPos.x, camPos.z, mEnd + 6, visitRock);
    rockNear.end();
    rockMid.end();
    counts.rockNear = rockNear.nAll;
    counts.rockMid = rockMid.nAll;
  }

  function applyQuality(q: Quality): void {
    const near = Math.max(20, q.treeNear);
    FU.nearEnd.value = near;
    // short bands where there is no anti-aliasing to soften the dither (phones, low)
    const soft = q.aa !== 'none' && q.name !== 'low';
    FU.nearBand.value = Math.min(20, Math.max(soft ? 6 : 3.5, near * (soft ? 0.15 : 0.1)));
    FU.fullEnd.value = Math.min(55, Math.max(12, near * 0.3));
    FU.fullBand.value = Math.min(8, Math.max(soft ? 3 : 1.6, near * (soft ? 0.06 : 0.045)));
    // thinning only among the impostors: a whole 3D tree fading by dither reads as a skeleton
    FU.thin0.value = near * 1.15 + 6;
    FU.thin1.value = near * 1.55 + 14;
    FU.density.value = Math.max(0.05, Math.min(1, q.treeDensity));
    FU.farEnd.value = Math.max(600, q.viewDistance);
    RU.nearEnd.value = Math.min(70, Math.max(18, near * 0.45));
    RU.nearBand.value = Math.max(4, near * 0.07);
    RU.midEnd.value = Math.min(260, Math.max(70, near * 1.8));
    RU.midBand.value = Math.max(10, near * 0.3);
    RU.minAngle.value = q.name === 'mobile' ? 0.009 : q.name === 'low' ? 0.007 : q.name === 'medium' ? 0.005 : 0.0035;
    const shadows = q.shadowCascades > 0;
    shadowRange = q.shadowDistance;
    realShadows = shadows && (q.name === 'high' || q.name === 'ultra');
    for (const m of casters) m.castShadow = shadows;
    for (const m of fullDepth) m.castShadow = realShadows;
    cover.setAmount(q.groundCover);
    force = true;
  }

  const sys: ForestSystem = {
    name: 'forest',
    group,
    counts,
    impostorAtlas: atlas ? { albedo: atlas.albedo, aux: atlas.aux } : null,
    update(_f: Frame): void {
      const cam = engine.camera;
      cam.updateMatrixWorld();
      camPos.setFromMatrixPosition(cam.matrixWorld);
      cover.update(camPos.x, camPos.z);
      if (!changed(cam)) return;
      projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView, cam.coordinateSystem, (cam as any).reversedDepth);
      updateTrees();
      updateRocks();
    },
    setQuality(q: Quality): void {
      applyQuality(q);
    },
    resize(): void {
      force = true;
    },
    setLodTint(on: boolean): void {
      FU.lodTint.value = on ? 1 : 0;
    },
    setWindScale(k: number): void {
      FU.wind.value = k;
    },
    dispose(): void {
      engine.scene.remove(group);
      for (const m of [...meshes, rockNearMesh, rockMidMesh, rockFar]) {
        if (m.geometry === undefined) continue;
        (m.material as THREE.Material).dispose();
        (m.geometry as THREE.InstancedBufferGeometry).dispose();
      }
      if (impostors && impostorDepth) {
        (impostors.material as THREE.Material).dispose();
        (impostorDepth.material as THREE.Material).dispose();
        impostors.geometry.dispose();
      }
      atlas?.dispose();
      cover.dispose();
    },
  };
  applyQuality(engine.quality);
  // a first fill so the warm-up compile sees every mesh with instances
  camPos.setFromMatrixPosition(engine.camera.matrixWorld);
  return sys;
}
