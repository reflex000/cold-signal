// 'radio': a hand-crank emergency radio, 168 x 112 x 64 mm. Model space (see common.ts), but the
// origin is the centre of the box (two hands use it): the front (speaker, signal meter) faces +Z,
// toward the holder; the crank is on the right end (+X), the telescopic antenna rises from the top
// left corner. Olive-grey moulded body with rubber corner bumpers, a slotted speaker grille, a
// backlit signal meter with a needle, a charge lamp, a tuning knob, a small solar strip on top and a
// webbing carry handle. The crank folds out of the right end with an orange knob.
// Named parts (hand pose): crank (pivot on the axle, turns about +X), needle (pivot at its foot,
// turns about +Z: -0.9 rad empty .. +0.9 rad full scale), glow (meter face and charge lamp: the
// first-person view lights them with the radio's charge).
// Anchors: gripL (left hand round the left end), gripR (right hand on the crank knob at angle 0),
// carry (the top handle, FIGURES' item space), needle, crankAxle, antennaTip, speaker.
import { Builder, MAT, PAL, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';
import { gripAnchor, layDown, toolCtx } from './common';

export const RADIO_W = 0.168;
export const RADIO_H = 0.112;
export const RADIO_D = 0.064;
export const RADIO_CRANK_AXLE: V3 = [RADIO_W / 2 + 0.004, -0.006, 0.002];
/** Crank arm length (axle to knob), and the knob's offset out from the arm. */
export const RADIO_CRANK_ARM = 0.046;
export const RADIO_NEEDLE: V3 = [0.04, 0.006, RADIO_D / 2 + 0.0012];
/** Needle sweep: radians either side of upright. */
export const RADIO_NEEDLE_SWEEP = 0.9;

register(
  'radio',
  (seed, opts) => {
    const b = new Builder(seed);
    const c = toolCtx(b, opts);
    const W = RADIO_W, H = RADIO_H, D = RADIO_D;
    const fz = D / 2; // front face
    const body = hex(0x5b6351);
    const panel = hex(0x34373b);
    const g = b.group(() => {
      // ---------------- body ----------------
      b.ink({ color: body, mat: MAT.PLASTIC, wear: 0.5, snow: 0.6, rough: 0.62, vary: 0.02 });
      b.pillow(W, H, D, { round: 0.012, bulge: 0.0012, seg: c.lod === 0 ? 3 : 1, ring: c.lod === 0 ? 2 : 1 });
      // rubber bumpers on the four end corners
      b.ink({ color: hex(0x18191a), mat: MAT.RUBBER, wear: 0.5, snow: 0.6 });
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const bump = b.pillow(0.03, 0.03, D + 0.006, { round: 0.009, seg: 1, ring: 1 });
        bump.move(sx * (W / 2 - 0.011), sy * (H / 2 - 0.011), 0);
      }
      // front panel, slightly raised, darker
      b.ink({ color: panel, mat: MAT.PLASTIC, wear: 0.45, snow: 0.4, rough: 0.55 });
      b.box(W - 0.05, H - 0.022, 0.004, { bevel: 0.0015 }).move(0, 0, fz + 0.0005);
      // ---------------- speaker grille: slots in a recess ----------------
      const gx0 = -0.06, gx1 = -0.002, gy0 = -0.04, gy1 = 0.036;
      b.ink({ color: hex(0x0c0c0d), mat: MAT.PLASTIC, wear: 0.2, snow: 0.2, rough: 0.8 });
      b.box(gx1 - gx0, gy1 - gy0, 0.002, { bevel: 0.0006 }).move((gx0 + gx1) / 2, (gy0 + gy1) / 2, fz + 0.0022);
      b.ink({ color: mixRGB(panel, body, 0.4), mat: MAT.PLASTIC, wear: 0.55, snow: 0.4, rough: 0.5 });
      const bars = c.lod === 0 ? 10 : 5;
      for (let i = 0; i <= bars; i++) {
        const y = gy0 + ((gy1 - gy0) * i) / bars;
        b.box(gx1 - gx0 + 0.004, c.lod === 0 ? 0.0036 : 0.0068, 0.003, { bevel: 0.0008 }).move((gx0 + gx1) / 2, y, fz + 0.0035);
      }
      // ---------------- signal meter: bezel, ticks; the face and lamp glow ----------------
      const mx0 = 0.012, mx1 = 0.068, my0 = 0.0, my1 = 0.038;
      const mcx = (mx0 + mx1) / 2, mcy = (my0 + my1) / 2;
      b.ink({ color: hex(0x101011), mat: MAT.PLASTIC, wear: 0.4, snow: 0.3, rough: 0.4 });
      b.box(mx1 - mx0 + 0.007, my1 - my0 + 0.007, 0.0035, { bevel: 0.0012 }).move(mcx, mcy, fz + 0.0022);
      const em = c.pose === 'hand' ? 1 : 0;
      c.part('glow', [mcx, mcy, fz + 0.004], () => {
        b.ink({ color: hex(0xe7d9b0), mat: MAT.PLASTIC, wear: 0.15, snow: 0, rough: 0.6, emissive: em * 0.9 });
        b.box(mx1 - mx0, my1 - my0, 0.001, { bevel: 0.0002 }).move(mcx, mcy, fz + 0.0042);
        // charge lamp under the meter
        b.ink({ color: hex(0xff6a28), mat: MAT.EMISSIVE, snow: 0, emissive: em * 2.2 });
        b.dome(0.0032, 0.002, 8).rotX(Math.PI / 2).move(0.062, -0.012, fz + 0.0024);
      });
      // scale ticks on an arc round the needle's foot, the red end zone
      b.ink({ color: hex(0x1a1714), mat: MAT.PLASTIC, wear: 0.1, snow: 0 });
      const nf = RADIO_NEEDLE;
      const ticks = c.lod === 0 ? 11 : 0;
      for (let i = 0; i < ticks; i++) {
        const a = -RADIO_NEEDLE_SWEEP + (2 * RADIO_NEEDLE_SWEEP * i) / (ticks - 1);
        const long = i % 5 === 0;
        const r0 = 0.024, len = long ? 0.0055 : 0.0035;
        b.box(0.0007, len, 0.0003, { bevel: 0.0001 }).move(0, r0 + len / 2, 0).rotZ(-a).move(nf[0], nf[1], fz + 0.0049);
      }
      if (c.lod === 0) {
        b.ink({ color: hex(0x8a2015), mat: MAT.PLASTIC, wear: 0.1, snow: 0 });
        for (let i = 0; i < 4; i++) {
          const a = RADIO_NEEDLE_SWEEP * (0.62 + 0.1 * i);
          b.box(0.0024, 0.0016, 0.0003, { bevel: 0.0001 }).move(0, 0.0215, 0).rotZ(-a).move(nf[0], nf[1], fz + 0.0049);
        }
        // lettering
        b.ink({ color: hex(0xb9b3a2), mat: MAT.PAINT, wear: 0.5, snow: 0.2 });
        b.stencil('AM  FM', 0.0045, { weight: 0.16, align: 'center' }).move(0.04, -0.0432, fz + 0.0028);
      }
      c.part('needle', nf, () => {
        b.ink({ color: hex(0x101010), mat: MAT.PLASTIC, wear: 0.1, snow: 0 });
        b.box(0.0009, 0.029, 0.0006, { bevel: 0.0001 }).move(nf[0], nf[1] + 0.0145, nf[2] + 0.0042);
        b.cyl(0.0022, 0.0012, { sides: 8, bevel: 0.0003 }).rotX(Math.PI / 2).move(nf[0], nf[1], nf[2] + 0.0042);
      });
      // ---------------- tuning knob, band switch ----------------
      b.ink({ color: hex(0x1b1c1d), mat: MAT.PLASTIC, wear: 0.5, snow: 0.4, rough: 0.5 });
      b.cyl(0.0105, 0.009, { sides: c.sides(16), bevel: 0.0018 }).rotX(Math.PI / 2).move(0.04, -0.026, fz + 0.0055);
      if (c.lod === 0) {
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          b.box(0.0014, 0.0014, 0.0085, { bevel: 0.0003 }).move(0.04 + Math.cos(a) * 0.0106, -0.026 + Math.sin(a) * 0.0106, fz + 0.0055);
        }
        b.box(0.0045, 0.009, 0.004, { bevel: 0.001 }).move(0.012, -0.026, fz + 0.004);
      }
      // ---------------- top: solar strip, carry handle, antenna ----------------
      b.ink({ color: hex(0x0d1418), mat: MAT.PLASTIC, wear: 0.15, snow: 0.8, rough: 0.12 });
      b.box(0.074, 0.0014, 0.03, { bevel: 0.0005 }).move(0.012, H / 2 + 0.0002, -0.004);
      b.ink({ color: hex(0x1d1f22), mat: MAT.CLOTH, wear: 0.55, snow: 0.7, rough: 0.9 });
      const hp: V3[] = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        hp.push([-0.046 + 0.092 * t, H / 2 - 0.002 + Math.sin(t * Math.PI) * 0.024, 0.004]);
      }
      b.strap(hp, 0.018, 0.003, { up: [0, 1, 0] });
      b.ink({ color: hex(0x16171a), mat: MAT.PLASTIC, wear: 0.5, snow: 0.6 });
      for (const s of [-1, 1]) b.box(0.012, 0.007, 0.022, { bevel: 0.002 }).move(s * 0.046, H / 2 + 0.002, 0.004);
      // telescopic antenna: swivel, three chrome sections (collapsed on the ground)
      const ax = -W / 2 + 0.014, az = -D / 2 + 0.012, ay = H / 2;
      b.ink({ color: hex(0x1a1a1b), mat: MAT.PLASTIC, wear: 0.4, snow: 0.6 });
      b.cyl(0.0065, 0.01, { sides: c.sides(10), bevel: 0.0015 }).move(ax, ay + 0.004, az);
      b.ink({ color: hex(0xb8bcbf), mat: MAT.METAL, wear: 0.25, snow: 0.6, rough: 0.2 });
      const ext = c.pose === 'hand';
      const secs = ext ? [[0.0042, 0.105], [0.0034, 0.1], [0.0027, 0.094]] : [[0.0042, 0.105]];
      let y = ay + 0.008;
      for (const [rr, len] of secs) {
        b.cyl(rr, len, { sides: c.sides(8), bevel: 0.0006 }).move(ax, y + len / 2, az);
        y += len - 0.006;
      }
      b.sphere(0.0042, { sides: c.sides(8), rings: 4 }).move(ax, y + 0.006, az);
      const tip: V3 = [ax, y + 0.006, az];

      // ---------------- crank (folds out of the right end) ----------------
      const A = RADIO_CRANK_AXLE;
      b.ink({ color: hex(0x1a1b1c), mat: MAT.PLASTIC, wear: 0.5, snow: 0.6 });
      b.cyl(0.0155, 0.006, { sides: c.sides(16), bevel: 0.0015 }).rotZ(Math.PI / 2).move(A[0] - 0.003, A[1], A[2]);
      c.part('crank', A, () => {
        b.ink({ color: hex(0x202123), mat: MAT.PLASTIC, wear: 0.5, snow: 0.6, rough: 0.45 });
        b.cyl(0.0105, 0.009, { sides: c.sides(14), bevel: 0.002 }).rotZ(Math.PI / 2).move(A[0] + 0.004, A[1], A[2]);
        b.box(0.0065, RADIO_CRANK_ARM + 0.012, 0.012, { bevel: 0.0025 }).move(A[0] + 0.0075, A[1] - RADIO_CRANK_ARM / 2, A[2]);
        b.ink({ color: hex(0xb4511f), mat: MAT.PLASTIC, wear: 0.55, snow: 0.6, rough: 0.5 });
        b.cyl(0.0074, 0.03, { sides: c.sides(12), bevel: 0.0022 }).rotZ(Math.PI / 2).move(A[0] + 0.0255, A[1] - RADIO_CRANK_ARM, A[2]);
      });
      void PAL;
      b.anchor('antennaTip', tip);
    });

    if (c.pose === 'ground') layDown(g, -Math.PI / 2, 0.4, 0);
    else {
      // left hand under the left end, palm up, fingers along the bottom: the radio sits on it like a book
      gripAnchor(b, 'gripL', [-W / 2 + 0.03, -H / 2 - 0.021, 0.0], [1, 0, 0], [0, 0, -1]);
      gripAnchor(b, 'gripR', [A0(0.0255), A0y(), RADIO_CRANK_AXLE[2]], [0, 0.45, -0.89], [-1, 0, 0]);
      gripAnchor(b, 'carry', [0, H / 2 + 0.022, 0.004], [0, -1, 0], [-1, 0, 0]);
      b.anchor('needle', RADIO_NEEDLE);
      b.anchor('crankAxle', RADIO_CRANK_AXLE);
      b.anchor('speaker', [-0.031, -0.002, fz + 0.004]);
    }
    return b.build({ ao: 0.9, ground: c.pose === 'ground', aoRadius: 0.02 });
  },
  { variants: 1, size: 'item', desc: 'hand-crank emergency radio', tags: ['tool', 'pickup'] },
);

/** The crank knob's centre at crank angle 0 (the arm hangs straight down). */
function A0(out: number): number {
  return RADIO_CRANK_AXLE[0] + out;
}
function A0y(): number {
  return RADIO_CRANK_AXLE[1] - RADIO_CRANK_ARM;
}
