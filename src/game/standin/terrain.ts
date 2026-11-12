// STAND-IN for gfx/terrain (TERRAIN), until the real system replaces it through src/game/visuals.ts.
// Three nested square grids around the camera (2 m, 8 m, 32 m cells) built on the CPU from
// world.heightAt, each with a hole where the finer one lies and a skirt round its outer edge so
// the seams never open. Recentred in steps as the camera moves. Masks (forest, rock, ice, trail)
// ride in a vertex attribute, box-filtered for the coarse rings. A plain snow / rock / ice TSL
// material that receives sun shadows.
// Owner: GAME.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { Frame, GfxSystem } from '../../gfx/api';
import type { CsEngine } from '../../gfx/engine';
import type { World } from '../../world/types';

const { attribute, normalWorld, positionWorld, vec2, vec3, float, mix, max, mx_noise_float } = TSL as any;

interface RingDef { cell: number; half: number; snap: number; level: number; skirt: number }
const RINGS: RingDef[] = [
  { cell: 2, half: 96, snap: 16, level: 0, skirt: 4 },
  { cell: 8, half: 448, snap: 64, level: 1, skirt: 16 },
  { cell: 32, half: 2048, snap: 256, level: 2, skirt: 0 },
];

interface MaskLevel { data: Uint8Array; n: number; cell: number; extent: number }

/** Box-filter the RGBA mask grid by 4 per level (2 m -> 8 m -> 32 m). */
function maskPyramid(world: World): MaskLevel[] {
  const m = world.masks;
  const levels: MaskLevel[] = [{ data: m.data, n: m.n, cell: (2 * m.extent) / (m.n - 1), extent: m.extent }];
  for (let l = 1; l < 3; l++) {
    const src = levels[l - 1];
    const n = Math.floor((src.n - 1) / 4) + 1;
    const out = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const acc = [0, 0, 0, 0];
        let w = 0;
        for (let dj = -2; dj <= 2; dj++) {
          const sj = Math.min(src.n - 1, Math.max(0, j * 4 + dj));
          for (let di = -2; di <= 2; di++) {
            const si = Math.min(src.n - 1, Math.max(0, i * 4 + di));
            const k = (sj * src.n + si) * 4;
            for (let c = 0; c < 4; c++) acc[c] += src.data[k + c];
            w++;
          }
        }
        const o = (j * n + i) * 4;
        for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / w);
      }
    }
    levels.push({ data: out, n, cell: src.cell * 4, extent: src.extent });
  }
  return levels;
}

class Ring {
  readonly def: RingDef;
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.BufferGeometry;
  readonly side: number; // vertices per side
  cx = NaN;
  cz = NaN;
  private pos: Float32Array;
  private nor: Float32Array;
  private msk: Uint8Array;
  private idx: Uint32Array;
  private skirtBase: number;

