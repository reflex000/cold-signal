// 'flaregun': an orange 12-gauge flare pistol, moulded plastic. Model space (see common.ts): the
// barrel points forward (-Z), the grip hangs below; the origin is the right fist on the grip (the
// grip axis passes through it, raked 17 degrees). Break-open: the barrel tips muzzle-down about a
// hinge pin at the front of the frame to show the chamber; an exposed hammer at the back; a big
// moulded trigger guard for gloved hands; a lanyard ring under the grip; SIGNAL ONLY on the barrel.
// Named parts (hand pose): barrel (pivot = hinge, axis +X, opens with a negative angle), hammer
// (pivot = its pin, axis +X, cocked back with a positive angle), trigger.
// Anchors: gripR (origin), gripL (round the barrel), muzzle, breech, hinge.
import { Builder, MAT, PAL, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';
import { gripAnchor, layDown, toolCtx } from './common';

export const FLARE_BORE_Y = 0.08;
export const FLARE_MUZZLE_Z = -0.158;
export const FLARE_BREECH_Z = -0.006;
export const FLARE_HINGE: V3 = [0, 0.054, -0.044];
export const FLARE_HAMMER: V3 = [0, 0.084, 0.0175];

register(
  'flaregun',
  (seed, opts) => {
    const b = new Builder(seed);
    const c = toolCtx(b, opts);
    const sides = c.sides(18);
    const Y = FLARE_BORE_Y;
    const orange = mixRGB(PAL.orange, hex(0xc85a22), 0.25);
    const g = b.group(() => {
      // ---------------- frame and grip ----------------
      b.ink({ color: orange, mat: MAT.PLASTIC, wear: 0.5, snow: 0.6, rough: 0.55, vary: 0.02 });
      // the receiver block round the breech
      b.pillow(0.034, 0.05, 0.072, { round: 0.009, bulge: 0.0012, seg: 2, ring: c.lod === 0 ? 2 : 1 }).move(0, 0.071, -0.014);
      // the grip, raked back at the bottom, a palm swell on the right
      const grip = b.pillow(0.031, 0.118, 0.046, { round: 0.0125, bulge: 0.0018, seg: c.lod === 0 ? 3 : 1, ring: c.lod === 0 ? 2 : 1 });
      grip.warp((p) => {
        const t = (p.y + 0.059) / 0.118; // 0 bottom .. 1 top
        p.z *= 0.92 + 0.12 * Math.sin(t * Math.PI); // fuller in the middle
        if (p.x > 0) p.x *= 1 + 0.08 * Math.sin(t * Math.PI);
      });
      grip.rotX(-0.292).move(0, -0.006, 0.0035);
      // flat butt with a lanyard ring
      b.ink({ color: mixRGB(orange, PAL.plasticBlack, 0.15), mat: MAT.PLASTIC, wear: 0.6, snow: 0.6 });
      b.box(0.029, 0.006, 0.042, { bevel: 0.0025 }).rotX(-0.292).move(0, -0.063, 0.0205);
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.5, snow: 0.5 });
      b.torus(0.0075, 0.0016, { sides: 5, segs: c.sides(12) }).rotZ(Math.PI / 2).move(0, -0.072, 0.03);
      // grip panels: a coarse moulded texture
      if (c.lod === 0) {
        b.ink({ color: mixRGB(orange, PAL.plasticBlack, 0.35), mat: MAT.PLASTIC, wear: 0.7, snow: 0.5, rough: 0.82 });
        for (const s of [-1, 1]) {
          const panel = b.pillow(0.004, 0.07, 0.03, { round: 0.0018, seg: 2, ring: 1 });
          panel.rotX(-0.292).move(s * 0.0156, -0.008, 0.006);
        }
      }
      // trigger guard, big enough for a mitt
      b.ink({ color: orange, mat: MAT.PLASTIC, wear: 0.6, snow: 0.6, rough: 0.55 });
      b.strap([[0, 0.05, -0.05], [0, 0.03, -0.056], [0, 0.013, -0.05], [0, 0.007, -0.036], [0, 0.009, -0.024], [0, 0.016, -0.017]], 0.009, 0.0048, { up: [1, 0, 0] });
      // the release latch on top of the frame
      b.ink({ color: hex(0x1a1a1b), mat: MAT.PLASTIC, wear: 0.5, snow: 0.6 });
      b.box(0.012, 0.005, 0.016, { bevel: 0.0018 }).move(0, 0.0975, 0.006);

      // ---------------- hammer ----------------
      c.part('hammer', FLARE_HAMMER, () => {
        b.ink({ color: hex(0x222224), mat: MAT.PLASTIC, wear: 0.55, snow: 0.5, rough: 0.5 });
        b.box(0.011, 0.024, 0.012, { bevel: 0.003 }).rotX(-0.35).move(0, 0.093, 0.023);
        const spur = b.box(0.013, 0.006, 0.014, { bevel: 0.0022 });
        spur.rotX(-0.5).move(0, 0.105, 0.031);
        if (c.lod === 0) for (let i = 0; i < 3; i++) b.box(0.0135, 0.0012, 0.002, { bevel: 0.0004 }).rotX(-0.5).move(0, 0.1083, 0.0275 + i * 0.0035);
      });
      // ---------------- trigger ----------------
      c.part('trigger', [0, 0.04, -0.034], () => {
        b.ink({ color: hex(0x222224), mat: MAT.PLASTIC, wear: 0.5, snow: 0.5 });
        const tr = b.box(0.007, 0.024, 0.006, { bevel: 0.002, rows: 3 });
        tr.bend(-0.6, 'x').move(0, 0.03, -0.035);
      });

      // ---------------- barrel (tips down about the hinge) ----------------
      c.part('barrel', FLARE_HINGE, () => {
        b.ink({ color: orange, mat: MAT.PLASTIC, wear: 0.45, snow: 0.6, rough: 0.5 });
        const len = FLARE_BREECH_Z - FLARE_MUZZLE_Z;
        const zc = (FLARE_BREECH_Z + FLARE_MUZZLE_Z) / 2;
        const bar = b.cyl(0.0152, len, { sides, bevel: 0.0025, rows: 2 });
        bar.rotX(Math.PI / 2).move(0, Y, zc);
        // muzzle reinforcement, breech ring
        b.cyl(0.0172, 0.013, { sides, bevel: 0.003 }).rotX(Math.PI / 2).move(0, Y, FLARE_MUZZLE_Z + 0.0068);
        b.cyl(0.0164, 0.008, { sides, bevel: 0.0024 }).rotX(Math.PI / 2).move(0, Y, FLARE_BREECH_Z - 0.006);
        // hinge lug under the barrel
        b.pillow(0.022, 0.022, 0.026, { round: 0.006, seg: 1, ring: 1 }).move(0, 0.062, -0.042);
        b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.4, snow: 0.4 });
        b.cyl(0.0035, 0.024, { sides: 8, bevel: 0.0008 }).rotZ(Math.PI / 2).move(FLARE_HINGE[0], FLARE_HINGE[1], FLARE_HINGE[2]);
        // the bore, black, and the chamber mouth at the breech
        b.ink({ color: hex(0x0d0d0e), mat: MAT.PLASTIC, wear: 0.2, snow: 0, rough: 0.6 });
        b.cyl(0.0095, 0.0008, { sides, bevel: 0.0002 }).rotX(Math.PI / 2).move(0, Y, FLARE_MUZZLE_Z - 0.0003);
        b.cyl(0.0105, 0.0008, { sides, bevel: 0.0002 }).rotX(Math.PI / 2).move(0, Y, FLARE_BREECH_Z + 0.0003);
        // lettering on both sides of the barrel
        if (c.lod === 0) {
          b.ink({ color: hex(0x151515), mat: MAT.PLASTIC, wear: 0.65, snow: 0.3 });
          for (const s of [-1, 1]) {
            const t1 = b.stencil('SIGNAL ONLY', 0.0042, { weight: 0.16, align: 'center' });
            t1.rotY((s * Math.PI) / 2).move(s * 0.0158, Y - 0.0021, -0.075);
            const t2 = b.stencil('12 GA', 0.0042, { weight: 0.16, align: 'center' });
            t2.rotY((s * Math.PI) / 2).move(s * 0.0158, Y - 0.0021, -0.124);
          }
        }
      });
    });

    if (c.pose === 'ground') layDown(g, 0, 0.8, Math.PI / 2);
    else {
      gripAnchor(b, 'gripR', [0, 0, 0], [0, -0.2881, -0.9576], [0, 0.9576, -0.2881]);
      gripAnchor(b, 'gripL', [0, Y - 0.004, -0.11], [1, 0, 0], [0, 0, -1]);
      b.anchor('muzzle', [0, Y, FLARE_MUZZLE_Z]);
      b.anchor('breech', [0, Y, FLARE_BREECH_Z]);
      b.anchor('hinge', FLARE_HINGE);
    }
    return b.build({ ao: 0.9, ground: c.pose === 'ground', aoRadius: 0.02 });
  },
  { variants: 1, size: 'item', desc: 'orange 12 gauge flare pistol', tags: ['tool', 'pickup'] },
);
