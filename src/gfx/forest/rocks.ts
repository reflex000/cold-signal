// Rocks: boulders, talus blocks, bedded slabs and outcrop chunks from world.rocks, near black, with
// chipped facets, strata and snow lying on their tops.
//
// EIGHT VARIANTS, ONE DRAW. All variants share one icosphere topology built by appending vertices
// at each subdivision, so the vertices of a coarser level are a prefix of the finer one. Each
// variant's displaced positions (and normals, AO) live in a half-float DataTexture row; the vertex
// shader fetches them with textureLoad(vertexIndex, variant). The levels of detail are just index
// buffers over the same rows: near (1280 tris), mid (320), far (20); ground-cover stones use 80.
//
// Per instance: rA = (x, y, z, rnd), rB = (yaw, tilt, variant, -), rC = (sx, sy, sz, -), where y is
// already sunk into the ground and sx/sy/sz are the half extents of the unit rock.
import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, attribute, cameraWorldMatrix, cos, cross, dFdx, dFdy, dot, float, floor, fract, int, ivec2, length, max, mix, normalLocal,
  normalViewGeometry, normalize, positionView, positionWorld, property, select, sin, smoothstep, step, textureLoad, uniform, varyingProperty,
  vec2, vec3, vec4, vertexIndex,
} from 'three/tsl';
import { U } from '../shared';
import { ForestMaterial, ditherNoise, hash11, noiseAt, snowShade, type N } from './common';

// ------------------------------------------------------------------------------------------
// Nested icosphere
// ------------------------------------------------------------------------------------------

interface Ico { pos: number[]; levels: number[][] }

function icosphere(levels: number): Ico {
  const t = (1 + Math.sqrt(5)) / 2;
  const pos: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    const l = Math.hypot(x, y, z);
    pos.push(x / l, y / l, z / l);
    return pos.length / 3 - 1;
  };
  for (const [x, y, z] of [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]) push(x, y, z);
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const out: number[][] = [faces];
  for (let l = 0; l < levels; l++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number): number => {
      const key = a < b ? a + ':' + b : b + ':' + a;
      let i = mid.get(key);
      if (i === undefined) {
        i = push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
        mid.set(key, i);
      }
      return i;
    };
    const nf: number[] = [];
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i], b = faces[i + 1], c = faces[i + 2];
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      nf.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = nf;
    out.push(faces);
  }
  return { pos, levels: out };
}

// ------------------------------------------------------------------------------------------
// Variants (CPU)
// ------------------------------------------------------------------------------------------

