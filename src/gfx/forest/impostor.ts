// Impostors: every far tree is one camera-facing quad textured from a multi-view atlas baked at load
// with the real renderer and the real tree material (so the far forest has the same crowns, snow
// and colour as the near one, in any light: the atlas stores albedo and normals, not lit colour).
//
// ATLAS. 20 types (spruce variants 0-7, fir 0-7, snag 0-3) x 8 azimuths x 3 elevations (0, 30, 60
// degrees), frames of 64 x 128 texels in a 32 x 15 grid (2048 x 1920). Two RGBA8 targets, written
// in ONE instanced draw per kind (the bake material's vertexNode drops each instance into its own
// frame, see treemat.ts):
//   albedo  rgb = albedo (AO for direct light folded in), a = coverage    (premultiplied in the mips)
//   aux     r, g = tree-local normal x, z (y >= 0 reconstructed), b = AO, a = snow potential
// The cleared targets are 0 everywhere a tree is not, so the generated mips are premultiplied by
// coverage: the shader divides by alpha and gets clean colours and normals at every distance.
//
// RUNTIME. One static instance buffer holds every tree; the vertex shader picks the four frames
// around the view direction (two azimuths x two elevations), bends the quad with the same sway as
// the 3D tree, and collapses instances inside the 3D range or thinned away. The fragment shader
// blends the four frames, applies the instance's snow load with the same rule as the mesh, and
// alpha-tests with the shared LOD dither.
import * as THREE from 'three/webgpu';
import {
  Fn, If, asin, attribute, cameraViewMatrix, cos, dFdx, dFdy, float, floor, fract, fwidth, length, log2, max, mix, normalize, positionLocal,
  property, select, sin, smoothstep, sqrt, step, texture, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { U } from '../shared';
import { ForestLambert, ditherNoise, effectiveSnow, gustAt, rotY, snowCoverage, snowShade, treeSway, type N } from './common';
import { FU, KIND_INDEX, createBakeMaterial, lodDistance, treeTint, type BakeLayout } from './treemat';
import { FRAME_BOX, SNAG_H, TREE_H, treeGeometry, type GeoKind } from './treegen';

export const IMP = {
  az: 8,
  el: 3,
  elStep: Math.PI / 6, // 30 degrees
  cols: 32,
  rows: 15,
  fw: 64,
  fh: 128,
  marginX: 3 / 64,
  marginY: 3 / 128,
};
const FRAMES_PER_TYPE = IMP.az * IMP.el;

/** Impostor type of (kind index, variant): spruce 0-7, fir 8-15, snag 16-19. */
export function impostorType(kind: number, variant: number): number {
  return kind === 2 ? 16 + (variant & 3) : kind * 8 + variant;
}

export interface ImpostorAtlas {
  albedo: THREE.Texture;
  aux: THREE.Texture;
  target: THREE.RenderTarget;
  ms: number;
  dispose(): void;
}

function layoutOf(kind: GeoKind): BakeLayout {
  const b = FRAME_BOX[kind];
  return { cols: IMP.cols, rows: IMP.rows, hw: b.hw, y0: b.y0, y1: b.y1, marginX: IMP.marginX, marginY: IMP.marginY };
}

/**
 * Bake the atlas with the given renderer (synchronous: the draws are queued at once). Leaves the
 * renderer's target, clear colour and MRT as it found them.
 */
export function bakeImpostors(renderer: THREE.WebGPURenderer, frame: { w: number; h: number } = { w: IMP.fw, h: IMP.fh }): ImpostorAtlas {
  const t0 = performance.now();
  const W = IMP.cols * frame.w, H = IMP.rows * frame.h;
  const target = new THREE.RenderTarget(W, H, {
    count: 2,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.textures[0].name = 'output';
  target.textures[1].name = 'aux';
  for (const t of target.textures) {
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
  }

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60);
  cam.position.set(0, 0, 0);
  cam.lookAt(0, 0, -1);
  cam.updateMatrixWorld();
  const kinds: GeoKind[] = ['spruce', 'fir', 'snag'];
  const made: { geo: THREE.InstancedBufferGeometry; mat: THREE.Material }[] = [];
  for (const kind of kinds) {
    const base = treeGeometry(kind, 'full');
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    for (const name of Object.keys(base.attributes)) geo.setAttribute(name, base.attributes[name]);
    const ki = KIND_INDEX[kind];
    const nVar = kind === 'snag' ? 4 : 8;
    const n = nVar * FRAMES_PER_TYPE;
    const iA = new Float32Array(n * 4), iB = new Float32Array(n * 4), iF = new Float32Array(n * 4);
    let k = 0;
    for (let v = 0; v < nVar; v++) {
      const type = impostorType(ki, v);
      for (let e = 0; e < IMP.el; e++) {
        for (let a = 0; a < IMP.az; a++, k++) {
          const f = type * FRAMES_PER_TYPE + e * IMP.az + a;
          iA.set([0, 0, 0, 1], k * 4);
          // load 2: the slabs at full thickness whatever the weather (the impostor thins them itself)
          iB.set([0, ki * 8 + v, 2, 0.5], k * 4);
          iF.set([f % IMP.cols, Math.floor(f / IMP.cols), (a / IMP.az) * Math.PI * 2, e * IMP.elStep], k * 4);
        }
      }
    }
    geo.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 4));
    geo.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 4));
    geo.setAttribute('iF', new THREE.InstancedBufferAttribute(iF, 4));
    geo.instanceCount = n;
    const mat = createBakeMaterial(kind, layoutOf(kind));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    made.push({ geo, mat });
  }

  const prevTarget = renderer.getRenderTarget();
  const prevMRT = renderer.getMRT();
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  try {
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.render(scene, cam);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setMRT(prevMRT);
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.autoClear = prevAuto;
  }
  // the bake geometries share the tree attributes: dispose only what is theirs
  for (const m of made) {
    m.mat.dispose();
    for (const name of ['iA', 'iB', 'iF']) m.geo.deleteAttribute(name);
  }
  const ms = performance.now() - t0;
  return {
    albedo: target.textures[0],
    aux: target.textures[1],
    target,
    ms,
    dispose: () => target.dispose(),
  };
}

