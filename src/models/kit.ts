// THE MODEL KIT. Every static thing in the game is built in code with this Builder and drawn with
// the one prop material in ./material.ts. Read this header, then ./props/crate.ts and
// ./props/barrel.ts as the style reference.
//
// A model is a function (seed, opts) => ModelDef registered in ./registry.ts:
//
//   register('crate', (seed) => {
//     const b = new Builder(seed);
//     b.ink({ color: PAL.timber, mat: MAT.WOOD, wear: 0.5 });
//     b.plank(0.6, 0.09, 0.018).rotZ(Math.PI / 2).move(0, 0.05, 0.2);   // made along +Y, then placed
//     b.anchor('top', [0, 0.4, 0]);
//     return b.build();
//   }, { variants: 4, size: 'prop' });
//
// CONVENTIONS
// - Metres, radians, Y up. A model stands on y = 0, centred on the origin, +Z is its front.
// - Long primitives (plank, cyl, tube, capsule, cone) are made along +Y and centred on the origin.
//   Wood grain, brushed-metal streaks and fur run along the part's own Y, so make it, then turn it.
// - A primitive is painted with the current ink() the moment it is made. Painting captures the
//   DETAIL COORDINATES (the vertex position in the part's own space, plus a random per-part
//   offset) which the material uses for grain, scratches, chips and weave. They stay glued to the
//   part through every later transform or deformation. part.paint({...}) afterwards changes only
//   the fields given.
// - Colours are linear RGB triples. Use PAL or hex(0xRRGGBB).
// - Every primitive bevels its hard edges (opts.bevel, metres). Bevel strips carry edge = 1, flat
//   faces edge = 0; final wear = wear * (0.4 + edge), so paint chips, bare metal and bleached
//   wood appear on edges first. Never ship a razor-edged box: bevel 2 to 8 mm on hand-sized
//   things, 1 to 3 cm on timber and structures.
// - build() bakes per-vertex ambient occlusion (contact darkening between parts and against the
//   ground), sky exposure for snow (a part under another part gets less snow), and a snow push
//   weight (welded, so caps of snow lift without opening cracks).
// - Same seed, same model. Draw all randomness from b.rng.
//
// VERTEX LAYOUT of the geometries build() returns (read by material.ts):
//   position  f32 x3
//   normal    f32 x3
//   color     u8n x4   rgb = sqrt(linear albedo), a = baked ambient occlusion
//   aDetail   f32 x4   xyz = detail coordinates (m), w = material id (MAT)
//   aSurf     u8n x4   roughness, metalness, wear, emissive (strength = (v * 8)^2, 0..64)
//   aEnv      u8n x4   snow exposure, sway length (v * 2.55 m), snow push, sway stiffness
// Six attributes on purpose: with the instance matrix that is 7 vertex buffers, under the WebGPU
// limit of 8. Do not add a seventh.
import * as THREE from 'three/webgpu';
import { Rng, hash32 } from '../core/rng';

// ------------------------------------------------------------------------------------------
// Materials and palette
// ------------------------------------------------------------------------------------------

export const MAT = {
  SNOW: 0,
  ROCK: 1,
  BARK: 2,
  WOOD: 3,
  /** Bare metal. wear up to 0.5: scratches and dull oxide. Above 0.5: rust blooms (steel). */
  METAL: 4,
  /** Painted metal: chips to primer, then bare metal and rust, by wear. */
  PAINT: 5,
  CLOTH: 6,
  PLASTIC: 7,
  /** Goes to the separate transparent geometry (ModelDef.glass). */
  GLASS: 8,
  ICE: 9,
  RUBBER: 10,
  FUR: 11,
  /** Glows: colour * emissive. Lamps, lit windows, instrument lights. */
  EMISSIVE: 12,
  /** Charred wood and coals. emissive > 0 makes embers glow in the cracks. */
  CHAR: 13,
} as const;
export type MatId = (typeof MAT)[keyof typeof MAT];
export const MAT_NAMES = ['snow', 'rock', 'bark', 'wood', 'metal', 'paint', 'cloth', 'plastic', 'glass', 'ice', 'rubber', 'fur', 'emissive', 'char'];

// Default roughness / metalness per material id.
const MAT_ROUGH = [0.85, 0.9, 0.95, 0.8, 0.42, 0.55, 0.95, 0.5, 0.08, 0.2, 0.85, 1, 0.6, 0.95];
const MAT_METAL = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export type RGB = readonly [number, number, number];
export type V3 = readonly [number, number, number];
export type P2 = readonly [number, number];
export interface Vec { x: number; y: number; z: number }

const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** sRGB hex (as you would pick it on screen) to linear RGB. */
export function hex(h: number): RGB {
  return [s2l(((h >> 16) & 255) / 255), s2l(((h >> 8) & 255) / 255), s2l((h & 255) / 255)];
}
export function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function scaleRGB(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k];
}

/** The shared palette. Albedos are deliberately low and grey: this is a cold, overcast mountain. */
export const PAL = {
  // aircraft
  aluminium: hex(0xc9ccce),
  aluminiumDull: hex(0x9ea3a6),
  liveryWhite: hex(0xd3d5d0),
  liveryGrey: hex(0x7a8085),
  liveryRed: hex(0x8a211d),
  liveryBlue: hex(0x1e3555),
  primer: hex(0x767a55), // zinc chromate green under aircraft paint
  scorched: hex(0x1d1a17),
  soot: hex(0x0d0c0b),
  seatBlue: hex(0x2a3852),
  seatGrey: hex(0x53575e),
  carpet: hex(0x3a3d45),
  // steel and iron
  steel: hex(0x8b8e91),
  steelDark: hex(0x4c4e51),
  iron: hex(0x38383a),
  galvanised: hex(0x9aa0a3),
  rust: hex(0x6a391e),
  rustDark: hex(0x3c2315),
  brass: hex(0xa88748),
  // paint on gear
  olive: hex(0x474e35),
  drab: hex(0x5b5a45),
  toolRed: hex(0x8f251c),
  toolBlue: hex(0x254a6e),
  signYellow: hex(0xc2951f),
  enamelWhite: hex(0xc9c8c0),
  enamelBlack: hex(0x1a1a1c),
  // survival gear
  orange: hex(0xd2541a),
  orangeFaded: hex(0xb8643a),
  // wood
  timber: hex(0x7c7164), // weathered grey-brown boards
  timberDark: hex(0x493b2d), // creosoted or cabin logs
  pine: hex(0xab8558), // fresh sawn softwood
  plywood: hex(0x9f865f),
  heartwood: hex(0xbd9c6c), // cut ends
  bark: hex(0x3a3028),
  barkGrey: hex(0x4d463f),
  deadwood: hex(0x8a8176), // barkless, sun-bleached
  charcoal: hex(0x131211),
  ash: hex(0x8a8884),
  // cloth, rope, rubber, plastic
  tarPaper: hex(0x1c1b1b),
  canvas: hex(0x8a8266),
  canvasOlive: hex(0x55593b),
  nylonBlack: hex(0x1b1c1f),
  nylonNavy: hex(0x1f2a40),
  nylonRed: hex(0x7d1f1b),
  leather: hex(0x49301d),
  rope: hex(0x978460),
  webbing: hex(0x26272a),
  rubber: hex(0x151515),
  plasticBlack: hex(0x19191b),
  plasticGrey: hex(0x6c6f72),
  plasticRed: hex(0xa0271d),
  // ground
  rock: hex(0x2b2c2f),
  rockBrown: hex(0x3a342e),
  concrete: hex(0x76746e),
  snow: [0.86, 0.89, 0.93] as RGB,
  ice: hex(0xa7c4d6),
  glass: hex(0x9db3b7),
  // light (multiply by emissive strength)
  fire: hex(0xff8426),
  ember: hex(0xff4a12),
  lampWarm: hex(0xffbf6e),
  lampCold: hex(0xcfe4ff),
  beaconRed: hex(0xff2616),
  instrument: hex(0x7dffa0),
} as const;

export const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------
// Noise on the CPU (seeded, for displacement)
// ------------------------------------------------------------------------------------------

const q5 = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const h3 = (s: number, x: number, y: number, z: number) => hash32(x + s * 7919, y, z) / 2147483648 - 1;
/** 3D value noise in [-1, 1]. */
export function noise3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const u = q5(x - ix), v = q5(y - iy), w = q5(z - iz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(h3(seed, ix, iy, iz), h3(seed, ix + 1, iy, iz), u), l(h3(seed, ix, iy + 1, iz), h3(seed, ix + 1, iy + 1, iz), u), v),
    l(l(h3(seed, ix, iy, iz + 1), h3(seed, ix + 1, iy, iz + 1), u), l(h3(seed, ix, iy + 1, iz + 1), h3(seed, ix + 1, iy + 1, iz + 1), u), v),
    w,
  );
}
export function fbm3(seed: number, x: number, y: number, z: number, octaves = 4, gain = 0.5): number {
  let a = 1, f = 1, s = 0, n = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * noise3(seed + o * 131, x * f, y * f, z * f);
    n += a;
    a *= gain;
    f *= 2.03;
  }
  return s / n;
}

// ------------------------------------------------------------------------------------------
// Paint
// ------------------------------------------------------------------------------------------

export interface Paint {
  /** Linear RGB albedo (for MAT.EMISSIVE: the light colour). */
  color?: RGB;
  mat?: MatId;
  rough?: number;
  metal?: number;
  /**
   * Glow as scene radiance, 0..64, the units of the lights (white paper in the day sun is about 3,
   * in dusk light about 1.5). Embers and coals 0.3 to 1 (MAT.CHAR: only its cracks glow), a lit
   * window 0.5 to 2, an instrument light or lamp lens 2 to 8, a beacon 10 to 30. Bloom starts
   * where radiance times exposure passes about 1, so the same number blooms at night, not by day.
   */
  emissive?: number;
  /** 0 new .. 1 wrecked. Edges wear first. */
  wear?: number;
  /** Snow exposure: 1 open to the sky, 0 under cover. build() also shades parts under other parts. */
  snow?: number;
  /** Random brightness spread per part (0.08 = +-8 %), so repeated boards do not match. */
  vary?: number;
  /** Which local axis the grain runs along (default 'y'). */
  grain?: 'x' | 'y' | 'z';
  /** Scale on the detail coordinates: > 1 makes the procedural detail finer on this part. */
  detailScale?: number;
  /**
   * Wood only: where the growth rings centre, as [x, z] across the grain in the part's own frame
   * at paint time. Logs and sticks pass [0, 0] (rings round the heart); by default the heart lies
   * far outside the part, so sawn boards show long straight grain.
   */
  pith?: P2;
}

/**
 * A read / write view of one vertex for Part.each(). `mat` may be changed per vertex, but a
 * triangle must never join two ids that are not neighbours (BARK-WOOD is fine, WOOD-CHAR is not):
 * the id is interpolated across the triangle, so the ids in between would show as bands.
 */
export interface VertexRef {
  readonly i: number;
  readonly x: number; readonly y: number; readonly z: number;
  readonly nx: number; readonly ny: number; readonly nz: number;
  readonly edge: number;
  r: number; g: number; b: number;
  mat: number;
  rough: number; metal: number; emissive: number; wear: number; snow: number; ao: number;
}

// ------------------------------------------------------------------------------------------
// Part: one mesh chunk under construction
// ------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n3 = new THREE.Matrix3();
const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, v: number) => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

interface Transformable<T> {
  apply(m: THREE.Matrix4): T;
}

