// Posts along the route and round the sites (no colliders; placed on the slope at the ground
// height, so both are sunk 0.35 m below y = 0 to stand on any terrain).
//
// 'fence_post': an old split cedar fence post, silver-grey and checked, leaning, with staples and
// broken barbed wire hanging off it. Variants (seed & 3): split post; round post with a rail
// stub; short rotten stump of a post; post with a long loop of wire still running away.
//
// 'sign_post': a forest trail sign: a dark creosoted post with routed boards in cream paint.
// Variants (seed & 3): SIGNAL TOWER with an arrow; RANGER CABIN / TRAIL; SURVEY ROUTE; a board
// broken off, only TRAIL left. The boards face +Z.
import { Builder, MAT, PAL, Path, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';
import { snowHeap } from './lib';

const SINK = 0.35;

register(
  'fence_post',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const H = [1.25, 1.35, 0.7, 1.2][v];
    const grey = mixRGB(PAL.deadwood, PAL.barkGrey, 0.35);
    const post = b.group(() => {
      b.ink({ color: grey, mat: MAT.WOOD, wear: 0.85, snow: 1, vary: 0.1 });
      if (v === 1) {
        b.log(H + SINK, 0.065, { r2: 0.055, sides: 8, rows: 4, ends: ['saw', 'break'], peel: 1, deadwood: grey, gnarl: 0.006 }).move(0, (H - SINK) / 2, 0);
        b.ink({ color: grey, mat: MAT.WOOD, wear: 0.85, snow: 1 });
        b.plank(0.7, 0.09, 0.04).rotZ(Math.PI / 2 - 0.15).move(0.38, H - 0.25, 0.06);
      } else {
        // split post: a wedge-shaped section, checked along the grain
        const p = b.extrude([[-0.07, -0.05], [0.07, -0.06], [0.05, 0.06], [-0.06, 0.055]], H + SINK, { bevel: 0.01, rows: 4 });
        p.noise(0.006, 9).move(0, (H - SINK) / 2, 0);
        if (v === 2) p.warp((q) => { if (q.y > H - 0.15) q.y = H - 0.15 + (q.y - H + 0.15) * 0.4 + 0.05 * Math.sin(q.x * 40); });
      }
      // staples and wire
      b.ink({ color: PAL.rustDark, mat: MAT.METAL, wear: 1.2, rough: 0.85, snow: 1 });
      for (const y of v === 2 ? [0.45] : [0.5, 0.85, 1.1]) {
        if (y > H - 0.05) continue;
        const wireEnd: V3 = v === 3 && y > 0.8 ? [r.range(-2.2, -1.6), y - 0.4, r.range(-0.3, 0.3)] : [r.range(-0.4, 0.3), Math.max(0.03, y - r.range(0.3, 0.6)), r.range(-0.15, 0.15)];
        const mid: V3 = [(wireEnd[0]) * 0.5, (y + wireEnd[1]) / 2 - 0.05, wireEnd[2] * 0.5 + 0.08];
        b.pipe(Path.spline([[0, y, 0.07], mid, wireEnd], 5), 0.0022, { sides: 3 }).ghost();
        // barbs along it
        for (let k = 1; k < 4; k++) {
          const t = k / 4;
          const q: V3 = [mid[0] * t * 2 * (1 - t) + wireEnd[0] * t * t, y + (wireEnd[1] - y) * t, 0.07 + (wireEnd[2] - 0.07) * t];
          b.box(0.002, 0.03, 0.002, { bevel: 0 }).rotZ(0.8).rotX(0.5).move(q[0], q[1], q[2]).ghost();
        }
      }
    });
    const lean = [[0.06, 0.02], [-0.04, 0.08], [0.12, -0.05], [0.03, -0.1]][v];
    post.rotX(lean[0]).rotZ(lean[1]).rotY(r.range(0, 6.28));
    snowHeap(b, [0, 0, 0], 0.22, 0.12, 0.2);
    return b.build({ ground: true });
  },
  { variants: 4, size: 'prop', desc: 'an old fence post with broken barbed wire (no collider)', tags: ['route'] },
);

