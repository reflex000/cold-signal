// The small things lying about the mountain that a player takes: the pickups the simulation spawns
// (PickupEnt items without a tool model, CrateEnt 'medkit', DeviceEnt 'note'), drawn by
// src/game/standin/markers.ts in place of its coloured boxes (POLISH). Small, worn, real-sized:
//   pickup_sticks   2 to 4 dead sticks dropped across each other (fuel)
//   pickup_logs     2 or 3 split billets, bark on the round side, the split face pale
//   pickup_tinder   a twist of dry grass with curls of birch bark
//   pickup_ammo     a squashed carton of rifle rounds, two loose rounds beside it
//   pickup_medkit   a grey first-aid case with a red cross and a carry handle (crate 'medkit')
//   note            a sheet of paper, folded once and curling, weighted with a stone
//   part_battery    the tail's ELT battery pack: a yellow moulded case, connector and cut leads
//   part_handset    the cabin radio's handset with a coiled cord
//   part_fuse       a cartridge fuse in a scrap of corrugated card
//   part_tube       a valve (vacuum tube) half out of its printed carton
//   part_coil       the antenna loading coil: copper on a ribbed white former, brass end caps
// Every model lies on y = 0 centred on the origin; the long axis runs along X.
// Owner: POLISH (pickups had been drawn as plain coloured boxes).
import { Builder, MAT, PAL, Path, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';

const TAU = Math.PI * 2;

register(
  'pickup_sticks',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const n = [2, 3, 3, 4][v];
    for (let i = 0; i < n; i++) {
      const rad = r.range(0.011, 0.022);
      const len = r.range(0.42, 0.7);
      const bark = r.chance(0.3) ? mixRGB(PAL.bark, PAL.barkGrey, 0.5) : mixRGB(PAL.barkGrey, PAL.deadwood, r.range(0.1, 0.5));
      b.ink({ color: bark, mat: MAT.BARK, wear: r.range(0.4, 0.8) });
      const p = b.log(len, rad, {
        r2: rad * r.range(0.55, 0.85),
        sides: 6,
        rows: 4,
        ends: [r.chance(0.6) ? 'break' : 'saw', r.chance(0.5) ? 'taper' : 'break'],
        bend: r.range(0.05, 0.35),
        gnarl: rad * 0.1,
        peel: r.range(0.1, 0.7),
        knots: r.int(0, 2),
        bark,
        deadwood: mixRGB(PAL.deadwood, hex(0x6f675d), r.range(0, 0.5)),
      });
      // dropped, not stacked: each lies across the others at its own angle, the upper ones resting on the lower
      const yaw = (i - (n - 1) / 2) * r.range(0.25, 0.7) + r.range(-0.2, 0.2);
      p.rotZ(Math.PI / 2 + r.range(-0.05, 0.05)).rotY(yaw).move(r.range(-0.06, 0.06), rad * 0.8 + (i > 0 && r.chance(0.5) ? 0.014 : 0), r.range(-0.08, 0.08));
      if (rad < 0.017 && r.chance(0.5)) {
        const fl = r.range(0.1, 0.18), phi = yaw + r.sign() * r.range(0.4, 0.7);
        const tw = b.log(fl, rad * 0.5, { r2: rad * 0.2, sides: 5, rows: 2, ends: ['saw', 'taper'], bend: 0.25, bark });
        tw.rotZ(Math.PI / 2).rotY(phi).move(Math.cos(phi) * fl * 0.4, rad * 0.8, -Math.sin(phi) * fl * 0.4);
      }
    }
    b.anchor('grab', [0, 0.04, 0]);
    return b.build({ aoRadius: 0.03 });
  },
  { variants: 4, size: 'item', desc: 'a few dead sticks dropped across each other', tags: ['wood', 'pickup'] },
);

