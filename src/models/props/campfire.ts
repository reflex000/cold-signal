// 'campfire': a ring of stones round a fire in one of four stages, opts.stage:
//   0 laid     tinder under a teepee of sticks, unlit (no emitters)
//   1 burning  the stack charred and glowing at its foot, coals in an ash bed: fire, smoke, spark
//   2 embers   burned down: charred stubs fallen inward on a red bed: a small fire, thin smoke
//   3 dead     cold charcoal and grey ash, the stones blackened inside (no emitters)
// The flames, smoke and light are the fx systems' (they read the emitters); the model carries the
// glow of the coals itself (MAT.CHAR with emissive: only the cracks glow, and they breathe).
// Variants (seed & 3): ring size and stones, how the sticks lie.
// Anchors: fire (heart of the flame), fuel (where a stick is laid on), ring (stone ring radius in `r`).
import { Builder, MAT, PAL, hex, mixRGB, type Part, type RGB, type V3 } from '../kit';
import { register } from '../registry';

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

register(
  'campfire',
  (seed, opts) => {
    const b = new Builder(seed);
    const r = b.rng;
    const stage = Math.max(0, Math.min(3, Math.round(Number(opts.stage ?? 1)) || 0));
    const R = r.range(0.36, 0.44); // stone centres
    const nStones = r.int(8, 11);

    // ---- the ring of stones ----
    for (let i = 0; i < nStones; i++) {
      const a = (i / nStones) * Math.PI * 2 + r.range(-0.14, 0.14);
      const sr = r.range(0.07, 0.115);
      const rr = R + r.range(-0.035, 0.035);
      // field stones carried from the slope: granite grey to brown, broken faces
      b.ink({ color: mixRGB(mixRGB(PAL.rock, PAL.concrete, r.range(0.25, 0.6)), PAL.rockBrown, r.next() * 0.5), mat: MAT.ROCK, wear: 0.3, vary: 0.15, snow: stage === 1 || stage === 2 ? 0.3 : 1 }); // a live fire keeps its ring clear of snow
      const s = b.rock(sr, { detail: 1, rough: 0.8, facet: 0.7, flat: 0.45, squash: [r.range(0.85, 1.15), r.range(0.5, 0.75), r.range(0.7, 0.95)] });
      s.rotY(r.range(0, Math.PI * 2)).move(Math.cos(a) * rr, -sr * 0.1, Math.sin(a) * rr);
      if (stage > 0) {
        // soot on the faces turned to the fire, a dusting of ash on top
        const soot = stage === 3 ? 0.85 : 0.75;
        s.each((q) => {
          const l = Math.hypot(q.x, q.z) || 1;
          const facing = sat((-(q.nx * q.x + q.nz * q.z) / l) * 1.3 + 0.15);
          const lowK = sat(1 - q.y / (sr * 1.4));
          const t = facing * soot * (0.55 + 0.45 * lowK);
          q.r += (PAL.soot[0] - q.r) * t; q.g += (PAL.soot[1] - q.g) * t; q.b += (PAL.soot[2] - q.b) * t;
        });
      }
    }

    // ---- the bed: ash and charcoal, glowing beneath while the fire lives ----
    const glow = [0, 0.55, 0.9, 0][stage]; // scene radiance: real coals are 0.2 to 1 (the day sun on paper is about 3)
    if (stage > 0) {
      b.ink({ color: PAL.charcoal, mat: MAT.CHAR, wear: [0, 0.5, 0.62, 0.92][stage], emissive: glow, snow: stage === 3 ? 1 : 0.15 });
      // a flat, lumpy bed (2 to 3 cm), not a mound: ash settles level
      const bed = b.lathe([[0, 0], [R * 0.84, 0], [R * 0.72, 0.007], [R * 0.5, 0.014], [R * 0.25, 0.02], [0, 0.024]], { sides: 28, smooth: true });
      bed.noise(0.008, 6).noise(0.0035, 21);
      // a ragged outline where ash and charcoal were kicked out over the snow
      const os = r.int(0, 1 << 20);
      bed.warp((q) => {
        const a = Math.atan2(q.z, q.x), k = Math.hypot(q.x, q.z) / (R * 0.84);
        const s = 1 + k * k * (0.16 * Math.sin(a * 3 + os) + 0.1 * Math.sin(a * 7 + os * 1.7) + 0.06 * Math.sin(a * 13 + os * 0.3));
        q.x *= s; q.z *= s;
      });
      bed.scale(1, stage === 2 ? 0.8 : 1, 1);
      // only the heart glows; the outer part of the bed is cold grey ash
      bed.each((q) => {
        const k = sat((Math.hypot(q.x, q.z) - R * 0.12) / (R * 0.38));
        q.emissive *= (1 - k) * (1 - k);
        q.wear = Math.min(1, q.wear + k * 0.35);
      });
      // coals and charcoal lumps
      const nCoal = [0, 9, 16, 11][stage];
      for (let i = 0; i < nCoal; i++) {
        const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * R * 0.5;
        const cr = r.range(0.016, 0.034);
        b.ink({ color: mixRGB(PAL.charcoal, PAL.soot, r.next()), mat: MAT.CHAR, wear: stage === 3 ? r.range(0.4, 0.9) : r.range(0.05, 0.4), emissive: glow * r.range(0.8, 1.8) * sat(1 - d / (R * 0.4)), snow: 0.3 });
        b.rock(cr, { detail: 0, rough: 0.9, facet: 0.8, flat: 0.3, squash: [1.3, 0.7, 1] }).rotY(r.range(0, 6.3)).move(Math.cos(a) * d, 0.014 - (d / R) * 0.02, Math.sin(a) * d);
      }
    }

    // ---- wood ----
    const barkCol = (): RGB => (r.chance(0.3) ? mixRGB(PAL.bark, PAL.barkGrey, 0.5) : mixRGB(PAL.barkGrey, PAL.deadwood, r.range(0.05, 0.4)));
    /** A stick from a to c. burnBelow: height under which it is charred; glowK: ember strength there. */
    const stick = (a: V3, c: V3, rad: number, burnBelow: number, glowK: number, ash: number): Part => {
      const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const bark = barkCol();
      b.ink({ color: bark, mat: MAT.BARK, wear: 0.45 });
      const p = b.log(len, rad, { r2: rad * r.range(0.65, 0.85), sides: 6, rows: Math.max(2, Math.round(len / 0.12)), ends: [r.chance(0.5) ? 'break' : 'saw', 'break'], bend: r.range(0.03, 0.18), peel: r.range(0, 0.4), bark });
      p.span(a, c);
      if (burnBelow > -1) {
        // all CHAR (it cannot share a triangle with BARK or WOOD): unburnt wood is char painted bark-brown
        p.paint({ mat: MAT.CHAR });
        p.each((q) => {
          const t = sat((burnBelow - q.y) / 0.07 + 0.5);
          const cc = mixRGB(mixRGB(bark, PAL.timberDark, 0.3), mixRGB(PAL.charcoal, PAL.soot, 0.5), t);
          q.r = cc[0]; q.g = cc[1]; q.b = cc[2];
          q.wear = t * ash;
          q.emissive = t * glowK * sat((burnBelow - q.y) / 0.12 + 0.3);
          q.rough = 0.9;
        });
      }
      return p;
    };

    const v = seed & 3;
    if (stage <= 1) {
      // teepee: feet on a circle, tops leaning together over the centre
      const n = r.int(7, 9);
      const top: V3 = [r.range(-0.02, 0.02), r.range(0.36, 0.44), r.range(-0.02, 0.02)];
      const foot = r.range(0.18, 0.24);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r.range(-0.2, 0.2);
        const f = foot * r.range(0.85, 1.15);
        const base: V3 = [Math.cos(a) * f, 0.012, Math.sin(a) * f];
        // tops cross a little past the apex, the way leaning sticks rest on each other
        const over = r.range(0.04, 0.1);
        const tip: V3 = [top[0] - Math.cos(a) * over + r.range(-0.02, 0.02), top[1] + r.range(-0.05, 0.03), top[2] - Math.sin(a) * over + r.range(-0.02, 0.02)];
        const rad = r.range(0.011, 0.02);
        if (stage === 0) stick(base, tip, rad, -2, 0, 0);
        else stick(base, tip, rad, r.range(0.14, 0.22), r.range(0.5, 0.9), 0.35);
      }
      if (v >= 2) {
        // two split pieces leaning in on the windward side
        for (let i = 0; i < 2; i++) {
          const a = r.range(0, Math.PI * 2);
          const base: V3 = [Math.cos(a) * 0.27, 0.02, Math.sin(a) * 0.27];
          const tip: V3 = [Math.cos(a) * 0.04, 0.3, Math.sin(a) * 0.04];
          stick(base, tip, r.range(0.024, 0.032), stage === 0 ? -2 : 0.1, 0.5, 0.3);
        }
      }
      if (stage === 0) {
        // tinder: a fist of dry grass and bark shavings under the stack
        b.ink({ color: hex(0x8d7c57), mat: MAT.FUR, wear: 0.2, snow: 0.2, detailScale: 1.5 });
        b.pillow(0.13, 0.06, 0.11, { round: 0.03, bulge: 0.01, seg: 2, ring: 2 }).crumple(0.012, 14).move(0, 0.03, 0);
        b.ink({ color: hex(0xb8a68a), mat: MAT.BARK, wear: 0.1, snow: 0.2 });
        for (let i = 0; i < 3; i++) {
          b.cloth(0.07, 0.05, { thickness: 0.001, wrinkle: 0.006, billow: 0.012 }).rotX(-1.2).rotY(r.range(0, 6.3)).move(r.range(-0.04, 0.04), 0.05, r.range(-0.04, 0.04));
        }
      }
    } else {
      // burned down: stubs fallen inward, their outer ends unburnt, the inner ends char
      const n = r.int(6, 9);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
        const out = r.range(0.17, 0.3), inn = r.range(0.0, 0.08);
        const base: V3 = [Math.cos(a) * out, 0.03, Math.sin(a) * out];
        const tip: V3 = [Math.cos(a + r.range(-0.3, 0.3)) * inn, r.range(0.035, 0.07), Math.sin(a + r.range(-0.3, 0.3)) * inn];
        // charred from the middle of the ring outward to about 14 cm from the centre
        const p = stick(base, tip, r.range(0.012, 0.022), 10, 0, stage === 2 ? 0.45 : 0.75);
        const ember = stage === 2 ? r.range(0.6, 1.1) : 0;
        p.each((q) => {
          const d = Math.hypot(q.x, q.z);
          const t = sat((0.17 - d) / 0.06 + 0.5);
          const cc = mixRGB(mixRGB(PAL.bark, PAL.timberDark, 0.3), mixRGB(PAL.charcoal, PAL.soot, 0.5), t);
          q.r = cc[0]; q.g = cc[1]; q.b = cc[2];
          q.wear = t * (stage === 2 ? 0.45 : 0.8);
          q.emissive = t * ember;
        });
      }
    }

    b.anchor('fire', [0, stage === 2 ? 0.06 : 0.12, 0]);
    b.anchor('fuel', [0, 0.3, 0]);
    b.anchor('ring', [0, 0, 0], 0, { r: R + 0.1 });
    if (stage === 1) {
      b.emitter('fire', [0, 0.1, 0], { size: 0.22, strength: 1 });
      b.emitter('smoke', [0, 0.55, 0], { size: 0.18, strength: 1 });
      b.emitter('spark', [0, 0.16, 0], { size: 0.2 });
    } else if (stage === 2) {
      b.emitter('fire', [0, 0.05, 0], { size: 0.14, strength: 0.35 });
      b.emitter('smoke', [0, 0.25, 0], { size: 0.12, strength: 0.45 });
    }
    return b.build();
  },
  { variants: 4, size: 'prop', desc: 'stone fire ring; opts.stage 0 laid, 1 burning, 2 embers, 3 dead', tags: ['fire'] },
);
