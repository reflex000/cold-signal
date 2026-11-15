// World tests: npx vitest run src/world
import { beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type WorldEx } from './index';
import type { PartId } from '../sim/types';
import type { Collider, SpawnDef, SpawnItem } from './types';
import { slowdown } from '../sim/timing';

const DEG = 1 / 90; // slopeAt is the slope angle / 90 degrees

let W: WorldEx;
let buildMs = 0;
let slow = 1;

beforeAll(() => {
  // how busy the machine was around the build (1 = idle): the time budget scales with it
  const before = slowdown();
  const t0 = performance.now();
  W = createWorld(417);
  buildMs = performance.now() - t0;
  slow = Math.max(before, slowdown());
}, 120000);

function insideCollider(c: Collider, x: number, y: number, z: number): boolean {
  if (y < c.y0 || y > c.y1) return false;
  const dx = x - c.x, dz = z - c.z;
  if (c.s === 'c') return dx * dx + dz * dz < c.r * c.r;
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  return Math.abs(lx) < c.hx && Math.abs(lz) < c.hz;
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Things that sit on furniture or are fixtures inside it: exempt from the walkable test. */
function onFurniture(d: SpawnDef): boolean {
  if (d.kind === 'pickup') return d.lie === 'shelf';
  if (d.kind === 'fire') return d.type === 'stove' || d.type === 'barrel';
  if (d.kind === 'device') return d.type !== 'door';
  return false;
}

describe('world', () => {
  it('builds fast enough', () => {
    // The brief asks for under 2.5 s on a desktop; the bound here is loose so a busy machine
    // does not fail the suite. The measured time is printed.
    console.log(`createWorld(417): ${buildMs.toFixed(0)} ms (machine ${slow.toFixed(2)}x slower than idle), trees ${W.trees.length}, rocks ${W.rocks.length}, props ${W.props.length}, defs ${W.spawn.defs.length}`);
    expect(buildMs).toBeLessThan(8000 * slow);
  });

  it('is deterministic', () => {
    const B = createWorld(417);
    expect(sameBytes(B.heightmap.data, W.heightmap.data)).toBe(true);
    expect(sameBytes(B.masks.data, W.masks.data)).toBe(true);
    expect(sameBytes(B.lake.thickness, W.lake.thickness)).toBe(true);
    expect(JSON.stringify(B.trees)).toBe(JSON.stringify(W.trees));
    expect(JSON.stringify(B.rocks)).toBe(JSON.stringify(W.rocks));
    expect(JSON.stringify(B.props)).toBe(JSON.stringify(W.props));
    expect(JSON.stringify(B.spawn)).toBe(JSON.stringify(W.spawn));
    expect(JSON.stringify(B.route)).toBe(JSON.stringify(W.route));
    expect(JSON.stringify(B.pois)).toBe(JSON.stringify(W.pois));
    expect(JSON.stringify(B.floors)).toBe(JSON.stringify(W.floors));
    expect(JSON.stringify(B.shelters)).toBe(JSON.stringify(W.shelters));
  }, 60000);

  it('puts every place on level ground near its target', () => {
    const targets: Record<string, [number, number]> = { wreck: [-120, 520], tail: [270, 380], cabin: [-430, 130], lake: [190, -40], hut: [190, -40], cave: [-310, -290], camp: [480, -330], tower: [40, -610] };
    expect(W.pois.map((p) => p.id).sort()).toEqual(Object.keys(targets).sort());
    for (const p of W.pois) {
      expect(W.slopeAt(p.x, p.z), p.id).toBeLessThan(12 * DEG);
      expect(Math.hypot(p.x - targets[p.id][0], p.z - targets[p.id][1]), p.id).toBeLessThan(15);
      expect(Math.abs(p.y - W.heightAt(p.x, p.z)), p.id).toBeLessThan(0.05);
      expect(W.poi(p.id)).toBe(p);
    }
    // the mountain rises from the wreck to the tower
    expect(W.poi('wreck').y).toBeGreaterThan(100);
    expect(W.poi('wreck').y).toBeLessThan(140);
    expect(W.poi('tower').y).toBeGreaterThan(410);
    expect(W.poi('tower').y).toBeLessThan(450);
  });

  it('has a walkable route through every place in order', () => {
    const order = W.route.filter((r) => r.poi).map((r) => r.poi);
    expect(order).toEqual(['wreck', 'tail', 'cabin', 'lake', 'hut', 'cave', 'camp', 'tower']);
    let worst = 0, length = 0;
    for (let i = 1; i < W.route.length; i++) {
      const a = W.route[i - 1], b = W.route[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      expect(len, `segment ${i}`).toBeLessThan(30);
      length += len;
      for (let s = 0; s <= len; s += 1) {
        const x = a.x + ((b.x - a.x) * s) / len, z = a.z + ((b.z - a.z) * s) / len;
        const sl = W.slopeAt(x, z);
        if (sl > worst) worst = sl;
        expect(sl, `slope at ${x.toFixed(1)},${z.toFixed(1)}`).toBeLessThan(35 * DEG);
        expect(W.walkable(x, z), `walkable at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(true);
      }
    }
    console.log(`route ${length.toFixed(0)} m, ${W.route.length} waypoints, steepest ${(worst * 90).toFixed(1)} deg`);
  });

  it('places spawn defs on walkable ground, out of colliders', () => {
    const near: Collider[] = [];
    for (const d of W.spawn.defs) {
      const where = `${d.kind} ${'item' in d ? d.item : 'type' in d ? d.type : ''} at ${d.x.toFixed(1)},${d.z.toFixed(1)}`;
      expect(Math.abs(d.x) < 790 && Math.abs(d.z) < 790, where).toBe(true);
      // never under the ground
      expect(d.y, where).toBeGreaterThan(W.heightAt(d.x, d.z) - 0.05);
      if (onFurniture(d)) continue;
      expect(W.walkable(d.x, d.z), where).toBe(true);
      near.length = 0;
      W.collidersNear(d.x, d.z, 0.05, near);
      for (const c of near) expect(insideCollider(c, d.x, d.y + 0.1, d.z), where).toBe(false);
      // resting on the ground or a floor
      expect(Math.abs(W.groundAt(d.x, d.z, d.y + 0.3).y - d.y), where).toBeLessThan(0.35);
    }
  });

  it('has the right amounts of things', () => {
    const defs = W.spawn.defs;
    const total = (item: string) => defs.reduce((a, d) => a + (d.kind === 'pickup' && d.item === item ? d.n : 0) + (d.kind === 'crate' ? d.loot.filter((l) => l.item === item).reduce((s, l) => s + l.n, 0) : 0), 0);
    expect(W.trees.length).toBeGreaterThanOrEqual(25000);
    expect(W.trees.length).toBeLessThanOrEqual(40000);
    const snags = W.trees.filter((t) => t.kind === 'snag').length / W.trees.length;
    expect(snags).toBeGreaterThan(0.015);
    expect(snags).toBeLessThan(0.05);
    expect(defs.filter((d) => d.kind === 'pickup' && d.item === 'stick').length).toBeGreaterThanOrEqual(380);
    expect(defs.filter((d) => d.kind === 'wood').length).toBeGreaterThanOrEqual(140);
    expect(defs.filter((d) => d.kind === 'log').length).toBeGreaterThanOrEqual(8);
    expect(total('matches')).toBeGreaterThanOrEqual(18);
    expect(total('matches')).toBeLessThanOrEqual(22);
    expect(total('ammo')).toBe(14);
    expect(total('flare')).toBe(7);
    for (const it of ['axe', 'rifle', 'flaregun', 'radio']) expect(total(it), it).toBe(1);
    expect(defs.filter((d) => d.kind === 'fire' && d.type === 'stove').length).toBe(1);
    expect(defs.filter((d) => d.kind === 'fire' && d.type === 'barrel').length).toBe(1);
    for (const t of ['panel', 'generator', 'door', 'note', 'bed', 'beacon'] as const) expect(defs.some((d) => d.kind === 'device' && d.type === t), t).toBe(true);
    expect(W.spawn.players.length).toBe(4);
    expect(W.spawn.packs.length).toBe(4);
    const wakes = W.spawn.packs.map((p) => p.wakeAt);
    expect(wakes.slice().sort((a, b) => a - b)).toEqual(wakes);
  });

  it('leaves sticks where people walk: 8 to 12 by the fuselage, many beside the trail, bundles of 1 to 3', () => {
    const sticks = W.spawn.defs.filter((d): d is SpawnItem => d.kind === 'pickup' && d.item === 'stick');
    const fus = W.props.find((p) => p.model === 'fuselage')!;
    const within = (r: number, x: number, z: number) => sticks.filter((d) => Math.hypot(d.x - x, d.z - z) <= r).reduce((a, d) => a + d.n, 0);
    const byWreck = within(40, fus.x, fus.z);
    expect(byWreck).toBeGreaterThanOrEqual(8);
    expect(byWreck).toBeLessThanOrEqual(12);
    // within 10 m of the trail (the dense route polyline), a hundred and more
    let nearTrail = 0;
    for (const d of sticks) if (W.trail.some((p) => Math.hypot(p.x - d.x, p.z - d.z) <= 10)) nearTrail += d.n;
    expect(nearTrail).toBeGreaterThanOrEqual(100);
    // scattered bundles hold 1 to 3 (the stacks laid at the cabin hearth and in the cave are their own)
    const laid = [W.poi('cabin'), W.poi('cave')];
    for (const d of sticks) if (laid.every((p) => Math.hypot(d.x - p.x, d.z - p.z) > 30)) expect(d.n >= 1 && d.n <= 3, `bundle of ${d.n}`).toBe(true);
    // under a dense canopy some lie on top of the snow
    expect(sticks.filter((d) => d.lie === 'ground').length).toBeGreaterThan(50);
    console.log(`sticks: ${sticks.length} pickups, ${sticks.reduce((a, d) => a + d.n, 0)} in all; ${byWreck} by the fuselage, ${nearTrail} within 10 m of the trail`);
  });

  it('starts the players just outside the fuselage break, on the ground', () => {
    const wreck = W.poi('wreck');
    for (const p of W.spawn.players) {
      expect(Math.hypot(p.x - wreck.x, p.z - wreck.z)).toBeLessThan(25);
      expect(W.walkable(p.x, p.z)).toBe(true);
      expect(Math.abs(p.y - W.groundAt(p.x, p.z, p.y + 0.3).y)).toBeLessThan(0.05);
    }
  });

  it('has all five radio parts, each a pickup where the table says', () => {
    const want: Record<PartId, string> = { battery: 'tail', handset: 'cabin', fuse: 'hut', tube: 'cave', coil: 'camp' };
    for (const id of Object.keys(want) as PartId[]) {
      const p = W.spawn.parts[id];
      expect(p, id).toBeTruthy();
      expect(p.poi).toBe(want[id]);
      const poi = W.poi(p.poi);
      expect(Math.hypot(p.x - poi.x, p.z - poi.z), id).toBeLessThan(poi.radius);
      const pick = W.spawn.defs.find((d) => d.kind === 'pickup' && d.item === 'part_' + id);
      expect(pick, id).toBeTruthy();
      expect(pick!.x).toBe(p.x);
      expect(pick!.z).toBe(p.z);
    }
  });

  it('has a level lake with thick and thin ice', () => {
    const L = W.lake;
    let n = 0, thin = 0, thick = 0;
    for (let z = L.minZ; z < L.minZ + L.n * L.cell; z += 1.7) {
      for (let x = L.minX; x < L.minX + L.n * L.cell; x += 1.7) {
        const t = W.iceAt(x, z);
        if (t <= 0) continue;
        n++;
        expect(W.heightAt(x, z)).toBeCloseTo(L.level, 4);
        expect(W.surfaceAt(x, z)).toBe('ice');
        expect(W.snowDepthAt(x, z)).toBe(0);
        expect(W.iceCell(x, z)).toBeGreaterThanOrEqual(0);
        if (t < 0.12) thin++;
        if (t >= 0.5) thick++;
      }
    }
    expect(n).toBeGreaterThan(5000); // about 260 m across
    expect(thin).toBeGreaterThan(100);
    expect(thick).toBeGreaterThan(1000);
    // the safe line to the hut is thick all the way
    const s = W.safeLine;
    for (let t = 0.05; t <= 1; t += 0.02) {
      const x = s.ax + (s.bx - s.ax) * t, z = s.az + (s.bz - s.az) * t;
      if (W.iceAt(x, z) > 0) expect(W.iceAt(x, z)).toBeGreaterThanOrEqual(0.5);
    }
    expect(W.iceAt(0, 0)).toBe(0);
    expect(W.iceCell(-300, 300)).toBe(-1);
  });

  it('cannot be walked out of', () => {
    for (let t = -800; t <= 800; t += 10) {
      expect(W.walkable(t, -800)).toBe(false);
      expect(W.walkable(t, 800)).toBe(false);
      expect(W.walkable(-800, t)).toBe(false);
      expect(W.walkable(800, t)).toBe(false);
    }
    // flood the ground a person can stand on (under the sim's 42 degree limit, out of solids)
    // from the wreck: it must stay well inside the west, east and north edges, and never reach
    // past the south edge (where the far side of the valley rises)
    const C = 2, H = 800, G = Math.round((2 * H) / C) + 1;
    const seen = new Uint8Array(G * G);
    const ok = (i: number, j: number) => {
      const x = -H + i * C, z = -H + j * C;
      return W.slopeAt(x, z) < 42 * DEG && W.walkable(x, z);
    };
    const w = W.poi('wreck');
    const si = Math.round((w.x - 12 + H) / C), sj = Math.round((w.z - 12 + H) / C);
    const queue = new Int32Array(G * G);
    let head = 0, tail = 0;
    queue[tail++] = sj * G + si;
    seen[sj * G + si] = 1;
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    while (head < tail) {
      const c = queue[head++];
      const i = c % G, j = (c - i) / G;
      const x = -H + i * C, z = -H + j * C;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= G || nj >= G) continue;
        const k = nj * G + ni;
        if (seen[k]) continue;
        seen[k] = 1;
        if (ok(ni, nj)) queue[tail++] = k;
      }
    }
    console.log(`reachable: x ${minX}..${maxX}, z ${minZ}..${maxZ}, ${tail} cells of ${G * G}`);
    expect(minX).toBeGreaterThan(-786);
    expect(maxX).toBeLessThan(786);
    expect(minZ).toBeGreaterThan(-786);
    expect(maxZ).toBeLessThan(799);
    expect(tail).toBeGreaterThan(G * G * 0.4);
  });

  it('answers collision and sight queries', () => {
    // a tree is found next to itself and blocks a ray through its trunk
    const t = W.trees.find((q) => q.kind === 'pine' && q.scale > 0.9)!;
    const out: Collider[] = [];
    W.collidersNear(t.x, t.z, 1, out);
    expect(out.some((c) => c.s === 'c' && c.x === t.x && c.z === t.z)).toBe(true);
    const hit = W.raycast(t.x - 6, t.y + 1.5, t.z, 1, 0, 0, 12);
    expect(hit).not.toBeNull();
    expect(['tree', 'rock', 'wall', 'ground']).toContain(hit!.what);
    expect(hit!.dist).toBeLessThanOrEqual(6);
    // straight down hits the ground at the terrain height
    const g = W.raycast(10, 400, 300, 0, -1, 0, 1000)!;
    expect(g.what === 'ground' || g.what === 'tree' || g.what === 'rock').toBe(true);
    if (g.what === 'ground') expect(g.y).toBeCloseTo(W.heightAt(10, 300), 1);
    // the ridge hides the far side of the mountain from the lake
    const lake = W.poi('lake');
    expect(W.lineClear(lake.x, lake.y + 1.7, lake.z, 40, W.heightAt(40, -760) + 1.7, -760)).toBe(false);
    // open ice (away from the hut in the middle) sees across the ice
    expect(W.lineClear(lake.x - 40, lake.y + 1.7, lake.z + 20, lake.x + 30, lake.y + 1.7, lake.z + 30)).toBe(true);
    // cabin walls stop a ray from inside
    const stove = W.anchors['cabin:cabin.stove'];
    expect(W.lineClear(stove.x, stove.y + 1.5, stove.z, stove.x + 30, stove.y + 1.5, stove.z - 30)).toBe(false);
  });

  it('has floors, shelters and indoor places', () => {
    const cab = W.anchors['cabin:cabin.bedside'];
    const g = W.groundAt(cab.x, cab.z, cab.y + 0.2);
    expect(g.surface).toBe('wood');
    expect(g.y).toBeCloseTo(cab.y, 3);
    const sh = W.shelterAt(cab.x, cab.y + 1, cab.z, 15, 3);
    expect(sh.indoor).toBe(true);
    expect(sh.amount).toBeGreaterThan(0.85);
    expect(W.snowDepthAt(cab.x, cab.z)).toBe(0);
    const cave = W.anchors['cave:cave.fire'];
    expect(W.shelterAt(cave.x, cave.y + 1, cave.z, 20, 0).indoor).toBe(true);
    // out on the open shoulder in a storm there is little shelter
    const camp = W.poi('camp');
    expect(W.shelterAt(camp.x + 30, W.heightAt(camp.x + 30, camp.z + 25) + 1, camp.z + 25, 18, 10).amount).toBeLessThan(0.6);
    // snow lies deep somewhere in the forest and is thin on the ridge
    let deep = 0;
    for (let k = 0; k < 400; k++) if (W.snowDepthAt(-500 + (k % 20) * 20, 200 + Math.floor(k / 20) * 15) > 0.45) deep++;
    expect(deep).toBeGreaterThan(10);
    const tower = W.poi('tower');
    expect(W.forestAt(tower.x, tower.z)).toBe(0);
    expect(W.forestAt(-300, 300) + W.forestAt(-200, 400) + W.forestAt(0, 500)).toBeGreaterThan(0.3);
  });

  it('builds a playable world from other seeds', () => {
    for (const seed of [1, 9001]) {
      const B = createWorld(seed);
      for (const p of B.pois) expect(B.slopeAt(p.x, p.z), `${seed} ${p.id}`).toBeLessThan(12 * DEG);
      for (let i = 1; i < B.route.length; i++) {
        const a = B.route[i - 1], b = B.route[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        for (let s = 0; s <= len; s += 1) {
          const x = a.x + ((b.x - a.x) * s) / len, z = a.z + ((b.z - a.z) * s) / len;
          expect(B.slopeAt(x, z), `${seed} slope at ${x.toFixed(0)},${z.toFixed(0)}`).toBeLessThan(35 * DEG);
          expect(B.walkable(x, z), `${seed} walkable at ${x.toFixed(0)},${z.toFixed(0)}`).toBe(true);
        }
      }
      expect(B.trees.length).toBeGreaterThan(20000);
      expect(B.trees.length).toBeLessThan(45000);
    }
  }, 120000);
});
