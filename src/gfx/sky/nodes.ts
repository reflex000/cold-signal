// Shader side of the sky: the dome drawn behind the world and the cheaper version of it that is
// rendered into the environment cube. One radiance function, two levels of detail.
//
//   clear sky (tables + Mie phase per pixel)  + night floor
//   + stars (procedural, turning about the celestial pole)  + Milky Way glow
//   + sun disc (limb darkened)  + moon disc (Lommel-Seeliger phase, maria, earthshine)
//   + aurora (2.5D march through curtains, green / red tops / violet hems)     quality.auroraSteps
//   -> cloud deck (2.5D march through a slab; a flat grey ceiling at full cover) quality.cloudSteps
//   -> storm fog swallows it (same fog model as the world)
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { U } from '../shared';
import { MOON_RADIUS, SUN_RADIUS } from './astro';
import { AIR, SKY, clearSky, fogColor, fogDepth, fogDepthSky, hgPhase, type N } from './common';
import { getNoise2D } from './textures';

const {
  Fn, If, Loop, uniform, texture, vec2, vec3, vec4, float, abs, clamp, max, min, dot, cross, normalize, exp, sqrt, mix, smoothstep,
  select, length, fract, floor, sin, hash, dFdx, dFdy, positionLocal, positionWorldDirection, cameraViewMatrix, cameraProjectionMatrix,
  interleavedGradientNoise, screenCoordinate,
} = TSL as any;

/** Uniforms only the sky's own shaders read. Written by the sky system. */
export const SKYU = {
  /** World -> star frame rotation (transpose of astro.starFrame). */
  starRot: uniform(new THREE.Matrix3()),
  /** Radiant flux scale of the stars (0 in daylight; the sky's own brightness hides them anyway). */
  starFlux: uniform(0),
  /** Radiance at the centre of the sun's disc and of a fully lit moon (transmitted, capped). */
  sunDisc: uniform(new THREE.Vector3()),
  moonDisc: uniform(new THREE.Vector3()),
  // cloud deck (km above the observer, km of wind drift)
  cloudOffset: uniform(new THREE.Vector2()),
  cloudBase: uniform(1.9),
  cloudThick: uniform(1.1),
  cloudDensity: uniform(9), // extinction of the densest cloud, 1/km
  /** Irradiance lighting the clouds from cloudLightDir (sun, or the moon at night). */
  cloudLight: uniform(new THREE.Vector3()),
  cloudLightDir: uniform(new THREE.Vector3(0, 1, 0)),
  /** Radiance of the ambient light inside the deck at its top (blue sky) and its base (snow bounce). */
  cloudAmbTop: uniform(new THREE.Vector3()),
  cloudAmbBottom: uniform(new THREE.Vector3()),
  /** Aurora radiance scale (0 = off). */
  auroraE: uniform(0),
  /** Radiance of the snow below the horizon, for the environment cube. */
  groundRad: uniform(new THREE.Vector3(0.1, 0.1, 0.1)),
};

const noise = (): N => texture(getNoise2D());

/** Angular size of a pixel, radians (derivatives: call outside any branch). */
function pixelAngle(d: N): N {
  return max(length(dFdx(d)), length(dFdy(d))).max(1e-5);
}

// ---------------------------------------------------------------------------------------------
// Stars
// ---------------------------------------------------------------------------------------------

