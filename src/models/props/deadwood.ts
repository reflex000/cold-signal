// Dead wood for the axe (WoodEnt): drawn by src/game/standin/markers.ts in place of its posts,
// cylinders and boxes (POLISH). Sizes follow what the markers drew (and the simulation reaches
// for): the instance is scaled by WoodEnt.scale.
//   snag        a dead standing spruce, ~6.8 m: silver, barkless in long strips, a broken top,
//               dead branch stubs pointing down, a flared foot
//   deadfall    a fallen trunk ~2.6 m long along X, broken at both ends, stubs, sunk into the snow
//   stump       a broken stump ~0.5 m with splinters and roots
//   branchpile  cut branches heaped by the cabin, ~1.6 x 1.1 m
// Owner: POLISH.
import { Builder, MAT, PAL, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';

const TAU = Math.PI * 2;

function stub(b: Builder, at: V3, az: number, droop: number, len: number, r0: number, bark: readonly [number, number, number], dead: readonly [number, number, number]): void {
  const r = b.rng;
  const p = b.log(len, r0, { r2: r0 * 0.35, sides: 5, rows: 2, ends: ['saw', r.chance(0.6) ? 'break' : 'taper'], bend: r.range(0, 0.25), bark, deadwood: dead, peel: 0.8 });
  // made along +Y: lay it out from the trunk at `az`, drooping by `droop`
  p.move(0, len / 2, 0).rotZ(-(Math.PI / 2 + droop)).rotY(-az).move(at[0], at[1], at[2]);
}

register(
  'snag',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const H = [6.8, 6.0, 7.4, 5.2][v];
    const R0 = 0.17;
    const bark = mixRGB(PAL.bark, PAL.barkGrey, r.range(0.3, 0.8));
    const dead = mixRGB(PAL.deadwood, hex(0x6e675e), r.range(0.1, 0.6));
    b.ink({ color: bark, mat: MAT.BARK, wear: 0.7 });
    const trunk = b.log(H, R0, { r2: R0 * 0.3, sides: 10, rows: 14, ends: ['saw', 'break'], bend: r.range(0.02, 0.08), gnarl: R0 * 0.08, peel: [0.85, 0.7, 0.95, 0.6][v], knots: 6, bark, deadwood: dead });
    trunk.move(0, H / 2 - 0.15, 0);
    // a slight lean, as old snags have
    trunk.rotZ(r.range(-0.04, 0.04)).rotX(r.range(-0.04, 0.04));
    // the flared foot: four or five root buttresses running into the snow
    const nr = 4 + r.int(0, 1);
    for (let i = 0; i < nr; i++) {
      const a = (i / nr) * TAU + r.range(-0.3, 0.3);
      const L = r.range(0.45, 0.7);
      const root = b.log(L, R0 * 0.55, { r2: R0 * 0.12, sides: 6, rows: 2, ends: ['saw', 'taper'], bark, deadwood: dead, peel: 0.5 });
      root.move(0, L / 2, 0).rotZ(-(Math.PI / 2 + 0.5)).rotY(-a).move(Math.cos(a) * R0 * 0.5, 0.3, Math.sin(a) * R0 * 0.5);
    }
    // dead branch stubs in whorls, longer low down, drooping, most broken short
    for (let y = 1.1; y < H - 0.6; y += r.range(0.32, 0.55)) {
      const t = y / H;
      const n = r.int(1, 3);
      const a0 = r.range(0, TAU);
      for (let k = 0; k < n; k++) {
        const az = a0 + (k / n) * TAU + r.range(-0.4, 0.4);
        const rr = R0 * (1 - 0.7 * t);
        const len = (r.chance(0.7) ? r.range(0.12, 0.35) : r.range(0.45, 0.9)) * (1.1 - 0.6 * t);
        stub(b, [Math.cos(az) * rr * 0.8, y, Math.sin(az) * rr * 0.8], az, r.range(0.15, 0.45), len, Math.max(0.012, rr * 0.22), bark, dead);
      }
    }
    b.anchor('chop', [0, 1.0, 0]);
    return b.build({ aoRadius: 0.3 });
  },
  { variants: 4, size: 'prop', desc: 'a dead standing spruce for the axe', tags: ['wood'] },
);

