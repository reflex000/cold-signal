// Materials of the 3D trees (full and simplified meshes) and of the impostor bake.
//
// PER INSTANCE (instanced attributes, see index.ts)
//   iA = (x, y, z, scale)          base of the trunk (already sunk into the snow), scale 1 = 14 m
//   iB = (yaw, kind * 8 + variant, snow load, rnd)   kind 0 spruce, 1 fir, 2 snag
//
// VARIANTS. The geometry is one per kind. The vertex shader turns it into one of eight variants
// from per-branch attributes: crown base height (lower branches dead: dead-twig cards take their
// place), branches missing, branch length jitter, a fuller side, lean. Everything depends on the
// variant only (never on the instance position), so impostors baked per variant match exactly.
//
// LOD. Every instance computes its distance to the camera; two thresholds tLo / tHi go to the
// fragment shader, which keeps a pixel when tLo <= dither < tHi. The full mesh, the simplified mesh
// and the impostor use complementary ranges of the same screen-space dither, so a crossfade never
// leaves holes or doubles. An instance outside its range collapses to a point (no fragments).
// Thinning (quality.treeDensity) uses the same dither, among the impostors only (beyond the 3D
// trees: nothing invisible to walk into, and no half-dissolved 3D tree).
import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, attribute, cameraProjectionMatrix, cameraWorldMatrix, cos, cross, dFdx, dFdy, dot, float, floor, fract, frontFacing, fwidth,
  length, log2, max, min, mix, mrt, normalLocal, normalViewGeometry, normalize, output, positionLocal, positionView, positionWorld,
  property, select, sin, smoothstep, step, texture, uniform, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { U } from '../shared';
import {
  ForestLambert, branchBounce, ditherNoise, effectiveSnow, gustAt, hash11, noiseAt, rotY, snowCoverage, snowShade, treeSway, type N,
} from './common';
import { getFoliageAtlas } from './textures';
import { PART, SNAG_H, TREE_H, type GeoKind, type GeoLod } from './treegen';

/** Forest-wide knobs, written by the forest system (setQuality / update). */
export const FU = {
  fullEnd: uniform(30), // m: centre of the full -> simplified crossfade
  fullBand: uniform(5),
  nearEnd: uniform(80), // m: end of the 3D trees (quality.treeNear)
  nearBand: uniform(12),
  thin0: uniform(22), // m: thinning by treeDensity fades in between thin0 and thin1
  thin1: uniform(42),
  density: uniform(1),
  lodTint: uniform(0), // 1: tint by LOD (bench ?lod=1)
  wind: uniform(1),
  farEnd: uniform(6000), // m: impostors end
  /**
   * 1 where there is no anti-aliasing (phones): LOD crossfades switch whole trees, each at its own
   * point in the band, instead of a per-pixel dither that reads as a stipple without AA.
   */
  perTree: uniform(0),
};

/** Threshold the LOD crossfades compare against (the same for a tree's mesh and its impostor). */
export function lodNoise(rnd: N): N {
  return mix(ditherNoise(), hash11(float(rnd).mul(97.13).add(0.31)), FU.perTree);
}

export const KIND_INDEX: Record<GeoKind, number> = { spruce: 0, fir: 1, snag: 2 };

// ------------------------------------------------------------------------------------------
// Instance data and the variant shape (shared by the runtime and the bake materials)
// ------------------------------------------------------------------------------------------

export interface Inst {
  base: N; scale: N; yaw: N; variant: N; load: N; rnd: N; height: N;
}

export function instanceData(kind: GeoKind): Inst {
  const iA: N = attribute('iA', 'vec4');
  const iB: N = attribute('iB', 'vec4');
  const kv: N = iB.y.add(0.5).floor();
  const variant: N = kv.sub(floor(kv.div(8)).mul(8));
  return {
    base: iA.xyz,
    scale: iA.w,
    yaw: iB.x,
    variant,
    load: effectiveSnow(iB.z),
    rnd: iB.w,
    height: iA.w.mul(kind === 'snag' ? SNAG_H : TREE_H),
  };
}

/** Distance used for every LOD decision (the CPU uses the same: index.ts). */
export function lodDistance(base: N, height: N): N {
  return length(vec3(U.camPos).sub(base.add(vec3(0, height.mul(0.45), 0))));
}

