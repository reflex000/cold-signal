// 'cabin': the ranger cabin (blueprint 'cabin': 6 x 5 m, walls 0.2 m thick on the centre lines
// x = +-2.9, z = +-2.4, 2.6 m tall; door gap x -1.6 .. -0.7 in the front wall; floor y 0.30;
// porch floor y 0.15 to z 3.9 on two posts at x +-2.85).
// Saddle-notched log walls with pale chinking, log ends standing out at the corners; board and
// batten gables; a ribbed steel roof (ridge along X, rust weeping from the screws) that runs on
// over the porch at a shallower pitch, icicles along both eaves; a stovepipe through the back slope.
// Inside, in the blueprint's furniture boxes: the box stove on its hearth with a heat shield, the
// log bunk bed (lower bunk in the box, upper bunk above), the table under the front window with a
// chair, two shelves of tins and jars, the rifle pegs, the cupboard (two doors), a hanging lantern,
// snowshoes, a wood box. Dark inside by day except at the windows; warm windows while the stove
// burns (part 'glow').
// Parts: 'door' (hinged, swings in), 'cupboard_door', 'cupboard_door2', 'glow'.
// Emitters: smoke at the chimney cap (source 'stove'), light at the lantern.
import { Builder, MAT, PAL, Path, fbm3, hex, mixRGB, type Part, type V3 } from '../kit';
import { register } from '../registry';
import { BLUEPRINTS } from '../../world/blueprints';
import { beam, casing, drift, icicles, mergeAll, roomLight, sash, sheet, snowHeap, type Aperture } from './lib';

const LOG_R = 0.125, COURSE = 0.225;
const WALL_X = 2.9, WALL_Z = 2.4, WALL_TOP = 2.6;
const RIDGE_Y = 4.1, EAVE_BACK_Z = -2.95;
const roofY = (z: number): number => (z <= 0 ? RIDGE_Y - (1.48 / 2.5) * -z : z <= 2.55 ? RIDGE_Y - (1.48 / 2.5) * z : 2.59 - (z - 2.55) * Math.tan(15 * Math.PI / 180));