// ------------------------------------------------------------------------------------------
// Runtime billboards
// ------------------------------------------------------------------------------------------

/** A unit quad (uv in position.xy) as an instanced geometry; the instance attributes are added by the caller. */
export function impostorGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// Two passes as for the 3D trees: a depth prepass decides coverage (alpha test), the lit pass
// shades only the front-most fragment (depth LESS-EQUAL with a small offset, no depth write, the
// same alpha decision). Both share the position node and the varyings below.

interface ImpVary { uv: N; f0: N; f1: N; w: N; m: N }
let impVary: ImpVary | null = null;
function impVaryings(): ImpVary {
  return (impVary ??= {
    uv: varyingProperty('vec2', 'iUV'),
    f0: varyingProperty('vec4', 'iF0'), // frame origins (x, y) of [e0][a0], [e0][a1]
    f1: varyingProperty('vec4', 'iF1'), // [e1][a0], [e1][a1]
    w: varyingProperty('vec4', 'iW'), // wa, we, yaw, load
    m: varyingProperty('vec4', 'iM'), // rnd, tB (fade), -, -
  });
}

let impPosition: N = null;
function impostorPosition(): N {
  if (impPosition) return impPosition;
  const V = impVaryings();
  impPosition = Fn(() => {
    const iA: N = attribute('iA', 'vec4');
    const iB: N = attribute('iB', 'vec4');
    const kv: N = iB.y.add(0.5).floor();
    const kind: N = floor(kv.div(8));
    const variant: N = kv.sub(kind.mul(8));
    const isSnag: N = step(1.5, kind);
    const isFir: N = step(0.5, kind).mul(isSnag.oneMinus());
    const type: N = select(isSnag.greaterThan(0.5), variant.sub(floor(variant.div(4)).mul(4)).add(16), kind.mul(8).add(variant));
    const S: N = iA.w;
    const yaw: N = iB.x;
    const rnd: N = iB.w;
    const hw: N = mix(mix(float(FRAME_BOX.spruce.hw), float(FRAME_BOX.fir.hw), isFir), float(FRAME_BOX.snag.hw), isSnag);
    const y0: N = float(FRAME_BOX.spruce.y0);
    const y1: N = mix(float(FRAME_BOX.spruce.y1), float(FRAME_BOX.snag.y1), isSnag);
    const H: N = mix(float(TREE_H), float(SNAG_H), isSnag).mul(S);
    const base: N = iA.xyz;
    const C: N = vec3(0, y0.add(y1).mul(0.5).mul(S), 0);
    const Vd: N = normalize(vec3(U.camPos).sub(base.add(C)));
    const Vl: N = rotY(Vd, yaw.negate());
    // frames around the view direction
    const phi: N = Vl.x.atan(Vl.z); // -pi..pi
    const a: N = fract(phi.div(Math.PI * 2).add(1)).mul(IMP.az);
    const a0: N = floor(a);
    const a1: N = a0.add(1).sub(step(IMP.az - 0.5, a0.add(1)).mul(IMP.az));
    const th: N = asin(Vl.y.clamp(-1, 1));
    const e: N = th.clamp(0, (IMP.el - 1) * IMP.elStep).div(IMP.elStep);
    const e0: N = floor(e).min(IMP.el - 2);
    const e1: N = e0.add(1);
    const frameXY = (ee: N, aa: N): N => {
      const f: N = type.mul(FRAMES_PER_TYPE).add(ee.mul(IMP.az)).add(aa);
      const fy: N = floor(f.div(IMP.cols));
      return vec2(f.sub(fy.mul(IMP.cols)), fy);
    };
    V.f0.assign(vec4(frameXY(e0, a0), frameXY(e0, a1)));
    V.f1.assign(vec4(frameXY(e1, a0), frameXY(e1, a1)));
    V.w.assign(vec4(fract(a), e.sub(e0).clamp(0, 1), yaw, effectiveSnow(iB.z)));
    // the quad faces the camera (elevation limited so the basis never degenerates)
    const thb: N = th.clamp(-0.35, 1.25);
    const right: N = vec3(cos(phi), 0, sin(phi).negate());
    const up: N = vec3(sin(thb).negate().mul(sin(phi)), cos(thb), sin(thb).negate().mul(cos(phi)));
    const uv: N = positionLocal.xy;
    V.uv.assign(uv);
    const halfW: N = hw.div(1 - 2 * IMP.marginX).mul(S);
    const halfH: N = y1.sub(y0).mul(0.5 / (1 - 2 * IMP.marginY)).mul(S);
    const local: N = C.add(right.mul(uv.x.sub(0.5).mul(2).mul(halfW))).add(up.mul(uv.y.sub(0.5).mul(2).mul(halfH)));
    const world: N = base.add(rotY(local, yaw)).toVar();
    const g: N = gustAt(base.xz);
    world.addAssign(treeSway(local.y.max(0), H, rnd, g).mul(FU.wind));
    // LOD: visible beyond the 3D trees, not thinned away, not past the end of the forest
    const d: N = lodDistance(base, H);
    const tB: N = smoothstep(FU.nearEnd.sub(FU.nearBand), FU.nearEnd, d);
    const thin: N = smoothstep(FU.thin0, FU.thin1, d).mul(step(FU.density, rnd));
    const gone: N = max(max(step(tB, 0.0005), step(0.999, thin)), step(FU.farEnd, d));
    V.m.assign(vec4(rnd, tB, 0, 0));
    return mix(world, base, gone);
  })();
  return impPosition;
}