export interface Shape {
  p: N; // tree-local position (scale 1), after the variant
  n: N; // tree-local normal
  part: N; // float part id
  along: N;
  isBranch: N; // 1 on branches (cards, slabs, stubs), 0 on the trunk
  attach: N; // vec3 attachment point
  hash: N;
}

/** Crown base of a variant, as a fraction of the height (dead lower trunk below it). */
function crownBase(v: N): N {
  return fract(v.mul(0.618).add(0.13)).mul(0.3);
}

export function variantShape(kind: GeoKind, inst: Inst): Shape {
  const aB: N = attribute('aB', 'vec4');
  const aC: N = attribute('aC', 'vec4');
  const p0: N = positionLocal;
  const n0: N = normalLocal;
  const part: N = floor(aB.z);
  const az: N = fract(aB.z).sub(0.05).div(0.9).mul(Math.PI * 2);
  const hash: N = aB.y;
  const isBranch: N = step(0.00001, hash);
  const hN: N = aC.x;
  const v: N = inst.variant;
  const attach: N = vec3(0, aB.x, 0);
  const j: N = hash11(hash.mul(97.31).add(v.mul(13.17)));
  let k: N;
  let p: N;
  let n: N = n0;
  if (kind === 'snag') {
    // broken top: the trunk ends in a splintered rim at a height set by the variant (4 shapes)
    const v4: N = v.sub(floor(v.div(4)).mul(4));
    const hb: N = float(SNAG_H).mul(v4.mul(0.12).add(0.5).add(hash11(v4.mul(3.1).add(0.7)).mul(0.06)));
    const ang: N = p0.z.atan(p0.x); // -pi..pi
    const sector: N = floor(ang.mul(6 / Math.PI).add(6.0).add(v4.mul(0.37)));
    const spl: N = hash11(sector.mul(7.13).add(v4.mul(2.9))).pow(2).mul(0.85).add(0.06);
    const top: N = hb.add(spl);
    const isTrunk: N = isBranch.oneMinus();
    const cut: N = step(top, p0.y).mul(isTrunk);
    const yTrunk: N = min(p0.y, top);
    // stubs above the break went with the top; a third of the others broke off long ago
    const keep: N = step(aB.x, hb.sub(0.15)).mul(step(0.3, hash11(hash.mul(53.1).add(v4.mul(1.7)))));
    k = mix(float(1), keep.mul(j.mul(0.4).add(0.8)), isBranch);
    p = attach.add(p0.sub(attach).mul(k));
    p = vec3(p.x, mix(p.y, yTrunk, isTrunk), p.z);
    n = normalize(mix(n0, vec3(n0.x.mul(0.35), 1, n0.z.mul(0.35)), cut));
    // snags lean more than live trees
    const la: N = hash11(v4.mul(5.7).add(0.9)).mul(6.2831);
    const amt: N = hash11(v4.mul(2.3).add(4.1)).mul(0.07).add(0.01);
    p = vec3(p.x.add(p.y.mul(cos(la).mul(amt))), p.y, p.z.add(p.y.mul(sin(la).mul(amt))));
  } else {
    const cb: N = crownBase(v);
    const f: N = j.mul(0.36).add(0.82);
    // a fuller side (shelter / light) on most variants
    const asym: N = cos(az.sub(v.mul(2.1))).mul(hash11(v.mul(5.3).add(1.7)).mul(0.32)).add(1);
    const dropRate: N = hN.oneMinus().mul(0.14).add(0.05);
    const dropped: N = step(hash11(hash.mul(61.7).add(v.mul(7.31)).add(3.1)), dropRate);
    const dead: N = max(step(hN, cb), dropped);
    const fLive: N = f.mul(asym).mul(dead.oneMinus());
    // dead twigs show only where a branch is gone, low on the trunk
    const fDead: N = dead.mul(step(hN, 0.5)).mul(step(0.45, hash11(hash.mul(17.3).add(v.mul(3.3))))).mul(j.mul(0.4).add(0.55));
    const fb: N = select(part.equal(PART.DEAD), fDead, fLive);
    k = mix(float(1), fb, isBranch);
    p = attach.add(p0.sub(attach).mul(k));
    // the slab of snow settles onto the spray as the load gets lighter
    const thick: N = smoothstep(0.06, 0.75, inst.load);
    p = p.sub(vec3(0, aC.w.mul(thick.oneMinus()), 0));
    // a slight lean
    const la: N = hash11(v.mul(3.7).add(0.3)).mul(6.2831);
    const amt: N = hash11(v.mul(8.1).add(2.2)).mul(0.03);
    p = vec3(p.x.add(p.y.mul(cos(la).mul(amt))), p.y, p.z.add(p.y.mul(sin(la).mul(amt))));
  }
  return { p, n, part, along: aB.w, isBranch, attach, hash };
}

