// Reading the snow-deformation map in a material (the terrain calls these). One sampled texture,
// U.trailTex: a 2:1 atlas [near | far] when U.trailFar.w = 1, else the near window alone.
//
//   near  R floor depth (x DEPTH_MAX m, dilated past the edge), G edge distance (0.5 = the wall,
//         > 0.5 inside, +-SDF_RANGE m), B raised snow (x RIM_MAX m), A freshness (x 1.25)
//   far   R depth (area-weighted, soft), G 1 near any trail, A freshness
// U.trailFill holds what the snow has filled in since each window was last re-rendered (subtracted
// here, so prints fill smoothly between re-renders). U.trailOn = 1 is the contract's plain map
// (R = depth x LEGACY_DEPTH, no edges), as the TERRAIN bench's test painter writes it.
//
// The wall of a print comes from the edge distance: bilinear filtering keeps an edge distance
// exact to a fraction of a texel, so the wall stays a crisp line at any magnification while the
// floor depth and the rims can be coarse. The surface gradient is analytic (chain rule through the
// wall profile), so a 4 cm texel map still shades a 1 cm wall. Owner: SNOW.
import { Break, Fn, If, Loop, abs, clamp, float, max, min, mix, select, smoothstep, vec2, vec4 } from 'three/tsl';
import { U } from '../shared';
import { DEPTH_MAX, LEGACY_DEPTH, RIM_MAX, SDF_RANGE, WALL } from './config';

type N = any;

/** Window uv of world xz for a window centred at `o` (vec2) that is `size` metres across. */
const winUV = (xz: N, o: N, size: N): N => xz.sub(o).div(size).add(0.5);
const inside01 = (uv: N): N => uv.x.greaterThanEqual(0).and(uv.x.lessThanEqual(1)).and(uv.y.greaterThanEqual(0)).and(uv.y.lessThanEqual(1));

/** Atlas uv of a near-window uv (clamped half a texel inside the near half). */
function nearAtlas(uv: N): N {
  const t: N = U.trailTexel;
  return vec2(clamp(uv.x.mul(U.trailAtlas.x), t.x.mul(0.5), U.trailAtlas.x.sub(t.x.mul(0.5))), clamp(uv.y, t.y.mul(0.5), float(1).sub(t.y.mul(0.5))));
}
/** Atlas uv of a far-window uv. */
function farAtlas(uv: N): N {
  const t: N = U.trailTexel;
  const a: N = U.trailAtlas;
  return vec2(clamp(uv.x.mul(a.z).add(a.y), a.y.add(t.x.mul(0.5)), a.y.add(a.z).sub(t.x.mul(0.5))), clamp(uv.y.mul(a.w), t.y.mul(0.5), a.w.sub(t.y.mul(0.5))));
}
const tap = (auv: N): N => (U.trailTex as N).sample(auv).level(0);

/** vec4(depth m, edge distance m (> 0 inside), rim m, freshness 0..1) of a near tap. */
function decodeNear(t: N): N {
  const snow: N = U.trailOn.greaterThan(1.5);
  const f: N = U.trailFill;
  const d: N = select(snow, max(t.x.sub(f.x), 0).mul(DEPTH_MAX), t.x.mul(LEGACY_DEPTH));
  const s: N = select(snow, t.y.sub(0.5).mul(2 * SDF_RANGE), float(1));
  const r: N = select(snow, max(t.z.sub(f.y), 0).mul(RIM_MAX), float(0));
  const fr: N = select(snow, max(t.w.sub(f.z), 0).mul(1.25), t.x);
  return vec4(d, s, r, fr);
}

/** Height (m, < 0 pressed) of a decoded tap with a wall of half width w. */
const heightOf = (q: N, w: N): N => {
  const ins: N = smoothstep(w.negate(), w, q.y);
  return q.z.mul(ins.oneMinus()).sub(q.x.mul(ins));
};

