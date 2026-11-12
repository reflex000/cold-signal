// THE PROP MATERIAL. One TSL MeshStandardNodeMaterial draws every model the kit builds (plus a
// glass variant for ModelDef.glass). It reads the kit's vertex layout (see kit.ts):
//
//   color   rgb = sqrt(albedo), a = baked AO        aDetail  xyz = detail coordinates, w = MAT id
//   aSurf   roughness, metalness, wear, emissive    aEnv     snow exposure, sway length, snow push, sway stiffness
//
// What it adds, per material id, from the detail coordinates: wood grain and end grain, bark
// furrows, brushed and scratched metal that rusts, paint that chips to primer and steel and bleeds
// rust, woven cloth, scuffed plastic, rubber, fur, ice, charred wood with glowing cracks; a bump
// normal from the same height field; wet darkening at the edge of the snow; and SNOW COVER:
// up-facing surfaces blend to snow by U.snowCover * exposure with a noisy edge, and the vertices
// are pushed up a few centimetres so the cap has thickness. Cloth with a sway length swings and
// flutters in U.windDir / U.windSpeed / U.gust.
//
// INSTANCING. Use it on a Mesh or an InstancedMesh, nothing else to set up. three applies the
// instance matrix to positionLocal / normalLocal BEFORE positionNode runs, so everything here
// (snow facing, wind, the push) is computed per instance in world space; one material and one
// compiled program serve every model and every instance. Do not set instanceColor (it would be a
// ninth vertex buffer on WebGPU with motion vectors on). The geometry has 6 attributes on purpose.
//
// COST. Three shared noise taps (one small RGBA8 texture, explicit LOD), one or two more inside
// the branch for the pixel's material, one for snow sparkle. No loops, no screen-space reads.
// The WebGPU and WebGL2 backends compile the same node graph.
//
// ENVIRONMENT. If the scene has no environment map, metals would be black: the material then
// reflects an analytic sky made from U.skyAmbient / U.groundAmbient / U.fogColor, so it always
// agrees with the weather. With scene.environment set, three's own image-based lighting is used.
import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, attribute, cameraWorldMatrix, cameraViewMatrix, cos, cross, dFdx, dFdy, dot, exp, float, floor, fract, int, length, log2,
  max, min, mix, modelWorldMatrix, modelWorldMatrixInverse, normalLocal, normalView, normalViewGeometry, normalize, positionLocal, positionView,
  positionViewDirection, pow, property, roughness, sin, smoothstep, sqrt, step, texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { U } from '../gfx/shared';
import { MAT } from './kit';

// ------------------------------------------------------------------------------------------
// Shared noise texture: two independent value noises, each stored with its own copy shifted by
// (37, 17) so that one bilinear fetch returns two neighbouring Z slices of a 3D lattice.
// ------------------------------------------------------------------------------------------

let noiseTex: THREE.DataTexture | null = null;
function getNoiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  // small deterministic generator: the material must look the same on every machine
  let s = 0x2545f491;
  const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  const a = new Uint8Array(N * N), b = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) { a[i] = Math.floor(rnd() * 256); b[i] = Math.floor(rnd() * 256); }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, j = ((y + 17) & 255) * N + ((x + 37) & 255);
    data[i * 4] = a[j];
    data[i * 4 + 1] = a[i];
    data[i * 4 + 2] = b[j];
    data[i * 4 + 3] = b[i];
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}

/** Optional global knobs for the prop material (shared by every instance of it). */
export const PROP_U = {
  /** Extra wetness 0..1 on everything open to the sky (melt, sleet). The band of wet around snow patches is automatic. */
  wet: uniform(0),
  /** Thickness of a full snow cap in metres. */
  snowDepth: uniform(0.04),
};

type N = any;

/** vec2 of two independent 3D value noises in 0..1 at lattice point p, mip level lod. */
function noise2(p: N, lod: N): N {
  const tex = getNoiseTexture();
  const i: N = floor(p);
  const f: N = p.sub(i);
  const u: N = f.mul(f).mul(f.mul(-2).add(3));
  const iw: N = i.sub(floor(i.div(256)).mul(256)); // wrap before scaling: keeps float precision far from the origin
  const uv: N = iw.xy.add(iw.z.mul(vec2(37, 17))).add(u.xy).add(0.5).div(256);
  const t: N = texture(tex, uv).level(lod);
  return mix(t.yw, t.xz, u.z);
}

