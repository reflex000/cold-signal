// THE TERRAIN MATERIAL. One TSL MeshStandardNodeMaterial subclass draws every LOD node.
//
// Vertex: places the CDLOD grid vertex (morph to the parent grid, height from the heightmap / far
// map, small detail noise within ~60 m, the snow-deformation hook) and gives three a vertex normal
// from the normal map (used for the shadow normal bias).
//
// Fragment: everything is computed once in setupDiffuseColor (colorNode stays null on purpose: a
// non-null colorNode would be compiled into the shadow pass) and handed to the lighting through
// properties: albedo, view normal, roughness, AO, snow subsurface weight, sparkle.
//   snow   bright, slightly blue albedo with low-frequency variation; darker hollows from the baked
//          curvature; wind crust (cm), drift undulation (m) and sastrugi ridges stretched along the
//          prevailing wind, all as analytic gradients from one derivative-noise texture, faded by
//          the pixel footprint so nothing shimmers; stable world-space glints for the sparkle.
//   rock   steep slopes and masks.G: near-black, strata bands following the contours, crumbly
//          triplanar bump; snow wins wherever the rock's own normal is flat (ledges).
//   ice    masks.B: black-blue clear ice, white fracture lines, wind-polished patches, drifts
//          blown over it along the wind, thin ice greyer (world.lake.thickness).
//   trail  masks.A: packed, darker, smoother.
//   prints U.trailTex through gfx/snow/sample.ts: footprints, drags and hollows with crisp walls,
//          rims, a compacted floor (darker, smoother, bluer when deep), their own shadow at a low sun
//          (a march through the map toward the key light), low-passed dents in the mesh.
//   far    outside the heightmap: snow, rock on steep faces, dark forest below the tree line.
// Lighting: a PhysicalLightingModel that multiplies the matching directional light by the baked
// horizon shadow, adds a soft subsurface wrap on snow, and adds the glints.
// Owner: TERRAIN.
import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, asin, attribute, cameraPosition, cameraViewMatrix, cameraWorldMatrix, clamp, diffuseColor, dot, dFdx, dFdy, exp2, float, floor, fract,
  length, max, min, mix, normalLocal, normalView, positionGeometry, positionView, positionViewDirection, positionWorld, pow, property,
  roughness, select, smoothstep, sqrt, step, tan, texture, uniform, varying, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { U, keyLightHorizon } from '../shared';
import { trailDebug, trailFragment, trailShadow, trailVertex } from '../snow/sample';
import { WIND_X, WIND_Z } from '../../world/layout';
import type { TerrainData } from './data';
import type { HeightFns } from './height';
import type { HorizonMaps } from './horizon';
import { DERIV_RANGE, getCellTexture, getDetailTexture } from './noise';

type N = any;

/** Per-system uniforms the vertex shader needs (written by the terrain system every frame). */
export interface TerrainUniforms {
  lodCam: N; // vec3: camera position used for the LOD selection this frame
  hc: N; // camera height above the ground
  r0: N; // LOD 0 range
  cell0: N; // LOD 0 cell size
  cubicLod: N; // LODs below this use Catmull-Rom
  detailFade: N; // vec2: detail noise fades out between these 2D distances
  viewDist: N; // quality.viewDistance: small-scale material detail ends at a fraction of it
  canopyFade: N; // vec2: metres over which the fake canopy shade on the forest floor fades in
}

/** Look knobs, shared by every terrain material (tune live from a bench). */
export const TERRAIN_U = {
  snowAlbedo: uniform(new THREE.Color(0.87, 0.9, 0.95)),
  sparkle: uniform(1),
  detail: uniform(1), // scale on all detail normals
  printDepth: uniform(1), // scale on the depth of the snow-deformation map in the mesh (1 = as pressed)
  debug: uniform(0), // 0 off, 1 LOD colours, 2 horizon shadow, 3 normals, 4 masks, 5 NaN finder, 6 visible skirts
  skirt: uniform(1), // scale on the skirt depth (debug)
};

export interface TerrainMaterialOptions {
  mobile: boolean;
  sparkle: boolean;
}

const WIND = new THREE.Vector2(WIND_X, WIND_Z).normalize();

/** Hash without sine (Hoskins), on wrapped cell ids so precision holds far from the origin. */
function hash3(p: N): N {
  const q = p.sub(floor(p.div(4096)).mul(4096));
  const p3 = fract(vec3(q.x, q.y, q.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)));
  return fract(vec3(p3.x.add(p3.y).mul(p3.z), p3.x.add(p3.z).mul(p3.y), p3.y.add(p3.z).mul(p3.x)));
}

// ------------------------------------------------------------------------------------------
// Analytic sky reflection (the scene may have no environment map). Same model as the prop
// material, so ice and metal agree.
// ------------------------------------------------------------------------------------------
class TerrainSkyNode extends THREE.LightingNode {
  static get type(): string {
    return 'ColdSignalTerrainSkyNode';
  }
  constructor(private occlusion: N) {
    super();
  }
  setup(builder: any): any {
    const refl: N = positionViewDirection.negate().reflect(normalView);
    const dir: N = mix(refl, normalView, pow(roughness, 4)).normalize().transformDirection(cameraWorldMatrix);
    const blur: N = roughness.mul(0.6).add(0.12);
    const zenith: N = vec3(U.skyAmbient).mul(0.42);
    const horizon: N = vec3(U.fogColor);
    const ground: N = vec3(U.groundAmbient).mul(0.5);
    const sky: N = mix(horizon, zenith, dir.y.max(0).pow(0.6));
    builder.context.radiance.addAssign(mix(ground, sky, smoothstep(blur.negate(), blur, dir.y)).mul(this.occlusion));
    return null;
  }
}

// ------------------------------------------------------------------------------------------
// Lighting: horizon shadow on the matching directional light, snow subsurface wrap, glints.
// ------------------------------------------------------------------------------------------
class TerrainLighting extends THREE.PhysicalLightingModel {
  constructor(private hz: HorizonMaps, private props: Props, private sparkle: boolean, private printShadows: boolean) {
    super();
  }

