// Procedural conifer geometry, built once on the CPU per (kind, level of detail):
//
//   spruce  (TreeInst kind 'pine')  Engelmann-like: whorls of drooping branches with up-turned tips,
//           each carrying a needle spray seen from above and a curtain of hanging branchlets
//   fir     subalpine fir: a narrow spire, denser and shorter flat sprays, no curtains
//   snag    a dead grey trunk with branch stubs; the broken top is made in the vertex shader
//
// One geometry per kind serves all eight variants: every branch carries its attachment height, a
// stable hash and its azimuth, and the vertex shader scales it (or drops it) per variant, so the
// crown base, gaps, fullness and lean differ from variant to variant without more draw calls (see
// treemat.ts). Snow lies on each branch as a slab with real thickness (part SNOW); its crest height
// is stored so the shader can thin it with the tree's snow load.
//
// Units: metres for a scale-1 tree (TREE_H = 14 m), Y up, trunk on the Y axis, base at y = 0.
//
// VERTEX LAYOUT (5 attributes; the two instance attributes make 7 of WebGPU's 8 vertex buffers)
//   position  f32 x3
//   normal    f32 x3   shading normal: foliage blends the card normal with the crown's outward normal
//   uv        f32 x2   foliage: atlas uv; bark: (angle / 2pi, height m); snow: (across, along)
//   aB        f32 x4   attach height (m), branch hash 0..1, part + 0.05 + 0.9 * azimuth01, along 0..1
//   aC        f32 x4   attach height / tree height, baked AO, snow potential, lift (m, snow crest)
import * as THREE from 'three/webgpu';
import { R, regionUV, type Region } from './textures';

export const TREE_H = 14;
export const SNAG_H = 13;

export type GeoKind = 'spruce' | 'fir' | 'snag';
export type GeoLod = 'full' | 'mid';

/** Part ids (aB.z integer part). Keep in sync with treemat.ts. */
export const PART = { BARK: 0, FOLIAGE: 1, SNOW: 2, DEAD: 3 } as const;

type V3 = [number, number, number];