// ------------------------------------------------------------------------------------------
// Analytic sky reflection, used when the scene has no environment map
// ------------------------------------------------------------------------------------------

class SkyReflectionNode extends THREE.LightingNode {
  static get type(): string {
    return 'ColdSignalSkyReflectionNode';
  }
  setup(builder: any): any {
    const refl: N = positionViewDirection.negate().reflect(normalView);
    const dir: N = pow(roughness, 4).mix(refl, normalView).normalize().transformDirection(cameraWorldMatrix);
    const blur: N = roughness.mul(0.6).add(0.12);
    const zenith: N = vec3(U.skyAmbient).mul(0.42);
    const horizon: N = vec3(U.fogColor);
    const ground: N = vec3(U.groundAmbient).mul(0.5);
    const sky: N = mix(horizon, zenith, dir.y.max(0).pow(0.6));
    const radiance: N = mix(ground, sky, smoothstep(blur.negate(), blur, dir.y));
    builder.context.radiance.addAssign(radiance);
    return null;
  }
}

class PropNodeMaterial extends THREE.MeshStandardNodeMaterial {
  static get type(): string {
    return 'ColdSignalPropMaterial';
  }
  setupEnvironment(builder: any): any {
    const node = super.setupEnvironment(builder);
    return node ?? new SkyReflectionNode();
  }
}

// ------------------------------------------------------------------------------------------
// Vertex stage: wind sway and the snow push (shared by the opaque and glass materials)
// ------------------------------------------------------------------------------------------

function makePositionNode(): N {
  const aEnv: N = attribute('aEnv', 'vec4');
  return Fn(() => {
    const world: N = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz.toVar();
    const swayLen: N = aEnv.y.mul(2.55);
    const stiff: N = aEnv.w;
    const wind: N = vec3(U.windDir.x, 0, U.windDir.y);
    const side: N = vec3(U.windDir.y.negate(), 0, U.windDir.x);
    const speed: N = U.windSpeed;
    // Pendulum: a point `swayLen` below its pin swings out along the wind by angle th, keeping its
    // length. Limp cloth flies out nearly flat in a storm; stiff things only tremble.
    const limp: N = stiff.oneMinus();
    const lean: N = float(1.45).mul(exp(speed.mul(-0.11)).oneMinus()).mul(limp.mul(limp));
    const ph: N = dot(world.xz, vec2(0.71, 1.37));
    const w1: N = speed.mul(0.45).add(2.6);
    const amp: N = U.gust.mul(0.3).add(speed.mul(0.012)).add(0.05).mul(limp.mul(0.75).add(0.25));
    const t: N = U.time;
    const flutter: N = sin(t.mul(w1).sub(swayLen.mul(7)).add(ph)).mul(0.6).add(sin(t.mul(w1.mul(2.3)).sub(swayLen.mul(15)).add(ph.mul(1.7))).mul(0.4));
    const th: N = lean.add(flutter.mul(amp)).clamp(-0.5, 1.5);
    const whip: N = sin(t.mul(w1.mul(1.6)).sub(swayLen.mul(11)).add(ph.mul(2.3))).mul(amp).mul(0.35);
    const sway: N = wind.mul(sin(th)).add(vec3(0, 1, 0).mul(cos(th).oneMinus())).add(side.mul(whip)).mul(swayLen);
    // Snow cap: straight up, by a weight the kit welded so that coincident vertices move together.
    const lump: N = sin(world.x.mul(9.1).add(world.z.mul(6.3))).mul(sin(world.z.mul(11.7).sub(world.x.mul(4.9)))).mul(0.35).add(0.75);
    const push: N = aEnv.z.mul(U.snowCover).mul(PROP_U.snowDepth).mul(lump);
    world.addAssign(sway.add(vec3(0, push, 0)));
    // Swing the normal with the cloth (rotation about the horizontal axis across the wind).
    const k: N = step(0.004, swayLen);
    const cs: N = cos(th.mul(k)), sn: N = sin(th.mul(k));
    const n: N = normalLocal;
    normalLocal.assign(n.mul(cs).add(cross(side, n).mul(sn)).add(side.mul(dot(side, n)).mul(cs.oneMinus())));
    return modelWorldMatrixInverse.mul(vec4(world, 1)).xyz;
  })();
}

// ------------------------------------------------------------------------------------------
// The opaque prop material
// ------------------------------------------------------------------------------------------