export interface TrailFrag {
  /** Height of the pressed surface relative to the untouched snow, m (< 0 in a print). */
  h: N;
  /** Its gradient (dh/dx, dh/dz). */
  grad: N;
  /** 0..1 compacted floor showing (pressed and not yet covered by fresh snow). */
  compact: N;
  /** 0..1 inside a print (the wall profile). */
  inside: N;
  /** Remaining depth of the print under this pixel, m. */
  depth: N;
  /** Raised loose snow (rims, kicked clumps), m. */
  rim: N;
  /** 1 where anything is pressed near this pixel (lets the lighting skip the shadow march). */
  near: N;
  /** World xz the view ray met the pressed surface at (the pixel's own xz without parallax). */
  xz: N;
}

/** Parallax inputs: what the surface shader knows about the view and the mesh at this pixel. */
export interface TrailParallax {
  /** Unit world direction from the camera to the pixel. */
  view: N;
  /** Macro slope of the ground (dh/dx, dh/dz). */
  slope: N;
  /** Height the mesh was already moved by trailVertex at this pixel, m (a varying). */
  dent: N;
}

/** Height (m) of the pressed surface at world xz, for the parallax march (no gradient). */
const heightAt = (xz: N): N => heightOf(decodeNear(tap(nearAtlas(winUV(xz, U.trailOrigin, U.trailSize)))), float(WALL));

/**
 * Parallax occlusion: follow the view ray from the mesh point down into the pressed surface and
 * return the xz where it meets it, so the near wall of a hole hides its floor and the far wall
 * shows. 12 linear steps over at most ~0.8 m of ray, then 4 halvings. Skipped at grazing angles
 * (the ray would run too far), where the mesh dent and the shading carry the depth instead.
 */
function parallax(xz: N, px: TrailParallax, out: N): void {
  const v: N = px.view;
  // the ray's descent per metre of travel, relative to the sloping ground (< 0: going down into it)
  const kd: N = v.y.sub(px.slope.x.mul(v.x)).sub(px.slope.y.mul(v.z));
  If(kd.lessThan(-0.12), () => {
    const h0: N = px.dent;
    // from where the ray is above any rim to where it is below the deepest hole, at most 0.8 m
    const t0: N = float(0.03).sub(h0).div(kd);
    const span: N = min(float(-0.4).sub(h0).div(kd).sub(t0), float(0.8).div(v.xz.length().max(0.05)));
    const dt: N = span.div(12);
    const tHi: N = t0.add(span).toVar();
    const tLo: N = t0.toVar();
    Loop(12, ({ i }: N) => {
      const tt: N = t0.add(dt.mul(float(i).add(1)));
      const p: N = xz.add(v.xz.mul(tt));
      If(h0.add(kd.mul(tt)).lessThanEqual(heightAt(p)), () => {
        tHi.assign(tt);
        tLo.assign(tt.sub(dt));
        Break();
      });
    });
    for (let k = 0; k < 4; k++) {
      const tm: N = tLo.add(tHi).mul(0.5);
      const below: N = h0.add(kd.mul(tm)).lessThanEqual(heightAt(xz.add(v.xz.mul(tm))));
      tHi.assign(select(below, tm, tHi));
      tLo.assign(select(below, tLo, tm));
    }
    out.assign(xz.add(v.xz.mul(tHi)));
  });
}

/**
 * Everything a surface shader needs from the map at world xz. `fp` = metres per pixel (from
 * screen derivatives, taken by the caller outside any branch); `px` turns on parallax. Call
 * inside a TSL Fn.
 */
