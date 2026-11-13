// GPU side of the figures: one shared bone texture and the skinning vertex stage.
//
// Every figure on screen (players, wolves) owns one ROW of an RGBA32F DataTexture: 32 bones x 3
// texels (the rows of each bone's 3x4 world skinning matrix, see rig.ts writeRow) plus a few data
// texels (eye shine, ...). Figures are drawn by plain THREE.Mesh objects at the origin whose
// `count` is the number of instances (three r187 draws object.count instances; no instance
// matrix, so no extra vertex buffer). Instance i of a mesh reads row `object.userData.csRow + i`
// through a per-object uniform, the way three's BatchedMesh reads its matrices (textureLoad, no
// sampler: an unfilterable float texture is fine on WebGPU and WebGL2).
//
// Vertex layout: the KIT layout (position, normal, color, aDetail, aSurf, aEnv: see models/kit.ts)
// plus aSkin u8n x4 = (bone0 / 255, bone1 / 255, weight of bone0, flag). Seven vertex buffers, under
// WebGPU's eight. The KIT prop material shades it (cloth, fur, rubber, snow cover, sky reflection,
// the ridge shadow); only its vertex stage is replaced.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createPropMaterial } from '../models/material';

type N = any;
const {
  Fn, attribute, dot, float, instanceIndex, int, ivec2, max, mix, normalLocal, normalView, normalize, positionLocal, positionPrevious,
  positionViewDirection, pow, textureLoad, uniform, varying, vec3, vec4,
} = TSL as N;

export const MAX_BONES = 32;
/** Texels per row: 3 per bone, then the data texels. */
export const ROW_TEXELS = 100;
/** Data texel: x = eye shine (scene radiance multiplier), y = spare, z = spare, w = spare. */
export const DATA_TEXEL = MAX_BONES * 3;

export class BoneTexture {
  readonly tex: THREE.DataTexture;
  readonly data: Float32Array;
  constructor(readonly rows: number) {
    this.data = new Float32Array(ROW_TEXELS * rows * 4);
    // identity matrices everywhere, so an unused row never explodes a vertex
    for (let r = 0; r < rows; r++) for (let b = 0; b < MAX_BONES; b++) {
      const o = (r * ROW_TEXELS + b * 3) * 4;
      this.data[o] = 1;
      this.data[o + 5] = 1;
      this.data[o + 10] = 1;
    }
    const t = new THREE.DataTexture(this.data, ROW_TEXELS, rows, THREE.RGBAFormat, THREE.FloatType);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace;
    t.name = 'actors-bones';
    t.needsUpdate = true;
    this.tex = t;
  }
  /** Upload after the rows of this frame are written. */
  commit(): void {
    this.tex.needsUpdate = true;
  }
  setData(row: number, x: number, y = 0, z = 0, w = 0): void {
    const o = (row * ROW_TEXELS + DATA_TEXEL) * 4;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = w;
  }
  dispose(): void {
    this.tex.dispose();
  }
}

/** Per-object row offset (object.userData.csRow), refreshed before each draw of a mesh. */
export function rowOffset(): N {
  return (uniform(0) as N).onObjectUpdate(({ object }: any) => object.userData.csRow ?? 0);
}

/** The row of the current instance: per-object offset + instanceIndex. */
export function instanceRow(): N {
  return int(instanceIndex).add(int(rowOffset()));
}

/**
 * Skinned world position (linear blend of two bones) for the instance's row. Also skins the
 * normal into normalLocal and sets positionPrevious (TAA velocity would otherwise read the bind
 * pose at the origin). The meshes sit at the origin, so local = world. `push` may move the
 * skinned point (fur shells).
 */
export function skinPosition(tex: THREE.DataTexture, row: N, push?: (world: N, normal: N) => N): N {
  const aSkin: N = attribute('aSkin', 'vec4');
  return Fn(() => {
    const b0: N = int(aSkin.x.mul(255).add(0.5)).mul(3);
    const b1: N = int(aSkin.y.mul(255).add(0.5)).mul(3);
    const w0: N = aSkin.z;
    const ld = (x: N): N => textureLoad(tex, ivec2(x, row));
    const a0: N = ld(b0), a1: N = ld(b0.add(1)), a2: N = ld(b0.add(2));
    const c0: N = ld(b1), c1: N = ld(b1.add(1)), c2: N = ld(b1.add(2));
    const p: N = vec4(positionLocal, 1);
    const n: N = normalLocal;
    const pa: N = vec3(dot(a0, p), dot(a1, p), dot(a2, p));
    const pc: N = vec3(dot(c0, p), dot(c1, p), dot(c2, p));
    const na: N = vec3(dot(a0.xyz, n), dot(a1.xyz, n), dot(a2.xyz, n));
    const nc: N = vec3(dot(c0.xyz, n), dot(c1.xyz, n), dot(c2.xyz, n));
    const world: N = mix(pc, pa, w0).toVar();
    const nrm: N = normalize(mix(nc, na, w0)).toVar();
    if (push) world.assign(push(world, nrm));
    normalLocal.assign(nrm);
    positionPrevious.assign(world);
    return world;
  })();
}

/** The figure material: KIT's prop material with the skinning vertex stage. */
export function createFigureMaterial(bones: BoneTexture): THREE.MeshStandardNodeMaterial {
  const m = createPropMaterial();
  m.name = 'actors-figure';
  m.positionNode = skinPosition(bones.tex, instanceRow());
  return m;
}

/**
 * Eyes: a dark, wet, glossy ball; the tapetum shines green-gold when a light near the viewer
 * faces it. The CPU writes the shine (scene radiance) into the data texel of the row; the shader
 * keeps it to the side of the ball that faces the viewer.
 */
export function createEyeMaterial(bones: BoneTexture): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'actors-eye';
  m.fog = true;
  const row: N = instanceRow();
  m.positionNode = skinPosition(bones.tex, row);
  const shine: N = varying(textureLoad(bones.tex, ivec2(DATA_TEXEL, row)).x, 'vCsShine');
  m.colorNode = vec4(0.06, 0.04, 0.015, 1);
  m.roughnessNode = float(0.12);
  m.metalnessNode = float(0);
  const facing: N = pow(max(dot(normalView, positionViewDirection), 0), 2);
  m.emissiveNode = vec3(0.6, 0.86, 0.3).mul(shine).mul(facing);
  return m;
}