register(
  'deadfall',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const L = 2.6, R = 0.2;
    const bark = mixRGB(PAL.bark, PAL.barkGrey, r.range(0.2, 0.8));
    const dead = mixRGB(PAL.deadwood, hex(0x6a6258), r.range(0.2, 0.7));
    b.ink({ color: bark, mat: MAT.BARK, wear: 0.65 });
    const log = b.log(L, R, { r2: R * 0.7, sides: 11, rows: 8, ends: ['break', v === 1 ? 'saw' : 'break'], bend: r.range(0.05, 0.15), gnarl: R * 0.08, peel: r.range(0.3, 0.8), knots: 4, bark, deadwood: dead });
    // lying along X, a third of its depth in the snow
    log.rotZ(Math.PI / 2).move(0, R * 0.62, 0);
    // stubs of the branches it fell on, pointing up and out
    for (let x = -L / 2 + 0.3; x < L / 2 - 0.2; x += r.range(0.25, 0.45)) {
      const az = r.range(-1.2, 1.2) + (r.chance(0.5) ? 0 : Math.PI);
      const len = r.range(0.12, 0.5);
      const rr = R * (0.85 - 0.25 * ((x + L / 2) / L));
      const p = b.log(len, Math.max(0.014, rr * 0.18), { r2: 0.008, sides: 5, rows: 2, ends: ['saw', 'break'], bend: 0.2, bark, deadwood: dead, peel: 0.7 });
      // around the log's axis (X): az from straight up
      p.move(0, len / 2, 0).rotX(az * 0.8).move(x, R * 0.62 + Math.cos(az * 0.8) * rr * 0.8, Math.sin(az * 0.8) * rr * 0.8);
    }
    // variant 2 keeps a plate of torn roots at one end
    if (v === 2) {
      b.ink({ color: mixRGB(bark, hex(0x2f2a24), 0.5), mat: MAT.BARK, wear: 0.6 });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU;
        const len = r.range(0.4, 0.75);
        const p = b.log(len, 0.05, { r2: 0.012, sides: 5, rows: 2, ends: ['saw', 'taper'], bend: 0.4, bark, deadwood: dead });
        p.move(0, len / 2, 0).rotX(a).move(-L / 2 - 0.05, R * 0.62 + Math.cos(a) * 0.1, Math.sin(a) * 0.1);
      }
    }
    b.anchor('chop', [0, R * 1.2, 0]);
    return b.build({ aoRadius: 0.2 });
  },
  { variants: 4, size: 'prop', desc: 'a fallen trunk along X for the axe', tags: ['wood'] },
);

register(
  'stump',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const R = 0.28, H = 0.5;
    const bark = mixRGB(PAL.bark, PAL.barkGrey, r.range(0.2, 0.7));
    const dead = mixRGB(PAL.deadwood, hex(0x6a6258), r.range(0.2, 0.6));
    b.ink({ color: bark, mat: MAT.BARK, wear: 0.6 });
    b.log(H, R, { r2: R * 0.85, sides: 12, rows: 3, ends: ['saw', 'break'], gnarl: R * 0.1, peel: r.range(0.2, 0.6), bark, deadwood: dead }).move(0, H / 2 - 0.05, 0);
    // splinters standing up from the break
    b.ink({ color: dead, mat: MAT.WOOD, wear: 0.6, grain: 'y' });
    for (let i = 0; i < 6; i++) {
      const a = r.range(0, TAU);
      const h = r.range(0.08, 0.28);
      b.box(r.range(0.02, 0.05), h, r.range(0.015, 0.03), { bevel: 0.004 }).taper(0.2, 1).rotY(-a).move(Math.cos(a) * R * 0.6, H - 0.05 + h / 2, Math.sin(a) * R * 0.6);
    }
    b.ink({ color: bark, mat: MAT.BARK, wear: 0.6 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + r.range(-0.3, 0.3);
      const L = r.range(0.35, 0.6);
      b.log(L, R * 0.4, { r2: R * 0.1, sides: 6, rows: 2, ends: ['saw', 'taper'], bark, deadwood: dead }).move(0, L / 2, 0).rotZ(-(Math.PI / 2 + 0.45)).rotY(-a).move(Math.cos(a) * R * 0.6, 0.2, Math.sin(a) * R * 0.6);
    }
    return b.build({ aoRadius: 0.15 });
  },
  { variants: 2, size: 'prop', desc: 'a broken stump for the axe', tags: ['wood'] },
);

register(
  'branchpile',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    // limbed branches dragged into a heap beside the woodshed, the cut ends toward +X
    for (let i = 0; i < 22; i++) {
      const bark = mixRGB(PAL.bark, PAL.barkGrey, r.range(0, 0.8));
      const dead = mixRGB(PAL.deadwood, hex(0x6a6258), r.range(0.1, 0.6));
      b.ink({ color: bark, mat: MAT.BARK, wear: 0.6 });
      const len = r.range(1.1, 1.8);
      const rad = r.range(0.02, 0.05);
      const p = b.log(len, rad, { r2: rad * 0.3, sides: 6, rows: 4, ends: ['saw', 'taper'], bend: r.range(0.1, 0.4), bark, deadwood: dead, peel: r.range(0, 0.5) });
      const layer = Math.floor(i / 7);
      p.rotZ(Math.PI / 2 + r.range(-0.12, 0.12)).rotY(r.range(-0.35, 0.35)).move(r.range(-0.2, 0.2), rad + layer * 0.12 + r.range(0, 0.06), r.range(-0.5, 0.5) * (1 - layer * 0.25));
      // a few side twigs
      if (r.chance(0.6)) {
        const tl = r.range(0.2, 0.45);
        const tw = b.log(tl, rad * 0.4, { r2: rad * 0.12, sides: 5, rows: 2, ends: ['saw', 'taper'], bend: 0.3, bark, deadwood: dead });
        tw.move(0, tl / 2, 0).rotZ(r.range(-1, 1)).rotX(r.range(-0.8, 0.8)).move(r.range(-0.4, 0.4), rad + layer * 0.12 + 0.03, r.range(-0.4, 0.4));
      }
    }
    return b.build({ aoRadius: 0.2 });
  },
  { variants: 1, size: 'prop', desc: 'a heap of limbed branches', tags: ['wood'] },
);