/** Shared transform sugar for Part and Group. */
abstract class Xf<T> implements Transformable<T> {
  abstract apply(m: THREE.Matrix4): T;
  move(x: number | V3, y = 0, z = 0): T {
    if (typeof x !== 'number') return this.apply(_m.makeTranslation(x[0], x[1], x[2]));
    return this.apply(_m.makeTranslation(x, y, z));
  }
  rotX(a: number): T { return this.apply(_m.makeRotationX(a)); }
  rotY(a: number): T { return this.apply(_m.makeRotationY(a)); }
  rotZ(a: number): T { return this.apply(_m.makeRotationZ(a)); }
  /** Rotate about X, then Y, then Z (radians). */
  rot(rx: number, ry: number, rz: number): T {
    return this.apply(_m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'ZYX')));
  }
  /** Rotate by `angle` about an arbitrary axis through the origin. */
  rotAxis(axis: V3, angle: number): T {
    return this.apply(_m.makeRotationAxis(_v.set(axis[0], axis[1], axis[2]).normalize(), angle));
  }
  scale(sx: number, sy = sx, sz = sx): T { return this.apply(_m.makeScale(sx, sy, sz)); }
  /** Turn the part's +Y axis to point along `dir` (for things made along Y), then move to `at`. */
  aim(dir: V3, at?: V3): T {
    const d = _v.set(dir[0], dir[1], dir[2]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    this.apply(_m.makeRotationFromQuaternion(q));
    return at ? this.move(at) : (this as unknown as T);
  }
  /** Place a Y-made part of length `len` so that it spans from a to b (its centre at the midpoint). */
  span(a: V3, b: V3): T {
    return this.aim([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  }
}

export class Part extends Xf<Part> {
  /** positions, normals (xyz per vertex), edge-ness (one per vertex), triangle indices */
  p: number[] = [];
  n: number[] = [];
  e: number[] = [];
  idx: number[] = [];
  // paint, one entry per vertex (d and c are xyz / rgb)
  d: number[] = [];
  c: number[] = [];
  m: number[] = [];
  ro: number[] = [];
  me: number[] = [];
  em: number[] = [];
  we: number[] = [];
  sn: number[] = [];
  sl: number[] = []; // sway length, metres
  st: number[] = []; // sway stiffness 0..1
  ao: number[] = []; // manual occlusion multiplier
  /** Affine transform applied since creation and the local box it was made in: the AO proxy. */
  xf = new THREE.Matrix4();
  lbox = new THREE.Box3();
  /** Other parts are darkened where they touch this one, and sheltered from snow under it. */
  occluder = true;
  /** Name of the ModelDef part this belongs to, or null for the main geometry. */
  owner: string | null = null;
  removed = false;
  constructor(readonly b: Builder) {
    super();
  }

  get count(): number { return this.p.length / 3; }
  get tris(): number { return this.idx.length / 3; }

  // --- construction (used by the primitives) ---
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, edge = 0): number {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.e.push(edge);
    return this.p.length / 3 - 1;
  }
  /** Add a triangle, wound to agree with its vertex normals. Degenerate triangles are dropped. */
  tri(a: number, b: number, c: number): void {
    const p = this.p, n = this.n;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
    const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx * gx + gy * gy + gz * gz < 1e-16) return;
    const s = gx * (n[a * 3] + n[b * 3] + n[c * 3]) + gy * (n[a * 3 + 1] + n[b * 3 + 1] + n[c * 3 + 1]) + gz * (n[a * 3 + 2] + n[b * 3 + 2] + n[c * 3 + 2]);
    if (s < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  /** Drop unreferenced vertices, set the AO proxy box, apply the builder's ink. */
  finish(): this {
    const used = new Int32Array(this.count).fill(-1);
    let k = 0;
    for (const i of this.idx) if (used[i] < 0) used[i] = k++;
    if (k !== this.count) {
      const p: number[] = new Array(k * 3), n: number[] = new Array(k * 3), e: number[] = new Array(k);
      for (let i = 0; i < used.length; i++) {
        const j = used[i];
        if (j < 0) continue;
        for (let a = 0; a < 3; a++) {
          p[j * 3 + a] = this.p[i * 3 + a];
          n[j * 3 + a] = this.n[i * 3 + a];
        }
        e[j] = this.e[i];
      }
      this.p = p;
      this.n = n;
      this.e = e;
      for (let i = 0; i < this.idx.length; i++) this.idx[i] = used[this.idx[i]];
    }
    this.refit();
    this.b._register(this);
    return this;
  }
  /** Recompute the AO proxy box in the part's current local frame (after a deformation). */
  refit(): void {
    this.lbox.makeEmpty();
    const inv = _m2.copy(this.xf).invert();
    for (let i = 0; i < this.p.length; i += 3) this.lbox.expandByPoint(_v.set(this.p[i], this.p[i + 1], this.p[i + 2]).applyMatrix4(inv));
  }

  // --- transforms ---
  apply(mat: THREE.Matrix4): this {
    const m = mat.elements;
    const p = this.p, n = this.n;
    _n3.getNormalMatrix(mat);
    const k = _n3.elements;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const a = n[i], b = n[i + 1], c = n[i + 2];
      const nx = k[0] * a + k[3] * b + k[6] * c, ny = k[1] * a + k[4] * b + k[7] * c, nz = k[2] * a + k[5] * b + k[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / l;
      n[i + 1] = ny / l;
      n[i + 2] = nz / l;
    }
    if (mat.determinant() < 0) for (let i = 0; i < this.idx.length; i += 3) {
      const t = this.idx[i + 1];
      this.idx[i + 1] = this.idx[i + 2];
      this.idx[i + 2] = t;
    }
    this.xf.premultiply(mat);
    return this;
  }

  /**
   * Free-form deformation: fn moves the point in place. Normals follow the deformation (they are
   * transformed by its numerical Jacobian), so bevel shading survives bends and dents.
   */
  warp(fn: (p: Vec) => void): this {
    const p = this.p, n = this.n;
    const q: Vec = { x: 0, y: 0, z: 0 };
    const eps = 2e-4;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      const nx = n[i], ny = n[i + 1], nz = n[i + 2];
      // two tangents
      let tx: number, ty: number, tz: number;
      if (Math.abs(nx) < 0.8) { tx = 0; ty = -nz; tz = ny; } else { tx = nz; ty = 0; tz = -nx; }
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      q.x = x; q.y = y; q.z = z;
      fn(q);
      const ox = q.x, oy = q.y, oz = q.z;
      q.x = x + tx * eps; q.y = y + ty * eps; q.z = z + tz * eps;
      fn(q);
      const ax = q.x - ox, ay = q.y - oy, az = q.z - oz;
      q.x = x + bx * eps; q.y = y + by * eps; q.z = z + bz * eps;
      fn(q);
      const cx = q.x - ox, cy = q.y - oy, cz = q.z - oz;
      // t x b = n, so J t x J b is the new normal
      let mx = ay * cz - az * cy, my = az * cx - ax * cz, mz = ax * cy - ay * cx;
      const ml = Math.hypot(mx, my, mz);
      if (ml > 1e-20) { mx /= ml; my /= ml; mz /= ml; } else { mx = nx; my = ny; mz = nz; }
      p[i] = ox; p[i + 1] = oy; p[i + 2] = oz;
      n[i] = mx; n[i + 1] = my; n[i + 2] = mz;
    }
    this.refit();
    return this;
  }
  /** Current axis-aligned bounds. */
  bounds(): THREE.Box3 {
    const b = new THREE.Box3();
    for (let i = 0; i < this.p.length; i += 3) b.expandByPoint(_v.set(this.p[i], this.p[i + 1], this.p[i + 2]));
    return b;
  }
  /**
   * Bend a part made along Y into an arc. `angle` is the total turn over the part's length; the
   * part curls toward +X (axis 'z') or toward +Z (axis 'x'). `from` 0..1 keeps the lower part straight.
   */
  bend(angle: number, axis: 'z' | 'x' = 'z', from = 0): this {
    if (Math.abs(angle) < 1e-6) return this;
    const bb = this.bounds();
    const y0 = bb.min.y + (bb.max.y - bb.min.y) * from;
    const len = bb.max.y - y0;
    if (len <= 0) return this;
    const k = angle / len;
    const R = 1 / k;
    return this.warp((p) => {
      const s = p.y - y0;
      if (s <= 0) return;
      const th = s * k;
      const side = axis === 'z' ? p.x : p.z;
      const r = R - side;
      const ns = R - r * Math.cos(th);
      p.y = y0 + r * Math.sin(th);
      if (axis === 'z') p.x = ns;
      else p.z = ns;
    });
  }
  /** Scale the cross-section (XZ) linearly along Y: `bottom` at the low end, `top` at the high end. */
  taper(top: number | P2, bottom: number | P2 = 1): this {
    const bb = this.bounds();
    const h = bb.max.y - bb.min.y || 1;
    const t = typeof top === 'number' ? [top, top] : top;
    const o = typeof bottom === 'number' ? [bottom, bottom] : bottom;
    return this.warp((p) => {
      const u = (p.y - bb.min.y) / h;
      p.x *= o[0] + (t[0] - o[0]) * u;
      p.z *= o[1] + (t[1] - o[1]) * u;
    });
  }
  /** Twist about Y by `angle` over the part's height. */
  twist(angle: number): this {
    const bb = this.bounds();
    const h = bb.max.y - bb.min.y || 1;
    return this.warp((p) => {
      const a = ((p.y - bb.min.y) / h - 0.5) * angle;
      const c = Math.cos(a), s = Math.sin(a);
      const x = p.x * c + p.z * s;
      p.z = -p.x * s + p.z * c;
      p.x = x;
    });
  }
  /** Displace by smooth vector noise: amp metres, freq cycles per metre. Warps and crumples. */
  crumple(amp: number, freq = 4, seed = this.b._nextSeed()): this {
    return this.warp((p) => {
      const x = p.x * freq, y = p.y * freq, z = p.z * freq;
      p.x += amp * fbm3(seed, x, y, z, 3);
      p.y += amp * fbm3(seed + 17, x, y, z, 3);
      p.z += amp * fbm3(seed + 31, x, y, z, 3);
    });
  }
  /** Displace along the normal by noise (lumpy surfaces: rock, bark, snow, hammered metal). */
  noise(amp: number, freq = 4, seed = this.b._nextSeed(), octaves = 3): this {
    const p = this.p, n = this.n;
    // Along-normal displacement must agree for coincident vertices or seams open: use the
    // welded mean normal as the direction.
    const w = weld(p, 1e-4);
    const acc = new Float64Array(w.count * 3);
    for (let i = 0; i < w.map.length; i++) for (let a = 0; a < 3; a++) acc[w.map[i] * 3 + a] += n[i * 3 + a];
    for (let i = 0; i < w.map.length; i++) {
      const j = w.map[i] * 3;
      const l = Math.hypot(acc[j], acc[j + 1], acc[j + 2]) || 1;
      const d = amp * fbm3(seed, p[i * 3] * freq, p[i * 3 + 1] * freq, p[i * 3 + 2] * freq, octaves);
      p[i * 3] += (acc[j] / l) * d;
      p[i * 3 + 1] += (acc[j + 1] / l) * d;
      p[i * 3 + 2] += (acc[j + 2] / l) * d;
    }
    this.recalcNormals(0.6);
    this.refit();
    return this;
  }
  /** Push a dent: vertices within `radius` of `at` move along `dir` (default: toward the part's centre). */
  dent(at: V3, radius: number, depth: number, dir?: V3): this {
    let dx = 0, dy = 0, dz = 0;
    if (dir) {
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dx = dir[0] / l; dy = dir[1] / l; dz = dir[2] / l;
    } else {
      const c = this.bounds().getCenter(new THREE.Vector3());
      dx = c.x - at[0]; dy = c.y - at[1]; dz = c.z - at[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
    }
    return this.warp((p) => {
      const r = Math.hypot(p.x - at[0], p.y - at[1], p.z - at[2]) / radius;
      if (r >= 1) return;
      const f = (1 - r * r) * (1 - r * r) * depth;
      p.x += dx * f; p.y += dy * f; p.z += dz * f;
    });
  }
  /**
   * Recompute normals from the triangles. `keep` 0..1 blends back toward the existing normals
   * (so designed bevel shading is not lost). Vertices stay split where they were split.
   */
  recalcNormals(keep = 0): this {
    const p = this.p, n = this.n, idx = this.idx;
    const acc = new Float64Array(p.length);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { acc[v] += gx; acc[v + 1] += gy; acc[v + 2] += gz; }
    }
    for (let i = 0; i < p.length; i += 3) {
      const l = Math.hypot(acc[i], acc[i + 1], acc[i + 2]) || 1;
      let x = acc[i] / l, y = acc[i + 1] / l, z = acc[i + 2] / l;
      if (keep > 0) {
        x += (n[i] - x) * keep; y += (n[i + 1] - y) * keep; z += (n[i + 2] - z) * keep;
        const m = Math.hypot(x, y, z) || 1;
        x /= m; y /= m; z /= m;
      }
      n[i] = x; n[i + 1] = y; n[i + 2] = z;
    }
    return this;
  }
  /** Turn the part inside out (for the inner face of a shell). */
  flip(): this {
    for (let i = 0; i < this.n.length; i++) this.n[i] = -this.n[i];
    for (let i = 0; i < this.idx.length; i += 3) {
      const t = this.idx[i + 1];
      this.idx[i + 1] = this.idx[i + 2];
      this.idx[i + 2] = t;
    }
    return this;
  }

  // --- paint ---
  /** Set paint fields on every vertex. The first paint (done by the builder) also captures detail coordinates. */
  paint(o: Paint): this {
    const nv = this.count;
    const first = this.m.length !== nv;
    if (first) {
      const seed = this.b._nextSeed();
      const g = o.grain ?? 'y';
      const ds = o.detailScale ?? 1;
      // A random offset decorrelates the procedural detail of parts. Across the grain it is also
      // where the heart of the tree (the ring centre) lies: 6 to 36 cm off, as in a board sawn
      // from a real log, and never quite parallel to the board (a slight shear), so faces show
      // cathedral arches. `pith` puts it exactly on the axis instead (logs, sticks).
      const h01 = (k: number) => hash32(seed, k) / 4294967296;
      const pa = h01(1) * Math.PI * 2, pr = 0.06 + h01(3) * 0.3;
      const ox = o.pith ? -o.pith[0] * ds : Math.cos(pa) * pr, oy = h01(2) * 31, oz = o.pith ? -o.pith[1] * ds : Math.sin(pa) * pr;
      const shx = o.pith ? 0 : (h01(5) - 0.5) * 0.06, shz = o.pith ? 0 : (h01(6) - 0.5) * 0.06;
      this.d.length = nv * 3;
      for (let i = 0; i < nv; i++) {
        let x = this.p[i * 3], y = this.p[i * 3 + 1], z = this.p[i * 3 + 2];
        if (g === 'x') { const t = x; x = y; y = t; } else if (g === 'z') { const t = z; z = y; y = t; }
        this.d[i * 3] = (x + y * shx) * ds + ox;
        this.d[i * 3 + 1] = y * ds + oy;
        this.d[i * 3 + 2] = (z + y * shz) * ds + oz;
      }
      const mat = o.mat ?? MAT.PLASTIC;
      const col = o.color ?? PAL.plasticGrey;
      this.c.length = nv * 3;
      for (const [arr, val] of [
        [this.m, mat], [this.ro, o.rough ?? MAT_ROUGH[mat]], [this.me, o.metal ?? MAT_METAL[mat]], [this.em, o.emissive ?? (mat === MAT.EMISSIVE ? 4 : 0)],
        [this.we, o.wear ?? 0.3], [this.sn, o.snow ?? 1], [this.sl, 0], [this.st, 0], [this.ao, 1],
      ] as [number[], number][]) {
        arr.length = nv;
        arr.fill(val);
      }
      const k = 1 + (o.vary ?? 0.06) * (hash32(seed, 4) / 2147483648 - 1);
      for (let i = 0; i < nv; i++) {
        this.c[i * 3] = col[0] * k; this.c[i * 3 + 1] = col[1] * k; this.c[i * 3 + 2] = col[2] * k;
      }
      return this;
    }
    if (o.mat !== undefined) {
      this.m.fill(o.mat);
      if (o.rough === undefined) this.ro.fill(MAT_ROUGH[o.mat]);
      if (o.metal === undefined) this.me.fill(MAT_METAL[o.mat]);
    }
    if (o.color) {
      const k = 1 + (o.vary ?? 0) * (hash32(this.b._nextSeed(), 4) / 2147483648 - 1);
      for (let i = 0; i < nv; i++) {
        this.c[i * 3] = o.color[0] * k; this.c[i * 3 + 1] = o.color[1] * k; this.c[i * 3 + 2] = o.color[2] * k;
      }
    }
    if (o.rough !== undefined) this.ro.fill(o.rough);
    if (o.metal !== undefined) this.me.fill(o.metal);
    if (o.emissive !== undefined) this.em.fill(o.emissive);
    if (o.wear !== undefined) this.we.fill(o.wear);
    if (o.snow !== undefined) this.sn.fill(o.snow);
    if (o.detailScale !== undefined) for (let i = 0; i < this.d.length; i++) this.d[i] *= o.detailScale;
    return this;
  }
  /** Edit vertices one by one: gradients of soot, wear, snow, glow. */
  each(fn: (v: VertexRef) => void): this {
    const self = this;
    let i = 0;
    const v: VertexRef = {
      get i() { return i; },
      get x() { return self.p[i * 3]; }, get y() { return self.p[i * 3 + 1]; }, get z() { return self.p[i * 3 + 2]; },
      get nx() { return self.n[i * 3]; }, get ny() { return self.n[i * 3 + 1]; }, get nz() { return self.n[i * 3 + 2]; },
      get edge() { return self.e[i]; },
      get r() { return self.c[i * 3]; }, set r(x) { self.c[i * 3] = x; },
      get g() { return self.c[i * 3 + 1]; }, set g(x) { self.c[i * 3 + 1] = x; },
      get b() { return self.c[i * 3 + 2]; }, set b(x) { self.c[i * 3 + 2] = x; },
      get mat() { return self.m[i]; }, set mat(x) { self.m[i] = x; },
      get rough() { return self.ro[i]; }, set rough(x) { self.ro[i] = x; },
      get metal() { return self.me[i]; }, set metal(x) { self.me[i] = x; },
      get emissive() { return self.em[i]; }, set emissive(x) { self.em[i] = x; },
      get wear() { return self.we[i]; }, set wear(x) { self.we[i] = x; },
      get snow() { return self.sn[i]; }, set snow(x) { self.sn[i] = x; },
      get ao() { return self.ao[i]; }, set ao(x) { self.ao[i] = x; },
    };
    for (i = 0; i < this.count; i++) fn(v);
    return this;
  }
  /** Blend the colour toward `color` by fn(vertex) 0..1 (soot toward a rim, mud toward the ground). */
  tint(color: RGB, fn: (v: VertexRef) => number): this {
    return this.each((v) => {
      const t = sat(fn(v));
      v.r += (color[0] - v.r) * t; v.g += (color[1] - v.g) * t; v.b += (color[2] - v.b) * t;
    });
  }
  /** Multiply the baked occlusion by fn(vertex) (insides of boxes, barrels, cavities the proxy AO cannot see). */
  shade(fn: (v: VertexRef) => number): this {
    return this.each((v) => { v.ao *= fn(v); });
  }
  /**
   * Make the part blow in the wind. Each vertex swings like a pendulum hung from `pin`: its sway
   * length is its distance from the pin (or from the pin's height if `byHeight`), so model cloth
   * and straps hanging at rest. stiff 0 = limp rag (flies out flat in a storm), 1 = stiff (trembles).
   */
  sway(pin: V3 | ((v: VertexRef) => number), stiff = 0, byHeight = false): this {
    return this.each((v) => {
      const len = typeof pin === 'function' ? pin(v) : byHeight ? Math.max(0, pin[1] - v.y) : Math.hypot(v.x - pin[0], v.y - pin[1], v.z - pin[2]);
      this.sl[v.i] = Math.min(2.55, Math.max(0, len));
      this.st[v.i] = sat(stiff);
    });
  }
  /** Not an occluder: other parts are not darkened or sheltered by this one (cloth, cables, open shells). */
  ghost(): this {
    this.occluder = false;
    return this;
  }

  // --- copies ---
  /** A copy, registered with the builder (and the current group) like a new primitive. */
  clone(): Part {
    const q = new Part(this.b);
    for (const k of ['p', 'n', 'e', 'idx', 'd', 'c', 'm', 'ro', 'me', 'em', 'we', 'sn', 'sl', 'st', 'ao'] as const) q[k] = this[k].slice();
    q.xf.copy(this.xf);
    q.lbox.copy(this.lbox);
    q.occluder = this.occluder;
    q.owner = this.owner;
    this.b._register(q, true);
    return q;
  }
  /** A mirrored copy across the plane axis = 0. */
  mirror(axis: 'x' | 'y' | 'z' = 'x'): Part {
    return this.clone().apply(_m.makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1));
  }
  /** Absorb another part (it is removed). They then count as one for occlusion. */
  merge(o: Part): this {
    const base = this.count;
    for (const k of ['p', 'n', 'e', 'd', 'c', 'm', 'ro', 'me', 'em', 'we', 'sn', 'sl', 'st', 'ao'] as const) for (const v of o[k]) this[k].push(v);
    for (const i of o.idx) this.idx.push(i + base);
    o.removed = true;
    this.xf.identity();
    this.refit();
    return this;
  }
  remove(): void {
    this.removed = true;
  }
}

