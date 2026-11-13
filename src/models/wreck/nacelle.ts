// 'engine_nacelle': a turboprop engine torn off the wing, lying on its side in the snow inside
// its blueprint box (1.9 x 1.9 x 3.4 m, axis along local Z, spinner toward +Z).
// The cowling (grey, sooted round the exhaust stubs) is crushed where it hit; the chin intake
// gapes; the rear end is torn off at the firewall, showing the engine core, the mount struts and
// cut lines. The four-blade propeller curled back over the cowling as it struck the ground, the
// tips painted; variant 1 lost two blades at the hub and is more crushed.
// Anchors: intake (blueprint), hub.
import { Builder, MAT, PAL, Path, fbm3, hex, mixRGB, type P2, type V3 } from '../kit';
import { register } from '../registry';
import { drift, snowHeap } from '../structures/lib';
import { BLUEPRINTS } from '../../world/blueprints';

register(
  'engine_nacelle',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 1;
    const bp = BLUEPRINTS.engine_nacelle;
    const S = r.int(0, 1 << 20);
    const roll = 1.25 + r.range(-0.1, 0.1); // lying on its side
    const CY = 0.62; // axis height (the cowling is half sunk)
    const body = b.group(() => {
      // cowling: a lathe along +Y, turned to +Z below
      const prof: P2[] = [[0, 1.62], [0.12, 1.6], [0.26, 1.5], [0.33, 1.38], [0.36, 1.3], [0.5, 1.22], [0.55, 1.0], [0.56, 0.6], [0.54, 0.1], [0.5, -0.5], [0.44, -1.1], [0.42, -1.45]];
      b.ink({ color: PAL.liveryGrey, mat: MAT.PAINT, wear: 0.6, rough: 0.7, snow: 1 });
      // lathe profiles run bottom to top (outside on the right)
      const cowl = b.lathe(prof.slice(4).reverse(), { sides: 20, smooth: true });
      cowl.crumple(0.03, 2.4).dent([0.55, 0.3, 0], 0.5, v ? 0.2 : 0.12, [-1, 0, 0]);
      cowl.each((q) => {
        // soot streaming back from the exhaust stubs
        const a = Math.atan2(q.z, q.x);
        const s = Math.max(0, Math.abs(Math.cos(a)) * 1.6 - 0.9) * Math.max(0, Math.min(1, (0.05 - q.y) / 0.6));
        const k = 1 - 0.85 * Math.min(1, s);
        q.r *= k; q.g *= k; q.b *= k;
        q.wear = 0.5 + 0.3 * Math.max(0, fbm3(S, q.x * 3, q.y * 3, q.z * 3, 2));
      });
      cowl.ghost();
      // spinner
      b.ink({ color: hex(0x1f2328), mat: MAT.PAINT, wear: 0.5, rough: 0.5, snow: 1 });
      b.lathe(prof.slice(0, 5).reverse(), { sides: 16, smooth: true }).ghost();
      // chin intake under the spinner
      b.ink({ color: PAL.liveryGrey, mat: MAT.PAINT, wear: 0.6, rough: 0.7, snow: 1 });
      const scoop = b.box(0.42, 0.7, 0.26, { bevel: 0.08, rows: 3 });
      scoop.taper([0.8, 0.7], 1).move(0, 0.95, -0.55);
      b.ink({ color: hex(0x101112), mat: MAT.PAINT, wear: 0.3, snow: 0 });
      b.box(0.3, 0.02, 0.14, { bevel: 0.02 }).move(0, 1.31, -0.56);
      // exhaust stubs either side
      b.ink({ color: hex(0x2a2522), mat: MAT.METAL, wear: 1.2, rough: 0.8, snow: 0.6 });
      for (const sx of [-1, 1]) b.cyl(0.11, 0.35, { sides: 10, r2: 0.13 }).rotX(-0.9).move(sx * 0.53, 0.05, -0.05);
      // the torn rear: firewall, core, mounts, cut lines
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.7, rough: 0.6, snow: 0.6 });
      b.cyl(0.28, 0.5, { sides: 12 }).move(0, -1.65, 0);
      b.ink({ color: hex(0x5a5a52), mat: MAT.PAINT, wear: 0.8, snow: 0.7 });
      b.cyl(0.43, 0.03, { sides: 16 }).crumple(0.04, 3).move(0, -1.46, 0);
      b.ink({ color: PAL.steel, mat: MAT.METAL, wear: 0.9, snow: 0.6 });
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.6;
        const p0: V3 = [Math.cos(a) * 0.36, -1.45, Math.sin(a) * 0.36];
        const p1: V3 = [Math.cos(a) * r.range(0.5, 0.7), -1.45 - r.range(0.35, 0.6), Math.sin(a) * r.range(0.5, 0.7)];
        b.cyl(0.022, 1, { sides: 6 }).scale(1, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), 1).span(p0, p1);
      }
      b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.4, snow: 0.4 });
      for (let k = 0; k < 5; k++) {
        const a = r.range(0, 6.28);
        const p0: V3 = [Math.cos(a) * 0.25, -1.5, Math.sin(a) * 0.25];
        const p1: V3 = [Math.cos(a) * 0.5 + r.range(-0.2, 0.2), -1.9 - r.range(0, 0.25), Math.sin(a) * 0.5];
        b.pipe(Path.spline([p0, [(p0[0] + p1[0]) / 2, -1.75, (p0[2] + p1[2]) / 2 + 0.05], p1], 3), r.range(0.008, 0.018), { sides: 5 }).ghost();
      }
      // the propeller: four blades curled back over the cowling, painted tips
      const blades = v === 1 ? [0, 2] : [0, 1, 2, 3];
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + r.range(-0.08, 0.08);
        const whole = blades.includes(k);
        const L = whole ? 1.75 : r.range(0.22, 0.4);
        b.ink({ color: hex(0x1b1c1e), mat: MAT.PAINT, wear: 0.55, rough: 0.6, snow: 1 });
        const bl = b.box(0.3, L, 0.035, { bevel: 0.01, rows: whole ? 10 : 2 });
        bl.taper([0.42, 0.7], 1).twist(0.5).move(0, L / 2 + 0.3, 0);
        if (whole) {
          bl.each((q) => {
            if (q.y > 0.3 + L - 0.16) { q.r = 0.55; q.g = 0.42; q.b = 0.06; }
          });
          // curled back (toward -Y here, the nacelle's tail) from near the root
          bl.bend(1.9 + r.range(0, 0.5), 'x', 0.08);
        }
        // turn the blade to its place round the hub: radial in XZ, the bend toward -Y
        bl.rotX(Math.PI / 2).rotY(a).move(0, 1.42, 0);
      }
      b.anchor('hub', [0, 1.45, 0]);
    });
    // lie it along +Z, rolled onto its side, the axis at CY
    body.rotX(Math.PI / 2).rotZ(roll).move(0, CY, 0.1);
    // snow piled against it
    drift(b, [[-1.0, 0, 1.5], [-1.1, 0, 0], [-0.95, 0, -1.6]], 1.0, 0.45, { lee: 0.5 });
    snowHeap(b, [0.6, 0, -1.9], 0.7, 0.3, 0.5);
    void mixRGB;
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    return b.build({ ground: true });
  },
  { variants: 2, size: 'structure', desc: 'a turboprop nacelle torn from the wing, propeller blades curled back (blueprint engine_nacelle)', tags: ['wreck'] },
);
