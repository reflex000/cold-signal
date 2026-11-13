// 'tail_section': the rear 9 m of Flight 417 lying in the ravine, built on the blueprint
// 'tail_section': hull walls slanting from |x| 1.6 at the break (z +4.5) to 0.8 at the closed
// tail (z -4.5), the cargo floor at y 0.30 (wider toward the break), a 0.15 step at the break, and
// the ELT rack standing in its furniture box on the -X wall.
// The cone tapers from the 3.4 m fuselage section to a 1.8 m, slightly squared tail; the fin rises
// 3.9 m over z -4.2 .. -1.2 with its rudder kicked over; the stabilisers are torn off at the root.
// The ELT bay hatch hangs open on the right side. Inside: beige cargo liner, roller tracks,
// tie-down rings, a cargo net half off its hooks, two bags; the pressure bulkhead dome at the back.
// Anchors: everything the blueprint names, plus 'elt' (the beacon unit on the rack).
import { Builder, MAT, PAL, Part, Path, fbm3, hex, mixRGB, type P2, type V3 } from '../kit';
import { register } from '../registry';
import { drift, roomLight, snowHeap, type Aperture } from '../structures/lib';
import { BLUEPRINTS } from '../../world/blueprints';
import { DEG, LIVERY, liveryAt, sat, steps, surface } from './hull';

const Z0 = 4.5, Z1 = -4.5; // break, tail end
/** Section of the cone at z: half width a, half height b, centre c, superellipse exponent n. */
function sec(z: number): { a: number; b: number; c: number; n: number } {
  const t = sat((Z0 - z) / (Z0 - Z1)); // 0 at the break .. 1 at the tail
  return { a: 1.72 - 0.8 * t, b: 1.72 - 0.47 * t, c: 1.2 + 0.05 * t, n: 2 + 0.6 * t };
}
/** A point on the cone at station z, angle a (0 crown), r metres inside. */
function cone(z: number, a: number, r = 0): V3 {
  const s = sec(z);
  const c = Math.cos(a), sn = Math.sin(a);
  const k = Math.pow(Math.pow(Math.abs(c), s.n) + Math.pow(Math.abs(sn), s.n), -1 / s.n);
  return [(s.a - r) * sn * k, s.c + (s.b - r) * c * k, z];
}

