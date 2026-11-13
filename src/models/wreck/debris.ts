// The small wreckage strewn along the 200 m skid scar.
//
// 'seat_row' (blueprint seat_row: 1.5 x 0.64 m box, 1.1 m tall, facing +Z): three passenger seats
// torn out of the floor in one piece on their tracks, standing where they came to rest, legs
// bent and sunk into the snow, belts hanging, a cushion gone. Variants (seed & 3) tilt, recline
// and strip them differently.
//
// 'debris_panel' (no collider; placed at scale 0.6 .. 1.4): a torn piece of the aircraft lying on
// the snow, one edge buried. Variants: 0 a window-belt panel with two window holes, white and
// navy; 1 a belly panel scoured to bare metal, concave up and holding snow, stringers showing;
// 2 a grey cowling / fairing piece, strongly curved; 3 a floor panel with its seat track and a
// scrap of carpet.
import { Builder, MAT, PAL, fbm3, hex, type V3 } from '../kit';
import { register } from '../registry';
import { drift, snowHeap } from '../structures/lib';
import { LIVERY, holeOutline, liveryAt, sat, seatUnit, steps, surface } from './hull';

register(
  'seat_row',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const g = b.group(() =>
      seatUnit(b, {
        n: 3,
        pitch: 0.5,
        snow: 1,
        damage: 0.45 + v * 0.12,
        recline: [[0.2, 0.25, 0.3], [0.5, 0.15, 0.2], [0.25, 0.9, 0.3], [0.1, 0.2, 0.65]][v],
        bare: [[], [2], [0], [1]][v],
        fabric: v === 3 ? PAL.seatGrey : PAL.seatBlue,
      }),
    );
    // sunk into the snow and knocked off square
    const tilt = [[0.02, 0.01], [0.09, -0.03], [-0.05, 0.06], [0.03, -0.07]][v];
    g.rotX(tilt[0]).rotZ(tilt[1]).rotY(r.range(-0.04, 0.04)).move(0, -0.05, 0);
    drift(b, [[-0.95, 0, -0.45], [0, 0, -0.55], [0.95, 0, -0.4]], 0.7, 0.18 + 0.05 * v, { lee: 0.5 });
    if (v !== 1) snowHeap(b, [r.range(-0.4, 0.4), 0.42, 0.05], 0.16, 0.06, 0.15);
    b.anchor('seat', [0, 0.45, 0.1]);
    return b.build({ ground: true });
  },
  { variants: 4, size: 'prop', desc: 'three airliner seats torn out on their tracks (blueprint seat_row)', tags: ['wreck'] },
);

