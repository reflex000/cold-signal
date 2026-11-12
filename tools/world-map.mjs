// Draw the world as a map, to judge the mountain and the placement by eye.
//   node tools/world-map.mjs [seed] [--px 1]
// Writes shots/world_map.png (hillshaded relief with slope tint, contours every 10 m, forest,
// rock, lake with ice thickness, trees as dots, rocks, props, spawn items as coloured dots, the
// route with its trail markers, the places with labels) and shots/world_profile.png (altitude
// along the route, coloured by slope, places marked). Prints the places, counts and the time
// createWorld took.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const seed = Number(args.find((a) => /^\d+$/.test(a)) ?? 417);
const pxArg = args.indexOf('--px');
const MPP = pxArg >= 0 ? Number(args[pxArg + 1]) : 1; // metres per pixel
const VIEW = 860; // half extent drawn

const server = await createServer({
  root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
  server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
let W;
try {
  const mod = await server.ssrLoadModule('/src/world/index.ts');
  const t0 = performance.now();
  const steps = [];
  let last = t0;
  W = mod.createWorld(seed, (p, label) => {
    const now = performance.now();
    steps.push(`${(now - last).toFixed(0).padStart(5)} ms  -> ${label}`);
    last = now;
  });
  const ms = performance.now() - t0;
  console.log(steps.join('\n'));
  console.log(`createWorld(${seed}): ${ms.toFixed(0)} ms`);
} finally {
  await server.close();
}

// ------------------------------------------------------------------------------------------
// raster helpers
// ------------------------------------------------------------------------------------------
const S = Math.round((VIEW * 2) / MPP);
const img = new PNG({ width: S, height: S });
const D = img.data;
const toPx = (x, z) => [Math.round((x + VIEW) / MPP), Math.round((z + VIEW) / MPP)];
function put(px, py, r, g, b, a = 1) {
  if (px < 0 || py < 0 || px >= S || py >= S) return;
  const o = (py * S + px) * 4;
  D[o] = D[o] * (1 - a) + r * a;
  D[o + 1] = D[o + 1] * (1 - a) + g * a;
  D[o + 2] = D[o + 2] * (1 - a) + b * a;
  D[o + 3] = 255;
}
function dot(x, z, rad, c, a = 1) {
  const [cx, cy] = toPx(x, z);
  const r = Math.max(0, rad);
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) if (dx * dx + dy * dy <= r * r + 0.5) put(cx + dx, cy + dy, c[0], c[1], c[2], a);
}
function line(x0, z0, x1, z1, c, w = 1, a = 1) {
  const [ax, ay] = toPx(x0, z0), [bx, by] = toPx(x1, z1);
  const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay), 1);
  for (let i = 0; i <= n; i++) {
    const px = Math.round(ax + ((bx - ax) * i) / n), py = Math.round(ay + ((by - ay) * i) / n);
    for (let dy = -Math.floor(w / 2); dy <= Math.floor((w - 1) / 2); dy++) for (let dx = -Math.floor(w / 2); dx <= Math.floor((w - 1) / 2); dx++) put(px + dx, py + dy, c[0], c[1], c[2], a);
  }
}
// 5x7 font, rows top to bottom, 5 bits each
const FONT = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31], 0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
  ' ': [0, 0, 0, 0, 0, 0, 0], '-': [0, 0, 0, 31, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ':': [0, 12, 12, 0, 12, 12, 0],
  '/': [1, 1, 2, 4, 8, 16, 16], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '%': [24, 25, 2, 4, 8, 19, 3],
};
function text(px, py, s, c, scale = 2, bg = [20, 20, 24]) {
  s = String(s).toUpperCase();
  const w = s.length * 6 * scale;
  for (let y = -2; y < 7 * scale + 2; y++) for (let x = -2; x < w + 1; x++) put(px + x, py + y, bg[0], bg[1], bg[2], 0.55);
  for (let i = 0; i < s.length; i++) {
    const g = FONT[s[i]] ?? FONT[' '];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (g[row] & (16 >> col))
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(px + i * 6 * scale + col * scale + sx, py + row * scale + sy, c[0], c[1], c[2]);
  }
}