// ------------------------------------------------------------------------------------------
// Fragment surface (shared by the runtime and the bake): albedo, alpha, snow potential, AO, ...
// ------------------------------------------------------------------------------------------

export interface Surface {
  albedo: N; // before snow, AO for direct light folded in
  alpha: N;
  potential: N; // snow potential of this pixel
  ao: N;
  rough: N;
  isSnowPart: N; // 1 on the snow slabs
}

/** Foliage colour variation per tree, from rnd (shared with the impostor shader). */
export function treeTint(rnd: N): N {
  const a: N = hash11(rnd.mul(71.3).add(0.4));
  const b: N = hash11(rnd.mul(13.9).add(5.1));
  return mix(vec3(0.84, 0.92, 1.06), vec3(1.1, 1.05, 0.88), a).mul(b.mul(0.3).add(0.85));
}

interface SurfaceIn {
  part: N; // float part id (varying)
  ao: N;
  pot: N; // vertex snow potential
  uv: N;
  tint: N;
  faceUp: N; // world-space up component of the visible side of the triangle
  wp: N; // position for noise (world at runtime, tree-local in the bake)
}

function surface(kind: GeoKind, I: SurfaceIn): Surface {
  const atlas = getFoliageAtlas();
  const uv: N = I.uv;
  // derivatives and implicit-LOD texture taps stay in uniform control flow (WGSL rule)
  const tex: N = texture(atlas, uv);
  const duv: N = max(length(dFdx(uv.mul(1024))), length(dFdy(uv.mul(1024)))).max(1e-6);
  const lod: N = log2(duv).max(0);
  const dense: N = texture(atlas, uv).level(lod.add(3)).a;
  const a0: N = tex.a;
  const aSharp: N = a0.sub(0.5).div(max(fwidth(a0), 0.0001)).add(0.5).clamp(0, 1);
  const wp: N = I.wp;
  const nz: N = noiseAt(vec2(wp.x.add(wp.y.mul(0.37)), wp.z.sub(wp.y.mul(0.29))).mul(0.37));
  const bu: N = uv.x.mul(Math.PI * 2 * 0.2); // bark: metres around the trunk
  const bv: N = uv.y; // and along it
  const lodB: N = log2(max(length(dFdx(vec2(bu, bv))), length(dFdy(vec2(bu, bv)))).max(1e-5).mul(256)).max(0);
  const faceUp: N = I.faceUp;

  const part: N = floor(I.part.add(0.5));
  const albedo: N = vec3(0).toVar();
  const alpha: N = float(1).toVar();
  const potential: N = float(0).toVar();
  const rough: N = float(0.9).toVar();
  const isSnow: N = float(0).toVar();

  If(part.equal(PART.FOLIAGE), () => {
    // (x1.3, POLISH: spruce needles reflect ~5% of visible light; the atlas alone drew ~3%)
    albedo.assign(tex.rgb.mul(I.tint).mul(nz.z.mul(0.39).add(1.1)));
    alpha.assign(aSharp);
    // snow catches on the up-facing side of the sprays, more where they are dense
    const up: N = smoothstep(0.08, 0.6, faceUp);
    // snow sits on the needle masses: the brighter (outer) needles of the texture catch it first
    const needle: N = tex.g.div(0.034).sub(1).clamp(-0.6, 0.6);
    potential.assign(I.pot.mul(up).mul(dense.mul(0.55).add(0.45)).mul(nz.x.mul(0.6).add(0.7)).mul(needle.mul(0.6).add(1)));
    rough.assign(0.86);
  }).ElseIf(part.equal(PART.DEAD), () => {
    // dead lower twigs: dark grey-brown, wet with melt, never pale
    albedo.assign(tex.rgb.mul(vec3(0.52, 0.48, 0.45)));
    alpha.assign(aSharp);
    potential.assign(I.pot.mul(smoothstep(0.1, 0.7, faceUp)).mul(nz.x.mul(0.6).add(0.7)));
    rough.assign(0.9);
  }).ElseIf(part.equal(PART.SNOW), () => {
    // what the impostor shows where the load is too light for snow: the needles under the slab
    albedo.assign(vec3(0.026, 0.04, 0.032).mul(I.tint));
    // patchy: the edges and thin spots go first as the load gets lighter
    potential.assign(I.pot.sub(nz.y.mul(0.32)).add(0.1));
    rough.assign(0.86);
    isSnow.assign(1);
  }).Else(() => {
    if (kind === 'snag') {
      // silver-grey weathered wood, long checks along the grain, patches of old bark low down
      const g: N = noiseAt(vec2(bu.mul(3.1), bv.mul(0.16))).level(lodB);
      const g2: N = noiseAt(vec2(bu.mul(11.0), bv.mul(0.9)).add(0.37)).level(lodB);
      const check: N = smoothstep(0.035, 0.0, abs(g.x.sub(0.5))).mul(0.6);
      const barkPatch: N = smoothstep(0.62, 0.7, g2.w.add(smoothstep(4.0, 0.5, bv).mul(0.35)));
      const wood: N = vec3(0.2, 0.19, 0.175).mul(g2.x.mul(0.35).add(0.8)).mul(check.oneMinus());
      albedo.assign(mix(wood, vec3(0.05, 0.042, 0.036).mul(g2.y.mul(0.5).add(0.75)), barkPatch));
    } else {
      // scaly bark: plates between fissures, darker in the cracks
      const g: N = noiseAt(vec2(bu.mul(4.0), bv.mul(0.55))).level(lodB);
      const g2: N = noiseAt(vec2(bu.mul(13.0), bv.mul(2.2)).add(0.61)).level(lodB);
      const fiss: N = smoothstep(0.06, 0.0, abs(g.x.sub(0.5))).max(smoothstep(0.05, 0.0, abs(g2.x.sub(0.5))).mul(0.6));
      const base: N = kind === 'fir' ? vec3(0.095, 0.095, 0.09) : vec3(0.075, 0.062, 0.05);
      albedo.assign(base.mul(g2.y.mul(0.45).add(0.75)).mul(mix(1, 0.35, fiss)));
    }
    potential.assign(smoothstep(0.55, 0.9, faceUp).mul(0.95));
    rough.assign(0.93);
  });
  // a little of the bake goes into direct light too (self-shadow the shadow map is too coarse for)
  return { albedo: albedo.mul(mix(1, I.ao, 0.5)), alpha, potential, ao: I.ao, rough, isSnowPart: isSnow };
}