function stars(d: N, px: N): N {
  const q = SKYU.starRot.mul(d).toVar();
  const a = abs(q);
  const isX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const isY = isX.not().and(a.y.greaterThanEqual(a.z));
  const m = max(a.x, max(a.y, a.z));
  const uvF = select(isX, vec2(q.y, q.z), select(isY, vec2(q.x, q.z), vec2(q.x, q.y))).div(m);
  const face = select(isX, select(q.x.greaterThan(0), float(0), float(1)), select(isY, select(q.y.greaterThan(0), float(2), float(3)), select(q.z.greaterThan(0), float(4), float(5))));
  const G = 96; // cells per face edge: 55k cells, a third of them hold a star
  const g = uvF.mul(0.5).add(0.5).mul(G);
  const cell = floor(g);
  const seed = cell.x.add(cell.y.mul(G)).add(face.mul(G * G)).add(17);
  const h1 = hash(seed);
  const h2 = hash(seed.add(91331));
  const h3 = hash(seed.add(57731));
  const h4 = hash(seed.add(23117));
  const h5 = hash(seed.add(77003));
  // star direction from its position in the cell
  const su = cell.add(vec2(h2, h3).mul(0.6).add(0.2)).div(G).mul(2).sub(1);
  const sgn = (v: N): N => select(v.greaterThan(0), float(1), float(-1));
  const sd = normalize(select(isX, vec3(sgn(q.x), su.x, su.y), select(isY, vec3(su.x, sgn(q.y), su.y), vec3(su.x, su.y, sgn(q.z)))));
  const chord2 = dot(q.sub(sd), q.sub(sd));
  // A star is a point: draw it about a pixel wide with constant flux, so it never aliases.
  const sigma = px.mul(0.62);
  const s2 = sigma.mul(sigma);
  // Few bright stars, many faint ones.
  const flux = h4.pow(24).mul(30).add(h4.pow(6).mul(2.5)).add(0.15);
  const exists = select(h1.lessThan(0.36), float(1), float(0));
  const col = mix(vec3(1.0, 0.78, 0.56), vec3(0.78, 0.86, 1.0), h5);
  // Twinkle low in the sky, where the air is thick.
  const low = smoothstep(0.0, 0.45, d.y).oneMinus();
  const tw = float(1).add(sin(U.time.mul(h2.mul(9).add(6)).add(h3.mul(6.283))).mul(0.45).mul(low));
  const ext = exp(float(-0.12).div(max(d.y, 0.02))).mul(smoothstep(-0.01, 0.03, d.y));
  const star = col.mul(flux.mul(exists).mul(exp(chord2.div(s2.mul(-2)))).div(s2.mul(2 * Math.PI))).mul(tw);
  // Milky Way: a faint, mottled band along a great circle of the star frame.
  const gp = vec3(0.42, -0.36, 0.83).normalize();
  const gb = dot(q, gp);
  const band = exp(gb.mul(gb).mul(-22));
  const mott = noise().sample(vec2(q.x.add(q.z.mul(0.5)), q.y.sub(q.z.mul(0.3))).mul(1.7)).g;
  const milky = vec3(0.75, 0.8, 1.0).mul(band.mul(mott.mul(1.3).sub(0.2).max(0))).mul(0.0009);
  return star.mul(SKYU.starFlux).add(milky.mul(SKYU.starFlux.mul(1e6).min(1))).mul(ext);
}

// ---------------------------------------------------------------------------------------------
// Sun and moon discs
// ---------------------------------------------------------------------------------------------

function sunDisc(d: N, px: N): N {
  const c = dot(d, U.sunDir);
  const r = sqrt(max(float(1).sub(c).mul(2), 0)).div(SUN_RADIUS);
  const soft = px.div(SUN_RADIUS);
  const edge = smoothstep(float(1).sub(soft), float(1).add(soft), r).oneMinus();
  const mu = sqrt(max(r.mul(r).oneMinus(), 0));
  const limb = float(1).sub(mu.oneMinus().mul(0.62));
  return vec3(SKYU.sunDisc).mul(edge.mul(limb));
}

function moonDisc(d: N, px: N): N {
  const m = vec3(U.moonDir);
  const rt = normalize(cross(m, vec3(0.0001, 1, 0)));
  const up = cross(rt, m);
  const p = vec2(dot(d, rt), dot(d, up)).div(MOON_RADIUS);
  const r2 = dot(p, p);
  const soft = px.div(MOON_RADIUS);
  const inside = smoothstep(float(1).sub(soft), float(1).add(soft), sqrt(r2)).oneMinus().mul(select(dot(d, m).greaterThan(0.99), float(1), float(0)));
  const z = sqrt(max(r2.oneMinus(), 0));
  const n = rt.mul(p.x).add(up.mul(p.y)).sub(m.mul(z));
  // Lommel-Seeliger: a flat full moon with a crisp terminator.
  const mu0 = dot(n, U.sunDir).max(0);
  const lit = mu0.div(mu0.add(z).add(1e-3)).mul(2);
  const maria = noise().sample(p.mul(0.23).add(vec2(0.31, 0.47))).r;
  const albedo = smoothstep(0.38, 0.62, maria).mul(0.32).add(0.62);
  const earthshine = 0.006;
  return vec3(SKYU.moonDisc).mul(inside.mul(albedo).mul(lit.add(earthshine)));
}

