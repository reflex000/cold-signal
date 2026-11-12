// The physically based sky, computed on the CPU (so it runs the same on WebGPU, WebGL2 and phones
// and the ambient, fog and sun colours come from the very same numbers the sky shader draws).
//
//   Transmittance table T(r, mu)   static, built once (Bruneton's parameterisation)
//   Multiple scattering table      static, built once (Hillaire 2020, second order + geometric series,
//                                  with a snow-covered ground of albedo 0.8 lighting the air from below)
//   Sky-view tables (SkyLut)       one per light (sun, moon), rebuilt row by row over a few frames
//                                  whenever that light's elevation has moved enough
//
// A sky-view table holds, for a view direction given by its azimuth from the light (0..pi, the sky
// is mirror symmetric about the light's vertical) and its elevation (Hillaire's mapping, dense at
// the horizon), two RGB integrals per unit of top-of-atmosphere irradiance:
//   A = Rayleigh phase * Rayleigh single scattering + isotropic multiple scattering   (smooth)
//   B = Mie single scattering without its phase function
// The shader adds B times the Mie phase per pixel, so the forward glow around the sun or the moon
// stays sharp at any table size. Values are stored as half floats divided by `scale`.
//
// Units: distances in km here; radiance per unit irradiance (1/sr). Owner: ATMOS.
import * as THREE from 'three/webgpu';

export const RG = 6360; // ground radius, km
export const RT = 6460; // top of the atmosphere, km
const H_TOP = Math.sqrt(RT * RT - RG * RG);
// Clean, cold mountain air: Rayleigh as at sea level, about two thirds of the standard aerosol.
const BR = [5.802e-3, 13.558e-3, 33.1e-3]; // Rayleigh scattering, 1/km
const HR = 8; // Rayleigh scale height, km
const AEROSOL = 0.7;
const MIE_S = 3.996e-3 * AEROSOL; // Mie scattering, 1/km
const MIE_E = 4.44e-3 * AEROSOL; // Mie extinction, 1/km
const HM = 1.2; // Mie scale height, km
// Ozone absorption at peak density, 1/km. The Chappuis band spans orange and red, so the red
// channel (centred near 610 nm) absorbs more than green: the twilight zenith stays blue, not mauve.
const OZ = [2.3e-3, 1.9e-3, 0.09e-3];
export const MIE_G = 0.8;
const GROUND_ALBEDO = 0.8; // snow
const SUN_SOFT = 0.006; // radians: half width of the soft edge of the earth's shadow (sun disc + refraction)

const TW = 128; // transmittance table: mu
const TH = 40; // transmittance table: height
const MW = 32; // multiple scattering table: cos of sun zenith
const MH = 16; // multiple scattering table: height

const INV_4PI = 1 / (4 * Math.PI);

export function rayleighPhase(c: number): number {
  return (3 / (16 * Math.PI)) * (1 + c * c);
}

/** Cornette-Shanks phase (Henyey-Greenstein with the Rayleigh-like correction), as the shader uses. */
export function miePhase(c: number, g = MIE_G): number {
  const g2 = g * g;
  const k = (3 / (8 * Math.PI)) * ((1 - g2) / (2 + g2));
  return (k * (1 + c * c)) / Math.pow(Math.max(1e-4, 1 + g2 - 2 * g * c), 1.5);
}

/** Elevation l (radians, -pi/2..pi/2) -> table v coordinate 0..1 (dense at the horizon). */
export function elevationToV(l: number): number {
  const a = Math.min(1, Math.abs(l) / (Math.PI / 2));
  return 0.5 + 0.5 * Math.sign(l) * Math.sqrt(a);
}

export function vToElevation(v: number): number {
  const x = 2 * v - 1;
  return Math.sign(x) * x * x * (Math.PI / 2);
}