  direct(input: any, builder: any): void {
    const { lightDirection, reflectedLight } = input;
    // the baked horizon shadow on the light the maps were made for (the same term every lit
    // material applies, see keyLightHorizon in ../shared.ts)
    const k: N = keyLightHorizon(input);
    let col: N = k ? input.lightColor.mul(k) : input.lightColor;
    if (input.lightNode?.light?.isDirectionalLight) {
      // the crowns' shade on the snow of the forest floor, where the trees' own shadows do not reach
      col = col.mul(this.props.canopy.oneMinus());
      // a print's wall and rim shade its own floor (the shadow map cannot hold a 3 cm wall)
      if (this.printShadows) col = col.mul(trailShadow(this.props.trailXZ, this.props.trailH, lightDirection.transformDirection(cameraWorldMatrix), this.props.trailNear));
    }
    super.direct({ ...input, lightColor: col }, builder);

    const p = this.props;
    // Snow: light scattered inside the snowpack softens the terminator and comes out bluish.
    const dotNL: N = normalView.dot(lightDirection);
    const wrap: N = clamp(dotNL.add(0.3).div(1.3), 0, 1).sub(clamp(dotNL, 0, 1)).max(0);
    reflectedLight.directDiffuse.addAssign(col.mul(wrap).mul(diffuseColor.rgb).mul(vec3(0.62, 0.8, 1.0)).mul(p.sss).mul(1 / Math.PI));

    if (this.sparkle) {
      // A glint is a mirror facet: it lights when its normal sits on the half vector.
      const hv: N = lightDirection.add(positionViewDirection).normalize();
      const c: N = clamp(dot(p.glintN, hv), 0, 1);
      const lobe: N = pow(c, 500).mul(8).add(pow(c, 70).mul(0.3));
      const facing: N = clamp(dot(p.glintN, lightDirection).mul(4), 0, 1);
      reflectedLight.directSpecular.addAssign(col.mul(lobe.mul(facing).mul(p.glint).mul(TERRAIN_U.sparkle)));
    }
  }
}

interface Props {
  canopy: N; // 0..1 share of the direct light the forest canopy takes (far forest floor)
  trailH: N; // height of the pressed snow surface relative to untouched snow, m (gfx/snow)
  trailNear: N; // > 0 where something is pressed near this pixel
  trailXZ: N; // world xz where the view ray meets the pressed surface (parallax)
  albedo: N;
  normal: N; // view space
  rough: N;
  ao: N;
  sss: N;
  glint: N;
  glintN: N; // view space
}

class TerrainNodeMaterial extends THREE.MeshStandardNodeMaterial {
  static get type(): string {
    return 'ColdSignalTerrainMaterial';
  }
  surface: N = null;
  /** Specular occlusion of the sky reflection (rough rock reflects little of the sky from its pits). */
  skyOcclusion: N = float(1);
  terrainLighting: (() => THREE.LightingModel) | null = null;

  setupDiffuseColor(): void {
    // The surface Fn assigns every property; the albedo becomes the diffuse colour.
    diffuseColor.assign(vec4(this.surface, 1));
  }

  setupLightingModel(): any {
    return this.terrainLighting ? this.terrainLighting() : super.setupLightingModel();
  }

  setupEnvironment(builder: any): any {
    const node = super.setupEnvironment(builder);
    return node ?? new TerrainSkyNode(this.skyOcclusion);
  }
}