register(
  'pickup_logs',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const n = v === 3 ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const len = r.range(0.38, 0.46);
      const R = r.range(0.07, 0.095);
      // a quarter (or a third) of a round, split along the grain: the arc is bark, the faces raw wood
      const a1 = r.chance(0.5) ? Math.PI / 2 : (2 * Math.PI) / 3;
      const poly: [number, number][] = [[0, 0]];
      const steps = 6;
      for (let k = 0; k <= steps; k++) {
        const a = (a1 * k) / steps;
        poly.push([Math.cos(a) * R * (1 + r.range(-0.03, 0.03)), Math.sin(a) * R * (1 + r.range(-0.03, 0.03))]);
      }
      const bark = mixRGB(PAL.bark, PAL.barkGrey, r.range(0.2, 0.7));
      const wood = mixRGB(PAL.pine, PAL.heartwood, r.range(0.2, 0.8));
      b.ink({ color: wood, mat: MAT.WOOD, wear: r.range(0.3, 0.6), grain: 'y', vary: 0.08, pith: [0, 0] });
      const p = b.extrude(poly, len, { bevel: 0.004, rows: 3 });
      // the round side keeps its bark (neighbouring material ids: WOOD -> BARK is allowed per vertex)
      p.each((q) => {
        const d = Math.hypot(q.x, q.z);
        if (d > R * 0.9 && Math.abs(q.y) < len / 2 - 0.004) {
          q.mat = MAT.BARK;
          q.r = bark[0]; q.g = bark[1]; q.b = bark[2];
          q.rough = 0.95;
        }
      });
      p.crumple(0.003, 6);
      // lying on a split face, along X, side by side or one across two
      const lay = i === 2 ? [0, 0.075, 0, Math.PI / 2 + r.range(-0.3, 0.3)] : [0, 0, (i - 0.5) * 0.15, r.range(-0.15, 0.15)];
      p.rotZ(-Math.PI / 2).rotX(-a1 / 2 + Math.PI / 2 + r.range(-0.2, 0.2)).rotY(lay[3]).move(lay[0], lay[1] + R * 0.55, lay[2]);
    }
    b.anchor('grab', [0, 0.12, 0]);
    return b.build({ aoRadius: 0.05 });
  },
  { variants: 4, size: 'item', desc: 'two or three split billets of firewood', tags: ['wood', 'pickup'] },
);

register(
  'pickup_tinder',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    // dry grass: a loose twist of blades, pale straw
    b.ink({ color: hex(0xa48f62), mat: MAT.CLOTH, wear: 0.6, vary: 0.12, detailScale: 3 });
    for (let i = 0; i < 26; i++) {
      const L = r.range(0.12, 0.2);
      const a = r.range(-0.6, 0.6);
      const y = r.range(0.004, 0.03);
      const mid: V3 = [r.range(-0.03, 0.03), y + r.range(0.005, 0.02), r.range(-0.02, 0.02)];
      const p0: V3 = [Math.cos(a) * -L / 2, y, Math.sin(a) * L / 2];
      const p1: V3 = [Math.cos(a) * L / 2, y + r.range(0, 0.015), -Math.sin(a) * L / 2];
      b.pipe(Path.spline([p0, mid, p1], 4), r.range(0.0012, 0.002), { sides: 3 });
    }
    // curls of birch bark: white outside, tan inside
    for (let i = 0; i < 3; i++) {
      b.ink({ color: mixRGB(hex(0xd8d4c8), hex(0xb7a88a), r.range(0, 0.4)), mat: MAT.BARK, wear: 0.5 });
      const R0 = r.range(0.01, 0.016);
      const c = b.lathe([[R0, -0.025], [R0 * 1.1, 0], [R0, 0.025]], { sides: 7, arc: [0, r.range(3.6, 5.2)] });
      c.rotZ(Math.PI / 2).rotY(r.range(0, TAU)).move(r.range(-0.04, 0.04), R0 + 0.004, r.range(-0.03, 0.03));
    }
    return b.build({ aoRadius: 0.02 });
  },
  { variants: 2, size: 'item', desc: 'a twist of dry grass and birch bark', tags: ['pickup'] },
);

register(
  'pickup_ammo',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    // a carton of rounds, the lid tucked, the card soft at the corners
    b.ink({ color: hex(0x6f5a3c), mat: MAT.CLOTH, wear: 0.65, rough: 0.9, detailScale: 2 });
    b.box(0.09, 0.034, 0.058, { bevel: 0.003 }).crumple(0.0015, 8).move(0, 0.017, 0);
    b.ink({ color: hex(0xb8b29d), mat: MAT.CLOTH, wear: 0.4 });
    b.box(0.05, 0.0012, 0.04, { bevel: 0.0004 }).move(0.008, 0.0345, 0); // the label
    b.ink({ color: hex(0x2b2722), mat: MAT.PAINT, wear: 0.2 });
    b.stencil('308', 0.012).rotX(-Math.PI / 2).move(0.005, 0.0353, 0.004);
    // two loose rounds: brass case, copper-jacketed bullet
    for (let i = 0; i < 2; i++) {
      const g = b.group(() => {
        b.ink({ color: PAL.brass, mat: MAT.METAL, wear: 0.3, rough: 0.35 });
        b.cyl(0.006, 0.05, { sides: 10, r2: 0.0059, bevel: 0.0006 }).move(0, 0.025, 0);
        b.ink({ color: hex(0x9a5a34), mat: MAT.METAL, wear: 0.25, rough: 0.3 });
        b.cone(0.0045, 0.021, { sides: 10 }).move(0, 0.06, 0);
      });
      g.rotZ(Math.PI / 2).rotY(r.range(-0.6, 0.6)).move(0.07 + i * 0.012, 0.006, -0.03 + i * 0.05);
    }
    return b.build({ aoRadius: 0.015 });
  },
  { variants: 2, size: 'item', desc: 'a carton of rifle rounds with two loose', tags: ['pickup'] },
);

