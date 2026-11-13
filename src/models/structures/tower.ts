// The signal tower on the north ridge.
//
// 'tower_mast' (blueprint tower_mast: four legs at (+-1.5, -4.5) and (+-1.5, -1.5), r 0.15, the
// 6 x 6 m pickup deck at y 0.45 over z 0.5 .. 6.5 with a step at z 6.5 .. 7.1): a 30 m square
// lattice mast of galvanised tube legs, angle-iron girts and cross bracing, a caged ladder up the
// south face, a rest platform at 15 m, the top platform with a dish, two yagis and a whip;
// red obstruction lamps at 15 m and at the top (part 'lamps', lit by the driver once the
// generator holds charge); three guy levels to deadmen on the site pad. The deck: steel frame on
// piers, checker plate painted with a worn yellow H in a circle and hazard edges, tie-down rings,
// the pickup strobe on its post at the 'beacon' anchor (part 'beacon').
//
// 'tower_shed' (blueprint tower_shed: 3 x 4 m, walls 0.12 m on x +-1.44 / z +-1.94, 2.5 m tall,
// door gap x -0.45 .. 0.45, floor y 0.18): a steel-framed hut clad in corrugated galvanised sheet
// on a concrete slab, a shed roof, a wired-glass window. Inside: the transmitter cabinet in its
// box with the five module slots (anchors and parts 'slot_battery', 'slot_handset', 'slot_coil',
// 'slot_tube', 'slot_fuse': each part is the installed module, hidden until installed), meters,
// switches and the indicator lamps (part 'panel_lights'), a caged ceiling lamp lit with them; the
// workbench in its box; the steel locker (part 'locker_door') for the CrateEnt 'locker'.
// Part 'door' (steel, hinged at x -0.45, swings out).
//
// 'generator' (blueprint generator: concrete pad 2.2 x 1.6 m at y 0.12, the genset in its box,
// the crank on the front face at (0, 0.85, 0.2)): an olive drab hand-crank generator set on a
// channel skid: the dynamo housing, the gearbox with the crank axle, a flywheel guard, the control
// box with a charge meter, a cable run toward the shed. Parts 'crank' (turns about +Z through the
// axle) and 'needle' (the meter's needle, about +Z).
import { Builder, MAT, PAL, Path, fbm3, hex, mixRGB, type Part, type V3 } from '../kit';
import { register } from '../registry';
import { BLUEPRINTS } from '../../world/blueprints';
import { angle, drift, icicles, mergeAll, place, roomLight, sash, sheet, snowHeap, type Aperture } from './lib';

