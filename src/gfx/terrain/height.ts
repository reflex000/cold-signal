// TSL height functions shared by the terrain vertex shader and the horizon pass. One definition
// of the surface, so every LOD, the shadow pass and the terrain-shadow march agree.
//   - heightmap (R32F, 2 m): bilinear, or Catmull-Rom where the mesh is finer than 2 m. Catmull-Rom
//     interpolates (it returns the sample exactly at sample points), so a fine LOD vertex that has
//     morphed onto the 2 m grid gets the same height as the coarse LOD next to it: no cracks.
//   - far map (R32F, 24 m): bilinear outside the heightmap square, blended in over EDGE_BLEND.
// Float textures are read with textureLoad (no filtering exists for R32F on WebGL2 or on WebGPU
// without float32-filterable). Owner: TERRAIN.
import { Fn, If, clamp, exp2, float, floor, ivec2, log2, max, min, mix, smoothstep, step, textureLoad, vec2 } from 'three/tsl';
import { EDGE_BLEND, FAR_CELL, FAR_N, FAR_ORIGIN } from './config';
import type { TerrainData } from './data';

type N = any;

export interface HeightFns {
  /** 0 outside the heightmap square .. 1 inside it (EDGE_BLEND band). */
  fineWeight(xz: N): N;
  /** Height at world xz. cubic: Catmull-Rom on the heightmap (16 loads) instead of bilinear (4). */
  height(xz: N, cubic: boolean): N;
  /**
   * Height at world xz filtered for a mesh of cell0 * 2^lod metres (lod a float node, >= the first
   * LOD with 2 m cells): the heightmap and far-map mip level whose samples match that cell.
   */
  heightLod(xz: N, lod: N): N;
  /** Height from the far map only (bilinear). */
  farHeight(xz: N): N;
  /** UV of a texel-centred texture over the heightmap square (normal map, masks). */
  fineUV(xz: N): N;
  /** UV of a texel-centred texture over the far map grid. */
  farUV(xz: N): N;
}

