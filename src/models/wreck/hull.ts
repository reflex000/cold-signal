// Aircraft building blocks shared by the wreck models: parametric surface patches (the curved
// skin of the fuselage, tail cone, wing and debris panels), the window ring patch, the hull
// cross-section of Flight 417, the livery and the passenger seat unit.
//
// Flight 417 is a low-wing twin turboprop regional airliner. The fuselage is a 3.6 m circle
// (radius 1.8, centre 1.45 m above the snow: the belly is crushed and buried). Model space as in
// src/world/blueprints.ts: nose toward +Z.
import { Builder, MAT, PAL, Part, fbm3, hex, mixRGB, type P2, type RGB, type V3 } from '../kit';

export const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const DEG = Math.PI / 180;

export type Map2 = (u: number, v: number) => V3;

const EPS = 1e-4;
function normalOf(map: Map2, u: number, v: number, flip: boolean): V3 {
  const a = map(u + EPS, v), b = map(u - EPS, v), c = map(u, v + EPS), d = map(u, v - EPS);
  const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2];
  const vx = c[0] - d[0], vy = c[1] - d[1], vz = c[2] - d[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  const s = flip ? -1 / l : 1 / l;
  nx *= s; ny *= s; nz *= s;
  return [nx, ny, nz];
}

/**
 * A quad grid over the sample values `us` x `vs`, mapped to 3D by `map`. The face looks along
 * dP/du x dP/dv (or the opposite with flip). `keep(i, j)` may drop cell (i, j) (holes, tears).
 */
export function surface(b: Builder, us: readonly number[], vs: readonly number[], map: Map2, o: { flip?: boolean; keep?: (i: number, j: number) => boolean } = {}): Part {
  const p = new Part(b);
  const flip = !!o.flip;
  const ids: number[][] = [];
  for (let i = 0; i < us.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < vs.length; j++) {
      const q = map(us[i], vs[j]);
      const n = normalOf(map, us[i], vs[j], flip);
      row.push(p.vert(q[0], q[1], q[2], n[0], n[1], n[2]));
    }
    ids.push(row);
  }
  for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < vs.length; j++) {
    if (o.keep && !o.keep(i, j)) continue;
    p.quad(ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
  }
  return p.finish();
}

/** Evenly spaced samples a..b in n steps (n + 1 values). */
export function steps(a: number, b: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

/**
 * A rectangle of surface with an elliptical hole (a window in a skin bay), as one ring of quads:
 * rectangle [u0, u1] x [v0, v1] in the map's domain, hole centred (cu, cv) with half sizes
 * (ru, rv) in domain units. `n` points round (a multiple of 4). Returns the hole outline too.
 */
export function holePatch(b: Builder, u0: number, u1: number, v0: number, v1: number, cu: number, cv: number, ru: number, rv: number, map: Map2, o: { n?: number; flip?: boolean; round?: number } = {}): Part {
  const n = o.n ?? 16, flip = !!o.flip;
  const per = n / 4;
  const outer: P2[] = [];
  const side = (a: P2, c: P2) => { for (let k = 0; k < per; k++) outer.push([a[0] + ((c[0] - a[0]) * k) / per, a[1] + ((c[1] - a[1]) * k) / per]); };
  side([u0, v0], [u1, v0]);
  side([u1, v0], [u1, v1]);
  side([u1, v1], [u0, v1]);
  side([u0, v1], [u0, v0]);
  const sq = o.round ?? 2.4; // superellipse exponent: aircraft windows are rounded rectangles
  const inner: P2[] = outer.map(([u, v]) => {
    const a = Math.atan2((v - cv) / rv, (u - cu) / ru);
    const c = Math.cos(a), s = Math.sin(a);
    const k = Math.pow(Math.pow(Math.abs(c), sq) + Math.pow(Math.abs(s), sq), -1 / sq);
    return [cu + ru * c * k, cv + rv * s * k];
  });
  const p = new Part(b);
  const oi = outer.map(([u, v]) => { const q = map(u, v), m = normalOf(map, u, v, flip); return p.vert(q[0], q[1], q[2], m[0], m[1], m[2]); });
  const ii = inner.map(([u, v]) => { const q = map(u, v), m = normalOf(map, u, v, flip); return p.vert(q[0], q[1], q[2], m[0], m[1], m[2]); });
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    p.quad(oi[k], oi[k2], ii[k2], ii[k]);
  }
  return p.finish();
}

