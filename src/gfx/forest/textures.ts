// The foliage atlas: needle sprays, hanging branchlets, dead twigs, dry grass and shrub twigs, drawn
// stroke by stroke on a 2D canvas at load (no image files), then turned into a mipmapped texture on
// the CPU so the alpha-tested foliage keeps its coverage at a distance (each mip's alpha is scaled
// until as many texels pass the 0.5 test as at full size) and so transparent texels carry the colour
// of their neighbours (no dark fringe where bilinear filtering meets the cut-out edge).
//
// Layout (1024 x 1024, sRGB colour, alpha = coverage). A region's v runs DOWN the canvas.
//   R.spruce      spruce spray seen from above   base at v0, tip at v1, u across
//   R.fir         subalpine fir spray (flat comb)
//   R.spruceMid   denser spruce spray for the simplified mesh
//   R.firMid      denser fir spray
//   R.curtain     spruce branchlets hanging from a branch: u along the branch (inner end u0), v down
//   R.curtainMid  denser curtain
//   R.dead        dead grey twigs (lower trunk, snags)
//   R.grass       dry grass tuft, base at v1 (bottom)
//   R.shrub       bare shrub twigs, base at v1
//   R.juniper     a low conifer shoot (shrub tip through the snow), base at v1
import * as THREE from 'three/webgpu';

export interface Region { x: number; y: number; w: number; h: number }

const SIZE = 1024;

export const R = {
  spruce: { x: 0, y: 0, w: 256, h: 512 },
  fir: { x: 256, y: 0, w: 256, h: 512 },
  spruceMid: { x: 512, y: 0, w: 256, h: 512 },
  firMid: { x: 768, y: 0, w: 256, h: 512 },
  curtain: { x: 0, y: 512, w: 512, h: 256 },
  curtainMid: { x: 0, y: 768, w: 512, h: 256 },
  dead: { x: 512, y: 512, w: 256, h: 256 },
  grass: { x: 768, y: 512, w: 256, h: 256 },
  shrub: { x: 512, y: 768, w: 256, h: 256 },
  juniper: { x: 768, y: 768, w: 256, h: 256 },
} satisfies Record<string, Region>;

/** Atlas uv of a point (u, v in 0..1) inside a region. */
export function regionUV(r: Region, u: number, v: number): [number, number] {
  // half a texel inset keeps bilinear taps inside the region
  const x = r.x + 0.5 + u * (r.w - 1);
  const y = r.y + 0.5 + v * (r.h - 1);
  return [x / SIZE, y / SIZE];
}

// ------------------------------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------------------------------