/** Normal of the visible side of the current triangle, from position derivatives, facing `toEye`. */
function visibleFace(p: N, toEye: N): N {
  const nf0: N = normalize((cross as any)(dFdx(p), dFdy(p)).add(vec3(1e-9, 2e-9, 3e-9)));
  return nf0.mul(select(dot(nf0, toEye).lessThan(0), float(-1), float(1)));
}

// ------------------------------------------------------------------------------------------
// Runtime materials (full / simplified meshes)
//
// Foliage is drawn in two passes so each pixel is lit once, however many cards overlap:
//   depth  cheap: alpha test (atlas alpha, slab coverage, LOD dither) and depth only
//   lit    the full shading, depth test LESS-EQUAL with a small offset toward the eye, no depth
//          write: early depth testing rejects everything behind the front-most fragment
// Both share one position node and the same alpha decision. (EQUAL was tried: the two programs'
// vertex code is compiled separately and does not give bit-identical depth, so whole triangles
// failed and became invisible occluders.) Shadows come from a separate cheap proxy.
// ------------------------------------------------------------------------------------------

interface Vary { part: N; misc: N; fade: N }

let vary: Vary | null = null;
/** The varyings every tree material shares (the same node objects, so the stages agree). */
function varyings(): Vary {
  return (vary ??= {
    part: varyingProperty('float', 'fPart'),
    misc: varyingProperty('vec4', 'fMisc'), // ao, potential, load, rnd
    fade: varyingProperty('vec2', 'fFade'), // tLo, tHi
  });
}

const positionCache = new Map<string, N>();