/** The outline of the hole holePatch() cuts (same superellipse), `n` points, in domain units. */
export function holeOutline(cu: number, cv: number, ru: number, rv: number, n = 16, sq = 2.4): P2[] {
  const out: P2[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const m = Math.pow(Math.pow(Math.abs(c), sq) + Math.pow(Math.abs(s), sq), -1 / sq);
    out.push([cu + ru * c * m, cv + rv * s * m]);
  }
  return out;
}

/** A closed band joining two loops of the same count (window reveals, frame rims). */
export function loft(b: Builder, a: readonly V3[], c: readonly V3[], outward: V3 | null = null): Part {
  const p = new Part(b);
  const n = a.length;
  // centre of the loops, for a normal guess when none is given
  let cx = 0, cy = 0, cz = 0;
  for (const q of a) { cx += q[0]; cy += q[1]; cz += q[2]; }
  cx /= n; cy /= n; cz /= n;
  const ia: number[] = [], ic: number[] = [];
  for (let k = 0; k < n; k++) {
    const q = a[k], r = c[k];
    let nx = (q[0] + r[0]) / 2 - cx, ny = (q[1] + r[1]) / 2 - cy, nz = (q[2] + r[2]) / 2 - cz;
    if (outward) { nx = outward[0]; ny = outward[1]; nz = outward[2]; }
    const l = Math.hypot(nx, ny, nz) || 1;
    ia.push(p.vert(q[0], q[1], q[2], nx / l, ny / l, nz / l));
    ic.push(p.vert(r[0], r[1], r[2], nx / l, ny / l, nz / l));
  }
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    p.quad(ia[k], ia[k2], ic[k2], ic[k]);
  }
  return p.finish();
}

// ------------------------------------------------------------------------------------------
// The hull of Flight 417
// ------------------------------------------------------------------------------------------

export const HULL = {
  R: 1.8,
  // Centre height: low enough that the cabin floor (y 0.36, |x| 1.56) fits inside the circle;
  // the belly lies 0.58 m under the snow, the crown is 3.02 m up.
  CY: 1.22,
  /** Last station of the constant section; the nose tapers from here to the tip. */
  NOSE0: 6.2,
  TIP: 9.25,
  /** Frame stations every 0.5 m, aligned so the over-wing exit (z 0.4 .. 1.4) sits between frames. */
  frame0: 0.4,
  pitch: 0.5,
};

/** Half width, half height and centre height of the hull section at z (outer skin). */
export function section(z: number): { a: number; b: number; c: number } {
  if (z <= HULL.NOSE0) return { a: HULL.R, b: HULL.R, c: HULL.CY };
  const u = sat((z - HULL.NOSE0) / (HULL.TIP - HULL.NOSE0));
  // the crown sweeps down over the cockpit, the chin rises less: a blunt airliner nose
  const top = HULL.CY + HULL.R - 1.95 * Math.pow(u, 1.7);
  const bot = HULL.CY - HULL.R + 1.05 * Math.pow(u, 1.5);
  const half = HULL.R * Math.sqrt(Math.max(0.0004, 1 - Math.pow(u, 2.3)));
  const hb = Math.max(0.02, (top - bot) / 2) * Math.sqrt(Math.max(0.0004, 1 - Math.pow(u, 6)));
  return { a: half, b: hb, c: (top + bot) / 2 + (Math.pow(u, 3) * 0.25) };
}

/** A point on the hull at station z, angle a (0 crown, +PI/2 the +X side), r metres inside the skin. */
export function hullAt(z: number, a: number, r = 0): V3 {
  const s = section(z);
  const k = Math.max(0.05, 1 - r / HULL.R);
  return [s.a * k * Math.sin(a), s.c + s.b * k * Math.cos(a), z];
}