class Pen {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s >>> 0;
    return this.s / 4294967296;
  }
  r(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

type Ctx = CanvasRenderingContext2D;

function rgb(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}

/** A twig: a polyline from (x0,y0) heading `ang` (radians, canvas space), gently curving. */
function twigPath(pen: Pen, x0: number, y0: number, ang: number, len: number, curve: number, steps = 8): [number, number][] {
  const pts: [number, number][] = [[x0, y0]];
  let x = x0, y = y0, a = ang;
  const st = len / steps;
  for (let i = 0; i < steps; i++) {
    a += curve / steps + pen.r(-0.04, 0.04);
    x += Math.cos(a) * st;
    y += Math.sin(a) * st;
    pts.push([x, y]);
  }
  return pts;
}

function strokePath(ctx: Ctx, pts: [number, number][], w0: number, w1: number, col: string): void {
  ctx.strokeStyle = col;
  ctx.lineCap = 'round';
  for (let i = 0; i < pts.length - 1; i++) {
    const t = i / Math.max(1, pts.length - 2);
    ctx.lineWidth = w0 + (w1 - w0) * t;
    ctx.beginPath();
    ctx.moveTo(pts[i][0], pts[i][1]);
    ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
    ctx.stroke();
  }
}

interface NeedleStyle {
  len: number; // px
  spread: [number, number]; // angle from the twig, radians
  step: number; // px between needle rings
  perStep: number;
  width: number;
  col: [number, number, number];
  colVar: number;
  /** 0 = needles all round (spruce), 1 = two flat ranks (fir) */
  flat: number;
  blue: number; // chance of a bluish needle
}

/** Needles along a twig polyline. Shorter toward the twig tip. */
function needles(ctx: Ctx, pen: Pen, pts: [number, number][], st: NeedleStyle, scale = 1): void {
  ctx.lineCap = 'round';
  let total = 0;
  const seg: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    seg.push(d);
    total += d;
  }
  for (let d = pen.r(0, st.step); d < total; d += st.step * pen.r(0.7, 1.3)) {
    // locate
    let k = 0, acc = 0;
    while (k < seg.length - 1 && acc + seg[k] < d) acc += seg[k++];
    const f = (d - acc) / Math.max(1e-6, seg[k]);
    const x = pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f;
    const y = pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f;
    const a = Math.atan2(pts[k + 1][1] - pts[k][1], pts[k + 1][0] - pts[k][0]);
    const tt = d / total;
    const lenK = scale * (1 - 0.45 * tt * tt) * (0.75 + 0.5 * pen.next());
    for (let n = 0; n < st.perStep; n++) {
      const side = n % 2 === 0 ? 1 : -1;
      let spread = pen.r(st.spread[0], st.spread[1]);
      if (st.flat < 1 && pen.next() > 0.5 + 0.5 * st.flat) spread *= pen.r(0.2, 0.7); // needles pointing at the viewer look short
      const na = a + side * spread;
      const L = st.len * lenK * (st.flat < 1 ? pen.r(0.55, 1.0) : 1);
      const v = st.colVar;
      const blue = pen.next() < st.blue;
      const r0 = st.col[0] * (1 + pen.r(-v, v)) * (blue ? 0.92 : 1);
      const g0 = st.col[1] * (1 + pen.r(-v, v));
      const b0 = st.col[2] * (1 + pen.r(-v, v)) * (blue ? 1.35 : 1);
      ctx.strokeStyle = rgb(r0, g0, b0);
      ctx.lineWidth = st.width * pen.r(0.8, 1.15);
      const bend = side * pen.r(-0.15, 0.25) * st.flat;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + Math.cos(na) * L * 0.55, y + Math.sin(na) * L * 0.55, x + Math.cos(na + bend) * L, y + Math.sin(na + bend) * L);
      ctx.stroke();
      // a pale tip on a few: new growth / frost
      if (pen.next() < 0.18) {
        ctx.strokeStyle = rgb(r0 * 1.5, g0 * 1.45, b0 * 1.35);
        ctx.lineWidth = st.width * 0.7;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(na + bend) * L * 0.75, y + Math.sin(na + bend) * L * 0.75);
        ctx.lineTo(x + Math.cos(na + bend) * L, y + Math.sin(na + bend) * L);
        ctx.stroke();
      }
    }
  }
}

const TWIG: [number, number, number] = [58, 45, 34];

const SPRUCE: NeedleStyle = { len: 11, spread: [0.5, 1.25], step: 1.6, perStep: 3, width: 1.6, col: [36, 52, 43], colVar: 0.22, flat: 0, blue: 0.3 };
const FIR: NeedleStyle = { len: 10, spread: [1.0, 1.45], step: 1.35, perStep: 2, width: 1.7, col: [33, 50, 38], colVar: 0.18, flat: 1, blue: 0.12 };

/** A spray seen from above: rachis from the region's top (base) to bottom (tip), branchlets on both sides. */
function spray(ctx: Ctx, pen: Pen, r: Region, st: NeedleStyle, o: { density: number; width: number; flat: boolean }): void {
  const cx = r.x + r.w / 2, y0 = r.y + 6, y1 = r.y + r.h - 8;
  const len = y1 - y0;
  const main = twigPath(pen, cx + pen.r(-6, 6), y0, Math.PI / 2 + pen.r(-0.05, 0.05), len, pen.r(-0.15, 0.15), 14);
  const branches: [number, number][][] = [];
  const nb = Math.round(22 * o.density);
  for (let i = 0; i < nb; i++) {
    const t = 0.06 + 0.9 * (i + pen.r(0, 0.6)) / nb;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.65);
    const side = i % 2 === 0 ? 1 : -1;
    const k = Math.min(main.length - 2, Math.floor(t * (main.length - 1)));
    const [bx, by] = main[k];
    const base = Math.PI / 2 - side * (o.flat ? pen.r(0.95, 1.25) : pen.r(0.7, 1.15));
    const L = (r.w * 0.5 - 10) * o.width * env * pen.r(0.75, 1.05);
    if (L < 6) continue;
    const tw = twigPath(pen, bx, by, base, L, side * pen.r(0.2, 0.45), 6);
    branches.push(tw);
    // tertiary shoots on the long branchlets
    if (L > 40) {
      const nt = Math.floor(L / 26);
      for (let j = 0; j < nt; j++) {
        const kk = 1 + Math.floor((j + 0.5) * (tw.length - 2) / nt);
        const s2 = j % 2 === 0 ? 1 : -1;
        const a2 = Math.atan2(tw[kk + 1][1] - tw[kk][1], tw[kk + 1][0] - tw[kk][0]) - s2 * pen.r(0.6, 1.0);
        branches.push(twigPath(pen, tw[kk][0], tw[kk][1], a2, L * pen.r(0.25, 0.4), s2 * 0.2, 3));
      }
    }
  }
  strokePath(ctx, main, 3.4, 1.4, rgb(...TWIG));
  for (const b of branches) strokePath(ctx, b, 1.6, 0.8, rgb(TWIG[0] * 0.95, TWIG[1] * 0.95, TWIG[2]));
  for (const b of branches) needles(ctx, pen, b, st, 1);
  needles(ctx, pen, main, st, 1.15);
}