register(
  'pickup_medkit',
  (seed) => {
    const b = new Builder(seed);
    const W = 0.42, H = 0.15, D = 0.26;
    // pressed steel, enamel worn at the edges, a red cross on the lid
    b.ink({ color: hex(0xb9b8b0), mat: MAT.PAINT, wear: 0.45, vary: 0.04 });
    b.box(W, H * 0.62, D, { bevel: 0.008 }).move(0, H * 0.31, 0);
    b.part('lid', () => {
      b.ink({ color: hex(0xb9b8b0), mat: MAT.PAINT, wear: 0.45 });
      b.box(W + 0.006, H * 0.38, D + 0.006, { bevel: 0.009 }).move(0, H * 0.81, 0);
      b.ink({ color: PAL.liveryRed, mat: MAT.PAINT, wear: 0.35 });
      b.box(0.11, 0.0015, 0.034, { bevel: 0.0005 }).move(0, H + 0.0008, 0);
      b.box(0.034, 0.0015, 0.11, { bevel: 0.0005 }).move(0, H + 0.0008, 0);
      // the handle, folded down on the lid
      b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.3 });
      b.pipe(Path.fillet([[-0.07, H + 0.004, D / 2 - 0.02], [-0.07, H + 0.012, D / 2 - 0.05], [0.07, H + 0.012, D / 2 - 0.05], [0.07, H + 0.004, D / 2 - 0.02]], 0.01), 0.006, { sides: 6 });
    }, [0, H * 0.62, -D / 2], { axis: [1, 0, 0], open: -1.9 });
    // latches
    b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.4 });
    for (const s of [-1, 1]) b.box(0.03, 0.03, 0.006, { bevel: 0.002 }).move(s * 0.12, H * 0.62, D / 2 + 0.004);
    b.anchor('grab', [0, H, 0]);
    return b.build({ aoRadius: 0.05 });
  },
  { variants: 1, size: 'item', desc: 'a steel first-aid case, lid opens (part "lid")', tags: ['loot', 'crate'] },
);

register(
  'note',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    // a sheet folded once, the halves lifting, ruled in faded ink
    b.ink({ color: hex(0xcfc8b3), mat: MAT.CLOTH, wear: 0.5, rough: 0.9, vary: 0.05, snow: 0.6 });
    const half = b.box(0.21, 0.0008, 0.15, { bevel: 0.0003, rows: 4 }).move(0, 0, 0.075);
    half.warp((p) => { p.y += 0.012 * (p.z / 0.15) ** 2 + 0.002 * Math.sin(p.x * 30); });
    const other = b.box(0.21, 0.0008, 0.15, { bevel: 0.0003, rows: 4 }).move(0, 0, -0.075);
    other.warp((p) => { p.y += 0.02 * (-p.z / 0.15) ** 1.6; });
    b.ink({ color: hex(0x4a5260), mat: MAT.CLOTH, wear: 0.6 });
    for (let i = 0; i < 6; i++) b.box(0.17, 0.0003, 0.0015).move(0, 0.0012 + 0.0003 * i, 0.02 + i * 0.019);
    // a stone on it against the wind
    b.ink({ color: PAL.iron, mat: MAT.ROCK, wear: 0.5 });
    b.rock(0.035, { squash: [1, 0.55, 0.9], flat: 0.2 }).move(r.range(-0.05, 0.05), 0.014, 0.05);
    return b.build({ aoRadius: 0.02 });
  },
  { variants: 1, size: 'item', desc: 'a folded note held down by a stone', tags: ['pickup'] },
);