export interface PropMaterialOpts {
  /** Disable the snow cover (indoor-only sets). Default true. */
  snow?: boolean;
  /** Disable the procedural bump normal (the phone tier may want this). Default true. */
  bump?: boolean;
}

/**
 * The material for ModelDef.geometry (and ModelPart.geometry). Create it once and share it:
 * getPropMaterial() returns the shared instance.
 */
export function createPropMaterial(o: PropMaterialOpts = {}): THREE.MeshStandardNodeMaterial {
  const useSnow = o.snow ?? true, useBump = o.bump ?? true;
  const m = new PropNodeMaterial();
  m.name = 'prop';
  m.fog = true;
  m.side = THREE.FrontSide;

  const aCol: N = attribute('color', 'vec4');
  const aDet: N = attribute('aDetail', 'vec4');
  const aSurf: N = attribute('aSurf', 'vec4');
  const aEnv: N = attribute('aEnv', 'vec4');

  const pRough: N = property('float', 'csRough');
  const pMetal: N = property('float', 'csMetal');
  const pEmis: N = property('vec3', 'csEmissive');
  const pNormal: N = property('vec3', 'csNormal');
  const pAO: N = property('float', 'csAO');

  m.positionNode = makePositionNode();

  m.colorNode = Fn(() => {
    const det: N = aDet.xyz;
    const id: N = int(aDet.w.add(0.5));
    const dx: N = dFdx(det), dy: N = dFdy(det);
    const pix: N = max(length(dx), length(dy)).max(1e-6); // metres of surface per pixel
    const lodIso = (scale: number): N => log2(pix.mul(scale)).max(0);
    const lodAni = (s: N): N => log2(max(length(dx.mul(s)), length(dy.mul(s))).max(1e-6)).max(0);
    // A thin line where `dist` (in noise units, from a noise of `freq` cycles per metre) is near 0.
    // Once the line is thinner than a pixel it widens and fades by the same factor, so it neither
    // aliases into dots nor vanishes. No derivatives: it is safe inside the material branches.
    const line = (dist: N, width: number, freq: number): N => {
      const w: N = max(pix.mul(freq * 1.5), width);
      return smoothstep(0, w, dist).oneMinus().mul(float(width).div(w));
    };
    // A soft threshold of noise value v at t, its edge at least a pixel wide (same idea).
    const edge = (t: N, v: N, width: number, freq: number): N => {
      const w: N = max(pix.mul(freq * 1.5), width);
      return smoothstep(t.sub(w), t.add(w), v);
    };
    // which way the surface faces in the part's own space (for end grain and triplanar weave)
    const nD: N = abs(normalize(cross(dx, dy).add(vec3(1e-12, 2e-12, 3e-12))));

    const base: N = aCol.rgb.mul(aCol.rgb);
    const ao: N = aCol.a;
    const wear: N = aSurf.z;
    const glow: N = aSurf.w.mul(8).pow(2);

    const nLo: N = noise2(det.mul(3.1), lodIso(3.1)).toVar(); // 30 cm blotches
    const nMd: N = noise2(det.mul(27).add(11.3), lodIso(27)).toVar(); // 4 cm
    const nHi: N = noise2(det.mul(230).add(4.7), lodIso(230)).toVar(); // 4 mm

    const col: N = vec3(base).toVar();
    const rough: N = float(aSurf.x).toVar();
    const metal: N = float(aSurf.y).toVar();
    const h: N = float(0).toVar(); // bump height, metres
    const em: N = base.mul(glow).toVar();
    const porous: N = float(0).toVar(); // how much water darkens it
    const snowBase: N = float(0).toVar();
    const grime: N = float(0.3).toVar();

    If(id.equal(MAT.WOOD), () => {
      // Growth rings round the heart (the kit puts it far off for boards, on the axis for logs):
      // straight or cathedral stripes on the faces, circles on the ends. A narrow dark latewood
      // band per ring, wobbling with the fibre; fibre streaks along the grain on top.
      const sA = vec3(72, 2.3, 72);
      const g: N = noise2(det.mul(sA), lodAni(sA));
      const sB = vec3(17, 0.8, 21);
      const g2: N = noise2(det.mul(sB).add(3.3), lodAni(sB));
      const endGrain: N = smoothstep(0.8, 0.95, nD.y);
      // distance from the heart, wobbling with the fibre; good and bad years make the spacing uneven
      const r0: N = length(det.xz);
      const rr: N = r0.add(g2.y.sub(0.5).mul(0.01)).add(g.y.sub(0.5).mul(0.002)).add(sin(r0.mul(23)).mul(0.004));
      const RING = 140; // rings per metre
      const ph: N = fract(rr.mul(RING));
      const late: N = smoothstep(0.5, 0.75, ph).mul(smoothstep(1.0, 0.84, ph)).mul(smoothstep(2.4, 0.9, pix.mul(RING))).mul(nMd.y.mul(0.6).add(0.55));
      const fibre: N = g.x.mul(0.6).add(g2.x.mul(0.4));
      col.mulAssign(mix(fibre.mul(0.36).add(0.8), nHi.x.mul(0.16).add(0.92), endGrain).mul(late.mul(-0.26).add(1.06)));
      // checks: along the grain on the faces, radial splits from the heart on the ends
      const dir: N = det.xz.div(rr.max(1e-4));
      const radial: N = noise2(vec3(dir.x.mul(5), dir.y.mul(5), rr.mul(3)).add(7.7), lodIso(30));
      const crack: N = mix(smoothstep(0.72, 0.86, g.y).mul(wear.mul(0.7).add(0.3)), line(abs(radial.x.sub(0.5)), 0.035, 30).mul(wear.mul(0.8).add(0.2)), endGrain);
      col.mulAssign(crack.mul(-0.55).add(1));
      // weather silvers wood and bleaches the high grain
      const lum: N = dot(col, vec3(0.3, 0.55, 0.15));
      col.assign(mix(col, vec3(lum).mul(vec3(1.0, 1.02, 1.05)).mul(1.08), wear.mul(nLo.x.mul(0.5).add(0.35))));
      col.mulAssign(mix(1, 0.8, endGrain));
      rough.addAssign(crack.mul(0.1));
      // weathered latewood stands proud of the softer earlywood
      h.assign(fibre.mul(0.0004).sub(crack.mul(0.0012)).add(late.mul(wear).mul(0.0005)).add(nHi.x.mul(0.0001)));
      porous.assign(1);
      grime.assign(0.45);
    }).ElseIf(id.equal(MAT.PAINT), () => {
      const chipN: N = nMd.x.mul(0.55).add(nHi.x.mul(0.3)).add(nLo.x.mul(0.15));
      const th: N = wear.mul(0.75);
      const any: N = smoothstep(th, th.sub(0.012), chipN);
      const deep: N = smoothstep(th.sub(0.03), th.sub(0.05), chipN);
      const sD = vec3(40, 2.1, 40);
      const drip: N = noise2(det.mul(sD).add(1.7), lodAni(sD));
      const rustAmt: N = smoothstep(0.3, 0.8, wear).add(ao.oneMinus().mul(0.35));
      const rustMask: N = deep.mul(smoothstep(rustAmt.oneMinus(), rustAmt.oneMinus().add(0.25), nHi.y.mul(0.5).add(nMd.y.mul(0.5)).add(0.15)));
      const rustCol: N = mix(vec3(0.13, 0.05, 0.022), vec3(0.055, 0.028, 0.016), nHi.y);
      col.mulAssign(nLo.x.mul(0.18).add(0.91));
      // chalky fade on the weather side, rust weeping down from the chips
      const bleed: N = smoothstep(0.52, 0.8, drip.x).mul(wear.mul(1.5).min(1)).mul(nLo.y.mul(0.7).add(0.3));
      col.assign(mix(col, col.mul(vec3(0.62, 0.4, 0.26)).add(vec3(0.02, 0.008, 0.002)), bleed.mul(0.7)));
      // primer, then dark steel (it dulls within days outdoors)
      col.assign(mix(col, vec3(0.3, 0.27, 0.22), any));
      col.assign(mix(col, vec3(0.26, 0.265, 0.275), deep));
      col.assign(mix(col, rustCol, rustMask));
      metal.assign(deep.mul(rustMask.oneMinus()));
      rough.assign(mix(mix(rough.add(bleed.mul(0.2)), 0.4, deep), 0.95, rustMask));
      h.assign(any.mul(-0.0003).add(nHi.x.mul(0.00004)).add(rustMask.mul(nHi.x).mul(0.0007)));
      grime.assign(0.5);
    }).ElseIf(id.equal(MAT.METAL), () => {
      const sA = vec3(390, 7, 390);
      const g: N = noise2(det.mul(sA), lodAni(sA));
      const scratch: N = smoothstep(0.8, 0.92, g.y).mul(wear.mul(2).min(1).mul(0.7).add(0.3));
      const dull: N = smoothstep(0.35, 0.75, nLo.y.add(nMd.x.mul(0.3)).sub(0.15)).mul(wear.mul(2).min(1).mul(0.7).add(0.3));
      col.mulAssign(g.x.mul(0.2).add(0.86).mul(nLo.x.mul(0.2).add(0.9)));
      col.assign(mix(col, col.mul(0.72).add(col.mul(0.15)), dull.mul(0.6)));
      rough.addAssign(dull.mul(0.25).add(g.x.sub(0.5).mul(0.18)).sub(scratch.mul(0.15)));
      // above wear 0.5 steel rusts: blooms first in the creases
      const rustAmt: N = wear.mul(2).sub(1).max(0).add(ao.oneMinus().mul(wear).mul(0.6));
      const rustMask: N = smoothstep(rustAmt.oneMinus(), rustAmt.oneMinus().add(0.22), nMd.y.mul(0.5).add(nLo.x.mul(0.3)).add(nHi.y.mul(0.2))).mul(step(0.001, rustAmt));
      // rust follows the painted albedo: brown where the model painted rust, near black under soot
      const rustK: N = dot(base, vec3(0.3, 0.55, 0.15)).div(0.045).clamp(0.18, 1.15);
      const rustCol: N = mix(mix(vec3(0.12, 0.048, 0.022), vec3(0.05, 0.027, 0.016), nHi.x), vec3(0.07, 0.05, 0.04), nMd.x.mul(0.5)).mul(rustK);
      col.assign(mix(col, rustCol, rustMask));
      // bright scratches only through bare metal, relative to it (never chalk lines on rust)
      col.mulAssign(scratch.mul(rustMask.oneMinus()).mul(0.45).add(1));
      metal.mulAssign(rustMask.oneMinus());
      rough.assign(mix(rough, 0.95, rustMask));
      h.assign(g.x.mul(0.00006).sub(scratch.mul(0.00015)).add(rustMask.mul(nHi.x).mul(0.0008)));
      grime.assign(0.45);
    }).ElseIf(id.equal(MAT.CLOTH), () => {
      const K = (Math.PI * 2) / 0.0034;
      const s: N = sin(det.mul(K));
      const weave: N = nD.z.mul(s.x.mul(s.y)).add(nD.x.mul(s.y.mul(s.z))).add(nD.y.mul(s.z.mul(s.x)));
      const fade: N = smoothstep(1.6, 0.5, pix.mul(K));
      const wv: N = weave.mul(fade);
      col.mulAssign(wv.mul(0.16).add(0.88).mul(nLo.x.mul(0.4).add(0.8)).mul(nMd.x.mul(0.16).add(0.92)));
      col.assign(mix(col, col.mul(0.62).add(0.1), wear.mul(nMd.y).mul(0.55)));
      h.assign(wv.mul(0.00022).add(nMd.x.mul(0.0007)));
      porous.assign(0.9);
      grime.assign(0.5);
    }).ElseIf(id.equal(MAT.BARK), () => {
      // Conifer bark: long fissures (contours of a noise stretched 10 : 1 along the grain) broken
      // by finer cracks into plates, each plate its own tone, the ridges weathered paler.
      const sA = vec3(30, 1.5, 30);
      const g: N = noise2(det.mul(sA), lodAni(sA));
      const sB = vec3(76, 3.8, 76);
      const g2: N = noise2(det.mul(sB).add(5.1), lodAni(sB));
      const fiss: N = line(abs(g.x.sub(0.5)), 0.07, 30).max(line(abs(g2.x.sub(0.5)), 0.05, 76).mul(0.6));
      const plate: N = g.y.mul(0.6).add(g2.y.mul(0.4));
      col.mulAssign(mix(1, 0.3, fiss).mul(plate.mul(0.5).add(0.75)).mul(nMd.x.mul(0.2).add(0.9)));
      col.mulAssign(smoothstep(0.6, 0.85, nLo.y).mul(fiss.oneMinus()).mul(0.35).add(1));
      const hb: N = fiss.oneMinus().mul(0.004).add(plate.mul(0.0015)).add(nHi.x.mul(0.0004));
      // Bark falls away with wear above 0.35, in ragged patches, baring bleached grey wood with
      // its fibres along the grain, a bark's thickness lower.
      const loss: N = smoothstep(0.35, 1.0, wear);
      // (the fine octave also hides the 1/256 steps of the hardware's bilinear weights on the coarse ones)
      const pn: N = nLo.y.mul(0.58).add(nMd.y.mul(0.32)).add(nHi.y.sub(0.5).mul(0.2));
      const bare: N = edge(loss.oneMinus(), pn, 0.012, 12).mul(step(0.001, loss));
      const sF = vec3(110, 3, 110);
      const fib: N = noise2(det.mul(sF).add(2.2), lodAni(sF));
      const wood: N = vec3(0.26, 0.235, 0.2).mul(fib.x.mul(0.35).add(0.8)).mul(line(abs(fib.y.sub(0.5)), 0.04, 110).mul(-0.45).add(1));
      col.assign(mix(col, wood, bare));
      rough.assign(mix(rough, 0.8, bare));
      h.assign(mix(hb, fib.x.mul(0.0004).sub(0.002), bare));
      porous.assign(1);
      grime.assign(0.5);
    }).ElseIf(id.equal(MAT.ROCK), () => {
      // Granite: mineral grains (dark and pale specks a few millimetres across), tone drifting
      // over the stone, rare thin veins where it fractured; weathered paler on top.
      const sG = vec3(420, 420, 420);
      const gr: N = noise2(det.mul(sG).add(2.9), lodIso(420));
      const fadeG: N = smoothstep(2.0, 0.7, pix.mul(420));
      const speck: N = smoothstep(0.62, 0.75, gr.x).mul(0.32).sub(smoothstep(0.38, 0.25, gr.y).mul(0.28)).mul(fadeG);
      col.mulAssign(nMd.x.mul(0.36).add(0.8).mul(nLo.x.mul(0.3).add(0.85)).mul(speck.add(1)));
      col.assign(mix(col, col.mul(vec3(1.15, 1.07, 0.92)), nLo.y.mul(0.5)));
      const vein: N = line(abs(nLo.y.sub(0.5)), 0.012, 3.1).mul(smoothstep(0.45, 0.7, nMd.y));
      col.mulAssign(vein.mul(-0.45).add(1));
      h.assign(nMd.x.mul(0.006).add(nHi.x.mul(0.0012)).add(speck.mul(0.0006)).sub(vein.mul(0.003)));
      porous.assign(0.7);
    }).ElseIf(id.equal(MAT.CHAR), () => {
      // Charcoal alligators: deep checks along the grain, short cross checks between them, the
      // blocks between slightly domed; the checks are what glows.
      const sA = vec3(70, 9, 70);
      const g: N = noise2(det.mul(sA), lodAni(sA));
      const sB = vec3(14, 55, 14);
      const g2: N = noise2(det.mul(sB).add(6.3), lodAni(sB));
      const crack: N = line(abs(g.x.sub(0.5)), 0.06, 70).max(line(abs(g2.x.sub(0.5)), 0.045, 55).mul(smoothstep(0.35, 0.6, g.y)));
      col.mulAssign(nHi.x.mul(0.6).add(0.7).mul(mix(1, 0.45, crack)));
      const ash: N = smoothstep(wear.oneMinus(), wear.oneMinus().add(0.18), nLo.x.mul(0.5).add(nMd.y.mul(0.5)));
      col.assign(mix(col, vec3(0.42, 0.41, 0.4).mul(nHi.y.mul(0.4).add(0.8)), ash.mul(0.85)));
      const pulse: N = sin(U.time.mul(2.3).add(nLo.y.mul(40))).mul(0.25).add(0.75);
      em.assign(vec3(1.0, 0.28, 0.05).mul(glow).mul(crack.mul(ash.oneMinus().mul(0.8).add(0.2))).mul(pulse).mul(nMd.y.add(0.4)));
      h.assign(crack.mul(-0.003).add(nHi.x.mul(0.0007)));
      porous.assign(0.3);
      grime.assign(0);
    }).ElseIf(id.equal(MAT.PLASTIC), () => {
      const sA = vec3(95, 13, 95);
      const scuff: N = smoothstep(0.76, 0.9, noise2(det.mul(sA), lodAni(sA)).x).mul(wear);
      col.mulAssign(nLo.x.mul(0.14).add(0.93));
      col.addAssign(scuff.mul(0.1));
      rough.addAssign(scuff.mul(0.3));
      h.assign(nHi.x.mul(0.00006).sub(scuff.mul(0.0001)));
    }).ElseIf(id.equal(MAT.RUBBER), () => {
      col.mulAssign(nMd.x.mul(0.3).add(0.85));
      col.assign(mix(col, vec3(0.2, 0.19, 0.17), nLo.x.mul(wear.mul(0.5).add(0.15))));
      h.assign(nHi.x.mul(0.0003));
    }).ElseIf(id.equal(MAT.FUR), () => {
      const sA = vec3(250, 11, 250);
      const g: N = noise2(det.mul(sA), lodAni(sA));
      col.mulAssign(g.x.mul(0.9).add(0.55).mul(nLo.x.mul(0.4).add(0.8)));
      h.assign(g.x.mul(0.0015));
      rough.assign(1);
      porous.assign(0.6);
    }).ElseIf(id.equal(MAT.ICE), () => {
      const crack: N = line(abs(nMd.x.sub(0.5)), 0.03, 27);
      col.mulAssign(nLo.x.mul(0.3).add(0.85));
      col.assign(mix(col, vec3(0.9, 0.95, 1), crack.mul(0.5).add(smoothstep(0.7, 0.85, nHi.y).mul(0.2))));
      rough.assign(nLo.y.mul(0.3).add(0.1).add(crack.mul(0.3)));
      em.addAssign(base.mul(vec3(U.skyAmbient)).mul(0.12));
      h.assign(nMd.y.mul(0.0015).sub(crack.mul(0.001)));
      grime.assign(0.1);
    }).ElseIf(id.equal(MAT.EMISSIVE), () => {
      // a lens or lit pane: the colour is the light, the surface itself is dark glass
      col.assign(base.mul(0.18));
      em.mulAssign(nMd.x.mul(0.2).add(0.9));
      grime.assign(0);
    }).ElseIf(id.equal(MAT.GLASS), () => {
      col.assign(base.mul(0.25));
      grime.assign(0.1);
    }).ElseIf(id.equal(MAT.SNOW), () => {
      snowBase.assign(1);
      grime.assign(0);
    });

    // dirt gathers where the bake found a crease
    col.mulAssign(mix(1, 0.62, ao.oneMinus().mul(grime)));

    const nGeo: N = normalize(normalViewGeometry);
    const nW0: N = nGeo.transformDirection(cameraWorldMatrix);
    const sunDir: N = vec3(U.sunDir);

    let snow: N = float(0);
    if (useSnow) {
      // ---- snow cover ----
      const cover: N = U.snowCover.mul(aEnv.x);
      const sn: N = nLo.x.mul(0.5).add(nMd.x.mul(0.35)).add(nHi.x.mul(0.15));
      const th: N = mix(1.02, 0.22, cover).sub(sn.sub(0.5).mul(0.5)).sub(ao.oneMinus().mul(0.25));
      const up: N = nW0.y;
      snow = max(smoothstep(th.sub(0.05), th.add(0.05), up).mul(smoothstep(0.0, 0.12, cover)), snowBase).toVar();
      // melt line: a wet, dark fringe around every patch; soaks wood and cloth, glazes metal
      const wet: N = max(smoothstep(th.sub(0.3), th.sub(0.05), up).mul(smoothstep(0.0, 0.12, cover)), PROP_U.wet.mul(aEnv.x).mul(up.max(0))).mul(snow.oneMinus());
      col.mulAssign(mix(1, 0.55, wet.mul(porous)));
      rough.assign(mix(rough, rough.mul(0.5), wet.mul(0.8)));
      const sunFacing: N = dot(nW0, sunDir).max(0);
      // never white: cream toward the sun, blue-grey away from it
      const snowCol: N = vec3(0.86, 0.89, 0.93).mul(nMd.y.mul(0.08).add(0.93)).mul(mix(vec3(0.82, 0.9, 1.0), vec3(1.0, 0.985, 0.95), sunFacing));
      col.assign(mix(col, snowCol, snow));
      metal.mulAssign(snow.oneMinus());
      // grazing sparkle: a few crystals per square centimetre catch the sun, and change as you move
      const sp: N = noise2(det.mul(640).add(9.1), lodIso(640));
      const glint: N = smoothstep(0.93, 1.0, fract(sp.x.mul(13).add(dot(positionViewDirection, vec3(5.3, 7.1, 3.7)).mul(4)))).mul(smoothstep(0.62, 0.8, sp.y));
      rough.assign(mix(rough, float(0.86).sub(glint.mul(0.5)), snow));
      // light that went into the snow comes back out blue on the shaded side
      const sss: N = vec3(U.skyAmbient).mul(vec3(0.25, 0.5, 1.0)).mul(0.07).mul(sunFacing.oneMinus());
      const sparkle: N = vec3(U.sunColor).mul(sunFacing).add(vec3(U.moonColor).mul(dot(nW0, vec3(U.moonDir)).max(0))).mul(glint).mul(0.9);
      em.assign(mix(em, sss.add(sparkle), snow));
      // the cap stands proud of the surface: its edge catches light
      h.assign(mix(h, nMd.y.mul(0.005).add(nHi.x.mul(0.0006)), snow).add(snow.mul(0.008)));
    }

    // ---- bump: height field to normal, in view space (Mikkelsen) ----
    if (useBump) {
      const sx: N = dFdx(positionView), sy: N = dFdy(positionView);
      const r1: N = cross(sy, nGeo), r2: N = cross(nGeo, sx);
      const d: N = dot(sx, r1);
      const g0: N = d.sign().mul(dFdx(h).mul(r1).add(dFdy(h).mul(r2)));
      // Limit the slope to about 40 degrees: at grazing angles, and where the height steps at a
      // material border, an unclamped gradient flips normals into sparkling dotted lines.
      const lim: N = d.abs().mul(0.85);
      const grad: N = g0.mul(min(lim.div(length(g0).max(1e-20)), 1));
      pNormal.assign(normalize(d.abs().mul(nGeo).sub(grad)));
    } else pNormal.assign(nGeo);

    pRough.assign(rough.clamp(0.04, 1));
    pMetal.assign(metal.clamp(0, 1));
    pEmis.assign(em);
    pAO.assign(mix(1, ao, snow.mul(-0.5).add(1)));
    // a little of the bake goes into direct light too: contact shadows the shadow map is too coarse for
    return vec4(col.mul(mix(1, ao.mul(0.5).add(0.5), snow.oneMinus())), 1);
  })();

  m.roughnessNode = pRough;
  m.metalnessNode = pMetal;
  m.emissiveNode = pEmis;
  m.normalNode = pNormal;
  m.aoNode = pAO;
  return m;
}