// ------------------------------------------------------------------------------------------
// relief
// ------------------------------------------------------------------------------------------
const hm = W.heightmap, N = hm.n, EXT = hm.extent, H = hm.data, M = W.masks.data;
const hAt = (x, z) => W.heightAt(x, z);
const mAt = (ch, x, z) => {
  const i = Math.max(0, Math.min(N - 1, Math.round((x + EXT) / 2))), j = Math.max(0, Math.min(N - 1, Math.round((z + EXT) / 2)));
  return M[(j * N + i) * 4 + ch] / 255;
};
const lightX = -0.55, lightY = 0.62, lightZ = -0.56;
for (let py = 0; py < S; py++) {
  for (let px = 0; px < S; px++) {
    const x = -VIEW + px * MPP, z = -VIEW + py * MPP;
    const e = Math.max(MPP, 2);
    const hc = hAt(x, z);
    const gx = (hAt(x + e, z) - hAt(x - e, z)) / (2 * e), gz = (hAt(x, z + e) - hAt(x, z - e)) / (2 * e);
    const nl = Math.sqrt(gx * gx + 1 + gz * gz);
    const shade = Math.max(0, (-gx * lightX + lightY - gz * lightZ) / nl);
    const slope = (Math.atan(Math.sqrt(gx * gx + gz * gz)) * 180) / Math.PI;
    // base: snow, cooler and greyer with height
    const t = Math.min(1, Math.max(0, (hc - 60) / 520));
    let r = 226 - 26 * t, g = 230 - 20 * t, b = 236 - 6 * t;
    // forest
    const f = mAt(0, x, z);
    r += (52 - r) * f * 0.62; g += (78 - g) * f * 0.62; b += (60 - b) * f * 0.62;
    // rock
    const rk = mAt(1, x, z);
    r += (96 - r) * rk * 0.85; g += (92 - g) * rk * 0.85; b += (90 - b) * rk * 0.85;
    // slope tint beyond walkable
    if (slope > 40) { r = r * 0.7 + 60; g = g * 0.6 + 30; b = b * 0.6 + 30; }
    else if (slope > 30) { r = r * 0.85 + 30; g = g * 0.85 + 20; b = b * 0.9; }
    // trail
    const tr = mAt(3, x, z);
    r += (200 - r) * tr * 0.35; g += (170 - g) * tr * 0.35; b += (120 - b) * tr * 0.35;
    // lake and ice thickness
    const ice = W.iceAt(x, z);
    if (ice > 0) {
      const k = Math.min(1, ice / 0.6);
      r = 60 + 150 * k; g = 90 + 130 * k; b = 140 + 100 * k;
      if (ice < 0.12) { r = 40; g = 55; b = 95; }
    }
    let k = 0.42 + 0.78 * shade;
    // contours
    const c10 = Math.floor(hc / 10), c10x = Math.floor(hAt(x + MPP, z) / 10), c10z = Math.floor(hAt(x, z + MPP) / 10);
    if (ice <= 0 && (c10 !== c10x || c10 !== c10z)) {
      const major = Math.floor(hc / 50) !== Math.floor(hAt(x + MPP, z) / 50) || Math.floor(hc / 50) !== Math.floor(hAt(x, z + MPP) / 50);
      k *= major ? 0.62 : 0.86;
    }
    put(px, py, Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k));
  }
}
// playable edge
line(-800, -800, 800, -800, [200, 40, 40]); line(800, -800, 800, 800, [200, 40, 40]);
line(800, 800, -800, 800, [200, 40, 40]); line(-800, 800, -800, -800, [200, 40, 40]);

