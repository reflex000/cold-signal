// The CPU half of the snow: records, the fill-in arithmetic and what the events press. No GPU.
import { describe, expect, it } from 'vitest';
import { createWorld } from '../../world/index';
import type { View } from '../../game/view';
import type { SimEvent } from '../../sim/types';
import { DEPTH_FILL_RATE, FRESH_FILL, K_BODY, K_BOOT, K_GROOVE, K_PAW, RIM_FILL_RATE } from './config';
import { CAPACITY, RecordStore } from './records';
import { Tracks } from './tracks';

const world = createWorld(417);

/** A flat open spot with about 0.3 m of loose snow and no packed trail, near the wreck. */
function openSnow(): { x: number; z: number } {
  const w = world.poi('wreck');
  const m = world.masks;
  for (let r = 30; r < 400; r += 5) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const x = w.x + Math.sin(a) * r, z = w.z + Math.cos(a) * r;
      const i = Math.round(((x + m.extent) / (2 * m.extent)) * (m.n - 1)), j = Math.round(((z + m.extent) / (2 * m.extent)) * (m.n - 1));
      const packed = m.data[(j * m.n + i) * 4 + 3] / 255;
      const sd = world.snowDepthAt(x, z);
      if (world.surfaceAt(x, z) === 'snow' && sd > 0.22 && sd < 0.34 && packed < 0.05 && world.slopeAt(x, z) < 0.1) return { x, z };
    }
  }
  throw new Error('no open snow found');
}

/** The least of a View the tracks read. */
function fakeView(ents: Record<number, unknown> = {}): View {
  const map = new Map<number, any>(Object.entries(ents).map(([k, v]) => [Number(k), v]));
  return { ents: map, list: () => [] } as unknown as View;
}

describe('snow records', () => {
  it('fills a print in as snow settles, rims and the compacted look first', () => {
    const s = new RecordStore();
    const i = s.add(K_BOOT, 10, 20, 0, -1, 0.056, 0.15, 0.15, 0.03, 0, 0, 0.5);
    const r = { depth: 0, rim: 0, fresh: 0, soft: 0 };
    s.eval(i, 0, r);
    expect(r.depth).toBeCloseTo(0.15);
    expect(r.fresh).toBe(1);
    s.eval(i, 0.01, r);
    expect(r.depth).toBeCloseTo(0.15 - 0.01 * DEPTH_FILL_RATE);
    expect(r.rim).toBeCloseTo(0.03 - 0.01 * RIM_FILL_RATE);
    expect(r.fresh).toBeCloseTo(1 - 0.01 / FRESH_FILL);
    // 2 cm of new snow hides the compacted floor; the hollow is still there
    s.eval(i, 0.02, r);
    expect(r.fresh).toBe(0);
    expect(r.depth).toBeGreaterThan(0.1);
    expect(s.gone(i, 0.05)).toBe(false);
    expect(s.gone(i, 0.15 / DEPTH_FILL_RATE + 0.01)).toBe(true);
  });

  it('finds records by area, forgets filled ones and reports how far the snow is pressed', () => {
    const s = new RecordStore();
    s.add(K_BOOT, 100, 100, 0, -1, 0.056, 0.15, 0.2, 0.02, 0, 0, 0.1);
    s.add(K_GROOVE, 140, 100, 1, 0, 0.13, 1, 0.1, 0.03, 0, 0, 0.2);
    s.add(K_PAW, 300, 300, 0, -1, 0.036, 0.046, 0.08, 0.01, 0, 0, 0.3);
    const seen: number[] = [];
    s.query(90, 90, 150, 110, 0, (i) => {
      seen.push(i);
    });
    expect(seen.length).toBe(2);
    expect(s.pressAt(100, 100, 0)).toBeCloseTo(0.2);
    expect(s.pressAt(140.8, 100, 0)).toBeCloseTo(0.1);
    expect(s.pressAt(120, 100, 0)).toBe(0);
    // after enough fill the query drops the filled records for good
    s.query(-1e4, -1e4, 1e4, 1e4, 10, () => {});
    expect(s.count).toBe(0);
  });

  it('is a ring: the oldest record makes room for the newest', () => {
    const s = new RecordStore();
    for (let k = 0; k < CAPACITY + 10; k++) s.add(K_BOOT, (k % 500) * 0.5, Math.floor(k / 500) * 0.5, 0, -1, 0.05, 0.15, 0.1, 0.01, 0, 0, 0);
    expect(s.count).toBe(CAPACITY);
    // every record is listed exactly once (the old ones left their cells when overwritten)
    let n = 0;
    s.query(-10, -10, 300, 300, 0, () => {
      n++;
    });
    expect(n).toBe(CAPACITY);
  });
});

describe('snow tracks', () => {
  it('presses alternating boot prints beside the line of the steps, deeper in deeper snow', () => {
    const p = openSnow();
    const s = new RecordStore();
    const t = new Tracks(s, world);
    // the walker is in the view (its velocity gives the heading of the first step)
    const view = fakeView({ 7: { id: 7, kind: 'player', x: p.x, y: 0, z: p.z, yaw: -Math.PI / 2, vx: 2.4, vz: 0 } });
    for (let k = 0; k < 6; k++) {
      const e: SimEvent = { t: 'step', id: 7, x: p.x + k * 0.9, y: 0, z: p.z, surface: 'snow', run: false, left: k % 2 === 0 };
      t.onEvent(e, view, 0);
    }
    const boots: number[] = [];
    s.query(p.x - 2, p.z - 2, p.x + 8, p.z + 2, 0, (i) => {
      if (s.kind[i] === K_BOOT) boots.push(i);
    });
    expect(boots.length).toBe(6);
    for (const i of boots) {
      expect(Math.abs(Math.abs(s.z[i] - p.z) - 0.1)).toBeLessThan(0.02); // a foot either side of the line
      expect(s.fx[i]).toBeGreaterThan(0.9); // pointing the way the steps went (+x)
      expect(s.depth[i]).toBeGreaterThan(0.08);
      expect(s.depth[i]).toBeLessThan(0.3);
    }
    // nothing on rock or a floor
    t.onEvent({ t: 'step', id: 8, x: p.x, y: 0, z: p.z, surface: 'rock', run: false, left: true }, view, 0);
    t.onEvent({ t: 'step', id: 8, x: p.x, y: 0, z: p.z, surface: 'wood', run: false, left: false }, view, 0);
    expect(s.count).toBe(6);
  });

  it('leaves a body-shaped hollow where a player goes down', () => {
    const p = openSnow();
    const s = new RecordStore();
    const t = new Tracks(s, world);
    const view = fakeView({ 3: { id: 3, kind: 'player', x: p.x, y: world.heightAt(p.x, p.z), z: p.z, yaw: 0, vx: 0, vz: 0, life: 'downed' } });
    t.onEvent({ t: 'downed', id: 3 }, view, 0);
    let body = -1;
    s.query(p.x - 2, p.z - 2, p.x + 2, p.z + 2, 0, (i) => {
      if (s.kind[i] === K_BODY) body = i;
    });
    expect(body).toBeGreaterThanOrEqual(0);
    expect(s.depth[body]).toBeGreaterThan(0.03);
    // head toward the facing (yaw 0 faces north, -z): the hollow's centre lies behind the position
    expect(s.z[body]).toBeGreaterThan(p.z);
    expect(s.pressAt(p.x, p.z, 0)).toBeGreaterThan(0.03);
  });
});
