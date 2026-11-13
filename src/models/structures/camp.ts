// The survey camp on the exposed shoulder.
//
// 'tent_torn' (blueprint tent_torn: cloth walls 1.3 m tall on x +-1.16 and z -1.56, open front):
// a canvas wall tent on a front and a back pole with a ridge pole at 1.5 m, short side walls to
// eaves at 0.85, staked guy lines. The front flaps are torn away to ragged strips that fly in the
// wind; the roof has a gash that flaps. Variants (seed % 3): 0 khaki, torn roof; 1 olive, a side
// wall split open; 2 khaki, the front pole snapped and the ridge sagging (the site's tent B).
// A ground sheet, a stool on its side, snow blown in.
//
// 'survey_mast' (blueprint survey_mast: a 6 m pole, post collider r 0.09, three guy stakes 2.5 m
// out): a galvanised pole in three sections on a footing, guy wires with turnbuckles to steel
// pickets, a cup anemometer, a wind vane and a whip on the top crossarm, a logger box and a solar
// panel low down, rime feathered on the windward side. Beside it lies the camp's radio antenna:
// a fallen tubular mast with its elements bent and its guys slack in the snow, one still on its
// stake.
import { Builder, MAT, PAL, Path, fbm3, hex, mixRGB, type Part, type V3 } from '../kit';
import { register } from '../registry';
import { BLUEPRINTS } from '../../world/blueprints';
import { drift, place, roomLight, snowHeap, type Aperture } from './lib';

const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