function h01(a: number, b: number, c = 0): number {
  // integer hash -> [0,1)
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mixv = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  aB: number[] = [];
  aC: number[] = [];
  idx: number[] = [];
  vert(p: V3, n: V3, uv: [number, number], b: [number, number, number, number], c: [number, number, number, number]): number {
    this.pos.push(p[0], p[1], p[2]);
    const nn = norm(n);
    this.nor.push(nn[0], nn[1], nn[2]);
    this.uv.push(uv[0], uv[1]);
    this.aB.push(b[0], b[1], b[2], b[3]);
    this.aC.push(c[0], c[1], c[2], c[3]);
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  /** Replace the normals of vertices [v0, v1) by the area-weighted face normals of tris [t0, t1). */
  smoothNormals(v0: number, v1: number, t0: number, t1: number): void {
    const acc = new Float32Array((v1 - v0) * 3);
    for (let t = t0; t < t1; t += 3) {
      const a = this.idx[t], b = this.idx[t + 1], c = this.idx[t + 2];
      const pa: V3 = [this.pos[a * 3], this.pos[a * 3 + 1], this.pos[a * 3 + 2]];
      const pb: V3 = [this.pos[b * 3], this.pos[b * 3 + 1], this.pos[b * 3 + 2]];
      const pc: V3 = [this.pos[c * 3], this.pos[c * 3 + 1], this.pos[c * 3 + 2]];
      const n = cross(sub(pb, pa), sub(pc, pa));
      for (const v of [a, b, c]) {
        if (v < v0 || v >= v1) continue;
        acc[(v - v0) * 3] += n[0];
        acc[(v - v0) * 3 + 1] += n[1];
        acc[(v - v0) * 3 + 2] += n[2];
      }
    }
    for (let v = v0; v < v1; v++) {
      const n = norm([acc[(v - v0) * 3], acc[(v - v0) * 3 + 1], acc[(v - v0) * 3 + 2]]);
      this.nor[v * 3] = n[0];
      this.nor[v * 3 + 1] = n[1];
      this.nor[v * 3 + 2] = n[2];
    }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(this.aB, 4));
    g.setAttribute('aC', new THREE.Float32BufferAttribute(this.aC, 4));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------------------------------
// Species
// ------------------------------------------------------------------------------------------

interface Species {
  seed: number;
  H: number;
  y0: number; // lowest whorl
  step: number; // m between whorls
  crownR: number; // horizontal reach of the lowest branches
  profile: (u: number) => number;
  perWhorl: (u: number) => number;
  pitch: (u: number) => number;
  droop: (u: number) => number;
  upturn: number;
  sprayW: number; // spray card width / branch length
  arch: number; // how far the spray's sides hang below its midrib (fraction of half width)
  curtain: number; // curtain height / branch length (0 = none)
  trunkR: number;
  spray: Region;
  sprayMid: Region;
}

const SPRUCE: Species = {
  seed: 11,
  H: TREE_H,
  y0: 0.55,
  step: 0.56,
  crownR: 2.35,
  // narrow subalpine cone, a little fuller in the lower third
  profile: (u) => Math.pow(1 - u, 0.92) * (1 + 0.12 * Math.sin(Math.PI * Math.min(1, u * 1.6))),
  perWhorl: (u) => (u < 0.55 ? 5 : u < 0.82 ? 4 : 3),
  pitch: (u) => (u > 0.72 ? 0.42 : u > 0.45 ? 0.12 : -0.22 + 0.5 * u),
  droop: (u) => 0.1 + 0.42 * (1 - u) * (1 - u),
  upturn: 0.3,
  sprayW: 0.62,
  arch: 0.32,
  curtain: 0.44,
  trunkR: 0.21,
  spray: R.spruce,
  sprayMid: R.spruceMid,
};

const FIR: Species = {
  seed: 23,
  H: TREE_H,
  y0: 0.45,
  step: 0.5,
  crownR: 1.5,
  // a slender spire with a small skirt where the lowest branches layered in the snow
  profile: (u) => Math.pow(1 - u, 1.0) * (1 + 0.3 * Math.pow(1 - u, 8)),
  perWhorl: (u) => (u < 0.6 ? 5 : u < 0.85 ? 4 : 3),
  pitch: (u) => (u > 0.75 ? 0.3 : 0.06 - 0.1 * (1 - u)),
  droop: (u) => 0.06 + 0.22 * (1 - u),
  upturn: 0.1,
  sprayW: 0.8,
  arch: 0.2,
  curtain: 0,
  trunkR: 0.17,
  spray: R.fir,
  sprayMid: R.firMid,
};

// ------------------------------------------------------------------------------------------
// Pieces
// ------------------------------------------------------------------------------------------

interface Branch {
  ya: number; // attach height
  az: number; // azimuth (radians, from +X toward +Z)
  L: number; // length
  p0: number; // pitch at the base
  droop: number;
  upturn: number;
  u: number; // ya normalised to the crown
  hash: number;
}

/** Point on the branch midrib at s in [0, 1] (tree-local). */
function midrib(b: Branch, s: number): V3 {
  const reach = b.L * s * Math.cos(b.p0) * (1 - 0.12 * b.droop * s);
  const tip = Math.max(0, s - 0.62);
  const y = b.ya + b.L * (s * Math.sin(b.p0) - b.droop * s * s) + b.upturn * b.L * tip * tip * 2.2;
  return [Math.cos(b.az) * reach, y, Math.sin(b.az) * reach];
}

function encodePart(part: number, az: number): number {
  const a = ((az / (Math.PI * 2)) % 1 + 1) % 1;
  return part + 0.05 + 0.9 * a;
}

/** The crown's outward normal at a branch point: out and a little up. */
function crownNormal(b: Branch, up = 0.55): V3 {
  return norm([Math.cos(b.az), up, Math.sin(b.az)]);
}

function addTrunk(g: GeoBuilder, H: number, r0: number, sides: number, rings: number[], flare: number, ao: (y: number) => number): void {
  const base = g.pos.length / 3;
  for (let i = 0; i < rings.length; i++) {
    const y = rings[i];
    const t = Math.min(1, Math.max(0, y / H));
    const r = Math.max(0.008, r0 * Math.pow(1 - t, 0.9) * (1 + flare * Math.exp(-Math.max(0, y) / 0.35)));
    const slope = r0 * 0.9 / H; // outward tilt of the normal from the taper
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      g.vert([c * r, y, s * r], [c, slope, s], [k / sides, y], [y, 0, encodePart(PART.BARK, 0), 0], [t, ao(y), 0, 0]);
    }
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < sides; k++) {
      const a = base + i * (sides + 1) + k, b = a + 1, c = a + sides + 1, d = c + 1;
      g.quad(a, c, d, b);
    }
  }
}