/** The position node of a tree level (one instance per kind and level, shared by its materials). */
function treePosition(kind: GeoKind, lod: GeoLod): N {
  const key = kind + lod;
  const hit = positionCache.get(key);
  if (hit) return hit;
  const V = varyings();
  const aC: N = attribute('aC', 'vec4');
  const node: N = Fn(() => {
    const inst = instanceData(kind);
    const sh = variantShape(kind, inst);
    const wf: N = hash11(inst.rnd.mul(31.7).add(0.2)).mul(0.16).add(0.92); // stout or slender
    const pl: N = vec3(sh.p.x.mul(wf), sh.p.y, sh.p.z.mul(wf)).mul(inst.scale);
    const world: N = inst.base.add(rotY(pl, inst.yaw)).toVar();
    // wind: the whole tree sways, the branches bounce
    const g: N = gustAt(inst.base.xz);
    const sway: N = treeSway(pl.y.max(0), inst.height, inst.rnd, g);
    const reach: N = length(sh.p.sub(sh.attach)).mul(inst.scale);
    const bounce: N = branchBounce(reach, sh.along, fract(sh.hash.mul(7.7).add(inst.rnd)), g, inst.load).mul(sh.isBranch);
    world.addAssign(sway.add(bounce).mul(FU.wind));
    normalLocal.assign(rotY(sh.n, inst.yaw));
    // LOD range of this instance
    const d: N = lodDistance(inst.base, inst.height);
    const tA: N = smoothstep(FU.fullEnd.sub(FU.fullBand.mul(0.5)), FU.fullEnd.add(FU.fullBand.mul(0.5)), d);
    const tB: N = smoothstep(FU.nearEnd.sub(FU.nearBand), FU.nearEnd, d);
    const tThin: N = smoothstep(FU.thin0, FU.thin1, d).mul(step(FU.density, inst.rnd));
    // snags have one 3D level: it runs all the way to the impostors
    const lo: N = lod === 'full' && kind !== 'snag' ? max(tA, tThin) : max(tB, tThin);
    const hi: N = lod === 'full' ? float(1.01) : tA;
    V.fade.assign(vec2(lo, hi));
    V.part.assign(sh.part);
    V.misc.assign(vec4(aC.y, aC.z, inst.load, inst.rnd));
    // outside its range the whole instance collapses to a point
    const gone: N = step(hi.sub(0.0005), lo);
    return mix(world, inst.base, gone);
  })();
  positionCache.set(key, node);
  return node;
}

/** Noise for the snow on slabs and sprays (world position, one tap). */
function snowNoise(wp: N): N {
  return noiseAt(vec2(wp.x.add(wp.y.mul(0.37)), wp.z.sub(wp.y.mul(0.29))).mul(0.37));
}

/** Coverage decision of the depth pass (and of shadows): cheap, one atlas tap and one noise tap. */
function treeAlpha(V: Vary): N {
  const tex: N = texture(getFoliageAtlas(), attribute('uv', 'vec2'));
  const a0: N = tex.a;
  const aSharp: N = a0.sub(0.5).div(max(fwidth(a0), 0.0001)).add(0.5).clamp(0, 1);
  const part: N = floor(V.part.add(0.5));
  const nz: N = snowNoise(positionWorld);
  // slabs go patchy as the load gets lighter; the same rule colours them in the lit pass
  const slab: N = select(frontFacing, step(0.5, snowCoverage(V.misc.z, V.misc.y.sub(nz.y.mul(0.32)).add(0.1))), float(0));
  const isCard: N = part.equal(PART.FOLIAGE).or(part.equal(PART.DEAD));
  const a: N = select(isCard, aSharp, select(part.equal(PART.SNOW), slab, float(1)));
  const n: N = lodNoise(V.misc.w);
  return a.mul(step(V.fade.x, n)).mul(step(n, V.fade.y.sub(0.00001)));
}

/** Depth prepass of a tree level. */
export function createTreeDepthMaterial(kind: GeoKind, lod: GeoLod): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = `forest-${kind}-${lod}-depth`;
  m.side = THREE.DoubleSide;
  m.alphaTest = 0.5;
  m.colorWrite = false;
  m.fog = false;
  const V = varyings();
  m.positionNode = treePosition(kind, lod);
  m.colorNode = vec4(0, 0, 0, treeAlpha(V));
  return m;
}