/** Branchlets hanging from the top edge (spruce "curtain"). u along the branch, v down. */
function curtain(ctx: Ctx, pen: Pen, r: Region, st: NeedleStyle, density: number): void {
  const n = Math.round(15 * density);
  // the carrying branch along the top edge
  const top = twigPath(pen, r.x + 4, r.y + 7, 0, r.w - 8, 0, 10);
  const hangs: [number, number][][] = [];
  for (let i = 0; i < n; i++) {
    const u = (i + pen.r(0.1, 0.9)) / n;
    const x = r.x + 6 + u * (r.w - 12);
    // longer toward the outer end, as the branch carries more there
    const L = (r.h - 16) * pen.r(0.55, 1.0) * (0.6 + 0.4 * u);
    const tw = twigPath(pen, x, r.y + 8, Math.PI / 2 + pen.r(-0.35, 0.25), L, pen.r(-0.3, 0.3), 7);
    hangs.push(tw);
    if (L > 60) {
      for (let j = 0; j < 2; j++) {
        const kk = 2 + Math.floor(pen.r(0, tw.length - 4));
        const s2 = pen.next() < 0.5 ? 1 : -1;
        hangs.push(twigPath(pen, tw[kk][0], tw[kk][1], Math.PI / 2 + s2 * pen.r(0.4, 0.8), L * pen.r(0.2, 0.35), 0, 3));
      }
    }
  }
  strokePath(ctx, top, 3, 2, rgb(...TWIG));
  for (const h of hangs) strokePath(ctx, h, 1.5, 0.8, rgb(...TWIG));
  for (const h of hangs) needles(ctx, pen, h, st, 0.95);
  needles(ctx, pen, top, st, 1.1);
}

/** Bare twigs branching from the region's top (dead lower branches, snags). */
function deadTwigs(ctx: Ctx, pen: Pen, r: Region): void {
  const grow = (x: number, y: number, a: number, L: number, w: number, depth: number): void => {
    const pts = twigPath(pen, x, y, a, L, pen.r(-0.4, 0.4), 5);
    const g = 70 + pen.r(-10, 14);
    strokePath(ctx, pts, w, w * 0.6, rgb(g * 1.05, g * 0.95, g * 0.85));
    if (depth <= 0) return;
    const nk = 2 + Math.floor(pen.next() * 2);
    for (let k = 0; k < nk; k++) {
      const i = 1 + Math.floor(pen.r(0, pts.length - 2));
      grow(pts[i][0], pts[i][1], a + (pen.next() < 0.5 ? 1 : -1) * pen.r(0.4, 0.9), L * pen.r(0.35, 0.6), w * 0.65, depth - 1);
    }
  };
  for (let i = 0; i < 3; i++) grow(r.x + r.w / 2 + pen.r(-20, 20), r.y + 4, Math.PI / 2 + pen.r(-0.5, 0.5), r.h * pen.r(0.6, 0.9), 3, 3);
}

/** Dry grass tuft: blades from the bottom centre, arching out. */
function grass(ctx: Ctx, pen: Pen, r: Region): void {
  const bx = r.x + r.w / 2, by = r.y + r.h - 3;
  for (let i = 0; i < 70; i++) {
    const a = -Math.PI / 2 + pen.r(-0.75, 0.75);
    const L = r.h * pen.r(0.45, 0.95);
    const curve = (a + Math.PI / 2) * pen.r(0.6, 1.4);
    const pts = twigPath(pen, bx + pen.r(-14, 14), by, a, L, curve, 6);
    const g = pen.r(0.75, 1.15);
    const dead = pen.next() < 0.35;
    const col = dead ? rgb(120 * g, 104 * g, 80 * g) : rgb(150 * g, 128 * g, 82 * g);
    strokePath(ctx, pts, 2.6, 0.7, col);
  }
}

