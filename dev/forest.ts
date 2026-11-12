// FOREST bench: the real forest system (trees, impostors, rocks, ground cover) on createWorld(417),
// over a plain white stand-in terrain built here from world.heightmap (the real terrain is
// TERRAIN's), in the bench's four lights.
//
//   dev/forest.html?view=forest|edge|aerial|clearing|snags   (default forest)
//     &light=day|dusk|night|storm  &q=mobile|low|medium|high|ultra  &webgl=1
//     &wind=0..25 (m/s)  &lod=1 (tint: full red, simplified green, impostor blue)
//     &forest=0 (no forest: for A/B timing)  &perf=1 (print GPU ms after the frames)
//     &t=12 (freeze the clock: stable shots)  &hud=1  and every createBench parameter (az, el, dist ...)
//
// Shots: node tools/shot.mjs "dev/forest.html?view=edge&light=dusk&t=3&frames=12" --out forest_edge_dusk
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createBench } from './bench';
import { createWorld } from '../src/world/index';
import { U } from '../src/gfx/shared';
import { createForestSystem, type ForestSystem } from '../src/gfx/forest';
import { getFoliageAtlas } from '../src/gfx/forest/textures';
import { proxyGeometry, treeGeometry } from '../src/gfx/forest/treegen';

const { positionWorld, vec3, float, mx_noise_float } = TSL as any;

const bench = await createBench({ ground: false });
const { engine, scene, orbit } = bench;
const view = bench.param('view') ?? 'forest';
// debug: ?scale=0.5 multiplies the render scale (fragment-bound or not)
if (bench.param('scale')) engine.userScale = bench.num('scale', 1);

const t0 = performance.now();
const world = createWorld(417);
const tWorld = performance.now() - t0;

// ---------------- stand-in terrain: a fine window around the view over a coarse whole ----------------
function terrain(cx: number, cz: number, half: number, step: number, drop: number): THREE.Mesh {
  const n = Math.round((2 * half) / step) + 1;
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const x0 = Math.round((cx - half) / step) * step, z0 = Math.round((cz - half) / step) * step;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const k = (j * n + i) * 3;
      pos[k] = x;
      pos[k + 1] = world.heightAt(x, z) - drop;
      pos[k + 2] = z;
      const nn = world.normalAt(x, z);
      nor[k] = nn.x;
      nor[k + 1] = nn.y;
      nor[k + 2] = nn.z;
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.set([a, c, b, b, c, d], q);
      q += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const nz: any = mx_noise_float(positionWorld.xz.mul(0.35)).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(2.3)).mul(0.25));
  (m as any).colorNode = vec3(0.86, 0.885, 0.93).mul(float(0.96).add(nz.mul(0.05)));
  m.fog = true;
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.name = 'bench-terrain';
  return mesh;
}

// ---------------- views ----------------
// A view is an eye (x, z, height above the ground) and what it looks at: either a point (tx, tz,
// height above the ground there) or a direction (az: 0 = north, clockwise; pitch: degrees up)
// followed down to the ground. The bench's orbit target goes where the look meets the ground, so
// its stand-in shadow box covers what is looked at.
interface ViewDef { x: number; z: number; up: number; tx?: number; tz?: number; tup?: number; az?: number; pitch?: number }
const VIEWS: Record<string, ViewDef> = {
  // inside the dense forest beside the ranger cabin, eye height, looking west between the trunks
  forest: { x: -442, z: 187, up: 1.7, tx: -470, tz: 186, tup: 3.5 },
  // in the open below a forest edge, looking up the slope at it
  edge: { x: 490, z: 670, up: 1.7, tx: 442, tz: 613, tup: 7 },
  // 300 m above the southern slope, looking north over the forest toward the lake
  aerial: { x: -260, z: 560, up: 300, az: 8, pitch: -28 },
  // standing in a clearing ringed by forest
  clearing: { x: -400, z: 20, up: 1.7, az: 250, pitch: 4 },
  // the snag cluster beside the cabin
  snags: { x: -452, z: 194, up: 1.7, tx: -478, tz: 183, tup: 5 },
};
const V = VIEWS[view] ?? VIEWS.forest;
const DEG = Math.PI / 180;
{
  const eye = new THREE.Vector3(V.x, world.heightAt(V.x, V.z) + V.up, V.z);
  let target: THREE.Vector3;
  if (V.tx !== undefined && V.tz !== undefined) {
    target = new THREE.Vector3(V.tx, world.heightAt(V.tx, V.tz) + (V.tup ?? 0), V.tz);
  } else {
    const az = (V.az ?? 0) * DEG, el = (V.pitch ?? 0) * DEG;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    target = eye.clone().addScaledVector(dir, 40);
    for (let t = 2; t < 2500; t += 2) {
      const p = eye.clone().addScaledVector(dir, t);
      if (p.y <= world.heightAt(p.x, p.z)) {
        target = p;
        break;
      }
    }
    if (el >= 0) target = eye.clone().addScaledVector(dir, 40);
  }
  const d = target.clone().sub(eye);
  const dist = d.length();
  // bench orbit: az 0 looks north, el > 0 looks down; the camera sits `dist` behind the target
  orbit.az = bench.num('az', Math.atan2(d.x, -d.z) / DEG);
  orbit.el = bench.num('el', -Math.asin(d.y / dist) / DEG);
  orbit.dist = bench.num('dist', dist);
  orbit.target.copy(target);
}
scene.add(terrain(V.x, V.z, view === 'aerial' ? 760 : 560, 2, 0));
scene.add(terrain(0, 0, 1024, 8, 0.8));