/** The lit pass of a tree level: depth test against its prepass, no depth write. */
export function createTreeMaterial(kind: GeoKind, lod: GeoLod): THREE.MeshLambertNodeMaterial {
  const m = new ForestLambert();
  m.name = `forest-${kind}-${lod}`;
  m.side = THREE.DoubleSide;
  m.depthWrite = false;
  m.depthFunc = THREE.LessEqualDepth;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -4;
  m.alphaTest = 0.5;
  const V = varyings();
  m.positionNode = treePosition(kind, lod);

  const pEmis: N = property('vec3', 'csFEmis');
  const pAO: N = property('float', 'csFAO');

  m.colorNode = Fn(() => {
    const load: N = V.misc.z;
    const tint: N = treeTint(V.misc.w);
    const face: N = visibleFace(positionView, positionView.negate()).transformDirection(cameraWorldMatrix);
    const s = surface(kind, { part: V.part, ao: V.misc.x, pot: V.misc.y, uv: attribute('uv', 'vec2'), tint, faceUp: face.y, wp: positionWorld });
    const nW: N = normalize(normalViewGeometry).transformDirection(cameraWorldMatrix);
    const sh = snowShade(nW);
    // a slab that is drawn at all is snow (the depth pass dropped the thin parts); on needles the
    // snow is either there or not: a narrow edge, no grey half-snow
    const c: N = select(s.isSnowPart.greaterThan(0.5), float(1), snowCoverage(load, s.potential, 0.03));
    const col: N = mix(s.albedo, sh.color, c).toVar();
    If(FU.lodTint.greaterThan(0.5), () => {
      col.mulAssign(lod === 'full' ? vec3(1.6, 0.5, 0.4) : vec3(0.45, 1.5, 0.5));
    });
    pEmis.assign(sh.emissive.mul(c));
    pAO.assign(mix(s.ao, 1, c.mul(0.6)));
    // the same coverage decision as the depth pass
    return vec4(col, treeAlpha(V));
  })();
  m.emissiveNode = pEmis;
  m.aoNode = pAO;
  // never flip the normal on back faces: foliage cards shade with the crown normal on both sides
  m.normalNode = normalize(normalViewGeometry);
  return m;
}

/**
 * Shadow proxy of a conifer: tiers of the crown envelope (treegen proxyGeometry) with dappled
 * holes, swaying like the tree. It is only ever drawn into shadow maps (index.ts makes its main
 * pass instance count zero), so the crowns cast solid, layered shadows for a few triangles each.
 */
export function createProxyMaterial(kind: GeoKind): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = `forest-${kind}-proxy`;
  // front faces outward: the shadow pass draws the back faces (one layer per tier) and, with no
  // discard anywhere, keeps early depth rejection
  m.side = THREE.FrontSide;
  m.fog = false;
  m.colorWrite = false;
  m.positionNode = Fn(() => {
    const inst = instanceData(kind);
    const aB: N = attribute('aB', 'vec4');
    const aC: N = attribute('aC', 'vec4');
    const p0: N = positionLocal;
    const v: N = inst.variant;
    // fades (shrinks to the trunk) before the impostors take over: an impostor is never shadowed
    // by its own proxy; thinned trees shrink with their tree
    const d: N = lodDistance(inst.base, inst.height);
    const fade: N = smoothstep(FU.nearEnd.sub(FU.nearBand.mul(1.8)), FU.nearEnd.sub(FU.nearBand), d).max(
      smoothstep(FU.thin0, FU.thin1, d).mul(step(FU.density, inst.rnd))).oneMinus();
    // tiers below the variant's crown base are gone; a fuller side as on the tree
    const isTier: N = step(0.00001, aB.y);
    const cb: N = crownBase(v);
    const alive: N = step(cb, aC.x).max(isTier.oneMinus());
    const az: N = p0.z.atan(p0.x);
    const asym: N = cos(az.sub(v.mul(2.1))).mul(hash11(v.mul(5.3).add(1.7)).mul(0.32)).add(1);
    const k: N = mix(float(1), asym.mul(alive), isTier).mul(fade);
    const attach: N = vec3(0, aB.x, 0);
    let p: N = attach.add(p0.sub(attach).mul(vec3(k, 1, k)));
    p = vec3(p.x, mix(p.y, aB.x, alive.oneMinus().mul(isTier)), p.z);
    const la: N = hash11(v.mul(3.7).add(0.3)).mul(6.2831);
    const amt: N = hash11(v.mul(8.1).add(2.2)).mul(0.03);
    p = vec3(p.x.add(p.y.mul(cos(la).mul(amt))), p.y, p.z.add(p.y.mul(sin(la).mul(amt))));
    const wf: N = hash11(inst.rnd.mul(31.7).add(0.2)).mul(0.16).add(0.92);
    const pl: N = vec3(p.x.mul(wf), p.y, p.z.mul(wf)).mul(inst.scale);
    const world: N = inst.base.add(rotY(pl, inst.yaw)).toVar();
    const g: N = gustAt(inst.base.xz);
    world.addAssign(treeSway(pl.y.max(0), inst.height, inst.rnd, g).mul(FU.wind));
    return mix(inst.base, world, step(0.001, fade));
  })();
  return m;
}

