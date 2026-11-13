// 'flashlight': a heavy two-cell rubber flashlight, 23 cm. Model space (see common.ts): the body runs
// along Z with the lamp forward (-Z); the origin is the right fist round the body. Black rubber
// armour with grip rings, a flared rubber head and bezel, a rubber-capped push switch on top
// under the thumb, a screw tail cap with a lanyard loop. Behind the clear lens: a chrome reflector
// and the bulb (named part 'lamp': the first-person view makes it glow with the beam).
// Named parts (hand pose): lamp (pivot at the bulb), cap (pivot on the tail).
// Anchors: gripR (origin), gripL (the tail cap, for changing the cell), lamp, tail, switch.
import { Builder, MAT, hex, type P2 } from '../kit';
import { register } from '../registry';
import { gripAnchor, layDown, toolCtx } from './common';

/** Model-space z of the lens face and of the tail end. */
export const FLASH_LENS_Z = -0.1465;
export const FLASH_TAIL_Z = 0.0865;

register(
  'flashlight',
  (seed, opts) => {
    const b = new Builder(seed);
    const c = toolCtx(b, opts);
    const sides = c.sides(18);
    // everything is made along +Y (lamp up) and turned so +Y becomes -Z: (x, y, z) -> (x, z, -y)
    const toModel = (y: number) => -y;
    const g = b.group(() => {
      // ---------------- body and head ----------------
      const rubber = hex(0x2d2f32);
      b.ink({ color: rubber, mat: MAT.RUBBER, wear: 0.5, snow: 0.5, vary: 0.02 });
      const prof: P2[] = [[0.0198, -0.0625], [0.0214, -0.0618], [0.022, -0.06]];
      for (let i = 0; i < 7; i++) {
        const yc = -0.046 + i * 0.0165;
        prof.push([0.022, yc - 0.0045], [0.0231, yc - 0.0027], [0.0234, yc], [0.0231, yc + 0.0027], [0.022, yc + 0.0045]);
      }
      prof.push([0.022, 0.07], [0.0226, 0.084], [0.0248, 0.094], [0.0282, 0.107], [0.0314, 0.12], [0.0334, 0.129]);
      // the rubber bezel with its rounded lip, turning in to the lens
      prof.push([0.0346, 0.1315], [0.0351, 0.1385], [0.0346, 0.1438], [0.0328, 0.1462], [0.0302, 0.1466], [0.0291, 0.1452], [0.0289, 0.143]);
      const body = b.lathe(prof, { sides, smooth: true });
      body.each((v) => {
        // scuffed paler on the rings and the bezel lip where it has been knocked about
        const lip = v.y > 0.13 ? 0.25 : 0;
        v.wear = 0.4 + lip + (Math.hypot(v.x, v.z) > 0.0229 ? 0.25 : 0);
      });
      if (c.lod === 0) {
        // anti-roll fins on the head
        b.ink({ color: hex(0x232427), mat: MAT.RUBBER, wear: 0.55, snow: 0.5 });
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
          const fin = b.box(0.004, 0.034, 0.005, { bevel: 0.0015 });
          fin.rotX(0.24).move(0, 0.108, 0.03).rotY(a);
        }
      }
      // the battery tube's mouth under the tail cap (seen while the cell is changed)
      b.ink({ color: hex(0x0c0c0d), mat: MAT.RUBBER, wear: 0.2, snow: 0 });
      b.cyl(0.0196, 0.002, { sides, bevel: 0.0004 }).move(0, -0.058, 0);
      // ---------------- switch on top, under the thumb ----------------
      b.ink({ color: hex(0x18191a), mat: MAT.RUBBER, wear: 0.45, snow: 0.5 });
      b.pillow(0.017, 0.026, 0.008, { round: 0.003, seg: 1, ring: 1 }).move(0, 0.06, 0.0226);
      b.ink({ color: hex(0x3a3b3e), mat: MAT.RUBBER, wear: 0.65, snow: 0.4 });
      b.dome(0.0058, 0.0032, c.sides(10)).rotX(Math.PI / 2).move(0, 0.06, 0.0264);

      // ---------------- the lamp: reflector bowl and bulb ----------------
      const em = c.pose === 'hand' ? (c.lod === 0 ? 1 : 0.35) : 0;
      c.part('lamp', [0, 0, toModel(0.127)], () => {
        b.ink({ color: hex(0xd6d8da), mat: MAT.METAL, rough: 0.1, wear: 0.08, snow: 0, emissive: em });
        const bowl = b.lathe([[0.0289, 0.1432], [0.0236, 0.1375], [0.0178, 0.1318], [0.0118, 0.1268], [0.0066, 0.1232], [0.0042, 0.1226]], { sides, smooth: true });
        bowl.each((v) => {
          // the reflector is lit by the bulb: brightest near it
          const rr = Math.hypot(v.x, v.z);
          v.emissive = em * (0.3 + 0.7 * Math.max(0, 1 - rr / 0.03));
        });
        b.ink({ color: hex(0xfff1d0), mat: MAT.EMISSIVE, snow: 0, emissive: em * 3 });
        b.sphere(0.0047, { sides: c.sides(10), rings: c.lod === 0 ? 6 : 4 }).move(0, 0.1272, 0);
        b.ink({ color: hex(0x2b2b2b), mat: MAT.METAL, rough: 0.4, snow: 0, emissive: 0 });
        b.cyl(0.0046, 0.006, { sides: c.sides(10), bevel: 0.0008 }).move(0, 0.1222, 0);
      });

      // ---------------- tail cap with the lanyard loop ----------------
      c.part('cap', [0, 0, toModel(-0.074)], () => {
        b.ink({ color: hex(0x202123), mat: MAT.RUBBER, wear: 0.55, snow: 0.5 });
        b.lathe([[0, -0.0865], [0.011, -0.0862], [0.0185, -0.0848], [0.0221, -0.0815], [0.0229, -0.077], [0.0229, -0.0655], [0.0216, -0.0618], [0.02, -0.0612]], { sides, smooth: true });
        // knurled grip on the cap
        if (c.lod === 0) {
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            b.box(0.0022, 0.011, 0.0018, { bevel: 0.0006 }).move(0, -0.0715, 0.0231).rotY(a);
          }
        }
        b.ink({ color: hex(0x151516), mat: MAT.RUBBER, wear: 0.5, snow: 0.5 });
        b.torus(0.0058, 0.0019, { sides: 5, segs: c.sides(10) }).rotZ(Math.PI / 2).move(0, -0.0875, 0.014);
      });
    });
    // made with the lamp along +Y: turn it to point forward (-Z), the switch up (+Y)
    g.rotX(-Math.PI / 2);

    if (c.pose === 'ground') layDown(g, 0, 0.6, 0.5);
    else {
      gripAnchor(b, 'gripR', [0, 0, 0], [0.35, 0.94, 0], [0, 0, -1]);
      gripAnchor(b, 'gripL', [0.0, 0.0, 0.074], [-0.9, 0.3, 0.2], [0, 0, 1]);
      b.anchor('lamp', [0, 0, FLASH_LENS_Z - 0.002]);
      b.anchor('tail', [0, 0, FLASH_TAIL_Z]);
      b.anchor('switch', [0, 0.027, -0.06]);
    }
    return b.build({ ao: 0.9, ground: c.pose === 'ground', aoRadius: 0.02 });
  },
  { variants: 1, size: 'item', desc: 'heavy rubber flashlight', tags: ['tool', 'pickup'] },
);