export function trailFragment(xz0: N, fp: N, px?: TrailParallax): TrailFrag {
  const h: N = float(0).toVar('trH');
  const grad: N = vec2(0).toVar('trG');
  const compact: N = float(0).toVar('trC');
  const ins: N = float(0).toVar('trI');
  const depth: N = float(0).toVar('trD');
  const rim: N = float(0).toVar('trR');
  const near: N = float(0).toVar('trN');
  const xz: N = vec2(xz0).toVar('trXZ'); // where the view ray meets the pressed surface

  const on: N = U.trailOn.greaterThan(0.5);
  const uv0: N = winUV(xz0, U.trailOrigin, U.trailSize);
  // fade the near window out over its last 7 % (the far map takes over there)
  const edgeN: N = min(min(uv0.x, uv0.x.oneMinus()), min(uv0.y, uv0.y.oneMinus()));
  const wN: N = select(on, smoothstep(0.0, 0.07, edgeN), float(0)).toVar();

  If(wN.greaterThan(0), () => {
    const c0: N = decodeNear(tap(nearAtlas(uv0)));
    const present: N = c0.y.greaterThan(-SDF_RANGE * 0.98).or(c0.z.greaterThan(0.0005)).or(c0.x.greaterThan(0.0005));
    if (px) {
      If(present.and(U.trailOn.greaterThan(1.5)), () => {
        parallax(xz0, px, xz);
      });
    }
    const uvN: N = winUV(xz, U.trailOrigin, U.trailSize);
    const c: N = decodeNear(tap(nearAtlas(uvN))).toVar();
    // anything here or within the edge-distance range of it
    If(present, () => {
      const t: N = U.trailTexel;
      const qxp: N = decodeNear(tap(nearAtlas(uvN).add(vec2(t.x, 0))));
      const qxn: N = decodeNear(tap(nearAtlas(uvN).sub(vec2(t.x, 0))));
      const qzp: N = decodeNear(tap(nearAtlas(uvN).add(vec2(0, t.y))));
      const qzn: N = decodeNear(tap(nearAtlas(uvN).sub(vec2(0, t.y))));
      const tm: N = U.trailSize.mul(t.y); // metres per near texel (the near window spans the atlas height)
      const gx: N = qxp.sub(qxn).div(tm.mul(2)); // d/dx of (depth, sdf, rim, fresh)
      const gz: N = qzp.sub(qzn).div(tm.mul(2));
      // the wall: physically ~1 cm wide, never sharper than the pixel (no shimmer at a distance)
      const w: N = max(float(WALL), fp.mul(0.9));
      const k: N = clamp(c.y.add(w).div(w.mul(2)), 0, 1);
      const i0: N = k.mul(k).mul(k.mul(-2).add(3));
      const iD: N = k.mul(k.oneMinus()).mul(6).div(w.mul(2)); // d inside / d sdf
      const dsdf: N = vec2(gx.y, gz.y);
      const dd: N = vec2(gx.x, gz.x);
      const dr: N = vec2(gx.z, gz.z);
      const gh: N = dr.mul(i0.oneMinus()).sub(dsdf.mul(c.z.mul(iD))).sub(dd.mul(i0)).sub(dsdf.mul(c.x.mul(iD)));
      // keep walls under ~72 deg: steeper normal-mapped walls turn black at grazing angles
      const gl: N = gh.length();
      grad.assign(gh.mul(min(float(1), float(3).div(gl.max(1e-4)))).mul(wN));
      h.assign(c.z.mul(i0.oneMinus()).sub(c.x.mul(i0)).mul(wN));
      ins.assign(i0.mul(wN));
      depth.assign(c.x.mul(i0).mul(wN));
      rim.assign(c.z.mul(i0.oneMinus()).mul(wN));
      compact.assign(i0.mul(clamp(c.w, 0, 1)).mul(smoothstep(0.003, 0.02, c.x)).mul(wN));
      near.assign(wN);
    });
  });

  // far map: trails behind you as soft grooves, where the near window does not reach
  If(U.trailFar.w.greaterThan(0.5).and(wN.lessThan(0.999)).and(on), () => {
    const uvF: N = winUV(xz0, U.trailFar.xy, U.trailFar.z).toVar();
    If(inside01(uvF), () => {
      const c: N = tap(farAtlas(uvF)).toVar();
      If(c.y.greaterThan(0.01), () => {
        const t: N = U.trailTexel;
        const a: N = U.trailAtlas;
        const du: N = t.x.div(a.z), dv: N = t.y.div(a.w); // one far texel in far-window uv
        const dF = (v: N): N => max(v.x.sub(U.trailFill.w), 0).mul(DEPTH_MAX);
        const d0: N = dF(c);
        const xp: N = dF(tap(farAtlas(uvF.add(vec2(du, 0)))));
        const xn: N = dF(tap(farAtlas(uvF.sub(vec2(du, 0)))));
        const zp: N = dF(tap(farAtlas(uvF.add(vec2(0, dv)))));
        const zn: N = dF(tap(farAtlas(uvF.sub(vec2(0, dv)))));
        const tm: N = U.trailFar.z.mul(du);
        const gF: N = vec2(xp.sub(xn), zp.sub(zn)).div(tm.mul(2)).negate();
        const wF: N = wN.oneMinus();
        h.assign(mix(d0.negate(), h, wN));
        grad.assign(grad.add(gF.mul(wF)));
        depth.assign(mix(d0, depth, wN));
        ins.assign(mix(smoothstep(0.004, 0.03, d0), ins, wN));
        compact.assign(mix(smoothstep(0.004, 0.04, d0).mul(clamp(c.w.sub(0), 0, 1)).mul(1.25).min(1), compact, wN));
      });
    });
  });

  return { h, grad, compact, inside: ins, depth, rim, near, xz };
}