// ------------------------------------------------------------------------------------------
// Glass
// ------------------------------------------------------------------------------------------

/** The material for ModelDef.glass: thin transparent panes that frost over with the snow cover. */
export function createGlassMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new PropNodeMaterial();
  m.name = 'prop-glass';
  m.fog = true;
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  const aCol: N = attribute('color', 'vec4');
  const aDet: N = attribute('aDetail', 'vec4');
  const aSurf: N = attribute('aSurf', 'vec4');
  const aEnv: N = attribute('aEnv', 'vec4');
  const pRough: N = property('float', 'csGlassRough');
  m.positionNode = makePositionNode();
  m.colorNode = Fn(() => {
    const det: N = aDet.xyz;
    const pix: N = max(length(dFdx(det)), length(dFdy(det))).max(1e-6);
    const nLo: N = noise2(det.mul(4.3), log2(pix.mul(4.3)).max(0));
    const nMd: N = noise2(det.mul(41), log2(pix.mul(41)).max(0));
    const base: N = aCol.rgb.mul(aCol.rgb);
    // frost creeps in from the edges of the bake's occlusion and grows with the snow cover
    const frostAmt: N = U.snowCover.mul(aEnv.x).mul(0.75).add(aSurf.z.mul(0.35)).add(aCol.a.oneMinus().mul(0.5));
    const frost: N = smoothstep(frostAmt.oneMinus(), frostAmt.oneMinus().add(0.3), nLo.x.mul(0.6).add(nMd.x.mul(0.4)));
    const fres: N = pow(float(1).sub(abs(dot(normalize(normalViewGeometry), positionViewDirection))), 4);
    pRough.assign(mix(aSurf.x, 0.85, frost));
    const col: N = mix(base.mul(0.35), vec3(0.8, 0.86, 0.92), frost);
    return vec4(col, mix(mix(0.22, 0.9, fres), 0.92, frost));
  })();
  m.roughnessNode = pRough;
  m.metalnessNode = float(0);
  return m;
}

let sharedProp: THREE.MeshStandardNodeMaterial | null = null;
let sharedGlass: THREE.MeshStandardNodeMaterial | null = null;
/** The one shared prop material. Every system that draws kit models should use this instance. */
export function getPropMaterial(): THREE.MeshStandardNodeMaterial {
  return (sharedProp ??= createPropMaterial());
}
export function getGlassMaterial(): THREE.MeshStandardNodeMaterial {
  return (sharedGlass ??= createGlassMaterial());
}