function addSpray(g: GeoBuilder, b: Branch, sp: Species, region: Region, widthK: number, rows: number): void {
  const W = Math.min(1.45, Math.max(0.22, sp.sprayW * b.L * widthK));
  const hw = W / 2;
  const side: V3 = [-Math.sin(b.az), 0, Math.cos(b.az)];
  const cn = crownNormal(b);
  const s0 = 0.03, s1 = 1.04;
  const first = g.pos.length / 3;
  for (let i = 0; i < rows; i++) {
    const s = s0 + (s1 - s0) * (i / (rows - 1));
    const c = midrib(b, Math.min(s, 1.0));
    const cTip = s > 1 ? add(c, mul(norm(sub(midrib(b, 1), midrib(b, 0.95))), (s - 1) * b.L)) : c;
    const tan = norm(sub(midrib(b, Math.min(1, s + 0.02)), midrib(b, Math.max(0, s - 0.02))));
    const upN = norm(cross(tan, side)); // the card's up side
    const fl = upN[1] < 0 ? mul(upN, -1) : upN;
    const ao = (0.32 + 0.68 * Math.pow(Math.min(1, s), 0.7)) * (0.72 + 0.28 * b.u);
    const pot = (0.18 + 0.46 * Math.sqrt(Math.min(1, s))) * (0.72 + 0.28 * b.u);
    const along = Math.min(1, s);
    for (let j = 0; j < 3; j++) {
      const x = (j - 1) * hw;
      const drop = Math.abs(x) * sp.arch;
      const p = add(add(cTip, mul(side, x)), [0, -drop + (j === 1 ? 0.01 * b.L : 0), 0]);
      // shading normal: the arched card's own normal blended into the crown normal
      const tilt = j === 0 ? -0.55 : j === 2 ? 0.55 : 0;
      const cardN = norm(add(fl, mul(side, tilt * Math.sign(fl[1] || 1))));
      const n = norm(mixv(cardN, cn, 0.6));
      const [uu, vv] = regionUV(region, j / 2, (s - s0) / (s1 - s0));
      g.vert(p, n, [uu, vv], [b.ya, b.hash, encodePart(PART.FOLIAGE, b.az), along], [b.u, ao, pot, 0]);
    }
  }
  for (let i = 0; i < rows - 1; i++) {
    const a = first + i * 3;
    g.quad(a, a + 3, a + 4, a + 1);
    g.quad(a + 1, a + 4, a + 5, a + 2);
  }
}

function addCurtain(g: GeoBuilder, b: Branch, sp: Species, region: Region, k: number, cols: number): void {
  const side: V3 = [-Math.sin(b.az), 0, Math.cos(b.az)];
  const out: V3 = [Math.cos(b.az), 0, Math.sin(b.az)];
  const cn = crownNormal(b, 0.25);
  const s0 = 0.24, s1 = 1.0;
  const first = g.pos.length / 3;
  const hK = sp.curtain * k * (0.42 + 0.6 * (1 - b.u));
  for (let i = 0; i < cols; i++) {
    const s = s0 + (s1 - s0) * (i / (cols - 1));
    const c = midrib(b, s);
    const hc = b.L * hK * (0.5 + 0.5 * s);
    const top = add(c, [0, -0.02 * b.L, 0]);
    const bot = add(add(top, [0, -hc, 0]), mul(out, 0.14 * hc));
    const n = norm(mixv(side, cn, 0.8));
    const [u0, v0] = regionUV(region, (s - s0) / (s1 - s0), 0);
    const [u1, v1] = regionUV(region, (s - s0) / (s1 - s0), 1);
    g.vert(top, n, [u0, v0], [b.ya, b.hash, encodePart(PART.FOLIAGE, b.az), s], [b.u, 0.5 + 0.3 * s, 0.1, 0]);
    g.vert(bot, n, [u1, v1], [b.ya, b.hash, encodePart(PART.FOLIAGE, b.az), s], [b.u, 0.36 + 0.3 * s, 0.04, 0]);
  }
  for (let i = 0; i < cols - 1; i++) {
    const a = first + i * 2;
    g.quad(a, a + 1, a + 3, a + 2);
  }
}