/** Shrub tip: a few reddish-brown stems with twigs, from the bottom. */
function shrub(ctx: Ctx, pen: Pen, r: Region): void {
  const grow = (x: number, y: number, a: number, L: number, w: number, depth: number): void => {
    const pts = twigPath(pen, x, y, a, L, pen.r(-0.3, 0.3), 5);
    strokePath(ctx, pts, w, w * 0.55, rgb(78 + pen.r(-8, 8), 44 + pen.r(-6, 6), 34));
    if (depth <= 0) {
      // a few dry leaves / buds
      for (let k = 0; k < 3; k++) {
        const p = pts[pts.length - 1 - k];
        ctx.fillStyle = rgb(96, 62, 40);
        ctx.beginPath();
        ctx.ellipse(p[0], p[1], 2.2, 1.4, a, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    const nk = 2 + Math.floor(pen.next() * 2);
    for (let k = 0; k < nk; k++) {
      const i = 2 + Math.floor(pen.r(0, pts.length - 3));
      grow(pts[i][0], pts[i][1], a + (pen.next() < 0.5 ? 1 : -1) * pen.r(0.3, 0.7), L * pen.r(0.4, 0.65), w * 0.7, depth - 1);
    }
  };
  for (let i = 0; i < 4; i++) grow(r.x + r.w / 2 + pen.r(-30, 30), r.y + r.h - 2, -Math.PI / 2 + pen.r(-0.45, 0.45), r.h * pen.r(0.55, 0.85), 3.4, 3);
}

/** A low conifer shoot poking up through the snow. */
function juniper(ctx: Ctx, pen: Pen, r: Region): void {
  const st: NeedleStyle = { ...FIR, len: 8, col: [32, 46, 36] };
  for (let i = 0; i < 5; i++) {
    const pts = twigPath(pen, r.x + r.w / 2 + pen.r(-40, 40), r.y + r.h - 2, -Math.PI / 2 + pen.r(-0.5, 0.5), r.h * pen.r(0.5, 0.9), pen.r(-0.4, 0.4), 7);
    strokePath(ctx, pts, 2.2, 1, rgb(...TWIG));
    needles(ctx, pen, pts, st, 1);
    for (let k = 2; k < pts.length - 1; k += 2) {
      const s = k % 4 === 0 ? 1 : -1;
      const tw = twigPath(pen, pts[k][0], pts[k][1], -Math.PI / 2 + s * pen.r(0.6, 1.0), r.h * 0.2, 0, 3);
      needles(ctx, pen, tw, st, 0.9);
    }
  }
}

// ------------------------------------------------------------------------------------------
// Mips that keep the alpha-test coverage, and colour bled into transparent texels
// ------------------------------------------------------------------------------------------

function boxBlur(src: Float32Array, w: number, h: number, ch: number, rad: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = 1 / (2 * rad + 1);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let x = -rad; x <= rad; x++) acc += src[(y * w + Math.min(w - 1, Math.max(0, x))) * ch + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * ch + c] = acc * k;
        const xa = Math.min(w - 1, x + rad + 1), xr = Math.max(0, x - rad);
        acc += src[(y * w + xa) * ch + c] - src[(y * w + xr) * ch + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let y = -rad; y <= rad; y++) acc += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * ch + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * ch + c] = acc * k;
        const ya = Math.min(h - 1, y + rad + 1), yr = Math.max(0, y - rad);
        acc += tmp[(ya * w + x) * ch + c] - tmp[(yr * w + x) * ch + c];
      }
    }
  }
  return out;
}