/** Positions welded on a grid of `tol` metres: map[i] = welded id of vertex i. */
function weld(p: number[], tol: number): { map: Int32Array; count: number } {
  const n = p.length / 3;
  const map = new Int32Array(n);
  const seen = new Map<string, number>();
  const k = 1 / tol;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const key = Math.round(p[i * 3] * k) + ',' + Math.round(p[i * 3 + 1] * k) + ',' + Math.round(p[i * 3 + 2] * k);
    let id = seen.get(key);
    if (id === undefined) {
      id = count++;
      seen.set(key, id);
    }
    map[i] = id;
  }
  return { map, count };
}

// ------------------------------------------------------------------------------------------
// Group: several parts (and the anchors / emitters / lights declared with them) moved as one
// ------------------------------------------------------------------------------------------

export interface Anchor { name: string; position: THREE.Vector3; yaw: number; [extra: string]: unknown }
export type EmitterType = 'fire' | 'smoke' | 'steam' | 'spark' | 'light' | 'beacon';
export interface Emitter {
  type: EmitterType;
  name?: string;
  position: THREE.Vector3;
  /** Unit direction the effect leaves in (default up). */
  dir: THREE.Vector3;
  /** Rough radius of the source in metres. */
  size: number;
  /** Name of the ModelDef part this moves with, if any. */
  part?: string;
  [extra: string]: unknown;
}
export interface LightDef {
  name?: string;
  position: THREE.Vector3;
  color: RGB;
  /** Candela-ish: PointLight.intensity. */
  intensity: number;
  range: number;
  /** 0 steady .. 1 fire-like flicker. */
  flicker: number;
  castShadow: boolean;
  part?: string;
}

export class Group extends Xf<Group> {
  parts: Part[] = [];
  anchors: Anchor[] = [];
  emitters: Emitter[] = [];
  lights: LightDef[] = [];
  /** For a named model part: the point the game rotates it about. */
  pivot = new THREE.Vector3();
  /** For a hinged named part: the hinge axis (unit, model space) and the angle that opens it fully. */
  axis = new THREE.Vector3(1, 0, 0);
  openAngle = 0;
  constructor(readonly b: Builder, readonly name: string | null = null) {
    super();
  }
  apply(m: THREE.Matrix4): this {
    // Part.apply uses the shared scratch matrix too: copy first.
    const mm = m.clone();
    for (const p of this.parts) if (!p.removed) p.apply(mm);
    for (const a of this.anchors) {
      a.position.applyMatrix4(mm);
      a.yaw += Math.atan2(mm.elements[8], mm.elements[10]);
    }
    for (const e of this.emitters) {
      e.position.applyMatrix4(mm);
      e.dir.transformDirection(mm);
    }
    for (const l of this.lights) l.position.applyMatrix4(mm);
    this.pivot.applyMatrix4(mm);
    this.axis.transformDirection(mm);
    // a mirror turns the sense of rotation around
    if (mm.determinant() < 0) this.openAngle = -this.openAngle;
    return this;
  }
  paint(o: Paint): this {
    for (const p of this.parts) p.paint(o);
    return this;
  }
  each(fn: (v: VertexRef, part: Part) => void): this {
    for (const p of this.parts) p.each((v) => fn(v, p));
    return this;
  }
  ghost(): this {
    for (const p of this.parts) p.ghost();
    return this;
  }
  bounds(): THREE.Box3 {
    const b = new THREE.Box3();
    for (const p of this.parts) if (!p.removed) b.union(p.bounds());
    return b;
  }
  /** A copy of everything in the group. Anchors and named emitters / lights get `suffix`. */
  clone(suffix = '_2'): Group {
    const g = new Group(this.b, null);
    this.b._inGroup(g, () => {
      for (const p of this.parts) if (!p.removed) p.clone();
    });
    for (const a of this.anchors) g.anchors.push(this.b._anchor({ ...a, name: a.name + suffix, position: a.position.clone() }));
    for (const e of this.emitters) g.emitters.push(this.b._emitter({ ...e, name: e.name ? e.name + suffix : undefined, position: e.position.clone(), dir: e.dir.clone() }));
    for (const l of this.lights) g.lights.push(this.b._light({ ...l, name: l.name ? l.name + suffix : undefined, position: l.position.clone() }));
    this.b._adopt(g);
    return g;
  }
  mirror(axis: 'x' | 'y' | 'z' = 'x', suffix = '_2'): Group {
    return this.clone(suffix).apply(_m.makeScale(axis === 'x' ? -1 : 1, axis === 'y' ? -1 : 1, axis === 'z' ? -1 : 1));
  }
  /** Merge all parts into one (one occlusion proxy, one grain offset is NOT implied: detail stays). */
  merged(): Part {
    const live = this.parts.filter((p) => !p.removed);
    const first = live[0];
    for (let i = 1; i < live.length; i++) first.merge(live[i]);
    return first;
  }
}

// ------------------------------------------------------------------------------------------
// 2D outlines with bevelled corners: the basis of box, extrude, lathe and sweep
// ------------------------------------------------------------------------------------------

/** A vertex of a processed outline: position, outward normal, edge-ness, and the direction it moves in when the outline is inset by 1. */
interface OV { x: number; y: number; nx: number; ny: number; e: number; ix: number; iy: number }

/**
 * Turn a polyline into runs of vertices with normals. Travelling along the points, the outside is
 * on the right (a counter-clockwise closed polygon faces outward). Convex corners sharper than
 * `crease` get a bevel of `bevel` metres in `seg` steps, shaded round; flatter corners are smooth.
 */