/** Snow lying on the spray: a dome-shaped slab whose crest height is stored as `lift`. */
function addSlab(g: GeoBuilder, b: Branch, sp: Species, widthK: number, rings: number, across: 3 | 5, rnd: (i: number) => number): void {
  const W = Math.min(1.45, Math.max(0.22, sp.sprayW * b.L * widthK));
  const side: V3 = [-Math.sin(b.az), 0, Math.cos(b.az)];
  // a heavy load is 15-35 cm on a long branch; some branches shed part of theirs
  const Tmax = Math.min(0.34, 0.06 + 0.13 * b.L) * (0.75 + 0.5 * rnd(0));
  const shed = 0.78 + 0.22 * rnd(30);
  const first = g.pos.length / 3;
  const t0 = g.idx.length;
  const s0 = 0.02, s1 = 0.84;
  const five = across === 5;
  const exposure = (0.86 + 0.14 * b.u) * shed;
  for (let i = 0; i < rings; i++) {
    const s = s0 + (s1 - s0) * (i / (rings - 1));
    const c = midrib(b, s);
    // a pillow: widest a third of the way out, lumpy along its length, crest off-centre
    const bulge = Math.sin(Math.PI * Math.min(1, (s + 0.12) / 1.0));
    const ws = W * 0.34 * (0.5 + 0.5 * bulge) * (0.78 + 0.44 * rnd(i + 1));
    const T = Tmax * (0.55 + 0.45 * bulge) * (0.72 + 0.56 * rnd(i + 7));
    const off = (rnd(i + 13) - 0.5) * 0.3 * ws;
    const prof = five ? [-1.08, -0.62, 0, 0.62, 1.08] : [-1.05, 0, 1.05];
    const liftK = five ? [-0.18, 0.8, 1, 0.8, -0.18] : [-0.15, 1, -0.15];
    const potK = five ? [0.7, 0.93, 1, 0.93, 0.7] : [0.7, 1, 0.7];
    for (let j = 0; j < prof.length; j++) {
      const x = prof[j] * ws + (j > 0 && j < prof.length - 1 ? off : 0);
      // the edges curl down over the needles; the spray under the slab is V-shaped
      const sprayY = -Math.abs(x) * sp.arch + 0.012;
      const lift = T * liftK[j];
      const p = add(add(c, mul(side, x)), [0, sprayY + lift, 0]);
      const [uu, vv] = [j / (prof.length - 1), (s - s0) / (s1 - s0)];
      g.vert(p, [0, 1, 0], [uu, vv], [b.ya, b.hash, encodePart(PART.SNOW, b.az), s], [b.u, 0.92, potK[j] * exposure, Math.max(0, lift)]);
    }
  }
  // rounded tip
  const tipS = 0.92;
  const tip = add(midrib(b, tipS), [0, 0.012, 0]);
  const tipI = g.vert(tip, [0, 1, 0], [0.5, 1], [b.ya, b.hash, encodePart(PART.SNOW, b.az), tipS], [b.u, 0.92, 0.66 * exposure, 0]);
  const n = five ? 5 : 3;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = first + i * n + j;
      g.quad(a, a + 1, a + n + 1, a + n);
    }
  }
  const last = first + (rings - 1) * n;
  for (let j = 0; j < n - 1; j++) g.tri(last + j, last + j + 1, tipI);
  g.smoothNormals(first, tipI + 1, t0, g.idx.length);
}