// ---------------- the forest ----------------
const wind = bench.num('wind', NaN);
if (Number.isFinite(wind)) {
  U.windSpeed.value = wind;
  U.gust.value = Math.min(1, wind / 25);
}
let forest: ForestSystem | null = null;
const t1 = performance.now();
if (bench.param('forest') !== '0') {
  forest = createForestSystem(engine, world);
  engine.add(forest);
  forest.setLodTint(bench.param('lod') === '1');
  // debug: ?hide=impostors,rocks,cover,full,mid,snag  ?noshadow=1
  const hide = (bench.param('hide') ?? '').split(',').filter(Boolean);
  forest.group.traverse((o) => {
    if (hide.some((h) => o.name.includes(h))) o.visible = false;
  });
  if (bench.param('noshadow') === '1') {
    const f = forest;
    const off = (): void => f.group.traverse((o) => { o.castShadow = false; });
    off();
    bench.onFrame(off);
  }
}
const tForest = performance.now() - t1;
(window as any).FOREST = forest;
// debug: ?atlas=1 (albedo) or ?atlas=2 (aux) shows the impostor atlas over the frame
if (forest?.impostorAtlas && bench.param('atlas')) {
  const a = bench.param('atlas');
  const tex = a === '3' ? getFoliageAtlas() : a === '2' ? forest.impostorAtlas.aux : forest.impostorAtlas.albedo;
  const { texture: ttex, vec2: v2, mix: tmix, vec3: tv3 } = TSL as any;
  engine.post.addOverlay('forest-atlas', 900, (color: any, uv: any) => {
    const t: any = ttex(tex, v2(uv.x, uv.y.oneMinus()));
    const bg: any = tmix(tv3(0.25, 0.3, 0.35), tv3(0.4, 0.45, 0.5), uv.x.mul(31).floor().add(uv.y.mul(15).floor()).mod(2));
    return tmix(bg, t.rgb.div(t.a.max(0.004)).pow(1 / 2.2), t.a);
  });
}
(window as any).WORLD = world;
{
  const tri = (g: THREE.BufferGeometry): number => (g.index ? g.index.count / 3 : 0);
  const kinds = ['spruce', 'fir', 'snag'] as const;
  console.log('[forest bench] triangles ' + kinds.map((k) => `${k} ${tri(treeGeometry(k, 'full'))}/${tri(treeGeometry(k, 'mid'))}`).join('  ') +
    `  proxy ${tri(proxyGeometry('spruce'))}/${tri(proxyGeometry('fir'))}`);
}
console.log(`[forest bench] world ${tWorld.toFixed(0)} ms, forest ${tForest.toFixed(0)} ms (impostor bake ${forest?.counts.impostorBakeMs.toFixed(0) ?? '-'} ms), view ${view}`);