function outline2(pts: readonly P2[], closed: boolean, bevel: number, seg: number, crease = 32 * DEG, smoothAll = false): OV[][] {
  const P: P2[] = [];
  for (const q of pts) {
    const l = P[P.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-7) P.push(q);
  }
  if (closed && P.length > 2 && Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1e-7) P.pop();
  const n = P.length;
  if (n < 2) return [];
  const sc = closed ? n : n - 1;
  const tx: number[] = [], ty: number[] = [], len: number[] = [];
  for (let s = 0; s < sc; s++) {
    const a = P[s], b = P[(s + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    tx.push((b[0] - a[0]) / l);
    ty.push((b[1] - a[1]) / l);
    len.push(l);
  }
  // corner i sits between segment (i - 1) and segment i
  type CT = 'smooth' | 'bevel' | 'hard' | 'end';
  const ct: CT[] = [], cut: number[] = [], ang: number[] = [];
  // mitre direction at corner i: moving the corner by this vector insets both segments by 1
  const mitx: number[] = [], mity: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 1 + n) % n : i - 1, b = i;
    if (!closed && (i === 0 || i === n - 1)) {
      const s = i === 0 ? 0 : sc - 1;
      ct.push('end'); cut.push(0); ang.push(0); mitx.push(ty[s]); mity.push(-tx[s]);
      continue;
    }
    const cr = tx[a] * ty[b] - ty[a] * tx[b];
    const dt = tx[a] * tx[b] + ty[a] * ty[b];
    const an = Math.atan2(Math.abs(cr), dt);
    ang.push(an);
    const k = 1 / Math.max(0.2, 1 + dt);
    mitx.push((ty[a] + ty[b]) * k);
    mity.push(-(tx[a] + tx[b]) * k);
    if (smoothAll || an < crease) { ct.push('smooth'); cut.push(0); }
    else if (cr > 0 && bevel > 0) { ct.push('bevel'); cut.push(Math.min(bevel, 0.45 * len[a], 0.45 * len[b])); }
    else { ct.push('hard'); cut.push(0); }
  }
  const avgN = (i: number): [number, number] => {
    const l = Math.hypot(mitx[i], mity[i]) || 1;
    return [mitx[i] / l, mity[i] / l];
  };
  let start = 0;
  if (closed) {
    start = ct.findIndex((c) => c !== 'smooth');
    if (start < 0) start = 0;
  }
  const runs: OV[][] = [];
  let cur: OV[] | null = null;
  for (let k = 0; k < sc; k++) {
    const s = closed ? (start + k) % n : k;
    const i = s, j = (s + 1) % n;
    const nx = ty[s], ny = -tx[s];
    if (!cur) {
      if (ct[i] === 'smooth') {
        const [ax, ay] = avgN(i);
        cur = [{ x: P[i][0], y: P[i][1], nx: ax, ny: ay, e: 0, ix: mitx[i], iy: mity[i] }];
      } else if (ct[i] === 'bevel') cur = [{ x: P[i][0] + tx[s] * cut[i], y: P[i][1] + ty[s] * cut[i], nx, ny, e: 0, ix: nx, iy: ny }];
      else cur = [{ x: P[i][0], y: P[i][1], nx, ny, e: 0, ix: mitx[i], iy: mity[i] }];
    }
    const nextS = closed ? (s + 1) % n : s + 1;
    if (ct[j] === 'smooth') {
      const [ax, ay] = avgN(j);
      cur.push({ x: P[j][0], y: P[j][1], nx: ax, ny: ay, e: 0, ix: mitx[j], iy: mity[j] });
      continue;
    }
    if (ct[j] !== 'bevel') {
      cur.push({ x: P[j][0], y: P[j][1], nx, ny, e: 0, ix: mitx[j], iy: mity[j] });
      runs.push(cur);
      cur = null;
      continue;
    }
    const ex = P[j][0] - tx[s] * cut[j], ey = P[j][1] - ty[s] * cut[j];
    cur.push({ x: ex, y: ey, nx, ny, e: 0, ix: nx, iy: ny });
    runs.push(cur);
    cur = null;
    const mx = ty[nextS], my = -tx[nextS];
    const bx = P[j][0] + tx[nextS] * cut[j], by = P[j][1] + ty[nextS] * cut[j];
    const run: OV[] = [];
    const R = cut[j] / Math.tan(ang[j] / 2);
    const cx = ex - nx * R, cy = ey - ny * R;
    for (let q = 0; q <= seg; q++) {
      const a = (q / seg) * ang[j];
      // rotate (nx, ny) counter-clockwise by a: toward the next segment's normal at a convex corner
      const rx = nx * Math.cos(a) - ny * Math.sin(a), ry = nx * Math.sin(a) + ny * Math.cos(a);
      if (q === 0) run.push({ x: ex, y: ey, nx, ny, e: 1, ix: nx, iy: ny });
      else if (q === seg) run.push({ x: bx, y: by, nx: mx, ny: my, e: 1, ix: mx, iy: my });
      else run.push({ x: cx + rx * R, y: cy + ry * R, nx: rx, ny: ry, e: 1, ix: rx, iy: ry });
    }
    runs.push(run);
  }
  if (cur) runs.push(cur);
  return runs;
}

function signedArea(p: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}
const ccw = (p: readonly P2[]): P2[] => (signedArea(p) < 0 ? [...p].reverse() : [...p]);

/** Triangulate the closed loop formed by the runs' (possibly offset) positions. Returns unique points and triangles. */
function capFromRuns(runs: OV[][], inset: number): { pts: P2[]; tris: number[][] } {
  const pts: P2[] = [];
  for (const r of runs) for (const v of r) {
    const x = v.x - v.ix * inset, y = v.y - v.iy * inset;
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(l[0] - x, l[1] - y) > 1e-6) pts.push([x, y]);
  }
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
  if (pts.length < 3) return { pts, tris: [] };
  const tris = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p[0], p[1])), []);
  return { pts, tris };
}

// ------------------------------------------------------------------------------------------
// Paths (for sweep, pipe, cable, strap)
// ------------------------------------------------------------------------------------------

export const Path = {
  /** Round the corners of a polyline with arcs of `radius`, `seg` steps each. */
  fillet(pts: readonly V3[], radius: number, seg = 4): V3[] {
    const out: V3[] = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = new THREE.Vector3(...pts[i - 1]), p = new THREE.Vector3(...pts[i]), c = new THREE.Vector3(...pts[i + 1]);
      const d0 = a.clone().sub(p), d1 = c.clone().sub(p);
      const l0 = d0.length(), l1 = d1.length();
      d0.divideScalar(l0);
      d1.divideScalar(l1);
      const half = Math.acos(Math.max(-1, Math.min(1, d0.dot(d1)))) / 2;
      if (half > Math.PI / 2 - 0.02) { out.push(pts[i]); continue; }
      const cut = Math.min(radius / Math.tan(half), l0 * 0.48, l1 * 0.48);
      const s = p.clone().addScaledVector(d0, cut), e = p.clone().addScaledVector(d1, cut);
      for (let k = 0; k <= seg; k++) {
        const t = k / seg;
        // quadratic Bezier through the corner: close enough to an arc for pipes and straps
        const q = s.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(p, 2 * t * (1 - t)).addScaledVector(e, t * t);
        out.push([q.x, q.y, q.z]);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  },
  /** A hanging line from a to b that drops `sag` metres at the middle, n segments. */
  catenary(a: V3, b: V3, sag: number, n = 12): V3[] {
    const out: V3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
    }
    return out;
  },
  /** An arc in the plane spanned by unit vectors u and v around `c`: c + r (u cos a + v sin a), a0..a1. */
  arc(c: V3, r: number, a0: number, a1: number, n = 12, u: V3 = [1, 0, 0], v: V3 = [0, 1, 0]): V3[] {
    const out: V3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      const cs = Math.cos(a) * r, sn = Math.sin(a) * r;
      out.push([c[0] + u[0] * cs + v[0] * sn, c[1] + u[1] * cs + v[1] * sn, c[2] + u[2] * cs + v[2] * sn]);
    }
    return out;
  },
  /** A smooth curve through the points (Catmull-Rom), `n` segments between each pair. */
  spline(pts: readonly V3[], n = 6): V3[] {
    const c = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal');
    return c.getPoints((pts.length - 1) * n).map((p) => [p.x, p.y, p.z] as V3);
  },
};

// ------------------------------------------------------------------------------------------
// ModelDef
// ------------------------------------------------------------------------------------------

export interface ModelPart {
  name: string;
  /** Geometry relative to the pivot. */
  geometry: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  /** Model-space point the part is placed at (and rotated about). */
  pivot: THREE.Vector3;
  /** Hinge axis through the pivot (unit, model space). */
  axis: THREE.Vector3;
  /** Rotation about `axis` (radians) that opens the part fully; 0 if it is not hinged. */
  openAngle: number;
}

export interface ModelDef {
  /** Filled in by the registry. */
  name: string;
  seed: number;
  /** All opaque geometry that is not a named part, merged. Null only if the model is all glass. */
  geometry: THREE.BufferGeometry | null;
  /** Transparent geometry (MAT.GLASS), drawn with the glass material, or null. */
  glass: THREE.BufferGeometry | null;
  /** Named sub-meshes the game moves or lights on its own (doors, lids, needles). */
  parts: Record<string, ModelPart>;
  anchors: Record<string, Anchor>;
  emitters: Emitter[];
  lights: LightDef[];
  bounds: THREE.Box3;
  /** Bounding-sphere radius about the origin. */
  radius: number;
  tris: number;
}

export interface BuildOpts {
  /** Darken toward y = 0 (the model stands on the ground). Default true. */
  ground?: boolean;
  /** Reach of the contact darkening in metres. Default: 12 % of the model's size, 0.04 .. 0.3. */
  aoRadius?: number;
  /** 0 disables baked occlusion, 1 default strength. */
  ao?: number;
}

// ------------------------------------------------------------------------------------------
// Stencil font: strokes as polylines on a 4 x 6 grid, "x y x y ..." per stroke
// ------------------------------------------------------------------------------------------

const GLYPHS: Record<string, string[]> = {
  A: ['0 0 0 4 2 6 4 4 4 0', '0 2.6 4 2.6'], B: ['0 0 0 6 3 6 4 5 4 4 3 3 0 3', '3 3 4 2 4 1 3 0 0 0'],
  C: ['4 5.4 3 6 1 6 0 5 0 1 1 0 3 0 4 0.6'], D: ['0 0 0 6 3 6 4 5 4 1 3 0 0 0'], E: ['4 6 0 6 0 0 4 0', '0 3 3 3'],
  F: ['4 6 0 6 0 0', '0 3 3 3'], G: ['4 5 3 6 1 6 0 5 0 1 1 0 3 0 4 1 4 3 2 3'], H: ['0 0 0 6', '4 0 4 6', '0 3 4 3'],
  I: ['1 6 3 6', '2 6 2 0', '1 0 3 0'], J: ['4 6 4 1 3 0 1 0 0 1'], K: ['0 0 0 6', '4 6 0 2', '1.3 3.3 4 0'],
  L: ['0 6 0 0 4 0'], M: ['0 0 0 6 2 3 4 6 4 0'], N: ['0 0 0 6 4 0 4 6'], O: ['1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0'],
  P: ['0 0 0 6 3 6 4 5 4 4 3 3 0 3'], Q: ['1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0', '2.4 1.6 4 0'],
  R: ['0 0 0 6 3 6 4 5 4 4 3 3 0 3', '2 3 4 0'], S: ['4 5 3 6 1 6 0 5 0 4 1 3 3 3 4 2 4 1 3 0 1 0 0 1'],
  T: ['0 6 4 6', '2 6 2 0'], U: ['0 6 0 1 1 0 3 0 4 1 4 6'], V: ['0 6 2 0 4 6'], W: ['0 6 1 0 2 3 3 0 4 6'],
  X: ['0 6 4 0', '0 0 4 6'], Y: ['0 6 2 3 4 6', '2 3 2 0'], Z: ['0 6 4 6 0 0 4 0'],
  '0': ['1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0', '1 1.5 3 4.5'], '1': ['1 5 2 6 2 0', '1 0 3 0'],
  '2': ['0 5 1 6 3 6 4 5 4 4 0 0 4 0'], '3': ['0 5 1 6 3 6 4 5 4 4 3 3 1.5 3', '3 3 4 2 4 1 3 0 1 0 0 1'],
  '4': ['3 0 3 6 0 2 4 2'], '5': ['4 6 0 6 0 3.4 3 3.4 4 2.4 4 1 3 0 0 0'],
  '6': ['4 5 3 6 1 6 0 5 0 1 1 0 3 0 4 1 4 2 3 3 0 3'], '7': ['0 6 4 6 1.2 0'],
  '8': ['1 3 0 4 0 5 1 6 3 6 4 5 4 4 3 3 1 3 0 2 0 1 1 0 3 0 4 1 4 2 3 3'], '9': ['4 3 1 3 0 4 0 5 1 6 3 6 4 5 4 1 3 0 1 0'],
  '-': ['0.8 3 3.2 3'], '.': ['2 0 2 0.7'], '/': ['0 0 4 6'], '^': ['2 0 2 6', '0 4 2 6 4 4'], ' ': [],
};

// ------------------------------------------------------------------------------------------
// Builder
// ------------------------------------------------------------------------------------------

export interface BoxOpts { bevel?: number; seg?: number; top?: boolean; bottom?: boolean; rows?: number }
export interface CylOpts { sides?: number; bevel?: number; seg?: number; top?: boolean; bottom?: boolean; rows?: number }
export interface LatheOpts {
  sides?: number;
  bevel?: number;
  seg?: number;
  crease?: number;
  smooth?: boolean;
  closed?: boolean;
  /** Partial revolution [from, to] in radians (angle 0 is +X, turning toward +Z): gutters, half pipes, the wall between two vents. Open at the cut. */
  arc?: P2;
}
export interface ExtrudeOpts { bevel?: number; seg?: number; capBevel?: number; top?: boolean; bottom?: boolean; rows?: number; crease?: number; smooth?: boolean }
export interface SweepOpts {
  /** Sides when the profile is a radius. */
  sides?: number;
  bevel?: number;
  seg?: number;
  /** The path is a loop. */
  closed?: boolean;
  caps?: boolean;
  /** Scale of the profile along the path, t in 0..1. */
  scale?: (t: number) => number | P2;
  /** Roll of the profile about the path, radians, t in 0..1. */
  twist?: (t: number) => number;
  /** Direction the profile's +Y axis leans toward at the start (default world up). */
  up?: V3;
  smooth?: boolean;
}
export interface ClothOpts {
  /** Cells across and down (default from size, about 6 cm cells). */
  nx?: number;
  ny?: number;
  /** Belly of the sheet toward +Z, metres. */
  billow?: number;
  /** Amplitude of the wrinkles, metres. */
  wrinkle?: number;
  /** 0..1: how ragged the bottom edge is (notches and missing cells). */
  tear?: number;
  /** Which edges are ragged. Default ['bottom']. */
  tearEdges?: ('bottom' | 'top' | 'left' | 'right')[];
  /** Sheet thickness in metres (the two faces are this far apart). */
  thickness?: number;
}
export interface PillowOpts {
  /** Edge radius in metres (default 20 % of the smallest size). */
  round?: number;
  /** How far the middle of each face swells out, metres. */
  bulge?: number;
  seg?: number;
  ring?: number;
}
/** How a log end looks: sawn flat, snapped into splinters, or a twig's tip. */
export type LogEnd = 'saw' | 'break' | 'taper';
export interface LogOpts {
  /** Radius at the top (+Y) end; default 0.85 r. */
  r2?: number;
  sides?: number;
  /** Rings along the length (default about one per 2.5 radii). */
  rows?: number;
  /** [bottom, top]; default both sawn. */
  ends?: [LogEnd, LogEnd];
  /** Total bend over the length, radians, in the direction `bendDir` (radians about Y; random if not given). */
  bend?: number;
  bendDir?: number;
  /** Bark lumpiness in metres (default 6 % of r). */
  gnarl?: number;
  /** 0..1 of the bark fallen away, showing bleached wood. */
  peel?: number;
  /** Number of cut branch stubs. */
  knots?: number;
  bark?: RGB;
  /** End-grain colour (default PAL.heartwood). */
  wood?: RGB;
  /** Bleached wood under peeled bark (default PAL.deadwood). */
  deadwood?: RGB;
}
export interface RockOpts {
  /** Subdivision 1..3 (80, 320, 1280 triangles). */
  detail?: number;
  /** Lumpiness 0..1. */
  rough?: number;
  /** 0 smooth boulder .. 1 faceted, broken rock. */
  facet?: number;
  /** Fraction of the radius buried / sliced flat at the bottom. */
  flat?: number;
  squash?: V3;
}

