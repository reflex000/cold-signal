// 'barrel': a 208 litre (55 US gallon) steel drum made into a fire barrel. The lid has been
// chiselled off, leaving a ragged, flared rim; a row of draught holes is cut round the foot. The
// paint has burned off the top half (bare steel, rust and soot), what is left below is chalky and
// blistered toward the burn line; dented where it was dropped. Charred split wood stands inside
// on a bed of coals that glow through the holes when it is lit.
// opts.lit (default true): glowing coals, no snow on it, and the emitters. Unlit: cold char, snow
// may settle inside, no emitters.
// Variants (seed & 3): blue, green, red, black drum; 1 and 3 carry a grate of two rebar rods.
// Emitters (lit): fire (just below the rim), smoke, spark. Anchors: top, fire, use.
import { Builder, MAT, PAL, hex, mixRGB, fbm3, type P2, type V3 } from '../kit';
import { register } from '../registry';

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

register(
  'barrel',
  (seed, opts) => {
    const b = new Builder(seed);
    const r = b.rng;
    const v = seed & 3;
    const lit = opts.lit !== false && opts.lit !== 0 && opts.lit !== 'false';
    const R = 0.286, th = 0.0018;
    const yt = 0.862 - r.range(0, 0.025); // cut height
    const yv0 = 0.055, yv1 = 0.125; // draught-hole band
    const paint = [hex(0x24476e), hex(0x2f4a2c), hex(0x7d231b), hex(0x1d1e20)][v];
    const snow = lit ? 0 : 1;
    const nSeed = r.int(0, 1 << 30);

    // outer radius along the height: rolled chime at the foot, two rolling hoops
    const hoop = (y: number, at: number) => 0.0095 * Math.exp(-(((y - at) / 0.0085) ** 2));
    const rOut = (y: number) => R + hoop(y, 0.29) + hoop(y, 0.585);
    const ys: number[] = [];
    for (let y = yv1; y < yt - 0.01; y += 0.045) ys.push(y);
    for (const at of [0.29, 0.585]) for (const d of [-0.02, -0.011, -0.005, 0, 0.005, 0.011, 0.02]) ys.push(at + d);
    ys.push(yt - 0.03, yt);
    const sorted = [...new Set(ys.map((y) => Math.round(y * 1e4) / 1e4))].filter((y) => y >= yv1 && y <= yt).sort((a, c) => a - c);
    const outer: P2[] = sorted.map((y) => [rOut(y), y]);
    const inner: P2[] = sorted.map((y) => [rOut(y) - th, y] as P2).reverse();

    b.ink({ color: paint, mat: MAT.PAINT, wear: 0.6, snow });
    const upper = b.lathe([...outer, ...inner], { sides: 32, closed: true, crease: 35 * Math.PI / 180 });
    const lower = b.lathe([[0, 0], [R + 0.002, 0], [R + 0.0065, 0.006], [R + 0.0065, 0.016], [R + 0.001, 0.022], [R, yv0], [R - th, yv0], [R - th, 0.03], [0, 0.03]], { sides: 32, closed: true, crease: 35 * Math.PI / 180 });
    // the wall between the draught holes
    const holes = 7;
    const holeW = 0.06 / R;
    const band = [];
    for (let i = 0; i < holes; i++) {
      const a0 = (i / holes) * Math.PI * 2 + holeW / 2, a1 = ((i + 1) / holes) * Math.PI * 2 - holeW / 2;
      band.push(b.lathe([[R, yv0], [R, yv1], [R - th, yv1], [R - th, yv0]], { sides: 4, closed: true, arc: [a0, a1] }));
    }

    // ragged chisel cut: teeth of uneven height, some bent outward
    upper.warp((q) => {
      const dTop = yt - q.y;
      if (dTop > 0.032) return;
      const a = Math.atan2(q.z, q.x);
      const c = Math.cos(a), s = Math.sin(a);
      const k = 1 - dTop / 0.032;
      if (dTop < 1e-4) q.y -= 0.022 * sat(0.5 + fbm3(nSeed, c * 3.1, s * 3.1, 0, 2) * 0.9 + 0.25 * Math.sin(a * 23));
      const flare = Math.max(0, fbm3(nSeed + 5, c * 2.2, s * 2.2, 1, 2)) * 0.026 * k * k;
      q.x += c * flare; q.z += s * flare;
    });
    // dents where it was dropped and kicked
    for (let i = 0, n = r.int(1, 3); i < n; i++) {
      const a = r.range(0, Math.PI * 2), y = r.range(0.2, 0.7);
      upper.dent([Math.cos(a) * R, y, Math.sin(a) * R], r.range(0.07, 0.13), r.range(0.008, 0.02));
    }

    // fire damage: paint burned off above a ragged line, scorched and chalky toward it, soot inside
    const burnLine = (a: number) => 0.42 + 0.09 * fbm3(nSeed + 9, Math.cos(a) * 1.6, Math.sin(a) * 1.6, 2, 3);
    const rustCol = mixRGB(PAL.rust, PAL.rustDark, 0.35);
    for (const part of [upper, lower, ...band]) {
      part.each((q) => {
        const a = Math.atan2(q.z, q.x);
        const inside = q.nx * q.x + q.nz * q.z < 0 || (q.ny > 0.5 && Math.hypot(q.x, q.z) < R - 0.004);
        const yb = burnLine(a);
        if (inside) {
          // inner wall and floor: soot over rust
          q.mat = MAT.METAL;
          const c = mixRGB(PAL.soot, rustCol, 0.25 * sat((yb - q.y) * 3));
          q.r = c[0]; q.g = c[1]; q.b = c[2];
          q.wear = 2;
          q.rough = 0.95;
          return;
        }
        if (q.y > yb) {
          q.mat = MAT.METAL;
          // rust in the middle, soot toward the rim
          const t = sat((q.y - yb) / 0.35);
          const c = mixRGB(mixRGB(rustCol, PAL.iron, 0.3 * fbm3(nSeed + 3, q.x * 9, q.y * 9, q.z * 9, 2) + 0.3), PAL.soot, t * t * 0.9);
          q.r = c[0]; q.g = c[1]; q.b = c[2];
          q.wear = 1.6 + t;
          q.rough = 0.9;
        } else {
          // paint, browning and blistering in the last few centimetres under the line (dark, not chipped)
          const t = sat(1 - (yb - q.y) / 0.12);
          const c = mixRGB(mixRGB(paint, hex(0x8f8a80), 0.18), mixRGB(PAL.rustDark, PAL.soot, 0.45), t * 0.9);
          q.r = c[0]; q.g = c[1]; q.b = c[2];
          q.wear = 0.75 + t * 0.35;
        }
      });
    }
    // soot streaks from the draught holes
    for (const part of [upper, ...band]) part.each((q) => {
      if (q.nx * q.x + q.nz * q.z < 0) return;
      const a = Math.atan2(q.z, q.x);
      const ph = ((a / (Math.PI * 2)) * holes + 100) % 1;
      const near = sat(1 - Math.abs(ph - 0) * 6) + sat(1 - Math.abs(ph - 1) * 6);
      const k = near * sat(1 - (q.y - yv1) / 0.18) * 0.6;
      q.r *= 1 - k; q.g *= 1 - k; q.b *= 1 - k;
    });

    // ---- inside: coals and charred split wood ----
    const glow = lit ? 0.6 : 0; // scene radiance of glowing coals
    b.ink({ color: PAL.charcoal, mat: MAT.CHAR, wear: lit ? 0.45 : 0.8, emissive: glow, snow });
    b.lathe([[0, 0.03], [R - 0.004, 0.03], [R - 0.01, 0.07], [R * 0.4, 0.1], [0, 0.11]], { sides: 18, smooth: true }).noise(0.008, 10);
    for (let i = 0; i < 12; i++) {
      const a = r.range(0, Math.PI * 2), d = Math.sqrt(r.next()) * (R - 0.04);
      b.ink({ color: mixRGB(PAL.charcoal, PAL.soot, r.next()), mat: MAT.CHAR, wear: r.range(0.2, 0.6), emissive: glow * r.range(0.8, 1.6), snow });
      b.rock(r.range(0.02, 0.04), { detail: 0, rough: 0.9, facet: 0.8, flat: 0.3 }).rotY(r.range(0, 6.3)).move(Math.cos(a) * d, 0.09 - (d / R) * 0.04, Math.sin(a) * d);
    }
    const pieces = r.int(3, 5);
    for (let i = 0; i < pieces; i++) {
      const a = (i / pieces) * Math.PI * 2 + r.range(-0.4, 0.4);
      const foot: V3 = [Math.cos(a) * r.range(0.04, 0.12), 0.09, Math.sin(a) * r.range(0.04, 0.12)];
      const lean = r.range(0.12, 0.2);
      const tip: V3 = [Math.cos(a + Math.PI) * lean, yt + r.range(-0.12, 0.1), Math.sin(a + Math.PI) * lean];
      const len = Math.hypot(tip[0] - foot[0], tip[1] - foot[1], tip[2] - foot[2]);
      b.ink({ color: PAL.bark, mat: MAT.BARK, wear: 0.4, snow });
      const p = b.log(len, r.range(0.03, 0.045), { r2: 0.022, sides: 7, rows: 5, ends: ['saw', 'break'], bend: 0.05, gnarl: 0.004 });
      p.span(foot, tip);
      // split wood: flatten one side, then char it all; it glows only low down, in the heat
      p.paint({ mat: MAT.CHAR });
      p.each((q) => {
        const t = sat(1 - (q.y - 0.1) / (yt * 0.9));
        const c = mixRGB(mixRGB(PAL.timberDark, PAL.charcoal, 0.6), PAL.soot, t);
        q.r = c[0]; q.g = c[1]; q.b = c[2];
        q.wear = lit ? 0.2 + 0.3 * t : 0.5 + 0.4 * t;
        q.emissive = glow * t * t * 1.2;
      });
    }

    // ---- a grate of two rebar rods across the rim ----
    if (v === 1 || v === 3) {
      b.ink({ color: PAL.rustDark, mat: MAT.METAL, wear: 1.8, rough: 0.9, snow });
      for (const z of [-0.075, 0.08]) {
        const yy = yt - 0.006;
        const p = b.pipe([[-R - 0.05, yy - 0.004, z], [-R + 0.02, yy + 0.004, z + 0.005], [R - 0.02, yy + 0.004, z - 0.004], [R + 0.06, yy - 0.006, z]], 0.006, { sides: 6 });
        // the ribs of rebar
        p.warp((q) => {
          const s = Math.sin(q.x * 260);
          q.y += s * 0.0007; q.z += Math.cos(q.x * 260) * 0.0007;
        });
      }
    }

    b.anchor('top', [0, yt, 0]);
    b.anchor('fire', [0, yt - 0.12, 0]);
    b.anchor('use', [0, 0, R + 0.6], 0);
    if (lit) {
      b.emitter('fire', [0, yt - 0.06, 0], { size: 0.22, strength: 1 });
      b.emitter('smoke', [0, yt + 0.45, 0], { size: 0.2, strength: 1 });
      b.emitter('spark', [0, yt, 0], { size: 0.18 });
    }
    return b.build();
  },
  { variants: 4, size: 'prop', desc: 'fire barrel (cut-open 208 l steel drum); opts.lit (default true)', tags: ['fire'] },
);
