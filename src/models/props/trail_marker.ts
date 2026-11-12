// 'trail_marker': a tall pole planted in the snow along the route, orange flagging tape wound
// round its head and a torn orange flag hanging from the one tie it has left. The flag and the
// tape tails swing and flutter in the wind (sway weights for the prop material): limp in calm air,
// flying out flat in a storm.
// Variants (seed & 3): 0 grey stripped sapling; 1 peeled pale pole; 2 galvanised survey rod with
// red bands; 3 leaning pole, the flag nearly torn away, long tape tails.
// Anchors: top (pole tip), flag (the tie).
import { Builder, MAT, PAL, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';

register(
  'trail_marker',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const H = r.range(2.3, 2.7); // above the snow
    const sink = 0.3;
    // survey orange: saturated enough to survive the tone mapper and the fog, faded on the old ones
    const orange = mixRGB(hex(0xe04a0c), PAL.orangeFaded, [0.0, 0.25, 0.1, 0.4][v]);
    let poleR = 0.022;
    const all = b.group(() => {
      // ---- pole ----
      if (v === 2) {
        poleR = 0.016;
        b.ink({ color: PAL.galvanised, mat: MAT.METAL, wear: 0.55, rough: 0.45 });
        b.cyl(poleR, H + sink, { sides: 10, bevel: 0.003 }).move(0, (H + sink) / 2 - sink, 0);
        b.ink({ color: PAL.toolRed, mat: MAT.PAINT, wear: 0.55 });
        for (let i = 0; i < 4; i++) b.cyl(poleR + 0.0008, 0.2, { sides: 10, bevel: 0.001, top: false, bottom: false }).move(0, H - 0.5 - i * 0.4, 0);
        b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.4 });
        b.cyl(poleR + 0.002, 0.03, { sides: 10, bevel: 0.006 }).move(0, H + 0.01, 0);
      } else {
        const bark = v === 1 ? mixRGB(PAL.deadwood, PAL.barkGrey, 0.2) : mixRGB(PAL.barkGrey, PAL.bark, 0.4);
        b.ink({ color: bark, mat: MAT.BARK, wear: 0.5 });
        const pole = b.log(H + sink, poleR, { r2: 0.015, sides: 8, rows: 10, ends: ['saw', v === 3 ? 'break' : 'taper'], bend: r.range(0.03, 0.08), gnarl: 0.0015, peel: v === 1 ? 0.92 : 0.45, knots: r.int(1, 3), bark });
        pole.move(0, (H + sink) / 2 - sink, 0);
      }
      const rAt = (y: number) => (v === 2 ? poleR : poleR + (0.015 - poleR) * ((y + sink) / (H + sink)));

      // ---- flagging tape wound round the head, two tails ----
      b.ink({ color: orange, mat: MAT.PLASTIC, wear: 0.4, rough: 0.6 });
      const tapeY = [H - 0.12, H - 0.16, H - 0.21];
      for (const y of tapeY) b.torus(rAt(y) + 0.002, 0.0028, { segs: 12, sides: 4 }).scale(1, 2.2, 1).move(0, y, 0);
      const tails = v === 3 ? 3 : 2;
      for (let i = 0; i < tails; i++) {
        const len = v === 3 ? r.range(0.45, 0.7) : r.range(0.22, 0.4);
        const a = r.range(0, Math.PI * 2);
        const pin: V3 = [Math.cos(a) * (rAt(H - 0.16) + 0.003), H - 0.15 - i * 0.03, Math.sin(a) * (rAt(H - 0.16) + 0.003)];
        const tail = b.cloth(0.022, len, { nx: 1, ny: Math.max(4, Math.round(len / 0.04)), thickness: 0.0008, wrinkle: 0.004, tear: 0.3, tearEdges: ['bottom'] });
        tail.rotY(-a + Math.PI / 2).move(pin);
        tail.sway(pin, 0.05);
      }

      // ---- the flag: tied by one corner, the other tie torn away ----
      const fw = v === 3 ? 0.36 : 0.42, fh = v === 3 ? 0.22 : 0.3;
      b.ink({ color: orange, mat: MAT.CLOTH, wear: 0.55, vary: 0.04 });
      const flag = b.cloth(fw, fh, { nx: 12, ny: 9, tear: v === 3 ? 0.95 : r.range(0.5, 0.75), tearEdges: ['right', 'bottom'], thickness: 0.0012, wrinkle: 0.01, billow: 0.025 });
      // hang from its top-left corner: the corner to the origin, the long diagonal close to vertical
      flag.move(fw / 2, 0, 0).rotZ(-(Math.PI / 2 - Math.atan2(fh, fw)) * 0.88);
      const tieY = H - 0.27;
      const tie: V3 = [rAt(tieY) + 0.004, tieY, 0];
      flag.move(tie);
      flag.sway(tie, 0);
      // the knot and the cord round the pole
      b.ink({ color: mixRGB(orange, PAL.rope, 0.3), mat: MAT.CLOTH, wear: 0.5 });
      b.torus(rAt(tieY) + 0.003, 0.0025, { segs: 10, sides: 4 }).move(0, tieY + 0.004, 0);
      b.sphere([0.008, 0.009, 0.008], { sides: 6, rings: 4 }).move(tie[0] + 0.003, tieY + 0.004, 0);
      b.anchor('top', [0, H, 0]);
      b.anchor('flag', tie);
    });
    // lean (the leaning one hard, the others a little), about the point where it enters the snow
    const lean = v === 3 ? 0.2 : r.range(0.0, 0.05);
    const dir = r.range(0, Math.PI * 2);
    all.rotY(r.range(0, Math.PI * 2));
    all.rotAxis([Math.cos(dir), 0, Math.sin(dir)], lean);
    return b.build({ aoRadius: 0.05 });
  },
  { variants: 4, size: 'prop', desc: 'route marker pole with a torn orange flag that flies in the wind', tags: ['route'], drawDistance: 260 },
);
