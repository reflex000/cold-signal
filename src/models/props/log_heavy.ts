// 'log_heavy': a 2.4 m log, too heavy for a pack (LogEnt). Lies along Z: the thin end (+Z) is the
// front, where carrier `a` takes it; the butt (-Z) is carrier `b`'s end. Sawn ends with rings round
// the heart, bark ridged and lumpy, cut branch stubs, bark peeling on the weathered variants.
// Variants (seed & 3): 0 fresh-cut spruce, dark bark; 1 weathered grey deadfall, half peeled, one end
// snapped; 2 thick butt log with a slight bow; 3 lichen-grey bark, peeling at the knots.
// Anchors: a (front end, top), b (back end, top), mid (centre of the top), grip_a, grip_b (where hands go).
import { Builder, MAT, PAL, hex, mixRGB } from '../kit';
import { register } from '../registry';

export const LOG_LEN = 2.4;

register(
  'log_heavy',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const L = LOG_LEN;
    const rb = [0.155, 0.15, 0.185, 0.16][v] * r.range(0.95, 1.05); // butt radius
    const rt = rb * [0.82, 0.8, 0.76, 0.84][v]; // top radius
    const bark = [PAL.bark, mixRGB(PAL.barkGrey, PAL.deadwood, 0.2), mixRGB(PAL.bark, PAL.barkGrey, 0.4), hex(0x55524a)][v];
    const wear = [0.35, 0.85, 0.5, 0.65][v];
    b.ink({ color: bark, mat: MAT.BARK, wear });
    const log = b.log(L, rb, {
      r2: rt,
      sides: 18,
      rows: 18,
      ends: v === 1 ? ['saw', 'break'] : ['saw', 'saw'],
      bend: [0.05, 0.08, 0.14, 0.06][v],
      gnarl: rb * [0.05, 0.07, 0.06, 0.08][v],
      peel: [0.05, 0.5, 0.12, 0.25][v],
      knots: r.int(3, 6),
      bark,
      wood: v === 1 ? mixRGB(PAL.heartwood, PAL.deadwood, 0.6) : PAL.heartwood,
    });
    // butt toward -Z, thin end toward +Z, resting on its underside: the taper tips it a little
    log.rotX(Math.PI / 2);
    log.rotX(Math.atan2(rb - rt, L));
    const bb = log.bounds();
    log.move(0, -bb.min.y - 0.012, 0); // settles a centimetre into the snow
    // dirt and wet where it lay on the ground, lichen-pale on top of the old ones
    log.each((q) => {
      const low = Math.max(0, 1 - (q.y - 0.0) / (rb * 0.9));
      const k = low * 0.45;
      q.r *= 1 - k; q.g *= 1 - k * 0.95; q.b *= 1 - k * 0.9;
      if (v === 3 && q.ny > 0.4 && q.mat === MAT.BARK) {
        const t = (q.ny - 0.4) * 0.5;
        q.r += (0.32 - q.r) * t; q.g += (0.34 - q.g) * t; q.b += (0.3 - q.b) * t;
      }
    });
    const top = (z: number) => {
      const t = (z + L / 2) / L;
      return 2 * (rb + (rt - rb) * t);
    };
    b.anchor('a', [0, top(L / 2), L / 2 - 0.08]);
    b.anchor('b', [0, top(-L / 2), -L / 2 + 0.08], Math.PI);
    b.anchor('mid', [0, top(0), 0]);
    b.anchor('grip_a', [0, top(L / 2 - 0.3) * 0.5, L / 2 - 0.3]);
    b.anchor('grip_b', [0, top(-L / 2 + 0.3) * 0.5, -L / 2 + 0.3]);
    return b.build();
  },
  { variants: 4, size: 'prop', desc: 'a 2.4 m log along Z; carriers at anchors a (front, +Z) and b (back)', tags: ['wood', 'log'] },
);
