// 'rifle': a bolt-action hunting rifle with a scope and a leather sling, 1.1 m. Model space (see
// common.ts): the barrel points forward (-Z), the bolt handle is on the right (+X); the origin is the
// right fist on the pistol grip, the bore 6 cm above it. Oiled walnut stock with a cheekpiece on the
// left, black recoil pad behind a white spacer, blued receiver, barrel and floorplate, a bright bolt
// body, a 3-9x scope in two rings, sling swivels and a worn sling hanging between them.
// Named parts (hand pose): bolt (pivot on the bore axis at the handle root: lifted by turning about
// +Z, pulled back along +Z), trigger.
// Anchors: gripR (pistol grip, origin), gripL (fore-end), boltKnob (the knob, closed), eye (where the
// eye sits behind the scope), scope, muzzle, port (top of the open action), cheek.
import { Builder, MAT, PAL, Path, hex, mixRGB, type P2, type V3 } from '../kit';
import { register } from '../registry';
import { gripAnchor, layDown, sstep, toolCtx } from './common';

export const RIFLE_BORE_Y = 0.06;
export const RIFLE_SCOPE_Y = 0.103;
export const RIFLE_MUZZLE_Z = -0.762;
/** Eye relief: the eye sits this far behind the eyepiece. */
export const RIFLE_EYE: V3 = [0, RIFLE_SCOPE_Y, 0.146];
export const RIFLE_BOLT_PIVOT: V3 = [0, RIFLE_BORE_Y, 0.02];
/** How far the bolt travels back, and the angle it lifts through (radians about +Z). */
export const RIFLE_BOLT_TRAVEL = 0.088;
export const RIFLE_BOLT_LIFT = 1.45;

// stock along z: [z, top, bottom, width]
const STOCK: readonly (readonly [number, number, number, number])[] = [
  [0.312, 0.09, -0.064, 0.0405],
  [0.28, 0.0912, -0.06, 0.041],
  [0.24, 0.0905, -0.05, 0.0405],
  [0.2, 0.0885, -0.036, 0.039],
  [0.16, 0.0855, -0.02, 0.037],
  [0.12, 0.0815, -0.004, 0.034],
  [0.085, 0.0775, 0.01, 0.031],
  [0.055, 0.0725, 0.0175, 0.0302],
  [0.035, 0.0645, 0.02, 0.033],
  [0.01, 0.0565, 0.018, 0.0398],
  [-0.04, 0.0545, 0.0125, 0.042],
  [-0.13, 0.0545, 0.0125, 0.042],
  [-0.15, 0.0532, 0.0195, 0.041],
  [-0.2, 0.0512, 0.0238, 0.0398],
  [-0.28, 0.0492, 0.0268, 0.0378],
  [-0.36, 0.048, 0.0298, 0.0348],
  [-0.392, 0.0472, 0.0318, 0.031],
  [-0.405, 0.0458, 0.0335, 0.024],
];

function stockAt(z: number, col: number): number {
  const T = STOCK;
  if (z >= T[0][0]) return T[0][col];
  for (let i = 1; i < T.length; i++) {
    if (z >= T[i][0]) {
      const a = T[i - 1], b = T[i];
      const t = (z - a[0]) / (b[0] - a[0]);
      return a[col] + (b[col] - a[col]) * t;
    }
  }
  return T[T.length - 1][col];
}

/** A rounded-square outline (superellipse), unit half-size, n points. */
function roundSquare(n: number, e: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    out.push([Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * 0.5, Math.sign(s) * Math.pow(Math.abs(s), 2 / e) * 0.5]);
  }
  return out;
}

