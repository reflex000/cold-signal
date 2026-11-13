// 'wing': 9 m of a torn-off wing lying in the snow (blueprint 'wing': local X spans the root at
// -4.5 to the tip at +4.5, the chord runs along Z with the leading edge at +Z, and the upper skin
// is a walkable floor at y 0.45).
// Variant 0 (seed even): the right wing, right side up, its root against the fuselage under the
// over-wing exit; 'NO STEP' on the flap, the green navigation light at the tip.
// Variant 1 (seed odd): the left wing, thrown upside down along the skid scar: the flatter lower
// skin faces the sky, the flap-track fairings and the torn engine mounting stand up out of it, the
// leading and trailing edges float over snow drifted underneath; red navigation light.
// Both: a NACA 4415 section tapering 2.6 -> 2.25 m, black de-icing boot on the leading edge, the
// flap and aileron hinge lines, a ragged root showing both spars, ribs and dangling lines.
import { Builder, MAT, PAL, Path, fbm3, hex, mixRGB, type V3 } from '../kit';
import { register } from '../registry';
import { drift, icicles } from '../structures/lib';
import { BLUEPRINTS } from '../../world/blueprints';
import { LIVERY, sat, steps, surface } from './hull';

/** NACA 4415 at chord fraction u (0 leading edge .. 1 trailing edge): [upper, lower] in chords. */
function naca(u: number): [number, number] {
  const m = 0.04, p = 0.4, t = 0.15;
  const yt = 5 * t * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
  const yc = u < p ? (m / (p * p)) * (2 * p * u - u * u) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * u - u * u);
  return [yc + yt, yc - yt];
}