// trees, rocks, props
for (const t of W.trees) {
  const c = t.kind === 'snag' ? [120, 95, 70] : t.kind === 'sapling' ? [70, 110, 80] : t.kind === 'fir' ? [18, 52, 40] : [24, 62, 34];
  dot(t.x, t.z, t.kind === 'sapling' ? 0 : Math.min(1.5, (t.scale * 1.6) / MPP), c, 0.85);
}
for (const r of W.rocks) dot(r.x, r.z, Math.max(0.5, Math.max(r.sx, r.sz) / MPP), [70, 66, 64], 0.9);
for (const p of W.props) {
  const big = ['fuselage', 'tail_section', 'cabin', 'cave_rocks', 'tower_mast', 'tower_shed', 'fishing_hut', 'wing'].includes(p.model);
  const c = p.model === 'trail_marker' ? [255, 200, 30] : p.model === 'fence_post' || p.model === 'sign_post' ? [150, 100, 40] : [230, 110, 40];
  dot(p.x, p.z, big ? 3 : p.model === 'trail_marker' ? 1.6 : 1.2, c, 1);
}
// colliders of structures (outline boxes)
for (const p of W.props) {
  const near = [];
  W.collidersNear(p.x, p.z, 0.5, near);
}
// route
for (let i = 1; i < W.route.length; i++) line(W.route[i - 1].x, W.route[i - 1].z, W.route[i].x, W.route[i].z, [210, 30, 40], 2, 0.9);
// spawn defs
const colorOf = (d) => {
  if (d.kind === 'pickup') {
    if (d.item.startsWith('part_')) return [255, 0, 255];
    if (d.item === 'stick') return [150, 90, 40];
    if (d.item === 'ammo' || d.item === 'rifle') return [255, 60, 60];
    if (d.item === 'flare' || d.item === 'flaregun') return [255, 120, 0];
    if (d.item === 'matches' || d.item === 'tinder') return [255, 220, 0];
    return [80, 200, 255];
  }
  if (d.kind === 'crate') return [0, 200, 120];
  if (d.kind === 'wood') return [110, 60, 20];
  if (d.kind === 'log') return [200, 140, 60];
  if (d.kind === 'fire') return [255, 80, 0];
  return [255, 255, 255];
};
for (const d of W.spawn.defs) dot(d.x, d.z, d.kind === 'pickup' && d.item === 'stick' ? 1 : 1.8, colorOf(d), 1);
for (const p of W.spawn.players) dot(p.x, p.z, 1.5, [0, 120, 255], 1);
for (const pk of W.spawn.packs) {
  for (let a = 0; a < 360; a += 2) dot(pk.x + pk.range * Math.cos((a * Math.PI) / 180), pk.z + pk.range * Math.sin((a * Math.PI) / 180), 0.6, [120, 20, 20], 0.5);
  text(toPx(pk.x, pk.z)[0] - 20, toPx(pk.x, pk.z)[1] - 6, 'WOLVES ' + Math.round(pk.wakeAt / 60) + 'M', [255, 140, 140], 1);
}
// places
for (const p of W.pois) {
  if (p.id === 'lake') continue;
  const [px, py] = toPx(p.x, p.z);
  for (let a = 0; a < 360; a += 1) put(Math.round(px + (p.radius / MPP) * Math.cos(a * Math.PI / 180)), Math.round(py + (p.radius / MPP) * Math.sin(a * Math.PI / 180)), 255, 255, 255, 0.5);
  text(px + 8, py - 18, `${p.name} ${Math.round(p.y)}M`, [255, 255, 255], 2);
}
const lk = W.poi('lake');
text(toPx(lk.x, lk.z)[0] - 70, toPx(lk.x, lk.z)[1] + 30, `${lk.name} ${Math.round(lk.y)}M`, [220, 240, 255], 2);
text(10, 10, `COLD SIGNAL  SEED ${seed}  ROUTE ${Math.round(W.stats.routeLength)}M  TREES ${W.trees.length}  ROCKS ${W.rocks.length}  PROPS ${W.props.length}  DEFS ${W.spawn.defs.length}`, [255, 255, 255], 2);
fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
fs.writeFileSync(path.join(root, 'shots', 'world_map.png'), PNG.sync.write(img));