// ------------------------------------------------------------------------------------------
// Bake material: renders every (variant, view) frame of a kind into the impostor atlas at once
// ------------------------------------------------------------------------------------------

export interface BakeLayout {
  cols: number; // frames across the atlas
  rows: number; // frames down
  hw: number; // half width of the frame box, m
  y0: number; // box bottom, m
  y1: number; // box top, m
  marginX: number; // fraction of the frame kept empty at each side
  marginY: number;
}

/**
 * Per instance: iF = (frame x, frame y, azimuth, elevation). Output (MRT): output = albedo with
 * alpha 1 where covered (the cleared atlas is 0, so mips come out premultiplied), aux = (normal.x,
 * normal.z, ao, snow potential) in tree-local space.
 */
export function createBakeMaterial(kind: GeoKind, L: BakeLayout): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = `forest-bake-${kind}`;
  m.side = THREE.DoubleSide;
  m.fog = false;
  m.toneMapped = false;
  const iF: N = attribute('iF', 'vec4');
  const aC: N = attribute('aC', 'vec4');
  const vPart: N = varyingProperty('float', 'bPart');
  const vMisc: N = varyingProperty('vec4', 'bMisc');
  const vN: N = varyingProperty('vec3', 'bNormal');
  const vP: N = varyingProperty('vec3', 'bPos');
  const vV: N = varyingProperty('vec3', 'bView');

  m.vertexNode = Fn(() => {
    const inst = instanceData(kind);
    const sh = variantShape(kind, inst);
    const phi: N = iF.z, th: N = iF.w;
    const V: N = vec3(sin(phi).mul(cos(th)), sin(th), cos(phi).mul(cos(th)));
    const right: N = vec3(cos(phi), 0, sin(phi).negate());
    const up: N = vec3(sin(th).negate().mul(sin(phi)), cos(th), sin(th).negate().mul(cos(phi)));
    const C: N = vec3(0, (L.y0 + L.y1) * 0.5, 0);
    const q: N = sh.p.sub(C);
    const xv: N = dot(q, right).div(L.hw).mul(1 - 2 * L.marginX);
    const yv: N = dot(q, up).div((L.y1 - L.y0) * 0.5).mul(1 - 2 * L.marginY);
    const zv: N = dot(q, V).sub(30);
    const clip: N = cameraProjectionMatrix.mul(vec4(xv, yv, zv, 1));
    // into this frame's rectangle of the atlas (orthographic: w = 1)
    const fx0: N = iF.x.mul(2 / L.cols).sub(1);
    const fy0: N = iF.y.mul(2 / L.rows).sub(1);
    const cx: N = fx0.add(clip.x.mul(0.5).add(0.5).mul(2 / L.cols));
    const cy: N = fy0.add(clip.y.mul(0.5).add(0.5).mul(2 / L.rows));
    vPart.assign(sh.part);
    vMisc.assign(vec4(aC.y, aC.z, inst.load, inst.rnd));
    vN.assign(sh.n);
    vP.assign(sh.p);
    vV.assign(V);
    return vec4(cx, cy, clip.z, clip.w);
  })();

  const pAux: N = property('vec4', 'csBakeAux');
  m.colorNode = Fn(() => {
    const face: N = visibleFace(vP, vV);
    const s = surface(kind, { part: vPart, ao: vMisc.x, pot: vMisc.y, uv: attribute('uv', 'vec2'), tint: vec3(1), faceUp: face.y, wp: vP });
    s.alpha.lessThan(0.5).discard();
    const n: N = normalize(vN);
    pAux.assign(vec4(n.x.mul(0.5).add(0.5), n.z.mul(0.5).add(0.5), s.ao, s.potential.clamp(0, 1)));
    return vec4(s.albedo, 1);
  })();
  m.mrtNode = mrt({ output, aux: pAux });
  return m;
}