register(
  'tent_torn',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed % 3;
    const bp = BLUEPRINTS.tent_torn;
    const S = r.int(0, 1 << 20);
    const L = 3.2, HW = 1.16, EAVE = 0.85, RIDGE = 1.5;
    const collapsed = v === 2;
    // ridge height along the tent (z from -1.6 at the back to +1.6 at the front)
    const ridgeY = (z: number) => (collapsed ? RIDGE - 0.95 * sat((z + 0.4) / 2.0) ** 1.4 : RIDGE - 0.03 * Math.cos((z / L) * Math.PI) * 0);
    const eaveY = (z: number) => (collapsed ? EAVE - 0.35 * sat((z + 0.2) / 1.8) : EAVE);
    const canvas = v === 1 ? PAL.canvasOlive : mixRGB(PAL.canvas, hex(0x9a8f70), 0.3);
    const cloth = (w: number, h: number, tear: number, edges: ('bottom' | 'top' | 'left' | 'right')[]) =>
      b.cloth(w, h, { nx: Math.max(3, Math.round(w / 0.16)), ny: Math.max(3, Math.round(h / 0.16)), wrinkle: 0.012, tear, tearEdges: edges, thickness: 0.003 });
    b.ink({ color: canvas, mat: MAT.CLOTH, wear: 0.7, rough: 0.95, snow: 1, vary: 0.04 });
    // roof panels: cloth made hanging (x across, y down), warped onto the slope from the ridge to the eave
    for (const side of [-1, 1]) {
      const torn = (v === 0 && side > 0) || (v === 2 && side < 0);
      const p = cloth(L, 1.36, torn ? 0.45 : 0.08, torn ? ['bottom', 'right'] : ['bottom']);
      p.warp((q) => {
        const z = q.x, u = -q.y / 1.36; // 0 ridge .. 1 eave
        const ry = ridgeY(z), ey = eaveY(z);
        const sag = 0.06 * Math.sin(Math.PI * u) * (0.6 + 0.4 * Math.cos((z / L) * Math.PI * 2)) + (collapsed ? 0.15 * Math.sin(Math.PI * u) * sat((z + 0.4) / 2) : 0);
        q.x = side * (HW * u);
        q.y = ry + (ey - ry) * u - sag;
        q.z = z;
      });
      // the canvas trembles on its lines; torn parts fly
      p.sway((vv) => Math.min(2.5, Math.abs(vv.x) * 0.4 + (torn && vv.z > 0.6 ? 0.8 : 0)), torn ? 0.35 : 0.8);
      p.ghost();
    }
    // side walls from the eave down to the ground
    for (const side of [-1, 1]) {
      const split = v === 1 && side > 0;
      const p = cloth(L, EAVE + 0.06, split ? 0.6 : 0.05, split ? ['top', 'left'] : ['bottom']);
      p.warp((q) => {
        const z = q.x, u = -q.y / (EAVE + 0.06);
        const ey = eaveY(z);
        q.x = side * (HW + 0.04 * u + 0.03 * Math.sin(z * 3.1 + S));
        q.y = ey * (1 - u) - 0.04;
        q.z = z;
      });
      p.sway((vv) => Math.min(2.5, (EAVE - vv.y) * 0.5 + (split ? 0.6 : 0)), split ? 0.3 : 0.85);
      p.ghost();
    }
    // back wall: a pentagon up to the ridge
    {
      const p = cloth(HW * 2 + 0.06, RIDGE, 0.05, ['bottom']);
      p.warp((q) => {
        const x = q.x, u = -q.y / RIDGE; // 0 top .. 1 ground
        const top = ridgeY(-1.56) - (ridgeY(-1.56) - eaveY(-1.56)) * Math.min(1, Math.abs(x) / HW);
        q.y = top * (1 - u) - 0.03;
        q.z = -1.56 + 0.04 * Math.sin(x * 2.3) * (1 - u);
      });
      p.sway((vv) => Math.min(2.5, (RIDGE - vv.y) * 0.3), 0.85);
      p.ghost();
    }
    // the front: ragged strips of the torn door flaps hanging from the front edges
    for (const side of [-1, 1]) {
      const p = cloth(0.5, r.range(0.6, 1.0), 0.85, ['bottom', 'left', 'right']);
      const top = (ridgeY(1.6) + eaveY(1.6)) / 2;
      p.rotY(side * 0.3).move(side * 0.55, top + 0.15, 1.62);
      p.sway([side * 0.55, top + 0.15, 1.62], 0.05);
      p.ghost();
    }
    // poles: front and back, the ridge pole; guy lines and stakes
    b.ink({ color: hex(0x6b5a40), mat: MAT.WOOD, wear: 0.6, snow: 1 });
    b.cyl(0.025, ridgeY(-1.56) + 0.05, { sides: 7 }).move(0, (ridgeY(-1.56) + 0.05) / 2, -1.5);
    if (!collapsed) {
      b.cyl(0.025, RIDGE + 0.05, { sides: 7 }).move(0, (RIDGE + 0.05) / 2, 1.55);
      place(b.cyl(0.022, L, { sides: 7 }), [0, RIDGE + 0.01, -1.6], [0, RIDGE + 0.01, 1.6]);
    } else {
      // snapped: the top half lies in the snow, the stump leans
      b.cyl(0.025, 0.7, { sides: 7 }).rotX(0.25).move(0, 0.34, 1.6);
      b.cyl(0.025, 0.9, { sides: 7 }).rotZ(Math.PI / 2 - 0.1).rotY(0.7).move(0.45, 0.04, 2.1);
      place(b.cyl(0.022, L, { sides: 7 }).bend(0.25, 'z'), [0, ridgeY(-1.6) + 0.01, -1.6], [0, ridgeY(1.6) + 0.02, 1.6]);
    }
    b.ink({ color: PAL.rope, mat: MAT.CLOTH, wear: 0.6, snow: 1 });
    const stake = (x: number, z: number) => {
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.8, snow: 1 });
      b.cyl(0.012, 0.3, { sides: 5 }).rotZ(Math.sign(x) * 0.3).move(x, 0.05, z);
      b.ink({ color: PAL.rope, mat: MAT.CLOTH, wear: 0.6, snow: 1 });
    };
    const guys: [V3, V3][] = [
      [[0, ridgeY(-1.6), -1.6], [0, 0.1, -2.6]],
      [[-HW, eaveY(-1.5), -1.5], [-2.0, 0.1, -2.1]], [[HW, eaveY(-1.5), -1.5], [2.0, 0.1, -2.1]],
      [[-HW, eaveY(0), 0], [-2.1, 0.1, 0]], [[HW, eaveY(0), 0], [2.1, 0.1, 0]],
      [[-HW, eaveY(1.5), 1.5], [-2.0, 0.1, 2.1]], [[HW, eaveY(1.5), 1.5], [2.0, 0.1, 2.1]],
    ];
    if (!collapsed) guys.push([[0, RIDGE, 1.6], [0, 0.1, 2.7]]);
    for (const [a, c] of guys) {
      if (collapsed && c[2] > 1.5 && r.chance(0.5)) continue; // pulled out
      b.cable(a, c, 0.04, 0.004, { segs: 6, sides: 4 });
      stake(c[0], c[2]);
    }
    // inside: ground sheet, a stool on its side, a pot
    b.ink({ color: hex(0x2c3a2e), mat: MAT.PLASTIC, wear: 0.6, rough: 0.7, snow: 0 });
    const gs = b.box(2.2, 0.006, 3.0, { bevel: 0.002, rows: 3 });
    gs.crumple(0.012, 2).move(0, 0.01, -0.05);
    b.ink({ color: hex(0x5d5348), mat: MAT.WOOD, wear: 0.6, snow: 0.3 });
    b.group(() => {
      b.box(0.36, 0.03, 0.36, { bevel: 0.006 }).move(0, 0.42, 0);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.03, 0.42, 0.03, { bevel: 0.004 }).rotX(dz * 0.12).rotZ(-dx * 0.12).move(dx * 0.15, 0.21, dz * 0.15);
    }).rotZ(Math.PI / 2).rotY(0.8).move(-0.5, 0.18, -0.6);
    b.ink({ color: hex(0x4a4c4e), mat: MAT.METAL, wear: 0.6, snow: 0.2 });
    b.cyl(0.11, 0.13, { sides: 10, top: false }).rotX(1.3).move(0.4, 0.1, -1.0);
    // snow: drifted against the back and the weather side, blown in along the floor
    drift(b, [[-1.6, 0, -1.85], [0, 0, -1.95], [1.6, 0, -1.85]], 0.9, 0.45);
    drift(b, [[-1.45, 0, -1.6], [-1.5, 0, 1.6]], 0.8, 0.32);
    snowHeap(b, [0.3, 0, 0.9], 0.8, 0.1, 1.0);
    // a little shade inside under the canvas
    const aps: Aperture[] = [{ c: [0, 0.8, 1.6], n: [0, 0, -1], area: 2.2 }];
    roomLight(b, (x, y, z) => Math.abs(x) < HW - 0.02 && z > -1.54 && z < 1.6 && y < eaveY(z) - 0.02, aps, { base: 0.35, gain: 2.0 });
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void fbm3; void Path;
    return b.build({ ground: true });
  },
  { variants: 3, size: 'structure', desc: 'a torn canvas wall tent (blueprint tent_torn); variant 2 half collapsed', tags: ['camp'] },
);