// ---------------------------------------------------------------------------------------------
// Aurora
// ---------------------------------------------------------------------------------------------

function aurora(d: N, steps: number, jitter: N, px: N): N {
  const acc = vec3(0).toVar();
  If(SKYU.auroraE.greaterThan(0.0001).and(d.y.greaterThan(0.005)), () => {
    const tex = noise();
    const t = U.time;
    Loop(steps, ({ i }: { i: N }) => {
      const hh = mix(float(1.0), float(2.9), float(i).add(jitter).div(steps));
      const dist = hh.div(max(d.y, 0.035));
      const p = vec2(d.x, d.z).mul(dist);
      // Pixel footprint in curtain units -> explicit mip level (this runs in a per-pixel branch).
      const lod = clamp(dist.mul(px).div(max(d.y, 0.05)).mul(128 * 0.045).max(1e-4).log2(), 0, 6);
      // The auroral oval lies to the north (-Z), low over the ridge.
      const gate = smoothstep(0.25, 1.4, p.y.negate()).mul(smoothstep(7.0, 14.0, p.y.negate()).oneMinus());
      // East-west arcs that fold and drift.
      const w1 = tex.sample(p.mul(0.045).add(vec2(t.mul(0.0035), t.mul(-0.0011)))).level(lod).r;
      const w2 = tex.sample(p.mul(0.11).add(vec2(t.mul(-0.0052), t.mul(0.0021)))).level(lod.add(1.3)).g;
      const b = p.y.mul(0.42).add(w1.sub(0.5).mul(3.2)).add(w2.sub(0.5).mul(0.9));
      const f = abs(fract(b).sub(0.5));
      const sheet = exp(f.mul(f).mul(-180));
      // Vertical rays: sampled along the arc only, so they stand upright.
      const rays = tex.sample(vec2(p.x.mul(0.55).add(w1.mul(2.0)).add(t.mul(0.004)), 0.37)).level(lod).b;
      const curtain = sheet.mul(rays.mul(1.1).add(0.25)).mul(gate);
      const green = exp(hh.sub(1.28).div(0.33).pow(2).negate()).mul(smoothstep(1.0, 1.07, hh));
      const red = smoothstep(1.55, 2.25, hh).mul(smoothstep(2.4, 2.9, hh).oneMinus());
      const hem = exp(hh.sub(1.035).div(0.045).pow(2).negate());
      const col = vec3(0.1, 1.0, 0.32).mul(green).add(vec3(0.85, 0.1, 0.16).mul(red.mul(0.42))).add(vec3(0.55, 0.12, 1.0).mul(hem.mul(0.55)));
      acc.addAssign(col.mul(curtain));
    });
    acc.mulAssign(SKYU.auroraE.div(steps));
  });
  return acc;
}

// ---------------------------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------------------------

/** Distance (km) along unit d from the observer to a shell h km above it (earth curvature). */
function shellDist(dy: N, h: N): N {
  const r0 = 6360;
  const b = dy.mul(r0);
  return b.negate().add(sqrt(b.mul(b).add(h.mul(2 * r0)).add(h.mul(h))));
}

