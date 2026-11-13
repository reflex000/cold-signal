// Shared building blocks for the structures and the wreck: light inside rooms, icicles, snow
// drifts as geometry, ribbed and corrugated sheet metal, sawn-timber frames, glazing, angle iron.
// Everything here only calls the kit Builder; nothing draws or allocates per frame.
import * as THREE from 'three/webgpu';
import { Builder, MAT, PAL, fbm3, mixRGB, type P2, type Part, type RGB, type V3 } from '../kit';

export const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const sstep = (a: number, b: number, v: number): number => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Merge parts into the first (one occlusion proxy: use for coplanar boards, strips, small clutter). */
export function mergeAll(parts: (Part | null | undefined)[]): Part | null {
  const live = parts.filter((p): p is Part => !!p);
  if (!live.length) return null;
  for (let i = 1; i < live.length; i++) live[0].merge(live[i]);
  return live[0];
}

// ------------------------------------------------------------------------------------------
// Light inside a room
// ------------------------------------------------------------------------------------------

/**
 * An opening that lets daylight into a room: centre `c`, unit normal `n` pointing INTO the room,
 * area in square metres. `gain` scales its brightness (a doorway under a porch roof < 1).
 */
export interface Aperture { c: V3; n: V3; area: number; gain?: number }

/**
 * Darken a room's inside by how much sky its surfaces can see through the openings. The kit's
 * baked occlusion only sees contact within a few decimetres; a closed room needs the bigger
 * picture or its walls glow like an outside wall in shade. For every vertex for which
 * `inside(v)` holds, the occlusion is multiplied by base + sum of the openings' form factors
 * (area * cos at the vertex * cos at the opening / (pi d^2 + area)), times `gain`.
 * Call it once, after the room is built and before b.build().
 */
export function roomLight(
  b: Builder,
  inside: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => boolean,
  aps: readonly Aperture[],
  o: { base?: number; gain?: number; max?: number } = {},
): void {
  const base = o.base ?? 0.13, gain = o.gain ?? 2.4, top = o.max ?? 1;
  b.each((v) => {
    if (!inside(v.x, v.y, v.z, v.nx, v.ny, v.nz)) return;
    let f = base;
    for (const a of aps) {
      const dx = a.c[0] - v.x, dy = a.c[1] - v.y, dz = a.c[2] - v.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d = Math.sqrt(d2) || 1e-3;
      const cv = (v.nx * dx + v.ny * dy + v.nz * dz) / d; // facing the opening
      const ca = -(a.n[0] * dx + a.n[1] * dy + a.n[2] * dz) / d; // the opening facing it
      if (cv <= 0 || ca <= 0) continue;
      f += (a.gain ?? 1) * gain * (a.area * cv * ca) / (Math.PI * d2 + a.area);
    }
    v.ao *= Math.min(top, f);
  });
}

// ------------------------------------------------------------------------------------------
// Ice and snow as geometry
// ------------------------------------------------------------------------------------------

/**
 * A row of icicles hanging from the line a -> c (an eave, a gutter, a wing's trailing edge).
 * Many short, a few long, clustered where melt water ran. One merged, non-occluding part.
 */