register(
  'part_battery',
  (seed) => {
    const b = new Builder(seed);
    // the ELT's battery: a moulded yellow pack, a stencilled date, a plug and two cut leads
    b.ink({ color: hex(0xc9a02a), mat: MAT.PLASTIC, wear: 0.45, rough: 0.6 });
    b.box(0.2, 0.075, 0.11, { bevel: 0.008 }).crumple(0.001, 6).move(0, 0.0375, 0);
    b.ink({ color: hex(0x2a2a2a), mat: MAT.PAINT, wear: 0.3 });
    b.stencil('ELT BATT', 0.014).rotX(-Math.PI / 2).move(-0.02, 0.0755, 0.01);
    b.stencil('EXP 06', 0.01).rotX(-Math.PI / 2).move(-0.02, 0.0755, -0.022);
    b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.3 });
    b.box(0.03, 0.025, 0.035, { bevel: 0.003 }).move(0.112, 0.03, 0.02);
    for (const [c, z] of [[PAL.liveryRed, 0.012], [PAL.plasticBlack, 0.028]] as const) {
      b.ink({ color: c, mat: MAT.PLASTIC, wear: 0.3 });
      b.pipe(Path.spline([[0.125, 0.03, z], [0.16, 0.02, z + 0.01], [0.19, 0.006, z - 0.02], [0.22, 0.004, z - 0.01]], 4), 0.0028, { sides: 5 });
    }
    b.anchor('grab', [0, 0.08, 0]);
    return b.build({ aoRadius: 0.03 });
  },
  { variants: 1, size: 'item', desc: 'the ELT battery pack (radio part)', tags: ['pickup', 'part'] },
);

register(
  'part_handset',
  (seed) => {
    const b = new Builder(seed);
    // a radio handset: grip with ear and mouth cups, a press-to-talk bar, the coiled cord
    b.ink({ color: hex(0x24262a), mat: MAT.PLASTIC, wear: 0.35, rough: 0.45 });
    const grip = b.capsule(0.017, 0.15, { sides: 10 });
    grip.scale(1, 1, 0.8).rotZ(Math.PI / 2).bend(0.5, 'z').move(0, 0.03, 0);
    for (const s of [-1, 1]) b.cyl(0.03, 0.03, { sides: 12, r2: 0.026, bevel: 0.004 }).rotZ(s * 0.25).move(s * 0.095, 0.022, 0);
    b.ink({ color: hex(0x6e6f70), mat: MAT.METAL, wear: 0.3 });
    b.box(0.04, 0.008, 0.012, { bevel: 0.002 }).move(0, 0.051, 0);
    // the coiled cord, sprung loose, ending in a torn plug
    b.ink({ color: hex(0x1b1c1f), mat: MAT.RUBBER, wear: 0.2 });
    const coil: V3[] = [];
    for (let i = 0; i <= 90; i++) {
      const t = i / 90;
      const a = t * 18 * TAU;
      coil.push([-0.11 - 0.2 * t + Math.cos(a) * 0.008, 0.012 + Math.sin(a) * 0.008, 0.01 + 0.06 * Math.sin(t * 3) + Math.sin(a) * 0.002]);
    }
    b.pipe(coil, 0.0016, { sides: 4 });
    b.anchor('grab', [0, 0.06, 0]);
    return b.build({ aoRadius: 0.02 });
  },
  { variants: 1, size: 'item', desc: 'the radio handset with its coiled cord (radio part)', tags: ['pickup', 'part'] },
);

register(
  'part_fuse',
  (seed) => {
    const b = new Builder(seed);
    // a scrap of corrugated card, folded round a ceramic cartridge fuse with brass caps
    b.ink({ color: hex(0x8b7656), mat: MAT.CLOTH, wear: 0.6, detailScale: 3 });
    const card = b.box(0.11, 0.002, 0.07, { bevel: 0.0008, rows: 3 });
    card.warp((p) => { p.y += 0.012 * (1 - Math.cos((p.z / 0.035) * 1.2)); }).move(0, 0.001, 0);
    b.ink({ color: hex(0xd9d4c4), mat: MAT.PLASTIC, wear: 0.3, rough: 0.7 });
    b.cyl(0.0095, 0.06, { sides: 12, bevel: 0.001 }).rotZ(Math.PI / 2).move(0, 0.0115, 0);
    b.ink({ color: PAL.brass, mat: MAT.METAL, wear: 0.35, rough: 0.35 });
    for (const s of [-1, 1]) b.cyl(0.0105, 0.012, { sides: 12, bevel: 0.0012 }).rotZ(Math.PI / 2).move(s * 0.033, 0.0115, 0);
    b.ink({ color: hex(0x3a3a3a), mat: MAT.PAINT, wear: 0.4 });
    b.stencil('30A', 0.007).rotX(-Math.PI / 2).move(0, 0.0212, 0.003);
    b.anchor('grab', [0, 0.03, 0]);
    return b.build({ aoRadius: 0.015 });
  },
  { variants: 1, size: 'item', desc: 'a cartridge fuse in a fold of card (radio part)', tags: ['pickup', 'part'] },
);