/** Build the mip chain from RGBA8 pixels (sRGB colour, linear alpha). */
export function buildAlphaMips(px: Uint8ClampedArray | Uint8Array, w: number, h: number): { data: Uint8Array; width: number; height: number }[] {
  // 1. bleed colour into transparent texels: premultiplied blur, then un-premultiply
  const pm = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3] / 255;
    pm[i * 4] = px[i * 4] * a;
    pm[i * 4 + 1] = px[i * 4 + 1] * a;
    pm[i * 4 + 2] = px[i * 4 + 2] * a;
    pm[i * 4 + 3] = a;
  }
  let bl = boxBlur(pm, w, h, 4, 3);
  bl = boxBlur(bl, w, h, 4, 6);
  const base = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3];
    if (a >= 250) {
      base[i * 4] = px[i * 4];
      base[i * 4 + 1] = px[i * 4 + 1];
      base[i * 4 + 2] = px[i * 4 + 2];
    } else {
      const ba = bl[i * 4 + 3];
      const t = a / 250; // keep the drawn colour where there is some coverage
      for (let c = 0; c < 3; c++) {
        const fill = ba > 1e-4 ? bl[i * 4 + c] / ba : 40;
        base[i * 4 + c] = Math.round(px[i * 4 + c] * t + fill * (1 - t));
      }
    }
    base[i * 4 + 3] = a;
  }
  // 2. coverage at full size
  let pass0 = 0;
  for (let i = 0; i < w * h; i++) if (base[i * 4 + 3] >= 128) pass0++;
  const target = pass0 / (w * h);
  const mips = [{ data: base, width: w, height: h }];
  let prev = base, pw = w, ph = h;
  // the unscaled (averaged) alpha of the previous level: the coverage scale must not compound
  let prevRaw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) prevRaw[i] = base[i * 4 + 3];
  while (pw > 1 || ph > 1) {
    const nw = Math.max(1, pw >> 1), nh = Math.max(1, ph >> 1);
    const out = new Uint8Array(nw * nh * 4);
    const raw = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0, g = 0, b = 0, a = 0, wt = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(pw - 1, x * 2 + dx), sy = Math.min(ph - 1, y * 2 + dy);
            const k = (sy * pw + sx) * 4;
            const aw = prevRaw[sy * pw + sx] + 8; // weight colour by coverage, but never to zero
            r += prev[k] * aw;
            g += prev[k + 1] * aw;
            b += prev[k + 2] * aw;
            wt += aw;
            a += prevRaw[sy * pw + sx];
          }
        }
        const o = (y * nw + x) * 4;
        out[o] = r / wt;
        out[o + 1] = g / wt;
        out[o + 2] = b / wt;
        raw[y * nw + x] = a / 4;
      }
    }
    // scale alpha so that the same fraction of texels passes the 0.5 test
    let lo = 0.5, hi = 8;
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      let n = 0;
      for (let i = 0; i < nw * nh; i++) if (raw[i] * mid >= 128) n++;
      if (n / (nw * nh) > target) hi = mid;
      else lo = mid;
    }
    const sc = (lo + hi) / 2;
    for (let i = 0; i < nw * nh; i++) out[i * 4 + 3] = Math.min(255, Math.round(raw[i] * sc));
    mips.push({ data: out, width: nw, height: nh });
    prev = out;
    prevRaw = raw;
    pw = nw;
    ph = nh;
  }
  return mips;
}

// ------------------------------------------------------------------------------------------
// The atlas
// ------------------------------------------------------------------------------------------

let atlas: THREE.DataTexture | null = null;

/** The foliage atlas texture (built once, on first use). */
export function getFoliageAtlas(): THREE.DataTexture {
  if (atlas) return atlas;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Ctx;
  ctx.clearRect(0, 0, SIZE, SIZE);
  const pen = new Pen(417);
  const clip = (r: Region, fn: () => void): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    ctx.clip();
    fn();
    ctx.restore();
  };
  clip(R.spruce, () => spray(ctx, pen, R.spruce, SPRUCE, { density: 1, width: 1, flat: false }));
  clip(R.fir, () => spray(ctx, pen, R.fir, FIR, { density: 1.15, width: 1.05, flat: true }));
  clip(R.spruceMid, () => {
    spray(ctx, pen, R.spruceMid, { ...SPRUCE, len: 13, width: 1.8 }, { density: 1.3, width: 1.05, flat: false });
  });
  clip(R.firMid, () => spray(ctx, pen, R.firMid, { ...FIR, len: 12, width: 2 }, { density: 1.35, width: 1.08, flat: true }));
  clip(R.curtain, () => curtain(ctx, pen, R.curtain, { ...SPRUCE, len: 12, width: 1.8 }, 1.5));
  clip(R.curtainMid, () => curtain(ctx, pen, R.curtainMid, { ...SPRUCE, len: 14, width: 2.1 }, 1.8));
  clip(R.dead, () => deadTwigs(ctx, pen, R.dead));
  clip(R.grass, () => grass(ctx, pen, R.grass));
  clip(R.shrub, () => shrub(ctx, pen, R.shrub));
  clip(R.juniper, () => juniper(ctx, pen, R.juniper));
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const mips = buildAlphaMips(img.data, SIZE, SIZE);
  const t = new THREE.DataTexture(mips[0].data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.mipmaps = mips as any;
  t.generateMipmaps = false;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  atlas = t;
  return t;
}