register(
  'tail_section',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const bp = BLUEPRINTS.tail_section;
    const S = r.int(0, 1 << 20);
    const AL = 150 * DEG;
    const A = steps(-AL, AL, 30);
    const dent = (z: number, a: number) => 0.01 * fbm3(S, z * 0.9, a * 2.3, 0, 2) - 0.12 * Math.exp(-(((a - 2.2) / 0.25) ** 2)) * sat((z - 1) / 3);
    const zEnd = (a: number) => {
      const n = fbm3(S + 3, Math.cos(a) * 1.4, Math.sin(a) * 1.4, 0, 3);
      let z = Z0 - 0.45 * (n + 0.3) + 0.15 * Math.abs(Math.sin(a * 5.7 + n * 3));
      if (Math.abs(a) < 1.1) z += 0.35 * sat(0.5 + n);
      if (Math.abs(a) > 1.2 && Math.abs(a) < 2.1) z = Math.min(z, Z0 + 0.04);
      if (Math.abs(a) > 2.1) z -= 0.6 * sat((Math.abs(a) - 2.1) / 0.5);
      return z;
    };
    const skin = (z: number, a: number, r0 = 0) => cone(z, a, r0 - dent(z, a));
    const front = (u: number, a: number, r0 = 0): V3 => {
      const ze = zEnd(a);
      const z = ze + (Z0 - 0.9 - ze) * u;
      const k = Math.max(0, 1 - u / 0.5);
      const curl = Math.max(0, fbm3(S + 21, Math.cos(a) * 2.2, Math.sin(a) * 2.2, 1, 2) * 1.5 + 0.1) * k * k;
      return cone(z, a, r0 - dent(z, a) - curl * 0.12);
    };

    // ---- skin: the torn front band, the cone, the tail cap ----
    b.ink({ color: PAL.liveryWhite, mat: MAT.PAINT, wear: 0.5, rough: 0.74, snow: 1 });
    const ur = [0, 0.2, 0.45, 0.72, 1];
    // z falls as u rises here, so the raw parametric normal points in: flip
    const parts: Part[] = [surface(b, ur, A, (u, a) => front(u, a), { flip: true })];
    const rows: number[] = [];
    for (let z = Z0 - 0.9; z > Z1 + 0.01; z -= 0.3) rows.push(z);
    rows.push(Z1);
    // the ELT bay hatch opening on the right side, just aft of the rack
    const hatch = (zm: number, am: number) => zm < -1.6 && zm > -2.5 && am > 1.0 && am < 1.55;
    for (let s0 = 0; s0 < rows.length - 1; s0 += 5) {
      const seg = rows.slice(s0, Math.min(rows.length, s0 + 6));
      parts.push(surface(b, seg, A, (z, a) => skin(z, a), { keep: (i, j) => !hatch((seg[i] + seg[i + 1]) / 2, (A[j] + A[j + 1]) / 2) }));
    }
    // tail cap: the cone closes in a blunt dome behind the last station
    parts.push(surface(b, steps(0, 1, 4), A, (u, a) => {
      const p = cone(Z1, a, -dent(Z1, a));
      const k = Math.cos(u * Math.PI / 2);
      const s = sec(Z1);
      return [p[0] * k, s.c + (p[1] - s.c) * k, Z1 - 0.55 * Math.sin(u * Math.PI / 2)];
    }, { flip: true }));
    for (const p of parts) {
      p.each((v) => {
        const c = liveryAt(v.y + 0.02, 0);
        v.r = c[0]; v.g = c[1]; v.b = c[2];
        const low = sat((0.7 - v.y) / 0.5);
        const n = fbm3(S + 1, v.x * 1.5, v.y * 3, v.z, 3);
        if (low > 0.25 + n * 0.3) {
          v.mat = MAT.METAL;
          const g = mixRGB(PAL.aluminiumDull, PAL.steelDark, 0.3);
          v.r = g[0]; v.g = g[1]; v.b = g[2];
          v.rough = 0.55; v.wear = 0.45;
        } else v.wear = 0.35 + 0.3 * low;
      });
      p.ghost();
    }
    // inside of the skin at the break
    b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.55, snow: 0 });
    surface(b, ur, A, (u, a) => front(u, a, 0.005)).ghost();
    // registration on the flank
    b.ink({ color: LIVERY.navy, mat: MAT.PAINT, wear: 0.5, snow: 1 });
    for (const side of [-1, 1]) {
      const p = cone(0.6, side * 62 * DEG, -0.004);
      const st = b.stencil('C-FKSB', 0.32, { align: 'center', weight: 0.13 });
      // tangent to the hull at 62 degrees from the crown
      st.rotY(side * Math.PI / 2).rotZ(side * 0.49).move(p[0], p[1], p[2]);
    }

    // ---- the fin and the rudder ----
    const finRootZ = -1.2, finRootC = 3.0, finTipC = 1.35, finH = 3.9, sweep = 0.62;
    const airfoil = (s: number, c: number): P2 => {
      // symmetric 12 % section: s 0..1 round the outline from the trailing edge, over the left face
      const u = s < 0.5 ? 1 - s * 2 : (s - 0.5) * 2; // chord fraction
      const th = 0.6 * 0.12 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
      return [s < 0.5 ? -th * c : th * c, -u * c];
    };
    const finS = steps(0, 1, 16);
    const finY0 = 2.35;
    const fin = surface(b, steps(0, 1, 6), finS, (h, s) => {
      const c = finRootC + (finTipC - finRootC) * h;
      const [x, dz] = airfoil(s, c);
      const zl = finRootZ + 0.0 - h * finH * sweep; // leading edge slides back with height
      return [x, finY0 + h * finH, zl + dz * 0.82];
    }, { flip: true });
    b.ink({ color: LIVERY.navy, mat: MAT.PAINT, wear: 0.5, rough: 0.7, snow: 1 });
    fin.paint({ color: LIVERY.navy, mat: MAT.PAINT, rough: 0.7 });
    fin.each((v) => {
      // a white and red band sweeps across the fin
      const band = v.y - finY0 - (v.z - finRootZ) * -0.6;
      if (band > 1.5 && band < 1.8) { v.r = LIVERY.white[0]; v.g = LIVERY.white[1]; v.b = LIVERY.white[2]; }
      else if (band > 1.8 && band < 1.95) { v.r = LIVERY.red[0]; v.g = LIVERY.red[1]; v.b = LIVERY.red[2]; }
      v.wear = 0.45 + 0.3 * sat((v.y - 5.5) / 1);
    });
    fin.ghost();
    // fin tip cap
    b.ink({ color: hex(0x2a2c2f), mat: MAT.PAINT, wear: 0.5, snow: 1 });
    b.box(0.06, 0.08, finTipC * 0.8, { bevel: 0.025 }).move(0, finY0 + finH + 0.03, finRootZ - finH * sweep - finTipC * 0.42);
    // the rudder hinged at 82 % chord, kicked 20 degrees to port
    b.ink({ color: LIVERY.navy, mat: MAT.PAINT, wear: 0.55, rough: 0.7, snow: 1 });
    {
      const rz0 = finRootZ - finRootC * 0.82, rz1 = finRootZ - finH * sweep - finTipC * 0.82;
      const rud = b.box(0.07, finH * 0.92, 0.5, { bevel: 0.02, rows: 3 });
      rud.taper([0.6, 0.7], 1).move(0, 0, -0.25).rotY(-0.35).move(0, finY0 + finH * 0.47, 0);
      rud.warp((q) => { q.z += (rz0 + (rz1 - rz0) * ((q.y - finY0) / finH)); });
    }
    // dorsal fillet blending the fin into the cone
    b.ink({ color: LIVERY.white, mat: MAT.PAINT, wear: 0.5, rough: 0.74, snow: 1 });
    {
      // a wedge from the crown up to the fin's leading edge
      const t = 0.09;
      const P: V3[] = [[-t, 2.62, 1.0], [t, 2.62, 1.0], [-t, 2.5, -1.3], [t, 2.5, -1.3], [-0.03, 3.25, -1.3], [0.03, 3.25, -1.3]];
      b.mesh(P, [[0, 2, 4], [1, 5, 3], [0, 4, 5, 1], [2, 3, 5, 4]]).ghost();
    }
    // the stabilisers: torn off at the root, ragged stubs
    b.ink({ color: LIVERY.white, mat: MAT.PAINT, wear: 0.7, rough: 0.7, snow: 1 });
    for (const side of [-1, 1]) {
      const p = cone(-3.2, side * 95 * DEG);
      const stub = b.box(0.55, 0.16, 1.5, { bevel: 0.02, rows: 2 });
      stub.crumple(0.035, 3.5).move(p[0] + side * 0.22, p[1] - 0.05, -3.2);
      b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.7, snow: 0.7 });
      b.box(0.05, 0.12, 1.2, { bevel: 0.01 }).move(p[0] + side * 0.48, p[1] - 0.05, -3.25);
      b.ink({ color: LIVERY.white, mat: MAT.PAINT, wear: 0.7, rough: 0.7, snow: 1 });
    }

    // ---- break structure: frames, stringers, floor beams ----
    b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.55, rough: 0.6, snow: 0.3 });
    for (const zf of [4.35, 3.85, 3.35]) {
      let a0 = -AL + 0.05;
      while (a0 < AL - 0.1) {
        const a1 = Math.min(AL - 0.05, a0 + r.range(0.6, 2.2));
        if (zf < 4.2 || r.chance(0.6)) {
          const path = steps(a0, a1, Math.max(2, Math.round((a1 - a0) / 0.15))).map((a) => cone(zf, a, 0.045));
          const fr = b.sweep([[-0.04, -0.01], [0.04, -0.01], [0.04, 0.01], [-0.04, 0.01]], path, { up: [0, 0, 1] });
          if (zf > 4.2) fr.crumple(0.05, 1.5);
        }
        a0 = a1 + (zf > 4.2 ? r.range(0.15, 0.6) : r.range(0.02, 0.15));
      }
    }
    b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.4, rough: 0.5, snow: 0.3 });
    for (let a = -AL + 0.12; a < AL - 0.1; a += 0.24 + r.range(-0.03, 0.03)) {
      const ze = zEnd(a) + r.range(-0.05, 0.25);
      const p0 = cone(3.2, a, 0.02), p1 = cone(ze, a, 0.02 + r.range(-0.03, 0.05));
      b.box(0.012, Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]), 0.022, { bevel: 0.002, rows: 3 }).bend(r.range(-0.4, 0.4), 'z').span(p0, p1);
    }

    // ---- cargo hold ----
    const FY = 0.3;
    b.ink({ color: hex(0x55575a), mat: MAT.PLASTIC, wear: 0.55, rough: 0.8, snow: 0 });
    {
      // the cargo floor: the blueprint's two rectangles, clipped to the cone's inside at floor level
      const half = (z: number) => {
        let lo = 0, hi = 2;
        for (let i = 0; i < 24; i++) {
          const m = (lo + hi) / 2;
          const q = sec(z);
          const ax = m / q.a, ay = (FY - q.c) / q.b;
          if (Math.pow(Math.abs(ax), q.n) + Math.pow(Math.abs(ay), q.n) < 1) lo = m; else hi = m;
        }
        const wide = z > 0.3 ? 1.32 : 0.95;
        return Math.min(wide, lo - 0.08);
      };
      const zs = [-4.4, -3.6, -2.8, -2.0, -1.2, -0.4, 0.3, 0.30001, 1.2, 2.2, 3.7];
      const poly: P2[] = [...zs.map((z) => [half(z), z] as P2), ...zs.slice().reverse().map((z) => [-half(z), z] as P2)];
      b.extrude(poly, 0.05, { bevel: 0.006 }).move(0, FY - 0.025, 0);
    }
    const step = bp.floors.find((f) => f.tag === 'step')!;
    b.ink({ color: hex(0x4b4d50), mat: MAT.PLASTIC, wear: 0.6, rough: 0.8, snow: 0.3 });
    const st = b.box(step.hx * 2, 0.04, step.hz * 2, { bevel: 0.006, rows: 1 }).move(step.x, step.y - 0.02, step.z);
    st.warp((q) => { if (q.z > 4.3) q.z = Math.min(q.z, 4.3 + 0.25 * sat(0.5 + fbm3(S + 31, q.x * 2.5, 0, 0, 2))); });
    // roller tracks and tie-down rings
    b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.45, rough: 0.45, snow: 0 });
    for (const x of [-0.45, 0.45]) b.box(0.05, 0.015, 7.6, { bevel: 0.003 }).move(x, FY + 0.008, -0.6);
    for (let z = -3.8; z < 3.4; z += 0.6) for (const x of [-0.45, 0.45]) b.cyl(0.012, 0.02, { sides: 6 }).move(x, FY + 0.02, z);
    for (let z = -3.6; z < 3.4; z += 1.0) for (const x of [-0.75, 0.75]) b.torus(0.03, 0.006, { segs: 8, sides: 4 }).rotX(Math.PI / 2 - 0.4).move(x, FY + 0.03, z);
    // liner: beige panels on the walls and ceiling, the cone narrowing to the bulkhead
    b.ink({ color: hex(0x9c9481), mat: MAT.PLASTIC, wear: 0.4, rough: 0.6, snow: 0 });
    const LAng = steps(-118 * DEG, 118 * DEG, 18);
    for (let z = 3.3; z > -4.3; z -= 1.9) {
      const zz = steps(Math.max(-4.3, z - 1.9), z, 4);
      surface(b, zz, LAng, (zq, a) => {
        const p = cone(zq, a, 0.09);
        return [p[0], Math.max(FY + 0.01, p[1]), p[2]];
      }, { flip: true }).ghost();
    }
    // the aft pressure bulkhead: a shallow dome behind the floor
    b.ink({ color: hex(0x6b6455), mat: MAT.PAINT, wear: 0.5, snow: 0 });
    {
      const s = sec(Z1 + 0.15);
      const dome = b.lathe([[0, 0.25], [0.5, 0.2], [0.85, 0.08], [1, 0]], { sides: 18, smooth: true });
      // convex toward the tail, the dish facing the hold
      dome.rotX(-Math.PI / 2).scale(s.a - 0.1, s.b - 0.1, 1).move(0, s.c, Z1 + 0.12).flip();
    }
    // the ELT rack in its box, the beacon unit on it, cables
    {
      const rb = bp.boxes.find((x) => x.tag === 'elt rack')!;
      b.group(() => {
        b.ink({ color: hex(0x3b3e40), mat: MAT.PAINT, wear: 0.5, snow: 0 });
        // a little shallower than its box: the cone wall leans in at the foot
        const hx = rb.hx - 0.04;
        for (const y of [0.55, 0.95, 1.35]) b.box(hx * 2, 0.025, rb.hz * 2, { bevel: 0.004 }).move(0.04, y - FY + 0.0, 0);
        for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(0.03, 1.2, 0.03, { bevel: 0.004 }).move(0.04 + dx * (hx - 0.02), 0.6, dz * (rb.hz - 0.02));
        b.ink({ color: hex(0xc2531f), mat: MAT.PAINT, wear: 0.45, snow: 0 });
        b.box(0.18, 0.12, 0.32, { bevel: 0.012 }).move(0.0, 1.35 - FY + 0.075, 0.05);
        b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.4, snow: 0 });
        b.cyl(0.006, 0.25, { sides: 5 }).move(0.0, 1.35 - FY + 0.25, -0.05);
      }).rotY(rb.yaw).move(rb.x, FY, rb.z);
      b.anchor('elt', [rb.x, 1.45, rb.z], rb.yaw + Math.PI / 2);
    }
    // the ELT bay hatch, hanging open outside on its lower hinge
    b.ink({ color: LIVERY.white, mat: MAT.PAINT, wear: 0.55, rough: 0.7, snow: 1 });
    {
      const p = cone(-2.05, 1.0);
      const h = b.box(0.02, 0.6, 0.85, { bevel: 0.006 });
      h.move(0, -0.3, 0).rotZ(-2.4).move(p[0] + 0.02, p[1], -2.05);
    }
    // a cargo net half off its hooks, two bags
    b.ink({ color: hex(0x2f3a2e), mat: MAT.CLOTH, wear: 0.5, snow: 0 });
    {
      const net = b.cloth(1.8, 1.3, { nx: 9, ny: 7, billow: 0.12, wrinkle: 0.05, tear: 0.4, thickness: 0.01 });
      net.rotY(Math.PI / 2 + 0.15).move(1.05, 2.0, 0.5).sway([1.05, 2.0, 0.5], 0.3).ghost();
    }
    b.ink({ color: PAL.nylonNavy, mat: MAT.CLOTH, wear: 0.5, snow: 0 });
    b.pillow(0.7, 0.32, 0.45, { round: 0.1, bulge: 0.05, seg: 1, ring: 1 }).rotY(0.4).move(0.55, FY + 0.16, -3.3);
    b.ink({ color: hex(0x4a3324), mat: MAT.CLOTH, wear: 0.5, snow: 0 });
    b.pillow(0.6, 0.28, 0.4, { round: 0.09, bulge: 0.04, seg: 1, ring: 1 }).rotY(-0.3).rotZ(0.2).move(-0.3, FY + 0.15, -3.9);

    // ---- snow: in through the break, banked outside ----
    snowHeap(b, [0.2, 0, 4.85], 1.6, 0.22, 0.7, 0.1);
    drift(b, [[0.4, FY - 0.08, 3.8], [0.1, FY - 0.09, 2.9], [-0.2, FY - 0.1, 2.0]], 1.4, 0.1, { noise: 0.015 });
    drift(b, [[-1.95, 0, 4.2], [-1.75, 0, 0], [-1.25, 0, -4.4]], 1.4, 0.5, { lee: -0.5 });
    drift(b, [[1.95, 0, 4.0], [1.7, 0, 0.5], [1.2, 0, -4.2]], 1.2, 0.4, { lee: 0.5 });
    snowHeap(b, [0, 0, -5.2], 1.1, 0.45, 0.8);

    // ---- light inside ----
    const aps: Aperture[] = [
      { c: [0, 1.3, 4.6], n: [0, 0, -1], area: 7.5 },
      { c: cone(-2.05, 1.27, 0.05), n: [-0.95, -0.3, 0], area: 0.5, gain: 0.8 },
    ];
    roomLight(b, (x, y, z, nx, ny, nz) => {
      if (z > 5.2 || z < -5.2 || y < 0.05) return false;
      const s = sec(z);
      const dx = x / s.a, dy = (y - s.c) / s.b;
      const rr = Math.pow(Math.pow(Math.abs(dx), s.n) + Math.pow(Math.abs(dy), s.n), 1 / s.n);
      if (rr < 0.96) return true;
      return rr < 1.01 && nx * dx + ny * dy < -0.2;
    }, aps, { base: 0.17, gain: 3.4 });

    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    void Path;
    return b.build({ ground: true, aoRadius: 0.18 });
  },
  { variants: 1, size: 'structure', desc: 'Flight 417: the tail section in the ravine, fin and ELT bay (blueprint tail_section)', tags: ['wreck'] },
);