/** The angle at which the outer skin of the constant section passes height y on the given side (+1 / -1). */
export function angleAtY(y: number, side = 1, r = 0): number {
  const c = (y - HULL.CY) / (HULL.R - r);
  return side * Math.acos(Math.max(-1, Math.min(1, c)));
}

// ------------------------------------------------------------------------------------------
// Livery: white upper body, a navy cheat line under the windows with a thin red pinstripe, grey belly
// ------------------------------------------------------------------------------------------

export const LIVERY = {
  white: PAL.liveryWhite,
  navy: PAL.liveryBlue,
  red: PAL.liveryRed,
  belly: hex(0x8a8f93),
};

/** Livery colour at a hull point (y = height). Bands are fixed heights on the constant section. */
export function liveryAt(y: number, z: number): RGB {
  if (y > 1.37) return LIVERY.white;
  if (y > 1.31) return LIVERY.red;
  if (y > 1.25) return LIVERY.white;
  // the cheat line sweeps down toward the nose
  if (y > 0.96 - 0.03 * Math.max(0, z - 5)) return LIVERY.navy;
  return LIVERY.belly;
}

/** Paint a skin part with the livery and the scars of the slide: scraped belly, smeared soot, dents. */
export function paintSkin(p: Part, seed: number, o: { scrape?: number; soot?: (x: number, y: number, z: number) => number } = {}): void {
  const scrape = o.scrape ?? 1;
  p.each((v) => {
    const c = liveryAt(v.y, v.z);
    v.r = c[0]; v.g = c[1]; v.b = c[2];
    // the slide scoured the belly to bare, scratched aluminium
    const low = sat((0.75 - v.y) / 0.5) * scrape;
    const n = fbm3(seed, v.x * 1.6, v.y * 3.2, v.z * 0.7, 3);
    if (low > 0.2 + n * 0.3) {
      v.mat = MAT.METAL;
      const g = mixRGB(PAL.aluminiumDull, PAL.steelDark, 0.25 + 0.3 * sat(n + 0.5));
      v.r = g[0]; v.g = g[1]; v.b = g[2];
      v.rough = 0.55;
      v.wear = 0.45;
    } else v.wear = 0.35 + 0.35 * low + 0.2 * sat(n + 0.3);
    if (o.soot) {
      const s = sat(o.soot(v.x, v.y, v.z));
      v.r *= 1 - 0.85 * s; v.g *= 1 - 0.85 * s; v.b *= 1 - 0.85 * s;
    }
  });
}

// ------------------------------------------------------------------------------------------
// Seats
// ------------------------------------------------------------------------------------------

export interface SeatOpts {
  /** Seats side by side. */
  n: number;
  /** Width of one seat (centre to centre). */
  pitch?: number;
  /** Recline of each back in radians (+ leans back); one value per seat. */
  recline?: number[];
  /** Seats whose cushion is gone. */
  bare?: number[];
  /** Snow exposure of the fabric (0 indoors). */
  snow?: number;
  /** How torn up: bent legs, hanging belts, split covers. */
  damage?: number;
  fabric?: RGB;
}

/**
 * An airliner seat unit facing +Z, centred on x = 0, standing on y = 0, its depth within
 * z -0.3 .. +0.3 and the back up to 1.06 m. Returns the group. Seat-pan top at 0.45.
 */
