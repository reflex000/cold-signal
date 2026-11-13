// 'axe': a felling axe, 1.5 kg head on a 74 cm hickory haft. Model space (see common.ts): the haft
// stands along +Y with the head at the top, the bit faces forward (-Z), the poll back (+Z), the
// cheeks face +-X; the origin is the right fist on the haft, 0.44 m below the eye of the head.
// The head is old forged steel: worn red paint on the cheeks gone to primer and rust, a battered
// poll, a bright honed edge bevel. The haft is oiled hickory, dark with hand grime at the grips, a
// swelled knob, a steel wedge in the top and a strip of black friction tape under the head.
// Anchors: gripR (origin), gripL (the knob), gripR2 (right hand slid down for a full swing), edge,
// head, end, top. No moving parts.
import { Builder, MAT, PAL, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';
import { gripAnchor, layDown, sstep, toolCtx } from './common';

/** Height of the centre of the eye above the right fist. */
export const AXE_HEAD_Y = 0.44;

// side silhouette of the head: u forward from the haft axis, top / bottom (v) and full thickness
const HEAD: readonly (readonly [number, number, number, number])[] = [
  // u       top     bottom   thick
  [-0.047, 0.03, -0.03, 0.035],
  [-0.043, 0.0335, -0.0335, 0.038],
  [-0.03, 0.0355, -0.0355, 0.04],
  [0.0, 0.036, -0.036, 0.04],
  [0.022, 0.0335, -0.0345, 0.039],
  [0.036, 0.0285, -0.031, 0.034],
  [0.048, 0.0265, -0.0305, 0.027],
  [0.062, 0.0285, -0.0335, 0.02],
  [0.076, 0.0325, -0.039, 0.0145],
  [0.09, 0.0375, -0.0455, 0.0105],
  [0.101, 0.0425, -0.0505, 0.0078],
  [0.111, 0.0465, -0.0548, 0.0056],
  [0.119, 0.049, -0.0578, 0.0036],
  [0.1245, 0.0482, -0.0575, 0.0022],
  [0.128, 0.045, -0.0545, 0.0012],
];

function lerpTable(u: number, col: number): number {
  const T = HEAD;
  if (u <= T[0][0]) return T[0][col];
  for (let i = 1; i < T.length; i++) {
    if (u <= T[i][0]) {
      const a = T[i - 1], b = T[i];
      const t = (u - a[0]) / (b[0] - a[0]);
      return a[col] + (b[col] - a[col]) * t;
    }
  }
  return T[T.length - 1][col];
}

/** Haft radius (along the bit direction) at height y above the fist. */
function haftR(y: number): number {
  if (y < -0.215) {
    // the swelled knob, rounded off at the very end
    const t = (y + 0.262) / 0.047; // 0 at the end, 1 where the swell starts
    return 0.0172 + 0.0042 * Math.sin(Math.min(1, Math.max(0, t)) * Math.PI * 0.95) + 0.0006 * t;
  }
  if (y < 0.15) return 0.0161 - 0.0011 * sstep(-0.215, 0.15, y);
  if (y < 0.4) return 0.015 + 0.0028 * sstep(0.2, 0.4, y);
  return 0.0178 - 0.001 * sstep(0.4, 0.47, y);
}

register(
  'axe',
  (seed, opts) => {
    const b = new Builder(seed);
    const c = toolCtx(b, opts);
    const r = b.rng;
    const HY = AXE_HEAD_Y;
    const g = b.group(() => {
      // ---------------- haft ----------------
      const wood = hex(0x8a6942);
      b.ink({ color: wood, mat: MAT.WOOD, wear: 0.42, snow: 0.6, grain: 'y' });
      const prof: [number, number][] = [[0, -0.2625]];
      const n = c.lod === 0 ? 46 : 18;
      for (let i = 0; i <= n; i++) {
        const y = -0.262 + (0.738 * i) / n;
        prof.push([haftR(y), y]);
      }
      prof.push([0, 0.4765]);
      const haft = b.lathe(prof, { sides: c.sides(14), smooth: true });
      haft.warp((p) => {
        // oval section (long axis along the bit), a slight S along the length, the knob hooks forward
        p.x *= 0.72;
        const t = (p.y + 0.26) / 0.74;
        p.z += 0.0045 * Math.sin(t * Math.PI * 2 + 0.4) - 0.0035 * t;
        const knob = sstep(-0.215, -0.255, p.y);
        p.z -= knob * 0.006 * (p.z < 0 ? 1.6 : 0.4);
      });
      // hand grime where the hands go, oil darkening toward the knob; a scorched patch from a fire
      haft.each((v) => {
        const grip = Math.exp(-(((v.y - 0.0) / 0.07) ** 2)) * 0.32 + Math.exp(-(((v.y + 0.2) / 0.05) ** 2)) * 0.38;
        const k = 1 - grip - 0.1 * sstep(0.1, -0.26, v.y);
        v.r *= k; v.g *= k * 0.97; v.b *= k * 0.93;
        v.wear = 0.3 + 0.35 * grip;
      });
      // ---------------- friction tape under the head ----------------
      b.ink({ color: hex(0x1b1b1d), mat: MAT.CLOTH, wear: 0.6, snow: 0.5, vary: 0.04 });
      const tp: [number, number][] = [];
      const y0 = 0.302, y1 = 0.352;
      for (let i = 0; i <= 8; i++) {
        const y = y0 + ((y1 - y0) * i) / 8;
        tp.push([haftR(y) + 0.0012, y]);
      }
      const tape = b.lathe([[haftR(y0) + 0.0002, y0 - 0.0008], ...tp, [haftR(y1) + 0.0002, y1 + 0.0008]], { sides: c.sides(16), smooth: true });
      const tapeSeed = r.int(0, 999);
      tape.warp((p) => {
        p.x *= 0.72;
        const t = (p.y + 0.26) / 0.74;
        p.z += 0.0045 * Math.sin(t * Math.PI * 2 + 0.4) - 0.0035 * t;
        // the wrap is lumpy where the turns overlap
        const a = Math.atan2(p.x, p.z);
        p.y += 0.0012 * Math.sin(a * 2 + tapeSeed) * (p.y > (y0 + y1) / 2 ? 1 : -1);
      });
      // the frayed end of the tape where it was torn off
      b.box(0.012, 0.016, 0.0012, { bevel: 0.0004 }).rotY(0.3).move(0.006, y1 - 0.008, -0.0175);

      // ---------------- head ----------------
      const red = hex(0x7d271c);
      b.ink({ color: red, mat: MAT.PAINT, wear: 0.72, snow: 0.6, rough: 0.6 });
      const path: V3[] = [];
      const us = HEAD.map((row) => row[0]);
      for (const u of us) path.push([0, HY, -u]);
      const u0 = us[0], u1 = us[us.length - 1];
      const sq: [number, number][] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      const head = b.sweep(sq, path, {
        bevel: 0.16,
        seg: c.lod === 0 ? 2 : 1,
        up: [0, 1, 0],
        scale: (t) => {
          const u = u0 + (u1 - u0) * t;
          return [lerpTable(u, 3), lerpTable(u, 1) - lerpTable(u, 2)];
        },
      });
      head.warp((p) => {
        const u = -p.z;
        p.y += (lerpTable(u, 1) + lerpTable(u, 2)) / 2;
        // the edge is a gentle convex curve, the cheeks a little hollow behind it
        const v = (p.y - HY) / 0.056;
        if (u > 0.1) p.z -= (u - 0.1) / 0.028 * 0.006 * (1 - v * v);
        const hollow = sstep(0.04, 0.07, u) * sstep(0.125, 0.09, u);
        p.x *= 1 - 0.12 * hollow;
      });
      const steel = hex(0x9a9ea2);
      head.each((v) => {
        const u = -v.z;
        if (u > 0.116) {
          // the honed bevel: bright, smooth, freshly ground
          v.mat = MAT.METAL;
          v.r = steel[0] * 1.15; v.g = steel[1] * 1.15; v.b = steel[2] * 1.15;
          v.rough = 0.22;
          v.wear = 0.12;
        } else if (u > 0.1) {
          v.mat = MAT.METAL;
          v.r = PAL.steelDark[0]; v.g = PAL.steelDark[1]; v.b = PAL.steelDark[2];
          v.wear = 0.42;
        } else if (u < -0.042) {
          // the poll: hammered, paint long gone
          v.mat = MAT.METAL;
          v.r = PAL.iron[0] * 1.1; v.g = PAL.iron[1] * 1.1; v.b = PAL.iron[2] * 1.1;
          v.wear = 0.78;
        }
      });
      if (c.lod === 0) {
        // the poll mushroomed from being used as a hammer
        head.dent([0, HY + 0.02, 0.047], 0.012, -0.0012, [0, 0, -1]);
        head.dent([0, HY - 0.015, 0.047], 0.01, -0.001, [0, 0, -1]);
        // a maker's stamp on the cheek
        b.ink({ color: mixRGB(PAL.iron, red, 0.3), mat: MAT.METAL, wear: 0.7, snow: 0.6 });
        const stamp = b.stencil('3 1/2', 0.0075, { weight: 0.14, align: 'center' });
        stamp.rotY(Math.PI / 2).move(0.0206, HY - 0.006, -0.012);
        const stamp2 = b.stencil('3 1/2', 0.0075, { weight: 0.14, align: 'center' });
        stamp2.rotY(-Math.PI / 2).move(-0.0206, HY - 0.006, -0.012);
      }
      // the steel wedge across the top of the haft
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.6, snow: 0.7 });
      b.box(0.0025, 0.004, 0.03, { bevel: 0.0008 }).move(0, 0.4772, 0.001);
      b.ink({ color: hex(0x5f4a33), mat: MAT.WOOD, wear: 0.5, snow: 0.7 });
      b.cyl(0.0172, 0.003, { sides: c.sides(14), bevel: 0.0012 }).scale(0.72, 1, 1).move(0, 0.4755, -0.0005);
    });

    if (c.pose === 'ground') layDown(g, 0, 0.35, Math.PI / 2);
    else {
      // right hand on the haft (thumb toward the head, knuckles toward the bit), left hand at the knob
      gripAnchor(b, 'gripR', [0, 0, 0], [0, 0, -1], [0, 1, 0]);
      gripAnchor(b, 'gripR2', [0, -0.13, 0], [0, 0, -1], [0, 1, 0]);
      gripAnchor(b, 'gripL', [0, -0.212, -0.002], [0, 0, -1], [0, 1, 0]);
      b.anchor('edge', [0, HY - 0.004, -0.13]);
      b.anchor('head', [0, HY, 0]);
      b.anchor('end', [0, -0.262, 0]);
      b.anchor('top', [0, 0.478, 0]);
    }
    return b.build({ ao: 0.9, ground: c.pose === 'ground', aoRadius: 0.03 });
  },
  { variants: 1, size: 'item', desc: 'felling axe, hickory haft', tags: ['tool', 'pickup'] },
);