/** Cloud density (1/km) at horizontal position xz (km) and height fraction hf in the deck. */
function cloudDensity(tex: N, xz: N, hf: N, cover: N, lod: N): N {
  const uv = xz.add(SKYU.cloudOffset).mul(1 / 22);
  // Explicit mip levels: these run inside per-pixel branches (WGSL forbids implicit derivatives there).
  const n1 = tex.sample(uv).level(lod).r;
  const n2 = tex.sample(uv.mul(3.7).add(0.31)).level(lod.add(1.9)).g;
  const base = n1.mul(0.68).add(n2.mul(0.32));
  // Rounded tops, flat-ish bases.
  const profile = smoothstep(0.0, 0.18, hf).mul(smoothstep(0.35, 1.0, hf).oneMinus());
  const thr = cover.oneMinus();
  const shape = smoothstep(thr.sub(0.05), thr.add(0.22), base.mul(mix(float(0.75), float(1.0), profile)));
  return shape.mul(profile).mul(SKYU.cloudDensity);
}

/** vec4(in-scattered radiance, transmittance) of the cloud deck toward d. */
function clouds(d: N, steps: number, jitter: N, behind: N, px: N): N {
  const cover = SKY.cover;
  const tex = noise();
  const res = vec4(0, 0, 0, 1).toVar();
  If(cover.greaterThan(0.02).and(d.y.greaterThan(-0.02)), () => {
    const dy = max(d.y, 0.0);
    const tb = shellDist(dy, SKYU.cloudBase);
    const tt = shellDist(dy, SKYU.cloudBase.add(SKYU.cloudThick));
    // Footprint of the pixel on the deck (km), stretched toward the horizon -> mip level of the
    // 0.17 km texels of the noise.
    const lod = clamp(tb.mul(px).div(max(dy, 0.06)).div(0.17).max(1e-4).log2(), 0, 7);
    const ld = vec3(SKYU.cloudLightDir);
    const cosT = dot(d, ld);
    // Bright forward lobe, a little back scatter; normalised phase (1/sr).
    const phase = mix(hgPhase(cosT, float(-0.2)), hgPhase(cosT, float(0.6)), 0.72);
    const S = vec3(0).toVar();
    const T = float(1).toVar();
    if (steps > 0) {
      const dt = tt.sub(tb).div(steps);
      Loop(steps, ({ i }: { i: N }) => {
        const hf = float(i).add(jitter).div(steps);
        const p = d.mul(tb.add(dt.mul(float(i).add(jitter))));
        const sig = cloudDensity(tex, vec2(p.x, p.z), hf, cover, lod);
        If(sig.greaterThan(0.01), () => {
          // One tap toward the light for self shadowing, plus a soft multiple-scattering floor.
          const pl = p.add(ld.mul(0.35));
          const sigL = cloudDensity(tex, vec2(pl.x, pl.z), min(hf.add(ld.y.mul(0.35).div(SKYU.cloudThick)), 1.0), cover, lod.add(0.5));
          const tl = max(exp(sigL.mul(-0.55)), exp(sigL.mul(-0.12)).mul(0.3));
          const powder = exp(sig.mul(-0.3)).oneMinus().mul(0.6).add(0.4);
          const lightS = vec3(SKYU.cloudLight).mul(tl.mul(phase).mul(powder));
          const amb = mix(vec3(SKYU.cloudAmbBottom), vec3(SKYU.cloudAmbTop), hf);
          const st = exp(sig.mul(dt).negate());
          S.addAssign(lightS.add(amb).mul(T.mul(st.oneMinus())));
          T.mulAssign(st);
        });
      });
    } else {
      // Mobile: one sample in the middle of the deck, lit by a gradient.
      const p = d.mul(tb.add(tt).mul(0.5));
      const sig = cloudDensity(tex, vec2(p.x, p.z), float(0.5), cover, lod);
      const st = exp(sig.mul(tt.sub(tb)).negate());
      const lit = vec3(SKYU.cloudLight).mul(phase.mul(0.6)).add(mix(vec3(SKYU.cloudAmbBottom), vec3(SKYU.cloudAmbTop), 0.4));
      S.assign(lit.mul(st.oneMinus()));
      T.assign(st);
    }
    // Far clouds sink into the haze of the horizon.
    const air = exp(tb.mul(-1 / 55));
    const horizonFade = smoothstep(-0.02, 0.04, d.y);
    const k = air.mul(horizonFade);
    // At full cover the deck closes into an even grey ceiling with soft darker rolls.
    const ovc = smoothstep(0.8, 0.99, cover);
    const roll = tex.sample(vec2(d.x, d.z).div(max(dy, 0.05)).mul(0.05).add(SKYU.cloudOffset.mul(0.02))).level(lod.sub(1).max(0)).r;
    const ceiling = vec3(SKY.overcast).mul(roll.mul(0.3).add(0.85));
    const col = mix(behind.mul(T).add(S), ceiling, ovc);
    const tr = mix(T, float(0), ovc);
    res.assign(vec4(mix(behind, col, k), mix(float(1), tr, k)));
  });
  return res;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

export interface SkyDetail {
  cloudSteps: number;
  auroraSteps: number;
  stars: boolean;
  discs: boolean;
}

/** Full sky radiance toward unit direction d. `px` is the pixel's angular size (for discs and stars). */
export function skyRadiance(d: N, px: N, o: SkyDetail, jitter: N, fogShare?: N): N {
  const L = clearSky(d).toVar();
  if (o.stars) {
    // A star is lost once the sky around it is much brighter than it (contrast threshold).
    const skyLum = dot(L, vec3(0.2126, 0.7152, 0.0722));
    L.addAssign(stars(d, px).div(skyLum.mul(60).add(1)));
  }
  if (o.discs) L.addAssign(sunDisc(d, px).add(moonDisc(d, px)));
  if (o.auroraSteps > 0) L.addAssign(aurora(d, o.auroraSteps, jitter, px));
  const c = clouds(d, o.cloudSteps, jitter, L, px);
  const lit = c.rgb;
  // The storm swallows the sky: the same fog the world gets, out to the edge of the world. Only
  // the snow in the air counts here: the clear-air haze is already part of the sky tables.
  const fa = exp(fogDepthSky(d.y, fogShare).mul(AIR.stormMix).negate()).oneMinus();
  return mix(lit, fogColor(d), fa);
}

/**
 * The dome: a unit sphere around the camera drawn at the far plane with the depth test on and no
 * depth write, after every opaque thing, so only pixels where the sky shows are shaded.
 */
export function createDomeMaterial(o: SkyDetail, reversedDepth: boolean): THREE.NodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = 'Sky.dome';
  mat.side = THREE.BackSide;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.fog = false;
  mat.lights = false;
  mat.vertexNode = Fn(() => {
    const vp = cameraViewMatrix.mul(vec4(positionLocal, 0)).xyz;
    const clip = cameraProjectionMatrix.mul(vec4(vp, 1));
    return reversedDepth ? vec4(clip.x, clip.y, 0, clip.w) : vec4(clip.x, clip.y, clip.w, clip.w);
  })();
  mat.fragmentNode = Fn(() => {
    const d = normalize(positionLocal);
    const px = pixelAngle(d);
    // Interleaved gradient noise: a stable per-pixel offset for the marches (no temporal flicker).
    const jitter = interleavedGradientNoise(screenCoordinate.xy);
    return vec4(skyRadiance(d, px, o, jitter), 1);
  })();
  return mat;
}

/** The sky as the environment cube sees it: no discs, no stars, coarse clouds, snow below. */
export function createEnvMaterial(o: SkyDetail): THREE.NodeMaterial {
  const mat = new THREE.NodeMaterial();
  mat.name = 'Sky.env';
  mat.side = THREE.BackSide;
  mat.depthWrite = false;
  mat.depthTest = false;
  mat.blending = THREE.NoBlending;
  mat.fragmentNode = Fn(() => {
  const d = normalize(positionWorldDirection);
  const sky = skyRadiance(d, float(0.025), { cloudSteps: Math.min(o.cloudSteps, 4), auroraSteps: o.auroraSteps > 0 ? 4 : 0, stars: false, discs: false }, float(0.5), float(1));
  // Below the horizon: snow lit by the sky and the sun, sinking into the fog with distance.
  const groundFog = exp(fogDepth(float(90), d.y, float(1)).negate()).oneMinus();
  const ground = mix(vec3(SKYU.groundRad), fogColor(d), groundFog);
  const L = mix(ground, sky, smoothstep(-0.06, 0.01, d.y));
  return vec4(L, 1);
  })();
  return mat;
}