export function icicles(b: Builder, a: V3, c: V3, o: { every?: number; len?: [number, number]; r?: number; seed?: number } = {}): Part | null {
  const r = b.rng;
  const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const every = o.every ?? 0.11;
  const [lo, hi] = o.len ?? [0.04, 0.45];
  const rad = o.r ?? 0.016;
  const seed = o.seed ?? r.int(0, 1 << 20);
  const prev = b.ink({ color: PAL.ice, mat: MAT.ICE, rough: 0.12, wear: 0.1, snow: 0, vary: 0.04 });
  let first: Part | null = null;
  for (let s = r.range(0, every); s < len; s += every * r.range(0.45, 1.6)) {
    const t = s / len;
    // melt runs: long ones bunch together
    const run = sat(0.5 + fbm3(seed, t * len * 0.9, 0, 0, 2) * 1.4);
    if (r.next() > 0.25 + run * 0.75) continue;
    const L = lo + (hi - lo) * Math.pow(r.next(), 2.2) * (0.35 + run * 0.65);
    const rr = rad * (0.6 + L / hi) * r.range(0.7, 1.15);
    const prof: P2[] = [];
    const n = L > 0.15 ? 6 : 4;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      // a carrot with a drip bulge or two
      const w = rr * (1 - u) ** 1.25 * (1 + 0.18 * Math.sin(u * 11 + s * 7));
      prof.push([Math.max(0, w), -u * L]);
    }
    prof.reverse();
    const p = b.lathe([[0, -L - 0.004], ...prof.slice(0, -1), [rr * 1.25, 0.004], [0, 0.006]], { sides: 5, smooth: true });
    p.rotY(r.range(0, 6.28)).rotX(r.range(-0.06, 0.06)).rotZ(r.range(-0.06, 0.06));
    p.move(a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, a[2] + (c[2] - a[2]) * t);
    if (first) first.merge(p);
    else first = p;
  }
  b.ink(prev);
  return first ? first.ghost() : null;
}

/**
 * A wind drift of snow along a path on the ground: a bank `w` wide and `h` high whose crest sits
 * toward `lee` (-1..1 across the path), buried 0.12 m so it meets any terrain. MAT.SNOW geometry.
 */
export function drift(b: Builder, path: readonly V3[], w: number, h: number, o: { lee?: number; taper?: boolean; noise?: number } = {}): Part {
  const lee = o.lee ?? 0;
  const prof: P2[] = [];
  const N = 9;
  for (let i = 0; i <= N; i++) {
    const u = i / N; // across, 0..1
    const x = (u - 0.5) * w;
    const c = 0.5 + lee * 0.3;
    const d = u < c ? u / c : (1 - u) / (1 - c);
    prof.push([x, -0.12 + (h + 0.12) * Math.pow(Math.sin((Math.PI / 2) * sat(d)), 1.6)]);
  }
  prof.push([w / 2, -0.14], [-w / 2, -0.14]);
  const prev = b.ink({ color: PAL.snow, mat: MAT.SNOW, rough: 0.85, wear: 0, snow: 1, vary: 0.02 });
  const taper = o.taper ?? true;
  const p = b.sweep(prof, path, {
    scale: taper ? (t) => [0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0.02, t))), 0.2 + 0.8 * Math.sin(Math.PI * Math.min(1, Math.max(0.02, t)))] : undefined,
    smooth: true,
  });
  const amp = o.noise ?? Math.min(0.05, h * 0.2);
  if (amp > 0) p.noise(amp, 1.4);
  b.ink(prev);
  return p;
}

/** A soft heap of snow (a mound against a corner, snow blown through a door). */
export function snowHeap(b: Builder, at: V3, rx: number, h: number, rz = rx, yaw = 0): Part {
  const prev = b.ink({ color: PAL.snow, mat: MAT.SNOW, rough: 0.85, wear: 0, snow: 1, vary: 0.02 });
  const p = b.lathe([[0, -0.1], [1.02, -0.1], [1, 0], [0.85, 0.25], [0.55, 0.62], [0.25, 0.9], [0, 1]], { sides: 12, smooth: true });
  p.scale(rx, h, rz).noise(Math.min(rx, rz, h) * 0.12, 2.2 / Math.max(0.3, Math.min(rx, rz))).rotY(yaw).move(at[0], at[1], at[2]);
  b.ink(prev);
  return p;
}

// ------------------------------------------------------------------------------------------
// Sheet metal
// ------------------------------------------------------------------------------------------

/**
 * A ribbed (R-panel) or corrugated sheet `w` wide and `len` long, `t` thick, made in the XY plane:
 * width along X, length along Y, ribs along Y and standing out toward +Z. Centred.
 * kind 'rib': flat pans with trapezoid ribs every `pitch`; 'wave': sine corrugation.
 */