export function createHeightFns(data: TerrainData, cell0: N, cubicLod: N): HeightFns {
  const hT = data.heightTex;
  const fT = data.farTex;
  const n = data.fineN;
  const cell = data.fineCell;
  const ext = data.fineExtent;

  const load = (tex: N, i: N, j: N): N => textureLoad(tex, ivec2(i, j)).x;

  /** Bilinear read of mip level L (float, integer-valued) of an atlas built by data.mipAtlas. */
  const bilinearLevel = (tex: N, xz: N, origin: number, c: number, size0: number, L: N): N => {
    const scale = exp2(L);
    const size = float(size0 - 1).div(scale).add(1);
    const up = step(0.5, L);
    const xo = up.mul(size0);
    const yo = floor(float(size0 - 1).mul(exp2(L.oneMinus()).oneMinus()).add(L.sub(1)).add(0.5)).mul(up);
    const g = xz.sub(origin).div(scale.mul(c));
    const i0 = clamp(floor(g), vec2(0), vec2(size.sub(2)));
    const f = clamp(g.sub(i0), vec2(0), vec2(1));
    const bx = i0.x.add(xo), by = i0.y.add(yo);
    const a = load(tex, bx, by);
    const b = load(tex, bx.add(1), by);
    const cc = load(tex, bx, by.add(1));
    const d = load(tex, bx.add(1), by.add(1));
    return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
  };

  const bilinear = (tex: N, xz: N, origin: number, c: number, size: number): N => {
    const g = xz.sub(origin).div(c);
    const i0 = clamp(floor(g), vec2(0), vec2(size - 2));
    const f = clamp(g.sub(i0), vec2(0), vec2(1));
    const a = load(tex, i0.x, i0.y);
    const b = load(tex, i0.x.add(1), i0.y);
    const cc = load(tex, i0.x, i0.y.add(1));
    const d = load(tex, i0.x.add(1), i0.y.add(1));
    return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y);
  };

  // Catmull-Rom weights for parameter t in [0, 1).
  const crw = (t: N): N[] => {
    const t2 = t.mul(t), t3 = t2.mul(t);
    return [
      t2.sub(t.mul(0.5)).sub(t3.mul(0.5)),
      t3.mul(1.5).sub(t2.mul(2.5)).add(1),
      t.mul(0.5).add(t2.mul(2)).sub(t3.mul(1.5)),
      t3.mul(0.5).sub(t2.mul(0.5)),
    ];
  };

  const catmullRom = (tex: N, xz: N): N => {
    const g = xz.add(ext).div(cell);
    const i1 = clamp(floor(g), vec2(0), vec2(n - 2));
    const t = clamp(g.sub(i1), vec2(0), vec2(1));
    const wx = crw(t.x), wy = crw(t.y);
    let sum: N = null;
    let lo: N = null, hi: N = null;
    for (let r = 0; r < 4; r++) {
      const jj = clamp(i1.y.add(r - 1), 0, n - 1);
      let row: N = null;
      for (let c = 0; c < 4; c++) {
        const ii = clamp(i1.x.add(c - 1), 0, n - 1);
        const raw = load(tex, ii, jj).toVar();
        if ((r === 1 || r === 2) && (c === 1 || c === 2)) {
          lo = lo ? min(lo, raw) : raw;
          hi = hi ? max(hi, raw) : raw;
        }
        const v = raw.mul(wx[c]);
        row = row ? row.add(v) : v;
      }
      const rv = row.mul(wy[r]);
      sum = sum ? sum.add(rv) : rv;
    }
    // No overshoot: a cliff edge would otherwise grow a lip (or a trench) a few metres high.
    return clamp(sum, lo, hi);
  };

  const fineWeight = (xz: N): N => {
    const inside = float(ext).sub(max(xz.x.abs(), xz.y.abs()));
    return smoothstep(0, EDGE_BLEND, inside);
  };

  const farHeight = (xz: N): N => bilinear(fT, xz, FAR_ORIGIN, FAR_CELL, FAR_N);

  const heightLod = Fn(([xz, lod]: N[]) => {
    const cellL = cell0.mul(exp2(lod));
    const lf = clamp(lod.sub(cubicLod), 0, data.fineLevels - 1).toVar();
    const lr = clamp(floor(log2(cellL.div(FAR_CELL))), 0, data.farLevels - 1).toVar();
    const w = fineWeight(xz).toVar();
    const h = float(0).toVar();
    If(w.greaterThan(0), () => {
      h.assign(bilinearLevel(hT, xz, -ext, cell, n, lf));
    });
    If(w.lessThan(1), () => {
      h.assign(mix(bilinearLevel(fT, xz, FAR_ORIGIN, FAR_CELL, FAR_N, lr), h, w));
    });
    return h;
  });

  const heightBil = Fn(([xz]: N[]) => {
    const w = fineWeight(xz).toVar();
    const h = float(0).toVar();
    If(w.greaterThan(0), () => {
      h.assign(bilinear(hT, xz, -ext, cell, n));
    });
    If(w.lessThan(1), () => {
      h.assign(mix(farHeight(xz), h, w));
    });
    return h;
  });

  const heightCubic = Fn(([xz]: N[]) => {
    const w = fineWeight(xz).toVar();
    const h = float(0).toVar();
    If(w.greaterThan(0), () => {
      h.assign(catmullRom(hT, xz));
    });
    If(w.lessThan(1), () => {
      h.assign(mix(farHeight(xz), h, w));
    });
    return h;
  });

  return {
    fineWeight,
    height: (xz: N, cubic: boolean): N => (cubic ? heightCubic(xz) : heightBil(xz)),
    heightLod: (xz: N, lod: N): N => heightLod(xz, lod),
    farHeight,
    fineUV: (xz: N): N => xz.add(ext).div(cell).add(0.5).div(n),
    farUV: (xz: N): N => xz.sub(FAR_ORIGIN).div(FAR_CELL).add(0.5).div(FAR_N),
  };
}
