// 'luggage': passengers' bags thrown out of the hold, lying flat. Length along X, width along Z.
// Variants (seed & 3):
//   0 hard-shell spinner case: two polycarbonate shells with ribs, zip band, four spinner wheels,
//     telescopic handle and carry handles. Lid = the upper shell (part 'lid').
//   1 soft nylon case: padded panels with piping, a front pocket, two wheels. Lid = front panel.
//   2 duffel bag: a slumped, creased cylinder of nylon with two carry straps and a shoulder strap
//     lying loose beside it. No lid.
//   3 old hard case: vinyl over board, metal corners, brass latches, a leather handle and belts.
// Lids hinge along the back long edge (-Z); setOpen swings them up. The lining shows inside.
// Anchors: top, loot, use, handle.
import { Builder, MAT, PAL, Path, hex, mixRGB, type Part, type RGB, type V3 } from '../kit';
import { register } from '../registry';

register(
  'luggage',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const lining = r.pick([hex(0x2c2f3a), hex(0x4a3b3a), hex(0x3d4140)]);
    const black = { color: PAL.nylonBlack, mat: MAT.CLOTH, wear: 0.4 } as const;
    const rubber = { color: PAL.rubber, mat: MAT.RUBBER, wear: 0.5 } as const;
    /** Paint the faces of a shell that face the opening as the lining (CLOTH and PLASTIC are neighbours). */
    const lined = (p: Part, up: boolean, col: RGB): void => {
      p.each((q) => {
        if ((up ? q.ny : -q.ny) < 0.85) return;
        q.mat = MAT.CLOTH;
        q.r = col[0]; q.g = col[1]; q.b = col[2];
        q.rough = 0.95;
        q.metal = 0;
        q.ao *= 0.8;
      });
    };
    let L = 0.68, Wd = 0.45, T = 0.27, yS = 0.15; // overall size and the seam height
    let handleAt: V3 = [L / 2, 0.1, 0];

    if (v === 0) {
      // ---- hard-shell spinner ----
      const shellCol = r.pick([hex(0x2b3442), hex(0x3a3d42), hex(0x5b2a2a), hex(0x8f9396)]);
      const shell = { color: shellCol, mat: MAT.PLASTIC, wear: r.range(0.35, 0.6), rough: 0.35 } as const;
      const baseT = 0.15, lidT = 0.12;
      b.ink(shell);
      const base = b.pillow(L, baseT, Wd, { round: 0.034, bulge: 0.006, seg: 3, ring: 2 }).move(0, baseT / 2 + 0.006, 0);
      lined(base, true, lining);
      // the zip band round the middle and its pull
      b.ink(black);
      {
        const hx = L / 2 - 0.004, hz = Wd / 2 - 0.004, y = baseT + 0.006;
        const loop = Path.fillet([[0, y, -hz], [hx, y, -hz], [hx, y, hz], [-hx, y, hz], [-hx, y, -hz], [0, y, -hz]], 0.034, 3);
        loop.pop();
        b.strap(loop, 0.014, 0.004, { closed: true, up: [0, 0, -1] });
        b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.4 });
        b.box(0.012, 0.004, 0.03, { bevel: 0.0015 }).move(L * 0.18, y, Wd / 2 + 0.006);
      }
      // wheels on the bottom end (-X): housings and rubber wheels, two per shell
      const wheel = (y: number, z: number) => {
        b.ink(shell);
        b.box(0.03, 0.05, 0.05, { bevel: 0.012 }).move(-L / 2 - 0.006, y, z);
        b.ink(rubber);
        b.cyl(0.024, 0.018, { sides: 12, bevel: 0.004 }).rotX(Math.PI / 2).move(-L / 2 - 0.032, y, z);
      };
      for (const z of [-Wd / 2 + 0.045, Wd / 2 - 0.045]) wheel(0.05, z);
      // telescopic handle housing on the top end (+X) and the carry handles
      b.ink(black);
      b.box(0.022, 0.026, 0.26, { bevel: 0.008 }).move(L / 2 + 0.006, 0.075, 0);
      b.strap(Path.fillet([[L / 2 - 0.002, 0.11, -0.07], [L / 2 + 0.03, 0.12, -0.05], [L / 2 + 0.03, 0.12, 0.05], [L / 2 - 0.002, 0.11, 0.07]], 0.02, 3), 0.028, 0.012, { up: [1, 0, 0] });
      b.strap(Path.fillet([[-0.07, 0.07, Wd / 2 - 0.002], [-0.05, 0.08, Wd / 2 + 0.03], [0.05, 0.08, Wd / 2 + 0.03], [0.07, 0.07, Wd / 2 - 0.002]], 0.02, 3), 0.028, 0.012, { up: [0, 0, 1] });
      handleAt = [L / 2 + 0.03, 0.12, 0];
      b.part(
        'lid',
        () => {
          b.ink(shell);
          const lid = b.pillow(L, lidT, Wd, { round: 0.034, bulge: 0.008, seg: 3, ring: 2 }).move(0, baseT + 0.006 + lidT / 2, 0);
          lined(lid, false, lining);
          // ribs along the lid
          for (const z of [-0.14, -0.05, 0.05, 0.14]) b.pillow(L - 0.16, 0.008, 0.03, { round: 0.004, bulge: 0.001, seg: 2, ring: 1 }).move(0, baseT + 0.006 + lidT + 0.0045, z);
          for (const z of [-Wd / 2 + 0.045, Wd / 2 - 0.045]) wheel(baseT + 0.006 + lidT - 0.05, z);
        },
        [0, yS, -Wd / 2],
        { axis: [1, 0, 0], open: -1.75 },
      );
      T = baseT + lidT + 0.006;
    } else if (v === 1) {
      // ---- soft nylon case ----
      const cloth = r.pick([PAL.nylonNavy, PAL.nylonBlack, hex(0x3a3330)]);
      const ink = { color: cloth, mat: MAT.CLOTH, wear: r.range(0.3, 0.55) } as const;
      L = 0.66; Wd = 0.42;
      const baseT = 0.17, lidT = 0.07;
      b.ink(ink);
      const base = b.pillow(L, baseT, Wd, { round: 0.045, bulge: 0.012, seg: 3, ring: 2 }).crumple(0.006, 5).move(0, baseT / 2 + 0.004, 0);
      lined(base, true, lining);
      // piping along the seam and the bottom edge
      b.ink(black);
      for (const y of [0.012, baseT + 0.004]) {
        const hx = L / 2 - 0.01, hz = Wd / 2 - 0.01;
        const loop = Path.fillet([[0, y, -hz], [hx, y, -hz], [hx, y, hz], [-hx, y, hz], [-hx, y, -hz], [0, y, -hz]], 0.05, 3);
        loop.pop();
        b.pipe(loop, 0.0045, { sides: 5, closed: true });
      }
      // two inline wheels and feet
      b.ink(rubber);
      for (const z of [-Wd / 2 + 0.05, Wd / 2 - 0.05]) b.cyl(0.03, 0.022, { sides: 12, bevel: 0.005 }).rotX(Math.PI / 2).move(-L / 2 + 0.01, 0.05, z);
      b.ink(black);
      b.box(0.024, 0.03, 0.28, { bevel: 0.008 }).move(L / 2 + 0.004, 0.08, 0);
      b.strap(Path.fillet([[-0.08, 0.09, Wd / 2 - 0.004], [-0.06, 0.1, Wd / 2 + 0.03], [0.06, 0.1, Wd / 2 + 0.03], [0.08, 0.09, Wd / 2 - 0.004]], 0.02, 3), 0.03, 0.01, { up: [0, 0, 1] });
      handleAt = [0, 0.1, Wd / 2 + 0.03];
      b.part(
        'lid',
        () => {
          b.ink(ink);
          const lid = b.pillow(L, lidT, Wd, { round: 0.035, bulge: 0.016, seg: 3, ring: 2 }).crumple(0.005, 5).move(0, baseT + 0.004 + lidT / 2, 0);
          lined(lid, false, lining);
          // front pocket with its zip
          b.pillow(L * 0.72, 0.04, Wd * 0.7, { round: 0.02, bulge: 0.012, seg: 2, ring: 2 }).crumple(0.004, 6).move(0.02, baseT + lidT + 0.012, 0.01);
          b.ink(black);
          b.strap([[-L * 0.32, baseT + lidT + 0.033, Wd * 0.33], [L * 0.36, baseT + lidT + 0.033, Wd * 0.33]], 0.008, 0.003, { up: [0, 1, 0] });
          b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.4 });
          b.box(0.03, 0.004, 0.012, { bevel: 0.0015 }).move(L * 0.28, baseT + lidT + 0.036, Wd * 0.33 + 0.012);
        },
        [0, baseT + 0.004, -Wd / 2],
        { axis: [1, 0, 0], open: -1.6 },
      );
      T = baseT + lidT + 0.05;
      yS = baseT + 0.004;
    } else if (v === 2) {
      // ---- duffel ----
      const cloth = r.pick([hex(0x8c2f1c), PAL.canvasOlive, hex(0x23324a), hex(0x2b2b2d)]);
      L = 0.64; Wd = 0.32; T = 0.27;
      b.ink({ color: cloth, mat: MAT.CLOTH, wear: r.range(0.35, 0.6) });
      const bag = b.pillow(L, 0.3, Wd, { round: 0.12, bulge: 0.02, seg: 4, ring: 3 });
      // half full and slumped: the top sinks and flattens, the belly spreads on the ground, the
      // ends fall in; then long creases across it and small wrinkles
      bag.warp((q) => {
        const u = (q.y + 0.15) / 0.3; // 0 bottom .. 1 top
        const ex = Math.abs(q.x) / (L / 2);
        q.y = -0.15 + (q.y + 0.15) * (0.78 - 0.1 * u * (1 - Math.cos(ex * Math.PI)) * 0.5);
        q.z *= 1 + 0.2 * (1 - u) * (1 - u) - 0.06 * u;
      });
      const fold = r.range(0, 6);
      bag.warp((q) => {
        q.y -= 0.009 * Math.max(0, Math.sin(q.x * 31 + fold)) ** 3 * Math.max(0, q.y + 0.05) * 6;
      });
      bag.crumple(0.016, 4.5).crumple(0.005, 15);
      const bb = bag.bounds();
      bag.move(0, -bb.min.y, 0);
      const top = bag.bounds().max.y;
      /** Points hugging the bag's cross-section at x: from the ground on the front, over the top, to the ground at the back. */
      const hug = (x: number, off: number, n = 14): V3[] => {
        const cy = top * 0.45, pts: V3[] = [];
        for (let i = 0; i <= n; i++) {
          const a = -0.2 + ((Math.PI + 0.4) * i) / n; // just below horizontal on each side
          const dy = Math.sin(a), dz = Math.cos(a);
          let reach = 0;
          for (let k = 0; k < bag.p.length; k += 3) {
            if (Math.abs(bag.p[k] - x) > 0.03) continue;
            reach = Math.max(reach, (bag.p[k + 1] - cy) * dy + bag.p[k + 2] * dz);
          }
          pts.push([x, Math.max(0.003, cy + dy * (reach + off)), dz * (reach + off)]);
        }
        return pts;
      };
      // zip track along the top, two webbing straps sewn round it, a loose shoulder strap on the ground
      b.ink(black);
      b.strap(Path.spline([[-L * 0.38, top - 0.016, 0.01], [0, top - 0.002, 0.012], [L * 0.38, top - 0.016, 0.01]], 6), 0.02, 0.003, { up: [0, 1, 0] });
      const web = { color: r.pick([PAL.webbing, PAL.nylonBlack, cloth]), mat: MAT.CLOTH, wear: 0.5 } as const;
      b.ink(web);
      for (const x of [-0.14, 0.14]) {
        b.strap(hug(x, 0.004), 0.035, 0.003, { up: [0, 0, 1] });
        // the handle loop, lying over to the front where it fell
        const h = hug(x, 0.012, 8);
        const loop: V3[] = [h[4], [x, top + 0.02, 0.06], [x, top - 0.01, 0.13], h[2]];
        b.strap(Path.spline(loop, 4), 0.03, 0.004, { up: [0, 1, 0] });
      }
      b.strap(Path.spline([[-0.15, 0.004, Wd / 2 + 0.02], [-0.05, 0.004, Wd / 2 + 0.18], [0.2, 0.004, Wd / 2 + 0.22], [0.32, 0.004, Wd / 2 + 0.06]], 6), 0.036, 0.004, { up: [0, 1, 0] });
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.4 });
      b.box(0.012, 0.004, 0.03, { bevel: 0.0015 }).move(L * 0.2, top + 0.002, 0.018);
      handleAt = [0, top + 0.02, 0];
    } else {
      // ---- old hard case ----
      L = 0.62; Wd = 0.4;
      const baseT = 0.12, lidT = 0.07;
      const vinyl = { color: r.pick([hex(0x5a3d26), hex(0x3f2a1d), hex(0x50483a)]), mat: MAT.CLOTH, wear: r.range(0.5, 0.75), rough: 0.6 } as const;
      const brass = { color: PAL.brass, mat: MAT.METAL, wear: 0.6, rough: 0.4 } as const;
      b.ink(vinyl);
      const base = b.pillow(L, baseT, Wd, { round: 0.012, bulge: 0.003, seg: 3, ring: 2 }).move(0, baseT / 2, 0);
      lined(base, true, lining);
      const corners = (y0: number, y1: number) => {
        b.ink(brass);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [y0, y1]) {
          b.box(0.045, 0.03, 0.045, { bevel: 0.011, seg: 2 }).move(sx * (L / 2 - 0.0185), y, sz * (Wd / 2 - 0.0185));
        }
      };
      corners(0.0145, baseT - 0.0145);
      // latches and handle on the front long side
      b.ink(brass);
      for (const x of [-0.18, 0.18]) b.box(0.04, 0.03, 0.008, { bevel: 0.003 }).move(x, baseT - 0.012, Wd / 2 + 0.003);
      b.ink({ color: PAL.leather, mat: MAT.CLOTH, wear: 0.7, rough: 0.55 });
      b.strap(Path.fillet([[-0.075, baseT - 0.01, Wd / 2], [-0.06, baseT - 0.012, Wd / 2 + 0.035], [0.06, baseT - 0.012, Wd / 2 + 0.035], [0.075, baseT - 0.01, Wd / 2]], 0.02, 3), 0.03, 0.012, { up: [0, 1, 0] });
      handleAt = [0, baseT, Wd / 2 + 0.035];
      b.part(
        'lid',
        () => {
          b.ink(vinyl);
          const lid = b.pillow(L, lidT, Wd, { round: 0.012, bulge: 0.004, seg: 3, ring: 2 }).move(0, baseT + lidT / 2, 0);
          lined(lid, false, lining);
          corners(baseT + 0.0145, baseT + lidT - 0.0145);
          b.ink(brass);
          for (const x of [-0.18, 0.18]) b.box(0.03, 0.022, 0.009, { bevel: 0.003 }).move(x, baseT + 0.01, Wd / 2 + 0.0035);
          // two leather belts over the lid, buckled on the front
          b.ink({ color: mixRGB(PAL.leather, PAL.timberDark, 0.3), mat: MAT.CLOTH, wear: 0.75, rough: 0.6 });
          for (const x of [-0.12, 0.12]) {
            b.strap([[x, baseT + 0.02, -Wd / 2 - 0.003], [x, baseT + lidT + 0.002, -Wd / 2 - 0.003], [x, baseT + lidT + 0.002, Wd / 2 + 0.003], [x, baseT - 0.03, Wd / 2 + 0.003]], 0.025, 0.003, { up: [0, 0, -1] });
          }
        },
        [0, baseT, -Wd / 2],
        { axis: [1, 0, 0], open: -1.7 },
      );
      T = baseT + lidT;
      yS = baseT;
    }

    // dirt where it hit the ground
    b.each((q) => {
      const low = Math.max(0, 1 - q.y / 0.06) * 0.35;
      q.r *= 1 - low; q.g *= 1 - low; q.b *= 1 - low;
    });

    b.anchor('top', [0, T, 0]);
    b.anchor('loot', [0, yS, 0]);
    b.anchor('use', [0, 0, Wd / 2 + 0.5], 0);
    b.anchor('handle', handleAt);
    return b.build();
  },
  { variants: 4, size: 'prop', desc: 'suitcases (lid part) and a duffel bag, lying flat', tags: ['loot', 'crate', 'wreck'] },
);