/** Atlas coordinates of the two frames this pixel blends, and the explicit mip level. */
function impTaps(): { tA: N; tB: N; mip: N; wa: N } {
  const V = impVaryings();
  const inv: N = vec2(1 / IMP.cols, 1 / IMP.rows);
  const uv: N = V.uv;
  // the elevation row is picked per pixel by a dither (a stipple only while the view crosses
  // between rows); the two azimuth frames of that row are blended: two taps per texture
  const nE: N = fract(ditherNoise().add(0.5));
  const hi: N = step(nE, V.w.y);
  const fA: N = mix(V.f0.xy, V.f1.xy, hi), fB: N = mix(V.f0.zw, V.f1.zw, hi);
  // explicit mip level: the frame switch makes the atlas uv jump between pixels
  const texel: N = max(length(dFdx(uv.mul(vec2(IMP.fw, IMP.fh)))), length(dFdy(uv.mul(vec2(IMP.fw, IMP.fh))))).max(1e-6);
  // the baked atlas runs top-down in v on both backends (frame row 0 and each frame's top at v = 0
  // side of its cell, measured): flip into it
  const at = (f: N): N => { const t: N = f.add(uv).mul(inv); return vec2(t.x, t.y.oneMinus()); };
  return { tA: at(fA), tB: at(fB), mip: log2(texel).max(0), wa: V.w.x };
}

