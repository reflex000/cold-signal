// 'cave_rocks': the cave at the foot of the cliff band (blueprint cave_rocks: a chamber whose
// walls are the edges of CAVE_POLY, 4.4 m tall, roofed over, the 3 m mouth at +Z, rock faces
// either side of the mouth out to |x| 6.4; floor y 0.03).
// Built as rock, not boulders: an inner shell lofted round the blueprint outline (the walls stand
// on the polygon edges, never inside them below head height, and arch over into a vault 3.6 to
// 4.3 m up), a thick outer mass offset 2 to 5 m outside it, and the cliff face joining the two
// round the mouth. Broken-rock facets (half-faceted normals), strata, scree and boulders at the
// foot, snow blown in over the threshold, icicles off the lip. Inside: an old stone hearth on the
// 'fire' anchor, the survey cache (stencilled crates under a torn tarp, rope, a jerrycan) behind
// the 'cache' anchor, the den's trampled bedding and old bones by the 'den' anchor.
// The inside is dark except toward the mouth (lib.roomLight).
import { Builder, MAT, PAL, Part, fbm3, hex, mixRGB, noise3, type P2, type V3 } from '../kit';
import { register } from '../registry';
import { BLUEPRINTS } from '../../world/blueprints';
import { drift, icicles, roomLight, snowHeap, type Aperture } from './lib';

const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Half width of the chamber at z (the blueprint polygon is symmetric about x = 0). */
function halfW(z: number): number {
  const pts: P2[] = [[0.3, 1.5], [-1.0, 1.5], [-3.6, 3.3], [-6.6, 3.3], [-9.2, 1.6]];
  if (z >= pts[0][0]) return pts[0][1];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [z0, w0] = pts[i], [z1, w1] = pts[i + 1];
    if (z <= z0 && z >= z1) return lerp(w0, w1, (z0 - z) / (z0 - z1));
  }
  return pts[pts.length - 1][1];
}

/** A grid of rock: half-faceted triangles (broken faces, not a smooth blob, not low-poly cubes). */
function rockGrid(b: Builder, us: readonly number[], vs: readonly number[], map: (u: number, v: number) => V3, o: { flip?: boolean; facet?: number; keep?: (i: number, j: number) => boolean } = {}): Part {
  const p = new Part(b);
  const P: V3[][] = us.map((u) => vs.map((v) => map(u, v)));
  const facet = o.facet ?? 0.55;
  const sgn = o.flip ? -1 : 1;
  // smooth normals from the grid
  const N: V3[][] = P.map((row, i) => row.map((_, j) => {
    const a = P[Math.min(us.length - 1, i + 1)][j], c = P[Math.max(0, i - 1)][j];
    const d = P[i][Math.min(vs.length - 1, j + 1)], e = P[i][Math.max(0, j - 1)];
    const ux = a[0] - c[0], uy = a[1] - c[1], uz = a[2] - c[2], vx = d[0] - e[0], vy = d[1] - e[1], vz = d[2] - e[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = (Math.hypot(nx, ny, nz) || 1) * sgn;
    return [nx / l, ny / l, nz / l] as V3;
  }));
  const tri = (a: [number, number], c: [number, number], d: [number, number]) => {
    const A = P[a[0]][a[1]], B = P[c[0]][c[1]], C = P[d[0]][d[1]];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-10) return;
    fx /= fl; fy /= fl; fz /= fl;
    // agree with the smooth side
    const s0 = N[a[0]][a[1]];
    if (fx * s0[0] + fy * s0[1] + fz * s0[2] < 0) { fx = -fx; fy = -fy; fz = -fz; }
    const ids = [a, c, d].map(([i, j]) => {
      const s = N[i][j];
      let nx = s[0] + (fx - s[0]) * facet, ny = s[1] + (fy - s[1]) * facet, nz = s[2] + (fz - s[2]) * facet;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      return p.vert(P[i][j][0], P[i][j][1], P[i][j][2], nx, ny, nz);
    });
    p.tri(ids[0], ids[1], ids[2]);
  };
  for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < vs.length; j++) {
    if (o.keep && !o.keep(i, j)) continue;
    // alternate the diagonal: no zipper pattern across the face
    if ((i + j) & 1) { tri([i, j], [i + 1, j], [i + 1, j + 1]); tri([i, j], [i + 1, j + 1], [i, j + 1]); }
    else { tri([i, j], [i + 1, j], [i, j + 1]); tri([i + 1, j], [i + 1, j + 1], [i, j + 1]); }
  }
  return p.finish();
}