// ------------------------------------------------------------------------------------------
// profile along the route
// ------------------------------------------------------------------------------------------
const PW = 1800, PH = 520, PAD = 50;
const prof = new PNG({ width: PW, height: PH });
for (let i = 0; i < prof.data.length; i += 4) { prof.data[i] = 24; prof.data[i + 1] = 26; prof.data[i + 2] = 30; prof.data[i + 3] = 255; }
const samples = [];
let dist = 0;
let maxSlope = 0, maxAt = null, notWalk = 0;
for (let i = 1; i < W.route.length; i++) {
  const a = W.route[i - 1], b = W.route[i];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  for (let s = 0; s < len; s += 1) {
    const x = a.x + ((b.x - a.x) * s) / len, z = a.z + ((b.z - a.z) * s) / len;
    const sl = W.slopeAt(x, z) * 90;
    if (sl > maxSlope) { maxSlope = sl; maxAt = [x, z]; }
    if (!W.walkable(x, z)) notWalk++;
    samples.push({ d: dist + s, h: W.groundAt(x, z, 1e4).y, sl });
  }
  dist += len;
}
const hmin = Math.min(...samples.map((s) => s.h)) - 10, hmax = Math.max(...samples.map((s) => s.h)) + 10;
const PX = (d) => PAD + ((PW - 2 * PAD) * d) / dist, PY = (h) => PH - PAD - ((PH - 2 * PAD) * (h - hmin)) / (hmax - hmin);
const pput = (x, y, c) => {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= PW || y >= PH) return;
  const o = (y * PW + x) * 4;
  prof.data[o] = c[0]; prof.data[o + 1] = c[1]; prof.data[o + 2] = c[2];
};
for (let hh = Math.ceil(hmin / 50) * 50; hh < hmax; hh += 50) for (let x = PAD; x < PW - PAD; x += 3) pput(x, PY(hh), [60, 64, 70]);
for (const s of samples) {
  const c = s.sl < 20 ? [120, 200, 120] : s.sl < 30 ? [230, 200, 80] : [240, 70, 60];
  for (let y = PY(s.h); y < PH - PAD; y += 1) pput(PX(s.d), y, [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25]);
  pput(PX(s.d), PY(s.h), c);
  pput(PX(s.d), PY(s.h) - 1, c);
}
// place marks
{
  let dd = 0;
  for (let i = 0; i < W.route.length; i++) {
    if (i > 0) dd += Math.hypot(W.route[i].x - W.route[i - 1].x, W.route[i].z - W.route[i - 1].z);
    const p = W.route[i].poi;
    if (!p) continue;
    const x = PX(dd), y = PY(W.groundAt(W.route[i].x, W.route[i].z, 1e4).y);
    for (let yy = y - 30; yy < y; yy++) pput(x, yy, [255, 255, 255]);
    const P = { width: PW, height: PH, data: prof.data };
    // label
    const s = p.toUpperCase();
    for (let ci = 0; ci < s.length; ci++) {
      const g = FONT[s[ci]] ?? FONT[' '];
      for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (g[row] & (16 >> col))
        for (let q = 0; q < 2; q++) for (let r2 = 0; r2 < 2; r2++) pput(x + 3 + ci * 12 + col * 2 + q, y - 46 + row * 2 + r2, [255, 255, 255]);
    }
    void P;
  }
}
fs.writeFileSync(path.join(root, 'shots', 'world_profile.png'), PNG.sync.write(prof));

console.log('places:');
for (const p of W.pois) console.log(`  ${p.id.padEnd(6)} (${p.x.toFixed(0)}, ${p.z.toFixed(0)})  alt ${p.y.toFixed(1)} m  slope ${(W.slopeAt(p.x, p.z) * 90).toFixed(1)} deg`);
console.log(`route ${W.route.length} waypoints, ${dist.toFixed(0)} m, max slope ${maxSlope.toFixed(1)} deg at ${maxAt && maxAt.map((v) => v.toFixed(0)).join(',')}, not walkable at ${notWalk} of ${samples.length} 1 m steps`);
console.log(`trees ${W.trees.length} (${['pine', 'fir', 'snag', 'sapling'].map((k) => k + ' ' + W.trees.filter((t) => t.kind === k).length).join(', ')}), rocks ${W.rocks.length}, props ${W.props.length}, colliders ${W.stats.colliders}, defs ${W.spawn.defs.length}`);
const count = (f) => W.spawn.defs.filter(f).length;
const sum = (it) => W.spawn.defs.reduce((a, d) => a + (d.kind === 'pickup' && d.item === it ? d.n : 0) + (d.kind === 'crate' ? d.loot.filter((l) => l.item === it).reduce((s, l) => s + l.n, 0) : 0), 0);
console.log(`sticks ${count((d) => d.kind === 'pickup' && d.item === 'stick')}, wood ${count((d) => d.kind === 'wood')}, logs ${count((d) => d.kind === 'log')}, matches ${sum('matches')}, ammo ${sum('ammo')}, flares ${sum('flare')}`);
console.log('wrote shots/world_map.png and shots/world_profile.png');