register(
  'tower_mast',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.tower_mast;
    const legs = bp.posts.map((p) => [p.x, p.z] as [number, number]);
    const H = 30, PANEL = 1.5;
    const cx = 0, cz = -3;
    const galv = mixRGB(PAL.galvanised, hex(0x7e8488), 0.4);
    // footings and base plates
    b.ink({ color: PAL.concrete, mat: MAT.ROCK, wear: 0.5, snow: 1 });
    for (const [x, z] of legs) b.cyl(0.15, 0.7, { sides: 12, bevel: 0.02 }).move(x, -0.2, z);
    b.ink({ color: galv, mat: MAT.METAL, wear: 0.65, rough: 0.5, snow: 1 });
    for (const [x, z] of legs) b.box(0.26, 0.02, 0.26, { bevel: 0.004 }).move(x, 0.16, z);
    // legs: tubes, lighter higher up, flanged joints every 6 m
    for (const [x, z] of legs) {
      for (let h = 0.16; h < H - 0.01; h += 6) {
        const h1 = Math.min(H, h + 6);
        const rr = h < 12 ? 0.07 : h < 24 ? 0.06 : 0.05;
        place(b.cyl(rr, h1 - h, { sides: 8, bevel: 0.004 }), [x, h, z], [x, h1, z]).ghost();
        place(b.cyl(rr + 0.03, 0.03, { sides: 8, bevel: 0.006 }), [x, h1 - 0.015, z], [x, h1 + 0.015, z]).ghost();
      }
    }
    // girts and X bracing in angle iron, every panel, all four faces (ghosts: a cheap bake)
    const faces: [[number, number], [number, number]][] = [[legs[0], legs[1]], [legs[1], legs[3]], [legs[3], legs[2]], [legs[2], legs[0]]];
    for (let h = PANEL; h <= H + 1e-6; h += PANEL) {
      const k = h > 24 ? 0.045 : 0.055;
      for (const [a, c] of faces) {
        const out: V3 = [((a[0] + c[0]) / 2 - cx), 0, ((a[1] + c[1]) / 2 - cz)];
        angle(b, [a[0], h, a[1]], [c[0], h, c[1]], k, 0.006, out).ghost();
        // the X below this girt
        angle(b, [a[0], h - PANEL, a[1]], [c[0], h, c[1]], k * 0.85, 0.005, out).ghost();
        angle(b, [c[0], h - PANEL, c[1]], [a[0], h, a[1]], k * 0.85, 0.005, out).ghost();
      }
    }
    // a cable tray up the north-east leg
    b.ink({ color: hex(0x6e7275), mat: MAT.METAL, wear: 0.6, snow: 1 });
    place(b.box(0.12, H - 1, 0.03, { bevel: 0.004 }), [1.38, 0.5, -4.42], [1.38, H - 0.5, -4.42]).ghost();
    // ladder up the south face, rails and rungs, a cage from 2.5 m
    b.ink({ color: galv, mat: MAT.METAL, wear: 0.6, snow: 1 });
    const lz = -1.5 + 0.28;
    for (const x of [-0.22, 0.22]) place(b.box(0.05, H, 0.012, { bevel: 0.003 }), [x, 0.15, lz], [x, H, lz]).ghost();
    const rungs = b.group(() => { for (let h = 0.4; h < H; h += 0.32) b.cyl(0.011, 0.44, { sides: 5 }).rotZ(Math.PI / 2).move(0, h, lz); });
    mergeAll(rungs.parts)?.ghost();
    const cage = b.group(() => {
      for (let h = 2.6; h < H - 0.5; h += 1.2) b.pipe(Path.arc([0, h, lz], 0.36, 0, Math.PI, 8, [1, 0, 0], [0, 0, 1]), 0.01, { sides: 4 });
      for (const a of [0.35, 1.2, 1.94, 2.79]) place(b.box(0.03, H - 3, 0.006, { bevel: 0.001 }), [Math.cos(a) * 0.36, 2.6, lz + Math.sin(a) * 0.36], [Math.cos(a) * 0.36, H - 0.5, lz + Math.sin(a) * 0.36]);
    });
    mergeAll(cage.parts)?.ghost();
    // platforms: grating at 15 m (rest) and at the top
    const grating = (y: number, ext: number) => {
      b.ink({ color: galv, mat: MAT.METAL, wear: 0.6, rough: 0.6, snow: 1 });
      b.box(3.0 + ext * 2, 0.04, 3.0 + ext * 2, { bevel: 0.006 }).move(cx, y, cz);
      b.ink({ color: hex(0xb08a2a), mat: MAT.PAINT, wear: 0.6, snow: 1 });
      for (const [x0, z0, x1, z1] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
        const e = 1.5 + ext;
        place(b.cyl(0.02, 1, { sides: 6 }).scale(1, e * 2, 1), [cx + x0 * e, y + 1.0, cz + z0 * e], [cx + x1 * e, y + 1.0, cz + z1 * e]).ghost();
        place(b.cyl(0.018, 1.0, { sides: 6 }), [cx + x0 * e, y, cz + z0 * e], [cx + x0 * e, y + 1.0, cz + z0 * e]).ghost();
      }
    };
    grating(15, 0.25);
    grating(H, 0.4);
    // top: dish, yagis, whip, lightning rod
    b.ink({ color: hex(0xc8c9c4), mat: MAT.PAINT, wear: 0.5, snow: 1 });
    {
      const dish = b.lathe([[0, -0.0], [0.25, 0.03], [0.45, 0.1], [0.5, 0.14], [0.49, 0.15], [0.44, 0.12], [0.24, 0.06], [0, 0.03]], { sides: 18, closed: true });
      dish.rotX(-Math.PI / 2 + 0.05).rotY(2.6).move(cx + 1.3, H - 1.2, cz - 1.0);
      b.ink({ color: galv, mat: MAT.METAL, wear: 0.6, snow: 1 });
      place(b.cyl(0.03, 1.4, { sides: 6 }), [cx + 1.5, H - 1.9, cz - 1.5], [cx + 1.5, H - 0.5, cz - 1.5]);
      for (const [yaw, y] of [[0.4, H - 2.2], [2.8, H - 3.4]]) {
        const yg = b.group(() => {
          b.cyl(0.015, 1.8, { sides: 6 }).rotZ(Math.PI / 2);
          for (let i = 0; i < 6; i++) b.cyl(0.006, 0.5 - i * 0.04, { sides: 4 }).rotX(Math.PI / 2).move(-0.8 + i * 0.32, 0, 0);
        });
        yg.rotY(yaw).move(cx + Math.cos(yaw) * 2.4, y, cz - Math.sin(yaw) * 2.4);
      }
      b.cyl(0.04, 4.5, { sides: 8, r2: 0.012 }).move(cx - 1.2, H + 2.25, cz + 1.2);
      b.cyl(0.01, 2.0, { sides: 5 }).move(cx + 1.4, H + 1.0, cz - 1.4);
    }
    // obstruction lamps: dark red lenses always; the lit lenses in part 'lamps'
    const lampAt: V3[] = [[1.55, H + 0.15, -1.45], [-1.55, H + 0.15, -4.55], [1.55, 15.15, -4.55], [-1.55, 15.15, -1.45]];
    for (const p of lampAt) {
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.5, snow: 1 });
      b.cyl(0.07, 0.12, { sides: 10 }).move(p[0], p[1] - 0.08, p[2]);
      b.ink({ color: hex(0x4a0e0a), mat: MAT.PLASTIC, rough: 0.2, wear: 0.3, snow: 0.5 });
      b.dome(0.075, 0.13, 10).move(p[0], p[1] - 0.02, p[2]);
      b.emitter('beacon', [p[0], p[1] + 0.05, p[2]], { name: 'lamp_red', size: 0.08, color: PAL.beaconRed });
    }
    b.part('lamps', () => {
      b.ink({ color: PAL.beaconRed, mat: MAT.EMISSIVE, emissive: 18, snow: 0 });
      for (const p of lampAt) b.dome(0.077, 0.132, 10).move(p[0], p[1] - 0.021, p[2]);
    });
    // guys: three levels to three deadmen on the pad (NW, NE, S)
    const deadmen: V3[] = [[-6.4, 0, -9.4], [6.4, 0, -9.4], [1.5, 0, 9.5]];
    for (const d of deadmen) {
      b.ink({ color: PAL.concrete, mat: MAT.ROCK, wear: 0.5, snow: 1 });
      b.box(0.7, 1.0, 0.7, { bevel: 0.03 }).move(d[0], -0.35, d[2]);
      b.ink({ color: PAL.rustDark, mat: MAT.METAL, wear: 1.0, snow: 1 });
      // the nearest leg carries the guys
      let best = legs[0], bd = 1e9;
      for (const l of legs) { const dd = Math.hypot(l[0] - d[0], l[1] - d[2]); if (dd < bd) { bd = dd; best = l; } }
      for (const h of [10.5, 19.5, H - 0.5]) {
        const top: V3 = [best[0], h, best[1]];
        const len = Math.hypot(top[0] - d[0], top[1] - 0.3, top[2] - d[2]);
        b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.5, snow: 1 });
        b.cable(top, [d[0], 0.3, d[2]], len * 0.012, 0.007, { segs: 10, sides: 4 });
      }
      b.ink({ color: PAL.rustDark, mat: MAT.METAL, wear: 1.0, snow: 1 });
      place(b.cyl(0.02, 0.4, { sides: 6 }), [d[0], 0.15, d[2]], [d[0] + (best[0] - d[0]) * 0.02, 0.5, d[2] + (best[1] - d[2]) * 0.02]);
    }

    // ---- the deck ----
    const deck = bp.floors.find((f) => f.tag === 'deck')!, step = bp.floors.find((f) => f.tag === 'step')!;
    const DY = deck.y;
    b.ink({ color: PAL.concrete, mat: MAT.ROCK, wear: 0.5, snow: 1 });
    for (const x of [-2.6, 0, 2.6]) for (const z of [0.9, 3.5, 6.1]) b.cyl(0.18, 0.5, { sides: 10 }).move(x, 0.0, z);
    b.ink({ color: hex(0x3d4144), mat: MAT.PAINT, wear: 0.7, snow: 1 });
    for (const z of [deck.z - deck.hz + 0.08, deck.z, deck.z + deck.hz - 0.08]) b.box(deck.hx * 2, 0.2, 0.12, { bevel: 0.01 }).move(0, DY - 0.13, z);
    for (const x of [-deck.hx + 0.08, 0, deck.hx - 0.08]) b.box(0.12, 0.2, deck.hz * 2, { bevel: 0.01 }).move(x, DY - 0.13, deck.z);
    // checker plate, panel by panel
    b.ink({ color: hex(0x6a6e70), mat: MAT.METAL, wear: 0.7, rough: 0.55, snow: 1 });
    mergeAll(b.group(() => {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) b.box(1.98, 0.02, 1.98, { bevel: 0.004 }).move(-2 + i * 2, DY - 0.01, deck.z - 2 + j * 2);
    }).parts);
    // the H in a circle, worn yellow paint, hazard edges
    b.ink({ color: hex(0xb8902a), mat: MAT.PAINT, wear: 0.85, snow: 1 });
    {
      const hP = b.group(() => {
        b.box(0.35, 0.004, 3.0, { bevel: 0.001 }).move(-0.9, 0, 0);
        b.box(0.35, 0.004, 3.0, { bevel: 0.001 }).move(0.9, 0, 0);
        b.box(1.45, 0.004, 0.35, { bevel: 0.001 }).move(0, 0, 0);
      });
      hP.move(0, DY + 0.003, deck.z);
      b.torus(2.45, 0.12, { segs: 40, sides: 3 }).scale(1, 0.04, 1).move(0, DY + 0.002, deck.z);
    }
    b.ink({ color: hex(0xb8902a), mat: MAT.PAINT, wear: 0.8, snow: 1 });
    mergeAll(b.group(() => {
      for (let s = -2.9; s < 2.9; s += 0.6) for (const z of [deck.z - deck.hz + 0.06, deck.z + deck.hz - 0.06]) b.box(0.3, 0.004, 0.1, { bevel: 0.001 }).rotY(0.6).move(s, DY + 0.003, z);
    }).parts);
    // the step
    b.ink({ color: hex(0x6a6e70), mat: MAT.METAL, wear: 0.7, rough: 0.55, snow: 1 });
    b.box(step.hx * 2, 0.03, step.hz * 2, { bevel: 0.004 }).move(step.x, step.y - 0.015, step.z);
    b.ink({ color: hex(0x3d4144), mat: MAT.PAINT, wear: 0.7, snow: 1 });
    for (const x of [-step.hx + 0.05, step.hx - 0.05]) b.box(0.08, step.y, step.hz * 2, { bevel: 0.008 }).move(x, step.y / 2, step.z);
    // tie-down rings
    b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.6, snow: 1 });
    for (const [x, z] of [[-2.6, 0.9], [2.6, 0.9], [-2.6, 6.1], [2.6, 6.1]]) b.torus(0.06, 0.01, { segs: 8, sides: 4 }).rotX(1.3).move(x, DY + 0.02, z);
    // the strobe on its post at the beacon anchor
    {
      const bc = bp.anchors.beacon;
      b.ink({ color: hex(0xb8902a), mat: MAT.PAINT, wear: 0.6, snow: 1 });
      b.cyl(0.04, 0.42, { sides: 8 }).move(bc.x, DY + 0.21, bc.z);
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.5, snow: 1 });
      b.cyl(0.09, 0.08, { sides: 12 }).move(bc.x, DY + 0.46, bc.z);
      b.ink({ color: hex(0x9fb0b8), mat: MAT.GLASS, rough: 0.1, wear: 0.3, snow: 0.5 });
      b.cyl(0.07, 0.12, { sides: 12 }).move(bc.x, DY + 0.56, bc.z);
      b.part('beacon', () => {
        b.ink({ color: PAL.lampCold, mat: MAT.EMISSIVE, emissive: 30, snow: 0 });
        b.cyl(0.03, 0.08, { sides: 8 }).move(bc.x, DY + 0.56, bc.z);
      });
      b.emitter('beacon', [bc.x, DY + 0.58, bc.z], { name: 'strobe', size: 0.07, color: PAL.lampCold });
    }
    drift(b, [[-3.4, 0, 0.6], [-3.5, 0, 3.5], [-3.4, 0, 6.4]], 0.9, 0.42);
    drift(b, [[3.4, 0, 1.0], [3.5, 0, 4.0], [3.4, 0, 6.2]], 0.8, 0.32);
    for (const [x, z] of legs) snowHeap(b, [x - 0.2, 0, z - 0.25], 0.5, 0.25, 0.4);
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void r; void fbm3;
    return b.build({ ground: true, aoRadius: 0.16 });
  },
  { variants: 1, size: 'structure', desc: 'the signal tower: 30 m guyed lattice mast and the pickup deck (blueprint tower_mast)', tags: ['tower'] },
);

