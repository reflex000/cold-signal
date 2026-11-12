// Screenshot models in the model viewer (dev/models.html) on the real GPU: every requested model
// and seed laid out on snowy ground, seen from one or more views tiled into ONE image.
//
//   node tools/shot-models.mjs --m crate,barrel --seed 1-4 --light dusk --views "30,20;200,35" \
//        --snow 0.8 --out crates_dusk [--backend webgl] [--w 1600 --h 900]
//
//   --m        model names, comma separated; options after colons: campfire:stage=2 (default: all)
//   --seed     1-4 | 3 | 0,2,5          --light  day | dusk | night | storm
//   --views    "az,el;az,el" degrees: az 0 looks at the models' front (+Z), 90 at their +X side
//   --snow     0..1 snow cover          --debug 1   anchors, emitters, lights, part pivots, bounds
//   --open     0..1 hinged parts open   --yaw deg / --scale k   placement of every prop
//   --wind m/s --gust 0..1 --wet 0..1 --exp k --fov deg --zoom k --labels 0 --fire 0
//   --t        seconds on the frozen clock (default 2.5; --t live lets it run)
//   --q        extra query string appended as is ("a=1&b=2")
//   --out      shots/<out>.jpg (default built from the arguments)
//
// Prints the backend, one line per model (triangles, size in metres, anchors, emitters, parts),
// and every console error or warning the page produced. Exit code 1 if the page threw or never
// became ready.
import path from 'node:path';
import fs from 'node:fs';
import { startServer, root } from './serve.mjs';
import { launch } from './pw.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : '1';
}

const backend = args.backend === 'webgl' ? 'webgl' : 'webgpu';
const q = new URLSearchParams();
const pass = ['m', 'seed', 'light', 'views', 'snow', 'debug', 'open', 'yaw', 'scale', 'wind', 'gust', 'wet', 'exp', 'fov', 'zoom', 'labels', 'fire'];
for (const k of pass) if (args[k] !== undefined) q.set(k, args[k]);
if (args.t !== 'live') q.set('t', args.t ?? '2.5');
if (backend === 'webgl') q.set('webgl', '1');
let query = q.toString().replace(/%2C/g, ',').replace(/%3B/g, ';').replace(/%3A/g, ':').replace(/%3D/g, '=');
if (args.q) query += '&' + args.q;

const name = args.out || ['models', args.m || 'all', args.light || 'day', args.snow ? 'snow' + args.snow : '', backend === 'webgl' ? 'gl' : '']
  .filter(Boolean).join('_').replace(/[^a-z0-9_.-]+/gi, '-');

const server = await startServer();
const { browser, page, logs } = await launch({ width: Number(args.w || 1600), height: Number(args.h || 900), backend });
const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });
let failed = false;
try {
  const url = `${server.url}/dev/models.html?${query}`;
  console.log(url.replace(server.url, ''));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DONE === true, null, { timeout: Number(args.timeout || 180000) });
  console.log('backend: ' + (await page.evaluate(() => window.BACKEND || 'unknown')));
  const info = await page.evaluate(() => window.MODEL_INFO || []);
  for (const m of info) {
    const opts = m.opts ? ' ' + Object.entries(m.opts).map(([k, v]) => `${k}=${v}`).join(',') : '';
    const extra = [
      m.anchors.length ? 'anchors ' + m.anchors.join(' ') : '',
      m.emitters.length ? 'emitters ' + m.emitters.join(' ') : '',
      m.parts.length ? 'parts ' + m.parts.join(' ') : '',
      m.lights ? 'lights ' + m.lights : '',
      m.glass ? 'glass' : '',
      m.registered ? '' : 'NOT REGISTERED',
    ].filter(Boolean).join(' | ');
    console.log(`  ${m.name}#${m.seed}${opts}: ${m.tris} tris, ${m.size.join(' x ')} m${extra ? ' | ' + extra : ''}`);
  }
  const hud = await page.evaluate(() => document.getElementById('info')?.textContent || '');
  if (hud) console.log('  ' + hud.split('\n').join('\n  '));
  const file = path.join(shots, name + '.jpg');
  await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
  console.log(file);
} catch (e) {
  failed = true;
  console.log('FAILED: ' + (e && e.stack ? e.stack : e));
} finally {
  const bad = logs.filter((l) => /^\[(error|warning|pageerror)\]/.test(l));
  if (bad.length) {
    console.log('PAGE LOG:');
    for (const l of bad.slice(0, 40)) console.log('  ' + l.slice(0, 1500));
    if (bad.some((l) => l.startsWith('[pageerror]'))) failed = true;
  }
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