register(
  'wing',
  (seed) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 1;
    const flip = v === 1;
    const bp = BLUEPRINTS.wing;
    const S = r.int(0, 1 << 20);
    const X0 = -4.5, X1 = 4.5;
    const chord = (x: number) => 2.6 - 0.35 * sat((x - X0) / (X1 - X0));
    const TOP = bp.floors[0].y; // 0.45
    // base height so the walkable skin's highest line is at TOP
    const base = flip ? TOP - 0.045 * 2.6 : TOP - 0.117 * 2.6;
    // s 0..1 round the section: upper skin from the trailing edge to the leading edge, then the lower
    const sec = (x: number, s: number): V3 => {
      const c = chord(x);
      const u = s < 0.5 ? 1 - s * 2 : (s - 0.5) * 2;
      const [yu, yl] = naca(Math.max(0, Math.min(1, u)));
      let y = (s < 0.5 ? yu : yl) * c;
      if (flip) y = -y;
      // the wing is bent where it hit: a long gentle warp and a crumpled leading edge
      const bend = 0.06 * Math.sin((x + 4.5) * 0.45) + (flip ? 0.03 : 0);
      const dent = u < 0.12 ? -0.05 * sat(fbm3(S, x * 0.9, 0, 0, 2) + 0.2) * (1 - u / 0.12) : 0;
      return [x, base + y + bend, c * 0.5 - u * c - dent];
    };
    // the torn root: x of the edge depends on where round the section you are
    const xRoot = (s: number) => X0 + 0.18 + 0.22 * (fbm3(S + 2, s * 6, 0, 0, 2) + 0.5) + 0.12 * Math.abs(Math.sin(s * 23));
    const map = (u: number, s: number): V3 => {
      const xr = xRoot(s);
      return sec(xr + (X1 - xr) * u, s);
    };
    const US = [0, 0.03, 0.08, 0.16, 0.26, 0.38, 0.5, 0.62, 0.74, 0.86, 0.95, 1];
    const SS = [...steps(0, 0.36, 6), ...steps(0.4, 0.6, 8).slice(0), ...steps(0.64, 1, 6)];
    const sSorted = [...new Set(SS.map((q) => Math.round(q * 1e5) / 1e5))].sort((a, c) => a - c);
    // the skin
    const up = flip ? LIVERY.belly : PAL.liveryGrey;
    b.ink({ color: up, mat: MAT.PAINT, wear: 0.5, rough: 0.72, snow: 1 });
    // mirrored (upside down) the parametric normal already points out
    const skin = surface(b, US, sSorted, map, { flip: !flip });
    skin.each((q) => {
      const upper = flip ? q.ny < 0 : q.ny > 0;
      const c = upper ? PAL.liveryGrey : LIVERY.belly;
      const k = 1 + 0.06 * fbm3(S + 5, q.x * 0.7, q.z * 0.7, 0, 2);
      q.r = c[0] * k; q.g = c[1] * k; q.b = c[2] * k;
      q.wear = 0.4 + 0.3 * sat(fbm3(S + 6, q.x * 2, q.z * 2, 1, 2) + 0.3);
    });
    skin.ghost();
    // hinge lines of the flap (root .. 0.5) and the aileron (0.5 .. tip): dark gaps at 75 % chord
    b.ink({ color: hex(0x18191a), mat: MAT.RUBBER, wear: 0.3, snow: 0.6 });
    for (const [x0, x1] of [[X0 + 0.5, 0.4], [0.6, X1 - 0.25]] as [number, number][]) {
      const s = flip ? 0.875 : 0.125; // the visible (up-facing) skin at 75 % chord
      const pts = steps(x0, x1, 6).map((x) => { const q = sec(x, s); return [q[0], q[1] + 0.003, q[2]] as V3; });
      b.strap(pts, 0.012, 0.003, { up: [0, 1, 0] });
      for (const xe of [x0, x1]) {
        const a = sec(xe, s), c2 = sec(xe, flip ? 1 : 0);
        b.strap([[a[0], a[1] + 0.003, a[2]], [c2[0], c2[1] + 0.003, c2[2]]], 0.01, 0.003, { up: [0, 1, 0] });
      }
    }
    // the de-icing boot on the leading edge
    b.ink({ color: PAL.rubber, mat: MAT.RUBBER, wear: 0.45, rough: 0.8, snow: 1 });
    surface(b, steps(0.06, 0.97, 8), steps(0.43, 0.57, 6), (u, s) => {
      const q = sec(-4.1 + 8.4 * u, s);
      const dy = ((s < 0.5) !== flip ? 1 : -1) * 0.003;
      return [q[0], q[1] + dy, q[2] + 0.004];
    }, { flip: !flip }).ghost();
    // tip fairing and navigation light
    b.ink({ color: PAL.liveryGrey, mat: MAT.PAINT, wear: 0.55, rough: 0.7, snow: 1 });
    surface(b, steps(0, 1, 3), sSorted, (u, s) => {
      const q = sec(X1, s);
      const yMid = base + (flip ? -1 : 1) * 0.04 * chord(X1);
      const k = Math.cos((u * Math.PI) / 2);
      return [X1 + 0.2 * Math.sin((u * Math.PI) / 2), yMid + (q[1] - yMid) * k, q[2] * (0.6 + 0.4 * k)];
    }, { flip: !flip }).ghost();
    b.ink({ color: flip ? hex(0x7a1410) : hex(0x14602c), mat: MAT.PLASTIC, rough: 0.15, wear: 0.4, snow: 0.5 });
    {
      const q = sec(X1, 0.5);
      b.sphere([0.06, 0.04, 0.09], { sides: 8, rings: 5 }).move(X1 + 0.18, q[1], q[2] - 0.18);
    }
    // the torn root: spars, a rib, ragged skin flaps, hanging lines
    b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.6, rough: 0.6, snow: 0.6 });
    for (const uc of [0.15, 0.6]) {
      const c = chord(X0);
      const z = c * 0.5 - uc * c;
      const [yu, yl] = naca(uc);
      const h = (yu - yl) * c * 0.92;
      const yc = base + (flip ? -1 : 1) * ((yu + yl) / 2) * c;
      const len = r.range(0.35, 0.6);
      b.box(len, h, 0.035, { bevel: 0.006, rows: 2 }).crumple(0.02, 4).move(X0 + 0.25 - len / 2, yc, z);
      // spar caps
      b.ink({ color: PAL.aluminiumDull, mat: MAT.METAL, wear: 0.5, snow: 0.6 });
      for (const dy of [-h / 2, h / 2]) b.box(len + 0.1, 0.02, 0.09, { bevel: 0.004 }).move(X0 + 0.22 - len / 2, yc + dy, z);
      b.ink({ color: PAL.primer, mat: MAT.PAINT, wear: 0.6, rough: 0.6, snow: 0.6 });
    }
    {
      const xr = X0 + 0.55;
      const c = chord(xr);
      const pts: V3[] = [];
      for (const s of steps(0, 1, 18)) pts.push(sec(xr, s));
      // root rib: a flat plate in the section, a little inside the torn skin
      const P = pts.slice(0, -1);
      const idx = P.map((_, i) => i);
      b.mesh(P, [idx, idx.slice().reverse()]).ghost();
      void c;
    }
    b.ink({ color: PAL.plasticBlack, mat: MAT.PLASTIC, wear: 0.4, snow: 0.4 });
    for (let i = 0; i < 4; i++) {
      const z = r.range(-0.8, 0.9), y = base + (flip ? -0.05 : 0.12);
      const a: V3 = [X0 + 0.4, y, z];
      const e: V3 = [X0 - r.range(0.1, 0.5), Math.max(0.02, y - r.range(0.05, 0.25)), z + r.range(-0.3, 0.3)];
      b.pipe(Path.spline([a, [(a[0] + e[0]) / 2, y + 0.05, (a[2] + e[2]) / 2], e], 3), r.range(0.006, 0.014), { sides: 5 }).ghost();
    }
    b.ink({ color: PAL.liveryGrey, mat: MAT.PAINT, wear: 0.7, rough: 0.7, snow: 1 });
    for (let i = 0; i < 4; i++) {
      const s = r.next() < 0.5 ? r.range(0.05, 0.35) : r.range(0.65, 0.95);
      const q = sec(xRoot(s) + 0.05, s);
      b.box(r.range(0.2, 0.45), 0.003, r.range(0.25, 0.5), { bevel: 0.001, rows: 2 }).crumple(0.04, 5).rotZ(r.range(-0.8, 0.8)).move(q[0] - 0.12, q[1], q[2]);
    }

    if (flip) {
      // upside down: flap-track fairings and the torn engine mounting stand up from the lower skin
      b.ink({ color: LIVERY.belly, mat: MAT.PAINT, wear: 0.55, rough: 0.7, snow: 1 });
      for (const x of [-3.6, -1.6, 1.0, 2.9]) {
        const q = sec(x, 0.86);
        const f = b.capsule(0.07, 1.0, { sides: 8, rings: 3 }).scale(1, 1, 1);
        f.rotX(Math.PI / 2).scale(1, 1.3, 1).move(x, q[1] + 0.06, q[2] - 0.25);
      }
      const q = sec(-2.3, 0.62);
      b.ink({ color: PAL.liveryGrey, mat: MAT.PAINT, wear: 0.7, rough: 0.7, snow: 1 });
      const stub = b.cyl(0.55, 0.7, { sides: 14, rows: 2 });
      stub.scale(1, 1, 0.8).crumple(0.06, 2.2).move(-2.3, q[1] + 0.25, q[2] + 0.1);
      b.ink({ color: hex(0x2c2c2c), mat: MAT.METAL, wear: 0.8, rough: 0.6, snow: 0.8 });
      b.cyl(0.5, 0.04, { sides: 14 }).move(-2.3, q[1] + 0.58, q[2] + 0.1);
      b.ink({ color: PAL.steelDark, mat: MAT.METAL, wear: 0.9, snow: 0.6 });
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        b.cyl(0.025, 0.55, { sides: 6 }).rotZ(r.range(-0.4, 0.4)).rotX(r.range(-0.4, 0.4)).move(-2.3 + Math.cos(a) * 0.32, q[1] + 0.8, q[2] + 0.1 + Math.sin(a) * 0.32);
      }
      // snow drifted under the floating edges
      drift(b, [[X0 + 0.3, 0, 1.35], [0, 0, 1.25], [X1, 0, 1.05]], 0.9, 0.22, { lee: -0.6 });
      drift(b, [[X0 + 0.4, 0, -1.25], [0, 0, -1.2], [X1, 0, -1.05]], 0.8, 0.2, { lee: 0.6 });
    } else {
      // NO STEP on the flap, a walkway line inboard
      b.ink({ color: hex(0x1d1e20), mat: MAT.PAINT, wear: 0.6, snow: 1 });
      const q = sec(-2.0, 0.07);
      b.stencil('NO STEP', 0.11, { align: 'center', weight: 0.14 }).rotX(-Math.PI / 2).move(-2.0, q[1] + 0.004, q[2] + 0.05);
      const q2 = sec(-3.2, 0.25);
      b.strap(steps(X0 + 0.5, -2.6, 3).map((x) => { const p = sec(x, 0.25); return [p[0], p[1] + 0.003, p[2]] as V3; }), 0.025, 0.002, { up: [0, 1, 0] });
      void q2;
      drift(b, [[X0 + 0.4, 0, 1.45], [0.5, 0, 1.4], [X1, 0, 1.2]], 1.1, 0.24, { lee: -0.5 });
      drift(b, [[X0 + 1, 0, -1.4], [X1 - 0.5, 0, -1.25]], 0.8, 0.16, { lee: 0.5 });
      icicles(b, sec(-1.5, 0.0), sec(1.5, 0.0), { every: 0.1, len: [0.02, 0.18], r: 0.01 });
    }
    void mixRGB;
    for (const k in bp.anchors) {
      const a = bp.anchors[k];
      b.anchor(k, [a.x, a.y, a.z], a.yaw);
    }
    return b.build({ ground: true });
  },
  { variants: 2, size: 'structure', desc: 'a torn-off wing lying in the snow, walkable (blueprint wing); 0 right side up, 1 upside down', tags: ['wreck'] },
);