export class Builder {
  readonly rng: Rng;
  private all: Part[] = [];
  private groups: Group[] = [];
  private stack: Group[] = [];
  private anchors: Anchor[] = [];
  private emitters: Emitter[] = [];
  private lights: LightDef[] = [];
  private named: Group[] = [];
  private inkNow: Paint = { color: PAL.plasticGrey, mat: MAT.PLASTIC };
  private seedCounter = 0;
  constructor(readonly seed = 0) {
    this.rng = new Rng(hash32(seed, 0x51ed));
  }

  // --- internals used by Part / Group ---
  _nextSeed(): number {
    return hash32(this.seed, 0xabc, this.seedCounter++);
  }
  _register(p: Part, painted = false): void {
    this.all.push(p);
    for (const g of this.stack) g.parts.push(p);
    const owner = [...this.stack].reverse().find((g) => g.name !== null);
    p.owner = owner ? owner.name : p.owner;
    if (!painted) p.paint(this.inkNow);
  }
  _inGroup(g: Group, fn: () => void): void {
    this.stack.push(g);
    try {
      fn();
    } finally {
      this.stack.pop();
    }
  }
  _adopt(g: Group): void {
    this.groups.push(g);
    for (const s of this.stack) {
      // parts were pushed by _register; anchors and friends need to follow the outer groups too
      for (const a of g.anchors) if (!s.anchors.includes(a)) s.anchors.push(a);
      for (const e of g.emitters) if (!s.emitters.includes(e)) s.emitters.push(e);
      for (const l of g.lights) if (!s.lights.includes(l)) s.lights.push(l);
    }
  }
  _anchor(a: Anchor): Anchor { this.anchors.push(a); return a; }
  _emitter(e: Emitter): Emitter { this.emitters.push(e); return e; }
  _light(l: LightDef): LightDef { this.lights.push(l); return l; }

  // --- state ---
  /** Set the paint every following primitive is made with. Returns the previous ink. */
  ink(o: Paint): Paint {
    const prev = this.inkNow;
    this.inkNow = { ...o };
    return prev;
  }
  /** Everything made inside fn becomes one group that can be moved, turned, cloned and mirrored. */
  group(fn: () => void): Group {
    const g = new Group(this, null);
    this._inGroup(g, fn);
    this._adopt(g);
    return g;
  }
  /**
   * Everything made inside fn becomes the named part `name` of the ModelDef: a separate geometry
   * the game can move (door, lid, crank). `pivot` is the hinge point in model space. For lids and
   * doors give the hinge: `axis` (default +X) and `open`, the angle in radians about that axis
   * that opens it fully (right-handed; a lid hinged along its back edge opens with a negative
   * angle about +X). The props system then opens it with setOpen(id, 0..1).
   */
  part(name: string, fn: () => void, pivot: V3 = [0, 0, 0], hinge: { axis?: V3; open?: number } = {}): Group {
    const g = new Group(this, name);
    g.pivot.set(pivot[0], pivot[1], pivot[2]);
    if (hinge.axis) g.axis.set(hinge.axis[0], hinge.axis[1], hinge.axis[2]).normalize();
    g.openAngle = hinge.open ?? 0;
    this._inGroup(g, fn);
    for (const e of g.emitters) e.part = name;
    for (const l of g.lights) l.part = name;
    this._adopt(g);
    this.named.push(g);
    return g;
  }
  /** A named point: where a hand grips, where a lid hinges, where loot lies. */
  anchor(name: string, at: V3, yaw = 0, extra: Record<string, unknown> = {}): Anchor {
    const a: Anchor = { ...extra, name, position: new THREE.Vector3(at[0], at[1], at[2]), yaw };
    for (const g of this.stack) g.anchors.push(a);
    return this._anchor(a);
  }
  /** Where an effect comes out. The fx systems read these from placed props. */
  emitter(type: EmitterType, at: V3, extra: { name?: string; dir?: V3; size?: number; [k: string]: unknown } = {}): Emitter {
    const { dir, size, ...rest } = extra;
    const e: Emitter = { ...rest, type, position: new THREE.Vector3(at[0], at[1], at[2]), dir: new THREE.Vector3(...(dir ?? [0, 1, 0])).normalize(), size: size ?? 0.2 };
    for (const g of this.stack) g.emitters.push(e);
    return this._emitter(e);
  }
  /** A point light the model owns (a lamp). Fire light belongs to a 'fire' emitter instead. */
  light(at: V3, o: { name?: string; color?: RGB; intensity?: number; range?: number; flicker?: number; castShadow?: boolean } = {}): LightDef {
    const l: LightDef = { name: o.name, position: new THREE.Vector3(at[0], at[1], at[2]), color: o.color ?? PAL.lampWarm, intensity: o.intensity ?? 8, range: o.range ?? 8, flicker: o.flicker ?? 0, castShadow: o.castShadow ?? false };
    for (const g of this.stack) g.lights.push(l);
    return this._light(l);
  }

  // --- primitives ---

  /**
   * A prism: polygon `poly` in the XZ plane (pairs [x, z], any winding) extruded `h` along Y,
   * centred on y = 0. Polygon corners get `bevel` (seg steps), the top and bottom rims `capBevel`
   * (default = bevel). rows > 1 adds loops along Y so the part can bend.
   */
  extrude(poly: readonly P2[], h: number, o: ExtrudeOpts = {}): Part {
    const part = new Part(this);
    // Work in (u, v) = (x, -z): counter-clockwise there is outward-facing here.
    const pts = ccw(poly.map((q) => [q[0], -q[1]] as P2));
    const bevel = o.bevel ?? 0;
    const cb = Math.min(o.capBevel ?? bevel, h * 0.45);
    const runs = outline2(pts, true, bevel, o.seg ?? 1, o.crease, o.smooth);
    const top = o.top ?? true, bottom = o.bottom ?? true;
    const y0 = -h / 2 + (bottom ? cb : 0), y1 = h / 2 - (top ? cb : 0);
    const rows = Math.max(1, o.rows ?? 1);
    for (const run of runs) {
      // walls
      const cols: number[][] = [];
      for (const v of run) {
        const col: number[] = [];
        for (let r = 0; r <= rows; r++) col.push(part.vert(v.x, y0 + ((y1 - y0) * r) / rows, -v.y, v.nx, 0, -v.ny, v.e));
        cols.push(col);
      }
      for (let i = 0; i + 1 < cols.length; i++) for (let r = 0; r < rows; r++) part.quad(cols[i][r], cols[i + 1][r], cols[i + 1][r + 1], cols[i][r + 1]);
      // rim bevels
      for (const [on, yw, yc, ny] of [[top, y1, h / 2, 1], [bottom, y0, -h / 2, -1]] as [boolean, number, number, number][]) {
        if (!on || cb <= 0) continue;
        const lo: number[] = [], hi: number[] = [];
        for (const v of run) {
          lo.push(part.vert(v.x, yw, -v.y, v.nx, 0, -v.ny, 1));
          hi.push(part.vert(v.x - v.ix * cb, yc, -(v.y - v.iy * cb), 0, ny, 0, 1));
        }
        for (let i = 0; i + 1 < lo.length; i++) part.quad(lo[i], lo[i + 1], hi[i + 1], hi[i]);
      }
    }
    for (const [on, yc, ny] of [[top, h / 2, 1], [bottom, -h / 2, -1]] as [boolean, number, number][]) {
      if (!on) continue;
      const cap = capFromRuns(runs, cb);
      const ids = cap.pts.map((q) => part.vert(q[0], yc, -q[1], 0, ny, 0, 0));
      for (const t of cap.tris) part.tri(ids[t[0]], ids[t[1]], ids[t[2]]);
    }
    return part.finish();
  }