register(
  'debris_panel',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const S = r.int(0, 1 << 20);
    // shape: a ragged blob in (u, w), metres; R = curvature radius of the skin
    const W = [1.6, 1.4, 1.2, 1.3][v], H = [1.1, 1.0, 0.9, 0.7][v];
    const R = [1.8, 1.8, 0.62, 40][v];
    const NU = 12, NW = 9;
    const us = steps(-W / 2, W / 2, NU), ws = steps(-H / 2, H / 2, NW);
    const inside = (u: number, w: number) => {
      const a = Math.atan2(w / H, u / W);
      const rr = Math.hypot((u / W) * 2, (w / H) * 2);
      const edge = 0.82 + 0.2 * fbm3(S, Math.cos(a) * 1.7, Math.sin(a) * 1.7, 0, 3) + 0.07 * Math.sin(a * 9 + S);
      return rr < edge;
    };
    const inWin = (u: number, w: number) => v === 0 && (Math.hypot((u + 0.25) / 0.13, (w - 0.05) / 0.17) < 1 || Math.hypot((u - 0.25) / 0.13, (w - 0.05) / 0.17) < 1);
    // the skin curls round the u axis (radius R): concave side toward +Y
    const map = (u: number, w: number, off = 0): V3 => {
      const a = w / R;
      const crumple = 0.025 * fbm3(S + 3, u * 2.4, w * 2.4, 0, 2) * (v === 3 ? 0.3 : 1);
      const rr = R + off + crumple;
      return [u, R - rr * Math.cos(a), rr * Math.sin(a)];
    };
    const keep = (i: number, j: number) => {
      const u = (us[i] + us[i + 1]) / 2, w = (ws[j] + ws[j + 1]) / 2;
      return inside(u, w) && !inWin(u, w);
    };
    const panel = b.group(() => {
      // outer (painted) face toward -Y of the curl, inner (primer, stringers) toward +Y
      const outerCol = v === 1 ? PAL.aluminiumDull : v === 2 ? PAL.liveryGrey : v === 3 ? hex(0x4b4e52) : PAL.liveryWhite;
      b.ink({ color: outerCol, mat: v === 1 ? MAT.METAL : v === 3 ? MAT.PLASTIC : MAT.PAINT, wear: 0.6, rough: v === 1 ? 0.5 : 0.72, snow: 1 });
      const outer = surface(b, us, ws, (u, w) => map(u, w, 0), { keep, flip: true });
      if (v === 0) outer.each((q) => {
        const c = liveryAt(1.25 + q.z * 0.95, 0);
        q.r = c[0]; q.g = c[1]; q.b = c[2];
      });
      b.ink({ color: v === 3 ? hex(0x3a3d41) : PAL.primer, mat: MAT.PAINT, wear: 0.6, rough: 0.7, snow: 1 });
      surface(b, us, ws, (u, w) => map(u, w, -0.003), { keep });
      // stringers and a frame on the inner face
      b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.5, snow: 1 });
      if (v !== 3) {
        for (let w = -H / 2 + 0.12; w < H / 2 - 0.1; w += 0.2) {
          let u0 = -W / 2, u1 = W / 2;
          while (u0 < 0 && !inside(u0, w)) u0 += 0.05;
          while (u1 > 0 && !inside(u1, w)) u1 -= 0.05;
          if (u1 - u0 < 0.2) continue;
          const p0 = map(u0 - r.range(0, 0.18), w, -0.015), p1 = map(u1 + r.range(0, 0.12), w, -0.015);
          b.box(0.018, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), 0.026, { bevel: 0.003, rows: 2 }).bend(r.range(-0.3, 0.3), 'z').span(p0, p1);
        }
        const uf = r.range(-0.2, 0.2);
        const fr = steps(-H / 2 + 0.08, H / 2 - 0.08, 6).filter((w) => inside(uf, w)).map((w) => map(uf, w, -0.04));
        if (fr.length > 1) b.sweep([[-0.04, -0.008], [0.04, -0.008], [0.04, 0.008], [-0.04, 0.008]], fr, { up: [1, 0, 0] });
      } else {
        // a floor panel: the seat track, a carpet scrap
        b.box(0.035, 0.012, W * 0.8, { bevel: 0.003 }).rotY(Math.PI / 2).move(0, 0.008, 0.18);
        b.ink({ color: PAL.carpet, mat: MAT.CLOTH, wear: 0.6, snow: 1 });
        b.box(0.5, 0.01, 0.35, { bevel: 0.003 }).crumple(0.02, 5).move(-0.25, 0.007, -0.12);
      }
      if (v === 0) {
        // window surrounds
        b.ink({ color: hex(0xc4c0b4), mat: MAT.PLASTIC, wear: 0.4, snow: 1 });
        for (const cu of [-0.25, 0.25]) {
          const loop = holeOutline(cu, 0.05, 0.13, 0.175, 12).map(([u, w]) => map(u, w, -0.01));
          b.pipe([...loop, loop[0]], 0.012, { sides: 4 });
        }
      }
    });
    // its resting pose: turned over or not, tilted with one edge dug in, a little roll
    const [tilt, roll, over, lift] = [[0.18, 0.12, Math.PI, 0.2], [0.12, -0.08, 0, 0.04], [0.35, 0.2, 0.25, 0.1], [0.1, 0.05, 0, 0.03]][v];
    panel.rotX(over).rotX(tilt).rotZ(roll).move(0, lift, 0);
    if (v === 1) snowHeap(b, [0.1, 0.06, 0.05], 0.45, 0.1, 0.32);
    drift(b, [[-0.8, 0, -0.55], [0, 0, -0.62], [0.8, 0, -0.5]], 0.6, 0.16, { lee: 0.6 });
    return b.build({ ground: true });
  },
  { variants: 4, size: 'prop', desc: 'a torn piece of the aircraft lying in the snow (no collider)', tags: ['wreck'] },
);

void sat;
void LIVERY;
