// 'stick_bundle': an armful of dead sticks gathered under the trees, lying along X, tied with a
// loop or two of cord. The pickup for sticks (fuel). Each stick is its own bent, snapped branch:
// some still in bark, some grey and bare, a twig fork here and there.
// Variants (seed & 3): 0 seven sticks, two ties; 1 nine thin sticks, one tie; 2 six thicker pieces,
// two ties, mostly barkless; 3 loose armful (no cord), splayed.
// Anchors: grab (centre top).
import { Builder, MAT, PAL, Path, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';

register(
  'stick_bundle',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const count = [7, 9, 6, 7][v];
    const rMin = [0.011, 0.009, 0.016, 0.011][v], rMax = [0.02, 0.015, 0.026, 0.021][v];
    const peelBias = [0.25, 0.3, 0.65, 0.35][v];
    // cross-section layout: sticks packed in a rough round bundle, the thickest at the bottom
    const sticks: { y: number; z: number; rad: number; len: number; dx: number; yaw: number; tilt: number }[] = [];
    const radii = Array.from({ length: count }, () => r.range(rMin, rMax)).sort((a, c) => c - a);
    const ring = (i: number): [number, number] => {
      if (i === 0) return [0, 0];
      const k = i <= 6 ? i - 1 : i - 7;
      const rr = i <= 6 ? 1 : 1.9;
      const a = (k / (i <= 6 ? 6 : 8)) * Math.PI * 2 + (i > 6 ? 0.3 : 0);
      return [Math.cos(a) * rr, Math.sin(a) * rr];
    };
    const pack = (v === 3 ? 1.9 : 1.05) * (rMin + rMax);
    for (let i = 0; i < count; i++) {
      const [cy, cz] = ring(i);
      sticks.push({
        y: cy * pack * 0.8,
        z: cz * pack + (v === 3 ? r.range(-0.03, 0.03) : 0),
        rad: radii[i],
        len: r.range(0.5, 0.78),
        dx: r.range(-0.07, 0.07),
        yaw: r.range(-1, 1) * (v === 3 ? 0.22 : 0.06),
        tilt: r.range(-1, 1) * 0.04,
      });
    }
    // drop the bundle so its lowest stick rests on the ground
    const minY = Math.min(...sticks.map((s) => s.y - s.rad));
    for (const s of sticks) {
      const bark = r.chance(0.5) ? PAL.bark : mixRGB(PAL.barkGrey, PAL.bark, r.range(0, 0.6));
      b.ink({ color: bark, mat: MAT.BARK, wear: r.range(0.4, 0.8) });
      const p = b.log(s.len, s.rad, {
        r2: s.rad * r.range(0.6, 0.85),
        sides: 6,
        rows: 5,
        ends: [r.chance(0.6) ? 'break' : 'saw', r.chance(0.5) ? 'taper' : 'break'],
        bend: r.range(0.05, 0.3),
        gnarl: s.rad * 0.08,
        peel: Math.min(0.95, Math.max(0, peelBias + r.range(-0.25, 0.25))),
        knots: r.int(0, 2),
        bark,
        deadwood: mixRGB(PAL.deadwood, hex(0x6f675d), r.range(0, 0.5)),
      });
      p.rotZ(Math.PI / 2 + s.tilt).rotY(s.yaw).move(s.dx, s.y - minY + s.rad * 0.85, s.z);
      // a forked twig on some of the thin ones
      if (s.rad < 0.016 && r.chance(0.45)) {
        // thick end on the stick, diverging from it in the horizontal plane
        const fl = r.range(0.12, 0.22);
        const u = r.range(-0.12, 0.12);
        const phi = s.yaw + r.sign() * r.range(0.35, 0.6);
        const ax = s.dx + Math.cos(s.yaw) * u, az = s.z - Math.sin(s.yaw) * u, ay = s.y - minY + s.rad * 0.85;
        const tw = b.log(fl, s.rad * 0.5, { r2: s.rad * 0.2, sides: 5, rows: 2, ends: ['saw', 'taper'], bend: 0.2, bark });
        tw.rotZ(Math.PI / 2).rotY(phi).move(ax - (fl / 2) * Math.cos(phi), ay, az + (fl / 2) * Math.sin(phi));
      }
    }
    // cord ties: a loop hugging the bundle's outline, knotted on top
    const ties = v === 3 ? [] : v === 1 ? [0.02] : [-0.17, 0.16];
    const bundleTop = Math.max(...sticks.map((s) => s.y - minY + s.rad * 1.8));
    if (ties.length) b.ink({ color: v === 2 ? PAL.orangeFaded : PAL.rope, mat: MAT.CLOTH, wear: 0.5, detailScale: 2 });
    for (const x of ties) {
      // the outline of the cross-section as seen along X: the farthest stick in each direction
      const loop: V3[] = [];
      const cy = sticks.reduce((s, k) => s + k.y - minY + k.rad * 0.85, 0) / sticks.length;
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const dy = Math.sin(a), dz = Math.cos(a);
        let reach = 0;
        for (const s of sticks) {
          const sy = s.y - minY + s.rad * 0.85 - cy, sz = s.z + Math.tan(s.yaw) * x;
          reach = Math.max(reach, sy * dy + sz * dz + s.rad * 1.08);
        }
        loop.push([x + r.range(-0.004, 0.004), Math.max(0.004, cy + dy * reach), dz * reach]);
      }
      b.pipe(Path.spline([...loop, loop[0]], 2).slice(0, -1), 0.0035, { sides: 5, closed: true });
      b.sphere([0.008, 0.007, 0.009], { sides: 6, rings: 4 }).move(x, bundleTop - 0.003, 0.004);
    }
    b.anchor('grab', [0, bundleTop, 0]);
    return b.build();
  },
  { variants: 4, size: 'item', desc: 'an armful of dead sticks lying along X, tied with cord', tags: ['wood', 'pickup'] },
);