  constructor(def: RingDef, mat: THREE.Material) {
    this.def = def;
    this.side = (2 * def.half) / def.cell + 1;
    const grid = this.side * this.side;
    const skirtVerts = def.skirt > 0 ? 4 * (this.side - 1) * 2 : 0;
    const nv = grid + skirtVerts;
    this.skirtBase = grid;
    this.pos = new Float32Array(nv * 3);
    this.nor = new Float32Array(nv * 3);
    this.msk = new Uint8Array(nv * 4);
    const cells = (this.side - 1) * (this.side - 1);
    this.idx = new Uint32Array(cells * 6 + (def.skirt > 0 ? 4 * (this.side - 1) * 6 : 0));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute('aMask', new THREE.BufferAttribute(this.msk, 4, true));
    g.setIndex(new THREE.BufferAttribute(this.idx, 1));
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'standin-terrain-' + def.cell;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  /** Rebuild vertices round (cx, cz). */
  build(world: World, mask: MaskLevel, cx: number, cz: number): void {
    this.cx = cx;
    this.cz = cz;
    const { cell, half, skirt } = this.def;
    const side = this.side;
    const pos = this.pos, nor = this.nor, msk = this.msk;
    const e = Math.max(2, cell * 0.5);
    const x0 = cx - half, z0 = cz - half;
    const mn = mask.n, mc = mask.cell, mext = mask.extent;
    for (let j = 0; j < side; j++) {
      const z = z0 + j * cell;
      for (let i = 0; i < side; i++) {
        const x = x0 + i * cell;
        const v = j * side + i;
        const h = world.heightAt(x, z);
        pos[v * 3] = x;
        pos[v * 3 + 1] = h;
        pos[v * 3 + 2] = z;
        const dx = (world.heightAt(x + e, z) - world.heightAt(x - e, z)) / (2 * e);
        const dz = (world.heightAt(x, z + e) - world.heightAt(x, z - e)) / (2 * e);
        const il = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
        nor[v * 3] = -dx * il;
        nor[v * 3 + 1] = il;
        nor[v * 3 + 2] = -dz * il;
        const mi = Math.min(mn - 1, Math.max(0, Math.round((x + mext) / mc)));
        const mj = Math.min(mn - 1, Math.max(0, Math.round((z + mext) / mc)));
        const k = (mj * mn + mi) * 4;
        msk[v * 4] = mask.data[k];
        msk[v * 4 + 1] = mask.data[k + 1];
        msk[v * 4 + 2] = mask.data[k + 2];
        msk[v * 4 + 3] = mask.data[k + 3];
      }
    }
    if (skirt > 0) {
      // the outer edge, walked once round: each edge vertex gets a twin hanging `skirt` below
      let s = this.skirtBase;
      const n = side - 1;
      for (let k = 0; k < 4 * n; k++) {
        const a = this.edgeOf(k), b = this.edgeOf((k + 1) % (4 * n));
        for (const src of [a, b]) {
          pos[s * 3] = pos[src * 3];
          pos[s * 3 + 1] = pos[src * 3 + 1] - skirt;
          pos[s * 3 + 2] = pos[src * 3 + 2];
          nor[s * 3] = nor[src * 3];
          nor[s * 3 + 1] = nor[src * 3 + 1];
          nor[s * 3 + 2] = nor[src * 3 + 2];
          for (let c = 0; c < 4; c++) msk[s * 4 + c] = msk[src * 4 + c];
          s++;
        }
      }
    }
    for (const name of ['position', 'normal', 'aMask']) (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  /** Index buffer: every cell except those inside the hole [hx0, hx1] x [hz0, hz1] (world metres). */
  indices(hx0: number, hx1: number, hz0: number, hz1: number): void {
    const { cell, half, skirt } = this.def;
    const side = this.side;
    const x0 = this.cx - half, z0 = this.cz - half;
    const idx = this.idx;
    let k = 0;
    for (let j = 0; j < side - 1; j++) {
      const za = z0 + j * cell;
      const inZ = za >= hz0 - 1e-3 && za + cell <= hz1 + 1e-3;
      for (let i = 0; i < side - 1; i++) {
        const xa = x0 + i * cell;
        if (inZ && xa >= hx0 - 1e-3 && xa + cell <= hx1 + 1e-3) continue;
        const v00 = j * side + i, v10 = v00 + 1, v01 = v00 + side, v11 = v01 + 1;
        // (v00, v01, v10) faces +Y
        idx[k++] = v00;
        idx[k++] = v01;
        idx[k++] = v10;
        idx[k++] = v10;
        idx[k++] = v01;
        idx[k++] = v11;
      }
    }
    if (skirt > 0) {
      const n = side - 1;
      let s = this.skirtBase;
      for (let e = 0; e < 4 * n; e++) {
        // edge vertices a, b (grid) and their twins a', b' (skirt). The skirt faces the ring's
        // centre, where the camera always is, and keeps the surface's normal so it is lit like
        // the snow it hangs from (a back face would be lit from below: a dark seam line).
        const a2 = s, b2 = s + 1;
        s += 2;
        const a = this.edgeOf(e), b = this.edgeOf((e + 1) % (4 * n));
        idx[k++] = a;
        idx[k++] = b2;
        idx[k++] = b;
        idx[k++] = a;
        idx[k++] = a2;
        idx[k++] = b2;
      }
    }
    const ia = this.geo.getIndex()!;
    ia.needsUpdate = true;
    this.geo.setDrawRange(0, k);
  }

  /** Edge vertex k of [0, 4n): first row left to right, last column, last row back, first column. */
  private edgeOf(k: number): number {
    const side = this.side, n = side - 1;
    if (k < n) return k;
    if (k < 2 * n) return (k - n) * side + n;
    if (k < 3 * n) return n * side + (n - (k - 2 * n));
    return (n - (k - 3 * n)) * side;
  }
}

function makeMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const m = attribute('aMask', 'vec4');
  const up = normalWorld.y;
  const p = positionWorld.xz;
  const n1 = mx_noise_float(p.mul(0.045));
  const n2 = mx_noise_float(p.mul(0.37));
  const n3 = mx_noise_float(p.mul(2.3));
  const grain = n1.mul(0.5).add(n2.mul(0.3)).add(n3.mul(0.2));
  // snow is never pure white: a cool off-white with a faint large-scale mottling
  const snow = vec3(0.83, 0.855, 0.9).mul(grain.mul(0.04).add(1));
  const packed = snow.mul(vec3(0.89, 0.89, 0.9));
  let col = mix(snow, snow.mul(0.94), m.x.mul(0.6));
  col = mix(col, packed, m.w);
  // lake ice: dark blue-black with drifted snow over part of it, in streaks along the prevailing
  // wind (down off the ridge toward the south-east)
  const streak = mx_noise_float(vec2(p.x.mul(0.011).add(p.y.mul(0.011)), p.y.mul(0.06).sub(p.x.mul(0.06))));
  const drift = streak.mul(0.5).add(0.5).add(n3.mul(0.1)).smoothstep(0.46, 0.7);
  const iceCol = vec3(0.1, 0.14, 0.18).add(vec3(0.03, 0.035, 0.04).mul(n2));
  const iceAmt = m.z.mul(drift.oneMinus());
  col = mix(col, iceCol, iceAmt);
  // rock where the mask says or the slope is too steep to hold snow; snow wins on flatter normals
  const steep = up.smoothstep(0.6, 0.78).oneMinus();
  const ledge = up.smoothstep(0.84, 0.95);
  const rockAmt = max(m.y.mul(ledge.oneMinus().mul(0.85).add(0.15)), steep).mul(float(1).sub(ledge.mul(0.85)));
  const rockCol = vec3(0.05, 0.048, 0.046).mul(n2.mul(0.3).add(n3.mul(0.15)).add(1));
  col = mix(col, rockCol, rockAmt.clamp(0, 1));
  mat.colorNode = col;
  mat.roughnessNode = mix(mix(float(0.86), float(0.28), iceAmt), float(0.93), rockAmt.clamp(0, 1));
  mat.metalnessNode = float(0);
  return mat;
}

export function createStandinTerrain(engine: CsEngine, world: World): GfxSystem {
  const levels = maskPyramid(world);
  const mat = makeMaterial();
  const group = new THREE.Group();
  group.name = 'standin-terrain';
  const rings = RINGS.map((d) => new Ring(d, mat));
  for (const r of rings) group.add(r.mesh);
  engine.scene.add(group);

  const snap = (v: number, s: number) => Math.round(v / s) * s;
  function place(x: number, z: number, force: boolean): void {
    let holeDirty = false;
    for (let k = 0; k < rings.length; k++) {
      const r = rings[k];
      const cx = snap(x, r.def.snap), cz = snap(z, r.def.snap);
      const moved = force || cx !== r.cx || cz !== r.cz;
      if (moved) r.build(world, levels[r.def.level], cx, cz);
      if (moved || holeDirty) {
        if (k === 0) r.indices(1, -1, 1, -1); // no hole
        else {
          const inner = rings[k - 1];
          const h = inner.def.half;
          r.indices(inner.cx - h, inner.cx + h, inner.cz - h, inner.cz + h);
        }
      }
      holeDirty = moved;
    }
  }
  const start = world.poi('wreck');
  place(start.x, start.z, true);

  return {
    name: 'terrain',
    update(f: Frame): void {
      const c = f.view.camera;
      place(c.x, c.z, false);
    },
    dispose(): void {
      engine.scene.remove(group);
      for (const r of rings) r.geo.dispose();
      mat.dispose();
    },
  };
}