function densities(h: number, out: Float64Array): void {
  out[0] = Math.exp(-h / HR);
  out[1] = Math.exp(-h / HM);
  out[2] = Math.max(0, 1 - Math.abs(h - 25) / 15);
}

/** Distance from radius r along mu to the top of the atmosphere. */
function distToTop(r: number, mu: number): number {
  const disc = r * r * (mu * mu - 1) + RT * RT;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
}

/** Distance from radius r along mu to the ground, or -1 when the ray misses it. */
function distToGround(r: number, mu: number): number {
  if (mu >= 0) return -1;
  const disc = r * r * (mu * mu - 1) + RG * RG;
  if (disc < 0) return -1;
  return Math.max(0, -r * mu - Math.sqrt(disc));
}

export class Atmosphere {
  /** Observer height above sea level, km (the crash site is high on a mountain). */
  observerKm: number;
  private trans = new Float32Array(TW * TH * 3);
  private ms = new Float32Array(MW * MH * 3);
  private dens = new Float64Array(3);
  private tmp = new Float64Array(3);
  private tmp2 = new Float64Array(3);

  constructor(observerKm = 1.6) {
    this.observerKm = observerKm;
    this.buildTransmittance();
    this.buildMultiScattering();
  }

  get r0(): number {
    return RG + this.observerKm;
  }

  // ---- transmittance ----