register(
  'cave_rocks',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.cave_rocks;
    const S = r.int(0, 1 << 20);
    // mouth arch at z 1.07: the ring boxes of the mouth's side edges reach that far forward
    const ZM = 1.07, ZB = -9.2; // mouth, back wall
    const rockCol = mixRGB(PAL.rock, PAL.rockBrown, 0.25);
    // section of the inner shell at z: s 0..1 from the left wall foot over the vault to the right foot
    const wallTop = (z: number) => lerp(1.55, 2.35, sat((ZM - z) / 3.5));
    const crown = (z: number) => lerp(2.6, 4.15, sat((ZM - z) / 3.2)) - 0.45 * sat((-7.4 - z) / 1.8);
    const strata = (y: number, z: number) => 0.05 * Math.sin(y * 7.5 + z * 0.4 + fbm3(S + 9, y, z * 0.3, 0, 2) * 2);
    const inner = (z: number, s: number, off = 0): V3 => {
      const w = halfW(z), wt = wallTop(z), cr = crown(z);
      const side = s < 0.5 ? -1 : 1;
      const t = s < 0.5 ? s * 2 : (1 - s) * 2; // 0 at the foot .. 1 at the crown
      let x: number, y: number;
      if (t < 0.45) {
        // the wall: from the floor up to the spring of the vault, standing on the polygon edge
        const k = t / 0.45;
        y = -0.08 + (wt + 0.08) * k;
        x = side * w;
      } else {
        // the vault: a quarter ellipse from the wall top to the crown
        const k = (t - 0.45) / 0.55;
        const a = (k * Math.PI) / 2;
        x = side * w * Math.cos(a) * (1 - 0.15 * k);
        y = wt + (cr - wt) * Math.sin(a);
      }
      // rough rock: below head height only ever outward (the collider face is the polygon edge)
      const n = fbm3(S, x * 0.7, y * 0.9, z * 0.7, 3);
      const n2 = noise3(S + 3, x * 2.3, y * 2.3, z * 2.3);
      const low = y < 2.1;
      const d = low ? 0.01 + 0.09 * sat(0.5 + n) + 0.02 * (n2 * 0.5 + 0.5) : 0.12 * n + 0.05 * n2;
      const out = d + off + strata(y, z) * (low ? 0.5 : 1) + (low ? 0.025 : 0);
      // push away from the chamber axis (x) on the walls, up on the vault
      const vx = t < 0.45 ? side : side * Math.cos(Math.PI / 2 * sat((t - 0.45) / 0.55));
      const vy = t < 0.45 ? 0 : Math.sin(Math.PI / 2 * sat((t - 0.45) / 0.55));
      return [x + vx * Math.max(low ? 0 : -0.2, out), y + vy * out, z];
    };
    // ---- the inner shell, its back wall ----
    b.ink({ color: rockCol, mat: MAT.ROCK, wear: 0.3, rough: 0.92, snow: 0, vary: 0.04 });
    const zs: number[] = [];
    for (let z = ZM; z > ZB + 0.01; z -= 0.42) zs.push(z);
    zs.push(ZB);
    const ss = [0, 0.04, 0.09, 0.15, 0.22, 0.3, 0.37, 0.43, 0.48, 0.52, 0.57, 0.63, 0.7, 0.78, 0.85, 0.91, 0.96, 1];
    for (let k = 0; k < zs.length - 1; k += 6) {
      const seg = zs.slice(k, Math.min(zs.length, k + 7));
      // u = z falls row to row: flip to face the chamber
      rockGrid(b, seg, ss, (z, s) => inner(z, s), { flip: false }).ghost();
    }
    // back wall: the last section closing into a rounded end
    rockGrid(b, [0, 0.3, 0.6, 0.85, 1], ss, (u, s) => {
      const p = inner(ZB, s);
      const k = Math.sin((u * Math.PI) / 2);
      const cy = 1.4;
      return [p[0] * (1 - k), cy + (p[1] - cy) * (1 - k), ZB - 0.18 * k];
    }).ghost();
    // ---- the outer mass: offset well outside, wider toward the mouth to make the cliff faces ----
    // open to the sky: snow lies on its ledges and its top (the material's job)
    b.ink({ color: rockCol, mat: MAT.ROCK, wear: 0.3, rough: 0.92, snow: 1, vary: 0.04 });
    // Below 2.4 m the mass stands on the colliders' outer faces (people walk round it): the ring
    // boxes 1.7 m outside the chamber's edges, the flank boxes out to |x| 6.4 beside the mouth.
    // outermost |x| of the blueprint's rock boxes at z (scanned once per row: exact for any layout)
    const inBox = (x: number, z: number) => bp.boxes.some((q) => {
      const dx = x - q.x, dz = z - q.z, c = Math.cos(q.yaw), sn = Math.sin(q.yaw);
      return Math.abs(dx * c - dz * sn) <= q.hx && Math.abs(dx * sn + dz * c) <= q.hz;
    });
    const halfCache = new Map<number, number>();
    const outerHalf = (z: number) => {
      const key = Math.round(z * 1000);
      let v = halfCache.get(key);
      if (v === undefined) {
        v = halfW(z) + 1.7;
        for (let x = 7.5; x > 0; x -= 0.01) if (inBox(x, z) || inBox(-x, z)) { v = x; break; }
        halfCache.set(key, v);
      }
      return v;
    };
    const JAMB = 3.25, ZJ = 1.08, ZF = 0.42;
    const outer = (z: number, s: number): V3 => {
      const t = s < 0.5 ? s * 2 : (1 - s) * 2; // 0 at the foot .. 1 on top
      const side = s < 0.5 ? -1 : 1;
      // a broken top: blocks and a ragged skyline, not a dome; it climbs toward the back into the
      // cliff band, so the mass reads as the foot of the cliff and not as a bunker set before it (POLISH)
      const top = crown(Math.min(z, ZM)) + 1.25 + 0.9 * fbm3(S + 12, z * 0.3, s * 2, 1, 2) + 0.9 * Math.max(0, noise3(S + 16, z * 0.45, s * 4, 2)) + 5.5 * sat((-z - 1.5) / 7) ** 1.3;
      // the front ring stands on the flank boxes' front face (z 0.40): look the outline up just behind it
      const wl = outerHalf(Math.min(z, 0.38));
      let x: number, y: number;
      if (t < 0.4) { y = -0.15 + (2.55 * t) / 0.4; x = side * wl; }
      else { const a = (((t - 0.4) / 0.6) * Math.PI) / 2; x = side * wl * Math.cos(a) ** 0.7; y = 2.4 + (top - 2.4) * Math.sin(a); }
      const n = fbm3(S + 13, x * 0.35, y * 0.35, z * 0.35, 3) * 0.5 + noise3(S + 14, x * 1.1, y * 1.1, z * 1.1) * 0.12;
      // strata: beds about 0.7 m thick, each stepping back to a ledge that holds snow
      const bed = y / 0.7, f = bed - Math.floor(bed);
      const ledge = 0.2 * (f < 0.25 ? f / 0.25 : 1);
      // on the collider face, give or take 8 cm of rock: vertical joints, bedding grooves, bulges
      if (y < 2.4) {
        const along = z * 0.9 + x * 0.6;
        const joint = Math.pow(Math.abs(Math.sin((along / 1.15) * Math.PI + noise3(S + 17, y * 0.8, z, 0) * 1.2)), 14);
        const groove = Math.pow(Math.abs(Math.sin((y / 0.7) * Math.PI + 0.6 * noise3(S + 18, z * 0.5, x * 0.5, 0))), 16);
        const out = 0.07 - 0.11 * sat(0.5 + n) - 0.07 * joint - 0.04 * groove;
        return [x + side * out, y, z];
      }
      const k = Math.cos((((t - 0.4) / 0.6) * Math.PI) / 2);
      const block = 0.35 * Math.max(0, noise3(S + 19, x * 0.6, y * 0.6, z * 0.6));
      return [x + side * (n * 1.6 + block - ledge) * k, y + n * 0.8, z];
    };
    // weathering: lighter and darker beds, lichen, dark streaks under the ledges
    const weather = (p: Part) => p.each((v) => {
      const k = 1 + 0.2 * fbm3(S + 21, v.x * 0.35, v.y * 0.5, v.z * 0.35, 3);
      const lich = sat((fbm3(S + 22, v.x * 0.8, v.y * 0.8, v.z * 0.8, 3) - 0.15) * 3) * sat(v.ny + 0.6);
      const streak = sat(fbm3(S + 23, v.x * 2.5, 0, v.z * 2.5, 2) * 2) * 0.35;
      const c = mixRGB(rockCol, hex(0x4f5246), lich * 0.6);
      v.r = c[0] * k * (1 - streak); v.g = c[1] * k * (1 - streak); v.b = c[2] * k * (1 - streak);
    });
    const zo = [ZF, -0.2, -0.8, -1.28, -1.34];
    for (let z = -1.9; z > -10.95; z -= 0.6) zo.push(z);
    const so = [0, 0.06, 0.13, 0.21, 0.3, 0.38, 0.45, 0.5, 0.55, 0.62, 0.7, 0.79, 0.87, 0.94, 1];
    for (let k = 0; k < zo.length - 1; k += 6) {
      const seg = zo.slice(k, Math.min(zo.length, k + 7));
      weather(rockGrid(b, seg, so, (z, s) => outer(z, s), { flip: true, facet: 0.8 }).ghost());
    }
    // the cliff face round the mouth: from the arch out to the jamb's front corner (z 1.08, where
    // the mouth's side boxes end), back along the jamb's side to the flank face (z 0.42), out to
    // the mass's front ring
    rockGrid(b, [0, 0.2, 0.38, 0.5, 0.52, 0.75, 1], ss, (u, s) => {
      const a = inner(ZM, s), c = outer(ZF, s);
      const side = s < 0.5 ? -1 : 1;
      const cx = side * Math.max(Math.abs(a[0]) + 0.3, Math.min(JAMB, Math.abs(c[0])));
      const cy = lerp(a[1], c[1], Math.abs(c[0]) > JAMB ? 0.0 : 0.5);
      const wob = 0.05 * fbm3(S + 15, s * 5, u * 3, 0, 2);
      if (u <= 0.5) { const k = u / 0.5; return [lerp(a[0], cx, k), lerp(a[1], cy, k), ZJ + Math.max(0, wob) * k]; }
      if (u <= 0.52) { const k = (u - 0.5) / 0.02; return [cx + side * Math.max(0, wob), cy, lerp(ZJ, ZF, k)]; }
      const k = (u - 0.52) / 0.48;
      return [lerp(cx, c[0], k), lerp(cy, c[1], k), ZF + Math.max(0, wob) * (1 - k)];
    }, { flip: true }).ghost();
    // the back of the mass: a face on the back boxes' outer face (z -10.9), closing in on top
    rockGrid(b, [0, 0.5, 1], so, (u, s) => {
      const p = outer(-10.9, s);
      return [p[0] * (1 - u), 1.2 + (p[1] - 1.2) * (1 - u), -10.9 - 0.04 * u];
    }, { flip: true }).ghost();

    // ---- floor: gravel and rock, level at the blueprint's 0.03 ----
    b.ink({ color: mixRGB(rockCol, hex(0x4a4640), 0.35), mat: MAT.ROCK, wear: 0.4, rough: 0.95, snow: 0, vary: 0.05 });
    {
      const fz = steps2(0.45, -9.35, 26), fx = steps2(-3.45, 3.45, 16);
      rockGrid(b, fz, fx, (z, x) => [x, 0.03 + 0.018 * fbm3(S + 20, x * 1.7, 0, z * 1.7, 3) - 0.006, z], { facet: 0.3, flip: true, keep: (i, j) => Math.abs((fx[j] + fx[j + 1]) / 2) < halfW((fz[i] + fz[i + 1]) / 2) + 0.15 });
    }
    // scree and loose stones along the walls (out of the walking line), boulders at the foot outside
    for (let i = 0; i < 26; i++) {
      const z = r.range(-8.8, -0.4);
      const side = r.chance(0.5) ? -1 : 1;
      // nestled into the foot of the wall, not out on the floor
      const x = side * (halfW(z) + r.range(-0.03, 0.08));
      b.ink({ color: mixRGB(rockCol, PAL.rockBrown, r.next() * 0.5), mat: MAT.ROCK, wear: 0.35, snow: 0 });
      b.rock(r.range(0.05, 0.16), { detail: 1, rough: 0.6, facet: 0.7, flat: 0.4 }).rotY(r.range(0, 6.3)).move(x, 0.03, z);
    }
    // no free boulders at the foot (they would have no collider): snow banked against the faces
    for (const sx of [-1, 1]) {
      snowHeap(b, [sx * 4.9, 0, 0.75], 1.4, 0.55, 0.6, 0.1);
      snowHeap(b, [sx * 5.4, 0, -2.6], 1.0, 0.5, 1.4);
    }

    // ---- the old hearth: a ring of fire-blackened stones, ash ----
    const fire = bp.anchors.fire;
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2 + r.range(-0.1, 0.1);
      b.ink({ color: mixRGB(PAL.rock, PAL.soot, 0.5), mat: MAT.ROCK, wear: 0.4, snow: 0 });
      b.rock(r.range(0.1, 0.15), { detail: 1, rough: 0.5, facet: 0.5, flat: 0.45 }).rotY(a).move(fire.x + Math.cos(a) * 0.55, fire.y - 0.02, fire.z + Math.sin(a) * 0.55);
    }
    b.ink({ color: PAL.ash, mat: MAT.CHAR, wear: 0.6, snow: 0 });
    b.lathe([[0, 0], [0.5, 0], [0.45, 0.02], [0.2, 0.035], [0, 0.04]], { sides: 12, smooth: true }).noise(0.01, 6).move(fire.x, fire.y - 0.005, fire.z);
    b.ink({ color: PAL.charcoal, mat: MAT.CHAR, wear: 0.6, snow: 0 });
    for (let i = 0; i < 4; i++) b.log(0.3, 0.025, { sides: 5, rows: 1, ends: ['break', 'break'] }).rotZ(Math.PI / 2).rotY(r.range(0, 6.3)).move(fire.x + r.range(-0.15, 0.15), fire.y + 0.04, fire.z + r.range(-0.15, 0.15));

    // ---- the survey cache: crates, a tarp, rope, a jerrycan ----
    const cache = bp.anchors.cache;
    const crate = (x: number, y: number, z: number, w: number, h: number, d: number, yaw: number, label: string) => {
      b.group(() => {
        b.ink({ color: mixRGB(PAL.timber, PAL.olive, 0.35), mat: MAT.WOOD, wear: 0.6, snow: 0, vary: 0.08 });
        b.box(w, h, d, { bevel: 0.01 }).move(0, h / 2, 0);
        b.ink({ color: mixRGB(PAL.timber, PAL.timberDark, 0.4), mat: MAT.WOOD, wear: 0.6, snow: 0 });
        for (const sx of [-1, 1]) b.box(0.05, h + 0.004, d + 0.012, { bevel: 0.006 }).move(sx * (w / 2 - 0.03), h / 2, 0);
        b.ink({ color: hex(0x1f1e1c), mat: MAT.WOOD, wear: 0.6, snow: 0 });
        b.stencil(label, h * 0.18, { align: 'center', weight: 0.15 }).move(0, h * 0.42, d / 2 + 0.002);
      }).rotY(yaw).move(x, y, z);
    };
    // shallow cases, flush with the wall: they have no collider, so they keep out of the way
    crate(3.12, 0.03, -6.45, 0.75, 0.48, 0.38, -Math.PI / 2 + 0.05, 'SURVEY');
    crate(3.12, 0.03, -5.1, 0.7, 0.45, 0.36, -Math.PI / 2 - 0.04, 'GEO 4');
    crate(3.13, 0.51, -6.3, 0.6, 0.38, 0.34, -Math.PI / 2 + 0.12, 'FRAGILE');
    b.ink({ color: PAL.canvasOlive, mat: MAT.CLOTH, wear: 0.65, snow: 0 });
    {
      const tarp = b.cloth(1.6, 1.3, { nx: 12, ny: 10, billow: 0.12, wrinkle: 0.05, tear: 0.5, tearEdges: ['bottom', 'left'], thickness: 0.004 });
      tarp.rotY(-Math.PI / 2).rotZ(0.12).move(3.27, 1.05, -5.8);
      tarp.warp((q) => { if (q.y < 0.05) q.y = 0.05 + (q.y - 0.05) * 0.1; });
      tarp.ghost();
    }
    b.ink({ color: PAL.rope, mat: MAT.CLOTH, wear: 0.5, snow: 0 });
    b.torus(0.17, 0.018, { segs: 14, sides: 5 }).move(2.75, 0.06, -4.55);
    b.torus(0.15, 0.018, { segs: 14, sides: 5 }).rotX(0.2).move(2.78, 0.1, -4.53);
    b.ink({ color: hex(0x3a4a2a), mat: MAT.PAINT, wear: 0.7, snow: 0 });
    b.box(0.17, 0.46, 0.34, { bevel: 0.02 }).rotZ(Math.PI / 2).rotY(0.3).move(3.1, 0.57, -5.0);
    void cache;

    // ---- the den: trampled bedding, old bones ----
    const den = bp.anchors.den;
    b.ink({ color: hex(0x4d4232), mat: MAT.CLOTH, wear: 0.7, snow: 0 });
    b.lathe([[0, 0.02], [0.75, 0], [0.82, 0.05], [0.7, 0.08], [0.3, 0.05], [0, 0.04]], { sides: 14, smooth: true }).noise(0.02, 5).scale(1, 1, 0.75).rotY(den.yaw).move(den.x, den.y, den.z);
    const bone = (x: number, z: number, len: number, rr: number, yaw: number) => {
      b.ink({ color: hex(0x9d968a), mat: MAT.PLASTIC, rough: 0.8, wear: 0.6, snow: 0 });
      const p = b.capsule(rr, len, { sides: 6, rings: 2 });
      p.rotZ(Math.PI / 2).rotY(yaw).move(x, den.y + rr * 0.8, z);
      b.sphere(rr * 1.6, { sides: 6, rings: 4 }).move(x + Math.cos(yaw) * len / 2, den.y + rr, z - Math.sin(yaw) * len / 2);
    };
    for (let i = 0; i < 6; i++) bone(den.x + r.range(-0.9, 0.9), den.z + r.range(-0.7, 0.9), r.range(0.18, 0.42), r.range(0.012, 0.022), r.range(0, 6.3));
    // ribs in an arc, a skull with antler stubs
    b.ink({ color: hex(0x9d968a), mat: MAT.PLASTIC, rough: 0.8, wear: 0.6, snow: 0 });
    for (let i = 0; i < 5; i++) {
      const rib = b.box(0.012, 0.36, 0.02, { bevel: 0.004, rows: 4 }).bend(1.3, 'z');
      rib.rotZ(Math.PI / 2 - 0.2).rotY(0.9 + i * 0.12).move(den.x + 0.55 + i * 0.07, den.y + 0.03, den.z - 0.35 - i * 0.04);
    }
    {
      const sk = b.group(() => {
        b.capsule(0.07, 0.3, { sides: 8, rings: 3 }).rotX(Math.PI / 2 - 0.15).move(0, 0.07, 0);
        b.ink({ color: hex(0x7d7568), mat: MAT.PLASTIC, rough: 0.85, wear: 0.6, snow: 0 });
        for (const sx of [-1, 1]) b.cone(0.02, 0.22, { sides: 6 }).rotZ(sx * -0.6).rotX(-0.4).move(sx * 0.06, 0.18, -0.08);
      });
      sk.rotY(2.4).rotZ(0.3).move(den.x - 0.7, den.y, den.z + 0.55);
    }

    // ---- snow: in over the threshold, on the ledge outside, icicles off the lip ----
    drift(b, [[0.4, 0.0, 1.6], [0.1, 0.0, 0.3], [-0.2, 0.0, -1.3]], 2.4, 0.16, { noise: 0.02 });
    snowHeap(b, [-2.6, 0, 1.6], 1.4, 0.4, 1.0);
    snowHeap(b, [2.9, 0, 1.4], 1.2, 0.35, 0.9);
    {
      const lip = (s: number) => { const p = inner(ZM, s); return [p[0], p[1] - 0.04, ZM + 0.08] as V3; };
      icicles(b, lip(0.36), lip(0.5), { every: 0.08, len: [0.05, 0.6], r: 0.02 });
      icicles(b, lip(0.5), lip(0.64), { every: 0.08, len: [0.05, 0.5], r: 0.02 });
    }

    // ---- light inside: only the mouth ----
    const aps: Aperture[] = [{ c: [0, 1.25, ZM], n: [0, 0, -1], area: 7.5 }];
    roomLight(b, (x, y, z, nx, ny, nz) => {
      void nx; void ny; void nz;
      if (z > ZM + 0.05 || z < -10.5) return false;
      if (y > crown(z) + 0.45) return false;
      return Math.abs(x) < halfW(z) + 0.45;
    }, aps, { base: 0.12, gain: 3.2 });

    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    return b.build({ ground: true, aoRadius: 0.2 });
  },
  { variants: 1, size: 'structure', desc: 'the cave: a rock chamber at the cliff foot with the survey cache and the den (blueprint cave_rocks)', tags: ['cave'] },
);

function steps2(a: number, b: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}