export function sheet(b: Builder, w: number, len: number, o: { kind?: 'rib' | 'wave'; pitch?: number; depth?: number; t?: number; rows?: number } = {}): Part {
  const kind = o.kind ?? 'rib';
  const pitch = o.pitch ?? (kind === 'rib' ? 0.3 : 0.076);
  const depth = o.depth ?? (kind === 'rib' ? 0.028 : 0.018);
  const t = o.t ?? 0.0012;
  const top: P2[] = [];
  const periods = Math.max(1, Math.round(w / pitch));
  const pw = w / periods;
  for (let k = 0; k < periods; k++) {
    const x0 = -w / 2 + k * pw;
    if (kind === 'rib') {
      // pan, rib flank, rib crown, flank (ribs 1/4 of the period, crown half the rib)
      top.push([x0, 0], [x0 + pw * 0.62, 0], [x0 + pw * 0.7, depth], [x0 + pw * 0.86, depth], [x0 + pw * 0.94, 0]);
    } else {
      for (let i = 0; i < 6; i++) top.push([x0 + (pw * i) / 6, depth * 0.5 * (1 - Math.cos((Math.PI * 2 * i) / 6))]);
    }
  }
  top.push([w / 2, 0]);
  // polygon in extrude's XZ plane: z is the sheet's thickness direction
  const poly: P2[] = [...top.map(([x, z]) => [x, z] as P2), ...top.slice().reverse().map(([x, z]) => [x, z - t] as P2)];
  const p = b.extrude(poly, len, { bevel: 0, capBevel: 0, rows: o.rows ?? 1, crease: kind === 'wave' ? 80 * Math.PI / 180 : 25 * Math.PI / 180 });
  // extrude makes along Y with the polygon in XZ: that is already width X, length Y, ribs +Z
  return p;
}

// ------------------------------------------------------------------------------------------
// Timber
// ------------------------------------------------------------------------------------------

/** A sawn beam from a to b, `w` x `h` in section (h along `up`), slightly irregular. */
export function beam(b: Builder, a: V3, c: V3, w: number, h: number, o: { up?: V3; bevel?: number } = {}): Part {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const p = b.plank(len, w, h, { bevel: o.bevel ?? Math.min(0.012, Math.min(w, h) * 0.15) });
  // plank: length Y, width X, thickness Z: the thickness (h) turns toward `up`
  return place(p, a, c, o.up ?? [0, 1, 0]);
}
const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

/** Place a part made along +Y (length `len`) from a to c with its +Z toward `up`: a rigid frame, not a warp. */
export function place(p: Part, a: V3, c: V3, up: V3 = [0, 1, 0]): Part {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) || 1;
  const d: V3 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len, (c[2] - a[2]) / len];
  let zx = up[0], zy = up[1], zz = up[2];
  const dd = zx * d[0] + zy * d[1] + zz * d[2];
  zx -= d[0] * dd; zy -= d[1] * dd; zz -= d[2] * dd;
  let zl = Math.hypot(zx, zy, zz);
  if (zl < 1e-4) {
    // up parallel to the member: any perpendicular will do
    if (Math.abs(d[0]) < 0.9) { zx = 0; zy = -d[2]; zz = d[1]; } else { zx = -d[2]; zy = 0; zz = d[0]; }
    zl = Math.hypot(zx, zy, zz);
  }
  zx /= zl; zy /= zl; zz /= zl;
  _m.makeBasis(_x.set(d[1] * zz - d[2] * zy, d[2] * zx - d[0] * zz, d[0] * zy - d[1] * zx), _y.set(d[0], d[1], d[2]), _z.set(zx, zy, zz));
  _m.setPosition((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2);
  return p.apply(_m);
}

/** A rectangular frame of sawn boards (a window or door casing) in the XY plane facing +Z, centred on its opening. */
export function casing(b: Builder, w: number, h: number, board: number, depth: number): Part[] {
  const out: Part[] = [];
  out.push(b.plank(h + board * 2, board, depth, { straight: true }).move(-w / 2 - board / 2, 0, 0));
  out.push(b.plank(h + board * 2, board, depth, { straight: true }).move(w / 2 + board / 2, 0, 0));
  out.push(b.plank(w, board, depth, { straight: true }).rotZ(Math.PI / 2).move(0, h / 2 + board / 2, 0));
  out.push(b.plank(w + board * 0.6, board * 1.1, depth * 1.25, { straight: true }).rotZ(Math.PI / 2).move(0, -h / 2 - board * 0.55, depth * 0.12));
  return out;
}