register(
  'survey_mast',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.survey_mast;
    const H = 6.0;
    const lean: V3 = [0.025, 1, -0.012]; // a slight lean off true
    const at = (h: number): V3 => [lean[0] * h, h, lean[2] * h];
    // footing, base plate
    b.ink({ color: PAL.concrete, mat: MAT.ROCK, wear: 0.5, snow: 1 });
    b.cyl(0.16, 0.5, { sides: 12 }).move(0, -0.15, 0);
    b.ink({ color: PAL.galvanised, mat: MAT.METAL, wear: 0.65, rough: 0.5, snow: 1 });
    b.box(0.22, 0.012, 0.22, { bevel: 0.003 }).move(0, 0.106, 0);
    // the pole in three sections with couplers
    const secs: [number, number, number][] = [[0.1, 2.1, 0.045], [2.1, 4.1, 0.04], [4.1, H, 0.034]];
    for (const [h0, h1, rr] of secs) {
      place(b.cyl(rr, h1 - h0, { sides: 10, bevel: 0.002 }), at(h0), at(h1));
      place(b.cyl(rr + 0.012, 0.12, { sides: 10, bevel: 0.004 }), at(h1 - 0.06), at(h1 + 0.06));
    }
    // guys to the three stakes, turnbuckles, pickets
    for (const k of ['stake1', 'stake2', 'stake3']) {
      const s = bp.anchors[k];
      const top = at(4.4);
      const st: V3 = [s.x, 0.25, s.z];
      b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.5, snow: 1 });
      b.cable(top, st, 0.03, 0.0035, { segs: 8, sides: 4 });
      place(b.cyl(0.008, 0.18, { sides: 5 }), [s.x * 0.97, 0.36, s.z * 0.97], [s.x, 0.22, s.z]);
      b.ink({ color: PAL.rustDark, mat: MAT.METAL, wear: 1.1, rough: 0.8, snow: 1 });
      b.box(0.04, 0.6, 0.04, { bevel: 0.004 }).rotX(0.25 * Math.sign(s.z || 1)).move(s.x, 0.0, s.z);
    }
    b.ink({ color: PAL.galvanised, mat: MAT.METAL, wear: 0.6, snow: 1 });
    b.torus(0.05, 0.008, { segs: 10, sides: 4 }).move(...at(4.4));
    // crossarm at the top: cup anemometer, wind vane, whip, lightning rod
    const ct = at(H - 0.15);
    place(b.cyl(0.018, 1.1, { sides: 8 }), [ct[0] - 0.55, ct[1], ct[2]], [ct[0] + 0.55, ct[1], ct[2]]);
    {
      const ax = ct[0] - 0.5, ay = ct[1], az = ct[2];
      b.cyl(0.012, 0.22, { sides: 6 }).move(ax, ay + 0.11, az);
      const rot = r.range(0, 6.28);
      for (let k = 0; k < 3; k++) {
        const a = rot + (k / 3) * Math.PI * 2;
        const ex: V3 = [ax + Math.cos(a) * 0.14, ay + 0.24, az + Math.sin(a) * 0.14];
        place(b.cyl(0.004, 0.14, { sides: 4 }), [ax, ay + 0.24, az], ex);
        b.ink({ color: hex(0x2d2f31), mat: MAT.PLASTIC, wear: 0.4, snow: 1 });
        b.sphere([0.035, 0.035, 0.035], { sides: 8, rings: 4 }).move(ex[0], ex[1], ex[2]);
        b.ink({ color: PAL.galvanised, mat: MAT.METAL, wear: 0.6, snow: 1 });
      }
      const vx = ct[0] + 0.5;
      b.cyl(0.01, 0.2, { sides: 6 }).move(vx, ay + 0.1, az);
      const vane = b.box(0.42, 0.005, 0.005, { bevel: 0.001 });
      vane.move(0.06, 0, 0).rotY(r.range(0, 6.28)).move(vx, ay + 0.22, az);
      b.box(0.005, 0.1, 0.14, { bevel: 0.001 }).move(vx - 0.16, ay + 0.22, az);
      b.cyl(0.004, 0.9, { sides: 4 }).move(ct[0], ct[1] + 0.5, ct[2]);
    }
    // the logger box and its solar panel at 1.5 m
    b.ink({ color: hex(0x8d9092), mat: MAT.PAINT, wear: 0.55, snow: 1 });
    b.box(0.3, 0.38, 0.16, { bevel: 0.015 }).move(0.04, 1.5, 0.11);
    b.ink({ color: hex(0x1d2430), mat: MAT.PLASTIC, rough: 0.2, wear: 0.4, snow: 1 });
    b.box(0.48, 0.02, 0.36, { bevel: 0.006 }).rotX(0.9).move(0.05, 2.15, 0.2);
    b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.4, snow: 1 });
    b.pipe(Path.spline([[0.04, 1.3, 0.11], [0.06, 1.0, 0.1], [0.05, 0.5, 0.06], [0.03, 0.2, 0.06]], 3), 0.006, { sides: 4 });
    // rime feathered on the windward (-X) side of the pole and the logger
    b.ink({ color: hex(0xc9d4db), mat: MAT.ICE, rough: 0.6, wear: 0.1, snow: 0 });
    for (let h = 1.0; h < H - 0.3; h += 0.18) {
      const p = at(h);
      const rr = h < 2.1 ? 0.045 : h < 4.1 ? 0.04 : 0.034;
      b.box(0.06 + r.range(0, 0.04), 0.1, 0.03, { bevel: 0.006 }).rotZ(-0.3).move(p[0] - rr - 0.03, p[1], p[2] + r.range(-0.01, 0.01)).ghost();
    }
    // the fallen radio antenna: a tubular mast lying in the snow, its elements bent, guys slack
    {
      const a0: V3 = [0.45, 0.06, -0.3], a1: V3 = [3.55, 0.12, -3.1];
      b.ink({ color: hex(0x9a9d98), mat: MAT.METAL, wear: 0.7, rough: 0.5, snow: 1 });
      const m = b.cyl(0.03, 1, { sides: 8, rows: 6 });
      m.scale(1, Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]), 1).bend(0.12, 'z');
      place(m, a0, a1, [0, 1, 0]);
      // a dipole frame at its head, one element folded under
      const d: V3 = [(a1[0] - a0[0]) / 4.17, 0, (a1[2] - a0[2]) / 4.17];
      for (let k = 0; k < 3; k++) {
        const c: V3 = [a1[0] - d[0] * (k * 0.25), a1[1] + 0.02, a1[2] - d[2] * (k * 0.25)];
        const perp: V3 = [-d[2], 0, d[0]];
        place(b.cyl(0.008, 1, { sides: 5 }).scale(1, 1.4 - k * 0.2, 1).bend(k === 1 ? 0.8 : 0.1, 'z'), [c[0] - perp[0] * 0.7, c[1] + (k === 1 ? 0.15 : 0.02), c[2] - perp[2] * 0.7], [c[0] + perp[0] * 0.7, c[1], c[2] + perp[2] * 0.7]);
      }
      b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.5, snow: 1 });
      const s2 = bp.anchors.stake2;
      b.cable([2.2, 0.1, -1.95], [s2.x, 0.25, s2.z], 0.0, 0.0035, { segs: 3, sides: 4 });
      for (let k = 0; k < 2; k++) {
        const p0: V3 = [1.2 + k * 1.2, 0.08, -1.0 - k * 1.1];
        b.pipe(Path.spline([p0, [p0[0] - 0.6, 0.03, p0[2] - 0.4], [p0[0] - 0.9, 0.02, p0[2] + 0.3], [p0[0] - 1.6, 0.02, p0[2] + 0.1]], 3), 0.0035, { sides: 4 }).ghost();
      }
    }
    drift(b, [[-0.6, 0, -0.4], [-0.5, 0, 0.5]], 0.6, 0.2);
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void (null as unknown as Part);
    return b.build({ ground: true });
  },
  { variants: 1, size: 'structure', desc: 'the survey mast: guyed 6 m pole with anemometer and vane, a fallen radio antenna beside it (blueprint survey_mast)', tags: ['camp'] },
);