  private buildTransmittance(): void {
    const d = this.dens;
    for (let j = 0; j < TH; j++) {
      const rho = H_TOP * (j / (TH - 1));
      const r = Math.sqrt(rho * rho + RG * RG);
      const dMin = RT - r;
      const dMax = rho + H_TOP;
      for (let i = 0; i < TW; i++) {
        const dist = dMin + (i / (TW - 1)) * (dMax - dMin);
        let mu = dist === 0 ? 1 : (H_TOP * H_TOP - rho * rho - dist * dist) / (2 * r * dist);
        mu = Math.max(-1, Math.min(1, mu));
        const n = 32;
        const dt = dist / n;
        let t0 = 0, t1 = 0, t2 = 0;
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) * dt;
          const rt = Math.sqrt(r * r + t * t + 2 * r * mu * t);
          densities(rt - RG, d);
          t0 += (BR[0] * d[0] + MIE_E * d[1] + OZ[0] * d[2]) * dt;
          t1 += (BR[1] * d[0] + MIE_E * d[1] + OZ[1] * d[2]) * dt;
          t2 += (BR[2] * d[0] + MIE_E * d[1] + OZ[2] * d[2]) * dt;
        }
        const o = (j * TW + i) * 3;
        this.trans[o] = Math.exp(-t0);
        this.trans[o + 1] = Math.exp(-t1);
        this.trans[o + 2] = Math.exp(-t2);
      }
    }
  }

  /** Transmittance from radius r (km) along mu to the top of the atmosphere, ignoring the ground. */
  transmittance(r: number, mu: number, out: Float64Array | number[]): void {
    r = Math.max(RG, Math.min(RT, r));
    const rho = Math.sqrt(Math.max(0, r * r - RG * RG));
    const dist = distToTop(r, mu);
    const dMin = RT - r;
    const dMax = rho + H_TOP;
    const x = Math.max(0, Math.min(1, dMax > dMin ? (dist - dMin) / (dMax - dMin) : 0)) * (TW - 1);
    const y = Math.max(0, Math.min(1, rho / H_TOP)) * (TH - 1);
    const i0 = Math.min(TW - 2, Math.floor(x)), j0 = Math.min(TH - 2, Math.floor(y));
    const fx = x - i0, fy = y - j0;
    const T = this.trans;
    const a = (j0 * TW + i0) * 3, b = a + 3, c = a + TW * 3, e = c + 3;
    for (let k = 0; k < 3; k++) {
      const top = T[a + k] + (T[b + k] - T[a + k]) * fx;
      const bot = T[c + k] + (T[e + k] - T[c + k]) * fx;
      out[k] = top + (bot - top) * fy;
    }
  }

  /** 0..1: how much of the sun's disc stands above the horizon seen from radius r along mu. */
  static sunVisible(r: number, mu: number): number {
    // cos zenith of the geometric horizon of this point; near the horizon d(mu) ~ d(elevation)
    const k = RG / r;
    const muH = -Math.sqrt(Math.max(0, 1 - k * k));
    const x = (mu - muH + SUN_SOFT) / (2 * SUN_SOFT);
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x * x * (3 - 2 * x);
  }

  /** Transmittance of sunlight reaching radius r from a light at cos zenith mu, earth shadow included. */
  lightTransmittance(r: number, mu: number, out: Float64Array | number[]): void {
    const v = Atmosphere.sunVisible(r, mu);
    if (v <= 0) {
      out[0] = out[1] = out[2] = 0;
      return;
    }
    this.transmittance(r, mu, out);
    out[0] *= v;
    out[1] *= v;
    out[2] *= v;
  }

  // ---- multiple scattering (Hillaire 2020) ----

  private buildMultiScattering(): void {
    const NDIR = 32;
    const NSTEP = 16;
    // Spherical Fibonacci directions.
    const dirs: number[] = [];
    for (let k = 0; k < NDIR; k++) {
      const y = 1 - (2 * (k + 0.5)) / NDIR;
      const rr = Math.sqrt(1 - y * y);
      const a = k * Math.PI * (3 - Math.sqrt(5));
      dirs.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
    }
    const d = this.dens;
    const Ts = this.tmp;
    for (let j = 0; j < MH; j++) {
      const h = 100 * Math.pow(j / (MH - 1), 2);
      const r = RG + Math.max(0.01, h);
      for (let i = 0; i < MW; i++) {
        const muS = -1 + (2 * i) / (MW - 1);
        const sx = Math.sqrt(Math.max(0, 1 - muS * muS)), sy = muS;
        let L0 = 0, L1 = 0, L2 = 0, F0 = 0, F1 = 0, F2 = 0;
        for (let k = 0; k < NDIR; k++) {
          const vx = dirs[k * 3], vy = dirs[k * 3 + 1], vz = dirs[k * 3 + 2];
          const mu = vy; // the point sits at (0, r, 0)
          const tg = distToGround(r, mu);
          const tMax = tg >= 0 ? tg : distToTop(r, mu);
          const dt = tMax / NSTEP;
          let o0 = 0, o1 = 0, o2 = 0;
          for (let s = 0; s < NSTEP; s++) {
            const t = (s + 0.5) * dt;
            const px = vx * t, py = r + vy * t, pz = vz * t;
            const rp = Math.sqrt(px * px + py * py + pz * pz);
            densities(rp - RG, d);
            const e0 = BR[0] * d[0] + MIE_E * d[1] + OZ[0] * d[2];
            const e1 = BR[1] * d[0] + MIE_E * d[1] + OZ[1] * d[2];
            const e2 = BR[2] * d[0] + MIE_E * d[1] + OZ[2] * d[2];
            const tr0 = Math.exp(-(o0 + e0 * dt * 0.5)), tr1 = Math.exp(-(o1 + e1 * dt * 0.5)), tr2 = Math.exp(-(o2 + e2 * dt * 0.5));
            o0 += e0 * dt;
            o1 += e1 * dt;
            o2 += e2 * dt;
            const ss0 = BR[0] * d[0] + MIE_S * d[1], ss1 = BR[1] * d[0] + MIE_S * d[1], ss2 = BR[2] * d[0] + MIE_S * d[1];
            const muSp = (px * sx + py * sy) / rp;
            this.lightTransmittance(rp, muSp, Ts);
            L0 += tr0 * ss0 * Ts[0] * INV_4PI * dt;
            L1 += tr1 * ss1 * Ts[1] * INV_4PI * dt;
            L2 += tr2 * ss2 * Ts[2] * INV_4PI * dt;
            F0 += tr0 * ss0 * dt;
            F1 += tr1 * ss1 * dt;
            F2 += tr2 * ss2 * dt;
          }
          if (tg >= 0) {
            // Sunlit snow under the air bounces light back up into it.
            const gx = vx * tg, gy = r + vy * tg, gz = vz * tg;
            const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
            const muG = (gx * sx + gy * sy) / gr;
            if (muG > 0) {
              this.lightTransmittance(gr, muG, Ts);
              const k0 = (GROUND_ALBEDO / Math.PI) * muG;
              L0 += Math.exp(-o0) * Ts[0] * k0;
              L1 += Math.exp(-o1) * Ts[1] * k0;
              L2 += Math.exp(-o2) * Ts[2] * k0;
            }
          }
        }
        // Integrated over the sphere with the isotropic phase 1/(4 pi) and uniform directions,
        // both the second-order light and the transfer factor are plain means over directions.
        L0 /= NDIR; L1 /= NDIR; L2 /= NDIR;
        F0 = Math.min(0.95, F0 / NDIR);
        F1 = Math.min(0.95, F1 / NDIR);
        F2 = Math.min(0.95, F2 / NDIR);
        const o = (j * MW + i) * 3;
        // Geometric series over all higher orders (Hillaire 2020, eq. 9).
        this.ms[o] = L0 / (1 - F0);
        this.ms[o + 1] = L1 / (1 - F1);
        this.ms[o + 2] = L2 / (1 - F2);
      }
    }
  }

  /** Multiple scattering source (per unit irradiance, per unit scattering coefficient) at radius r. */
  multiScattering(r: number, muS: number, out: Float64Array): void {
    const h = Math.max(0, r - RG);
    const x = (0.5 + 0.5 * Math.max(-1, Math.min(1, muS))) * (MW - 1);
    const y = Math.min(1, Math.sqrt(h / 100)) * (MH - 1);
    const i0 = Math.min(MW - 2, Math.floor(x)), j0 = Math.min(MH - 2, Math.floor(y));
    const fx = x - i0, fy = y - j0;
    const M = this.ms;
    const a = (j0 * MW + i0) * 3, b = a + 3, c = a + MW * 3, e = c + 3;
    for (let k = 0; k < 3; k++) {
      const top = M[a + k] + (M[b + k] - M[a + k]) * fx;
      const bot = M[c + k] + (M[e + k] - M[c + k]) * fx;
      out[k] = top + (bot - top) * fy;
    }
  }

  /**
   * Integrate one view ray for a light at elevation `lightEl`: writes A (Rayleigh with phase plus
   * multiple scattering) into a[ao..ao+2] and B (Mie without phase) into b[bo..bo+2].
   */
  integrate(viewEl: number, azimuth: number, lightEl: number, steps: number, a: Float32Array, ao: number, b: Float32Array, bo: number): void {
    const r0 = this.r0;
    const cl = Math.cos(viewEl);
    const vx = cl * Math.cos(azimuth), vy = Math.sin(viewEl), vz = cl * Math.sin(azimuth);
    const sx = Math.cos(lightEl), sy = Math.sin(lightEl); // light along +x, sz = 0
    const cosT = vx * sx + vy * sy;
    const pr = rayleighPhase(cosT);
    const tg = distToGround(r0, vy);
    const tMax = tg >= 0 ? tg : distToTop(r0, vy);
    const Ts = this.tmp;
    const TT = this.trans, MM = this.ms;
    const br0 = BR[0], br1 = BR[1], br2 = BR[2], oz0 = OZ[0], oz1 = OZ[1], oz2 = OZ[2];
    let o0 = 0, o1 = 0, o2 = 0;
    let R0 = 0, R1 = 0, R2 = 0, S0 = 0, S1 = 0, S2 = 0, Q0 = 0, Q1 = 0, Q2 = 0;
    let tPrev = 0;
    // Everything below is inlined by hand: this loop runs ~30k times per table.
    for (let s = 0; s < steps; s++) {
      // Quadratic spacing: dense near the observer where the air is thickest.
      const u1 = (s + 1) / steps;
      const t1 = tMax * u1 * u1;
      const dt = t1 - tPrev;
      const t = tPrev + dt * 0.5;
      tPrev = t1;
      const px = vx * t, py = r0 + vy * t, pz = vz * t;
      const rp = Math.sqrt(px * px + py * py + pz * pz);
      const h = rp - RG;
      const dR = Math.exp(-h / HR), dM = Math.exp(-h / HM);
      const dO = h > 10 && h < 40 ? 1 - Math.abs(h - 25) / 15 : 0;
      const e0 = br0 * dR + MIE_E * dM + oz0 * dO;
      const e1 = br1 * dR + MIE_E * dM + oz1 * dO;
      const e2 = br2 * dR + MIE_E * dM + oz2 * dO;
      const hdt = dt * 0.5;
      const tr0 = Math.exp(-(o0 + e0 * hdt)), tr1 = Math.exp(-(o1 + e1 * hdt)), tr2 = Math.exp(-(o2 + e2 * hdt));
      o0 += e0 * dt;
      o1 += e1 * dt;
      o2 += e2 * dt;
      const muS = (px * sx + py * sy) / rp;
      // light transmittance with the soft earth shadow
      const kk = RG / rp;
      const sq = Math.sqrt(Math.max(0, 1 - kk * kk));
      let vis = (muS + sq + SUN_SOFT) / (2 * SUN_SOFT);
      let T0 = 0, T1 = 0, T2 = 0;
      if (vis > 0) {
        if (vis > 1) vis = 1;
        else vis = vis * vis * (3 - 2 * vis);
        const rho = rp * sq;
        const dist = -rp * muS + Math.sqrt(Math.max(0, rp * rp * (muS * muS - 1) + RT * RT));
        const dMin = RT - rp, dMax = rho + H_TOP;
        let x = (dist - dMin) / (dMax - dMin);
        x = (x < 0 ? 0 : x > 1 ? 1 : x) * (TW - 1);
        let y = rho / H_TOP;
        y = (y > 1 ? 1 : y) * (TH - 1);
        let i0 = x | 0, j0 = y | 0;
        if (i0 > TW - 2) i0 = TW - 2;
        if (j0 > TH - 2) j0 = TH - 2;
        const fx = x - i0, fy = y - j0;
        const ia = (j0 * TW + i0) * 3, ic = ia + TW * 3;
        const w00 = (1 - fx) * (1 - fy) * vis, w10 = fx * (1 - fy) * vis, w01 = (1 - fx) * fy * vis, w11 = fx * fy * vis;
        T0 = TT[ia] * w00 + TT[ia + 3] * w10 + TT[ic] * w01 + TT[ic + 3] * w11;
        T1 = TT[ia + 1] * w00 + TT[ia + 4] * w10 + TT[ic + 1] * w01 + TT[ic + 4] * w11;
        T2 = TT[ia + 2] * w00 + TT[ia + 5] * w10 + TT[ic + 2] * w01 + TT[ic + 5] * w11;
      }
      // multiple scattering
      let mx = (0.5 + 0.5 * (muS < -1 ? -1 : muS > 1 ? 1 : muS)) * (MW - 1);
      let my = Math.sqrt((h > 0 ? h : 0) / 100);
      my = (my > 1 ? 1 : my) * (MH - 1);
      let mi = mx | 0, mj = my | 0;
      if (mi > MW - 2) mi = MW - 2;
      if (mj > MH - 2) mj = MH - 2;
      mx -= mi;
      my -= mj;
      const ma = (mj * MW + mi) * 3, mc = ma + MW * 3;
      const v00 = (1 - mx) * (1 - my), v10 = mx * (1 - my), v01 = (1 - mx) * my, v11 = mx * my;
      const M0 = MM[ma] * v00 + MM[ma + 3] * v10 + MM[mc] * v01 + MM[mc + 3] * v11;
      const M1 = MM[ma + 1] * v00 + MM[ma + 4] * v10 + MM[mc + 1] * v01 + MM[mc + 4] * v11;
      const M2 = MM[ma + 2] * v00 + MM[ma + 5] * v10 + MM[mc + 2] * v01 + MM[mc + 5] * v11;
      const rr = dR * dt, mm = MIE_S * dM * dt;
      R0 += tr0 * T0 * br0 * rr;
      R1 += tr1 * T1 * br1 * rr;
      R2 += tr2 * T2 * br2 * rr;
      S0 += tr0 * T0 * mm;
      S1 += tr1 * T1 * mm;
      S2 += tr2 * T2 * mm;
      Q0 += tr0 * M0 * (br0 * rr + mm);
      Q1 += tr1 * M1 * (br1 * rr + mm);
      Q2 += tr2 * M2 * (br2 * rr + mm);
    }
    let g0 = 0, g1 = 0, g2 = 0;
    if (tg >= 0) {
      // Below the horizon: far snowfields, lit by the light and seen through the air.
      const gx = vx * tg, gy = r0 + vy * tg, gz = vz * tg;
      const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
      const muG = (gx * sx + gy * sy) / gr;
      if (muG > 0) {
        this.lightTransmittance(gr, muG, Ts);
        const k = (GROUND_ALBEDO / Math.PI) * muG;
        g0 = Math.exp(-o0) * Ts[0] * k;
        g1 = Math.exp(-o1) * Ts[1] * k;
        g2 = Math.exp(-o2) * Ts[2] * k;
      }
    }
    a[ao] = pr * R0 + Q0 + g0;
    a[ao + 1] = pr * R1 + Q1 + g1;
    a[ao + 2] = pr * R2 + Q2 + g2;
    b[bo] = S0;
    b[bo + 1] = S1;
    b[bo + 2] = S2;
  }
}