register(
  'part_tube',
  (seed) => {
    const b = new Builder(seed);
    // a printed carton lying on its side, flap open, the valve half out: the silvered getter dome,
    // the dark plate inside, the black base and its pins
    b.ink({ color: hex(0xb7b0a0), mat: MAT.CLOTH, wear: 0.5, detailScale: 2 });
    b.box(0.1, 0.045, 0.045, { bevel: 0.002, top: true }).crumple(0.001, 6).move(-0.035, 0.0225, 0);
    b.ink({ color: hex(0x8e2b22), mat: MAT.PAINT, wear: 0.45 });
    b.box(0.1, 0.0012, 0.03).move(-0.035, 0.0455, 0);
    b.ink({ color: hex(0xb7b0a0), mat: MAT.CLOTH, wear: 0.5 });
    b.box(0.0012, 0.045, 0.04).rotY(0.9).move(0.03, 0.0225, 0.022); // the flap
    // the valve, along X, its base inside the box mouth
    b.ink({ color: hex(0xa9adb0), mat: MAT.METAL, wear: 0.15, rough: 0.12 });
    b.lathe([[0.001, 0.07], [0.008, 0.068], [0.0135, 0.058], [0.015, 0.035], [0.015, 0.012]], { sides: 14 }).rotZ(-Math.PI / 2).move(0.005, 0.017, 0);
    b.ink({ color: hex(0x1d1d1f), mat: MAT.PLASTIC, wear: 0.3 });
    b.cyl(0.016, 0.014, { sides: 14, bevel: 0.0015 }).rotZ(Math.PI / 2).move(0.012, 0.017, 0);
    b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.2 });
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU;
      b.cyl(0.0008, 0.008, { sides: 4 }).rotZ(Math.PI / 2).move(0.003, 0.017 + Math.sin(a) * 0.009, Math.cos(a) * 0.009);
    }
    b.anchor('grab', [0, 0.05, 0]);
    return b.build({ aoRadius: 0.015 });
  },
  { variants: 1, size: 'item', desc: 'a valve half out of its carton (radio part)', tags: ['pickup', 'part'] },
);

register(
  'part_coil',
  (seed) => {
    const b = new Builder(seed);
    // the loading coil: a ribbed white former, copper wound close, brass end caps and terminals
    const L = 0.16, R = 0.022;
    b.ink({ color: hex(0xd7d3c6), mat: MAT.PLASTIC, wear: 0.35, rough: 0.6 });
    b.cyl(R * 0.9, L, { sides: 14, rows: 2, bevel: 0.002 }).rotZ(Math.PI / 2).move(0, R + 0.002, 0);
    b.ink({ color: hex(0xb06a3c), mat: MAT.METAL, wear: 0.4, rough: 0.35 });
    const turns = 34;
    const wire: V3[] = [];
    for (let i = 0; i <= turns * 10; i++) {
      const t = i / (turns * 10);
      const a = t * turns * TAU;
      wire.push([-L * 0.42 + L * 0.84 * t, R + 0.002 + Math.sin(a) * R * 0.97, Math.cos(a) * R * 0.97]);
    }
    b.pipe(wire, 0.0013, { sides: 4 });
    b.ink({ color: PAL.brass, mat: MAT.METAL, wear: 0.35, rough: 0.3 });
    for (const s of [-1, 1]) {
      b.cyl(R * 1.08, 0.008, { sides: 14, bevel: 0.0015 }).rotZ(Math.PI / 2).move(s * (L / 2 - 0.004), R + 0.002, 0);
      b.cyl(0.003, 0.016, { sides: 6 }).rotZ(Math.PI / 2).move(s * (L / 2 + 0.008), R + 0.002, 0);
    }
    b.anchor('grab', [0, 0.05, 0]);
    return b.build({ aoRadius: 0.02 });
  },
  { variants: 1, size: 'item', desc: 'the antenna loading coil (radio part)', tags: ['pickup', 'part'] },
);