register(
  'rifle',
  (seed, opts) => {
    const b = new Builder(seed);
    const c = toolCtx(b, opts);
    const sides = c.sides(18);
    const BY = RIFLE_BORE_Y, SY = RIFLE_SCOPE_Y;
    const walnut = hex(0x4b2e1b);
    const blued = hex(0x22252a);
    const g = b.group(() => {
      // ---------------- stock ----------------
      b.ink({ color: walnut, mat: MAT.WOOD, wear: 0.45, snow: 0.6, grain: 'z', vary: 0 });
      const zs = STOCK.map((s) => s[0]);
      const path: V3[] = zs.map((z) => [0, 0, z] as V3);
      const z0 = zs[0], z1 = zs[zs.length - 1];
      const stock = b.sweep(roundSquare(c.lod === 0 ? 20 : 12, 2.7), path, {
        up: [0, 1, 0],
        smooth: true,
        scale: (t) => {
          const z = z0 + (z1 - z0) * t;
          return [stockAt(z, 3), stockAt(z, 1) - stockAt(z, 2)];
        },
      });
      stock.warp((p) => {
        const z = p.z;
        p.y += (stockAt(z, 1) + stockAt(z, 2)) / 2;
        // a cheekpiece swelling out of the left side of the butt
        const ck = sstep(0.11, 0.15, z) * sstep(0.29, 0.25, z) * sstep(0.025, 0.05, p.y) * sstep(0.09, 0.07, p.y);
        if (p.x < 0) p.x -= ck * 0.0065;
        // the comb rolls over toward the right (where the cheek does not rest)
        if (p.x > 0 && p.y > 0.07 && z > 0.1) p.y -= (p.x / 0.02) * 0.002;
      });
      // darker, oil-soaked where the hands go; the fore-end tip and the wrist worn pale
      stock.each((v) => {
        const fore = sstep(-0.16, -0.22, v.z) * sstep(-0.36, -0.3, v.z);
        const wrist = sstep(0.0, 0.04, v.z) * sstep(0.12, 0.08, v.z);
        const k = 1 - 0.18 * fore - 0.12 * wrist;
        v.r *= k; v.g *= k; v.b *= k;
        v.wear = 0.38 + 0.3 * Math.max(fore, wrist) + (v.z < -0.39 ? 0.3 : 0);
      });
      // pistol grip, raked back, a palm swell
      const top: V3 = [0, 0.036, -0.0141], bot: V3 = [0, -0.0718, 0.0251];
      const ell: P2[] = [];
      for (let i = 0; i < (c.lod === 0 ? 16 : 10); i++) {
        const a = (i / (c.lod === 0 ? 16 : 10)) * Math.PI * 2;
        ell.push([Math.cos(a) * 0.0152, Math.sin(a) * 0.0212]);
      }
      b.ink({ color: walnut, mat: MAT.WOOD, wear: 0.5, snow: 0.6, grain: 'y', vary: 0 });
      const grip = b.sweep(ell, [top, [(top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2, (top[2] + bot[2]) / 2], bot], {
        up: [0, 0, -1],
        smooth: true,
        scale: (t) => [1 + 0.05 * Math.sin(Math.PI * t), 1 + 0.07 * Math.sin(Math.PI * t)],
      });
      grip.tint(mixRGB(walnut, [0, 0, 0], 0.35), (v) => 0.35 * sstep(0.02, -0.04, v.y));
      // grip cap
      b.ink({ color: hex(0x121212), mat: MAT.PLASTIC, wear: 0.4, snow: 0.6 });
      b.cyl(0.0163, 0.004, { sides: c.sides(14), bevel: 0.0012 }).scale(1, 1, 1.38).rotX(-0.348).move(bot[0], bot[1] - 0.001, bot[2] + 0.0005);
      // recoil pad behind a white spacer
      const padPath: V3[] = [[0, 0, 0.3105], [0, 0, 0.3135], [0, 0, 0.336]];
      b.ink({ color: hex(0xc9c4b6), mat: MAT.PLASTIC, wear: 0.4, snow: 0.6 });
      const spacer = b.sweep(roundSquare(c.lod === 0 ? 20 : 12, 2.7), padPath.slice(0, 2), { up: [0, 1, 0], smooth: true, scale: () => [0.0408, 0.155] });
      spacer.move(0, 0.013, 0);
      b.ink({ color: hex(0x1a1714), mat: MAT.RUBBER, wear: 0.45, snow: 0.6 });
      const pad = b.sweep(roundSquare(c.lod === 0 ? 20 : 12, 2.7), padPath.slice(1), { up: [0, 1, 0], smooth: true, scale: (t) => [0.0405 - 0.002 * t, 0.155 - 0.004 * t] });
      pad.move(0, 0.013, 0);

      // ---------------- steel: receiver, tang, barrel ----------------
      b.ink({ color: blued, mat: MAT.METAL, wear: 0.36, snow: 0.6, rough: 0.36 });
      const rec = b.cyl(0.017, 0.235, { sides, bevel: 0.003, rows: 2 });
      rec.rotX(Math.PI / 2).move(0, BY, -0.0825);
      // the flat bottom of the action sits in the stock; a recoil lug under the front ring
      b.box(0.026, 0.012, 0.2, { bevel: 0.002 }).move(0, BY - 0.012, -0.08);
      b.box(0.022, 0.01, 0.06, { bevel: 0.002 }).move(0, 0.0655, 0.058);
      // ejection port on the right: a dark slot
      b.ink({ color: hex(0x0b0b0c), mat: MAT.METAL, wear: 0.2, snow: 0, rough: 0.5 });
      b.box(0.003, 0.018, 0.074, { bevel: 0.0008 }).move(0.0161, BY + 0.004, -0.075);
      // safety slider on the tang
      b.ink({ color: hex(0x7d7f80), mat: MAT.METAL, wear: 0.3, snow: 0.5 });
      b.box(0.006, 0.004, 0.011, { bevel: 0.001 }).move(0.008, 0.0722, 0.07);
      // barrel: tapered sporter contour, crowned
      b.ink({ color: blued, mat: MAT.METAL, wear: 0.32, snow: 0.6, rough: 0.34 });
      // (lathes here are made along +Y with y = -z, then turned by rotX(-90 deg): (x, y, z) -> (x, z, -y))
      const bp: P2[] = [[0, -0.2005], [0.0122, -0.2], [0.0122, -0.235], [0.0109, -0.29]];
      for (let i = 1; i <= 6; i++) bp.push([0.0109 - 0.0027 * (i / 6), -0.29 - 0.465 * (i / 6)]);
      // the crown, then down the bore
      bp.push([0.0082, RIFLE_MUZZLE_Z + 0.002], [0.0068, RIFLE_MUZZLE_Z], [0.0043, RIFLE_MUZZLE_Z], [0.0043, RIFLE_MUZZLE_Z + 0.012], [0, RIFLE_MUZZLE_Z + 0.012]);
      const barrel = b.lathe(bp.map(([rr, z]) => [rr, -z] as P2), { sides, smooth: true });
      barrel.rotX(-Math.PI / 2).move(0, BY, 0);
      barrel.each((v) => {
        if (v.z < RIFLE_MUZZLE_Z + 0.0125 && Math.hypot(v.x, v.y - BY) < 0.0046) {
          v.r = v.g = v.b = 0.006;
          v.wear = 0.05;
        }
      });

      // ---------------- trigger guard, floorplate, swivels ----------------
      b.ink({ color: blued, mat: MAT.METAL, wear: 0.45, snow: 0.6, rough: 0.4 });
      b.box(0.027, 0.004, 0.096, { bevel: 0.0015 }).move(0, 0.0115, -0.088);
      b.strap(Path.fillet([[0, 0.015, -0.044], [0, -0.006, -0.04], [0, -0.007, -0.01], [0, 0.012, 0.012]], 0.009, 3), 0.009, 0.0035, { up: [1, 0, 0] });
      c.part('trigger', [0, 0.014, -0.026], () => {
        b.ink({ color: hex(0x9a9c9e), mat: MAT.METAL, wear: 0.35, snow: 0.4 });
        b.box(0.006, 0.022, 0.0045, { bevel: 0.0015, rows: 3 }).bend(-0.5, 'x').move(0, 0.003, -0.026);
      });
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.5, snow: 0.6 });
      const swF: V3 = [0, 0.0262, -0.34], swR: V3 = [0, -0.04, 0.215];
      for (const s of [swF, swR]) {
        b.cyl(0.0042, 0.008, { sides: 8, bevel: 0.001 }).move(s[0], s[1] - 0.002, s[2]);
        b.torus(0.0085, 0.0016, { sides: 5, segs: 10 }).rotZ(Math.PI / 2).move(s[0], s[1] - 0.012, s[2]);
      }

      // ---------------- sling: worn leather between the swivels ----------------
      if (c.lod === 0 || c.pose === 'hand') {
        b.ink({ color: hex(0x3f2a1b), mat: MAT.CLOTH, wear: 0.6, snow: 0.6, rough: 0.75, grain: 'z' });
        const a: V3 = [0, swF[1] - 0.02, swF[2]], e: V3 = [0, swR[1] - 0.02, swR[2]];
        const cat = Path.catenary(a, e, c.pose === 'hand' ? 0.1 : 0.03, c.lod === 0 ? 16 : 8);
        b.strap(cat, 0.024, 0.0036, { up: [0, 1, 0] });
        // the keeper and the buckle near the front swivel
        b.ink({ color: hex(0x2e1f15), mat: MAT.CLOTH, wear: 0.55, snow: 0.6 });
        const k = cat[3], k2 = cat[4];
        b.box(0.029, 0.0075, 0.014, { bevel: 0.002 }).rotX(Math.atan2(-(k2[1] - k[1]), k2[2] - k[2])).move(k[0], k[1], k[2]);
      }

      // ---------------- scope ----------------
      b.ink({ color: hex(0x151617), mat: MAT.PAINT, wear: 0.22, snow: 0.6, rough: 0.5 });
      const sp: P2[] = [
        [0, 0.0585], [0.0168, 0.0585], [0.0198, 0.0575], [0.0204, 0.052], [0.0204, 0.03], [0.0188, 0.022], [0.016, 0.0145], [0.0133, 0.006],
        [0.0158, 0.0035], [0.0162, -0.0005], [0.0162, -0.026], [0.0158, -0.0295], [0.0128, -0.032],
        [0.0127, -0.172], [0.0148, -0.19], [0.0205, -0.222], [0.0255, -0.244], [0.0262, -0.25], [0.0262, -0.268], [0.0248, -0.2725], [0.022, -0.2728], [0, -0.2728],
      ];
      const scope = b.lathe(sp.map(([rr, z]) => [rr, -z] as P2), { sides: c.sides(20), smooth: true });
      scope.rotX(-Math.PI / 2).move(0, SY, 0);
      // knurled power ring
      if (c.lod === 0) {
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          b.box(0.0016, 0.0014, 0.02, { bevel: 0.0004 }).move(Math.cos(a) * 0.0163, SY + Math.sin(a) * 0.0163, -0.013);
        }
      }
      // turret saddle, elevation and windage turrets
      b.pillow(0.031, 0.029, 0.04, { round: 0.009, seg: 1, ring: c.lod === 0 ? 2 : 1 }).move(0, SY, -0.112);
      b.cyl(0.0112, 0.017, { sides: c.sides(14), bevel: 0.002 }).move(0, SY + 0.0205, -0.112);
      b.cyl(0.0112, 0.017, { sides: c.sides(14), bevel: 0.002 }).rotZ(-Math.PI / 2).move(0.0205, SY, -0.112);
      b.ink({ color: hex(0x9a9ea0), mat: MAT.METAL, wear: 0.3, snow: 0.5 });
      b.box(0.0012, 0.0006, 0.009, { bevel: 0.0002 }).move(0, SY + 0.0293, -0.112);
      // lenses: coated glass, blue-green, glossy
      b.ink({ color: hex(0x0d1a1c), mat: MAT.PLASTIC, wear: 0.05, snow: 0, rough: 0.05 });
      b.cyl(0.0165, 0.001, { sides: c.sides(18), bevel: 0.0002 }).rotX(Math.PI / 2).move(0, SY, 0.0592);
      b.cyl(0.0222, 0.001, { sides: c.sides(18), bevel: 0.0002 }).rotX(Math.PI / 2).move(0, SY, -0.2735);
      // rings and bases on the receiver
      b.ink({ color: hex(0x18191a), mat: MAT.METAL, wear: 0.35, snow: 0.6, rough: 0.45 });
      for (const z of [-0.036, -0.166]) {
        b.cyl(0.0153, 0.011, { sides: c.sides(16), bevel: 0.0015 }).rotX(Math.PI / 2).move(0, SY, z);
        b.box(0.02, 0.016, 0.011, { bevel: 0.0018 }).move(0, BY + 0.0215, z);
        b.cyl(0.0024, 0.03, { sides: 6, bevel: 0.0005 }).rotZ(Math.PI / 2).move(0, SY - 0.0085, z);
      }

      // ---------------- bolt ----------------
      c.part('bolt', RIFLE_BOLT_PIVOT, () => {
        b.ink({ color: hex(0x8e9295), mat: MAT.METAL, wear: 0.25, snow: 0.3, rough: 0.3 });
        b.cyl(0.0088, 0.15, { sides: c.sides(14), bevel: 0.0015 }).rotX(Math.PI / 2).move(0, BY, -0.04);
        b.ink({ color: blued, mat: MAT.METAL, wear: 0.35, snow: 0.5, rough: 0.36 });
        // bolt shroud behind the receiver
        b.lathe([[0, 0.0625], [0.004, 0.0625], [0.0095, 0.06], [0.0122, 0.05], [0.0122, 0.034], [0, 0.034]].map(([rr, z]) => [rr, -z] as P2), { sides: c.sides(14), smooth: true })
          .rotX(-Math.PI / 2).move(0, BY, 0);
        // handle: out to the right, swept back and down to the knob
        const root: V3 = [0.012, BY + 0.001, 0.02];
        const knob: V3 = [0.0545, BY - 0.026, 0.037];
        b.pipe([root, [0.03, BY - 0.004, 0.025], [0.046, BY - 0.016, 0.032], knob], 0.0034, { sides: 8 });
        b.ink({ color: hex(0x1d1e20), mat: MAT.METAL, wear: 0.45, snow: 0.5, rough: 0.4 });
        b.sphere(0.0092, { sides: c.sides(12), rings: c.lod === 0 ? 7 : 5 }).scale(1, 1, 1.1).move(knob[0] + 0.002, knob[1] - 0.003, knob[2] + 0.001);
      });
    });

    if (c.pose === 'ground') layDown(g, 0, 1.2, Math.PI / 2);
    else {
      gripAnchor(b, 'gripR', [0, 0, 0], [0, -0.341, -0.94], [0, 0.94, -0.341]);
      // FIGURES' item space: the barrel along the knuckles (+Y), the bore above the fist (thumb up)
      gripAnchor(b, 'item', [0, 0, 0], [0, 0, -1], [0, 1, 0]);
      gripAnchor(b, 'gripL', [0, 0.031, -0.255], [1, 0, 0], [0, 0, -1]);
      // the right hand on the bolt knob (closed): thumb toward the receiver, knuckles forward
      gripAnchor(b, 'boltKnob', [0.062, BY - 0.031, 0.04], [0.15, 0.25, -0.95], [-0.8, 0.55, 0]);
      b.anchor('eye', RIFLE_EYE);
      b.anchor('scope', [0, SY, 0.0585]);
      b.anchor('muzzle', [0, BY, RIFLE_MUZZLE_Z]);
      b.anchor('port', [0.01, BY + 0.02, -0.07]);
      b.anchor('cheek', [-0.008, 0.088, 0.17]);
    }
    return b.build({ ao: 0.9, ground: c.pose === 'ground', aoRadius: 0.025 });
  },
  { variants: 1, size: 'item', desc: 'bolt-action hunting rifle, scope and sling', tags: ['tool', 'pickup'] },
);
