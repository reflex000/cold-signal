// 'fuselage': the forward 18 m of Flight 417, lying where it stopped, broken open at the wing
// root. Built on the blueprint 'fuselage' (src/world/blueprints.ts): hull walls at |x| 1.56 .. 1.80,
// the over-wing exit on +X (z 0.4 .. 1.4), the bulkhead at z 6.30 .. 6.54 closing off the cockpit,
// the cabin floor at y 0.36 (z -8.0 .. 6.3), a torn floor step at y 0.18 and the open break at
// z -9. Four seat units, the galley and the crew locker stand exactly in their furniture boxes.
//
// Outside: a 3.6 m aluminium tube in a white, navy and red livery, its belly scoured to bare metal
// and buried in the snow, oil-canned skin, the crushed nose with a crazed windscreen, the torn
// stub of the left wing root, the exit hatch thrown onto the right wing. At the break the skin
// tears into peeled petals, frames and stringers stick out, insulation and wiring hang.
// Inside: dado panels, sidewall lining with window reveals and shades, overhead bins (some open,
// one hanging), the ceiling with dropped oxygen masks, carpet and seat tracks, snow blown in.
// The inside is dark by day except near the break, the exit and the windows (lib.roomLight).
// Parts: 'locker_door' (hinged on +Y at the outboard edge; the CrateEnt 'locker' opens it).
// Anchors: everything the blueprint names, plus 'barrel_light' (where the outside fire glows in).
import { Builder, MAT, PAL, Part, Path, fbm3, hex, type P2, type V3 } from '../kit';
import { register } from '../registry';
import { drift, icicles, roomLight, snowHeap, type Aperture } from '../structures/lib';
import { BLUEPRINTS } from '../../world/blueprints';
import { DEG, HULL, holeOutline, holePatch, hullAt, loft, paintSkin, sat, seatUnit, section, steps, surface } from './hull';

// Angles round the hull (0 = crown, + toward +X) for the circle R 1.8 centred 1.22 m up.
const AT = 69.2 * DEG; // top of the window belt and of the exit cut-out (y 1.86)
const AB = 87.5 * DEG; // bottom of the window belt (y 1.30)
const AL = 150 * DEG; // lowest skin line, under the snow (y -0.34)
const AW = 78.5 * DEG; // window centre line (y 1.58)
const WRU = 0.12, WRV = 5.25 * DEG; // window half sizes: along z (m), around (rad)
const AEXIT = 118.5 * DEG; // the exit cut-out reaches down to the floor line (y 0.36)
const CROWN = 14; // crown band steps (9.886 deg each)
const Z_FLOOR_END = -8.0;
const Z_BULK = 6.3;
const FLOOR_Y = 0.36;
const DADO_TOP = 0.62; // where the curved sidewall lining comes down to |x| 1.56
const crownCol = (k: number) => -AT + (2 * AT * k) / CROWN;
// cockpit windscreen in crown columns: front panes |a| between columns 8 and 11, side windows 11 .. 13
const WS_FRONT: [number, number] = [crownCol(8), crownCol(11)];
const WS_SIDE: [number, number] = [crownCol(11), crownCol(13)];

/** Angles round the hull, crown at 0: lower(-) belt(-) crown belt(+) lower(+), shared by every band. */
function columns(): number[] {
  const lowerDeg = [150, 140, 130, AEXIT / DEG, 108, 98, 87.5];
  const beltDeg = [87.5, 82.925, 78.35, 73.775, 69.2];
  const out: number[] = [];
  const push = (a: number) => { if (!out.length || Math.abs(out[out.length - 1] - a) > 1e-6) out.push(a); };
  for (const d of lowerDeg) push(-d * DEG);
  for (const d of beltDeg) push(-d * DEG);
  for (const a of steps(-AT, AT, CROWN)) push(a);
  for (const d of [...beltDeg].reverse()) push(d * DEG);
  for (const d of [...lowerDeg].reverse()) push(d * DEG);
  return out;
}

