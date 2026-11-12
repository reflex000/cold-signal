// 'jerrycan': a 20 litre pressed-steel jerrycan, 345 x 470 x 165 mm. Broad faces front and back
// (+Z / -Z) with the raised X, a welded seam flange all round the middle, three tubular handles
// across the top and the spout with its cam-lever cap at the right shoulder. Paint chips first on
// the seam, the handles and the corners; rust weeps from the chips.
// Variants (seed & 3): olive drab, fuel red, sand, dark grey; each dented differently.
// Anchors: grip (centre handle), spout (cap).
import { Builder, MAT, PAL, Path, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';

register(
  'jerrycan',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const W = 0.345, D = 0.165, HB = 0.44; // body
    const lift = 0.004; // the seam flange is the lowest point
    const paint = [mixRGB(PAL.olive, PAL.drab, 0.3), hex(0x7a2018), hex(0x8b7c5c), hex(0x3f4245)][v];
    const wear = r.range(0.35, 0.6);
    b.ink({ color: paint, mat: MAT.PAINT, wear, vary: 0.04 });

    // ---- body: pressed steel, faces faintly domed ----
    const body = b.pillow(W, HB, D, { round: 0.021, bulge: 0.0025, seg: 3, ring: 2 }).move(0, HB / 2 + lift, 0);
    for (let i = 0, n = r.int(1, 3); i < n; i++) {
      const side = r.sign();
      body.dent([r.range(-0.12, 0.12), r.range(0.08, 0.38), (side * D) / 2], r.range(0.04, 0.08), r.range(0.004, 0.009), [0, 0, -side]);
    }
    if (r.chance(0.5)) body.dent([(r.sign() * W) / 2, r.range(0.02, 0.1), r.range(-0.05, 0.05)], 0.05, 0.008);

    // ---- the X on both faces ----
    const panelW = W - 0.07, panelH = HB - 0.08;
    const ang = Math.atan2(panelW, panelH);
    const len = Math.hypot(panelW, panelH) - 0.03;
    for (const s of [-1, 1]) {
      for (const k of [-1, 1]) {
        b.box(0.03, len, 0.012, { bevel: 0.0045, seg: 2 }).rotZ(k * ang).move(0, HB / 2 + lift, s * (D / 2 - 0.0032));
      }
    }

    // ---- welded seam flange round the middle ----
    {
      const hx = W / 2 + 0.0025, y0 = lift - 0.0005 + 0.0025, y1 = HB + lift + 0.0025 - 0.005;
      const loop = Path.fillet([[hx, (y0 + y1) / 2, 0], [hx, y1, 0], [-hx, y1, 0], [-hx, y0, 0], [hx, y0, 0], [hx, (y0 + y1) / 2, 0]], 0.02, 4);
      loop.pop();
      const seam = b.strap(loop, 0.0028, 0.0075, { closed: true, up: [1, 0, 0] });
      seam.paint({ wear: Math.min(1, wear + 0.35) });
    }

    // ---- three handles across the top ----
    const top = HB + lift;
    const hxs = [-0.112, -0.035, 0.042];
    for (const hx of hxs) {
      const path = Path.fillet([[hx, top - 0.006, -0.052], [hx, top + 0.032, -0.036], [hx, top + 0.032, 0.036], [hx, top - 0.006, 0.052]], 0.014, 4);
      b.pipe(path, 0.0085, { sides: 8 }).paint({ wear: Math.min(1, wear + 0.4) });
      // pressed brackets where the handle meets the shoulder
      for (const z of [-0.047, 0.047]) b.box(0.03, 0.012, 0.016, { bevel: 0.004 }).move(hx, top - 0.001, z);
    }

    // ---- spout and cap at the right shoulder ----
    const sx = 0.118, tilt = -0.32;
    b.group(() => {
      b.cyl(0.023, 0.032, { sides: 14, bevel: 0.002 }).move(0, 0.012, 0);
      b.ink({ color: mixRGB(paint, PAL.steelDark, 0.25), mat: MAT.PAINT, wear: Math.min(1, wear + 0.25) });
      b.cyl(0.03, 0.02, { sides: 16, bevel: 0.004 }).move(0, 0.036, 0);
      b.dome(0.026, 0.006, 12).move(0, 0.046, 0);
      // cam lever folded down over the cap, and its hinge
      b.box(0.075, 0.007, 0.024, { bevel: 0.0025 }).move(-0.028, 0.051, 0);
      b.cyl(0.0045, 0.03, { sides: 8, bevel: 0.001 }).rotX(Math.PI / 2).move(0.03, 0.046, 0);
      b.box(0.012, 0.022, 0.03, { bevel: 0.002 }).move(0.034, 0.036, 0);
    })
      .rotZ(tilt)
      .move(sx, top - 0.008, 0);
    b.ink({ color: paint, mat: MAT.PAINT, wear, vary: 0.04 });

    // grime: dust in the seam and on the bottom, hands on the handles
    b.each((q) => {
      const low = Math.max(0, 1 - q.y / 0.06) * 0.3;
      q.r *= 1 - low; q.g *= 1 - low; q.b *= 1 - low;
    });

    const grip: V3 = [hxs[1], top + 0.04, 0];
    b.anchor('grip', grip);
    b.anchor('spout', [sx + 0.02, top + 0.05, 0]);
    return b.build();
  },
  { variants: 4, size: 'item', desc: '20 l steel jerrycan', tags: ['pickup', 'fuel'] },
);