  /** A box w (X) by h (Y) by d (Z), centred, every edge bevelled. The workhorse. */
  box(w: number, h: number, d: number, o: BoxOpts = {}): Part {
    const bevel = Math.min(o.bevel ?? Math.min(w, h, d) * 0.06, Math.min(w, h, d) * 0.45);
    return this.extrude([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]], h, { bevel, seg: o.seg ?? 1, top: o.top, bottom: o.bottom, rows: o.rows });
  }

  /**
   * A sawn board: length along Y, width along X, thickness along Z. Slightly irregular (cup, bow,
   * uneven ends) unless `true` is passed for `straight`.
   */
  plank(len: number, w: number, t: number, o: { bevel?: number; rows?: number; straight?: boolean } = {}): Part {
    const rows = o.rows ?? (o.straight ? 1 : 3);
    const p = this.box(w, len, t, { bevel: o.bevel ?? Math.min(0.004, t * 0.25), rows });
    if (!o.straight) {
      const r = this.rng;
      const bow = r.range(-1, 1) * 0.004 * len, cup = r.range(-1, 1) * 0.02, tw = r.range(-1, 1) * 0.012 * len;
      const e0 = r.range(-0.006, 0.006), e1 = r.range(-0.006, 0.006);
      p.warp((q) => {
        const u = q.y / len; // -0.5..0.5
        q.z += bow * (1 - 4 * u * u) + cup * q.x * q.x * (1 / Math.max(w, 1e-3));
        const a = tw * u;
        const x = q.x * Math.cos(a) - q.z * Math.sin(a);
        q.z = q.x * Math.sin(a) + q.z * Math.cos(a);
        q.x = x;
        q.y += (u > 0 ? e1 : e0) * (q.x / w) * 2 * Math.min(1, Math.abs(u) * 4);
      });
    }
    return p;
  }

  /** A solid of revolution about Y from a profile of [radius, y] points, bottom to top (outside on the right). */
  lathe(profile: readonly P2[], o: LatheOpts = {}): Part {
    const part = new Part(this);
    const sides = Math.max(o.arc ? 1 : 3, o.sides ?? 16);
    const pts = o.closed ? ccw(profile) : profile;
    const runs = outline2(pts, !!o.closed, o.bevel ?? 0, o.seg ?? 1, o.crease, o.smooth);
    const a0 = o.arc ? o.arc[0] : 0, span = o.arc ? o.arc[1] - o.arc[0] : Math.PI * 2;
    const ringN = o.arc ? sides + 1 : sides;
    for (const run of runs) {
      const rings: number[][] = [];
      for (const v of run) {
        const ring: number[] = [];
        for (let s = 0; s < ringN; s++) {
          const a = a0 + (s / sides) * span;
          const c = Math.cos(a), sn = Math.sin(a);
          ring.push(part.vert(v.x * c, v.y, v.x * sn, v.nx * c, v.ny, v.nx * sn, v.e));
        }
        rings.push(ring);
      }
      for (let i = 0; i + 1 < rings.length; i++) for (let s = 0; s < sides; s++) {
        const t = (s + 1) % ringN;
        part.quad(rings[i][s], rings[i][t], rings[i + 1][t], rings[i + 1][s]);
      }
    }
    return part.finish();
  }

  /** A cylinder along Y, radius r (r2 at the top if given), with bevelled rims. */
  cyl(r: number, h: number, o: CylOpts & { r2?: number } = {}): Part {
    const r2 = o.r2 ?? r;
    const bevel = o.bevel ?? Math.min(r, h) * 0.08;
    const prof: P2[] = [];
    if (o.bottom ?? true) prof.push([0, -h / 2]);
    prof.push([r, -h / 2]);
    const rows = Math.max(1, o.rows ?? 1);
    for (let i = 1; i < rows; i++) prof.push([r + ((r2 - r) * i) / rows, -h / 2 + (h * i) / rows]);
    prof.push([r2, h / 2]);
    if ((o.top ?? true) && r2 > 1e-6) prof.push([0, h / 2]);
    return this.lathe(prof, { sides: o.sides ?? 16, bevel, seg: o.seg ?? 1, crease: 20 * DEG });
  }
  cone(r: number, h: number, o: CylOpts = {}): Part {
    return this.cyl(r, h, { ...o, r2: 0 });
  }
  /** A hollow pipe along Y: outer radius ro, inner ri. Open ends show the wall. */
  tube(ro: number, ri: number, h: number, o: { sides?: number; bevel?: number } = {}): Part {
    return this.lathe([[ro, -h / 2], [ro, h / 2], [ri, h / 2], [ri, -h / 2]], { sides: o.sides ?? 16, bevel: o.bevel ?? (ro - ri) * 0.25, closed: true });
  }
  /** A sphere (or with r as [rx, ry, rz], an ellipsoid). */
  sphere(r: number | V3, o: { sides?: number; rings?: number } = {}): Part {
    const rings = o.rings ?? 8;
    const prof: P2[] = [];
    for (let i = 0; i <= rings; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / rings;
      prof.push([Math.max(0, Math.cos(a)), Math.sin(a)]);
    }
    const p = this.lathe(prof, { sides: o.sides ?? 12, smooth: true });
    for (let i = 0; i < p.n.length; i++) p.n[i] = p.p[i];
    // paint captured unit-sphere detail: rescale it with the shape
    const s = typeof r === 'number' ? [r, r, r] : r;
    p.apply(_m.makeScale(s[0], s[1], s[2]));
    for (let i = 0; i < p.d.length; i += 3) { p.d[i] *= s[0]; p.d[i + 1] *= s[1]; p.d[i + 2] *= s[2]; }
    return p;
  }
  /** A capsule along Y: total height h, radius r. */
  capsule(r: number, h: number, o: { sides?: number; rings?: number } = {}): Part {
    const rings = o.rings ?? 4;
    const prof: P2[] = [];
    const half = Math.max(0, h / 2 - r);
    for (let i = 0; i <= rings; i++) {
      const a = -Math.PI / 2 + ((Math.PI / 2) * i) / rings;
      prof.push([Math.max(0, Math.cos(a)) * r, Math.sin(a) * r - half]);
    }
    for (let i = 0; i <= rings; i++) {
      const a = ((Math.PI / 2) * i) / rings;
      prof.push([Math.max(0, Math.cos(a)) * r, Math.sin(a) * r + half]);
    }
    return this.lathe(prof, { sides: o.sides ?? 12, smooth: true });
  }
  /** A low dome: rivet heads, bolt caps, buttons. Base on y = 0, bulging toward +Y. */
  dome(r: number, h = r * 0.5, sides = 6): Part {
    return this.lathe([[r, 0], [r * 0.7, h * 0.75], [0, h]], { sides, smooth: true });
  }

  /**
   * A soft box w x h x d, centred: edges rounded with radius `round`, every face bulging out by
   * `bulge` metres at its centre. Bags, cushions, seat pads, sandbags, mattresses, soft cases.
   * `seg` grid steps across the flat middle of a face (default 3), `ring` steps per half of a
   * rounded edge (default 2). Smooth shaded and welded, so crumple() and dent() never open it.
   */
  pillow(w: number, h: number, d: number, o: PillowOpts = {}): Part {
    const part = new Part(this);
    const half = [w / 2, h / 2, d / 2];
    const r = Math.min(o.round ?? Math.min(w, h, d) * 0.2, half[0] * 0.98, half[1] * 0.98, half[2] * 0.98);
    const hi = half.map((x) => x - r);
    const bulge = o.bulge ?? 0;
    const seg = Math.max(1, o.seg ?? 3), ring = Math.max(1, o.ring ?? 2);
    // coordinates across a face: equal angle steps over the rounded border, even steps in the middle
    const axis = (k: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < ring; i++) out.push(-(hi[k] + r * Math.tan((Math.PI / 4) * (1 - i / ring))));
      for (let i = 0; i <= seg; i++) out.push(-hi[k] + (2 * hi[k] * i) / seg);
      for (let i = ring - 1; i >= 0; i--) out.push(hi[k] + r * Math.tan((Math.PI / 4) * (1 - i / ring)));
      return out;
    };
    const A = [axis(0), axis(1), axis(2)];
    const ids = new Map<string, number>();
    const p = [0, 0, 0], q = [0, 0, 0];
    for (let k = 0; k < 3; k++) for (const s of [-1, 1]) {
      const u = (k + 1) % 3, v = (k + 2) % 3;
      const grid: number[][] = [];
      for (let i = 0; i < A[u].length; i++) {
        const row: number[] = [];
        for (let j = 0; j < A[v].length; j++) {
          p[k] = s * half[k]; p[u] = A[u][i]; p[v] = A[v][j];
          for (let c = 0; c < 3; c++) q[c] = Math.max(-hi[c], Math.min(hi[c], p[c]));
          let nx = p[0] - q[0], ny = p[1] - q[1], nz = p[2] - q[2];
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
          const fu = Math.max(0, 1 - (p[u] / half[u]) ** 2), fv = Math.max(0, 1 - (p[v] / half[v]) ** 2);
          const bl = bulge * fu * fv;
          const x = q[0] + nx * r + (k === 0 ? s * bl : 0), y = q[1] + ny * r + (k === 1 ? s * bl : 0), z = q[2] + nz * r + (k === 2 ? s * bl : 0);
          const key = Math.round(x * 1e5) + ',' + Math.round(y * 1e5) + ',' + Math.round(z * 1e5);
          let id = ids.get(key);
          if (id === undefined) {
            id = part.vert(x, y, z, nx, ny, nz, sat((1 - Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz))) * 3.5));
            ids.set(key, id);
          }
          row.push(id);
        }
        grid.push(row);
      }
      for (let i = 0; i + 1 < grid.length; i++) for (let j = 0; j + 1 < grid[i].length; j++) part.quad(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
    }
    part.recalcNormals(0.25);
    return part.finish();
  }

  /**
   * A log, branch or stick along Y, centred: bark round the sides (MAT.BARK), end grain with its
   * rings round the heart on the ends (MAT.WOOD). Radius r at the bottom, o.r2 at the top. Bent,
   * lumpy, peeled and broken by the options; randomness from b.rng. Paints with the current ink's
   * wear and snow; bark and wood colours from the options.
   */
  log(len: number, r: number, o: LogOpts = {}): Part {
    const rng = this.rng;
    const r2 = o.r2 ?? r * 0.85;
    const sides = o.sides ?? Math.max(5, Math.min(14, Math.round(r * 80 + 5)));
    const rows = o.rows ?? Math.max(1, Math.round(len / Math.max(0.05, r * 2.5)));
    const ends = o.ends ?? ['saw', 'saw'];
    const bark = o.bark ?? PAL.bark, wood = o.wood ?? PAL.heartwood, dead = o.deadwood ?? PAL.deadwood;
    const seed = this._nextSeed();
    const prev = this.ink({ ...this.inkNow, mat: MAT.BARK, color: bark, pith: [0, 0], grain: 'y', detailScale: 1 });
    const p = this.cyl(r, len, { r2, sides, rows, bevel: Math.min(Math.min(r, r2) * 0.15, 0.006) });
    this.ink(prev);
    const half = len / 2;
    // ends: sawn flat (rings), broken (splinters), or a twig tip
    p.each((v) => {
      if (Math.abs(v.ny) < 0.7) return;
      v.mat = MAT.WOOD;
      const rr = Math.hypot(v.x, v.z) / Math.max(1e-4, v.y > 0 ? r2 : r);
      const c = mixRGB(wood, dead, 0.35 + 0.4 * rr);
      v.r = c[0]; v.g = c[1]; v.b = c[2];
    });
    const peel = o.peel ?? 0, gnarl = o.gnarl ?? r * 0.06;
    // Peeling: the material bares the wood where bark wear (as stored: wear * (0.4 + edge)) is
    // above 0.35, in ragged patches of its own. Here only how much, varying along the log.
    if (peel > 0) p.each((v) => {
      if (v.mat !== MAT.BARK) return;
      const n = fbm3(seed + 3, v.x * 5, v.y * 1.2, v.z * 5, 2) * 0.5 + 0.5;
      const loss = sat(peel * (0.35 + 1.3 * n));
      v.wear = Math.max(v.wear, (0.35 + 0.65 * loss) / (0.4 + v.edge));
    });
    p.warp((q) => {
      const rad = Math.hypot(q.x, q.z);
      if (rad < 1e-6) return;
      const a = Math.atan2(q.z, q.x);
      // bark ridges along the log, lumps, the swelling where it met the ground or the trunk
      const k = 1 + (gnarl / Math.max(r, 1e-3)) * (fbm3(seed, Math.cos(a) * 2.2, q.y * 3.1, Math.sin(a) * 2.2, 3) + 0.35 * Math.sin(a * Math.max(5, sides) + q.y * 6));
      q.x *= k; q.z *= k;
    });
    for (const [end, sign] of [[ends[0], -1], [ends[1], 1]] as [LogEnd, number][]) {
      if (end === 'saw') continue;
      const R = sign > 0 ? r2 : r;
      p.warp((q) => {
        if (q.y * sign < half - R * 0.25 - 1e-4) return;
        const a = Math.atan2(q.z, q.x), rad = Math.hypot(q.x, q.z) / Math.max(R, 1e-4);
        if (end === 'break') {
          // splinters: the rim stands in ragged teeth, the heart pulls out further
          const tooth = 0.5 + 0.5 * noise3(seed + 11 + sign, Math.cos(a) * 3, Math.sin(a) * 3, 0);
          q.y += sign * R * (0.7 * tooth * rad + 0.55 * (1 - rad) * (0.3 + tooth));
        } else {
          // a twig tip: pinch to a point
          const t = Math.min(1, (q.y * sign - (half - R * 0.25)) / (R * 0.25 + 1e-4));
          q.x *= 1 - 0.8 * t; q.z *= 1 - 0.8 * t;
          q.y += sign * R * 1.5 * t;
        }
      });
    }
    if (o.bend) {
      const bd = o.bendDir ?? rng.range(0, Math.PI * 2);
      p.rotY(bd).bend(o.bend).rotY(-bd);
    }
    p.recalcNormals(0.5);
    p.refit();
    // branch stubs: a collar swelling out of the bark, narrowing to a weathered cut face
    const knots = o.knots ?? 0;
    for (let i = 0; i < knots; i++) {
      const y = rng.range(-half * 0.8, half * 0.8);
      const rr = r + (r2 - r) * ((y + half) / len);
      const kr = Math.max(0.004, rr * rng.range(0.09, 0.17));
      const a = rng.range(0, Math.PI * 2);
      // from half way into the log out past the bark, leaning toward the top end like the branch grew
      const up = rng.range(0.25, 0.7);
      const hc = 1 / Math.hypot(1, up); // horizontal share of the stub's direction
      const sIn = (rr * 0.5) / hc; // base to bark surface, along the stub
      const kl = sIn + kr * rng.range(1.2, 2.6);
      const y0 = -kl / 2, ys = y0 + sIn;
      const prevK = this.ink({ ...this.inkNow, mat: MAT.BARK, color: bark, pith: [0, 0], grain: 'y', detailScale: 1 });
      const stub = this.lathe([[0, y0], [kr * 2.1, y0], [kr * 2.0, ys - kr * 0.3], [kr * 1.2, ys + kr * 1.2], [kr, kl / 2], [0, kl / 2]], { sides: 7, bevel: kr * 0.2, crease: 40 * DEG });
      this.ink(prevK);
      const cut = mixRGB(dead, bark, 0.35);
      stub.each((v) => {
        if (v.ny > 0.7) { v.mat = MAT.WOOD; v.r = cut[0]; v.g = cut[1]; v.b = cut[2]; }
      });
      stub.crumple(kr * 0.12, 0.12 / Math.max(kr, 0.01));
      const d: V3 = [Math.cos(a) * hc, up * hc, Math.sin(a) * hc];
      const base: V3 = [Math.cos(a) * rr * 0.5, y, Math.sin(a) * rr * 0.5];
      stub.aim(d, [base[0] + (d[0] * kl) / 2, base[1] + (d[1] * kl) / 2, base[2] + (d[2] * kl) / 2]);
      p.merge(stub);
    }
    return p;
  }

  /**
   * Sweep a cross-section along a path. `profile` is a radius (round) or a closed polygon of
   * [x, y] points in the section plane (y toward `up`). Corners of the path are mitred; use
   * Path.fillet / Path.spline for bends.
   */
  sweep(profile: number | readonly P2[], path: readonly V3[], o: SweepOpts = {}): Part {
    const part = new Part(this);
    let runs: OV[][];
    if (typeof profile === 'number') {
      const sides = o.sides ?? 8;
      const pts: P2[] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        pts.push([Math.cos(a) * profile, Math.sin(a) * profile]);
      }
      runs = outline2(pts, true, 0, 1, undefined, true);
    } else runs = outline2(ccw(profile), true, o.bevel ?? 0, o.seg ?? 1, undefined, o.smooth);
    const closed = !!o.closed;
    const P = path.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
    const n = P.length;
    if (n < 2) return part.finish();
    const segN = closed ? n : n - 1;
    const T: THREE.Vector3[] = [];
    for (let s = 0; s < segN; s++) T.push(P[(s + 1) % n].clone().sub(P[s]).normalize());
    // parallel-transported frames per segment
    const up = new THREE.Vector3(...(o.up ?? [0, 1, 0]));
    if (Math.abs(up.dot(T[0])) > 0.98) up.set(1, 0, 0);
    const Y: THREE.Vector3[] = [up.clone().addScaledVector(T[0], -up.dot(T[0])).normalize()];
    const qrot = new THREE.Quaternion();
    for (let s = 1; s < segN; s++) {
      qrot.setFromUnitVectors(T[s - 1], T[s]);
      Y.push(Y[s - 1].clone().applyQuaternion(qrot).addScaledVector(T[s], 0).normalize());
    }
    const X = Y.map((y, s) => y.clone().cross(T[s]).normalize());
    const ringCount = closed ? n : n;
    // per path point: plane normal (mitre) and the segment whose frame is projected onto it
    const lens: number[] = [0];
    for (let i = 1; i < n; i++) lens.push(lens[i - 1] + P[i].distanceTo(P[i - 1]));
    const total = lens[n - 1] || 1;
    const rings: number[][][] = []; // [point][run][vertex]
    const tmp = new THREE.Vector3(), nrm = new THREE.Vector3(), mit = new THREE.Vector3();
    for (let i = 0; i < ringCount; i++) {
      const sIn = closed ? (i - 1 + segN) % segN : Math.max(0, i - 1);
      const sOut = closed ? i % segN : Math.min(segN - 1, i);
      mit.copy(T[sIn]).add(T[sOut]).normalize();
      const t = lens[i] / total;
      const sc = o.scale ? o.scale(t) : 1;
      const sx = typeof sc === 'number' ? sc : sc[0], sy = typeof sc === 'number' ? sc : sc[1];
      const tw = o.twist ? o.twist(t) : 0;
      const cs = Math.cos(tw), sn = Math.sin(tw);
      const denom = T[sIn].dot(mit) || 1;
      const ring: number[][] = [];
      for (const run of runs) {
        const ids: number[] = [];
        for (const v of run) {
          const px = (v.x * cs - v.y * sn) * sx, py = (v.x * sn + v.y * cs) * sy;
          const nx = v.nx * cs - v.ny * sn, ny = v.nx * sn + v.ny * cs;
          // offset in the incoming frame, slid along the incoming tangent onto the mitre plane
          nrm.copy(Y[sIn]).add(Y[sOut]).multiplyScalar(ny).addScaledVector(X[sIn], nx).addScaledVector(X[sOut], nx).normalize();
          tmp.copy(X[sIn]).multiplyScalar(px).addScaledVector(Y[sIn], py);
          tmp.addScaledVector(T[sIn], -tmp.dot(mit) / denom).add(P[i]);
          ids.push(part.vert(tmp.x, tmp.y, tmp.z, nrm.x, nrm.y, nrm.z, v.e));
        }
        ring.push(ids);
      }
      rings.push(ring);
    }
    const last = closed ? ringCount : ringCount - 1;
    for (let i = 0; i < last; i++) {
      const a = rings[i], b = rings[(i + 1) % ringCount];
      for (let r = 0; r < runs.length; r++) for (let k = 0; k + 1 < a[r].length; k++) part.quad(a[r][k], a[r][k + 1], b[r][k + 1], b[r][k]);
    }
    if (!closed && (o.caps ?? true)) {
      const cap = capFromRuns(runs, 0);
      for (const [i, s, sign] of [[0, 0, -1], [n - 1, segN - 1, 1]] as [number, number, number][]) {
        const t = lens[i] / total;
        const sc = o.scale ? o.scale(t) : 1;
        const sx = typeof sc === 'number' ? sc : sc[0], sy = typeof sc === 'number' ? sc : sc[1];
        if (Math.abs(sx) < 1e-6 || Math.abs(sy) < 1e-6) continue;
        const tw = o.twist ? o.twist(t) : 0;
        const cs = Math.cos(tw), sn = Math.sin(tw);
        const ids = cap.pts.map((q) => {
          const px = (q[0] * cs - q[1] * sn) * sx, py = (q[0] * sn + q[1] * cs) * sy;
          tmp.copy(X[s]).multiplyScalar(px).addScaledVector(Y[s], py).add(P[i]);
          return part.vert(tmp.x, tmp.y, tmp.z, T[s].x * sign, T[s].y * sign, T[s].z * sign, 0);
        });
        for (const tr of cap.tris) part.tri(ids[tr[0]], ids[tr[1]], ids[tr[2]]);
      }
    }
    return part.finish();
  }
  /** A round pipe or rod along a path. */
  pipe(path: readonly V3[], r: number, o: SweepOpts = {}): Part {
    return this.sweep(r, path, { sides: 8, ...o });
  }
  /** A cable hanging from a to b, dropping `sag` metres at mid-span. */
  cable(a: V3, b: V3, sag: number, r = 0.006, o: { segs?: number; sides?: number } = {}): Part {
    return this.sweep(r, Path.catenary(a, b, sag, o.segs ?? 10), { sides: o.sides ?? 5 }).ghost();
  }
  /** A flat strap, belt or band along a path: width w (across), thickness t. `up` is the strap's face normal at the start. */
  strap(path: readonly V3[], w: number, t: number, o: SweepOpts = {}): Part {
    return this.sweep([[-w / 2, -t / 2], [w / 2, -t / 2], [w / 2, t / 2], [-w / 2, t / 2]], path, { bevel: t * 0.3, ...o });
  }
  /** A ring / torus in the XZ plane: ring radius R, tube radius r. */
  torus(R: number, r: number, o: { sides?: number; segs?: number } = {}): Part {
    const segs = o.segs ?? 16;
    const path: V3[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      path.push([Math.cos(a) * R, 0, Math.sin(a) * R]);
    }
    return this.sweep(r, path, { sides: o.sides ?? 6, closed: true, up: [0, 1, 0] });
  }

  /**
   * A cloth sheet hanging in the XY plane (w across X, h down Y, top edge at y = 0), both faces.
   * Sags, wrinkles and has a torn edge. Pin it and make it blow with part.sway().
   */
  cloth(w: number, h: number, o: ClothOpts = {}): Part {
    const part = new Part(this);
    const nx = o.nx ?? Math.max(2, Math.round(w / 0.06)), ny = o.ny ?? Math.max(2, Math.round(h / 0.06));
    const seed = this._nextSeed();
    const tear = o.tear ?? 0, th = (o.thickness ?? 0.002) / 2;
    const edges = o.tearEdges ?? ['bottom'];
    const billow = o.billow ?? 0, wr = o.wrinkle ?? Math.min(w, h) * 0.02;
    const px: number[] = [], py: number[] = [], pz: number[] = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const u = i / nx, v = j / ny;
      let x = (u - 0.5) * w, y = -v * h;
      // ragged edges: pull the outline in by noise
      if (tear > 0) {
        const rag = (t: number, k: number) => tear * (0.5 + 0.5 * noise3(seed + k, t * 9, k, 0)) * (0.35 + 0.65 * Math.abs(noise3(seed + k + 5, t * 23, 0, k)));
        if (edges.includes('bottom')) y += rag(u, 1) * h * 0.45 * sstep(0.45, 1, v);
        if (edges.includes('top')) y -= rag(u, 2) * h * 0.45 * sstep(0.55, 0, v);
        if (edges.includes('right')) x -= rag(v, 3) * w * 0.45 * sstep(0.45, 1, u);
        if (edges.includes('left')) x += rag(v, 4) * w * 0.45 * sstep(0.55, 0, u);
      }
      const z = billow * Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v * 1.2)) + wr * fbm3(seed, x * 5, y * 5, 0, 3) * (0.3 + 0.7 * v);
      px.push(x); py.push(y); pz.push(z);
    }
    // normals from the grid
    const N: number[] = [];
    const at = (i: number, j: number) => Math.min(ny, Math.max(0, j)) * (nx + 1) + Math.min(nx, Math.max(0, i));
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const a = at(i - 1, j), b = at(i + 1, j), c = at(i, j - 1), d = at(i, j + 1);
      const ux = px[b] - px[a], uy = py[b] - py[a], uz = pz[b] - pz[a];
      const vx = px[d] - px[c], vy = py[d] - py[c], vz = pz[d] - pz[c];
      // u runs +X, v runs -Y: v x u faces +Z
      let gx = vy * uz - vz * uy, gy = vz * ux - vx * uz, gz = vx * uy - vy * ux;
      const l = Math.hypot(gx, gy, gz) || 1;
      gx /= l; gy /= l; gz /= l;
      N.push(gx, gy, gz);
    }
    const front: number[] = [], back: number[] = [];
    for (let k = 0; k < px.length; k++) {
      const gx = N[k * 3], gy = N[k * 3 + 1], gz = N[k * 3 + 2];
      front.push(part.vert(px[k] + gx * th, py[k] + gy * th, pz[k] + gz * th, gx, gy, gz, 0));
      back.push(part.vert(px[k] - gx * th, py[k] - gy * th, pz[k] - gz * th, -gx, -gy, -gz, 0));
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      // holes near ragged edges
      if (tear > 0) {
        const u = (i + 0.5) / nx, v = (j + 0.5) / ny;
        let near = 0;
        if (edges.includes('bottom')) near = Math.max(near, sstep(0.6, 1, v));
        if (edges.includes('top')) near = Math.max(near, sstep(0.4, 0, v));
        if (edges.includes('right')) near = Math.max(near, sstep(0.6, 1, u));
        if (edges.includes('left')) near = Math.max(near, sstep(0.4, 0, u));
        if (near * tear * 0.9 > 0.5 + 0.5 * noise3(seed + 9, u * 11, v * 11, 3)) continue;
      }
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      part.quad(front[a], front[b], front[c], front[d]);
      part.quad(back[a], back[b], back[c], back[d]);
    }
    part.occluder = false;
    return part.finish();
  }

  /** A rock, boulder or lump: a displaced, optionally faceted, geodesic sphere of radius r. */
  rock(r: number, o: RockOpts = {}): Part {
    const part = new Part(this);
    const seed = this._nextSeed();
    const detail = Math.max(0, Math.min(3, o.detail ?? 2));
    // icosahedron
    const t = (1 + Math.sqrt(5)) / 2;
    let V: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    V = V.map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
    let F: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let d = 0; d < detail; d++) {
      const mid = new Map<number, number>();
      const m = (a: number, b: number) => {
        const key = a < b ? a * 65536 + b : b * 65536 + a;
        let id = mid.get(key);
        if (id === undefined) {
          const v = [V[a][0] + V[b][0], V[a][1] + V[b][1], V[a][2] + V[b][2]];
          const l = Math.hypot(v[0], v[1], v[2]);
          id = V.push([v[0] / l, v[1] / l, v[2] / l]) - 1;
          mid.set(key, id);
        }
        return id;
      };
      const G: number[][] = [];
      for (const [a, b, c] of F) {
        const ab = m(a, b), bc = m(b, c), ca = m(c, a);
        G.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
      }
      F = G;
    }
    const rough = o.rough ?? 0.5, sq = o.squash ?? [1, 0.75, 1], flat = o.flat ?? 0.25;
    const pos = V.map((v) => {
      const big = fbm3(seed, v[0] * 1.1, v[1] * 1.1, v[2] * 1.1, 2);
      const med = fbm3(seed + 7, v[0] * 2.7, v[1] * 2.7, v[2] * 2.7, 3);
      // ridged term gives broken, planar faces
      const rid = 1 - Math.abs(noise3(seed + 13, v[0] * 1.9, v[1] * 1.9, v[2] * 1.9));
      const k = r * (1 + rough * (0.34 * big + 0.16 * med + 0.22 * (rid - 0.6)));
      let y = v[1] * k * sq[1];
      const floor = -r * sq[1] * (1 - flat);
      if (y < floor) y = floor + (y - floor) * 0.08;
      return [v[0] * k * sq[0], y - floor, v[2] * k * sq[2]];
    });
    const facet = o.facet ?? 0.35;
    // smooth normals
    const acc = pos.map(() => [0, 0, 0]);
    const fn: number[][] = [];
    for (const [a, b, c] of F) {
      const ux = pos[b][0] - pos[a][0], uy = pos[b][1] - pos[a][1], uz = pos[b][2] - pos[a][2];
      const vx = pos[c][0] - pos[a][0], vy = pos[c][1] - pos[a][1], vz = pos[c][2] - pos[a][2];
      const g = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      fn.push(g);
      for (const i of [a, b, c]) { acc[i][0] += g[0]; acc[i][1] += g[1]; acc[i][2] += g[2]; }
    }
    const nrm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    if (facet <= 0.01) {
      const ids = pos.map((p, i) => { const s = nrm(acc[i]); return part.vert(p[0], p[1], p[2], s[0], s[1], s[2], 0); });
      for (const [a, b, c] of F) part.idx.push(ids[a], ids[b], ids[c]);
    } else {
      F.forEach(([a, b, c], f) => {
        const g = nrm(fn[f]);
        const ids = [a, b, c].map((i) => {
          const s = nrm(acc[i]);
          const m = nrm([s[0] + (g[0] - s[0]) * facet, s[1] + (g[1] - s[1]) * facet, s[2] + (g[2] - s[2]) * facet]);
          return part.vert(pos[i][0], pos[i][1], pos[i][2], m[0], m[1], m[2], 0);
        });
        part.idx.push(ids[0], ids[1], ids[2]);
      });
    }
    return part.finish();
  }

  /**
   * A raw mesh: points and faces (triangles or convex polygons, counter-clockwise from outside).
   * Flat shaded unless `smooth`.
   */
  mesh(points: readonly V3[], faces: readonly (readonly number[])[], smooth = false): Part {
    const part = new Part(this);
    if (smooth) {
      for (const p of points) part.vert(p[0], p[1], p[2], 0, 1, 0, 0);
      for (const f of faces) for (let i = 1; i + 1 < f.length; i++) part.idx.push(f[0], f[i], f[i + 1]);
      part.recalcNormals();
    } else {
      for (const f of faces) {
        const a = points[f[0]], b = points[f[1]], c = points[f[2]];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        let gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
        const l = Math.hypot(gx, gy, gz) || 1;
        gx /= l; gy /= l; gz /= l;
        const ids = f.map((i) => part.vert(points[i][0], points[i][1], points[i][2], gx, gy, gz, 0));
        for (let i = 1; i + 1 < ids.length; i++) part.idx.push(ids[0], ids[i], ids[i + 1]);
      }
    }
    return part.finish();
  }

  /**
   * Stencilled lettering: flat paint strokes in the XY plane facing +Z, baseline on y = 0, letter
   * height h. Painted with the current ink: on timber use mat WOOD and a dark colour so the grain
   * shows through the paint; on steel MAT.PAINT. Place it 1 to 2 mm proud of the surface it is
   * painted on. A-Z, 0-9, space and - . / ^ (an up arrow). Strokes stop short of each other at the
   * joints, as a real stencil does.
   */
  stencil(text: string, h: number, o: { weight?: number; spacing?: number; align?: 'left' | 'center' | 'right' } = {}): Part {
    const part = new Part(this);
    const u = h / 6, w = (o.weight ?? 0.15) * h, adv = (4 + (o.spacing ?? 1.7)) * u;
    const chars = text.toUpperCase().split('');
    const total = chars.length * adv - (o.spacing ?? 1.7) * u;
    let x0 = o.align === 'center' ? -total / 2 : o.align === 'right' ? -total : 0;
    for (const ch of chars) {
      for (const stroke of GLYPHS[ch] ?? []) {
        const pts = stroke.split(' ').map(Number);
        for (let i = 0; i + 3 < pts.length; i += 2) {
          const ax = x0 + pts[i] * u, ay = pts[i + 1] * u, bx = x0 + pts[i + 2] * u, by = pts[i + 3] * u;
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 1e-6) continue;
          const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy * (w / 2), ny = dx * (w / 2);
          const e = w * 0.2; // reach a little past the point, short of the next stroke
          const a = part.vert(ax - dx * e + nx, ay - dy * e + ny, 0, 0, 0, 1);
          const b2 = part.vert(bx + dx * e + nx, by + dy * e + ny, 0, 0, 0, 1);
          const c = part.vert(bx + dx * e - nx, by + dy * e - ny, 0, 0, 0, 1);
          const d = part.vert(ax - dx * e - nx, ay - dy * e - ny, 0, 0, 0, 1);
          part.quad(a, b2, c, d);
        }
      }
      x0 += adv;
    }
    part.occluder = false;
    return part.finish();
  }

  /** Edit every vertex of every part made so far: weathering passes over the whole model (grime from the ground, soot from a fire). */
  each(fn: (v: VertexRef, part: Part) => void): this {
    for (const p of this.all) if (!p.removed) p.each((v) => fn(v, p));
    return this;
  }

  /** Copies of a part or group: fn places copy i (0 is the original). */
  array<T extends Part | Group>(src: T, count: number, fn: (copy: T, i: number) => void): T[] {
    const out: T[] = [src];
    for (let i = 1; i < count; i++) out.push(src.clone() as T);
    out.forEach((c, i) => fn(c, i));
    return out;
  }

  // --- build ---

  build(o: BuildOpts = {}): ModelDef {
    const parts = this.all.filter((p) => !p.removed && p.idx.length > 0);
    const bounds = new THREE.Box3();
    for (const p of parts) bounds.union(p.bounds());
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(), new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const R = o.aoRadius ?? Math.min(0.3, Math.max(0.04, 0.12 * Math.max(size.x, size.y, size.z)));
    const aoK = o.ao ?? 1;
    const ground = o.ground ?? true;

    // occluder proxies: a box in each part's own frame
    const occ = parts.map((p) => {
      const inv = new THREE.Matrix4().copy(p.xf).invert();
      const wb = p.bounds();
      const ext = p.lbox.getSize(new THREE.Vector3());
      // paper-thin and tiny parts make poor occluders
      const solid = p.occluder && Math.max(ext.x, ext.y, ext.z) > 0.015 && Number.isFinite(inv.elements[0]);
      return { inv: inv.elements, lo: p.lbox.min, hi: p.lbox.max, wb, solid };
    });
    const inside = (k: number, x: number, y: number, z: number, pad: number): boolean => {
      const m = occ[k].inv, lo = occ[k].lo, hi = occ[k].hi;
      const lx = m[0] * x + m[4] * y + m[8] * z + m[12];
      if (lx < lo.x - pad || lx > hi.x + pad) return false;
      const ly = m[1] * x + m[5] * y + m[9] * z + m[13];
      if (ly < lo.y - pad || ly > hi.y + pad) return false;
      const lz = m[2] * x + m[6] * y + m[10] * z + m[14];
      return lz >= lo.z - pad && lz <= hi.z + pad;
    };
    // ray (origin, dir) against proxy k: true if it is hit at t > 0
    const rayHits = (k: number, x: number, y: number, z: number, dx: number, dy: number, dz: number): boolean => {
      const m = occ[k].inv, lo = occ[k].lo, hi = occ[k].hi;
      const ox = m[0] * x + m[4] * y + m[8] * z + m[12], oy = m[1] * x + m[5] * y + m[9] * z + m[13], oz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const ex = m[0] * dx + m[4] * dy + m[8] * dz, ey = m[1] * dx + m[5] * dy + m[9] * dz, ez = m[2] * dx + m[6] * dy + m[10] * dz;
      let t0 = 1e-3, t1 = 1e9;
      for (let ax = 0; ax < 3; ax++) {
        const o1 = ax === 0 ? ox : ax === 1 ? oy : oz, d1 = ax === 0 ? ex : ax === 1 ? ey : ez;
        const a = ax === 0 ? lo.x : ax === 1 ? lo.y : lo.z, b = ax === 0 ? hi.x : ax === 1 ? hi.y : hi.z;
        if (Math.abs(d1) < 1e-9) {
          if (o1 < a || o1 > b) return false;
          continue;
        }
        let ta = (a - o1) / d1, tb = (b - o1) / d1;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) return false;
      }
      return true;
    };

    // per-vertex bake: occlusion and sky exposure
    const DIRS = 7, RADII = [0.22, 0.55, 1], RW = [0.45, 0.33, 0.22];
    const tilt = Math.cos(58 * DEG), tiltS = Math.sin(58 * DEG);
    const SKY: number[][] = [[0, 1, 0, 0.4]];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      SKY.push([Math.sin(25 * DEG) * Math.cos(a), Math.cos(25 * DEG), Math.sin(25 * DEG) * Math.sin(a), 0.15]);
    }
    const bakedAO: Float32Array[] = [], bakedSky: Float32Array[] = [];
    const near: number[] = [], above: number[] = [];
    parts.forEach((part, pi) => {
      const nv = part.count;
      const ao = new Float32Array(nv), sky = new Float32Array(nv);
      const pb = occ[pi].wb;
      // candidate occluders for this part
      near.length = 0;
      above.length = 0;
      for (let k = 0; k < parts.length; k++) {
        if (k === pi || !occ[k].solid) continue;
        const wb = occ[k].wb;
        if (wb.min.x - R < pb.max.x && wb.max.x + R > pb.min.x && wb.min.y - R < pb.max.y && wb.max.y + R > pb.min.y && wb.min.z - R < pb.max.z && wb.max.z + R > pb.min.z) near.push(k);
        if (wb.max.y > pb.min.y + 0.01) {
          const reach = (wb.max.y - pb.min.y) * 0.5;
          if (wb.min.x - reach < pb.max.x && wb.max.x + reach > pb.min.x && wb.min.z - reach < pb.max.z && wb.max.z + reach > pb.min.z) above.push(k);
        }
      }
      for (let i = 0; i < nv; i++) {
        const x = part.p[i * 3], y = part.p[i * 3 + 1], z = part.p[i * 3 + 2];
        const nx = part.n[i * 3], ny = part.n[i * 3 + 1], nz = part.n[i * 3 + 2];
        // tangent frame
        let tx: number, ty: number, tz: number;
        if (Math.abs(ny) < 0.9) { tx = nz; ty = 0; tz = -nx; } else { tx = 1; ty = 0; tz = 0; }
        const d = tx * nx + ty * ny + tz * nz;
        tx -= nx * d; ty -= ny * d; tz -= nz * d;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
        let blocked = 0, weight = 0;
        if (aoK > 0 && (near.length > 0 || ground)) {
          for (let dI = 0; dI < DIRS; dI++) {
            let dx = nx, dy = ny, dz = nz, w = 1;
            if (dI > 0) {
              const a = ((dI - 1) / 6) * Math.PI * 2;
              const ca = Math.cos(a) * tiltS, sa = Math.sin(a) * tiltS;
              dx = nx * tilt + tx * ca + bx * sa;
              dy = ny * tilt + ty * ca + by * sa;
              dz = nz * tilt + tz * ca + bz * sa;
              w = 0.55;
            }
            for (let rI = 0; rI < 3; rI++) {
              const rr = R * RADII[rI];
              const qx = x + dx * rr, qy = y + dy * rr, qz = z + dz * rr;
              let hit = ground && qy < 0;
              for (let k = 0; !hit && k < near.length; k++) hit = inside(near[k], qx, qy, qz, 0);
              weight += w * RW[rI];
              if (hit) blocked += w * RW[rI];
            }
          }
        }
        const occl = weight > 0 ? blocked / weight : 0;
        ao[i] = Math.max(0.12, Math.min(1, (1 - Math.min(1, occl * 1.5 * aoK)) * part.ao[i]));
        let open = 0;
        for (const s of SKY) {
          let hit = false;
          for (let k = 0; !hit && k < above.length; k++) hit = rayHits(above[k], x, y, z, s[0], s[1], s[2]);
          if (!hit) open += s[3];
        }
        sky[i] = open;
      }
      bakedAO.push(ao);
      bakedSky.push(sky);
    });

    // snow push: welded so coincident vertices rise together
    const allP: number[] = [];
    for (const p of parts) for (const v of p.p) allP.push(v);
    const w = weld(allP, 2e-4);
    const accY = new Float64Array(w.count * 3), minSnow = new Float32Array(w.count).fill(1);
    {
      let g = 0;
      parts.forEach((part, pi) => {
        for (let i = 0; i < part.count; i++, g++) {
          const id = w.map[g];
          accY[id * 3] += part.n[i * 3]; accY[id * 3 + 1] += part.n[i * 3 + 1]; accY[id * 3 + 2] += part.n[i * 3 + 2];
          minSnow[id] = Math.min(minSnow[id], part.sn[i] * bakedSky[pi][i]);
        }
      });
    }

    // emit geometries
    const groupsByOwner = new Map<string | null, Group | null>([[null, null]]);
    for (const g of this.named) groupsByOwner.set(g.name, g);
    const offsets: number[] = [];
    {
      let g = 0;
      for (const p of parts) { offsets.push(g); g += p.count; }
    }
    let tris = 0;
    const emit = (owner: string | null, glass: boolean, pivot: THREE.Vector3 | null): THREE.BufferGeometry | null => {
      let nv = 0, ni = 0;
      const sel: number[] = [];
      parts.forEach((p, pi) => {
        if (p.owner !== owner || (p.m[0] === MAT.GLASS) !== glass) return;
        sel.push(pi);
        nv += p.count;
        ni += p.idx.length;
      });
      if (nv === 0) return null;
      const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Uint8Array(nv * 4);
      const det = new Float32Array(nv * 4), surf = new Uint8Array(nv * 4), env = new Uint8Array(nv * 4);
      const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
      let vo = 0, io = 0;
      const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
      for (const pi of sel) {
        const p = parts[pi];
        const g0 = offsets[pi];
        for (let i = 0; i < p.count; i++) {
          const o3 = (vo + i) * 3, o4 = (vo + i) * 4;
          pos[o3] = p.p[i * 3] - (pivot ? pivot.x : 0);
          pos[o3 + 1] = p.p[i * 3 + 1] - (pivot ? pivot.y : 0);
          pos[o3 + 2] = p.p[i * 3 + 2] - (pivot ? pivot.z : 0);
          nor[o3] = p.n[i * 3]; nor[o3 + 1] = p.n[i * 3 + 1]; nor[o3 + 2] = p.n[i * 3 + 2];
          col[o4] = u8(Math.sqrt(Math.max(0, p.c[i * 3])));
          col[o4 + 1] = u8(Math.sqrt(Math.max(0, p.c[i * 3 + 1])));
          col[o4 + 2] = u8(Math.sqrt(Math.max(0, p.c[i * 3 + 2])));
          col[o4 + 3] = u8(bakedAO[pi][i]);
          det[o4] = p.d[i * 3]; det[o4 + 1] = p.d[i * 3 + 1]; det[o4 + 2] = p.d[i * 3 + 2];
          det[o4 + 3] = p.m[i];
          surf[o4] = u8(p.ro[i]);
          surf[o4 + 1] = u8(p.me[i]);
          surf[o4 + 2] = u8(p.we[i] * (0.4 + p.e[i]));
          surf[o4 + 3] = u8(Math.sqrt(Math.max(0, p.em[i])) / 8);
          const id = w.map[g0 + i];
          const l = Math.hypot(accY[id * 3], accY[id * 3 + 1], accY[id * 3 + 2]) || 1;
          const exposure = p.sn[i] * bakedSky[pi][i];
          env[o4] = u8(exposure);
          env[o4 + 1] = u8(p.sl[i] / 2.55);
          env[o4 + 2] = u8(sstep(0.15, 0.7, accY[id * 3 + 1] / l) * minSnow[id]);
          env[o4 + 3] = u8(p.st[i]);
        }
        for (let i = 0; i < p.idx.length; i++) index[io + i] = p.idx[i] + vo;
        vo += p.count;
        io += p.idx.length;
      }
      tris += ni / 3;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4, true));
      geo.setAttribute('aDetail', new THREE.BufferAttribute(det, 4));
      geo.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4, true));
      geo.setAttribute('aEnv', new THREE.BufferAttribute(env, 4, true));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.computeBoundingBox();
      // room for the snow cap and for cloth swinging on its sway length
      let reach = 0.06;
      for (const pi of sel) for (const s of parts[pi].sl) if (s > reach) reach = s;
      geo.boundingBox!.expandByScalar(reach);
      geo.boundingSphere = geo.boundingBox!.getBoundingSphere(new THREE.Sphere());
      return geo;
    };

    const def: ModelDef = {
      name: '',
      seed: this.seed,
      geometry: emit(null, false, null),
      glass: emit(null, true, null),
      parts: {},
      anchors: {},
      emitters: this.emitters,
      lights: this.lights,
      bounds,
      radius: 0,
      tris: 0,
    };
    for (const g of this.named) {
      const name = g.name as string;
      def.parts[name] = { name, geometry: emit(name, false, g.pivot), glass: emit(name, true, g.pivot), pivot: g.pivot.clone(), axis: g.axis.clone(), openAngle: g.openAngle };
    }
    for (const a of this.anchors) def.anchors[a.name] = a;
    def.tris = tris;
    def.radius = Math.max(bounds.min.length(), bounds.max.length());
    return def;
  }
}