// ------------------------------------------------------------------------------------------

/** Where each module sits on the panel front (shed-local), and its anchor yaw. */
export const PANEL_SLOTS: Record<'battery' | 'handset' | 'coil' | 'tube' | 'fuse', V3> = {
  tube: [-0.22, 1.62, -1.5],
  coil: [0.5, 1.62, -1.5],
  handset: [0.62, 1.15, -1.5],
  battery: [-0.25, 0.5, -1.5],
  fuse: [0.42, 0.62, -1.5],
};

register(
  'tower_shed',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.tower_shed;
    const S = r.int(0, 1 << 20);
    const FY = 0.18, WX = 1.44, WZ = 1.94;
    const roofY = (z: number) => 2.62 - (2.15 - z) * (0.3 / 4.3); // falls to the back
    const door = bp.openings[0];
    const galv = mixRGB(PAL.galvanised, hex(0x8a8e90), 0.35);
    // slab and floor
    b.ink({ color: PAL.concrete, mat: MAT.ROCK, wear: 0.5, snow: 1 });
    b.box(3.2, 0.45, 4.2, { bevel: 0.02 }).move(0, FY - 0.03 - 0.225 + 0.0, 0);
    b.ink({ color: mixRGB(PAL.plywood, PAL.timber, 0.4), mat: MAT.WOOD, wear: 0.7, snow: 0, vary: 0.05 });
    mergeAll(b.group(() => { for (let x = -1.36; x < 1.36; x += 0.2) b.plank(3.88, 0.195, 0.03, { straight: true }).rotX(Math.PI / 2).move(x + 0.1, FY - 0.015, 0); }).parts);
    // frame: channel posts at the corners and beside the door, the top plates
    b.ink({ color: hex(0x5b6063), mat: MAT.PAINT, wear: 0.7, snow: 0.5 });
    for (const [x, z] of [[-WX, -WZ], [WX, -WZ], [-WX, WZ], [WX, WZ], [-0.5, WZ], [0.5, WZ], [-WX, 0], [WX, 0]]) b.box(0.08, roofY(z) - FY, 0.08, { bevel: 0.006 }).move(x, (roofY(z) + FY) / 2, z);
    // corrugated cladding (outside) and plywood lining (inside)
    const clad = (x0: number, z0: number, x1: number, z1: number, gaps: [number, number][] = []) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(-(z1 - z0), x1 - x0);
      let nx = z1 - z0, nz = -(x1 - x0);
      const nl = Math.hypot(nx, nz);
      nx /= nl; nz /= nl;
      if (nx * (x0 + x1) + nz * (z0 + z1) < 0) { nx = -nx; nz = -nz; }
      for (let s = 0; s < len - 0.01; s += 0.76) {
        const a = s, c = Math.min(len, s + 0.8);
        const m = (a + c) / 2;
        if (gaps.some(([g0, g1]) => m > g0 - 0.3 && m < g1 + 0.3)) continue;
        const x = x0 + ((x1 - x0) * m) / len, z = z0 + ((z1 - z0) * m) / len;
        const top = roofY(z) - 0.02;
        b.ink({ color: galv, mat: MAT.METAL, wear: 0.62, rough: 0.5, snow: 1, vary: 0.06 });
        const sh = sheet(b, c - a, top, { kind: 'wave', pitch: 0.076, depth: 0.017 });
        sh.rotY(yaw).move(x + nx * 0.065, top / 2, z + nz * 0.065);
        sh.each((q) => { q.wear = 0.55 + 0.4 * Math.max(0, fbm3(S + Math.round(s * 10), q.x * 2, q.y * 1.5, q.z * 2, 2)) + 0.3 * Math.max(0, 0.4 - q.y); });
        b.ink({ color: mixRGB(PAL.plywood, PAL.timber, 0.25), mat: MAT.WOOD, wear: 0.5, snow: 0 });
        b.box(c - a, top - FY, 0.012, { bevel: 0.002 }).rotY(yaw).move(x - nx * 0.05, (top + FY) / 2, z - nz * 0.05);
      }
    };
    clad(-WX, -WZ, WX, -WZ);
    clad(-WX, -WZ, -WX, WZ);
    clad(WX, -WZ, WX, WZ, [[1.65, 2.25]]);
    clad(-WX, WZ, WX, WZ, [[door.x - door.w / 2 + WX, door.x + door.w / 2 + WX]]);
    // the door's neighbours: narrow sheets either side of the opening
    for (const sx of [-1, 1]) {
      b.ink({ color: galv, mat: MAT.METAL, wear: 0.62, rough: 0.5, snow: 1 });
      const w = WX - door.w / 2 - 0.62;
      const sh = sheet(b, 0.62 - 0.07, roofY(WZ) - 0.02, { kind: 'wave', pitch: 0.076, depth: 0.017 });
      sh.move(sx * (door.w / 2 + 0.31), (roofY(WZ) - 0.02) / 2, WZ + 0.065);
      void w;
      b.ink({ color: mixRGB(PAL.plywood, PAL.timber, 0.25), mat: MAT.WOOD, wear: 0.5, snow: 0 });
      b.box(0.55, roofY(WZ) - FY - 0.02, 0.012, { bevel: 0.002 }).move(sx * (door.w / 2 + 0.3), (roofY(WZ) + FY) / 2, WZ - 0.05);
    }
    // the side window (east), wired glass
    b.group(() => sash(b, 0.55, 0.42, { cols: 1, rows: 1, frame: hex(0x5b6063), glassTint: hex(0x8a9a9a) })).rotY(Math.PI / 2).move(WX + 0.07, 1.6, 0.55);
    b.ink({ color: hex(0x5b6063), mat: MAT.PAINT, wear: 0.6, snow: 1 });
    b.box(0.03, 0.55, 0.7, { bevel: 0.006 }).move(WX + 0.06, 1.6, 0.55).ghost();
    // over the door: the frame head, a sign plate
    b.ink({ color: hex(0x5b6063), mat: MAT.PAINT, wear: 0.7, snow: 1 });
    b.box(door.w + 0.16, 0.08, 0.14, { bevel: 0.008 }).move(door.x, FY + door.h + 0.04, WZ);
    b.ink({ color: hex(0xc9c6b8), mat: MAT.PAINT, wear: 0.6, snow: 1 });
    b.box(0.5, 0.18, 0.012, { bevel: 0.003 }).move(0.75, 1.75, WZ + 0.09);
    b.ink({ color: hex(0x7d1f1b), mat: MAT.PAINT, wear: 0.6, snow: 1 });
    b.stencil('DANGER', 0.06, { align: 'center', weight: 0.18 }).move(0.75, 1.76, WZ + 0.097);
    b.stencil('HIGH VOLTAGE', 0.035, { align: 'center', weight: 0.16 }).move(0.75, 1.69, WZ + 0.097);
    // the steel door
    const hx = door.x - door.w / 2 + 0.01;
    b.part('door', () => {
      b.ink({ color: hex(0x4d5457), mat: MAT.PAINT, wear: 0.65, rough: 0.6, snow: 0.6 });
      b.box(door.w - 0.02, door.h - 0.02, 0.045, { bevel: 0.008 }).move(hx + (door.w - 0.02) / 2, FY + door.h / 2, WZ + 0.02);
      b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.5, rough: 0.35, snow: 0.3 });
      b.box(0.14, 0.025, 0.04, { bevel: 0.008 }).move(hx + door.w - 0.14, FY + 1.0, WZ + 0.07);
      b.cyl(0.02, 0.03, { sides: 8 }).rotX(Math.PI / 2).move(hx + door.w - 0.1, FY + 1.1, WZ + 0.05);
    }, [hx, FY, WZ + 0.02], { axis: [0, 1, 0], open: -1.7 });
    // roof: purlins, corrugated sheets, icicles off the back eave
    b.ink({ color: hex(0x5b6063), mat: MAT.PAINT, wear: 0.7, snow: 0.4 });
    for (const z of [-1.9, -0.95, 0, 0.95, 1.9]) place(b.box(0.06, 3.3, 0.1, { bevel: 0.006 }), [-1.65, roofY(z) + 0.02, z], [1.65, roofY(z) + 0.02, z], [0, 1, 0]).ghost();
    const tilt = Math.atan(0.3 / 4.3);
    for (let x = -1.65; x < 1.65; x += 0.72) {
      b.ink({ color: galv, mat: MAT.METAL, wear: 0.65, rough: 0.5, snow: 1, vary: 0.06 });
      const sh = sheet(b, 0.76, 4.5, { kind: 'wave', pitch: 0.076, depth: 0.017 });
      sh.rotX(-Math.PI / 2).rotX(tilt).move(x + 0.38, roofY(0) + 0.085, 0);
      sh.each((q) => { q.wear = 0.6 + 0.35 * Math.max(0, fbm3(S + Math.round(x * 10), q.x * 2, 0, q.z * 1.2, 2)); });
    }
    icicles(b, [-1.65, roofY(-2.25) + 0.05, -2.27], [1.65, roofY(-2.25) + 0.05, -2.27], { every: 0.12, len: [0.03, 0.35] });

    // ---- the transmitter cabinet and its slots ----
    const pb = bp.boxes.find((x) => x.tag === 'panel')!;
    const PX0 = pb.x - pb.hx, PX1 = pb.x + pb.hx, PZF = pb.z + pb.hz; // front face z -1.52
    b.ink({ color: hex(0x6b7268), mat: MAT.PAINT, wear: 0.55, rough: 0.6, snow: 0 });
    b.box(PX1 - PX0, pb.y1 - pb.y0, pb.hz * 2 - 0.03, { bevel: 0.015 }).move(pb.x, (pb.y0 + pb.y1) / 2, pb.z - 0.015);
    b.ink({ color: hex(0x575d55), mat: MAT.PAINT, wear: 0.55, rough: 0.6, snow: 0 });
    for (const y of [0.92, 1.38]) b.box(PX1 - PX0 - 0.04, 0.02, 0.02, { bevel: 0.004 }).move(pb.x, y, PZF - 0.005);
    // meters, a frequency dial, switches, a speaker grille, the label
    for (const [x, y] of [[-0.3, 1.18], [0.05, 1.18], [0.3, 1.82]]) {
      b.ink({ color: hex(0x1b1c1d), mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
      b.cyl(0.07, 0.03, { sides: 14 }).rotX(Math.PI / 2).move(x, y, PZF + 0.01);
      b.ink({ color: hex(0xcfc8b2), mat: MAT.PAINT, wear: 0.3, snow: 0 });
      b.cyl(0.058, 0.004, { sides: 14 }).rotX(Math.PI / 2).move(x, y, PZF + 0.026);
      b.ink({ color: hex(0x1b1c1d), mat: MAT.PAINT, wear: 0.3, snow: 0 });
      b.box(0.004, 0.05, 0.002, { bevel: 0.0005 }).rotZ(-0.7 + r.next() * 0.3).move(x - 0.012, y + 0.015, PZF + 0.03);
    }
    b.ink({ color: hex(0x2a2b2c), mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
    b.cyl(0.05, 0.035, { sides: 16 }).rotX(Math.PI / 2).move(0.32, 1.2, PZF + 0.017);
    for (let i = 0; i < 4; i++) b.box(0.015, 0.035, 0.03, { bevel: 0.004 }).rotX(-0.4).move(-0.38 + i * 0.09, 1.0, PZF + 0.02);
    b.ink({ color: hex(0x3a3d3a), mat: MAT.METAL, wear: 0.4, snow: 0 });
    for (let i = 0; i < 6; i++) b.box(0.22, 0.01, 0.006, { bevel: 0.001 }).move(0.08, 1.52 + i * 0.022, PZF + 0.004);
    b.ink({ color: hex(0xd7d2c0), mat: MAT.PAINT, wear: 0.5, snow: 0 });
    b.stencil('VHF TRANSMITTER', 0.035, { align: 'center', weight: 0.16 }).move(pb.x, 1.9, PZF + 0.002);
    // the five empty sockets (always there) and the installed modules (parts, hidden until installed)
    const sockets = (name: string, p: V3) => {
      const [x, y, z] = p;
      b.ink({ color: hex(0x1d1e1f), mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
      if (name === 'tube') { b.cyl(0.045, 0.03, { sides: 12 }).rotX(Math.PI / 2).move(x, y, PZF + 0.01); }
      else if (name === 'coil') { b.ink({ color: hex(0xb7ad98), mat: MAT.PLASTIC, wear: 0.4, snow: 0 }); for (const dx of [-0.06, 0.06]) b.cyl(0.015, 0.05, { sides: 8 }).rotX(Math.PI / 2).move(x + dx, y, PZF + 0.025); }
      else if (name === 'handset') { b.ink({ color: hex(0x1d1e1f), mat: MAT.PLASTIC, wear: 0.4, snow: 0 }); b.box(0.08, 0.2, 0.04, { bevel: 0.01 }).move(x, y, PZF + 0.02); for (const dy of [-0.08, 0.08]) b.box(0.03, 0.025, 0.06, { bevel: 0.006 }).move(x, y + dy, PZF + 0.05); }
      else if (name === 'battery') { b.box(0.32, 0.22, 0.02, { bevel: 0.004 }).move(x, y, PZF + 0.002); b.ink({ color: hex(0x8a6a30), mat: MAT.METAL, wear: 0.4, snow: 0 }); for (const dx of [-0.08, 0.08]) b.cyl(0.012, 0.03, { sides: 6 }).rotX(Math.PI / 2).move(x + dx, y + 0.06, PZF + 0.02); }
      else if (name === 'fuse') { b.box(0.16, 0.08, 0.02, { bevel: 0.004 }).move(x, y, PZF + 0.01); b.ink({ color: hex(0x8a6a30), mat: MAT.METAL, wear: 0.4, snow: 0 }); for (const dx of [-0.05, 0.05]) b.box(0.012, 0.04, 0.03, { bevel: 0.003 }).move(x + dx, y, PZF + 0.03); }
    };
    for (const [name, p] of Object.entries(PANEL_SLOTS)) {
      sockets(name, p);
      b.anchor('slot_' + name, [p[0], p[1], PZF + 0.05], 0);
      b.part('slot_' + name, () => {
        const [x, y] = p;
        if (name === 'tube') {
          b.ink({ color: hex(0x9aa6a8), mat: MAT.GLASS, rough: 0.05, wear: 0.2, snow: 0 });
          b.lathe([[0, 0], [0.03, 0.005], [0.034, 0.08], [0.028, 0.12], [0, 0.13]], { sides: 12, smooth: true }).rotX(Math.PI / 2).move(x, y, PZF + 0.03);
          b.ink({ color: hex(0x5d4a2a), mat: MAT.METAL, wear: 0.3, snow: 0 });
          b.cyl(0.012, 0.06, { sides: 6 }).rotX(Math.PI / 2).move(x, y, PZF + 0.08);
        } else if (name === 'coil') {
          b.ink({ color: hex(0xc9c0aa), mat: MAT.PLASTIC, wear: 0.3, snow: 0 });
          b.cyl(0.035, 0.15, { sides: 10 }).rotZ(Math.PI / 2).move(x, y, PZF + 0.07);
          b.ink({ color: hex(0xa8642e), mat: MAT.METAL, wear: 0.3, rough: 0.35, snow: 0 });
          for (let i = 0; i < 9; i++) b.torus(0.038, 0.004, { segs: 10, sides: 3 }).rotZ(Math.PI / 2).move(x - 0.065 + i * 0.016, y, PZF + 0.07);
        } else if (name === 'handset') {
          b.ink({ color: hex(0x151617), mat: MAT.PLASTIC, wear: 0.35, rough: 0.35, snow: 0 });
          b.capsule(0.022, 0.22, { sides: 8, rings: 2 }).move(x, y, PZF + 0.085);
          for (const dy of [-0.1, 0.1]) b.sphere([0.035, 0.03, 0.03], { sides: 8, rings: 4 }).move(x, y + dy, PZF + 0.09);
          b.pipe(Path.spline([[x, y - 0.12, PZF + 0.08], [x - 0.04, y - 0.25, PZF + 0.12], [x - 0.1, y - 0.3, PZF + 0.05], [x - 0.15, y - 0.2, PZF + 0.01]], 4), 0.006, { sides: 4 });
        } else if (name === 'battery') {
          b.ink({ color: hex(0x1f2120), mat: MAT.PLASTIC, wear: 0.45, snow: 0 });
          b.box(0.28, 0.18, 0.16, { bevel: 0.01 }).move(x, y - 0.01, PZF + 0.09);
          b.ink({ color: hex(0xb33a1e), mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
          b.cyl(0.014, 0.025, { sides: 6 }).move(x + 0.08, y + 0.09, PZF + 0.09);
        } else {
          b.ink({ color: hex(0xd9d4c6), mat: MAT.PLASTIC, wear: 0.3, snow: 0 });
          b.cyl(0.012, 0.11, { sides: 8 }).rotZ(Math.PI / 2).move(x, y, PZF + 0.035);
          b.ink({ color: hex(0x9a8a5a), mat: MAT.METAL, wear: 0.3, snow: 0 });
          for (const dx of [-0.05, 0.05]) b.cyl(0.0135, 0.018, { sides: 8 }).rotZ(Math.PI / 2).move(x + dx, y, PZF + 0.035);
        }
      }, [p[0], p[1], PZF]);
    }
    // indicator lamps: dark when off; the lit set and the ceiling lamp in part 'panel_lights'
    const lamps: [number, number, number][] = [[-0.4, 1.38, 0x2fb85a], [-0.32, 1.38, 0xe0a020], [-0.24, 1.38, 0xd23a1a]];
    b.ink({ color: hex(0x202421), mat: MAT.PLASTIC, rough: 0.2, wear: 0.3, snow: 0 });
    for (const [x, y] of lamps) b.dome(0.014, 0.012, 8).rotX(Math.PI / 2).move(x, y + 0.05, PZF + 0.004);
    b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.5, snow: 0 });
    b.cyl(0.08, 0.06, { sides: 10 }).move(0, roofY(0) - 0.04, 0);
    b.ink({ color: hex(0xc9c9c0), mat: MAT.GLASS, rough: 0.2, wear: 0.4, snow: 0 });
    b.sphere([0.06, 0.07, 0.06], { sides: 10, rings: 6 }).move(0, roofY(0) - 0.13, 0);
    b.part('panel_lights', () => {
      for (const [x, y, c] of lamps) {
        b.ink({ color: hex(c), mat: MAT.EMISSIVE, emissive: 6, snow: 0 });
        b.dome(0.0145, 0.0125, 8).rotX(Math.PI / 2).move(x, y + 0.05, PZF + 0.005);
      }
      b.ink({ color: PAL.lampWarm, mat: MAT.EMISSIVE, emissive: 5, snow: 0 });
      b.sphere([0.03, 0.04, 0.03], { sides: 8, rings: 5 }).move(0, roofY(0) - 0.13, 0);
    });
    b.emitter('light', [0, roofY(0) - 0.2, 0], { name: 'shed_lamp', size: 0.06, color: PAL.lampWarm, intensity: 5, range: 6, powered: true });
    // the cable from the generator: in through the back wall, up to the cabinet
    b.ink({ color: PAL.plasticBlack, mat: MAT.RUBBER, wear: 0.5, snow: 0 });
    b.pipe([[-1.35, 0.3, -1.85], [-0.8, 0.25, -1.86], [-0.5, 0.25, -1.86], [-0.45, 0.4, -1.7]], 0.018, { sides: 6 });

    // ---- workbench, the locker ----
    const bn = bp.boxes.find((x) => x.tag === 'bench')!;
    b.ink({ color: mixRGB(PAL.timber, PAL.pine, 0.2), mat: MAT.WOOD, wear: 0.7, snow: 0, vary: 0.06 });
    b.box(bn.hx * 2, 0.045, bn.hz * 2, { bevel: 0.008 }).move(bn.x, bn.y1 - 0.022, bn.z);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.06, bn.y1 - bn.y0 - 0.045, 0.06, { bevel: 0.006 }).move(bn.x + dx * (bn.hx - 0.05), (bn.y0 + bn.y1 - 0.045) / 2, bn.z + dz * (bn.hz - 0.05));
    b.box(bn.hx * 2 - 0.08, 0.025, bn.hz * 2 - 0.1, { bevel: 0.004 }).move(bn.x, bn.y0 + 0.25, bn.z);
    b.ink({ color: hex(0x3d4a5a), mat: MAT.PAINT, wear: 0.6, snow: 0 });
    b.box(0.12, 0.1, 0.16, { bevel: 0.01 }).move(bn.x + 0.1, bn.y1 + 0.05, bn.z - 0.85);
    b.ink({ color: hex(0x6a5a3a), mat: MAT.CLOTH, wear: 0.5, snow: 0 });
    b.box(0.18, 0.03, 0.25, { bevel: 0.004 }).rotY(0.3).move(bn.x + 0.05, bn.y1 + 0.015, bn.z + 0.2);
    const lk = bp.anchors.locker;
    const LX0 = lk.x, LX1 = WX - 0.06, LZ0 = lk.z - 0.3, LZ1 = lk.z + 0.3, LY1 = FY + 1.8;
    b.ink({ color: hex(0x55606a), mat: MAT.PAINT, wear: 0.6, snow: 0 });
    b.box(LX1 - LX0 - 0.02, LY1 - FY, 0.02, { bevel: 0.004 }).move((LX0 + LX1) / 2 + 0.01, (FY + LY1) / 2, LZ0);
    b.box(LX1 - LX0 - 0.02, LY1 - FY, 0.02, { bevel: 0.004 }).move((LX0 + LX1) / 2 + 0.01, (FY + LY1) / 2, LZ1);
    b.box(LX1 - LX0, 0.02, LZ1 - LZ0, { bevel: 0.004 }).move((LX0 + LX1) / 2, LY1, lk.z);
    b.box(0.02, LY1 - FY, LZ1 - LZ0, { bevel: 0.004 }).move(LX1, (FY + LY1) / 2, lk.z);
    b.part('locker_door', () => {
      b.ink({ color: hex(0x5b6670), mat: MAT.PAINT, wear: 0.6, snow: 0 });
      b.box(0.02, LY1 - FY - 0.02, LZ1 - LZ0 - 0.01, { bevel: 0.004 }).move(LX0 + 0.01, (FY + LY1) / 2, lk.z);
      b.ink({ color: hex(0x2f3438), mat: MAT.PAINT, wear: 0.5, snow: 0 });
      for (let i = 0; i < 4; i++) b.box(0.006, 0.012, 0.25, { bevel: 0.002 }).move(LX0 - 0.002, LY1 - 0.15 - i * 0.03, lk.z);
      b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.4, snow: 0 });
      b.box(0.03, 0.12, 0.025, { bevel: 0.005 }).move(LX0 - 0.01, FY + 1.0, LZ1 - 0.06);
    }, [LX0 + 0.01, FY, LZ0], { axis: [0, 1, 0], open: -1.7 });

    // ---- snow round the outside ----
    drift(b, [[-1.9, 0, -2.3], [0, 0, -2.4], [1.9, 0, -2.3]], 1.0, 0.5);
    drift(b, [[-1.85, 0, -2.0], [-1.95, 0, 0], [-1.85, 0, 2.0]], 0.8, 0.35);
    snowHeap(b, [1.2, 0, 2.35], 0.6, 0.15, 0.4);

    // ---- light inside ----
    const aps: Aperture[] = [
      { c: [0, FY + door.h / 2, WZ], n: [0, 0, -1], area: door.w * door.h, gain: 0.35 },
      { c: [WX, 1.6, 0.55], n: [-1, 0, 0], area: 0.23, gain: 0.8 },
    ];
    roomLight(b, (x, y, z, nx, ny) => {
      if (Math.abs(x) > WX - 0.03 || Math.abs(z) > WZ - 0.03 || y < 0.05) return false;
      if (y > roofY(z) + 0.01) return ny < 0;
      return true;
    }, aps, { base: 0.12, gain: 3.0 });
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void (null as unknown as Part);
    return b.build({ ground: true, aoRadius: 0.16 });
  },
  { variants: 1, size: 'structure', desc: 'the equipment shed: steel-clad hut with the transmitter panel and its five slots (blueprint tower_shed)', tags: ['tower'] },
);

register(
  'generator',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.generator;
    const pad = bp.floors[0], gs = bp.boxes[0], crankA = bp.anchors.crank;
    const PY = pad.y;
    const olive = mixRGB(PAL.olive, PAL.drab, 0.3);
    b.ink({ color: PAL.concrete, mat: MAT.ROCK, wear: 0.55, snow: 1 });
    b.box(pad.hx * 2, PY + 0.35, pad.hz * 2, { bevel: 0.03 }).move(0, (PY - 0.35) / 2, 0);
    // channel skid
    b.ink({ color: hex(0x2e3130), mat: MAT.PAINT, wear: 0.8, snow: 1 });
    for (const z of [gs.z - gs.hz + 0.06, gs.z + gs.hz - 0.06]) b.box(gs.hx * 2 + 0.1, 0.1, 0.08, { bevel: 0.008 }).move(0, PY + 0.05, z);
    // dynamo housing (left), gearbox (middle), flywheel guard (right)
    b.ink({ color: olive, mat: MAT.PAINT, wear: 0.72, rough: 0.65, snow: 1 });
    const dyn = b.cyl(0.27, 0.62, { sides: 18, bevel: 0.03 });
    dyn.rotZ(Math.PI / 2).move(-0.32, PY + 0.42, gs.z);
    for (let i = 0; i < 5; i++) b.box(0.02, 0.46, 0.5, { bevel: 0.004 }).move(-0.55 + i * 0.1, PY + 0.42, gs.z).ghost();
    b.box(0.42, 0.62, 0.6, { bevel: 0.03 }).move(0.12, PY + 0.45 + 0.08, gs.z);
    const guard = b.lathe([[0.36, -0.07], [0.4, -0.06], [0.42, 0], [0.4, 0.06], [0.36, 0.07]], { sides: 22, closed: true });
    guard.rotZ(Math.PI / 2).move(0.5, PY + 0.5, gs.z);
    b.ink({ color: hex(0x2f2f2e), mat: MAT.METAL, wear: 0.7, snow: 1 });
    b.cyl(0.34, 0.06, { sides: 22 }).rotZ(Math.PI / 2).move(0.5, PY + 0.5, gs.z);
    // the control box on top: the charge meter (needle is a part), a switch, a stencil
    b.ink({ color: olive, mat: MAT.PAINT, wear: 0.7, rough: 0.65, snow: 1 });
    b.box(0.34, 0.24, 0.2, { bevel: 0.015 }).move(-0.25, PY + 0.81, gs.z + 0.1);
    b.ink({ color: hex(0xd8d2bd), mat: MAT.PAINT, wear: 0.35, snow: 0 });
    const mX = -0.3, mY = PY + 0.83, mZ = gs.z + 0.2 + 0.006;
    b.cyl(0.065, 0.004, { sides: 16 }).rotX(Math.PI / 2).move(mX, mY, mZ);
    b.ink({ color: hex(0x1b1c1d), mat: MAT.PAINT, wear: 0.3, snow: 0 });
    for (let k = 0; k <= 4; k++) {
      const a = -0.8 + (k / 4) * 1.6;
      b.box(0.003, 0.012, 0.002, { bevel: 0.0005 }).rotZ(-a).move(mX + Math.sin(a) * 0.05, mY + Math.cos(a) * 0.05, mZ + 0.003);
    }
    b.part('needle', () => {
      b.ink({ color: hex(0xa0281c), mat: MAT.PAINT, wear: 0.2, snow: 0 });
      b.box(0.004, 0.05, 0.002, { bevel: 0.0005 }).move(mX, mY + 0.022, mZ + 0.005);
    }, [mX, mY, mZ], { axis: [0, 0, 1] });
    b.ink({ color: hex(0x1b1c1d), mat: MAT.PLASTIC, wear: 0.4, snow: 0.5 });
    b.box(0.03, 0.05, 0.03, { bevel: 0.006 }).rotX(-0.4).move(-0.13, mY, mZ + 0.01);
    b.ink({ color: hex(0xbdb59a), mat: MAT.PAINT, wear: 0.7, snow: 1 });
    b.stencil('GEN SET 2KW', 0.04, { align: 'center', weight: 0.15 }).move(0.12, PY + 0.32, gs.z + gs.hz + 0.003 - 0.06);
    // the crank: axle boss on the gearbox front, arm and wooden grip (part, turns about +Z)
    b.ink({ color: hex(0x2e3130), mat: MAT.METAL, wear: 0.6, snow: 1 });
    b.cyl(0.05, 0.06, { sides: 12 }).rotX(Math.PI / 2).move(crankA.x, crankA.y, gs.z + gs.hz - 0.04);
    b.part('crank', () => {
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.65, rough: 0.45, snow: 0.5 });
      b.cyl(0.022, 0.1, { sides: 8 }).rotX(Math.PI / 2).move(crankA.x, crankA.y, crankA.z - 0.02);
      b.box(0.05, 0.3, 0.025, { bevel: 0.008 }).move(crankA.x, crankA.y - 0.13, crankA.z + 0.03);
      b.cyl(0.014, 0.08, { sides: 6 }).rotX(Math.PI / 2).move(crankA.x, crankA.y - 0.26, crankA.z + 0.07);
      b.ink({ color: hex(0x5a3f26), mat: MAT.WOOD, wear: 0.7, snow: 0.3 });
      b.cyl(0.024, 0.14, { sides: 8 }).rotX(Math.PI / 2).move(crankA.x, crankA.y - 0.26, crankA.z + 0.17);
    }, [crankA.x, crankA.y, crankA.z], { axis: [0, 0, 1] });
    // exhaust stack (it once had a petrol prime mover), the cable run toward the shed (+X)
    b.ink({ color: PAL.rustDark, mat: MAT.METAL, wear: 1.2, rough: 0.8, snow: 1 });
    b.cyl(0.03, 0.5, { sides: 8 }).move(-0.5, PY + 0.95, gs.z - 0.2);
    b.ink({ color: PAL.plasticBlack, mat: MAT.RUBBER, wear: 0.5, snow: 1 });
    b.pipe(Path.spline([[0.62, PY + 0.3, gs.z - 0.2], [0.85, PY + 0.1, gs.z - 0.35], [1.15, PY + 0.02, gs.z - 0.4], [1.6, -0.04, gs.z - 0.45]], 4), 0.02, { sides: 6 });
    drift(b, [[-1.3, 0, -0.9], [0, 0, -1.0], [1.3, 0, -0.9]], 0.9, 0.35);
    snowHeap(b, [-1.25, 0, 0.5], 0.4, 0.2, 0.5);
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void r;
    return b.build({ ground: true, aoRadius: 0.16 });
  },
  { variants: 1, size: 'structure', desc: 'the hand-crank generator set on its pad (blueprint generator); parts crank, needle', tags: ['tower'] },
);