/**
 * Lit fraction 0..1 of a light coming from world direction `l` (unit, toward the light) at a
 * pixel of print height `h0`: a short march through the near map toward the light, so a print's
 * own wall and rim shade its floor at a low sun. `near` > 0 where anything is pressed nearby
 * (TrailFrag.near); 1 elsewhere, at no cost.
 */
export const trailShadow = Fn(([xz, h0, l, near]: N[]) => {
  const lit: N = float(1).toVar();
  const len: N = l.xz.length();
  If(near.greaterThan(0.001).and(len.greaterThan(0.02)).and(U.trailOn.greaterThan(1.5)), () => {
    const dir: N = l.xz.div(len);
    const tanE: N = l.y.div(len).max(0.02);
    const uv0: N = winUV(xz, U.trailOrigin, U.trailSize);
    const tm: N = U.trailSize.mul(U.trailTexel.y); // metres per texel
    const occ: N = float(0).toVar();
    // 1, 2, 3.5, 5.5, 8 texels: a boot print's width at 2-4 cm texels
    for (const k of [1, 2, 3.5, 5.5, 8]) {
      const dist: N = tm.mul(k);
      const q: N = decodeNear(tap(nearAtlas(uv0.add(dir.mul(dist).div(U.trailSize)))));
      const hk: N = heightOf(q, float(0.015));
      const ray: N = h0.add(dist.mul(tanE));
      // the penumbra widens with distance from the occluder
      occ.assign(max(occ, hk.sub(ray).div(dist.mul(0.08).add(0.004))));
    }
    lit.assign(float(1).sub(smoothstep(0, 1, occ)));
  });
  return lit;
});

/**
 * Height offset (m) for a terrain vertex at world xz: the map low-passed over ~15 cm (vertices
 * are 25 cm apart: a sharp print would alias into spikes), plus the far map. Vertex stage only.
 */
export function trailVertex(xz: N): N {
  const y: N = float(0).toVar('trV');
  const on: N = U.trailOn.greaterThan(0.5);
  const uvN: N = winUV(xz, U.trailOrigin, U.trailSize);
  const edgeN: N = min(min(uvN.x, uvN.x.oneMinus()), min(uvN.y, uvN.y.oneMinus()));
  const wN: N = select(on, smoothstep(0.0, 0.07, edgeN), float(0));
  If(wN.greaterThan(0), () => {
    const o: N = float(0.075).div(U.trailSize);
    const s: N = float(0).toVar();
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      s.addAssign(heightOf(decodeNear(tap(nearAtlas(uvN.add(vec2(o.mul(dx), o.mul(dz)))))), float(0.03)));
    }
    y.assign(s.mul(0.25 * 0.9).mul(wN));
  });
  If(U.trailFar.w.greaterThan(0.5).and(wN.lessThan(0.999)).and(on), () => {
    const uvF: N = winUV(xz, U.trailFar.xy, U.trailFar.z);
    If(inside01(uvF), () => {
      const d: N = max(tap(farAtlas(uvF)).x.sub(U.trailFill.w), 0).mul(DEPTH_MAX);
      y.assign(mix(d.negate(), y, wN));
    });
  });
  return y;
}

/** Raw near-window texel at world xz (debug views): (R x 2, G, B x 4). */
export function trailDebug(xz: N): N {
  const uvN: N = winUV(xz, U.trailOrigin, U.trailSize);
  const t: N = tap(nearAtlas(uvN));
  return vec4(t.x.mul(2), t.y, t.z.mul(4), 1).xyz.mul(select(inside01(uvN), float(1), float(0.2)));
}

void abs;