register(
  'sign_post',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const sets: { text: string; arrow: '' | 'L' | 'R' | '^' }[][] = [
      [{ text: 'SIGNAL TOWER', arrow: '^' }],
      [{ text: 'RANGER CABIN', arrow: 'L' }, { text: 'TRAIL', arrow: 'R' }],
      [{ text: 'SURVEY ROUTE', arrow: '^' }],
      [{ text: 'TRAIL', arrow: 'R' }],
    ];
    const H = 2.0;
    // the post
    b.ink({ color: mixRGB(PAL.timberDark, hex(0x2a2018), 0.5), mat: MAT.WOOD, wear: 0.7, snow: 1, vary: 0.06 });
    const post = b.box(0.1, H + SINK, 0.1, { bevel: 0.012, rows: 3 });
    post.move(0, (H - SINK) / 2, 0);
    b.box(0.13, 0.025, 0.13, { bevel: 0.008 }).rotZ(0.12).move(0, H + 0.005, 0);
    const set = sets[v];
    set.forEach((s, i) => {
      const y = H - 0.28 - i * 0.3;
      const w = 0.16 + s.text.length * 0.068;
      const dir = s.arrow === 'L' ? -1 : s.arrow === 'R' ? 1 : 0;
      const g = b.group(() => {
        b.ink({ color: mixRGB(hex(0x3d3326), PAL.timberDark, 0.4), mat: MAT.WOOD, wear: 0.65, snow: 1, vary: 0.05 });
        // the board, its end cut to a point for a direction arrow
        const pts: [number, number][] = dir === 0
          ? [[-w / 2, -0.11], [w / 2, -0.11], [w / 2, 0.11], [-w / 2, 0.11]]
          : dir > 0 ? [[-w / 2, -0.11], [w / 2 - 0.1, -0.11], [w / 2, 0], [w / 2 - 0.1, 0.11], [-w / 2, 0.11]] : [[-w / 2 + 0.1, -0.11], [w / 2, -0.11], [w / 2, 0.11], [-w / 2 + 0.1, 0.11], [-w / 2, 0]];
        b.extrude(pts.map(([x, yy]) => [x, -yy] as [number, number]), 0.035, { bevel: 0.006 }).rotX(Math.PI / 2).move(0, 0, 0);
        b.ink({ color: hex(0xc9bf9a), mat: MAT.PAINT, wear: 0.7, snow: 1 });
        b.stencil(s.text, 0.075, { align: 'center', weight: 0.17 }).move(dir * 0.04, -0.04, 0.0185);
        if (s.arrow === '^') b.stencil('^', 0.08, { align: 'center', weight: 0.2 }).move(w / 2 - 0.08, -0.045, 0.0185);
        // two lag bolts
        b.ink({ color: PAL.rustDark, mat: MAT.METAL, wear: 1.0, snow: 1 });
        b.cyl(0.012, 0.012, { sides: 6 }).rotX(Math.PI / 2).move(0, 0.05, 0.022);
      });
      g.rotZ(r.range(-0.04, 0.04)).move(dir * (w / 2 - 0.05), y, 0.07);
    });
    if (v === 3) {
      // the second board snapped off: a stub on the post, the rest in the snow
      b.ink({ color: mixRGB(hex(0x3d3326), PAL.timberDark, 0.4), mat: MAT.WOOD, wear: 0.7, snow: 1 });
      b.box(0.18, 0.2, 0.035, { bevel: 0.006, rows: 2 }).crumple(0.01, 8).move(-0.12, H - 0.58, 0.07);
      b.box(0.6, 0.035, 0.2, { bevel: 0.006 }).rotY(0.6).move(-0.5, 0.04, 0.35);
    }
    snowHeap(b, [0, 0, 0], 0.3, 0.16, 0.26);
    return b.build({ ground: true });
  },
  { variants: 4, size: 'prop', desc: 'a routed trail sign on a post (no collider)', tags: ['route'] },
);