function addDeadTwig(g: GeoBuilder, b: Branch): void {
  const side: V3 = [-Math.sin(b.az), 0, Math.cos(b.az)];
  const out: V3 = [Math.cos(b.az), 0, Math.sin(b.az)];
  const L = b.L * 0.55;
  const W = Math.max(0.2, L * 0.75);
  const pitch = b.p0 - 0.35;
  const dir: V3 = norm([out[0] * Math.cos(pitch), Math.sin(pitch), out[2] * Math.cos(pitch)]);
  const o: V3 = [0, b.ya, 0];
  const tipP = add(o, mul(dir, L));
  const n = norm([out[0] * 0.5, 1, out[2] * 0.5]);
  const roll: V3 = add(mul(side, 1), [0, 0.35, 0]);
  const at = (u: number, v: number): V3 => add(add(o, mul(sub(tipP, o), v)), mul(roll, (u - 0.5) * W * (0.3 + 0.7 * v)));
  const corner = (u: number, v: number): number => {
    const [uu, vv] = regionUV(R.dead, u, v);
    // little snow: it falls through sparse dead twigs
    return g.vert(at(u, v), n, [uu, vv], [b.ya, b.hash, encodePart(PART.DEAD, b.az), v], [b.u, 0.45, 0.1, 0]);
  };
  const a = corner(0, 0), bb = corner(1, 0), c = corner(1, 1), d = corner(0, 1);
  g.quad(a, bb, c, d);
}

// ------------------------------------------------------------------------------------------
// Conifers
// ------------------------------------------------------------------------------------------

function buildConifer(sp: Species, lod: GeoLod): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const full = lod === 'full';
  // trunk
  const ringsFull = [-1.2, -0.3, 0.4, 1.4, 3.0, 5.0, 7.4, 9.8, 12.0, 13.4, sp.H];
  const ringsMid = [-1.2, 0.5, 4.0, 9.0, sp.H];
  addTrunk(g, sp.H, sp.trunkR, full ? 8 : 5, full ? ringsFull : ringsMid, 0.55, (y) => (y < 1.5 ? 0.7 : 0.5));

  // whorls (the mid level keeps every other whorl, same branches, so hashes and variants agree)
  let w = 0;
  for (let y = sp.y0; y < sp.H - 0.22; y += sp.step, w++) {
    // the simplified spruce keeps every other whorl (its curtains fill the side view); the fir, a
    // narrow spire whose tiers are its silhouette, keeps them all with simpler branches
    if (!full && sp.curtain > 0 && w % 2 === 1) continue;
    const u = (y - sp.y0) / (sp.H - sp.y0);
    const n = sp.perWhorl(u);
    const phase = w * 2.39996 + h01(sp.seed, w, 99) * 0.6;
    for (let k = 0; k < n; k++) {
      const az = phase + (k / n) * Math.PI * 2 + (h01(sp.seed, w, k) - 0.5) * 0.5;
      const jitter = 0.88 + 0.24 * h01(sp.seed + 1, w, k);
      const L = Math.max(0.16, sp.crownR * sp.profile(u) * jitter);
      const b: Branch = {
        ya: y + (h01(sp.seed + 2, w, k) - 0.5) * sp.step * 0.3,
        az,
        L,
        p0: sp.pitch(u) + (h01(sp.seed + 3, w, k) - 0.5) * 0.18,
        droop: sp.droop(u) * (0.85 + 0.3 * h01(sp.seed + 4, w, k)),
        upturn: u < 0.65 ? sp.upturn : sp.upturn * 0.3,
        u,
        hash: h01(sp.seed + 5, w, k),
      };
      const rnd = (i: number): number => h01(sp.seed + 6 + i, w, k);
      const wk = full ? 1 : sp.curtain > 0 ? 1.42 : 1.15;
      // the simplified sprays hang deeper at the sides so they still show edge-on from afar
      addSpray(g, b, full ? sp : { ...sp, arch: sp.arch * 2.2 }, full ? sp.spray : sp.sprayMid, wk, full ? 3 : 2);
      if (sp.curtain > 0 && b.L > 0.55 && u < (full ? 0.86 : 0.7)) addCurtain(g, b, sp, full ? R.curtain : R.curtainMid, full ? 1 : 1.3, 2);
      if (sp.curtain === 0 && full && b.L > 0.6 && u < 0.6 && k % 2 === 0) {
        // fir: a second, steeper spray rolled about the branch fills the side view
        const b2: Branch = { ...b, az: b.az + 0.12, p0: b.p0 - 0.32, L: b.L * 0.82, hash: b.hash };
        addSpray(g, b2, { ...sp, arch: full ? -0.45 : 0.6 }, full ? sp.spray : sp.sprayMid, full ? 0.7 : 1.1, full ? 3 : 2);
      }
      addSlab(g, b, sp, full ? 1 : 1.3, full ? 3 : 2, full && sp === SPRUCE ? 5 : 3, rnd);
      if (u < 0.55) addDeadTwig(g, b);
    }
  }
  return g.build();
}

