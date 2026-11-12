// Image-based ambient: the sky rendered into a small cube and prefiltered for every roughness, set
// as scene.environment so every standard material (snow, rock, metal, ice, cloth) is lit by, and
// reflects, the sky that is actually overhead. three's PMREMGenerator works at 256 per face with
// 256-tap filtering; the sky has no sharp features once the discs are left out (the direct lights
// carry those), so this does the job at 64 (32 on phones) and spreads a refresh over three frames:
//   stage 0  render the sky into the source cube (its mips are generated)
//   stage 1  prefilter level 0 (mirror) and level 1
//   stage 2  prefilter the rest (the last level is the diffuse irradiance three reads)
// The prefilter is GGX importance sampling with V = N, the samples computed here and unrolled into
// the shader as constants, each read from the source mip that matches its solid angle.
// The output texture is flagged isPMREMTexture, which PMREMNode samples as it is.
// Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';

const { Fn, cubeTexture, vec3, vec4, abs, cross, normalize, select, positionWorldDirection } = TSL as any;

const LOD_MIN = 3; // the roughest level is 8 x 8, as in three's generator
const SAMPLES = 40;

function lodToRoughness(lod: number, maxLod: number): number {
  return maxLod > 0 ? 1 - Math.sqrt(1 - lod / maxLod) : 0;
}