/** Depth prepass of the impostors: coverage only. */
export function createImpostorDepthMaterial(atlas: ImpostorAtlas): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'forest-impostor-depth';
  m.side = THREE.DoubleSide;
  m.alphaTest = 0.5;
  m.colorWrite = false;
  m.fog = false;
  const V = impVaryings();
  m.positionNode = impostorPosition();
  m.colorNode = vec4(0, 0, 0, impAlpha(atlas));
  return m;
}

/** Coverage of an impostor pixel (depth and lit passes alike). */
function impAlpha(atlas: ImpostorAtlas): N {
  const V = impVaryings();
  const t = impTaps();
  const cover: N = texture(atlas.albedo, t.tA).level(t.mip).a.mul(t.wa.oneMinus()).add(texture(atlas.albedo, t.tB).level(t.mip).a.mul(t.wa));
  // the mips average coverage away: give some back with distance so far crowns stay full
  const a1: N = cover.mul(t.mip.mul(0.3).add(1));
  const alpha: N = a1.sub(0.5).div(max(fwidth(a1), 0.0001)).add(0.5).clamp(0, 1);
  return alpha.mul(step(ditherNoise(), V.m.y.sub(0.00001)));
}

/** The lit impostors: depth test against the prepass, no depth write. */
export function createImpostorMaterial(atlas: ImpostorAtlas): THREE.MeshLambertNodeMaterial {
  const m = new ForestLambert();
  m.name = 'forest-impostor';
  m.side = THREE.DoubleSide;
  m.depthWrite = false;
  m.depthFunc = THREE.LessEqualDepth;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -4;
  m.alphaTest = 0.5;
  const V = impVaryings();
  m.positionNode = impostorPosition();

  const pEmis: N = property('vec3', 'csIEmis');
  const pAO: N = property('float', 'csIAO');
  const pN: N = property('vec3', 'csINormal');

  m.colorNode = Fn(() => {
    const t = impTaps();
    const A: N = texture(atlas.albedo, t.tA).level(t.mip).mul(t.wa.oneMinus()).add(texture(atlas.albedo, t.tB).level(t.mip).mul(t.wa));
    const B: N = texture(atlas.aux, t.tA).level(t.mip).mul(t.wa.oneMinus()).add(texture(atlas.aux, t.tB).level(t.mip).mul(t.wa));
    // the mips are premultiplied by coverage: divide it back out
    const k: N = float(1).div(A.a.max(0.004));
    const albedo: N = A.rgb.mul(k).mul(treeTint(V.m.x));
    const nx: N = B.x.mul(k).mul(2).sub(1), nz: N = B.y.mul(k).mul(2).sub(1);
    const nl: N = vec3(nx, sqrt(max(float(1).sub(nx.mul(nx)).sub(nz.mul(nz)), 0)), nz);
    const nW: N = normalize(rotY(nl, V.w.z));
    const ao: N = B.z.mul(k).clamp(0, 1);
    const pot: N = B.w.mul(k).clamp(0, 1);
    const sh = snowShade(nW);
    const c: N = snowCoverage(V.w.w, pot);
    const col: N = mix(albedo, sh.color, c).toVar();
    If(FU.lodTint.greaterThan(0.5), () => {
      col.mulAssign(vec3(0.5, 0.6, 1.7));
    });
    pEmis.assign(sh.emissive.mul(c));
    pAO.assign(mix(ao, 1, c.mul(0.6)));
    pN.assign(normalize(cameraViewMatrix.mul(vec4(nW, 0)).xyz));
    return vec4(col, impAlpha(atlas));
  })();
  m.emissiveNode = pEmis;
  m.aoNode = pAO;
  m.normalNode = pN;
  return m;
}
