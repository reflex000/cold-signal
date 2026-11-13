// Two small timber buildings.
//
// 'woodshed' (blueprint woodshed: 3 x 1.6 m lean-to, plank walls 1.9 m tall at the back z -0.74
// and the sides x +-1.44, open at the front): rough sawn boards on a pole frame, a single board-
// and-tar-paper roof falling to the back, split wood stacked along the back wall in the
// blueprint's woodpile box, a chopping block on the 'block' anchor with split pieces around it.
//
// 'fishing_hut' (blueprint fishing_hut: 2.5 x 2.5 m, walls 0.1 m on x +-1.2 / z +-1.2, 2.2 m
// tall, door gap x -0.4 .. 0.4 at the front, floor y 0.10): a plywood ice-fishing shack on two
// sled runners, faded red paint, corner trim, a small window, a rolled-roofing shed roof, a tin
// stovepipe from a little sheet-metal stove in the back corner, the bench and the shelf in their
// boxes, the fishing hole in the floor with its hatch lifted and dark water in the ice below.
// Part 'door' (hinged at x -0.4, swings out). Emitter: smoke at the stovepipe cap (source 'stove').
import { Builder, MAT, PAL, Path, fbm3, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';
import { BLUEPRINTS } from '../../world/blueprints';
import { beam, drift, icicles, roomLight, sash, sheet, snowHeap, type Aperture } from './lib';

register(
  'woodshed',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.woodshed;
    const grey = mixRGB(PAL.timber, PAL.deadwood, 0.3);
    const roofY = (z: number) => 1.98 + (z + 0.95) * (0.24 / 1.9); // falls to the back
    // pole frame
    b.ink({ color: mixRGB(PAL.deadwood, PAL.barkGrey, 0.4), mat: MAT.WOOD, wear: 0.7, snow: 1 });
    for (const [x, z] of [[-1.44, -0.74], [1.44, -0.74], [-1.44, 0.8], [1.44, 0.8], [0, 0.8]]) {
      const h = roofY(z) + 0.02;
      b.log(h + 0.3, 0.06, { sides: 7, rows: 3, ends: ['saw', 'saw'], peel: 0.9, deadwood: mixRGB(PAL.deadwood, PAL.barkGrey, 0.4), gnarl: 0.004 }).move(x, (h - 0.3) / 2, z);
    }
    beam(b, [-1.55, roofY(0.8) - 0.08, 0.8], [1.55, roofY(0.8) - 0.08, 0.8], 0.09, 0.14);
    beam(b, [-1.55, roofY(-0.74) - 0.08, -0.74], [1.55, roofY(-0.74) - 0.08, -0.74], 0.09, 0.14);
    // rough boards: vertical on the back and the sides, gaps between them
    b.ink({ color: grey, mat: MAT.WOOD, wear: 0.8, snow: 1, vary: 0.12 });
    for (let x = -1.42; x < 1.42; x += 0.2) {
      const h = roofY(-0.74) - 0.05 + r.range(-0.03, 0.02);
      b.plank(h, 0.18 + r.range(-0.02, 0.01), 0.022).move(x + 0.1, h / 2 - 0.02, -0.71);
    }
    for (const sx of [-1, 1]) for (let z = -0.72; z < 0.78; z += 0.2) {
      const h = Math.min(roofY(z), roofY(z + 0.2)) - 0.04 + r.range(-0.03, 0.02);
      b.plank(h, 0.18 + r.range(-0.02, 0.01), 0.022).rotY(Math.PI / 2).move(sx * 1.47, h / 2 - 0.02, z + 0.1);
    }
    // roof: boards under tar paper, battens on top
    b.ink({ color: PAL.timber, mat: MAT.WOOD, wear: 0.7, snow: 0.4 });
    for (let x = -1.6; x < 1.6; x += 0.6) beam(b, [x + 0.3, roofY(-1.0), -1.0], [x + 0.3, roofY(1.0), 1.0], 0.06, 0.1);
    b.ink({ color: PAL.tarPaper, mat: MAT.CLOTH, wear: 0.6, rough: 0.9, snow: 1 });
    const tilt = Math.atan(0.24 / 1.9);
    b.box(3.4, 0.03, 2.1, { bevel: 0.01, rows: 2 }).rotX(-tilt).crumple(0.01, 2).move(0, roofY(0) + 0.07, 0);
    b.ink({ color: PAL.timberDark, mat: MAT.WOOD, wear: 0.7, snow: 1 });
    for (let x = -1.6; x <= 1.61; x += 0.53) b.box(0.05, 0.025, 2.1, { bevel: 0.006 }).rotX(-tilt).move(x, roofY(0) + 0.095, 0);
    icicles(b, [-1.6, roofY(-1.05) + 0.02, -1.06], [1.6, roofY(-1.05) + 0.02, -1.06], { every: 0.12, len: [0.03, 0.3] });
    // the woodpile: split rounds stacked along the back, ends to the front
    const wp = bp.boxes.find((x) => x.tag === 'woodpile')!;
    for (let row = 0; row < 5; row++) {
      const y = 0.08 + row * 0.2;
      if (y > wp.y1 - 0.05) break;
      for (let x = wp.x - wp.hx + 0.08; x < wp.x + wp.hx - 0.06; x += r.range(0.14, 0.2)) {
        b.ink({ color: PAL.bark, mat: MAT.BARK, wear: 0.5, snow: 0.3 });
        const lg = b.log(wp.hz * 2 - r.range(0, 0.08), r.range(0.065, 0.095), { sides: 6, rows: 1, ends: ['saw', 'saw'], peel: r.range(0, 0.4), wood: mixRGB(PAL.heartwood, PAL.timber, 0.3) });
        lg.rotX(Math.PI / 2).rotY(r.range(-0.08, 0.08)).rotZ(r.range(0, 3)).move(x, y + r.range(-0.02, 0.02), wp.z + r.range(-0.03, 0.03));
      }
    }
    // chopping block, split pieces, chips in the snow
    const blk = bp.anchors.block;
    b.ink({ color: PAL.bark, mat: MAT.BARK, wear: 0.5, snow: 1 });
    b.log(0.5, 0.24, { sides: 10, rows: 2, ends: ['saw', 'saw'], peel: 0.3, gnarl: 0.01, wood: mixRGB(PAL.heartwood, PAL.timberDark, 0.25) }).move(blk.x, 0.22, blk.z);
    for (let i = 0; i < 5; i++) {
      const a = r.range(0, 6.28), d = r.range(0.45, 0.9);
      b.ink({ color: PAL.bark, mat: MAT.BARK, wear: 0.5, snow: 1 });
      b.log(0.32, 0.06, { sides: 5, rows: 1, ends: ['saw', 'saw'], peel: 0.3 }).rotZ(Math.PI / 2).rotY(r.range(0, 6.28)).move(blk.x + Math.cos(a) * d, 0.04, blk.z + Math.sin(a) * d);
    }
    drift(b, [[-1.9, 0, -0.95], [0, 0, -1.05], [1.9, 0, -0.95]], 1.1, 0.5);
    drift(b, [[-1.75, 0, -0.9], [-1.8, 0, 0.9]], 0.9, 0.35);
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void fbm3; void hex; void Path;
    return b.build({ ground: true, aoRadius: 0.15 });
  },
  { variants: 1, size: 'structure', desc: 'a lean-to woodshed with split wood stacked inside (blueprint woodshed)', tags: ['cabin'] },
);