function radicalInverse(i: number): number {
  let b = i >>> 0;
  b = ((b << 16) | (b >>> 16)) >>> 0;
  b = (((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1)) >>> 0;
  b = (((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2)) >>> 0;
  b = (((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4)) >>> 0;
  b = (((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8)) >>> 0;
  return b / 4294967296;
}

interface Tap {
  x: number;
  y: number;
  z: number;
  w: number;
  lod: number;
}

/** Tangent-space directions (N = +z), weights and source mip levels for a GGX lobe. */
function ggxTaps(rough: number, n: number, size: number): Tap[] {
  if (rough <= 0.001) return [{ x: 0, y: 0, z: 1, w: 1, lod: 0 }];
  const a = rough * rough;
  const a2 = a * a;
  const texel = (4 * Math.PI) / (6 * size * size);
  const taps: Tap[] = [];
  for (let i = 0; i < n; i++) {
    const u1 = (i + 0.5) / n;
    const u2 = radicalInverse(i);
    const ch = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1));
    const sh = Math.sqrt(Math.max(0, 1 - ch * ch));
    const ph = 2 * Math.PI * u2;
    const hx = sh * Math.cos(ph), hy = sh * Math.sin(ph), hz = ch;
    // L = reflect(-V, H) with V = N = +z
    const lx = 2 * hz * hx, ly = 2 * hz * hy, lz = 2 * hz * hz - 1;
    if (lz <= 0) continue;
    const dn = (a2 - 1) * ch * ch + 1;
    const D = a2 / (Math.PI * dn * dn);
    const pdf = D / 4;
    const omega = 1 / (n * pdf);
    const lod = Math.max(0, 0.5 * Math.log2(omega / texel) + 1);
    taps.push({ x: lx, y: ly, z: lz, w: lz, lod: Math.min(Math.log2(size), lod) });
  }
  return taps;
}

export class SkyEnv {
  readonly size: number;
  readonly maxLod: number;
  /** The prefiltered cube: assign to scene.environment. */
  readonly texture: THREE.Texture;
  private src: THREE.CubeRenderTarget;
  private out: THREE.CubeRenderTarget;
  private cam: THREE.CubeCamera;
  private box: THREE.Mesh;
  private skyMat: THREE.NodeMaterial;
  private filters: THREE.NodeMaterial[] = [];
  private stage = -1;
  /** Number of completed refreshes. */
  refreshes = 0;

  constructor(size: number, skyMaterial: THREE.NodeMaterial) {
    this.size = Math.max(16, 1 << Math.round(Math.log2(size)));
    this.maxLod = Math.max(0, Math.log2(this.size) - LOD_MIN);
    const opts = (mips: boolean) => ({
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: mips,
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false,
    });
    this.src = new THREE.CubeRenderTarget(this.size, opts(true));
    this.src.texture.name = 'SkyEnv.source';
    this.out = new THREE.CubeRenderTarget(this.size, opts(false));
    for (let lod = 0; lod <= this.maxLod; lod++) this.out.texture.mipmaps.push({ width: this.size >> lod, height: this.size >> lod } as any);
    this.out.texture.name = 'SkyEnv';
    (this.out.texture as any).isPMREMTexture = true;
    this.texture = this.out.texture;

    this.cam = new THREE.CubeCamera(0.1, 10, this.src);
    this.cam.updateMatrixWorld(true);
    this.skyMat = skyMaterial;
    this.box = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), skyMaterial);
    this.box.frustumCulled = false;

    const env = cubeTexture(this.src.texture);
    for (let lod = 0; lod <= this.maxLod; lod++) {
      const taps = ggxTaps(lodToRoughness(lod, this.maxLod), lod === 0 ? 1 : SAMPLES, this.size);
      const m = new THREE.NodeMaterial();
      m.name = 'SkyEnv.prefilter' + lod;
      m.side = THREE.BackSide;
      m.blending = THREE.NoBlending;
      m.depthTest = false;
      m.depthWrite = false;
      m.fragmentNode = Fn(() => {
        const n = normalize(positionWorldDirection);
        const up = select(abs(n.z).lessThan(0.999), vec3(0, 0, 1), vec3(1, 0, 0));
        const t = normalize(cross(up, n));
        const b = cross(n, t);
        let sum: any = vec3(0);
        let wsum = 0;
        for (const tp of taps) {
          const dir = t.mul(tp.x).add(b.mul(tp.y)).add(n.mul(tp.z));
          sum = sum.add(env.sample(dir).level(tp.lod).rgb.mul(tp.w));
          wsum += tp.w;
        }
        return vec4(sum.mul(1 / wsum), 1);
      })();
      this.filters.push(m);
    }
  }

  /** True while a refresh is spread over frames. */
  get busy(): boolean {
    return this.stage >= 0;
  }

  /** Swap the sky material (quality change). */
  setSkyMaterial(m: THREE.NodeMaterial): void {
    this.skyMat = m;
  }

  /** Start a refresh if none is running. */
  request(): void {
    if (this.stage < 0) this.stage = 0;
  }

  /** Run the next stage of a pending refresh (call once per frame). Returns true when one finished. */
  step(renderer: THREE.WebGPURenderer): boolean {
    if (this.stage < 0) return false;
    if (this.stage === 0) {
      this.renderCube(renderer, this.src, 0, this.skyMat);
      this.stage = 1;
      return false;
    }
    if (this.stage === 1) {
      this.renderCube(renderer, this.out, 0, this.filters[0]);
      if (this.maxLod >= 1) this.renderCube(renderer, this.out, 1, this.filters[1]);
      if (this.maxLod > 1) {
        this.stage = 2;
        return false;
      }
    } else {
      for (let lod = 2; lod <= this.maxLod; lod++) this.renderCube(renderer, this.out, lod, this.filters[lod]);
    }
    this.stage = -1;
    this.refreshes++;
    return true;
  }

  /** Whole refresh in one go (start-up, big jumps). */
  refreshNow(renderer: THREE.WebGPURenderer): void {
    this.stage = 0;
    while (this.stage >= 0) this.step(renderer);
  }

  private renderCube(renderer: THREE.WebGPURenderer, target: THREE.CubeRenderTarget, lod: number, mat: THREE.NodeMaterial): void {
    this.box.material = mat;
    (this.cam as any).renderTarget = target;
    (this.cam as any).activeMipmapLevel = lod;
    this.cam.update(renderer as any, this.box as any);
  }

  dispose(): void {
    this.src.dispose();
    this.out.dispose();
    for (const m of this.filters) m.dispose();
    this.box.geometry.dispose();
  }
}