function vnoise(seed: number, x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const s = (t: number): number => t * t * (3 - 2 * t);
  const h = (i: number, j: number, k: number): number => {
    let n = (i * 374761393 + j * 668265263 + k * 1440670441 + seed * 2246822519) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const u = s(xf), v = s(yf), w = s(zf);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
function fbm(seed: number, x: number, y: number, z: number, oct = 4): number {
  let a = 0.5, s = 0, f = 1;
  for (let o = 0; o < oct; o++) {
    s += a * (vnoise(seed + o * 31, x * f, y * f, z * f) - 0.5);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

const ROCK_N = 642; // vertices at level 3
export const ROCK_VARIANTS = 8;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Displaced positions (xyz) and AO (w) of one variant, unit size (about -1..1). */
function variantPositions(ico: Ico, v: number): Float32Array {
  const r = rng(9001 + v * 7919);
  const out = new Float32Array(ROCK_N * 4);
  const type = v >> 1; // 0 boulder, 1 angular block, 2 bedded slab, 3 outcrop chunk
  // planes that chip the block: normal, offset
  const cuts: number[][] = [];
  const nCuts = type === 0 ? 3 : type === 1 ? 9 : type === 2 ? 6 : 7;
  for (let i = 0; i < nCuts; i++) {
    const th = r() * Math.PI * 2, ph = Math.acos(r() * 1.6 - 0.75);
    const n = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
    cuts.push([n[0], n[1], n[2], (type === 0 ? 0.82 : 0.62) + r() * 0.25]);
  }
  const strataK = type === 2 ? 5.5 : type === 3 ? 4 : 0;
  const stretch = type === 3 ? [1.25, 0.9, 0.85] : type === 2 ? [1.1, 0.75, 1.0] : [1, 0.92, 1];
  for (let i = 0; i < ROCK_N; i++) {
    let x = ico.pos[i * 3], y = ico.pos[i * 3 + 1], z = ico.pos[i * 3 + 2];
    // low-frequency lumps, then a rougher surface
    const lump = fbm(v * 13 + 1, x * 1.3 + 4, y * 1.3, z * 1.3, 3) * (type === 0 ? 0.45 : 0.3);
    const rough = fbm(v * 13 + 5, x * 4.2, y * 4.2, z * 4.2, 3) * 0.1;
    let rad = 1 + lump + rough;
    x *= rad * stretch[0];
    y *= rad * stretch[1];
    z *= rad * stretch[2];
    // chips: points beyond a cutting plane are pushed back onto it (flat facets with edges)
    for (const c of cuts) {
      const d = x * c[0] + y * c[1] + z * c[2] - c[3];
      if (d > 0) {
        const k = d * 0.92;
        x -= c[0] * k;
        y -= c[1] * k;
        z -= c[2] * k;
      }
    }
    // strata: gentle steps across the bedding (rock splits along it)
    if (strataK > 0) {
      const bed = y * strataK + fbm(v * 13 + 9, x * 0.8, 0, z * 0.8, 2) * 1.5;
      const fl = Math.floor(bed);
      const f = bed - fl;
      const step = fl + Math.pow(f, 3.5) * 0.85 + f * 0.15;
      const ny = step / strataK - fbm(v * 13 + 9, x * 0.8, 0, z * 0.8, 2) * 1.5 / strataK;
      const inset = 1 - 0.06 * Math.sin(f * Math.PI);
      x *= inset;
      z *= inset;
      y = y * 0.4 + ny * 0.6;
    }
    // sit flat: the buried underside is squashed
    if (y < -0.35) y = -0.35 + (y + 0.35) * 0.35;
    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
  }
  return out;
}

function computeNormalsAO(ico: Ico, p: Float32Array): Float32Array {
  const faces = ico.levels[3];
  const n = new Float32Array(ROCK_N * 4);
  const nb = new Float32Array(ROCK_N * 4); // neighbour sum (xyz) and count
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    const ax = p[a * 4], ay = p[a * 4 + 1], az = p[a * 4 + 2];
    const e1x = p[b * 4] - ax, e1y = p[b * 4 + 1] - ay, e1z = p[b * 4 + 2] - az;
    const e2x = p[c * 4] - ax, e2y = p[c * 4 + 1] - ay, e2z = p[c * 4 + 2] - az;
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      n[v * 4] += fx;
      n[v * 4 + 1] += fy;
      n[v * 4 + 2] += fz;
    }
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      nb[u * 4] += p[w * 4];
      nb[u * 4 + 1] += p[w * 4 + 1];
      nb[u * 4 + 2] += p[w * 4 + 2];
      nb[u * 4 + 3] += 1;
    }
  }
  for (let i = 0; i < ROCK_N; i++) {
    const l = Math.hypot(n[i * 4], n[i * 4 + 1], n[i * 4 + 2]) || 1;
    n[i * 4] /= l;
    n[i * 4 + 1] /= l;
    n[i * 4 + 2] /= l;
    // concavity: how far the vertex sits inside the average of its neighbours, along the normal
    const c = nb[i * 4 + 3] || 1;
    const dx = p[i * 4] - nb[i * 4] / c, dy = p[i * 4 + 1] - nb[i * 4 + 1] / c, dz = p[i * 4 + 2] - nb[i * 4 + 2] / c;
    const conv = (dx * n[i * 4] + dy * n[i * 4 + 1] + dz * n[i * 4 + 2]) * 12;
    const low = Math.min(1, Math.max(0, (p[i * 4 + 1] + 0.4) / 0.9));
    p[i * 4 + 3] = Math.min(1, Math.max(0.25, 0.72 + conv * 0.5)) * (0.55 + 0.45 * low);
    n[i * 4 + 3] = 0;
  }
  return n;
}

type RockGeo = Record<'near' | 'mid' | 'far' | 'tiny', THREE.BufferGeometry>;
let rockData: { tex: THREE.DataTexture; geo: RockGeo } | null = null;

/** The variant texture and the index buffers of the four levels (1280, 320, 80, 20 triangles). */
export function rockAssets(): { tex: THREE.DataTexture; geo: RockGeo } {
  if (rockData) return rockData;
  const ico = icosphere(3);
  const W = ROCK_N, Hh = ROCK_VARIANTS * 2;
  const half = new Uint16Array(W * Hh * 4);
  for (let v = 0; v < ROCK_VARIANTS; v++) {
    const p = variantPositions(ico, v);
    const n = computeNormalsAO(ico, p);
    for (let i = 0; i < W * 4; i++) {
      half[(v * 2) * W * 4 + i] = THREE.DataUtils.toHalfFloat(p[i]);
      half[(v * 2 + 1) * W * 4 + i] = THREE.DataUtils.toHalfFloat(n[i]);
    }
  }
  const tex = new THREE.DataTexture(half, W, Hh, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  const mk = (level: number): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    // the vertex shader reads positions from the texture; this attribute only sizes the draw
    g.setAttribute('position', new THREE.Float32BufferAttribute(ico.pos.slice(0, ROCK_N * 3), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(ico.pos.slice(0, ROCK_N * 3), 3));
    g.setIndex(new THREE.Uint16BufferAttribute(ico.levels[level], 1));
    return g;
  };
  rockData = { tex, geo: { near: mk(3), mid: mk(2), far: mk(1), tiny: mk(0) } };
  return rockData;
}

// ------------------------------------------------------------------------------------------
// Material
// ------------------------------------------------------------------------------------------

export const RU = {
  nearEnd: uniform(40),
  nearBand: uniform(6),
  midEnd: uniform(150),
  midBand: uniform(25),
  minAngle: uniform(0.005), // rocks smaller than this (radians) fade out
  snowDepth: uniform(0.12), // m of snow on top of a big rock
  coverEnd: uniform(22), // m: ground-cover stones fade out toward this distance
};

export type RockLod = 'near' | 'mid' | 'far' | 'pebble';

/** World-space position, normal and LOD range of a rock vertex (shared by main and shadow passes). */
function rockVertex(lod: RockLod, shadow: boolean): { pos: N; nrm: N; lo: N; hi: N; ao: N; local: N; size: N } {
  const { tex } = rockAssets();
  const rA: N = attribute('rA', 'vec4');
  const rB: N = attribute('rB', 'vec4');
  const rC: N = attribute('rC', 'vec4');
  const vi: N = int(vertexIndex);
  const variant: N = int(rB.z.add(0.5));
  const P: N = textureLoad(tex, ivec2(vi, variant.mul(2)));
  const Nn: N = textureLoad(tex, ivec2(vi, variant.mul(2).add(1)));
  const s: N = rC.xyz.max(0.0001); // an empty ground-cover slot has size 0: keep the normal finite
  const local: N = P.xyz.mul(s);
  // tilt about local X, then yaw about Y
  const ct: N = cos(rB.y), st: N = sin(rB.y);
  const tilt = (v: N): N => vec3(v.x, v.y.mul(ct).sub(v.z.mul(st)), v.y.mul(st).add(v.z.mul(ct)));
  const cy: N = cos(rB.x), sy: N = sin(rB.x);
  const yaw = (v: N): N => vec3(v.x.mul(cy).add(v.z.mul(sy)), v.y, v.z.mul(cy).sub(v.x.mul(sy)));
  const nW: N = normalize(yaw(tilt(Nn.xyz.div(s))));
  let pos: N = rA.xyz.add(yaw(tilt(local)));
  // a cap of snow: up-facing vertices rise a little, more on big rocks (it looks like a soft layer)
  const size: N = max(max(rC.x, rC.y), rC.z);
  const capK: N = smoothstep(0.35, 0.85, nW.y).mul(U.snowCover).mul(RU.snowDepth).mul(size.mul(0.5).add(0.3).min(1.2)).mul(step(0.001, size)).mul(size.min(1));
  pos = pos.add(vec3(0, capK, 0));
  const d: N = length(vec3(U.camPos).sub(rA.xyz));
  const tN: N = smoothstep(RU.nearEnd.sub(RU.nearBand.mul(0.5)), RU.nearEnd.add(RU.nearBand.mul(0.5)), d);
  const tM: N = smoothstep(RU.midEnd.sub(RU.midBand), RU.midEnd, d);
  // small rocks far away: gone (by their angular size, dithered)
  const ang: N = size.mul(2).div(d.max(1));
  const tS: N = smoothstep(RU.minAngle, RU.minAngle.mul(1.6), ang).oneMinus();
  let lo: N, hi: N;
  if (lod === 'near') {
    lo = max(tN, tS);
    hi = float(1.01);
  } else if (lod === 'mid') {
    lo = max(tM, tS);
    hi = tN;
  } else if (lod === 'far') {
    lo = tS;
    hi = tM;
  } else {
    lo = smoothstep(RU.coverEnd.sub(5), RU.coverEnd, d);
    hi = float(1.01).mul(step(0.001, size));
  }
  if (shadow && lod === 'mid') lo = max(lo, step(size, 0.9)); // only big rocks cast from the mid level
  return { pos, nrm: nW, lo, hi, ao: P.w, local: P.xyz, size };
}

export function createRockMaterial(lod: RockLod): THREE.MeshStandardNodeMaterial {
  const m = new ForestMaterial();
  m.name = 'forest-rock-' + lod;
  m.side = THREE.FrontSide;
  m.metalness = 0;
  m.alphaTest = 0.5;
  const vFade: N = varyingProperty('vec2', 'rFade');
  const vAO: N = varyingProperty('vec4', 'rMisc'); // ao, rnd, size, -
  const vLocal: N = varyingProperty('vec3', 'rLocal');

  const build = (shadow: boolean): N => Fn(() => {
    const r = rockVertex(lod, shadow);
    normalLocal.assign(r.nrm);
    vFade.assign(vec2(r.lo, r.hi));
    vAO.assign(vec4(r.ao, attribute('rA', 'vec4').w, r.size, 0));
    vLocal.assign(r.local);
    const gone: N = step(r.hi.sub(0.0005), r.lo);
    return mix(r.pos, attribute('rA', 'vec4').xyz, gone);
  })();
  m.positionNode = build(false);
  m.castShadowPositionNode = build(true);

  const pRough: N = property('float', 'csRRough');
  const pEmis: N = property('vec3', 'csREmis');
  const pAO: N = property('float', 'csRAO');
  const pN: N = property('vec3', 'csRN');

  m.colorNode = Fn(() => {
    const wp: N = positionWorld;
    const lp: N = vLocal;
    // facets: blend the smooth normal toward the true triangle plane, so chips read as edges
    const nf0: N = normalize(cross(dFdx(positionView), dFdy(positionView)).add(vec3(1e-9, 2e-9, 3e-9)));
    const nGeo: N = normalize(normalViewGeometry);
    const nf: N = nf0.mul(select(dot(nf0, nGeo).lessThan(0), float(-1), float(1)));
    const nV: N = normalize((mix as any)(nGeo, nf, 0.55));
    const nW: N = nV.transformDirection(cameraWorldMatrix);
    const n1: N = noiseAt(vec2(wp.x.add(wp.y.mul(0.6)), wp.z.sub(wp.y.mul(0.4))).mul(0.21));
    const n2: N = noiseAt(vec2(wp.x.sub(wp.y.mul(0.5)), wp.z.add(wp.y.mul(0.7))).mul(1.9).add(0.33));
    const n3: N = noiseAt(vec2(wp.x.add(wp.z.mul(0.3)), wp.y.add(wp.z.mul(0.5))).mul(7.3).add(0.71));
    const rnd: N = vAO.y;
    // near-black granite and basalt: tone drifting over the stone, mineral speckle
    const tone: N = hash11(rnd.mul(37.3).add(0.5));
    const base: N = mix(vec3(0.036, 0.036, 0.038), vec3(0.062, 0.058, 0.054), tone);
    const col: N = base.mul(n1.x.mul(0.55).add(0.72)).mul(n3.y.mul(0.35).add(0.83)).toVar();
    // strata: paler and darker bands through the stone along its bedding
    const band: N = sin(lp.y.mul(19).add(n1.y.mul(4)).add(rnd.mul(40))).mul(0.5).add(0.5);
    col.mulAssign(band.mul(0.22).add(0.89));
    // pale crustose lichen on the faces that see the sky but not the snow
    const lich: N = smoothstep(0.66, 0.74, n2.z.mul(0.7).add(n3.x.mul(0.3))).mul(smoothstep(0.1, 0.5, nW.y).mul(smoothstep(0.85, 0.55, nW.y)));
    col.assign(mix(col, vec3(0.11, 0.115, 0.1).mul(n3.z.mul(0.4).add(0.8)), lich.mul(0.7)));
    const ao: N = vAO.x;
    // snow on the tops (thicker cover on flatter facets), wet dark rim below it
    const th: N = mix(1.02, 0.42, U.snowCover).sub(n2.x.sub(0.5).mul(0.35)).sub(n1.z.sub(0.5).mul(0.2));
    const snow: N = smoothstep(th.sub(0.05), th.add(0.05), nW.y);
    const wet: N = smoothstep(th.sub(0.25), th.sub(0.04), nW.y).mul(snow.oneMinus());
    col.mulAssign(mix(1, 0.6, wet));
    const sh = snowShade(nW);
    const outCol: N = mix(col.mul(mix(1, ao, 0.5)), sh.color, snow);
    pRough.assign(mix(mix(0.82, 0.55, wet), 0.86, snow));
    pEmis.assign(sh.emissive.mul(snow));
    pAO.assign(mix(ao, 1, snow.mul(0.5)));
    pN.assign(normalize((mix as any)(nV, nGeo, snow.mul(0.7))));
    const n: N = ditherNoise();
    const keep: N = step(vFade.x, n).mul(step(n, vFade.y.sub(0.00001)));
    return vec4(outCol, keep);
  })();
  m.roughnessNode = pRough;
  m.emissiveNode = pEmis;
  m.aoNode = pAO;
  m.normalNode = pN;
  return m;
}