/**
 * A glazed window `w` x `h` in the XY plane facing +Z (centred): `cols` x `rows` panes in a
 * timber sash. Panes are MAT.GLASS (the transparent pass); some may be cracked out.
 */
export function sash(b: Builder, w: number, h: number, o: { cols?: number; rows?: number; bar?: number; frame?: RGB; broken?: number; glassTint?: RGB } = {}): void {
  const cols = o.cols ?? 2, rows = o.rows ?? 2, bar = o.bar ?? 0.035;
  const prev = b.ink({ color: o.frame ?? PAL.timber, mat: MAT.WOOD, wear: 0.7, snow: 0.6, vary: 0.05 });
  for (let i = 0; i <= cols; i++) b.box(i === 0 || i === cols ? bar * 1.4 : bar, h, 0.045, { bevel: 0.004 }).move(-w / 2 + (w * i) / cols, 0, 0);
  for (let j = 0; j <= rows; j++) b.box(w, j === 0 || j === rows ? bar * 1.4 : bar, 0.045, { bevel: 0.004 }).move(0, -h / 2 + (h * j) / rows, 0);
  b.ink({ color: o.glassTint ?? PAL.glass, mat: MAT.GLASS, rough: 0.06, wear: 0.2, snow: 0.5 });
  const r = b.rng;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    if (o.broken && r.next() < o.broken) continue;
    const pw = w / cols - bar, ph = h / rows - bar;
    b.box(pw, ph, 0.004, { bevel: 0.0005 }).move(-w / 2 + (w * (i + 0.5)) / cols, -h / 2 + (h * (j + 0.5)) / rows, 0);
  }
  b.ink(prev);
}

// ------------------------------------------------------------------------------------------
// Steel
// ------------------------------------------------------------------------------------------

/** An L-section angle iron from a to c, legs `leg` long, `t` thick, the heel toward `heel`. */
export function angle(b: Builder, a: V3, c: V3, leg: number, t: number, heel: V3 = [0, 1, 0]): Part {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  // the section's centroid sits on the member axis; the heel (corner) points toward -X -Z
  const k = leg * 0.3;
  const prof: P2[] = [[0, 0], [leg, 0], [leg, t], [t, t], [t, leg], [0, leg]].map(([x, z]) => [x - k, z - k] as P2);
  const p = b.extrude(prof, len, { bevel: t * 0.3, capBevel: t * 0.2 });
  // turn the heel diagonal toward `heel`: rotate 45 deg so the corner is on -Z, then place (+Z -> heel side away)
  p.rotY(-Math.PI / 4);
  return place(p, a, c, [-heel[0], -heel[1], -heel[2]]);
}

/** Bolt heads (hex domes) at points, each facing `n`. Merged into one part. */
export function bolts(b: Builder, pts: readonly V3[], n: V3, r = 0.009): Part | null {
  let first: Part | null = null;
  for (const at of pts) {
    const p = b.dome(r, r * 0.7, 6).aim(n, at);
    if (first) first.merge(p);
    else first = p;
  }
  return first;
}

/** Rust weeping down from a line (bolt rows, sheet laps): darken toward rust below y0 within `reach`. */
export function rustRun(p: Part, x0: number, x1: number, y0: number, reach: number, seed: number, k = 0.5): void {
  const rc = mixRGB(PAL.rust, PAL.rustDark, 0.4);
  p.tint(rc, (v) => {
    if (v.x < x0 || v.x > x1 || v.y > y0 || v.y < y0 - reach) return 0;
    const streak = sat(0.5 + fbm3(seed, v.x * 9, 0, v.z * 9, 2) * 1.6);
    return k * streak * (1 - (y0 - v.y) / reach);
  });
}