// info line
const info = document.createElement('div');
info.style.cssText = 'position:fixed;left:8px;bottom:8px;color:#dfe5ec;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none;text-shadow:0 1px 2px #000';
if (bench.param('hud') === '1') document.body.appendChild(info);
let frames = 0;
const perf = bench.param('perf') === '1';
const perfFrames = bench.num('pf', 240);
bench.onFrame(() => {
  frames++;
  if (forest && frames % 10 === 0) {
    const c = forest.counts;
    info.textContent = `${view}  full ${c.full}  mid ${c.mid}  snag ${c.snag}  rocks ${c.rockNear}/${c.rockMid}  bake ${c.impostorBakeMs.toFixed(0)} ms`;
  }
  if (perf && frames === perfFrames) {
    const s = engine.stats;
    const msg = `[forest perf] ${view} ${engine.quality.name} ${engine.width}x${engine.height} gpu ${s.gpuMs.toFixed(2)} ms  frame ${s.frameMs.toFixed(1)} ms  calls ${s.calls}  tris ${(s.tris / 1000).toFixed(0)}k  forest=${forest ? 1 : 0}`;
    console.log(msg);
    (window as any).PERF = { gpuMs: s.gpuMs, calls: s.calls, tris: s.tris };
  }
});
if (perf) bench.busy(new Promise<void>((ok) => {
  const wait = (): void => {
    if (frames >= perfFrames + 5) ok();
    else setTimeout(wait, 50);
  };
  wait();
}));

// ---------------- interleaved A/B timing: ?perf=ab&cfg=none,all,trees,imp,rocks,cover ----------------
// Cycles the configurations inside one page (each phase 100 frames, the first 45 ignored while the
// GPU timer settles), three rounds, and prints the median GPU time of each: the other loads on a
// shared GPU drift slowly, so interleaving keeps the comparison fair.
if (bench.param('perf') === 'ab' && forest) {
  const f = forest;
  const cfgs = (bench.param('cfg') ?? 'none,all,trees,imp,rocks,cover').split(',');
  const match: Record<string, (name: string) => boolean> = {
    none: () => false,
    all: () => true,
    trees: (n) => /spruce|fir|snag/.test(n),
    full: (n) => /-full|proxy/.test(n) && !/snag/.test(n),
    mid: (n) => /-mid/.test(n),
    proxy: (n) => /proxy/.test(n),
    snag: (n) => /snag/.test(n),
    imp: (n) => /impostor/.test(n),
    rocks: (n) => /rocks/.test(n),
    cover: (n) => /cover/.test(n),
  };
  const leaves: THREE.Object3D[] = [];
  f.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) leaves.push(o);
  });
  const apply = (c: string): void => {
    const m = match[c] ?? match.all;
    for (const o of leaves) o.visible = m(o.name);
  };
  const samples: Record<string, number[]> = {};
  const PH = bench.num('ph', 90), SKIP = Math.round(PH * 0.45), ROUNDS = bench.num('rounds', 2);
  let k = 0;
  apply(cfgs[0]);
  bench.busy(new Promise<void>((ok) => {
    bench.onFrame(() => {
      const total = cfgs.length * ROUNDS * PH;
      if (k >= total) return;
      const phase = Math.floor(k / PH), inPh = k % PH;
      const c = cfgs[phase % cfgs.length];
      if (inPh >= SKIP && engine.stats.gpuMs > 0) (samples[c] ??= []).push(engine.stats.gpuMs);
      k++;
      if (k % PH === 0 && k < total) apply(cfgs[Math.floor(k / PH) % cfgs.length]);
      if (k === total) {
        apply('all');
        const med = (a: number[]): number => {
          const s = [...a].sort((x, y) => x - y);
          return s.length ? s[Math.floor(s.length / 2)] : NaN;
        };
        const base = med(samples.none ?? []);
        const rows = cfgs.map((c) => `${c}=${med(samples[c] ?? []).toFixed(1)}${Number.isFinite(base) && c !== 'none' ? ` (+${(med(samples[c] ?? []) - base).toFixed(1)})` : ''}`);
        console.log(`[forest perf] ${view} ${engine.quality.name} ${engine.width}x${engine.height} ${engine.backend} median gpu ms: ${rows.join('  ')}`);
        ok();
      }
    });
  }));
}
