// A cheap fluvial erosion pass on a coarse grid: implicit stream power (Braun & Willett 2013)
// plus a little hillslope diffusion. Channels where flow gathers are cut down and graded while
// ridges keep their height, which turns smooth noise into drainage that reads as geology.
//
// Drainage area is accumulated with multiple flow directions (each cell shares its water among
// all lower neighbours by slope): single-direction routing on a grid draws long straight
// grooves down an even slope. The implicit update then follows the steepest receiver.
// Cells are ordered by an exact integer key (quantised height, then index), so the result is
// the same on every engine. The order barely changes between iterations, so after the first
// full sort it is repaired with an insertion sort.

const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DZ = [0, 0, 1, -1, 1, 1, -1, -1];

export interface ErodeOptions {
  iterations: number;
  /** Stream power coefficient (per iteration). */
  k: number;
  /** Diffusion per iteration as a fraction of the 4-neighbour Laplacian (stable below 0.25). */
  diffuse: number;
}

/** Erode `h` (n x n, `cell` metres apart) in place. Border cells are fixed outlets. */
export function erode(h: Float64Array, n: number, cell: number, o: ErodeOptions): void {
  const size = n * n;
  const keys = new Float64Array(size);
  const order = new Int32Array(size);
  const area = new Float64Array(size);
  const tmp = new Float64Array(size);
  const rcv = new Int32Array(size);
  const rdist = new Float64Array(size);
  const inner = new Uint8Array(size);
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) inner[j * n + i] = 1;
  const nd = new Float64Array(8), of = new Int32Array(8);
  for (let k = 0; k < 8; k++) {
    nd[k] = Math.sqrt(DX[k] * DX[k] + DZ[k] * DZ[k]) * cell;
    of[k] = DZ[k] * n + DX[k];
  }
  const cellArea = cell * cell;
  const IDX = 131072; // > size for n <= 362
  const w = new Float64Array(8);
  const kc = o.k;

  for (let it = 0; it < o.iterations; it++) {
    // order by height (ascending), ties by index
    if (it === 0) {
      for (let c = 0; c < size; c++) keys[c] = Math.round(h[c] * 4096) * IDX + c;
      keys.sort();
      for (let p = 0; p < size; p++) {
        const kv = keys[p];
        order[p] = kv - Math.floor(kv / IDX) * IDX;
      }
    } else {
      for (let p = 0; p < size; p++) {
        const c = order[p];
        keys[p] = Math.round(h[c] * 4096) * IDX + c;
      }
      for (let p = 1; p < size; p++) {
        const kv = keys[p], c = order[p];
        let q = p - 1;
        while (q >= 0 && keys[q] > kv) {
          keys[q + 1] = keys[q];
          order[q + 1] = order[q];
          q--;
        }
        keys[q + 1] = kv;
        order[q + 1] = c;
      }
    }
    // multiple-flow-direction drainage area from the highest cell down; note the steepest receiver
    area.fill(cellArea);
    for (let p = size - 1; p >= 0; p--) {
      const c = order[p];
      rcv[c] = -1;
      if (inner[c] === 0) continue;
      const hc = h[c];
      let sum = 0, best = 0;
      for (let k = 0; k < 8; k++) {
        const s = (hc - h[c + of[k]]) / nd[k];
        if (s > 0) {
          w[k] = s;
          sum += s;
          if (s > best) {
            best = s;
            rcv[c] = c + of[k];
            rdist[c] = nd[k];
          }
        } else w[k] = 0;
      }
      if (sum <= 0) continue;
      const a = area[c] / sum;
      for (let k = 0; k < 8; k++) if (w[k] > 0) area[c + of[k]] += a * w[k];
    }
    // implicit stream power (m = 0.5, n = 1) toward the steepest receiver, lowest cells first
    for (let p = 0; p < size; p++) {
      const c = order[p];
      const r = rcv[c];
      if (r < 0) continue;
      const f = (kc * Math.sqrt(area[c])) / rdist[c];
      h[c] = (h[c] + f * h[r]) / (1 + f);
    }
    // hillslope diffusion
    if (o.diffuse > 0) {
      const d = o.diffuse;
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const c = j * n + i;
          tmp[c] = h[c] + d * (h[c - 1] + h[c + 1] + h[c - n] + h[c + n] - 4 * h[c]);
        }
      }
      for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) h[j * n + i] = tmp[j * n + i];
    }
  }
}
