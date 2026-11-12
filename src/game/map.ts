// The pack's map (UiGame.map): a top-down drawing of the playable square made from the world
// data. Hill shading, contour lines every 25 m (every 100 m stronger), forest, bare rock, the lake
// ice and the marked trail, in the interface's palette (dark ground, off-white lines, one amber
// accent). Drawn in slices during idle time after boot so it never costs a frame; map() returns
// null until it is ready. Places and people are marked by the UI through toUV().
// Owner: GAME.
import type { World } from '../world/types';

const SIZE = 768;
const HALF = 800; // metres: the playable square
const ROWS_PER_SLICE = 24;

export interface GameMap {
  canvas: HTMLCanvasElement;
  toUV(x: number, z: number): [number, number];
}

export class MapMaker {
  private result: GameMap | null = null;
  private started = false;

  constructor(private readonly world: World) {}

  get(): GameMap | null {
    if (!this.started) this.start();
    return this.result;
  }

  /** Begin drawing in the background (call once the game is running). */
  start(): void {
    if (this.started || typeof document === 'undefined') return;
    this.started = true;
    const w = this.world;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const g = canvas.getContext('2d');
    if (!g) return;
    const img = g.createImageData(SIZE, SIZE);
    const px = img.data;
    const hts = new Float32Array(SIZE * SIZE);
    const m = w.masks;
    const mcell = (2 * m.extent) / (m.n - 1);
    const step = (2 * HALF) / SIZE;
    // light from the north-west, high: the classic map shading
    const lx = -0.55, ly = 0.62, lz = -0.55;
    let row = 0;

    const slice = (): void => {
      const end = Math.min(SIZE, row + ROWS_PER_SLICE);
      for (; row < end; row++) {
        const z = -HALF + (row + 0.5) * step;
        for (let col = 0; col < SIZE; col++) {
          const x = -HALF + (col + 0.5) * step;
          const h = w.heightAt(x, z);
          hts[row * SIZE + col] = h;
          const dx = (w.heightAt(x + step, z) - w.heightAt(x - step, z)) / (2 * step);
          const dz = (w.heightAt(x, z + step) - w.heightAt(x, z - step)) / (2 * step);
          const il = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
          const shade = Math.max(0, (-dx * lx + ly - dz * lz) * il);
          const mi = Math.min(m.n - 1, Math.max(0, Math.round((x + m.extent) / mcell)));
          const mj = Math.min(m.n - 1, Math.max(0, Math.round((z + m.extent) / mcell)));
          const k = (mj * m.n + mi) * 4;
          const forest = m.data[k] / 255, rock = m.data[k + 1] / 255, ice = m.data[k + 2] / 255;
          // ground: dark slate lifted by the shading and a little by height
          const lift = 0.35 + 0.65 * shade;
          let r = 14 + 30 * lift, gg = 19 + 32 * lift, b = 25 + 36 * lift;
          // forest darkens and greens a touch
          r -= 9 * forest;
          gg -= 4 * forest;
          b -= 9 * forest;
          // bare rock: darker, neutral
          r -= 8 * rock;
          gg -= 9 * rock;
          b -= 11 * rock;
          // lake ice: cool and flat
          if (ice > 0.5) {
            r = 34;
            gg = 52;
            b = 66;
          }
          const o = (row * SIZE + col) * 4;
          px[o] = r;
          px[o + 1] = gg;
          px[o + 2] = b;
          px[o + 3] = 255;
        }
      }
      if (row < SIZE) {
        later(slice);
        return;
      }
      // contours where a 25 m level is crossed between neighbours
      for (let j = 1; j < SIZE - 1; j++) {
        for (let i = 1; i < SIZE - 1; i++) {
          const h = hts[j * SIZE + i];
          const a = Math.floor(h / 25);
          const r = Math.floor(hts[j * SIZE + i + 1] / 25), d = Math.floor(hts[(j + 1) * SIZE + i] / 25);
          if (a !== r || a !== d) {
            const major = Math.max(a, r, d) % 4 === 0;
            const o = (j * SIZE + i) * 4;
            const k = major ? 0.3 : 0.13;
            px[o] += (235 - px[o]) * k;
            px[o + 1] += (232 - px[o + 1]) * k;
            px[o + 2] += (225 - px[o + 2]) * k;
          }
        }
      }
      g.putImageData(img, 0, 0);
      // the marked trail: a fine dotted amber line along the route
      const route = w.route;
      if (route.length > 1) {
        g.save();
        g.strokeStyle = 'rgba(214,160,72,0.75)';
        g.lineWidth = 1.4;
        g.setLineDash([2, 3]);
        g.beginPath();
        for (let i = 0; i < route.length; i++) {
          const u = (route[i].x + HALF) / (2 * HALF) * SIZE, v = (route[i].z + HALF) / (2 * HALF) * SIZE;
          if (i === 0) g.moveTo(u, v);
          else g.lineTo(u, v);
        }
        g.stroke();
        g.restore();
      }
      // a thin frame
      g.strokeStyle = 'rgba(235,232,225,0.18)';
      g.lineWidth = 1;
      g.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
      this.result = {
        canvas,
        toUV: (x: number, z: number): [number, number] => [(x + HALF) / (2 * HALF), (z + HALF) / (2 * HALF)],
      };
    };
    later(slice);
  }
}

function later(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 200 });
  else setTimeout(fn, 16);
}