register(
  'cabin',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.cabin;
    const S = r.int(0, 1 << 20);
    const logBark = PAL.timberDark;
    // old peeled logs go grey with weather, brown only in the checks and toward the ground
    const weathered = mixRGB(mixRGB(PAL.timberDark, PAL.deadwood, 0.45), PAL.barkGrey, 0.25);
    const logInk = () => b.ink({ color: weathered, mat: MAT.WOOD, wear: 0.6, snow: 1, vary: 0.1 });
    // one wall log from a to c (horizontal), sawn ends, hewn and weathered
    const wallLog = (a: V3, c: V3, rr = LOG_R): Part => {
      const len = Math.hypot(c[0] - a[0], c[2] - a[2]);
      logInk();
      const p = b.log(len, rr * r.range(0.93, 1.07), { r2: rr * r.range(0.86, 0.95), sides: 8, rows: Math.max(2, Math.round(len / 1.4)), ends: ['saw', 'saw'], bend: r.range(0, 0.012), gnarl: 0.006, peel: 0.97, knots: r.int(0, 2), bark: logBark, deadwood: weathered, wood: mixRGB(PAL.heartwood, PAL.timberDark, 0.45) });
      p.rotZ(Math.PI / 2).rotY(Math.atan2(-(c[2] - a[2]), c[0] - a[0])).move((a[0] + c[0]) / 2, a[1], (a[2] + c[2]) / 2);
      return p;
    };
    // the openings of the front and east walls, as [from, to] along the wall and [y0, y1]
    const door = bp.openings.find((o) => o.kind === 'door')!;
    const winF = bp.openings.find((o) => o.kind === 'window' && Math.abs(o.yaw) < 0.1)!;
    const winE = bp.openings.find((o) => o.kind === 'window' && Math.abs(o.yaw) > 0.1)!;
    const gaps = (wall: 'front' | 'east', y: number): [number, number][] => {
      const out: [number, number][] = [];
      if (wall === 'front') {
        if (y < door.y + door.h + 0.02) out.push([door.x - door.w / 2, door.x + door.w / 2]);
        if (y > winF.y - 0.05 && y < winF.y + winF.h + 0.05) out.push([winF.x - winF.w / 2, winF.x + winF.w / 2]);
      } else if (y > winE.y - 0.05 && y < winE.y + winE.h + 0.05) out.push([winE.z - winE.w / 2, winE.z + winE.w / 2]);
      return out;
    };
    // ---- log walls: front / back courses at k, sides interlocked half a course up ----
    const courses = 11;
    for (let k = 0; k < courses; k++) {
      const yb = 0.13 + k * COURSE, ys = yb + COURSE / 2;
      // back wall, whole
      wallLog([-WALL_X - 0.3 - r.range(0, 0.16), yb, -WALL_Z], [WALL_X + 0.3 + r.range(0, 0.16), yb, -WALL_Z]);
      // front wall, cut at the door and the window
      {
        let x0 = -WALL_X - 0.38;
        for (const [g0, g1] of gaps('front', yb).sort((a, c) => a[0] - c[0])) {
          if (g0 - x0 > 0.05) wallLog([x0, yb, WALL_Z], [g0, yb, WALL_Z]);
          x0 = g1;
        }
        wallLog([x0, yb, WALL_Z], [WALL_X + 0.38, yb, WALL_Z]);
      }
      if (ys + LOG_R > WALL_TOP + 0.08) continue;
      wallLog([-WALL_X, ys, -WALL_Z - 0.36], [-WALL_X, ys, WALL_Z + 0.36]);
      {
        let z0 = -WALL_Z - 0.36;
        for (const [g0, g1] of gaps('east', ys)) {
          if (g0 - z0 > 0.05) wallLog([WALL_X, ys, z0], [WALL_X, ys, g0]);
          z0 = g1;
        }
        wallLog([WALL_X, ys, z0], [WALL_X, ys, WALL_Z + 0.36]);
      }
    }
    // chinking between the courses: pale lime mortar
    b.ink({ color: hex(0x9b978b), mat: MAT.ROCK, wear: 0.3, rough: 0.95, snow: 1, vary: 0.06 });
    const chink = b.group(() => { for (let k = 0; k < courses - 1; k++) {
      const y = 0.13 + (k + 0.5) * COURSE;
      b.box(WALL_X * 2 - 0.1, 0.035, 0.16, { bevel: 0 }).move(0, y, -WALL_Z);
      let x0 = -WALL_X + 0.05;
      for (const [g0, g1] of gaps('front', y).sort((a, c) => a[0] - c[0])) {
        if (g0 - x0 > 0.05) b.box(g0 - x0, 0.035, 0.16, { bevel: 0 }).move((x0 + g0) / 2, y, WALL_Z);
        x0 = g1;
      }
      b.box(WALL_X - 0.05 - x0, 0.035, 0.16, { bevel: 0 }).move((x0 + WALL_X - 0.05) / 2, y + 0, WALL_Z);
      const ys = y + COURSE / 2;
      if (ys < WALL_TOP) {
        b.box(0.16, 0.035, WALL_Z * 2 - 0.1, { bevel: 0 }).move(-WALL_X, ys, 0);
        let z0 = -WALL_Z + 0.05;
        for (const [g0, g1] of gaps('east', ys)) {
          if (g0 - z0 > 0.05) b.box(0.16, 0.035, g0 - z0, { bevel: 0 }).move(WALL_X, ys, (z0 + g0) / 2);
          z0 = g1;
        }
        b.box(0.16, 0.035, WALL_Z - 0.05 - z0, { bevel: 0 }).move(WALL_X, ys, (z0 + WALL_Z - 0.05) / 2);
      }
    } });
    mergeAll(chink.parts);

    // stone piers under the sill logs at the corners
    b.ink({ color: PAL.rock, mat: MAT.ROCK, wear: 0.3, snow: 1 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rock(0.26, { detail: 1, rough: 0.5, facet: 0.5, flat: 0.5 }).move(sx * WALL_X, -0.08, sz * WALL_Z);

    // ---- door and window casings, the door ----
    b.ink({ color: mixRGB(PAL.timber, PAL.timberDark, 0.3), mat: MAT.WOOD, wear: 0.65, snow: 0.8, vary: 0.06 });
    for (const p of casing(b, door.w, door.h, 0.14, 0.27)) p.move(door.x, door.y + door.h / 2, WALL_Z);
    for (const p of casing(b, winF.w, winF.h, 0.12, 0.27)) p.move(winF.x, winF.y + winF.h / 2, WALL_Z);
    for (const p of casing(b, winE.w, winE.h, 0.12, 0.27)) p.rotY(Math.PI / 2).move(WALL_X, winE.y + winE.h / 2, winE.z);
    b.group(() => sash(b, winF.w - 0.04, winF.h - 0.04, { cols: 2, rows: 2, frame: PAL.timber })).move(winF.x, winF.y + winF.h / 2, WALL_Z - 0.04);
    b.group(() => sash(b, winE.w - 0.04, winE.h - 0.04, { cols: 2, rows: 2, frame: PAL.timber, broken: 0.25 })).rotY(Math.PI / 2).move(WALL_X - 0.04, winE.y + winE.h / 2, winE.z);
    // warm light behind the panes, shown while the stove burns
    b.part('glow', () => {
      b.ink({ color: PAL.lampWarm, mat: MAT.EMISSIVE, emissive: 1.1, snow: 0 });
      b.box(winF.w - 0.1, winF.h - 0.1, 0.004, { bevel: 0.001 }).move(winF.x, winF.y + winF.h / 2, WALL_Z - 0.075);
      b.box(0.004, winE.h - 0.1, winE.w - 0.1, { bevel: 0.001 }).move(WALL_X - 0.075, winE.y + winE.h / 2, winE.z);
    });
    // the threshold: a worn sill across the wall under the door, floor height inside
    b.ink({ color: mixRGB(PAL.timber, PAL.timberDark, 0.35), mat: MAT.WOOD, wear: 0.9, snow: 0.6 });
    b.plank(door.w + 0.06, 0.34, 0.06, { straight: true }).rotZ(Math.PI / 2).rotX(Math.PI / 2).move(door.x, door.y - 0.03, WALL_Z);
    const hingeX = door.x - door.w / 2 + 0.02;
    b.part('door', () => {
      b.ink({ color: mixRGB(PAL.timber, PAL.timberDark, 0.55), mat: MAT.WOOD, wear: 0.7, snow: 0, vary: 0.08 });
      const n = 5, bw = (door.w - 0.04) / n;
      for (let i = 0; i < n; i++) b.plank(door.h - 0.04, bw - 0.006, 0.045).move(hingeX + bw * (i + 0.5), door.y + door.h / 2, WALL_Z - 0.06);
      // ledges and brace on the inside face
      for (const y of [0.35, door.h - 0.35]) b.plank(door.w - 0.1, 0.13, 0.03, { straight: true }).rotZ(Math.PI / 2).move(hingeX + door.w / 2 - 0.02, door.y + y, WALL_Z - 0.1);
      const br = b.plank(Math.hypot(door.w - 0.2, door.h - 0.8), 0.12, 0.028, { straight: true });
      br.rotZ(Math.atan2(door.w - 0.2, door.h - 0.8)).move(hingeX + door.w / 2 - 0.02, door.y + door.h / 2, WALL_Z - 0.1);
      // strap hinges and the latch
      b.ink({ color: PAL.iron, mat: MAT.METAL, wear: 0.9, rough: 0.7, snow: 0 });
      for (const y of [0.3, door.h - 0.3]) b.box(0.42, 0.04, 0.008, { bevel: 0.002 }).move(hingeX + 0.2, door.y + y, WALL_Z - 0.035);
      b.box(0.03, 0.14, 0.03, { bevel: 0.006 }).move(hingeX + door.w - 0.14, door.y + 1.0, WALL_Z - 0.025);
    }, [hingeX, door.y, WALL_Z - 0.06], { axis: [0, 1, 0], open: 1.75 });

    // ---- floor and porch ----
    b.ink({ color: mixRGB(PAL.timber, PAL.plywood, 0.3), mat: MAT.WOOD, wear: 0.7, snow: 0, vary: 0.1 });
    const fl = bp.floors.find((f) => f.tag === 'floor')!;
    mergeAll(b.group(() => { for (let x = -2.78; x < 2.78; x += 0.16) b.plank(4.6, 0.155, 0.03, { straight: true }).rotX(Math.PI / 2).rotZ(r.range(-0.01, 0.01)).move(x + 0.08, fl.y - 0.015 + r.range(-0.003, 0.003), 0); }).parts);
    const po = bp.floors.find((f) => f.tag === 'porch')!;
    b.ink({ color: PAL.timber, mat: MAT.WOOD, wear: 0.75, snow: 0.7, vary: 0.1 });
    mergeAll(b.group(() => { for (let z = po.z - po.hz + 0.06; z < po.z + po.hz; z += 0.15) b.plank(po.hx * 2, 0.145, 0.035, { straight: true }).rotZ(Math.PI / 2).rotX(Math.PI / 2).move(0, po.y - 0.017 + r.range(-0.004, 0.004), z); }).parts);
    for (const x of [-2.6, 0, 2.6]) beam(b, [x, 0.05, po.z - po.hz], [x, 0.05, po.z + po.hz], 0.12, 0.1);
    // porch posts (peeled poles), beam, roof
    b.ink({ color: mixRGB(PAL.deadwood, PAL.timber, 0.5), mat: MAT.WOOD, wear: 0.6, snow: 1 });
    for (const p of bp.posts) {
      const pp = b.log(2.12, p.r, { r2: p.r * 0.9, sides: 9, rows: 4, ends: ['saw', 'saw'], peel: 1, deadwood: mixRGB(PAL.deadwood, PAL.timber, 0.5), gnarl: 0.004 });
      pp.move(p.x, 1.06, p.z);
    }
    beam(b, [-3.2, 2.19, 3.8], [3.2, 2.19, 3.8], 0.16, 0.14);

    // ---- gables (board and batten) ----
    b.ink({ color: mixRGB(PAL.timber, PAL.timberDark, 0.4), mat: MAT.WOOD, wear: 0.7, snow: 1, vary: 0.1 });
    for (const sx of [-1, 1]) mergeAll(b.group(() => {
      for (let z = -2.45; z < 2.45; z += 0.2) {
        const top = Math.min(roofY(z), roofY(z + 0.2)) - 0.05;
        if (top <= WALL_TOP + 0.05) continue;
        const h = top - WALL_TOP + 0.05;
        b.plank(h, 0.19, 0.025, { straight: true }).rotY(Math.PI / 2).move(sx * (WALL_X + 0.02), WALL_TOP + h / 2 - 0.02, z + 0.1);
      }
      for (let z = -2.25; z < 2.3; z += 0.4) {
        const top = roofY(z) - 0.06;
        if (top <= WALL_TOP + 0.1) continue;
        b.plank(top - WALL_TOP, 0.05, 0.02, { straight: true }).rotY(Math.PI / 2).move(sx * (WALL_X + 0.045), (top + WALL_TOP) / 2, z);
      }
    }).parts);

    // ---- roof: rafters, purlins, ribbed steel, ridge cap, fascia ----
    b.ink({ color: mixRGB(PAL.timber, PAL.timberDark, 0.5), mat: MAT.WOOD, wear: 0.6, snow: 0.4, vary: 0.08 });
    // under the sheets: they shelter nothing the sheets do not (ghost: cheaper bake)
    for (let x = -3.2; x <= 3.21; x += 0.8) {
      beam(b, [x, roofY(EAVE_BACK_Z) - 0.1, EAVE_BACK_Z], [x, RIDGE_Y - 0.1, 0], 0.07, 0.15).ghost();
      beam(b, [x, RIDGE_Y - 0.1, 0], [x, roofY(2.55) - 0.1, 2.55], 0.07, 0.15).ghost();
      beam(b, [x, roofY(2.55) - 0.1, 2.55], [x, roofY(3.98) - 0.1, 3.98], 0.07, 0.13).ghost();
    }
    for (const z of [-2.7, -1.8, -0.9, 0.9, 1.8, 2.45, 3.2, 3.9]) {
      const y = roofY(z) - 0.035;
      beam(b, [-3.35, y, z], [3.35, y, z], 0.08, 0.04).ghost();
    }
    // collar ties across the room
    for (const z of [-1.2, 1.2]) wallLog([-WALL_X, WALL_TOP + 0.02, z], [WALL_X, WALL_TOP + 0.02, z], 0.09);
    const steel = mixRGB(PAL.galvanised, hex(0x6d7276), 0.5);
    b.ink({ color: steel, mat: MAT.METAL, wear: 0.62, rough: 0.55, snow: 1, vary: 0.07 });
    const sheetRun = (z0: number, z1: number) => {
      const y0 = roofY(z0), y1 = roofY(z1);
      const len = Math.hypot(z1 - z0, y1 - y0) + 0.06;
      for (let x = -3.35, i = 0; x < 3.35; x += 0.84, i++) {
        const sh = sheet(b, 0.9, len, { kind: 'rib', pitch: 0.3, depth: 0.03, t: 0.0015 });
        // made in XY facing +Z, ribs along Y: lay it on the slope, ribs running downhill
        sh.rotX(-Math.PI / 2).rotX(-Math.atan((y1 - y0) / (z1 - z0))).move(x + 0.45, (y0 + y1) / 2 + 0.005 + (i % 2) * 0.004, (z0 + z1) / 2);
        sh.crumple(0.006, 1.2);
        sh.each((q) => {
          // rust weeps down from each row of screws and blooms toward the eave
          const toEave = Math.abs(q.z - (z1 > z0 ? z1 : z0)) / len;
          q.wear = 0.5 + 0.35 * Math.max(0, fbm3(S + i, q.x * 3, 0, q.z * 1.5, 2)) + 0.25 * (1 - toEave);
        });
      }
    };
    sheetRun(0, EAVE_BACK_Z);
    sheetRun(0, 2.55);
    sheetRun(2.55, 3.98);
    b.ink({ color: mixRGB(steel, PAL.rust, 0.3), mat: MAT.METAL, wear: 0.8, rough: 0.6, snow: 1 });
    {
      const cap = sheet(b, 0.3, 6.8, { kind: 'wave', pitch: 0.3, depth: 0.0, t: 0.0015 });
      cap.rotZ(Math.PI / 2).rotX(-Math.PI / 2).move(0, RIDGE_Y + 0.04, 0);
      cap.warp((q) => { q.y -= Math.abs(q.z) * 0.55; });
    }
    b.ink({ color: mixRGB(PAL.timber, PAL.timberDark, 0.4), mat: MAT.WOOD, wear: 0.7, snow: 1 });
    beam(b, [-3.38, roofY(EAVE_BACK_Z) - 0.05, EAVE_BACK_Z], [3.38, roofY(EAVE_BACK_Z) - 0.05, EAVE_BACK_Z], 0.03, 0.16);
    beam(b, [-3.38, roofY(3.98) - 0.05, 3.98], [3.38, roofY(3.98) - 0.05, 3.98], 0.03, 0.16);
    for (const sx of [-1, 1]) {
      beam(b, [sx * 3.38, roofY(EAVE_BACK_Z) - 0.04, EAVE_BACK_Z], [sx * 3.38, RIDGE_Y - 0.04, 0], 0.03, 0.17);
      beam(b, [sx * 3.38, RIDGE_Y - 0.04, 0], [sx * 3.38, roofY(2.55) - 0.04, 2.55], 0.03, 0.17);
      beam(b, [sx * 3.38, roofY(2.55) - 0.04, 2.55], [sx * 3.38, roofY(3.98) - 0.04, 3.98], 0.03, 0.15);
    }
    icicles(b, [-3.3, roofY(EAVE_BACK_Z) - 0.12, EAVE_BACK_Z - 0.02], [3.3, roofY(EAVE_BACK_Z) - 0.12, EAVE_BACK_Z - 0.02], { every: 0.19, len: [0.04, 0.55] });
    icicles(b, [-3.3, roofY(3.98) - 0.12, 4.0], [3.3, roofY(3.98) - 0.12, 4.0], { every: 0.2, len: [0.03, 0.4] });
    // a sign on the porch beam
    b.ink({ color: hex(0x3d3326), mat: MAT.WOOD, wear: 0.6, snow: 1 });
    b.box(1.5, 0.22, 0.035, { bevel: 0.008 }).move(-0.3, 1.97, 3.89);
    b.ink({ color: hex(0xc9bf9a), mat: MAT.PAINT, wear: 0.6, snow: 1 });
    b.stencil('RANGER STATION', 0.1, { align: 'center', weight: 0.16 }).move(-0.3, 1.92, 3.909);

    // ---- stove, pipe and chimney ----
    const st = bp.boxes.find((x) => x.tag === 'stove')!;
    const SY = fl.y;
    b.ink({ color: hex(0x7d776d), mat: MAT.ROCK, wear: 0.4, snow: 0 });
    b.box(0.95, 0.04, 1.0, { bevel: 0.01 }).move(st.x + 0.05, SY + 0.02, st.z + 0.08);
    b.ink({ color: PAL.iron, mat: MAT.METAL, wear: 0.75, rough: 0.7, snow: 0 });
    {
      const W = 0.58, D = 0.66, H = 0.55, legH = 0.2;
      const y0 = SY + 0.04 + legH;
      b.box(W, H, D, { bevel: 0.025 }).move(st.x, y0 + H / 2, st.z);
      b.box(W + 0.05, 0.035, D + 0.05, { bevel: 0.01 }).move(st.x, y0 + H + 0.017, st.z);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.cyl(0.025, legH, { sides: 6, r2: 0.032 }).move(st.x + dx * (W / 2 - 0.05), SY + 0.04 + legH / 2, st.z + dz * (D / 2 - 0.05));
      // the door with its mica window, the draft wheel
      b.box(0.4, 0.34, 0.03, { bevel: 0.008 }).move(st.x, y0 + 0.27, st.z + D / 2 + 0.015);
      b.ink({ color: hex(0x3a2a1c), mat: MAT.GLASS, rough: 0.2, wear: 0.6, snow: 0 });
      b.box(0.24, 0.16, 0.005, { bevel: 0.002 }).move(st.x, y0 + 0.3, st.z + D / 2 + 0.032);
      b.ink({ color: PAL.iron, mat: MAT.METAL, wear: 0.7, rough: 0.6, snow: 0 });
      b.cyl(0.04, 0.02, { sides: 10 }).rotX(Math.PI / 2).move(st.x - 0.12, y0 + 0.08, st.z + D / 2 + 0.035);
      b.box(0.12, 0.025, 0.04, { bevel: 0.008 }).move(st.x + 0.15, y0 + 0.32, st.z + D / 2 + 0.05);
      // kettle
      b.ink({ color: hex(0x5f5a50), mat: MAT.METAL, wear: 0.7, rough: 0.45, snow: 0 });
      b.lathe([[0, 0], [0.1, 0], [0.12, 0.06], [0.11, 0.13], [0.06, 0.17], [0, 0.18]], { sides: 12, smooth: true }).move(st.x + 0.12, y0 + H + 0.035, st.z + 0.12);
      b.pipe(Path.arc([st.x + 0.12, y0 + H + 0.2, st.z + 0.12], 0.08, 0, Math.PI, 6, [1, 0, 0], [0, 1, 0]), 0.006, { sides: 4 });
      // stovepipe: up from the flue collar, through the roof jack, rain cap at the chimney anchor
      const chim = bp.anchors.chimney;
      const top = y0 + H + 0.03;
      b.ink({ color: hex(0x26272a), mat: MAT.METAL, wear: 0.7, rough: 0.6, snow: 0 });
      b.cyl(0.078, chim.y - top - 0.2, { sides: 12, rows: 3 }).move(st.x, (top + chim.y - 0.2) / 2, st.z - 0.12);
      for (let y = top + 0.4; y < chim.y - 0.4; y += 0.6) b.torus(0.08, 0.006, { segs: 12, sides: 3 }).move(st.x, y, st.z - 0.12);
      b.ink({ color: mixRGB(steel, PAL.rust, 0.25), mat: MAT.METAL, wear: 0.75, snow: 1 });
      b.cone(0.26, 0.3, { sides: 14 }).move(st.x, roofY(st.z - 0.12) + 0.12, st.z - 0.12);
      b.cone(0.2, 0.12, { sides: 12 }).move(st.x, chim.y + 0.05, st.z - 0.12);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        b.box(0.01, 0.12, 0.01, { bevel: 0.002 }).move(st.x + Math.cos(a) * 0.08, chim.y - 0.05, st.z - 0.12 + Math.sin(a) * 0.08);
      }
      b.emitter('smoke', [st.x, chim.y + 0.12, st.z - 0.12], { name: 'chimney', size: 0.1, source: 'stove' });
      // heat shield on standoffs behind the stove
      b.ink({ color: hex(0x55524b), mat: MAT.METAL, wear: 0.7, rough: 0.55, snow: 0 });
      b.box(1.0, 1.4, 0.012, { bevel: 0.003 }).move(st.x, SY + 0.9, -WALL_Z + LOG_R + 0.06);
      b.box(0.012, 1.4, 0.9, { bevel: 0.003 }).move(-WALL_X + LOG_R + 0.06, SY + 0.9, st.z + 0.05);
    }
    // wood box beside the stove
    b.ink({ color: PAL.timber, mat: MAT.WOOD, wear: 0.7, snow: 0 });
    b.box(0.42, 0.36, 0.4, { bevel: 0.01 }).move(-2.52, SY + 0.18, -1.0);
    b.ink({ color: PAL.bark, mat: MAT.BARK, wear: 0.5, snow: 0 });
    for (let i = 0; i < 5; i++) b.log(0.38, r.range(0.04, 0.06), { sides: 6, rows: 2, ends: ['saw', 'saw'], peel: 0.2 }).rotX(Math.PI / 2).move(-2.62 + (i % 3) * 0.1, SY + 0.4 + Math.floor(i / 3) * 0.08, -1.0);

    // ---- bunk bed ----
    {
      const bd = bp.boxes.find((x) => x.tag === 'bed')!;
      const x0 = bd.x - bd.hx, x1 = bd.x + bd.hx, z0 = bd.z - bd.hz, z1 = bd.z + bd.hz;
      b.ink({ color: mixRGB(PAL.deadwood, PAL.timber, 0.4), mat: MAT.WOOD, wear: 0.6, snow: 0 });
      for (const [px, pz] of [[x0 + 0.05, z0 + 0.05], [x1 - 0.05, z0 + 0.05], [x0 + 0.05, z1 - 0.05], [x1 - 0.05, z1 - 0.05]]) b.log(2.0, 0.055, { sides: 7, rows: 2, ends: ['saw', 'saw'], peel: 1, deadwood: mixRGB(PAL.deadwood, PAL.timber, 0.4) }).move(px, SY + 1.0, pz);
      for (const y of [SY + 0.38, SY + 1.42]) {
        for (const z of [z0 + 0.05, z1 - 0.05]) beam(b, [x0, y, z], [x1, y, z], 0.06, 0.12);
        for (const x of [x0 + 0.05, x1 - 0.05]) beam(b, [x, y, z0], [x, y, z1], 0.06, 0.12);
        for (let x = x0 + 0.2; x < x1 - 0.1; x += 0.3) b.plank(bd.hz * 2 - 0.1, 0.14, 0.025, { straight: true }).rotX(Math.PI / 2).move(x, y + 0.04, bd.z);
        b.ink({ color: hex(0x6b6553), mat: MAT.CLOTH, wear: 0.5, snow: 0 });
        b.pillow(x1 - x0 - 0.14, 0.12, bd.hz * 2 - 0.14, { round: 0.05, bulge: 0.015, seg: 2, ring: 1 }).move(bd.x, y + 0.12, bd.z);
        b.ink({ color: hex(0x4e4a44), mat: MAT.CLOTH, wear: 0.5, snow: 0 });
        const bl = b.cloth(1.3, 0.8, { nx: 10, ny: 6, billow: 0.0, wrinkle: 0.03, thickness: 0.012 });
        bl.rotX(-Math.PI / 2).move(0, 0, -0.4).warp((q) => { q.y += 0.03 * Math.sin(q.x * 6) * Math.cos(q.z * 5); }).move(bd.x + 0.15, y + 0.19, bd.z);
        b.ink({ color: hex(0x8a8476), mat: MAT.CLOTH, wear: 0.4, snow: 0 });
        b.pillow(0.45, 0.1, 0.32, { round: 0.04, bulge: 0.02, seg: 1, ring: 1 }).move(x0 + 0.32, y + 0.24, bd.z);
        b.ink({ color: mixRGB(PAL.deadwood, PAL.timber, 0.4), mat: MAT.WOOD, wear: 0.6, snow: 0 });
      }
    }

    // ---- table, chair ----
    {
      const tb = bp.boxes.find((x) => x.tag === 'table')!;
      const x0 = tb.x - tb.hx, x1 = tb.x + tb.hx, z0 = tb.z - tb.hz, z1 = tb.z + tb.hz;
      b.ink({ color: mixRGB(PAL.timber, PAL.pine, 0.25), mat: MAT.WOOD, wear: 0.65, snow: 0, vary: 0.08 });
      for (let z = z0; z < z1 - 0.01; z += 0.18) b.plank(x1 - x0, 0.175, 0.04).rotZ(Math.PI / 2).rotX(Math.PI / 2).move(tb.x, tb.y1 - 0.02, z + 0.09);
      for (const [px, pz] of [[x0 + 0.08, z0 + 0.08], [x1 - 0.08, z0 + 0.08], [x0 + 0.08, z1 - 0.08], [x1 - 0.08, z1 - 0.08]]) b.box(0.07, tb.y1 - tb.y0 - 0.04, 0.07, { bevel: 0.008 }).move(px, (tb.y0 + tb.y1 - 0.04) / 2, pz);
      beam(b, [x0 + 0.08, SY + 0.15, tb.z], [x1 - 0.08, SY + 0.15, tb.z], 0.05, 0.07);
      // a chair at the west end, half pushed in
      b.group(() => {
        b.box(0.42, 0.035, 0.42, { bevel: 0.006 }).move(0, 0.45, 0);
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.035, 0.45, 0.035, { bevel: 0.005 }).move(dx * 0.18, 0.225, dz * 0.18);
        for (const dz of [-1, 1]) b.box(0.035, 0.5, 0.035, { bevel: 0.005 }).move(-0.18, 0.7, dz * 0.18);
        b.box(0.03, 0.12, 0.4, { bevel: 0.005 }).move(-0.18, 0.88, 0);
        b.box(0.03, 0.08, 0.4, { bevel: 0.005 }).move(-0.18, 0.66, 0);
      }).rotY(0.25).move(x0 - 0.08, SY, tb.z - 0.05);
      // the lantern hanging over the table, a tin plate and mug
      b.ink({ color: PAL.iron, mat: MAT.METAL, wear: 0.6, snow: 0 });
      const lx = tb.x + 0.25, lz = tb.z + 0.1, ly = 2.3;
      b.cable([lx, WALL_TOP + 0.05, lz], [lx, ly + 0.22, lz], 0, 0.004, { segs: 1, sides: 4 });
      b.cyl(0.07, 0.03, { sides: 10 }).move(lx, ly - 0.12, lz);
      b.cyl(0.05, 0.03, { sides: 10 }).move(lx, ly + 0.12, lz);
      b.pipe(Path.arc([lx, ly + 0.14, lz], 0.07, 0, Math.PI, 6, [1, 0, 0], [0, 1, 0]), 0.004, { sides: 4 });
      b.ink({ color: hex(0x9a8f74), mat: MAT.GLASS, rough: 0.2, wear: 0.4, snow: 0 });
      b.lathe([[0.045, -0.1], [0.06, -0.04], [0.055, 0.04], [0.04, 0.1]], { sides: 10, smooth: true }).move(lx, ly, lz);
      b.part('glow_lamp', () => {
        b.ink({ color: PAL.lampWarm, mat: MAT.EMISSIVE, emissive: 3, snow: 0 });
        b.cyl(0.012, 0.03, { sides: 6 }).move(lx, ly - 0.02, lz);
      });
      b.emitter('light', [lx, ly, lz], { name: 'lantern', size: 0.06, color: PAL.lampWarm, intensity: 6, range: 7 });
      b.ink({ color: hex(0x6e6c66), mat: MAT.METAL, wear: 0.6, snow: 0 });
      b.cyl(0.11, 0.015, { sides: 14 }).move(tb.x + 0.55, tb.y1 + 0.008, tb.z - 0.15);
      b.ink({ color: hex(0x3f5a6e), mat: MAT.PAINT, wear: 0.7, snow: 0 });
      b.cyl(0.04, 0.09, { sides: 10 }).move(tb.x + 0.6, tb.y1 + 0.045, tb.z + 0.2);
    }

    // ---- shelves, the rifle pegs, the cupboard ----
    const tins = (x: number, y: number, z: number, along: 'x' | 'z', len: number, avoid: number[]) => mergeAll(b.group(() => {
      for (let s = -len / 2 + 0.05; s < len / 2 - 0.04; s += r.range(0.07, 0.14)) {
        if (avoid.some((a) => Math.abs(a - s) < 0.17)) continue;
        if (r.chance(0.25)) continue;
        const col = [hex(0x6e2a1e), hex(0x3c4a3a), hex(0x8a7a52), hex(0x2f3c52), hex(0x5c5a55)][r.int(0, 4)];
        const jar = r.chance(0.3);
        // jars are drawn opaque: merged with the tins they must stay in the opaque pass
        b.ink({ color: jar ? hex(0x6f7a6c) : col, mat: jar ? MAT.PLASTIC : MAT.PAINT, rough: jar ? 0.12 : 0.5, wear: 0.6, snow: 0 });
        const h = r.range(0.08, 0.16);
        const px = along === 'x' ? x + s : x, pz = along === 'z' ? z + s : z;
        b.cyl(r.range(0.03, 0.045), h, { sides: 7, bevel: 0.004 }).move(px, y + h / 2 + 0.002, pz);
      }
    }).parts)?.ghost();
    b.ink({ color: mixRGB(PAL.timber, PAL.pine, 0.2), mat: MAT.WOOD, wear: 0.6, snow: 0, vary: 0.08 });
    {
      const s1 = bp.boxes.find((x) => x.tag === 'shelf' && Math.abs(x.x) > 2)!;
      for (const y of [0.78, 1.34, 1.86]) b.plank(s1.hz * 2, s1.hx * 2 - 0.02, 0.03).rotX(Math.PI / 2).move(s1.x, y, s1.z);
      for (const dz of [-1, 1]) b.box(0.3, 1.6, 0.03, { bevel: 0.005 }).move(s1.x, SY + 0.8, s1.z + dz * (s1.hz - 0.02));
      const a1 = bp.anchors.shelf1, a2 = bp.anchors.shelf1b;
      tins(s1.x + 0.02, 1.355, s1.z, 'z', s1.hz * 2, [a1.z - s1.z, a2.z - s1.z]);
      tins(s1.x + 0.02, 1.875, s1.z, 'z', s1.hz * 2, []);
      tins(s1.x + 0.02, 0.795, s1.z, 'z', s1.hz * 2, []);
      b.ink({ color: mixRGB(PAL.timber, PAL.pine, 0.2), mat: MAT.WOOD, wear: 0.6, snow: 0, vary: 0.08 });
      const s2 = bp.boxes.find((x) => x.tag === 'shelf' && Math.abs(x.x) < 2)!;
      for (const y of [0.78, 1.34, 1.86]) b.plank(s2.hx * 2, s2.hz * 2 - 0.02, 0.03).rotZ(Math.PI / 2).rotX(Math.PI / 2).move(s2.x, y, s2.z);
      for (const dx of [-1, 1]) b.box(0.03, 1.6, 0.3, { bevel: 0.005 }).move(s2.x + dx * (s2.hx - 0.02), SY + 0.8, s2.z);
      tins(s2.x, 1.355, s2.z + 0.02, 'x', s2.hx * 2, [bp.anchors.shelf2.x - s2.x, bp.anchors.shelf2b.x - s2.x]);
      tins(s2.x, 1.875, s2.z + 0.02, 'x', s2.hx * 2, []);
      // rifle pegs
      b.ink({ color: PAL.timberDark, mat: MAT.WOOD, wear: 0.5, snow: 0 });
      const rk = bp.anchors.rack;
      for (const dx of [-0.3, 0.3]) b.cyl(0.018, 0.14, { sides: 6 }).rotX(Math.PI / 2 - 0.2).move(rk.x + dx, rk.y - 0.04, -WALL_Z + LOG_R + 0.06);
    }
    {
      const cb = bp.boxes.find((x) => x.tag === 'cupboard')!;
      const x0 = cb.x - cb.hx, x1 = cb.x + cb.hx, z0 = cb.z - cb.hz, z1 = cb.z + cb.hz;
      b.ink({ color: mixRGB(PAL.timberDark, hex(0x4a3d33), 0.5), mat: MAT.WOOD, wear: 0.6, snow: 0, vary: 0.06 });
      b.box(x1 - x0 - 0.03, cb.y1 - cb.y0, 0.025, { bevel: 0.005 }).move((x0 + x1) / 2 - 0.015, (cb.y0 + cb.y1) / 2, z0 + 0.012);
      b.box(x1 - x0 - 0.03, cb.y1 - cb.y0, 0.025, { bevel: 0.005 }).move((x0 + x1) / 2 - 0.015, (cb.y0 + cb.y1) / 2, z1 - 0.012);
      b.box(x1 - x0, 0.03, z1 - z0, { bevel: 0.006 }).move((x0 + x1) / 2, cb.y1 - 0.015, cb.z);
      b.box(x1 - x0 - 0.03, 0.025, z1 - z0 - 0.05, { bevel: 0.004 }).move((x0 + x1) / 2 - 0.015, cb.y0 + 0.55, cb.z);
      const dz = (z1 - z0) / 2 - 0.01;
      b.part('cupboard_door', () => {
        b.box(0.025, cb.y1 - cb.y0 - 0.06, dz, { bevel: 0.005 }).move(x1 - 0.012, (cb.y0 + cb.y1) / 2, z0 + 0.005 + dz / 2);
        b.ink({ color: PAL.iron, mat: MAT.METAL, wear: 0.6, snow: 0 });
        b.box(0.02, 0.08, 0.02, { bevel: 0.004 }).move(x1 + 0.01, cb.y0 + 0.75, z0 + dz - 0.05);
      }, [x1 - 0.012, cb.y0, z0 + 0.005], { axis: [0, 1, 0], open: 1.9 });
      b.ink({ color: mixRGB(PAL.timberDark, hex(0x4a3d33), 0.5), mat: MAT.WOOD, wear: 0.6, snow: 0, vary: 0.06 });
      b.part('cupboard_door2', () => {
        b.box(0.025, cb.y1 - cb.y0 - 0.06, dz, { bevel: 0.005 }).move(x1 - 0.012, (cb.y0 + cb.y1) / 2, z1 - 0.005 - dz / 2);
        b.ink({ color: PAL.iron, mat: MAT.METAL, wear: 0.6, snow: 0 });
        b.box(0.02, 0.08, 0.02, { bevel: 0.004 }).move(x1 + 0.01, cb.y0 + 0.75, z1 - dz + 0.05);
      }, [x1 - 0.012, cb.y0, z1 - 0.005], { axis: [0, 1, 0], open: -1.9 });
    }
    // snowshoes hanging inside the front wall
    b.ink({ color: hex(0x6b5638), mat: MAT.WOOD, wear: 0.6, snow: 0 });
    for (const dx of [-0.16, 0.16]) {
      const loop: V3[] = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        loop.push([0.18 + dx + Math.sin(a) * 0.13, 1.45 + Math.cos(a) * 0.38 * (Math.cos(a) > 0 ? 1 : 0.8), WALL_Z - LOG_R - 0.02]);
      }
      b.pipe(loop, 0.012, { sides: 5 });
    }

    // ---- snow drifts against the walls ----
    // banked against the walls (centred just outside each wall: the inner half hides under the floor)
    drift(b, [[-3.5, 0, -2.72], [0, 0, -2.8], [3.5, 0, -2.72]], 1.6, 0.72);
    drift(b, [[-3.12, 0, -2.6], [-3.18, 0, 0], [-3.12, 0, 2.7]], 1.3, 0.55);
    drift(b, [[3.12, 0, -2.4], [3.15, 0, 0.5], [3.1, 0, 2.6]], 1.1, 0.4);
    drift(b, [[-3.0, 0, 4.25], [0, 0, 4.35], [3.0, 0, 4.25]], 0.9, 0.22);
    snowHeap(b, [2.2, po.y - 0.06, 3.5], 0.8, 0.12, 0.35);

    // ---- light inside ----
    const aps: Aperture[] = [
      { c: [winF.x, winF.y + winF.h / 2, WALL_Z - 0.1], n: [0, 0, -1], area: winF.w * winF.h, gain: 0.8 },
      { c: [WALL_X - 0.1, winE.y + winE.h / 2, winE.z], n: [-1, 0, 0], area: winE.w * winE.h, gain: 0.8 },
      { c: [door.x, door.y + door.h / 2, WALL_Z - 0.1], n: [0, 0, -1], area: door.w * door.h, gain: 0.35 },
    ];
    roomLight(b, (x, y, z, nx, ny, nz) => {
      void nz;
      if (Math.abs(x) > WALL_X - LOG_R + 0.02 || Math.abs(z) > WALL_Z - LOG_R + 0.02) return false;
      if (y < 0.05) return false;
      // under the roof (the underside of the sheets and purlins face down)
      if (y > roofY(z) - 0.06) return ny < 0;
      return true;
    }, aps, { base: 0.12, gain: 3.0 });

    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    // a short occlusion reach: the contact shadows that matter here are between logs, boards and furniture
    return b.build({ ground: true, aoRadius: 0.16 });
  },
  { variants: 1, size: 'structure', desc: 'the ranger cabin: log walls, steel roof, porch, stove, bunks (blueprint cabin)', tags: ['cabin'] },
);