// ---------------------------------------------------------------------------------------------
// Sky-view table for one light, double buffered, built a few rows per frame.
// ---------------------------------------------------------------------------------------------

export class SkyLut {
  readonly w: number;
  readonly h: number;
  readonly steps: number;
  readonly texA: THREE.DataTexture;
  readonly texB: THREE.DataTexture;
  /** Multiply texture values by this to get radiance per unit irradiance. */
  scale = 1;
  /** Light elevation (radians) the textures currently hold; NaN before the first build. */
  elevation = NaN;
  /** Bumped every time new tables are uploaded. */
  version = 0;
  private atm: Atmosphere;
  private a: Float32Array; // live CPU copy (unscaled)
  private b: Float32Array;
  private na: Float32Array; // being built
  private nb: Float32Array;
  private buildEl = NaN;
  private row = -1;
  private half16A: Uint16Array;
  private half16B: Uint16Array;

  constructor(atm: Atmosphere, w: number, h: number, steps: number) {
    this.atm = atm;
    this.w = w;
    this.h = h;
    this.steps = steps;
    const n = w * h * 3;
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.na = new Float32Array(n);
    this.nb = new Float32Array(n);
    this.half16A = new Uint16Array(w * h * 4);
    this.half16B = new Uint16Array(w * h * 4);
    const make = (data: Uint16Array, name: string): THREE.DataTexture => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      t.name = name;
      t.needsUpdate = true;
      return t;
    };
    this.texA = make(this.half16A, 'SkyLut.A');
    this.texB = make(this.half16B, 'SkyLut.B');
  }

  get busy(): boolean {
    return this.row >= 0;
  }

  /** Elevation the tables hold, or are being built for. */
  get target(): number {
    return this.row >= 0 ? this.buildEl : this.elevation;
  }

  /** Begin (or restart) building tables for a light at elevation el. */
  start(el: number): void {
    this.buildEl = el;
    this.row = 0;
  }

  /** Build up to `rows` rows; returns true when new tables were swapped in. */
  step(rows: number): boolean {
    if (this.row < 0) return false;
    const { w, h, steps } = this;
    const end = Math.min(h, this.row + rows);
    for (let j = this.row; j < end; j++) {
      const l = vToElevation((j + 0.5) / h);
      for (let i = 0; i < w; i++) {
        const phi = ((i + 0.5) / w) * Math.PI;
        const o = (j * w + i) * 3;
        this.atm.integrate(l, phi, this.buildEl, steps, this.na, o, this.nb, o);
      }
    }
    this.row = end;
    if (end < h) return false;
    this.row = -1;
    this.swap();
    return true;
  }

  /** Build the whole table now (big jumps of the clock, benches). */
  buildNow(el: number): void {
    this.start(el);
    this.step(this.h);
  }

  private swap(): void {
    let t = this.a;
    this.a = this.na;
    this.na = t;
    t = this.b;
    this.b = this.nb;
    this.nb = t;
    this.elevation = this.buildEl;
    let m = 1e-12;
    const n = this.w * this.h * 3;
    for (let k = 0; k < n; k++) {
      if (this.a[k] > m) m = this.a[k];
      if (this.b[k] > m) m = this.b[k];
    }
    this.scale = m;
    const inv = 1 / m;
    const toHalf = THREE.DataUtils.toHalfFloat;
    const HA = this.half16A, HB = this.half16B;
    const one = toHalf(1);
    for (let p = 0, q = 0; p < n; p += 3, q += 4) {
      HA[q] = toHalf(this.a[p] * inv);
      HA[q + 1] = toHalf(this.a[p + 1] * inv);
      HA[q + 2] = toHalf(this.a[p + 2] * inv);
      HA[q + 3] = one;
      HB[q] = toHalf(this.b[p] * inv);
      HB[q + 1] = toHalf(this.b[p + 1] * inv);
      HB[q + 2] = toHalf(this.b[p + 2] * inv);
      HB[q + 3] = one;
    }
    this.texA.needsUpdate = true;
    this.texB.needsUpdate = true;
    this.version++;
  }

  /**
   * Radiance per unit irradiance toward a view direction at elevation `l` and azimuth `phi` from
   * the light (0..pi), with cosTheta the cosine of the angle between view and light. Adds the Mie
   * phase like the shader does.
   */
  sample(l: number, phi: number, cosTheta: number, out: Float64Array | number[]): void {
    if (Number.isNaN(this.elevation)) {
      out[0] = out[1] = out[2] = 0;
      return;
    }
    const { w, h } = this;
    const x = Math.max(0, Math.min(w - 1, (phi / Math.PI) * w - 0.5));
    const y = Math.max(0, Math.min(h - 1, elevationToV(l) * h - 0.5));
    const i0 = Math.min(w - 2, Math.floor(x)), j0 = Math.min(h - 2, Math.floor(y));
    const fx = x - i0, fy = y - j0;
    const pm = miePhase(cosTheta);
    const A = this.a, B = this.b;
    const a = (j0 * w + i0) * 3, b = a + 3, c = a + w * 3, e = c + 3;
    for (let k = 0; k < 3; k++) {
      const ta = A[a + k] + (A[b + k] - A[a + k]) * fx, ba = A[c + k] + (A[e + k] - A[c + k]) * fx;
      const tb = B[a + k] + (B[b + k] - B[a + k]) * fx, bb = B[c + k] + (B[e + k] - B[c + k]) * fx;
      out[k] = ta + (ba - ta) * fy + pm * (tb + (bb - tb) * fy);
    }
  }

  dispose(): void {
    this.texA.dispose();
    this.texB.dispose();
  }
}