register(
  'fuselage',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.fuselage;
    const S = r.int(0, 1 << 20);
    const A = columns();
    const isBelt = (a: number, side: number) => side * a >= AT - 1e-6 && side * a <= AB + 1e-6;
    const frames: number[] = [];
    for (let k = -19; k <= 12; k++) frames.push(HULL.frame0 + HULL.pitch * k);
    // cabin window bays (start stations); none on +X at the exit
    const winBays: number[] = [];
    for (let k = -17; k <= 10; k++) winBays.push(HULL.frame0 + HULL.pitch * k);
    const hasWin = (z0: number, side: number) => winBays.some((w) => Math.abs(w - z0) < 1e-6) && !(side > 0 && z0 > 0.3 && z0 < 1.0);
    const broken = new Set<string>();
    for (let i = 0; i < 6; i++) broken.add(`${r.chance(0.5) ? 1 : -1}:${winBays[r.int(0, 5)].toFixed(2)}`);

    // ---- the skin surface: dents (oil canning), crushed nose, petals at the break ----
    const zEnd = (a: number): number => {
      const n = fbm3(S + 3, Math.cos(a) * 1.4, Math.sin(a) * 1.4, 0.5, 3);
      const teeth = Math.abs(Math.sin(a * 6.3 + n * 4));
      const A2 = Math.abs(a);
      let z = -9.0 + 0.5 * (n + 0.3) - 0.16 * teeth;
      if (A2 < 1.15) z -= 0.4 * sat(0.6 + n * 1.5); // tongues over the top reach back
      // one long tear runs forward along the upper right side
      z += 0.9 * Math.exp(-(((a - 0.85) / 0.16) ** 2));
      if (A2 > 2.05) z += 0.7 * sat((A2 - 2.05) / 0.55); // the belly tore away further forward
      if (A2 > 1.2 && A2 < 2.05) z = Math.max(z, -9.04); // where people walk: inside the hull boxes
      return z;
    };
    const ZS = -8.1; // where the regular rows begin
    const dent = (z: number, a: number): number => {
      let off = 0.009 * fbm3(S, z * 0.95, a * 2.4, 0, 2) + 0.004 * fbm3(S + 9, z * 3.1, a * 7, 1, 2);
      // the nose came down on its chin
      if (z > 7.5) off -= 0.22 * sat((z - 7.5) / 1.7) ** 2 * sat((Math.abs(a) - 1.75) / 0.7) * (0.7 + 0.3 * fbm3(S + 4, z * 2, a * 3, 2, 2));
      // a long crease down the left side where it rolled onto a rock
      off -= 0.05 * Math.exp(-(((a + 1.95) / 0.12) ** 2)) * sat(1 - Math.abs(z + 2.5) / 3.5);
      // the last metres before the break buckled as the tube tore: the crown and the upper right
      // side sag in, in folds (kept off the walls below head height: the hull collider is there)
      if (z < -7.0) {
        const k = sat((-7.0 - z) / 2.0);
        off -= k * k * Math.max(0, Math.cos(a - 0.35)) * (0.2 + 0.1 * fbm3(S + 17, z * 1.3, a * 2.5, 0, 2)) * (Math.abs(a) > 1.3 ? 0.4 : 1);
        off -= k * 0.035 * Math.sin(z * 9.0 + a * 3.0);
      }
      return off;
    };
    const skin = (z: number, a: number, r0 = 0): V3 => hullAt(z, a, r0 - dent(z, a));
    // rear band: z from the torn edge (u = 0) to ZS (u = 1); petals peel outward near the edge
    const petal = (a: number) => Math.max(0, fbm3(S + 21, Math.cos(a) * 2.2, Math.sin(a) * 2.2, 3, 2) * 1.6 + 0.15);
    // End-on from 20 m the break read as a perfect round tube (POLISH): over the crown and the
    // belly the skin peels back in big ragged petals and the crown is crushed flat toward the
    // edge, so the opening is torn and lopsided. On the walls at body height (|a| 1.2 .. 2.05, the
    // hull colliders) it stays as it was.
    const wild = (a: number) => {
      const A2 = Math.abs(a);
      return A2 < 1.2 ? 1 : A2 > 2.05 ? 0.8 : 0.15;
    };
    const rear = (u: number, a: number, r0 = 0): V3 => {
      const z0 = zEnd(a);
      const z = z0 + (ZS - z0) * u;
      const k = Math.max(0, 1 - u / 0.5);
      const curl = petal(a) * k * k;
      const wl = wild(a);
      // crown crushed down toward the torn edge (a lopsided, flattened mouth)
      const crush = wl * k * (0.35 + 0.2 * fbm3(S + 31, a * 1.5, 0, 0, 2)) * Math.max(0, Math.cos(a - 0.25)) ** 2;
      const p = hullAt(z, a, r0 - dent(z, a) - curl * (0.13 + 0.42 * wl) - 0.045 * k * fbm3(S + 5, a * 8, u * 6, 0, 2));
      // the petal also bends back on itself
      return [p[0], p[1] - crush, p[2] - curl * (0.05 + 0.3 * wl)];
    };

    // ======================================================================================
    // OUTER SKIN
    // ======================================================================================
    // weathered, chalky paint: rough, so the shaded side reads as lit by the sky, not as a mirror
    b.ink({ color: PAL.liveryWhite, mat: MAT.PAINT, wear: 0.45, rough: 0.74, snow: 1 });
    const skinParts: Part[] = [];
    const keepCell = (z0: number, z1: number, a0: number, a1: number): boolean => {
      const am = (a0 + a1) / 2, zm = (z0 + z1) / 2;
      // window bays are made by holePatch
      for (const side of [-1, 1]) if (isBelt(am, side) && zm < 6.0 && zm > ZS) {
        const bay = HULL.frame0 + HULL.pitch * Math.floor((zm - HULL.frame0) / HULL.pitch);
        if (hasWin(bay, side)) return false;
      }
      // the over-wing exit
      if (am > AT && am < AEXIT && zm > 0.4 && zm < 1.4) return false;
      // cockpit windscreen: two front panes and a side window each side
      const aa = Math.abs(am);
      if (zm > 7.1 && zm < 7.7 && aa > WS_FRONT[0] && aa < WS_FRONT[1]) return false;
      if (zm > 6.5 && zm < 7.1 && aa > WS_SIDE[0] && aa < WS_SIDE[1]) return false;
      return true;
    };
    // the rear band (torn edge)
    const ur = [0, 0.18, 0.4, 0.68, 1];
    const holes: [number, number, number][] = [[r.range(-0.9, -0.3), 0.2 + r.range(0, 0.25), 0.35], [r.range(0.15, 0.7), 0.3 + r.range(0, 0.3), 0.3], [r.range(-1.4, -1.0), 0.15, 0.25]];
    const torn = (u: number, a: number) => holes.some(([ha, hu, hr]) => Math.hypot((a - ha) / hr, (u - hu) / 0.22) < 1);
    skinParts.push(surface(b, ur, A, (u, a) => rear(u, a), { keep: (i, j) => !torn((ur[i] + ur[i + 1]) / 2, (A[j] + A[j + 1]) / 2) }));
    // regular rows in 2 m segments (smaller occlusion neighbourhoods = faster bake)
    const rows: number[] = [];
    for (let z = ZS; z < HULL.NOSE0 - 1e-6; z += 0.25) rows.push(z);
    rows.push(HULL.NOSE0, 6.5, 6.8, 7.1, 7.4, 7.7, 8.0, 8.25, 8.5, 8.7, 8.86, 8.95, HULL.TIP);
    for (let s = 0; s < rows.length - 1; s += 4) {
      const seg = rows.slice(s, Math.min(rows.length, s + 5));
      skinParts.push(surface(b, seg, A, (z, a) => skin(z, a), { keep: (i, j) => keepCell(seg[i], seg[i + 1], A[j], A[j + 1]) }));
    }
    // window bays
    for (const side of [-1, 1]) for (const z0 of winBays) {
      if (!hasWin(z0, side)) continue;
      const v0 = side > 0 ? AT : -AB, v1 = side > 0 ? AB : -AT;
      skinParts.push(holePatch(b, z0, z0 + HULL.pitch, v0, v1, z0 + HULL.pitch / 2, side * AW, WRU, WRV, (z, a) => skin(z, a)));
    }
    // kept as separate parts: each sees only its own neighbourhood in the occlusion bake
    for (const sp of skinParts) {
      paintSkin(sp, S, { scrape: 1 });
      sp.ghost();
    }
    // the inside of the skin where nothing lines it: the last bays at the break
    b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.5, snow: 0 });
    const inner = surface(b, ur, A, (u, a) => rear(u, a, 0.004), { flip: true, keep: (i, j) => !torn((ur[i] + ur[i + 1]) / 2, (A[j] + A[j + 1]) / 2) });
    inner.merge(surface(b, [ZS, -7.85, -7.6], A, (z, a) => skin(z, a, 0.004), { flip: true, keep: (i, j) => keepCell([ZS, -7.85, -7.6][i], [ZS, -7.85, -7.6][i + 1], A[j], A[j + 1]) }));
    inner.ghost();
    {
      const cz: number[] = [];
      for (let z = -7.6; z < 8.6; z += 0.5) cz.push(z);
      cz.push(8.6);
      const ca = steps(-crownCol(13), crownCol(13), 12);
      for (let s0 = 0; s0 < cz.length - 1; s0 += 4) {
        const seg = cz.slice(s0, Math.min(cz.length, s0 + 5));
        surface(b, seg, ca, (z, a) => skin(z, a, 0.006), {
          flip: true,
          keep: (i, j) => {
            const zm = (seg[i] + seg[i + 1]) / 2, aa = Math.abs((ca[j] + ca[j + 1]) / 2);
            return !((zm > 7.1 && zm < 7.7 && aa > WS_FRONT[0] && aa < WS_FRONT[1]) || (zm > 6.5 && zm < 7.1 && aa > WS_SIDE[0] && aa < WS_SIDE[1]));
          },
        }).ghost();
      }
    }
    // the torn skin edge catches the light as a thin bright line: bare metal where it ripped
    // torn edges show bare metal; the primer is the pale zinc-chromate green, not a dark ring
    inner.each((v) => {
      const d = Math.abs(v.z - zEnd(Math.atan2(v.x, v.y - HULL.CY)));
      if (d < 0.09) v.wear = 1.1;
      const c = hex(0x8c9258);
      v.r = c[0]; v.g = c[1]; v.b = c[2];
    });

    // ---- window panes, frames on the skin ----
    b.ink({ color: hex(0x5d6a70), mat: MAT.GLASS, rough: 0.05, wear: 0.25, snow: 0.4 });
    let glass: Part | null = null;
    const winLoops: { z: number; side: number; skinL: V3[]; linL: V3[] }[] = [];
    for (const side of [-1, 1]) for (const z0 of winBays) {
      if (!hasWin(z0, side)) continue;
      const cz = z0 + HULL.pitch / 2;
      const outl = holeOutline(cz, side * AW, WRU, WRV, 16);
      const skinL = outl.map(([z, a]) => skin(z, a));
      const linL = outl.map(([z, a]) => hullAt(z, a, 0.12));
      winLoops.push({ z: cz, side, skinL, linL });
      if (broken.has(`${side}:${z0.toFixed(2)}`)) continue;
      const pane = outl.map(([z, a]) => skin(z, a, 0.012));
      // counter-clockwise in (z, a) is counter-clockwise seen from outside on both sides
      const g = b.mesh(pane, [pane.map((_, i) => i)]);
      g.ghost();
      glass = g;
    }
    void glass;

    // ---- over-wing exit: frame round the cut-out ----
    b.ink({ color: PAL.plasticBlack, mat: MAT.RUBBER, wear: 0.4, snow: 0.5 });
    {
      const loop: P2[] = [[0.4, AT], [0.9, AT], [1.4, AT], [1.4, (AT + AEXIT) / 2], [1.4, AEXIT], [0.9, AEXIT], [0.4, AEXIT], [0.4, (AT + AEXIT) / 2]];
      const o = loop.map(([z, a]) => skin(z, a, -0.004));
      const i2 = loop.map(([z, a]) => skin(z, a, 0.11));
      loft(b, o, i2).ghost();
    }

    // ======================================================================================
    // STRUCTURE AT THE BREAK: frames, stringers, floor beams, insulation, wiring
    // ======================================================================================
    b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.55, rough: 0.6, snow: 0.3 });
    for (const zf of [-9.1, -8.6, -8.1]) {
      // a frame: Z-section ring 8 cm deep inside the skin, broken where the skin went
      let a0 = -AL + 0.05;
      while (a0 < AL - 0.1) {
        const len = r.range(0.6, 2.2);
        const a1 = Math.min(AL - 0.05, a0 + len);
        const ok = zf > -9.0 || r.chance(0.55);
        if (ok) {
          const path: V3[] = steps(a0, a1, Math.max(2, Math.round((a1 - a0) / 0.15))).map((a) => hullAt(zf, a, 0.045));
          const fr = b.sweep([[-0.042, -0.01], [0.042, -0.01], [0.042, 0.01], [-0.042, 0.01]], path, { up: [0, 0, 1] });
          // the frames nearest the edge are bent where the skin pulled them
          if (zf < -8.8) fr.crumple(0.05, 1.5);
        }
        a0 = a1 + (zf < -8.8 ? r.range(0.15, 0.6) : r.range(0.02, 0.15));
      }
    }
    // stringers: from the last intact frame out past the torn edge
    b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.4, rough: 0.5, snow: 0.3 });
    for (let a = -AL + 0.12; a < AL - 0.1; a += 0.21 + r.range(-0.03, 0.03)) {
      const ze = zEnd(a) - r.range(-0.05, 0.28);
      const p0 = hullAt(-7.9, a, 0.02), p1 = hullAt(ze, a, 0.02 + r.range(-0.04, 0.06));
      const st = b.box(0.012, Math.hypot(p1[2] - p0[2], p1[0] - p0[0], p1[1] - p0[1]), 0.022, { bevel: 0.002, rows: 3 });
      st.bend(r.range(-0.5, 0.5) * sat((-8.8 - ze) * 2), 'z').span(p0, p1);
    }
    // floor beams sticking out of the torn floor, bent down
    b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.5, rough: 0.55, snow: 0.4 });
    for (const zb of [-8.1, -8.6]) {
      const beamL = b.box(3.05, 0.11, 0.035, { bevel: 0.004, rows: 1 });
      beamL.move(0, FLOOR_Y - 0.1, zb);
      if (zb < -8.3) beamL.warp((q) => { q.y -= 0.18 * Math.max(0, Math.sin(q.x * 1.3 + 0.4)); q.z += 0.05 * Math.sin(q.x * 2.1); });
    }
    // insulation blankets hanging out between the frames
    b.ink({ color: hex(0x7b7d6f), mat: MAT.CLOTH, wear: 0.55, snow: 0.2, vary: 0.08 });
    for (let i = 0; i < 9; i++) {
      const a = r.range(-1.6, 1.6);
      const z = r.range(-8.9, -8.2);
      const top = hullAt(z, a, 0.07);
      const cl = b.cloth(r.range(0.3, 0.5), r.range(0.25, 0.6), { nx: 5, ny: 6, billow: 0.03, wrinkle: 0.015, tear: 0.6, thickness: 0.025 });
      cl.rotY(Math.PI / 2 + r.range(-0.3, 0.3)).rotZ(-a * 0.25).move(top[0], top[1], top[2]).sway(top, 0.4).ghost();
    }
    // wiring looms dangling from the crown
    b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.3, snow: 0.2 });
    for (let i = 0; i < 7; i++) {
      const a = r.range(-0.7, 0.7);
      const z0 = r.range(-8.9, -7.8);
      const top = hullAt(z0, a, 0.1);
      const lenW = r.range(0.4, 1.2);
      const end: V3 = [top[0] + r.range(-0.3, 0.3), Math.max(FLOOR_Y + 0.6, top[1] - lenW), top[2] + r.range(-0.4, 0.2)];
      b.pipe(Path.spline([top, [(top[0] + end[0]) / 2 + 0.05, (top[1] + end[1]) / 2 + 0.05, (top[2] + end[2]) / 2], end], 4), r.range(0.008, 0.016), { sides: 5 })
        .sway(top, 0.3).ghost();
    }

    // ======================================================================================
    // CABIN INTERIOR
    // ======================================================================================
    // ---- floor: panels with a torn rear edge, carpet, seat tracks ----
    b.ink({ color: hex(0x4b4e52), mat: MAT.PLASTIC, wear: 0.55, rough: 0.8, snow: 0 });
    const floorZ0 = Z_FLOOR_END - 0.15, floorLen = Z_BULK - floorZ0;
    const floor = b.box(3.1, 0.05, floorLen, { bevel: 0.006, rows: 1 }).move(0, FLOOR_Y - 0.025, floorZ0 + floorLen / 2);
    floor.warp((q) => {
      if (q.z < Z_FLOOR_END + 0.2) q.z = Math.max(q.z, Z_FLOOR_END - 0.15 + 0.22 * sat(0.5 + fbm3(S + 30, q.x * 2.5, 0, 0, 2)));
    });
    b.ink({ color: PAL.carpet, mat: MAT.CLOTH, wear: 0.6, rough: 0.95, snow: 0 });
    b.box(0.9, 0.012, floorLen - 0.4, { bevel: 0.003 }).move(0, FLOOR_Y + 0.006, floorZ0 + 0.2 + (floorLen - 0.4) / 2);
    b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.4, rough: 0.45, snow: 0 });
    for (const x of [-1.2, -0.62, 0.62, 1.2]) b.box(0.03, 0.008, floorLen - 0.3, { bevel: 0.002 }).move(x, FLOOR_Y + 0.004, floorZ0 + 0.15 + (floorLen - 0.3) / 2);

    // ---- dado panels: the vertical wall the hull collider stands for ----
    b.ink({ color: hex(0x8e8c84), mat: MAT.PLASTIC, wear: 0.45, rough: 0.6, snow: 0 });
    for (const side of [-1, 1]) for (let z = -7.6; z < Z_BULK - 0.01; z += 1.0) {
      const z1 = Math.min(Z_BULK, z + 1.0);
      if (side > 0 && z1 > 0.4 && z < 1.4) {
        // around the exit: pieces either side
        if (z < 0.4) b.box(0.02, DADO_TOP - FLOOR_Y, 0.4 - z, { bevel: 0.004 }).move(side * 1.565, (FLOOR_Y + DADO_TOP) / 2, (z + 0.4) / 2);
        if (z1 > 1.4) b.box(0.02, DADO_TOP - FLOOR_Y, z1 - 1.4, { bevel: 0.004 }).move(side * 1.565, (FLOOR_Y + DADO_TOP) / 2, (1.4 + z1) / 2);
        continue;
      }
      if (side > 0 && z > 5.3) continue; // the galley stands here
      b.box(0.02, DADO_TOP - FLOOR_Y, z1 - z - 0.004, { bevel: 0.004 }).move(side * 1.565, (FLOOR_Y + DADO_TOP) / 2, (z + z1) / 2);
      // an air return grille
      b.ink({ color: hex(0x3a3b3d), mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
      b.box(0.006, 0.07, 0.3, { bevel: 0.002 }).move(side * 1.552, FLOOR_Y + 0.13, (z + z1) / 2);
      b.ink({ color: hex(0x8e8c84), mat: MAT.PLASTIC, wear: 0.45, rough: 0.6, snow: 0 });
    }

    // ---- sidewall lining with window reveals ----
    // from the bins (y 2.22) down to where the lining meets the dado top at |x| 1.56
    const LA = [51.3, 60.25, 69.2, 73.775, 78.35, 82.925, 87.5, 99.4, 111.3].map((d) => d * DEG);
    b.ink({ color: hex(0xb3afa3), mat: MAT.PLASTIC, wear: 0.35, rough: 0.55, snow: 0 });
    const liningParts: Part[] = [];
    for (const side of [-1, 1]) {
      const cols = side > 0 ? LA : LA.map((a) => -a).reverse();
      const zr: number[] = [];
      for (let z = -7.6; z <= Z_BULK + 1e-6; z += 0.25) zr.push(Math.min(Z_BULK, z));
      for (let s = 0; s < zr.length - 1; s += 4) {
        const seg = zr.slice(s, Math.min(zr.length, s + 5));
        liningParts.push(surface(b, seg, cols, (z, a) => hullAt(z, a, 0.12), {
          flip: true,
          keep: (i, j) => {
            const zm = (seg[i] + seg[i + 1]) / 2, am = (cols[j] + cols[j + 1]) / 2;
            if (side > 0 && zm > 0.4 && zm < 1.4 && am > AT - 0.01) return false;
            if (side > 0 && zm > 5.3 && am > AB) return false;
            if (!isBelt(am, side)) return true;
            const bay = HULL.frame0 + HULL.pitch * Math.floor((zm - HULL.frame0) / HULL.pitch);
            return !hasWin(bay, side);
          },
        }));
      }
      for (const z0 of winBays) {
        if (!hasWin(z0, side) || z0 < -7.6) continue;
        const v0 = side > 0 ? AT : -AB, v1 = side > 0 ? AB : -AT;
        liningParts.push(holePatch(b, z0, z0 + HULL.pitch, v0, v1, z0 + HULL.pitch / 2, side * AW, WRU, WRV, (z, a) => hullAt(z, a, 0.12), { flip: true }));
      }
    }
    for (const lp of liningParts) lp.ghost();
    // reveals and shades
    b.ink({ color: hex(0xc4c0b4), mat: MAT.PLASTIC, wear: 0.3, rough: 0.5, snow: 0 });
    let reveals: Part | null = null;
    for (const w of winLoops) {
      if (w.z < -7.6) continue;
      const lp = loft(b, w.skinL, w.linL, null);
      // normals toward the window axis: seen from inside the tunnel
      lp.flip();
      lp.ghost();
      reveals = lp;
    }
    void reveals;
    b.ink({ color: hex(0xd0ccc0), mat: MAT.PLASTIC, wear: 0.3, rough: 0.6, snow: 0 });
    for (const w of winLoops) {
      if (w.z < -7.6 || !r.chance(0.45)) continue;
      // a shade pulled part-way down inside the reveal
      const drop = r.range(0.3, 1);
      const zA = w.z - WRU * 0.95, zB = w.z + WRU * 0.95;
      const aTop = w.side * (AW - WRV * 1.0), aBot = w.side * (AW - WRV + 2 * WRV * drop);
      surface(b, [zA, zB], [Math.min(aTop, aBot), Math.max(aTop, aBot)], (z, a) => hullAt(z, a, 0.1), { flip: true }).ghost();
    }

    // ---- overhead bins ----
    for (const side of [-1, 1]) {
      for (let z = -7.6; z < Z_BULK - 0.2; z += 1.0) {
        const len = Math.min(1.0, Z_BULK - 0.05 - z) - 0.02;
        const torn = side < 0 && z > -3.7 && z < -2.5; // the one that came down
        // section against the lining: bottom 2.22 (head room over the aisle edge), top 2.62
        const prof: P2[] = [[0.8, 2.22], [1.33, 2.22], [1.18, 2.45], [0.98, 2.62], [0.8, 2.62], [0.77, 2.42]];
        b.ink({ color: hex(0xbdb9ad), mat: MAT.PLASTIC, wear: 0.35, rough: 0.5, snow: 0 });
        const body = b.extrude(prof.map(([x, y]) => [side * x, y] as P2), len, { bevel: 0.012 }).rotX(-Math.PI / 2).move(0, 0, z + len / 2 + 0.01);
        // the door: hinged along its top edge
        const doorState = r.next();
        b.ink({ color: hex(0xcac6ba), mat: MAT.PLASTIC, wear: 0.3, rough: 0.45, snow: 0 });
        const door = b.box(0.025, 0.4, len - 0.02, { bevel: 0.008 });
        if (torn) {
          // whole bin hanging by its rear bracket, swung down over the seat row
          const g = [body, door];
          door.move(side * 0.775, 2.42, z + len / 2 + 0.01);
          for (const p of g) p.move(-side * 0.55, -2.62, -(z + 0.02)).rotX(0.5).rotZ(side * 0.3).move(side * 0.57, 2.6, z + 0.02);
        } else if (doorState < 0.35) {
          // open: up and out over the aisle
          door.move(0, -0.2, 0).rotZ(side * -1.35).move(side * 0.785, 2.62, z + len / 2 + 0.01);
        } else if (doorState < 0.5 && z > -6) {
          // one hinge gone: hangs twisted
          door.move(0, -0.2, 0).rotZ(side * -0.25).rotX(0.3).move(side * 0.785, 2.6, z + len / 2 + 0.01);
        } else door.rotZ(side * 0.07).move(side * 0.775, 2.42, z + len / 2 + 0.01);
        // passenger service unit under the bin: reading lights, vents, the mask hatch
        b.ink({ color: hex(0x9f9c92), mat: MAT.PLASTIC, wear: 0.35, snow: 0 });
        if (!torn) b.box(0.42, 0.02, len - 0.04, { bevel: 0.004 }).move(side * 1.03, 2.21, z + len / 2 + 0.01);
      }
    }
    // dropped oxygen masks over the seat rows (yellow cups on clear tubes)
    for (const sb of bp.boxes.filter((x) => x.tag === 'seat')) {
      const side = Math.sign(sb.x);
      for (let i = 0; i < 3; i++) {
        if (!r.chance(0.7)) continue;
        const x = side * (0.9 + i * 0.14), z = sb.z + r.range(-0.1, 0.12);
        const drop = r.range(0.4, 0.7);
        b.ink({ color: hex(0xc9ccc6), mat: MAT.PLASTIC, rough: 0.2, wear: 0.2, snow: 0 });
        b.cable([x, 2.2, z], [x + r.range(-0.05, 0.05), 2.2 - drop, z + r.range(-0.05, 0.05)], 0.0, 0.0035, { segs: 2, sides: 4 }).sway([x, 2.2, z], 0.2);
        b.ink({ color: hex(0xb59a2c), mat: MAT.PLASTIC, rough: 0.5, wear: 0.3, snow: 0 });
        // the cup: narrow end on the tube, the open face down
        b.cone(0.045, 0.06, { sides: 8, bevel: 0.004 }).move(x, 2.2 - drop - 0.03, z).sway([x, 2.2, z], 0.2);
      }
    }
    // ceiling: a shallow vault between the bins, panels down near the break
    b.ink({ color: hex(0xc2beb2), mat: MAT.PLASTIC, wear: 0.3, rough: 0.55, snow: 0 });
    {
      const zr: number[] = [];
      for (let z = -7.3; z <= Z_BULK + 1e-6; z += 1.0) zr.push(Math.min(Z_BULK, z));
      const ceil = surface(b, zr, steps(-0.8, 0.8, 6), (z, x) => [x, 2.75 - 0.08 * x * x, z], { flip: true });
      ceil.ghost();
      // two fallen panels near the break, hanging on one edge
      for (const z of [-7.9, -6.9]) {
        const pn = b.box(0.95, 0.012, 0.95, { bevel: 0.003 });
        pn.move(0.47, 0, 0).rotZ(r.range(-1.0, -0.65)).move(-0.47 + r.range(-0.08, 0.08), 2.72, z + 0.45);
      }
    }

    // ---- seats, exactly in their boxes ----
    for (const sb of bp.boxes.filter((x) => x.tag === 'seat')) {
      const g = b.group(() => seatUnit(b, { n: 2, pitch: 0.62, snow: 0, damage: sb.z < 0 ? 0.6 : 0.35, recline: [r.range(0.08, 0.28), r.range(0.08, 0.3)], bare: sb.z < 0 && r.chance(0.5) ? [0] : [] }));
      g.move(sb.x, FLOOR_Y, sb.z);
    }
    // seat rows that were torn out: empty track fittings, a loose cushion
    b.ink({ color: PAL.seatBlue, mat: MAT.CLOTH, wear: 0.6, snow: 0 });
    b.pillow(0.5, 0.1, 0.44, { round: 0.035, bulge: 0.01, seg: 1, ring: 1 }).rotY(0.7).rotZ(0.2).move(-0.4, FLOOR_Y + 0.06, -5.6);
    b.pillow(0.5, 0.1, 0.44, { round: 0.035, bulge: 0.01, seg: 1, ring: 1 }).rotY(-0.3).move(1.0, FLOOR_Y + 0.05, -3.4);

    // ---- bulkhead: locker, cockpit door, galley ----
    {
      const pts: P2[] = [];
      for (const a of steps(-111.3 * DEG, 111.3 * DEG, 24)) {
        const q = hullAt(Z_BULK, a, 0.1);
        pts.push([q[0], q[1]]);
      }
      pts.push([1.56, FLOOR_Y], [-1.56, FLOOR_Y]);
      b.ink({ color: hex(0xa9a597), mat: MAT.PLASTIC, wear: 0.4, rough: 0.55, snow: 0 });
      // its cabin face on the collider face, z 6.30
      b.extrude(pts.map(([x, y]) => [x, y] as P2), 0.06, { bevel: 0.01 }).rotX(-Math.PI / 2).move(0, 0, Z_BULK + 0.03);
    }
    // cockpit door: jammed shut, buckled
    b.ink({ color: hex(0x8a877c), mat: MAT.PAINT, wear: 0.45, snow: 0 });
    b.box(0.66, 1.85, 0.05, { bevel: 0.01, rows: 4 }).crumple(0.012, 3).move(-0.02, FLOOR_Y + 0.93, Z_BULK - 0.015);
    b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.3, rough: 0.35, snow: 0 });
    b.box(0.12, 0.025, 0.04, { bevel: 0.006 }).move(0.2, FLOOR_Y + 1.0, Z_BULK - 0.05);
    // crew locker, its door a named part
    const L0 = -1.56, L1 = -0.6, LZ = 5.85;
    b.ink({ color: hex(0x9a978c), mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
    b.box(L1 - L0, 2.0, 0.03, { bevel: 0.006 }).move((L0 + L1) / 2, FLOOR_Y + 1.0, Z_BULK - 0.015);
    b.box(0.03, 2.0, Z_BULK - LZ, { bevel: 0.006 }).move(L1, FLOOR_Y + 1.0, (LZ + Z_BULK) / 2);
    b.box(L1 - L0, 0.03, Z_BULK - LZ, { bevel: 0.006 }).move((L0 + L1) / 2, FLOOR_Y + 2.0, (LZ + Z_BULK) / 2);
    b.box(L1 - L0, 0.03, Z_BULK - LZ, { bevel: 0.006 }).move((L0 + L1) / 2, FLOOR_Y + 0.02, (LZ + Z_BULK) / 2);
    b.box(L1 - L0 - 0.04, 0.02, Z_BULK - LZ - 0.04, { bevel: 0.004 }).move((L0 + L1) / 2, FLOOR_Y + 1.3, (LZ + Z_BULK) / 2);
    b.part('locker_door', () => {
      b.ink({ color: hex(0xa8a599), mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
      b.box(L1 - L0 - 0.02, 1.96, 0.025, { bevel: 0.006 }).move((L0 + L1) / 2, FLOOR_Y + 1.0, LZ - 0.013);
      b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.3, rough: 0.35, snow: 0 });
      b.box(0.025, 0.14, 0.03, { bevel: 0.005 }).move(L1 - 0.08, FLOOR_Y + 1.05, LZ - 0.04);
    }, [L0 + 0.01, FLOOR_Y + 1.0, LZ - 0.013], { axis: [0, 1, 0], open: 1.75 });
    // galley: worktop at 1.26, trolley bays, cabinets above
    {
      const gb = bp.boxes.find((x) => x.tag === 'galley')!;
      const x0 = gb.x - gb.hx, x1 = gb.x + gb.hx, z0 = gb.z - gb.hz, z1 = gb.z + gb.hz;
      b.ink({ color: hex(0x9fa1a0), mat: MAT.METAL, wear: 0.35, rough: 0.35, snow: 0 });
      b.box(x1 - x0, gb.y1 - gb.y0 - 0.04, z1 - z0, { bevel: 0.01 }).move((x0 + x1) / 2, (gb.y0 + gb.y1) / 2 - 0.02, (z0 + z1) / 2);
      b.ink({ color: hex(0x6f7173), mat: MAT.METAL, wear: 0.4, rough: 0.4, snow: 0 });
      b.box(x1 - x0 + 0.02, 0.04, z1 - z0 + 0.02, { bevel: 0.006 }).move((x0 + x1) / 2, gb.y1 - 0.02, (z0 + z1) / 2);
      // trolley bay doors and latches on the aisle face
      b.ink({ color: hex(0x8d8f8e), mat: MAT.METAL, wear: 0.4, rough: 0.4, snow: 0 });
      for (const zz of [z0 + 0.22, z1 - 0.22]) b.box(0.01, 0.75, 0.4, { bevel: 0.004 }).move(x0 - 0.005, gb.y0 + 0.45, zz);
      b.ink({ color: PAL.toolRed, mat: MAT.PAINT, wear: 0.4, snow: 0 });
      for (const zz of [z0 + 0.22, z1 - 0.22]) b.box(0.02, 0.05, 0.03, { bevel: 0.004 }).move(x0 - 0.015, gb.y0 + 0.78, zz + 0.12);
      b.ink({ color: hex(0xa9a597), mat: MAT.PLASTIC, wear: 0.35, snow: 0 });
      b.box(x1 - x0, 0.55, 0.35, { bevel: 0.01 }).move((x0 + x1) / 2, 2.05, Z_BULK - 0.175);
    }

    // ---- wreckage spilled out of the break: the floor's torn end bent down, cables, a cushion ----
    b.ink({ color: hex(0x4b4e52), mat: MAT.PLASTIC, wear: 0.6, rough: 0.8, snow: 1 });
    {
      const fp = b.box(1.4, 0.04, 1.1, { bevel: 0.006, rows: 3 });
      fp.move(0, 0, -0.55).rotX(-0.42).crumple(0.03, 2.5).move(0.55, FLOOR_Y - 0.05, Z_FLOOR_END - 0.18);
      b.ink({ color: PAL.carpet, mat: MAT.CLOTH, wear: 0.6, snow: 1 });
      b.box(0.8, 0.01, 0.9, { bevel: 0.003, rows: 2 }).move(0, 0, -0.5).rotX(-0.45).crumple(0.02, 3).move(0.4, FLOOR_Y - 0.02, Z_FLOOR_END - 0.2);
    }
    b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.4, snow: 1 });
    for (let i = 0; i < 4; i++) {
      const x0 = r.range(-1.2, 1.2), y0 = r.range(0.25, 0.4);
      b.pipe(Path.spline([[x0, y0, -8.3], [x0 + r.range(-0.3, 0.3), 0.08, -9.3], [x0 + r.range(-0.6, 0.6), 0.02, -10.2 - r.range(0, 0.8)]], 4), r.range(0.008, 0.015), { sides: 5 }).ghost();
    }
    b.ink({ color: PAL.seatBlue, mat: MAT.CLOTH, wear: 0.6, snow: 1 });
    b.pillow(0.5, 0.1, 0.44, { round: 0.035, bulge: 0.01, seg: 1, ring: 1 }).rotY(1.1).rotZ(0.15).move(-1.1, 0.04, -10.4);
    b.ink({ color: hex(0x7b7d6f), mat: MAT.CLOTH, wear: 0.55, snow: 1 });
    b.cloth(0.6, 0.5, { nx: 5, ny: 4, wrinkle: 0.03, tear: 0.6, thickness: 0.02 }).rotX(-Math.PI / 2 + 0.1).rotY(0.5).move(1.5, 0.05, -10.0).ghost();

    // ---- snow blown in through the break ----
    snowHeap(b, [0.1, 0.0, -8.75], 1.5, 0.24, 0.65, 0.05);
    drift(b, [[-0.2, FLOOR_Y - 0.07, -8.05], [0.1, FLOOR_Y - 0.08, -7.2], [0.3, FLOOR_Y - 0.09, -6.2]], 1.5, 0.11, { lee: 0.3, noise: 0.015 });

    // ======================================================================================
    // COCKPIT (seen through the crazed windscreen; not enterable)
    // ======================================================================================
    b.ink({ color: hex(0x2e3033), mat: MAT.PLASTIC, wear: 0.4, rough: 0.6, snow: 0 });
    b.box(2.3, 0.05, 1.9, { bevel: 0.01 }).move(0, 0.62, 7.45);
    b.box(1.9, 0.5, 0.12, { bevel: 0.02 }).rotX(-0.35).move(0, 1.35, 7.95);
    b.ink({ color: hex(0x1d1e20), mat: MAT.PLASTIC, wear: 0.35, rough: 0.7, snow: 0 });
    b.box(1.95, 0.08, 0.35, { bevel: 0.02 }).move(0, 1.62, 7.85);
    b.box(0.35, 0.55, 0.6, { bevel: 0.02 }).move(0, 0.9, 7.55);
    for (const sx of [-0.55, 0.55]) {
      b.ink({ color: hex(0x3a3631), mat: MAT.CLOTH, wear: 0.45, snow: 0 });
      b.pillow(0.5, 0.12, 0.5, { round: 0.04, bulge: 0.01, seg: 1, ring: 1 }).move(sx, 1.0, 7.1);
      b.pillow(0.5, 0.75, 0.12, { round: 0.04, bulge: 0.01, seg: 1, ring: 1 }).rotX(-0.2).move(sx, 1.45, 6.8);
      b.ink({ color: hex(0x252628), mat: MAT.PLASTIC, wear: 0.3, snow: 0 });
      b.box(0.04, 0.35, 0.04, { bevel: 0.006 }).rotX(0.3).move(sx, 1.15, 7.62);
      b.box(0.28, 0.04, 0.05, { bevel: 0.01 }).move(sx, 1.33, 7.66);
    }
    // windscreen: framed panes, crazed
    b.ink({ color: hex(0x1b1c1e), mat: MAT.PAINT, wear: 0.4, snow: 0.8 });
    const cockpitCells: [number, number, number, number][] = [];
    for (const s of [-1, 1]) {
      cockpitCells.push([7.1, 7.7, s > 0 ? WS_FRONT[0] : -WS_FRONT[1], s > 0 ? WS_FRONT[1] : -WS_FRONT[0]]);
      cockpitCells.push([6.5, 7.1, s > 0 ? WS_SIDE[0] : -WS_SIDE[1], s > 0 ? WS_SIDE[1] : -WS_SIDE[0]]);
    }
    for (const [z0, z1, a0, a1] of cockpitCells) {
      const loop: P2[] = [[z0, a0], [z1, a0], [z1, a1], [z0, a1]];
      const o = loop.map(([z, a]) => skin(z, a, -0.006));
      const i2 = loop.map(([z, a]) => skin(z, a, 0.07));
      loft(b, o, i2).ghost();
    }
    b.ink({ color: hex(0x6d7a80), mat: MAT.GLASS, rough: 0.1, wear: 0.9, snow: 0.6 });
    for (const [z0, z1, a0, a1] of cockpitCells) surface(b, [z0 + 0.01, z1 - 0.01], [a0 + 0.005, a1 - 0.005], (z, a) => skin(z, a, 0.02)).ghost();
    // the crazing: a web of white cracks from an impact point on each front pane
    b.ink({ color: hex(0xb9c3c7), mat: MAT.ICE, rough: 0.3, wear: 0.2, snow: 0 });
    for (const s of [-1, 1]) {
      const cz = r.range(7.25, 7.55), ca = s * r.range(WS_FRONT[0] + 0.12, WS_FRONT[1] - 0.12);
      for (let k = 0; k < 11; k++) {
        const ang = (k / 11) * Math.PI * 2 + r.range(-0.2, 0.2);
        let zz = cz, aa = ca;
        const pts: V3[] = [skin(zz, aa, 0.012)];
        for (let st = 0; st < 4; st++) {
          zz += Math.cos(ang + r.range(-0.4, 0.4)) * 0.07;
          aa += (Math.sin(ang + r.range(-0.4, 0.4)) * 0.07) / 1.5;
          if (zz < 7.12 || zz > 7.68 || Math.abs(aa) < WS_FRONT[0] + 0.01 || Math.abs(aa) > WS_FRONT[1] - 0.01) break;
          pts.push(skin(zz, aa, 0.012));
        }
        if (pts.length > 1) b.pipe(pts, 0.0016, { sides: 3 }).ghost();
      }
    }

    // ======================================================================================
    // OUTSIDE DETAILS
    // ======================================================================================
    // wing-to-body fairings low on both sides, the left wing root torn off
    b.ink({ color: LIVERY_GREY(), mat: MAT.PAINT, wear: 0.6, snow: 1 });
    for (const side of [-1, 1]) {
      const fair = surface(b, steps(-2.4, 2.8, 8), steps(side > 0 ? 112 * DEG : -150 * DEG, side > 0 ? 150 * DEG : -112 * DEG, 5), (z, a) => {
        const bulge = 0.16 * Math.sin(Math.PI * sat((z + 2.4) / 5.2)) * Math.sin(Math.PI * sat((Math.abs(a) - 112 * DEG) / (38 * DEG)));
        return hullAt(z, a, -0.01 - bulge);
      });
      paintSkin(fair, S + 7, { scrape: 1.4 });
    }
    // the stub of the left wing: spar and torn skin standing out of the fairing
    b.ink({ color: PAL.liveryGrey, mat: MAT.PAINT, wear: 0.7, snow: 1 });
    {
      const stub = b.box(0.55, 0.32, 2.3, { bevel: 0.02, rows: 3 });
      stub.warp((q) => {
        const t = (q.x + 0.275) / 0.55;
        q.y += 0.05 * Math.sin(q.z * 3.1) * t;
        q.z += 0.12 * fbm3(S + 40, q.y * 4, q.z * 3, 0, 2) * t;
      });
      stub.crumple(0.03, 3).move(-1.95, 0.32, 0.3);
      b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.7, snow: 0.6 });
      b.box(0.5, 0.26, 0.06, { bevel: 0.01 }).rotY(0.05).move(-2.05, 0.33, 0.15);
      b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.6, snow: 0.6 });
      for (let i = 0; i < 6; i++) {
        const z = -0.7 + i * 0.4 + r.range(-0.1, 0.1);
        b.box(r.range(0.2, 0.5), 0.004, r.range(0.12, 0.3), { bevel: 0.001 }).crumple(0.03, 6).rotZ(r.range(-0.6, 0.6)).move(-2.25 - r.range(0, 0.15), 0.45 + r.range(-0.1, 0.1), z);
      }
    }
    // the exit hatch, thrown out onto the right wing
    b.ink({ color: PAL.liveryWhite, mat: MAT.PAINT, wear: 0.5, snow: 1 });
    {
      const h = surface(b, steps(-0.48, 0.48, 3), steps(-0.36, 0.36, 4), (z, a) => [a * 1.8 * 0.95, 0.12 * Math.cos(a), z]);
      h.rotY(0.4).rotZ(0.06).move(2.75, 0.47, 0.55);
      b.ink({ color: hex(0x9e9a8f), mat: MAT.PLASTIC, wear: 0.4, snow: 0.3 });
      b.box(0.62, 0.025, 0.85, { bevel: 0.006 }).rotY(0.4).move(2.75, 0.5, 0.55);
    }
    // the forward passenger door outline on the left, its handle; antennas; the beacon
    b.ink({ color: hex(0x262729), mat: MAT.RUBBER, wear: 0.4, snow: 1 });
    {
      const loop: P2[] = [[4.95, -60 * DEG], [5.75, -60 * DEG], [5.75, -117 * DEG], [4.95, -117 * DEG]];
      for (let i = 0; i < 4; i++) {
        const a0 = loop[i], a1 = loop[(i + 1) % 4];
        b.pipe(steps(0, 1, 6).map((t) => skin(a0[0] + (a1[0] - a0[0]) * t, a0[1] + (a1[1] - a0[1]) * t, -0.002)), 0.006, { sides: 4 }).ghost();
      }
    }
    b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.4, rough: 0.35, snow: 1 });
    b.box(0.03, 0.16, 0.05, { bevel: 0.008 }).rotZ(-0.6).move(...hullAtV(5.55, -98 * DEG, -0.02));
    b.ink({ color: hex(0x2c2d2f), mat: MAT.PAINT, wear: 0.5, snow: 1 });
    for (const [z, a] of [[3.2, 0], [-4.5, 0.05]] as [number, number][]) {
      const p = hullAtV(z, a, 0);
      b.extrude([[0, -0.12], [0.03, -0.1], [0.03, 0.12], [0, 0.14], [-0.03, 0.1], [-0.03, -0.1]], 0.22, { bevel: 0.006 }).rotX(-0.25).move(p[0], p[1] + 0.1, p[2]);
    }
    b.ink({ color: hex(0x5a1612), mat: MAT.PLASTIC, rough: 0.2, wear: 0.4, snow: 0.6 });
    {
      const p = hullAtV(0.2, 0, 0);
      b.dome(0.06, 0.07, 10).move(p[0], p[1], p[2]);
    }

    // ---- snow banked against the hull: it seats the tube in the terrain ----
    drift(b, [[-2.25, 0, -8.2], [-2.35, 0, -4], [-2.3, 0, 0], [-2.2, 0, 4], [-1.9, 0, 7.6]], 1.6, 0.55, { lee: -0.5 });
    drift(b, [[2.25, 0, -8.2], [2.3, 0, -4.5], [2.2, 0, -1.6]], 1.4, 0.4, { lee: 0.4 });
    drift(b, [[2.15, 0, 2.6], [2.25, 0, 5.2], [1.9, 0, 7.8]], 1.4, 0.45, { lee: 0.4 });
    // the snow the nose ploughed up as it came to rest, banked against it
    snowHeap(b, [0.1, 0, 9.5], 1.95, 1.2, 1.15, 0.2);
    drift(b, [[-2.1, 0, 8.4], [0, 0.1, 9.9], [2.1, 0, 8.6]], 1.6, 0.55);
    drift(b, [[-1.6, 0, -9.6], [0, 0.06, -9.75], [1.6, 0, -9.6]], 1.9, 0.2, { lee: 0.6, noise: 0.03 });
    // icicles under the torn crown, where the barrel's heat melts the snow on the roof
    for (let i = 0; i < 3; i++) {
      const a0 = -0.9 + i * 0.6 + r.range(-0.1, 0.1), a1 = a0 + r.range(0.25, 0.45);
      const p0 = rear(0.02, a0), p1 = rear(0.02, a1);
      if (p0[1] > 2.3 && p1[1] > 2.3) icicles(b, p0, p1, { every: 0.06, len: [0.03, 0.32], r: 0.012 });
    }

    // ======================================================================================
    // LIGHT INSIDE
    // ======================================================================================
    const aps: Aperture[] = [
      { c: [0, 1.6, -8.95], n: [0, 0, 1], area: 8.5 },
      { c: [1.68, 1.1, 0.9], n: [-1, 0, 0], area: 1.4 },
    ];
    for (const w of winLoops) {
      const c = hullAt(w.z, w.side * AW, 0.05);
      aps.push({ c, n: [-w.side, 0, 0], area: 0.075, gain: 0.85 });
    }
    for (const [z0, z1, a0, a1] of cockpitCells) {
      const c = hullAt((z0 + z1) / 2, (a0 + a1) / 2, 0.04);
      const n = hullAt((z0 + z1) / 2, (a0 + a1) / 2, 0.5);
      aps.push({ c, n: [n[0] - c[0], n[1] - c[1], n[2] - c[2]].map((x) => x / 0.46) as unknown as V3, area: 0.35, gain: 0.7 });
    }
    roomLight(b, (x, y, z, nx, ny, nz) => {
      if (z < -9.5 || z > 9.3 || y < 0.05) return false;
      const s = section(Math.min(z, HULL.TIP - 0.01));
      const dx = x / s.a, dy = (y - s.c) / s.b;
      const rr = Math.hypot(dx, dy);
      if (rr < 0.965) return true;
      // the inner face of the skin
      return rr < 1.01 && nx * dx + ny * dy < -0.2;
    }, aps, { base: 0.17, gain: 3.4 });

    // ---- anchors ----
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    return b.build({ ground: true, aoRadius: 0.18 });
  },
  { variants: 1, size: 'structure', desc: 'Flight 417: the forward fuselage, torn open at the wing root (blueprint fuselage)', tags: ['wreck'] },
);

function hullAtV(z: number, a: number, r: number): V3 {
  return hullAt(z, a, r);
}
function LIVERY_GREY() {
  return hex(0x8a8f93);
}