export function seatUnit(b: Builder, o: SeatOpts): void {
  const r = b.rng;
  const pitch = o.pitch ?? 0.5;
  const n = o.n, W = n * pitch;
  const snow = o.snow ?? 0;
  const dmg = o.damage ?? 0.3;
  const fabric = o.fabric ?? PAL.seatBlue;
  // ---- frame: two leg pairs on seat tracks, a front and a rear spreader tube ----
  b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.35, rough: 0.5, snow });
  const legX = [-W / 2 + pitch * 0.35, W / 2 - pitch * 0.35];
  for (const lx of legX) {
    const bend = (r.next() - 0.5) * dmg * 0.25;
    // the leg: a forged A from the track up to the spreaders
    b.box(0.03, 0.4, 0.04, { bevel: 0.006 }).rotX(0.32).rotZ(bend).move(lx, 0.2, 0.08);
    b.box(0.03, 0.4, 0.04, { bevel: 0.006 }).rotX(-0.18).rotZ(bend).move(lx, 0.2, -0.16);
    b.box(0.035, 0.03, 0.56, { bevel: 0.006 }).move(lx, 0.015, -0.03);
  }
  for (const z of [0.17, -0.14]) b.cyl(0.018, W - 0.04, { sides: 8 }).rotZ(Math.PI / 2).move(0, 0.39, z);
  // ---- each seat ----
  for (let i = 0; i < n; i++) {
    const cx = -W / 2 + pitch * (i + 0.5);
    const bare = o.bare?.includes(i);
    const rec = (o.recline?.[i] ?? 0.22) + (r.next() - 0.5) * 0.05;
    // pan frame and cushion
    b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.4, snow });
    b.box(pitch - 0.05, 0.03, 0.42, { bevel: 0.008 }).move(cx, 0.41, 0.03);
    if (!bare) {
      b.ink({ color: fabric, mat: MAT.CLOTH, wear: 0.35 + dmg * 0.4, snow, vary: 0.05 });
      const c = b.pillow(pitch - 0.07, 0.1, 0.44, { round: 0.035, bulge: 0.012, seg: 2, ring: 1 }).move(cx, 0.47, 0.05);
      c.dent([cx + r.range(-0.08, 0.08), 0.52, 0.02], 0.16, 0.025);
    }
    // back: shell, cushion, headrest cover, tray table on the rear face
    b.group(() => {
      b.ink({ color: PAL.plasticGrey, mat: MAT.PLASTIC, wear: 0.45, snow, vary: 0.04 });
      b.box(pitch - 0.04, 0.62, 0.05, { bevel: 0.012 }).move(0, 0.31, -0.03);
      b.ink({ color: PAL.seatGrey, mat: MAT.PLASTIC, wear: 0.4, snow });
      b.box(pitch * 0.62, 0.26, 0.012, { bevel: 0.004 }).move(0, 0.36, -0.06);
      b.ink({ color: fabric, mat: MAT.CLOTH, wear: 0.4 + dmg * 0.3, snow, vary: 0.05 });
      b.pillow(pitch - 0.07, 0.58, 0.09, { round: 0.03, bulge: 0.01, seg: 2, ring: 1 }).move(0, 0.33, 0.03);
      b.ink({ color: hex(0xc9c6bb), mat: MAT.CLOTH, wear: 0.5, snow });
      b.pillow(pitch - 0.1, 0.17, 0.095, { round: 0.03, bulge: 0.006, seg: 1, ring: 1 }).move(0, 0.55, 0.035);
    }).rotX(-rec).move(cx, 0.44, -0.18);
    // armrests between and at the ends
    b.ink({ color: PAL.plasticGrey, mat: MAT.PLASTIC, wear: 0.5, snow });
    if (i === 0) b.box(0.04, 0.05, 0.36, { bevel: 0.01 }).move(cx - pitch / 2 + 0.02, 0.64, 0.0);
    b.box(0.04, 0.05, 0.36, { bevel: 0.01 }).move(cx + pitch / 2 - 0.02, 0.64, 0.0);
    // the lap belt: one half buckled, one hanging
    b.ink({ color: PAL.webbing, mat: MAT.CLOTH, wear: 0.4, snow });
    const hang = r.range(0.12, 0.3);
    b.strap(
      [[cx - pitch * 0.35, 0.45, -0.12], [cx - pitch * 0.38, 0.47, 0.04], [cx - pitch * 0.4, 0.46 - hang * 0.6, 0.22], [cx - pitch * 0.41, 0.44 - hang, 0.27]],
      0.045, 0.003, { up: [1, 0, 0] },
    ).sway([cx - pitch * 0.38, 0.47, 0.04], 0.6);
    b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.2, rough: 0.3, snow });
    b.box(0.05, 0.004, 0.065, { bevel: 0.001 }).rotX(1.2).move(cx - pitch * 0.41, 0.44 - hang + 0.01, 0.27);
  }
}