register(
  'fishing_hut',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.fishing_hut;
    const S = r.int(0, 1 << 20);
    const FY = 0.1, H = 2.2;
    const roofY = (z: number) => 2.1 + (z + 1.35) * (0.22 / 2.7); // high over the door, falls to the back
    const paint = mixRGB(hex(0x7a2c22), hex(0x8a6a5a), 0.35);
    const door = bp.openings[0];
    // runners and floor deck
    b.ink({ color: PAL.timberDark, mat: MAT.WOOD, wear: 0.7, snow: 1 });
    for (const x of [-0.9, 0.9]) {
      const run = b.box(0.1, 0.07, 2.7, { bevel: 0.01, rows: 6 });
      run.warp((q) => { if (q.z > 1.05) q.y += (q.z - 1.05) ** 2 * 1.6; });
      run.move(x, 0.035, 0);
    }
    b.ink({ color: mixRGB(PAL.plywood, PAL.timber, 0.5), mat: MAT.WOOD, wear: 0.7, snow: 0, vary: 0.06 });
    // floor with the fishing hole cut out
    const hole = bp.anchors.hole;
    const hs = 0.22;
    const floorPieces: [number, number, number, number][] = [
      [-1.2, 1.2, -1.2, hole.z - hs], [-1.2, 1.2, hole.z + hs, 1.2], [-1.2, hole.x - hs, hole.z - hs, hole.z + hs], [hole.x + hs, 1.2, hole.z - hs, hole.z + hs],
    ];
    for (const [x0, x1, z0, z1] of floorPieces) b.box(x1 - x0, 0.03, z1 - z0, { bevel: 0.004 }).move((x0 + x1) / 2, FY - 0.015, (z0 + z1) / 2);
    // the hole: dark water in a ring of ice, the hatch lifted against the shelf
    b.ink({ color: hex(0x0d1418), mat: MAT.ICE, rough: 0.05, wear: 0, snow: 0 });
    b.box(hs * 2, 0.01, hs * 2, { bevel: 0.002 }).move(hole.x, FY - 0.12, hole.z);
    b.ink({ color: PAL.ice, mat: MAT.ICE, rough: 0.3, wear: 0.2, snow: 0 });
    b.tube(hs * 1.05, hs * 0.75, 0.1, { sides: 12 }).move(hole.x, FY - 0.08, hole.z);
    b.ink({ color: mixRGB(PAL.plywood, PAL.timber, 0.5), mat: MAT.WOOD, wear: 0.7, snow: 0 });
    b.box(hs * 2 + 0.04, 0.025, hs * 2 + 0.04, { bevel: 0.004 }).move(0, 0, hs + 0.02).rotX(-1.2).move(hole.x, FY + 0.01, hole.z - hs - 0.02);
    // walls: painted plywood sheets on the outside, raw on the inside, corner trim, battens
    const wall = (x0: number, z0: number, x1: number, z1: number, gapsAlong: [number, number][] = []) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(-(z1 - z0), x1 - x0);
      let s0 = 0;
      const segs: [number, number][] = [];
      for (const g of gapsAlong) { segs.push([s0, g[0]]); s0 = g[1]; }
      segs.push([s0, len]);
      for (const [a, c] of segs) {
        if (c - a < 0.02) continue;
        const m = (a + c) / 2;
        const cx = x0 + ((x1 - x0) * m) / len, cz = z0 + ((z1 - z0) * m) / len;
        b.ink({ color: paint, mat: MAT.PAINT, wear: 0.72, rough: 0.8, snow: 1, vary: 0.05 });
        const top = Math.min(roofY(z0 + ((z1 - z0) * a) / len), roofY(z0 + ((z1 - z0) * c) / len)) - 0.04;
        b.box(c - a, top, 0.02, { bevel: 0.004 }).rotY(yaw).move(cx, top / 2, cz).move(...outward(x0, z0, x1, z1, 0.03));
        b.ink({ color: mixRGB(PAL.plywood, PAL.timber, 0.3), mat: MAT.WOOD, wear: 0.5, snow: 0 });
        b.box(c - a, top - FY, 0.012, { bevel: 0.003 }).rotY(yaw).move(cx, (top + FY) / 2, cz).move(...outward(x0, z0, x1, z1, -0.03));
      }
    };
    const outward = (x0: number, z0: number, x1: number, z1: number, d: number): V3 => {
      // the wall's outward normal (away from the hut's centre)
      let nx = z1 - z0, nz = -(x1 - x0);
      const l = Math.hypot(nx, nz) || 1;
      nx /= l; nz /= l;
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      if (nx * mx + nz * mz < 0) { nx = -nx; nz = -nz; }
      return [nx * d, 0, nz * d];
    };
    wall(-1.2, -1.2, 1.2, -1.2);
    wall(-1.2, -1.2, -1.2, 1.2);
    wall(1.2, -1.2, 1.2, 1.2);
    wall(-1.2, 1.2, 1.2, 1.2, [[door.x - door.w / 2 + 1.2, door.x + door.w / 2 + 1.2]]);
    // framing visible inside: studs, top plate
    b.ink({ color: PAL.pine, mat: MAT.WOOD, wear: 0.5, snow: 0 });
    for (const [x, z] of [[-1.17, -1.17], [1.17, -1.17], [-1.17, 1.17], [1.17, 1.17], [-0.45, 1.17], [0.45, 1.17], [0, -1.17], [-1.17, 0], [1.17, 0]]) b.box(0.045, roofY(z) - 0.1, 0.045, { bevel: 0.004 }).move(x, (roofY(z) - 0.1) / 2 + 0.02, z);
    // corner trim
    b.ink({ color: hex(0xb8b0a0), mat: MAT.PAINT, wear: 0.75, snow: 1 });
    for (const [x, z] of [[-1.22, -1.22], [1.22, -1.22], [-1.22, 1.22], [1.22, 1.22]]) b.box(0.06, roofY(z) - 0.05, 0.06, { bevel: 0.006 }).move(x, (roofY(z) - 0.05) / 2, z);
    // window on the east side
    b.group(() => sash(b, 0.45, 0.35, { cols: 1, rows: 1, frame: hex(0xb8b0a0) })).rotY(Math.PI / 2).move(1.235, 1.45, 0.15);
    // door: plywood on a frame, hinged at x -0.4, swings out
    const hx = door.x - door.w / 2 + 0.01;
    b.part('door', () => {
      b.ink({ color: paint, mat: MAT.PAINT, wear: 0.75, rough: 0.8, snow: 0.5 });
      b.box(door.w - 0.02, door.h - 0.02, 0.025, { bevel: 0.005 }).move(hx + (door.w - 0.02) / 2, FY + door.h / 2, 1.235);
      b.ink({ color: hex(0xb8b0a0), mat: MAT.PAINT, wear: 0.7, snow: 0.5 });
      for (const y of [0.3, door.h - 0.3]) b.box(door.w - 0.1, 0.07, 0.02, { bevel: 0.004 }).move(hx + (door.w - 0.02) / 2, FY + y, 1.255);
      b.ink({ color: PAL.iron, mat: MAT.METAL, wear: 0.8, snow: 0.3 });
      b.box(0.025, 0.12, 0.03, { bevel: 0.005 }).move(hx + door.w - 0.1, FY + 1.0, 1.265);
    }, [hx, FY, 1.235], { axis: [0, 1, 0], open: -1.6 });
    // roof: plywood deck, rolled roofing, drip edge
    b.ink({ color: PAL.plywood, mat: MAT.WOOD, wear: 0.6, snow: 0.3 });
    const tilt = Math.atan(0.22 / 2.7);
    b.box(2.75, 0.02, 2.75, { bevel: 0.004 }).rotX(-tilt).move(0, roofY(0) + 0.0, 0);
    b.ink({ color: hex(0x2b2a28), mat: MAT.CLOTH, wear: 0.6, rough: 0.9, snow: 1 });
    b.box(2.8, 0.012, 2.8, { bevel: 0.004, rows: 2 }).rotX(-tilt).crumple(0.006, 3).move(0, roofY(0) + 0.018, 0);
    icicles(b, [-1.38, roofY(-1.4) - 0.02, -1.41], [1.38, roofY(-1.4) - 0.02, -1.41], { every: 0.12, len: [0.03, 0.25] });
    // stove in the back corner, pipe through the roof
    b.ink({ color: hex(0x2c2c2e), mat: MAT.METAL, wear: 0.8, rough: 0.6, snow: 0 });
    const sx = -0.95, sz = -0.95;
    b.cyl(0.14, 0.32, { sides: 12 }).move(sx, FY + 0.22, sz);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.5;
      b.box(0.02, 0.08, 0.02, { bevel: 0.003 }).move(sx + Math.cos(a) * 0.1, FY + 0.04, sz + Math.sin(a) * 0.1);
    }
    b.ink({ color: hex(0x5c5d5f), mat: MAT.METAL, wear: 0.7, rough: 0.5, snow: 0 });
    const pipeTop = roofY(sz) + 0.55;
    b.cyl(0.05, pipeTop - FY - 0.38, { sides: 10 }).move(sx, (pipeTop + FY + 0.38) / 2, sz);
    b.cone(0.11, 0.08, { sides: 10 }).move(sx, pipeTop + 0.06, sz);
    b.emitter('smoke', [sx, pipeTop + 0.12, sz], { name: 'stovepipe', size: 0.07, source: 'stove' });
    // the bench and the shelf, in their boxes
    b.ink({ color: mixRGB(PAL.plywood, PAL.timber, 0.4), mat: MAT.WOOD, wear: 0.65, snow: 0 });
    const bn = bp.boxes.find((x) => x.tag === 'bench')!;
    b.box(bn.hx * 2, 0.03, bn.hz * 2, { bevel: 0.005 }).move(bn.x, bn.y1 - 0.015, bn.z);
    for (const dz of [-1, 1]) b.box(bn.hx * 2 - 0.04, bn.y1 - bn.y0 - 0.03, 0.025, { bevel: 0.004 }).move(bn.x, (bn.y0 + bn.y1) / 2 - 0.015, bn.z + dz * (bn.hz - 0.05));
    const sh = bp.boxes.find((x) => x.tag === 'shelf')!;
    for (const y of [0.55, sh.y1 - 0.015]) b.box(sh.hx * 2, 0.025, sh.hz * 2, { bevel: 0.004 }).move(sh.x, y, sh.z);
    for (const dx of [-1, 1]) b.box(0.025, sh.y1 - sh.y0, sh.hz * 2, { bevel: 0.004 }).move(sh.x + dx * (sh.hx - 0.015), (sh.y0 + sh.y1) / 2, sh.z);
    // a reel and jig line hung on a nail, a bucket by the hole
    b.ink({ color: hex(0x5a4a3a), mat: MAT.WOOD, wear: 0.6, snow: 0 });
    b.box(0.3, 0.04, 0.03, { bevel: 0.006 }).move(0.9, 1.5, -1.16);
    b.ink({ color: hex(0x7e817f), mat: MAT.METAL, wear: 0.5, snow: 0 });
    b.lathe([[0, 0], [0.11, 0], [0.13, 0.25], [0.125, 0.26], [0, 0.03]], { sides: 12 }).move(0.75, FY, -0.5);
    // snow banked round it (it stands on drifted lake ice)
    drift(b, [[-1.45, 0, -1.7], [0, 0, -1.55], [1.45, 0, -1.7]], 1.0, 0.45);
    drift(b, [[-1.5, 0, -1.4], [-1.55, 0, 1.3]], 0.9, 0.3);
    snowHeap(b, [1.6, 0, 0.9], 0.6, 0.22, 0.5);
    // light inside: the door, the little window
    const aps: Aperture[] = [
      { c: [door.x, FY + door.h / 2, 1.2], n: [0, 0, -1], area: door.w * door.h, gain: 0.4 },
      { c: [1.2, 1.45, 0.15], n: [-1, 0, 0], area: 0.16, gain: 0.8 },
    ];
    roomLight(b, (x, y, z, nx, ny) => {
      if (Math.abs(x) > 1.19 || Math.abs(z) > 1.19 || y < 0.02) return false;
      if (y > roofY(z) - 0.04) return ny < 0;
      return true;
    }, aps, { base: 0.13, gain: 3.0 });
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void S; void Path; void sheet; void fbm3;
    return b.build({ ground: true, aoRadius: 0.15 });
  },
  { variants: 1, size: 'structure', desc: 'the ice-fishing hut on the lake: plywood on runners, stovepipe, hole in the floor (blueprint fishing_hut)', tags: ['lake'] },
);
