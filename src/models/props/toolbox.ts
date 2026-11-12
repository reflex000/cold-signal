// 'toolbox': a portable tool chest. Folded sheet steel with a rolled rim, a shallow hipped lid on a
// piano hinge (named part 'lid', opened by setOpen), a fold-flat bail handle with a black grip, two
// draw latches. Hollow: open it and a hammer, a spanner and a screwdriver lie on the bottom.
// Variants (seed & 3): 0 red steel, 1 blue steel, 2 large olive steel, 3 black plastic, yellow latches.
// Anchors: top, loot (inside floor), use, hinge.
import { Builder, MAT, PAL, Path, hex, type V3 } from '../kit';
import { register } from '../registry';

register(
  'toolbox',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const plastic = v === 3;
    const W = [0.5, 0.45, 0.56, 0.48][v], D = [0.21, 0.2, 0.235, 0.24][v], HB = [0.165, 0.155, 0.2, 0.18][v];
    const HL = plastic ? 0.07 : 0.055;
    const t = plastic ? 0.004 : 0.0012; // wall
    const paint = [PAL.toolRed, PAL.toolBlue, hex(0x46523a), PAL.plasticBlack][v];
    const wear = r.range(0.4, 0.65);
    const shell = plastic ? { color: paint, mat: MAT.PLASTIC, wear, rough: 0.6 } : { color: paint, mat: MAT.PAINT, wear };
    const steel = { color: PAL.steel, mat: MAT.METAL, wear: 0.45, rough: 0.35 } as const;
    const latchInk = plastic ? { color: PAL.signYellow, mat: MAT.PLASTIC, wear: 0.4, rough: 0.5 } : steel;
    const bev = plastic ? 0.012 : 0.004;

    // ---- body: an open tray, outside and inside walls, a rolled rim over the join ----
    b.ink(shell);
    b.box(W, HB, D, { bevel: bev, top: false }).move(0, HB / 2, 0);
    const inner = b.box(W - 2 * t, HB - t, D - 2 * t, { bevel: Math.max(0.001, bev - t), top: false }).flip().move(0, HB / 2 + t / 2 + 0.0005, 0);
    inner.shade((q) => 0.45 + 0.4 * Math.min(1, q.y / HB));
    inner.paint({ wear: wear * 0.4 });
    {
      const hx = W / 2 - t / 2, hz = D / 2 - t / 2, y = HB - 0.002;
      const rim = Path.fillet([[0, y, -hz], [hx, y, -hz], [hx, y, hz], [-hx, y, hz], [-hx, y, -hz], [0, y, -hz]], bev + 0.002, 2);
      rim.pop();
      b.pipe(rim, plastic ? 0.005 : 0.0028, { sides: 6, closed: true }).paint({ wear: Math.min(1, wear + 0.3) });
    }
    if (plastic) {
      // moulded ribs across the front and back
      for (const s of [-1, 1]) for (const y of [0.05, 0.1]) b.box(W - 0.08, 0.012, 0.006, { bevel: 0.0025 }).move(0, y, s * (D / 2 + 0.002));
    }

    // ---- what is inside ----
    b.ink({ color: PAL.timber, mat: MAT.WOOD, wear: 0.5 });
    const fy = t + 0.001;
    b.cyl(0.0125, 0.3, { sides: 8, bevel: 0.003, r2: 0.011 }).rotZ(Math.PI / 2).rotY(0.12).move(-0.02, fy + 0.0125, -0.04);
    b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.7, rough: 0.5 });
    b.box(0.026, 0.026, 0.11, { bevel: 0.003 }).rotY(0.12).move(0.13, fy + 0.013, -0.025);
    b.box(0.19, 0.005, 0.022, { bevel: 0.0015 }).rotY(-0.3).move(-0.05, fy + 0.0025, 0.045);
    b.torus(0.016, 0.005, { segs: 10, sides: 5 }).move(-0.145, fy + 0.005, 0.073);
    b.ink({ color: PAL.plasticRed, mat: MAT.PLASTIC, wear: 0.5 });
    b.cyl(0.012, 0.09, { sides: 8, bevel: 0.004 }).rotZ(Math.PI / 2).rotY(0.5).move(0.09, fy + 0.012, 0.05);
    b.ink(steel);
    b.cyl(0.0035, 0.1, { sides: 6, bevel: 0.0005 }).rotZ(Math.PI / 2).rotY(0.5).move(0.09 - 0.088, fy + 0.012, 0.05 + 0.048);

    // ---- piano hinge along the back, latch plates on the front ----
    b.ink(steel);
    b.cyl(0.0045, W - 0.05, { sides: 8, bevel: 0.001 }).rotZ(Math.PI / 2).move(0, HB, -D / 2 - 0.003);
    b.box(W - 0.05, 0.02, 0.0015, { bevel: 0.0005 }).move(0, HB - 0.012, -D / 2 - 0.001);
    b.ink(latchInk);
    for (const s of [-1, 1]) {
      const lx = s * (W / 2 - 0.085);
      b.box(0.036, 0.04, 0.003, { bevel: 0.001 }).move(lx, HB - 0.03, D / 2 + 0.0015);
      // the lever, closed
      b.box(0.028, 0.048, 0.006, { bevel: 0.002 }).rotX(-0.12).move(lx, HB - 0.026, D / 2 + 0.006);
    }

    // ---- lid ----
    const hinge: V3 = [0, HB, -D / 2 - 0.003];
    b.part(
      'lid',
      () => {
        b.ink(shell);
        // hipped section drawn in (x = -height, z) and extruded along the width
        const lid = b.extrude([[0, -D / 2], [0, D / 2], [-HL, D / 2 - 0.022], [-HL, -D / 2 + 0.022]], W, { bevel: plastic ? 0.016 : 0.009, seg: 2, capBevel: bev });
        lid.rotZ(-Math.PI / 2).move(0, HB + 0.0015, 0);
        const ytop = HB + HL + 0.0015;
        // handle ears and the bail lying folded toward the front
        b.ink(steel);
        const hw = W / 2 - 0.085;
        for (const s of [-1, 1]) b.box(0.018, 0.016, 0.026, { bevel: 0.004 }).move(s * hw, ytop + 0.006, 0);
        const bail = Path.fillet([[-hw, ytop + 0.008, 0], [-hw, ytop + 0.009, 0.06], [hw, ytop + 0.009, 0.06], [hw, ytop + 0.008, 0]], 0.02, 4);
        b.pipe(bail, 0.0042, { sides: 6 }).paint({ wear: 0.75 });
        b.ink({ color: PAL.rubber, mat: MAT.RUBBER, wear: 0.4 });
        b.cyl(0.0115, 0.12, { sides: 10, bevel: 0.004 }).rotZ(Math.PI / 2).move(0, ytop + 0.009 + 0.004, 0.06);
        // latch hooks
        b.ink(latchInk);
        for (const s of [-1, 1]) b.box(0.026, 0.016, 0.005, { bevel: 0.0015 }).move(s * (W / 2 - 0.085), HB + 0.012, D / 2 + 0.0025);
      },
      hinge,
      { axis: [1, 0, 0], open: -1.8 },
    );

    // scuffs and grime toward the bottom
    b.each((q) => {
      const low = Math.max(0, 1 - q.y / 0.05) * 0.3;
      q.r *= 1 - low; q.g *= 1 - low; q.b *= 1 - low;
      if (q.y < 0.012) q.wear = Math.min(1.5, q.wear + 0.3);
    });

    b.anchor('top', [0, HB + HL + 0.02, 0]);
    b.anchor('loot', [0, t + 0.02, 0]);
    b.anchor('use', [0, 0, D / 2 + 0.5], 0);
    b.anchor('hinge', hinge);
    return b.build();
  },
  { variants: 4, size: 'item', desc: 'portable tool chest; lid opens (part "lid")', tags: ['loot', 'crate'] },
);