export function createTerrainMaterial(data: TerrainData, h: HeightFns, hz: HorizonMaps, tu: TerrainUniforms, o: TerrainMaterialOptions): THREE.MeshStandardNodeMaterial {
  const m = new TerrainNodeMaterial();
  m.name = o.mobile ? 'terrain-mobile' : 'terrain';
  m.fog = true;
  m.metalness = 0;
  m.side = THREE.FrontSide;

  const detTex = getDetailTexture();
  const cellTex = getCellTexture();
  const detail = (uvN: N): N => texture(detTex, uvN);
  const cells = (uvN: N): N => texture(cellTex, uvN);
  const grad = (s: N): N => vec2(s.y, s.z).sub(0.5).mul(DERIV_RANGE);

  const aNode: N = attribute('aNode', 'vec4');
  // how far the mesh was lowered by the snow-deformation map here (the parallax march starts there)
  const vDent: N = varyingProperty('float', 'vTrailDent');

  // ---------------------------------------------------------------- vertex ----
  m.positionNode = Fn(() => {
    vDent.assign(0);
    const g: N = positionGeometry;
    const lod: N = aNode.w;
    const cell: N = tu.cell0.mul(exp2(lod));
    const gxz: N = vec2(g.x, g.z);
    const xz0: N = aNode.xy.add(gxz.mul(cell));
    const d2a: N = length(xz0.sub(tu.lodCam.xz));
    const d: N = sqrt(d2a.mul(d2a).add(tu.hc.mul(tu.hc)));
    const r: N = tu.r0.mul(exp2(lod));
    const k: N = clamp(d.sub(r.mul(0.8)).div(r.mul(0.2)), 0, 1);
    const odd: N = fract(gxz.mul(0.5)).mul(2);
    const xz: N = xz0.sub(odd.mul(cell).mul(k)).toVar();

    const y: N = float(0).toVar();
    If(lod.lessThan(tu.cubicLod), () => {
      y.assign(h.height(xz, true));
    }).Else(() => {
      // heights filtered for this LOD, blended toward the parent's level with the morph: at the
      // join both sides read the same level, and no single noisy sample dents a coarse mesh
      y.assign(mix(h.heightLod(xz, lod), h.heightLod(xz, lod.add(1)), k));
    });

    // Near the camera: small drifts so the snow has shape below the 2 m grid, and footprints.
    const d2: N = length(xz.sub(tu.lodCam.xz));
    const fade: N = smoothstep(tu.detailFade.x, tu.detailFade.y, d2).oneMinus();
    If(fade.greaterThan(0), () => {
      const mk: N = (texture(data.maskTex, h.fineUV(xz)) as N).level(0);
      const amp: N = mk.z.oneMinus().mul(mk.w.mul(0.75).oneMinus()).mul(mk.y.mul(0.5).oneMinus());
      // one detail-texture tile holds ~8 noise features: tiles of 42 m and 14 m give ~5 m and ~1.7 m drifts
      const n1: N = detail(xz.div(42)).level(0).x.sub(0.5);
      const n2: N = detail(xz.div(14).add(0.37)).level(0).x.sub(0.5);
      y.addAssign(n1.mul(0.16).add(n2.mul(0.05)).mul(amp).mul(fade));
      // footprints, drags and hollows (gfx/snow), low-passed to the 25 cm grid
      const dent: N = trailVertex(xz).mul(TERRAIN_U.printDepth).mul(fade);
      y.addAssign(dent);
      vDent.assign(dent);
    });

    // Skirts hang below the node edge; they only show through a would-be crack.
    const skirt: N = step(g.y, -0.5);
    y.subAssign(skirt.mul(cell.mul(2).add(0.5)).mul(TERRAIN_U.skirt));

    // vertex normal from the baked normal maps (shadow normal bias, fallback shading)
    const w: N = h.fineWeight(xz).toVar();
    const enc: N = vec2(0.5).toVar();
    If(w.greaterThan(0), () => {
      enc.assign((texture(data.normFineTex, h.fineUV(xz)) as N).level(0).xy);
    });
    If(w.lessThan(1), () => {
      enc.assign(mix((texture(data.normFarTex, h.farUV(xz)) as N).level(0).xy, enc, w));
    });
    const sl: N = tan(enc.sub(0.5).clamp(-0.497, 0.497).mul(Math.PI));
    normalLocal.assign(vec3(sl.x.negate(), 1, sl.y.negate()).normalize());
    return vec3(xz.x, y, xz.y);
  })();

  // -------------------------------------------------------------- fragment ----
  const pAlbedo: N = property('vec3', 'trAlbedo');
  const pNormal: N = property('vec3', 'trNormal');
  const pRough: N = property('float', 'trRough');
  const pAO: N = property('float', 'trAO');
  const pSSS: N = property('float', 'trSSS');
  const pGlint: N = property('float', 'trGlint');
  const pGlintN: N = property('vec3', 'trGlintN');
  const pEnv: N = property('float', 'trEnv');
  const pCanopy: N = property('float', 'trCanopy');
  const pTrailH: N = property('float', 'trPrintH');
  const pTrailNear: N = property('float', 'trPrintNear');
  const pTrailXZ: N = property('vec2', 'trPrintXZ');
  const props: Props = { canopy: pCanopy, trailH: pTrailH, trailNear: pTrailNear, trailXZ: pTrailXZ, albedo: pAlbedo, normal: pNormal, rough: pRough, ao: pAO, sss: pSSS, glint: pGlint, glintN: pGlintN };

  const vLod: N = varying(aNode.w);
  const vSkirt: N = varying(step(positionGeometry.y, -0.5));

  m.surface = Fn(() => {
    const p: N = positionWorld.toVar();
    const xz: N = p.xz;
    // Derivatives first (WGSL allows them only in uniform control flow). Every tap below passes
    // explicit gradients, so whole material layers can be skipped with branches.
    const dpx: N = dFdx(p).toVar();
    const dpy: N = dFdy(p).toVar();
    const fp: N = max(length(dpx), length(dpy)).max(1e-4).toVar(); // metres per pixel
    const gx: N = dpx.xz, gy: N = dpy.xz;
    const dist: N = length(positionView).toVar();
    /** 0 when a feature of wavelength `lambda` m is under 2 px wide .. 1 above 6 px (mip-mapped
     * derivative textures already average finer octaves away; this only stops the last of it). */
    const res = (lambda: number | N): N => clamp(float(lambda).div(fp).sub(2).div(4), 0, 1);
    /** The same for analytic bands with sharp edges (strata): 8 .. 20 px per band. */
    const resBand = (lambda: number): N => clamp(float(lambda).div(fp).sub(8).div(12), 0, 1);
    /** 1 near .. 0 beyond ~12 % of quality.viewDistance: where small-scale detail stops (saves taps on low tiers). */
    const nearD: N = smoothstep(tu.viewDist.mul(0.1), tu.viewDist.mul(0.14), dist).oneMinus().toVar();
    /** Linear map of world xz (or of its derivatives) to texture uv: (a x + b z, c x + d z) / s. */
    const lin = (a: number, b: number, c: number, d: number, s: number | N) => (v: N): N => vec2(v.x.mul(a).add(v.y.mul(b)), v.x.mul(c).add(v.y.mul(d))).div(s);
    /** Its transpose, for turning a texture-space gradient back into world xz. */
    const linT = (a: number, b: number, c: number, d: number, s: number | N) => (g: N): N => vec2(g.x.mul(a).add(g.y.mul(c)), g.x.mul(b).add(g.y.mul(d))).div(s);
    const tap = (tex: THREE.Texture, f: (v: N) => N, ox: number, oy: number): N => (texture(tex, f(xz).add(vec2(ox, oy))) as N).grad(f(gx), f(gy));

    // ---- macro surface ----
    const w: N = h.fineWeight(xz).toVar();
    const farW: N = w.oneMinus().toVar();
    const nf: N = texture(data.normFineTex, h.fineUV(xz));
    const nr: N = texture(data.normFarTex, h.farUV(xz));
    // slopes are stored as 0.5 + atan(dh/dx) / pi (see data.ts)
    const sl: N = tan(mix(vec2(nr.x, nr.y), vec2(nf.x, nf.y), w).sub(0.5).clamp(-0.497, 0.497).mul(Math.PI));
    const nM: N = vec3(sl.x.negate(), 1, sl.y.negate()).normalize().toVar();
    const curv: N = mix(nr.z, nf.z, w).sub(0.5).toVar(); // > 0 hollow, < 0 crest
    const snowDepth: N = nf.w.mul(w).toVar();
    const mk: N = texture(data.maskTex, h.fineUV(xz)).mul(w).toVar(); // forest, rock, ice, trail
    const slope: N = nM.y.oneMinus().toVar(); // 0 flat, 0.234 at 40 deg, 0.36 at 50 deg
    // the same slope over ~8 m: rock needs a face, not a lip one texel wide
    const nfc: N = (texture(data.normFineTex, h.fineUV(xz)) as N).bias(2.5);
    const slc: N = tan(nfc.xy.sub(0.5).clamp(-0.497, 0.497).mul(Math.PI));
    const slopeC: N = vec3(slc.x.negate(), 1, slc.y.negate()).normalize().y.oneMinus().toVar();
    const curvC: N = nfc.z.sub(0.5).toVar(); // curvature over ~8 m: couloirs, not the steps of the strata

    // ---- low-frequency variation ----
    // (one tile of the detail texture holds ~8 noise features: a tile of T metres gives ~T/8 features)
    const lowVar: N = tap(detTex, lin(1, 0, 0, 1, 330), 0, 0).w.mul(0.6).add(tap(detTex, lin(0, 1, -1, 0, 90), 0.21, 0.21).w.mul(0.4)).sub(0.5).toVar(); // -0.5..0.5
    const broadN: N = tap(detTex, lin(0.8, 0.6, -0.6, 0.8, 190), 0.3, 0.3).x.toVar(); // 0..1, ~25 m blobs

    // ---- wind frame (prevailing storm wind: sastrugi and drifts line up with it) ----
    const wx = WIND.x, wz = WIND.y;

    // ---- trail and thin snow ----
    const trail: N = smoothstep(0.3, 0.72, mk.w.add(broadN.sub(0.5).mul(0.3))).toVar();
    const nearTrail: N = smoothstep(0.02, 0.25, mk.w).toVar();

    // ---- snow detail: gradient (dh/dx, dh/dz) of the small-scale snow surface ----
    const sg: N = vec2(0).toVar();
    // exposure to the wind: thin, scoured snow carries crust and sastrugi; deep drifts are smoother
    const exposure: N = smoothstep(0.1, 0.55, snowDepth).oneMinus().mul(0.6).add(0.4).mul(w).add(farW.mul(0.6)).toVar();
    {
      // the vertex drift noise, so lighting follows the displaced surface
      const fadeV: N = smoothstep(tu.detailFade.x, tu.detailFade.y, length(xz.sub(tu.lodCam.xz))).oneMinus();
      If(fadeV.greaterThan(0.001), () => {
        const amp: N = mk.z.oneMinus().mul(mk.w.mul(0.75).oneMinus()).mul(mk.y.mul(0.5).oneMinus()).mul(fadeV);
        const A = lin(1, 0, 0, 1, 42), B = lin(1, 0, 0, 1, 14);
        sg.addAssign(grad(tap(detTex, A, 0, 0)).mul(0.16 / 42).add(grad(tap(detTex, B, 0.37, 0.37)).mul(0.05 / 14)).mul(amp));
      });
    }
    // Sastrugi: ridges stretched along the wind, sharp-crested, in fields that come and go with
    // smooth wind-packed slabs between them; two sizes.
    const field: N = smoothstep(0.35, 0.75, tap(detTex, lin(0.6, 0.8, -0.8, 0.6, 140), 0.41, 0.19).x.add(lowVar.mul(0.5))).mul(0.7).add(0.3).toVar();
    // TA x TC: tile sizes along / across the wind (features about an eighth of that)
    const sastrugi = (LA: number, LC: number, amp: number, ox: number, oy: number): void => {
      If(res(LC / 8).mul(nearD).greaterThan(0), () => {
        const S = lin(wx, wz, -wz, wx, 1);
        const s: N = tap(detTex, (v: N): N => S(v).div(vec2(LA, LC)), ox, oy);
        const c2: N = s.x.mul(2).sub(1);
        const dr: N = c2.div(sqrt(c2.mul(c2).add(0.02))).mul(-2); // d(1 - |2n-1|)/dn, softened
        const gs: N = grad(s).mul(dr).div(vec2(LA, LC));
        const gxz: N = vec2(gs.x.mul(wx).sub(gs.y.mul(wz)), gs.x.mul(wz).add(gs.y.mul(wx)));
        sg.addAssign(gxz.mul(amp).mul(exposure).mul(field).mul(res(LC / 8)).mul(nearD));
      });
    };
    sastrugi(37, 10.4, 0.3, 0.13, 0.71); // ~4.6 x 1.3 m
    if (!o.mobile) sastrugi(13.6, 3.8, 0.08, 0.57, 0.29); // ~1.7 x 0.5 m
    If(res(25 / 8).greaterThan(0), () => {
      // drift undulation, ~3 m across and twice that along the wind, like small dunes
      const M = lin(wx * 0.5, wz * 0.5, -wz, wx, 25), MT = linT(wx * 0.5, wz * 0.5, -wz, wx, 25);
      sg.addAssign(MT(grad(tap(detTex, M, 0.55, 0.55))).mul(0.4).mul(res(25 / 8)));
    });
    if (!o.mobile) {
      If(res(3 / 8).mul(nearD).greaterThan(0), () => {
        // wind crust, ~0.4 m bumps of a centimetre
        const C = lin(0.34, -0.94, 0.94, 0.34, 3), CT = linT(0.34, -0.94, 0.94, 0.34, 3);
        sg.addAssign(CT(grad(tap(detTex, C, 0.81, 0.81))).mul(0.05).mul(exposure.mul(0.5).add(0.5)).mul(res(3 / 8)).mul(nearD));
      });
    }
    sg.mulAssign(TERRAIN_U.detail);
    // normal-mapped bumps steeper than ~40 deg turn away from the viewer at grazing angles
    sg.assign(sg.mul(min(float(1), float(0.8).div(length(sg).max(1e-4)))));

    // ---- footprints, drags and hollows (gfx/snow: the snow-deformation map) ----
    const slopeX: N = nM.x.negate().div(nM.y);
    const slopeZ: N = nM.z.negate().div(nM.y);
    // parallax on the desktop tiers: the view ray finds the floor of a hole behind its near wall
    const tr = trailFragment(xz, fp, o.mobile ? undefined : { view: p.sub(cameraPosition).normalize(), slope: vec2(slopeX, slopeZ), dent: vDent });
    const print: N = tr.compact.mul(w).toVar(); // compacted floor showing (darker, smoother)
    const pressed: N = tr.inside.mul(w).toVar(); // inside a print at all
    // deep holes glow blue in shade: light comes through the snow walls
    const hole: N = pressed.mul(smoothstep(0.02, 0.3, tr.depth)).toVar();
    const raised: N = smoothstep(0.0, 0.03, tr.rim).mul(w).toVar(); // loose snow pushed up or kicked out
    const pg: N = tr.grad.mul(w);

    // combined snow normal (pressing flattens the wind crust and the sastrugi)
    const snowG: N = sg.mul(trail.mul(0.7).oneMinus()).mul(pressed.mul(0.85).oneMinus()).add(pg);
    const nSnow: N = vec3(slopeX.add(snowG.x).negate(), 1, slopeZ.add(snowG.y).negate()).normalize().toVar();

    // ---- rock ----
    // Inner: the world's bare-rock mask where the ground is not flat (on flat ground it only thins
    // the snow), plus faces steeper than ~48 deg; never on the packed trail or its graded banks.
    // Far ring (24 m cells read gentler): ~42 deg, and wind-scoured crests. Snow fills gullies and
    // holds on ledges and benches of the strata.
    const crest: N = smoothstep(0.02, 0.12, curv.negate());
    const steepFar: N = smoothstep(0.25, 0.37, slope.add(broadN.sub(0.5).mul(0.14)).add(crest.mul(0.08)));
    const maskRock: N = smoothstep(0.55, 0.8, mk.y.add(broadN.sub(0.5).mul(0.25))).mul(smoothstep(0.08, 0.22, slope));
    // Cliff zones (a face within ~8 m): a noise in the plane of the face leaves some benches bare and
    // breaks the snow on the others, so terraced cliffs do not read as regular stripes.
    const cliffZone: N = smoothstep(0.16, 0.3, slopeC).mul(w).toVar();
    const faceNoise: N = float(0.5).toVar();
    const facet: N = vec3(0).toVar(); // large-scale bump in the plane of a cliff face (view: world)
    If(cliffZone.greaterThan(0.01), () => {
      const ax: N = smoothstep(0.3, 0.7, abs(nM.x).div(abs(nM.x).add(abs(nM.z)).max(1e-3)));
      const TF = 60;
      const fa: N = (texture(detTex, vec2(p.z, p.y).div(TF).add(0.21)) as N).grad(vec2(dpx.z, dpx.y).div(TF), vec2(dpy.z, dpy.y).div(TF));
      const fb: N = (texture(detTex, vec2(p.x, p.y).div(TF).add(0.67)) as N).grad(vec2(dpx.x, dpx.y).div(TF), vec2(dpy.x, dpy.y).div(TF));
      faceNoise.assign(mix(fb.x.mul(0.65).add(fb.w.mul(0.35)), fa.x.mul(0.65).add(fa.w.mul(0.35)), ax));
      // The same noise as relief about 3 m deep across ~7 m slabs: a smooth face shades like
      // concrete from afar, a faceted one catches the light slab by slab (no extra taps).
      const ga: N = grad(fa), gb: N = grad(fb);
      facet.assign(mix(vec3(gb.x, gb.y, 0), vec3(0, ga.y, ga.x), ax).mul(cliffZone).mul(3 / TF));
    });
    const benchRock: N = cliffZone.mul(smoothstep(0.52, 0.66, faceNoise));
    // the face noise also roughens where rock gives way to snow, so gullies do not end in straight edges
    // On cliffs the edge is crisp and broken by the face noise: a couloir a few metres wide is only
    // a blurred trough in the 2 m normals, and a soft edge read as a glowing white streak.
    const steepIn: N = smoothstep(mix(float(0.31), float(0.345), cliffZone), mix(float(0.43), float(0.375), cliffZone), mix(slope, slopeC, 0.6).add(broadN.sub(0.5).mul(0.14)).add(faceNoise.sub(0.5).mul(0.24).add(facet.x.add(facet.z).mul(0.6)).mul(cliffZone)));
    // The masks are 2D: a trail at the foot of a wall projects straight up its face. A trail never
    // runs up a cliff, so it keeps the rock off walkable ground only (it laid soft white streaks up
    // the wall above the cave). (SNOW, per the look brief.)
    const trailKeep: N = nearTrail.mul(smoothstep(0.3, 0.55, nM.y));
    const rockArea: N = max(max(maskRock, steepIn), benchRock).mul(w).add(steepFar.mul(farW)).mul(mk.z.oneMinus()).mul(trailKeep.oneMinus()).clamp(0, 1).toVar();
    const rock: N = float(0).toVar();
    const nRock: N = nM.toVar();
    const rockAlb: N = vec3(0.045).toVar();
    const ledgeAO: N = float(1).toVar();
    const rockTex: N = float(0).toVar();
    If(rockArea.greaterThan(0.002), () => {
      // strata: bands following the contours (world height), warped so they wander; 2.3 m beds
      // up close (ledges that catch snow), 19 m benches in the albedo only
      const warpS: N = tap(detTex, lin(1, 0, 0, 1, 450), 0.1, 0.4).x.mul(3.1);
      const s1: N = p.y.div(2.3).add(warpS).add(lowVar.mul(0.8));
      const s2: N = p.y.div(19).add(warpS.mul(0.6)).add(lowVar.mul(0.9));
      const prof = (b: N): N => smoothstep(0.0, 0.12, b).mul(smoothstep(0.55, 1.0, b).oneMinus()).sub(0.5);
      // not every bed makes a ledge
      const h1: N = hash3(vec2(floor(s1).mul(7.31).add(13.7), 91.3)).x;
      const h2: N = hash3(vec2(floor(s2).mul(5.77).add(41.9), 17.9)).x;
      const k1: N = smoothstep(0.25, 0.85, h1).mul(0.7).add(0.3);
      // only the near beds tilt the normal (and so catch snow); the 19 m benches stay in the albedo:
      // as snow lines they would stripe whole cliffs
      const ledge: N = prof(fract(s1)).mul(resBand(2.3)).mul(0.6).mul(k1).toVar();
      ledgeAO.assign(ledge.mul(0.3).add(0.85));
      if (o.mobile) {
        nRock.assign(nM.sub(facet).add(vec3(0, ledge.mul(0.5), 0)).normalize());
      } else {
        // crumbly triplanar bump
        const bw: N = pow(abs(nM), vec3(4)).toVar();
        bw.divAssign(bw.x.add(bw.y).add(bw.z));
        const tp = (a: N, b: N, ga: N, gb: N, gc: N, gd: N, o2: number): N => (texture(detTex, vec2(a, b).div(6).add(o2)) as N).grad(vec2(ga, gb).div(6), vec2(gc, gd).div(6));
        const bump: N = vec3(0).toVar();
        If(nearD.mul(res(6 / 8)).greaterThan(0), () => {
          const sX: N = tp(p.z, p.y, dpx.z, dpx.y, dpy.z, dpy.y, 0);
          const sY: N = tp(p.x, p.z, dpx.x, dpx.z, dpy.x, dpy.z, 0.5);
          const sZ: N = tp(p.x, p.y, dpx.x, dpx.y, dpy.x, dpy.y, 0.25);
          const gX: N = grad(sX), gY: N = grad(sY), gZ: N = grad(sZ);
          const k: N = res(6 / 8).mul(nearD);
          bump.assign(vec3(gY.x.mul(bw.y).add(gZ.x.mul(bw.z)), gX.y.mul(bw.x).add(gZ.y.mul(bw.z)), gX.x.mul(bw.x).add(gY.y.mul(bw.y))).mul(0.25 / 6).mul(k));
          // lighter and darker patches of the same rock, a metre across
          rockTex.assign(sX.x.mul(bw.x).add(sY.x.mul(bw.y)).add(sZ.x.mul(bw.z)).sub(0.5).mul(k));
        });
        nRock.assign(nM.sub(bump).sub(facet).add(vec3(0, ledge.mul(0.4), 0)).normalize());
      }
      // snow is caught wherever the rock's own normal is flat enough, and fills the gullies
      const hold: N = tap(detTex, lin(1, 0, 0, 1, 30), 0.66, 0.66).x.sub(0.5).mul(res(30 / 8)).add(tap(detTex, lin(0, 1, -1, 0, 120), 0.12, 0.83).x.sub(0.5).mul(1.6).mul(res(120 / 8)));
      // xz-projected noise would streak down a cliff: on near-vertical faces only ledges hold snow
      const vert: N = smoothstep(0.3, 0.6, nM.y);
      // Couloirs fill with snow, but broken by rock steps and runnels (a smooth fill read as a white
      // spike down the cliff): the face noise decides which stretches of a gully hold snow.
      const gullyBreak: N = smoothstep(0.38, 0.62, faceNoise.add(hold.mul(0.6)));
      const gully: N = smoothstep(0.01, 0.08, mix(curv, curvC, w)).mul(0.2).mul(smoothstep(0.22, 0.45, nM.y)).mul(mix(float(1), gullyBreak, cliffZone));
      // holding needs a bench, not a step one texel high: judge with the ~8 m normal as well
      const holdY: N = mix(nRock.y, slopeC.oneMinus(), 0.55);
      const faceN: N = faceNoise.sub(0.5).mul(vert.oneMinus());
      // on cliffs the edge between plastered snow and rock is crisper (no soft glow down the face)
      const e0: N = mix(float(0.6), float(0.65), cliffZone), e1: N = mix(float(0.84), float(0.76), cliffZone);
      const snowOnRock: N = smoothstep(e0, e1, holdY.add(hold.mul(0.18).add(broadN.sub(0.5).mul(0.12)).mul(vert)).add(faceN.mul(0.7)).add(snowDepth.mul(0.25)).add(gully));
      // A sheer face (steeper than ~70 deg at the 2 m scale) holds snow only on its ledges: the
      // 8 m slope across a cut step (the cave's pad) reads gentle and laid soft vertical white
      // smears down the wall above the cave. (SNOW, per the look brief.)
      const sheer: N = smoothstep(0.26, 0.42, nM.y).oneMinus().mul(cliffZone);
      const onLedge: N = smoothstep(0.5, 0.72, nRock.y);
      rock.assign(rockArea.mul(mix(snowOnRock, snowOnRock.mul(onLedge), sheer).oneMinus()));
      // Near-black. Bedding shows only in places (a whole face of even stripes reads as concrete);
      // vertical joints (~1 m apart, ~5 m long, in the plane of the face) and broad tone patches
      // break the face up the way frost-shattered rock does.
      const v1: N = fract(floor(s1).mul(0.6180339)).sub(0.5).mul(0.3).mul(resBand(2.3)).mul(smoothstep(0.42, 0.68, broadN));
      const v2: N = h2.sub(0.5).mul(0.35).mul(resBand(19));
      const axJ: N = smoothstep(0.3, 0.7, abs(nM.x).div(abs(nM.x).add(abs(nM.z)).max(1e-3)));
      const J = (a: N, b: N, ga: N, gb: N, gc: N, gd: N, o2: number): N =>
        (texture(detTex, vec2(a.div(9), b.div(45)).add(o2)) as N).grad(vec2(ga.div(9), gb.div(45)), vec2(gc.div(9), gd.div(45))).x;
      const jn: N = mix(J(p.x, p.y, dpx.x, dpx.y, dpy.x, dpy.y, 0.71), J(p.z, p.y, dpx.z, dpx.y, dpy.z, dpy.y, 0.13), axJ);
      const joint: N = smoothstep(0.045, 0.0, abs(jn.sub(0.5))).mul(res(9 / 8)).mul(vert.oneMinus()).mul(0.55);
      const tone: N = broadN.sub(0.5).mul(0.6).add(faceNoise.sub(0.5).mul(0.5).mul(cliffZone));
      rockAlb.assign(vec3(0.03, 0.025, 0.02).mul(v1.add(v2).add(tone).add(1)).mul(lowVar.mul(0.6).mul(vert).add(1)).mul(rockTex.mul(0.9).add(1)).mul(joint.oneMinus()));
      ledgeAO.mulAssign(joint.mul(0.4).oneMinus());
    });

    // ---- lake ice ----
    const ice: N = float(0).toVar();
    const drift: N = float(0).toVar();
    const iceAlb: N = vec3(0.012, 0.022, 0.034).toVar();
    const roughIce: N = float(0.12).toVar();
    const crack: N = float(0).toVar();
    If(mk.z.greaterThan(0.01), () => {
      const iceN: N = tap(cellTex, lin(wx, wz, -wz, wx, 40), 0.2, 0.2).w; // (only for breakup)
      ice.assign(smoothstep(0.5, 0.62, mk.z.add(iceN.sub(0.5).mul(0.08))));
      const thickUV: N = xz.sub(vec2(data.lake.minX, data.lake.minZ)).div(data.lake.size);
      const thick: N = (texture(data.lakeTex, thickUV) as N).level(0).x.mul(data.lakeMaxThick);
      const thin: N = smoothstep(0.12, 0.32, thick).oneMinus().mul(ice);
      // drifts blown over the ice, streaked along the wind, thicker near the shores
      const D = lin(wx, wz, -wz, wx, 1);
      const driftN: N = tap(detTex, (v: N): N => D(v).div(vec2(200, 44)), 0.33, 0.33).x;
      // most of a mountain lake in winter is under drifted snow; the wind keeps lanes of ice bare
      drift.assign(smoothstep(0.4, 0.56, driftN.add(mk.z.oneMinus().mul(0.9)).add(lowVar.mul(0.2))).mul(ice));
      // Fractures on the edges of warped Voronoi cells (the cell texture holds 10 cells per tile;
      // r = (F2 - F1) / 0.6 in cell units): long main cracks across 30 m plates, and a finer network
      // only in the zones where the ice has worked. Warping bends the edges; a slow noise decides
      // which stretches show, so the pattern never reads as tiles.
      const wq: N = tap(detTex, lin(1, 0, 0, 1, 90), 0.71, 0.37);
      const warp: N = vec2(wq.x, wq.w).sub(0.5);
      const zone: N = tap(detTex, lin(0.6, -0.8, 0.8, 0.6, 260), 0.15, 0.55).x;
      const uv1: N = xz.div(300).add(warp.mul(0.09));
      const uv2: N = vec2(xz.y, xz.x).div(48).add(warp.mul(0.35));
      const c1: N = (texture(cellTex, uv1) as N).grad(gx.div(300), gy.div(300)).x;
      const c2: N = (texture(cellTex, uv2) as N).grad(vec2(gx.y, gx.x).div(48), vec2(gy.y, gy.x).div(48)).x;
      const w1: N = fp.mul(1.5).add(0.05).div(30 * 0.6), w2: N = fp.mul(1.5).add(0.03).div(4.8 * 0.6);
      const show1: N = smoothstep(0.3, 0.55, zone.add(wq.w.sub(0.5).mul(0.6)));
      const show2: N = smoothstep(0.55, 0.75, zone.add(wq.x.sub(0.5).mul(0.5)));
      crack.assign(smoothstep(0.0, w1, c1).oneMinus().mul(show1).max(smoothstep(0.0, w2, c2).oneMinus().mul(show2).mul(0.55)).mul(res(0.5)).mul(nearD.mul(0.7).add(0.3)));
      const polished: N = smoothstep(0.55, 0.75, tap(cellTex, lin(1, 0, 0, 1, 170), 0.7, 0.7).z);
      // black-blue clear ice dulled by hoar frost (a frozen lake is not a mirror), greyer where thin
      const frost: N = smoothstep(0.35, 0.8, wq.x.mul(0.6).add(lowVar.add(0.5).mul(0.4)));
      iceAlb.assign(mix(vec3(0.016, 0.024, 0.034), vec3(0.11, 0.12, 0.13), thin).add(vec3(0.05, 0.055, 0.06).mul(frost)).add(vec3(0.3, 0.33, 0.36).mul(crack)));
      roughIce.assign(mix(mix(float(0.3), float(0.5), frost), float(0.09), polished).add(crack.mul(0.3)));
    });
    const nIce: N = vec3(slopeX.negate(), 1, slopeZ.negate()).normalize();
    const iceW: N = ice.mul(drift.oneMinus()).toVar();

    // ---- far ring: dark forest below the tree line ----
    const forestFar: N = float(0).toVar();
    const forestAlb: N = vec3(0.03).toVar();
    If(farW.greaterThan(0.002), () => {
      const f1: N = tap(detTex, lin(1, 0, 0, 1, 1400), 0.2, 0.2).w;
      // a ragged edge (avalanche paths, clearings ~30 m across), not smooth blobs
      const f3: N = tap(detTex, lin(0.8, -0.6, 0.6, 0.8, 260), 0.45, 0.85).x;
      forestFar.assign(smoothstep(0.3, 0.55, nr.w.add(f1.sub(0.5).mul(0.5)).add(f3.sub(0.5).mul(0.35))).mul(farW));
      const f2: N = tap(detTex, lin(0, 1, -1, 0, 350), 0.6, 0.1).w;
      // dark crowns with snow on them and between them, seen from kilometres: a cool dark grey-green
      // (a greener, brighter canopy turned olive under a low sun)
      forestAlb.assign(vec3(0.016, 0.021, 0.022).mul(f2.mul(0.7).add(0.65)).add(vec3(0.045, 0.05, 0.058).mul(lowVar.add(0.5)).mul(f3.mul(0.6).add(0.7))));
    });

    // ---- snow albedo ----
    const hollow: N = smoothstep(0.0, 0.3, curv).mul(0.07).add(smoothstep(0.0, 0.3, curv.negate()).mul(-0.02));
    // thin snow over rock (world mask between snow and bare rock): greyer, harder
    // thin, older snow on steep cliff ground (couloirs, ledges) is greyer than the drifts below
    const thinSnow: N = smoothstep(0.15, 0.5, mk.y).mul(maskRock.oneMinus()).mul(0.06).add(smoothstep(0.2, 0.34, slope).mul(cliffZone).mul(0.1));
    const forestShade: N = mk.x.mul(0.05);
    const snowAlb: N = vec3(TERRAIN_U.snowAlbedo as N).mul(lowVar.mul(0.06).add(1).sub(hollow).sub(forestShade).sub(thinSnow)).toVar();
    snowAlb.mulAssign(mix(vec3(1), vec3(0.84, 0.87, 0.92), trail));
    snowAlb.mulAssign(mix(vec3(1), vec3(0.84, 0.875, 0.92), print));
    snowAlb.mulAssign(mix(vec3(1), vec3(0.8, 0.9, 1.0), hole));
    snowAlb.mulAssign(raised.mul(0.03).add(1));

    // ---- combine ----
    const snowW: N = rock.oneMinus().mul(iceW.oneMinus()).mul(forestFar.oneMinus()).toVar();
    const albedo: N = snowAlb.mul(snowW).toVar();
    albedo.addAssign(rockAlb.mul(rock));
    albedo.addAssign(iceAlb.mul(iceW).mul(rock.oneMinus()));
    albedo.addAssign(forestAlb.mul(forestFar).mul(rock.oneMinus()));

    const n: N = nSnow.toVar();
    n.assign(mix(n, nRock, rock));
    n.assign(mix(n, nIce, iceW.mul(rock.oneMinus())));
    n.assign(n.normalize());

    const roughSnow: N = mix(float(0.82), float(0.66), exposure.mul(res(0.37))).sub(trail.mul(0.16)).sub(print.mul(0.04)).add(raised.mul(0.08));
    const rough: N = roughSnow.mul(snowW).add(float(0.8).mul(rock)).add(roughIce.mul(iceW).mul(rock.oneMinus())).add(float(0.9).mul(forestFar)).toVar();
    // detail lost to the footprint shows up as roughness, not as shimmer
    rough.assign(rough.add(smoothstep(0.02, 0.6, fp).mul(0.08)).clamp(0.03, 1));

    // Forest floor beyond the reach of the trees' cast shadows (impostors cast none): the canopy
    // takes most of the direct light and a share of the sky, so from a distance or from above a
    // forest reads as a dark stand, not as white snow with dark specks on it.
    const canopy: N = smoothstep(0.12, 0.65, mk.x).mul(smoothstep(tu.canopyFade.x, tu.canopyFade.y, dist)).toVar();
    // a print sees less of the sky the deeper it is (its white walls give some of it back)
    const printAO: N = pressed.mul(smoothstep(0.0, 0.28, tr.depth).mul(0.36).add(0.05));
    const ao: N = float(1).sub(smoothstep(0.0, 0.35, curv).mul(0.3)).sub(rock.mul(ledgeAO.oneMinus())).sub(printAO.mul(snowW)).sub(forestFar.mul(0.3)).sub(canopy.mul(0.5)).clamp(0.3, 1);

    // ---- glints ----
    pGlint.assign(0);
    pGlintN.assign(vec3(0, 1, 0));
    if (o.sparkle) {
      // One candidate crystal per 3 cm cell. A glint stays at least about a pixel wide so it is
      // rasterised every frame (stable, no crawling); when cells shrink below a pixel it fades out.
      const CELL = 0.03;
      const fadeG: N = clamp(float(CELL).div(fp).sub(0.9).div(0.9), 0, 1).mul(smoothstep(15, 45, dist).oneMinus()).mul(snowW).mul(trail.oneMinus()).mul(pressed.oneMinus()).toVar(); // no glints on pressed snow: on its steep walls they flashed and bloomed
      If(fadeG.greaterThan(0.001), () => {
        const gp: N = xz.div(CELL);
        const ci: N = floor(gp);
        const f: N = gp.sub(ci);
        const r1: N = hash3(ci);
        const r2: N = hash3(ci.add(vec2(17.1, 3.7)));
        const present: N = step(0.5, r1.x);
        const rad: N = max(fp.div(CELL).mul(0.8), 0.28).min(0.45);
        const dotM: N = smoothstep(rad.mul(0.35), rad, length(f.sub(r1.yz.mul(0.4).add(0.3)))).oneMinus();
        const gn: N = n.add(vec3(r2.x.sub(0.5), 0, r2.y.sub(0.5)).mul(0.7)).normalize();
        pGlint.assign(present.mul(dotM).mul(fadeG).mul(r2.z.mul(0.7).add(0.3)));
        pGlintN.assign(gn.transformDirection(cameraViewMatrix));
      });
    }

    // ---- debug views ----
    const dbg: N = TERRAIN_U.debug;
    If(dbg.greaterThan(0.5), () => {
      const lodCol: N = vec3(fract(vLod.mul(0.37)), fract(vLod.mul(0.61).add(0.3)), fract(vLod.mul(0.83).add(0.6))).mul(0.8).add(0.1);
      const sunLit: N = hz.lit(xz, asin(clamp(U.sunDir.y, -1, 1)));
      albedo.assign(mix(albedo, lodCol, step(dbg, 1.5)));
      albedo.assign(mix(albedo, vec3(sunLit.mul(0.8).add(0.05)), step(1.5, dbg).mul(step(dbg, 2.5))));
      albedo.assign(mix(albedo, n.mul(0.5).add(0.5).mul(0.8), step(2.5, dbg).mul(step(dbg, 3.5))));
      albedo.assign(mix(albedo, vec3(rock, ice, trail).mul(0.8).add(vec3(0, 0, print)), step(3.5, dbg).mul(step(dbg, 4.5))));
      // 5: NaN finder (red: macro normal, green: rock / snow weights, blue: detail gradient)
      const bad = (v: N): N => select(v.equal(v), float(0), float(1));
      albedo.assign(mix(albedo, vec3(bad(nM.x.add(nM.y).add(curv)), bad(rock.add(snowW).add(rough)), bad(sg.x.add(sg.y).add(fp))).add(0.05), step(4.5, dbg).mul(step(dbg, 5.5))));
      // 6: skirts that show (magenta)
      albedo.assign(mix(albedo, mix(vec3(0.05), vec3(1, 0, 1), step(0.001, vSkirt)), step(5.5, dbg).mul(step(dbg, 6.5))));
      // 7: snow deformation (red pressed, green compacted, blue raised; white = near-window presence)
      albedo.assign(mix(albedo, vec3(pressed, print, raised).mul(0.8).add(tr.near.mul(0.12)), step(6.5, dbg).mul(step(dbg, 7.5))));
      // 8: the raw near-window texels (R x 2, G, B x 4)
      albedo.assign(mix(albedo, trailDebug(xz), step(7.5, dbg)));
    });

    pAlbedo.assign(albedo);
    pNormal.assign(n.transformDirection(cameraViewMatrix));
    pRough.assign(rough);
    pAO.assign(ao);
    pCanopy.assign(canopy.mul(0.88));
    // compacted snow scatters less; a deep hole's walls pass blue light into it
    pSSS.assign(snowW.mul(0.55).mul(print.mul(0.45).oneMinus()).mul(hole.mul(0.8).add(1)));
    pTrailH.assign(tr.h);
    pTrailNear.assign(tr.near.mul(w));
    pTrailXZ.assign(tr.xz);
    // the sky reflection in a hole sees its walls, not the sky
    pEnv.assign(float(1).sub(rock.mul(0.65)).sub(forestFar.mul(0.6)).mul(pressed.mul(smoothstep(0.01, 0.15, tr.depth)).mul(0.7).oneMinus()));
    return albedo;
  })();

  m.normalNode = pNormal;
  m.roughnessNode = pRough;
  m.metalnessNode = float(0);
  m.aoNode = pAO;
  m.skyOcclusion = pEnv;
  m.terrainLighting = () => new TerrainLighting(hz, props, o.sparkle, !o.mobile);
  return m;
}