// ------------------------------------------------------------------------------------------
// Snag
// ------------------------------------------------------------------------------------------

function buildSnag(lod: GeoLod): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const H = SNAG_H;
  const full = lod === 'full';
  const rings: number[] = [-1.2, -0.3, 0.4, 1.3, 2.5, 3.8, 5.0];
  for (let y = 5.8; y < H - 0.1; y += full ? 0.55 : 1.1) rings.push(y);
  rings.push(H);
  addTrunk(g, H, 0.2, full ? 8 : 6, rings, 0.45, (y) => (y < 1.2 ? 0.75 : 0.62));
  // branch stubs: dead, drooping, thin; more and longer in the upper half (the lower ones broke off)
  let w = 0;
  // irregular: whorls 0.5-1.3 m apart, many gone, one to three stubs, the low ones short
  for (let y = 1.6; y < H - 0.5; y += (full ? 0.5 : 0.8) + 0.8 * h01(4, w, 1), w++) {
    const u = y / H;
    if (h01(4, w, 2) < 0.3 + 0.35 * (1 - u)) continue;
    const n = 1 + Math.floor(h01(5, w, 7) * (u > 0.4 ? 3 : 2));
    for (let k = 0; k < n; k++) {
      const az = w * 2.39996 + (k / n) * Math.PI * 2 + (h01(5, w, k) - 0.5) * 0.7;
      const long = h01(6, w, k + 9) < 0.18 ? 2.2 : 1; // now and then a long dead branch survives
      const L = (0.1 + 0.55 * h01(6, w, k) * h01(6, w, k + 3)) * (0.35 + 1.0 * u) * (1 - 0.5 * u * u) * long;
      const r = 0.018 + 0.03 * h01(7, w, k) * (1 - u * 0.5);
      const pitch = -0.25 - 0.5 * h01(8, w, k);
      const hash = h01(9, w, k);
      const dir: V3 = norm([Math.cos(az) * Math.cos(pitch), Math.sin(pitch), Math.sin(az) * Math.cos(pitch)]);
      const o: V3 = [0, y, 0];
      const tip = add(o, mul(dir, L));
      // a 4-sided tapered stub
      const up: V3 = [0, 1, 0];
      const s1 = norm(cross(dir, up)), s2 = norm(cross(s1, dir));
      const first = g.pos.length / 3;
      for (let e = 0; e < 2; e++) {
        const c = e === 0 ? o : tip;
        const rr = e === 0 ? r : r * 0.35;
        for (let q = 0; q < 4; q++) {
          const a = (q / 4) * Math.PI * 2 + 0.785;
          const off = add(mul(s1, Math.cos(a) * rr), mul(s2, Math.sin(a) * rr));
          g.vert(add(c, off), norm(off), [q / 4, e * L], [y, hash, encodePart(PART.BARK, az), e], [u, 0.6, 0.6, 0]);
        }
      }
      for (let q = 0; q < 4; q++) {
        const a = first + q, b = first + ((q + 1) % 4);
        g.quad(a, a + 4, b + 4, b);
      }
      const capI = g.vert(add(tip, mul(dir, r * 0.5)), dir, [0.5, L], [y, hash, encodePart(PART.BARK, az), 1], [u, 0.6, 0.6, 0]);
      for (let q = 0; q < 4; q++) g.tri(first + 4 + ((q + 1) % 4), first + 4 + q, capI);
      // a few bare twigs on the longer upper stubs
      if (full && L > 0.5 && u > 0.35 && k % 2 === 0) {
        const b: Branch = { ya: y, az, L: L * 1.6, p0: pitch + 0.2, droop: 0.1, upturn: 0, u, hash };
        addDeadTwig(g, b);
      }
    }
  }
  return g.build();
}

// ------------------------------------------------------------------------------------------
// Shadow proxy: the crown as a stack of open cones (lampshades), a little inside the real crown
// so the outer needles on the sun side stay lit, plus the lower trunk.
// ------------------------------------------------------------------------------------------

function buildProxy(sp: Species): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const sides = 8;
  // trunk up to where the crown hides it
  addTrunk(g, sp.H, sp.trunkR, 5, [-1.0, 3.0, sp.H * 0.8], 0.3, () => 0.5);
  const tiers = sp === FIR ? 7 : 6;
  const span = sp.H - sp.y0;
  for (let t = 0; t < tiers; t++) {
    const yb = sp.y0 + (t / tiers) * span;
    // tiers overlap: under a low sun the gaps between them would project as long regular dashes
    const yt = Math.min(sp.H, yb + (span / tiers) * 2.1);
    const u = (yb - sp.y0) / span;
    // the branches droop: the envelope at a tier's foot reaches the radius of the whorls above it
    const rb = sp.crownR * sp.profile(Math.min(1, u + 0.04)) * 0.8;
    const rt = sp.crownR * sp.profile((yt - sp.y0) / span) * 0.22;
    const first = g.pos.length / 3;
    for (let e = 0; e < 2; e++) {
      const y = e === 0 ? yb - 0.3 * (span / tiers) : yt;
      const r = e === 0 ? rb : rt;
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * Math.PI * 2 + t * 0.7;
        const c = Math.cos(a), s = Math.sin(a);
        g.vert([c * r, y, s * r], [c, 0.5, s], [k / sides, e], [yb, 0.5, encodePart(PART.FOLIAGE, a), e], [u, 1, 0, 0]);
      }
    }
    // outward-facing; a quarter of the panels left out lets light through the crown
    for (let k = 0; k < sides; k++) {
      if (h01(sp.seed + 40, t, k) < 0.25) continue;
      const a = first + k;
      g.quad(a, a + sides + 1, a + sides + 2, a + 1);
    }
  }
  return g.build();
}

const cache = new Map<string, THREE.BufferGeometry>();

/** Shadow proxy geometry of a conifer kind (cached). */
export function proxyGeometry(kind: 'spruce' | 'fir'): THREE.BufferGeometry {
  const key = kind + ':proxy';
  let g = cache.get(key);
  if (!g) {
    g = buildProxy(kind === 'spruce' ? SPRUCE : FIR);
    cache.set(key, g);
  }
  return g;
}

/** The shared geometry of a kind and level of detail (built on first use, then cached). */
export function treeGeometry(kind: GeoKind, lod: GeoLod): THREE.BufferGeometry {
  const key = kind + ':' + lod;
  let g = cache.get(key);
  if (!g) {
    g = kind === 'snag' ? buildSnag(lod) : buildConifer(kind === 'spruce' ? SPRUCE : FIR, lod);
    cache.set(key, g);
  }
  return g;
}

/** Bounding box of the impostor frames per kind (scale 1): half width, bottom and top. */
export const FRAME_BOX: Record<GeoKind, { hw: number; y0: number; y1: number }> = {
  spruce: { hw: 2.9, y0: -0.6, y1: TREE_H + 0.5 },
  fir: { hw: 2.05, y0: -0.6, y1: TREE_H + 0.5 },
  snag: { hw: 1.45, y0: -0.6, y1: SNAG_H + 0.5 },
};

export function disposeTreeGeometries(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
