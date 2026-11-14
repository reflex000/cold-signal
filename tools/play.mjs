// Drive the real game in headless Chrome on the real GPU with a scenario script.
//
//   node tools/play.mjs tools/scenarios/<name>.mjs [--q high] [--backend webgl] [--mobile 1]
//                       [--w 1600 --h 900] [--live 1] [--query "extra=params"] [--timeout ms]
//                       [--dist 1]   (the production build in dist/, served by vite preview)
//
// Opens the game with ?still=1&dev=1&skipTitle=1 (no real-time loop: the scenario steps it through
// window.CS; --live 1 runs the real loop instead), waits for CS.ready, then runs the scenario's
// default export with { page, ev, step, shot, sheet, log, args, check, sleep }:
//   ev(fn, arg)        page.evaluate
//   step(n, dt)        CS.step(n, dt) -> CS.stats()
//   shot(name, o)      waits for the frame, writes shots/<name>.jpg; o.sheet keeps a thumbnail
//   sheet(name, cols)  writes the thumbnails kept under that name as shots/<name>.png
//   log(...)           prints a line
//   check(cond, msg)   records a failure (the run exits 1) without stopping
//   sleep(ms)          real-time wait (live runs)
// A scenario may export `query` (extra URL parameters) and `live` (true: real-time loop).
// Prints CS.stats() and every page error / warning; exits non-zero on failure.
// The run never reads or writes the player's save or settings (?nosave=1&fresh=1).
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { startServer, root } from './serve.mjs';
import { launch } from './pw.mjs';

const args = { _: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1';
  else args._.push(a);
}
if (!args._[0]) {
  console.log('usage: node tools/play.mjs tools/scenarios/<name>.mjs [--q high] [--backend webgl] [--mobile 1] [--w 1600 --h 900] [--live 1] [--query "a=b"]');
  process.exit(1);
}

const scenarioFile = path.resolve(args._[0]);
const mod = await import(pathToFileURL(scenarioFile).href);
const scenario = mod.default;
if (typeof scenario !== 'function') {
  console.log('the scenario has no default export function: ' + scenarioFile);
  process.exit(1);
}
const mobile = args.mobile === '1';
const backend = args.backend || (mobile ? 'webgl' : 'webgpu');
const live = args.live === '1' || mod.live === true;
const name = path.basename(scenarioFile, '.mjs');

// `bare` scenarios open the page as a player would (no tool parameters, no window.CS)
const bare = mod.bare === true;
const q = new URLSearchParams(bare ? '' : live ? 'dev=1&skipTitle=1&nosave=1&fresh=1' : 'still=1&dev=1&skipTitle=1&nosave=1&fresh=1');
if (args.q) q.set('q', args.q);
if (backend === 'webgl') q.set('webgl', '1');
for (const extra of [mod.query, args.query]) {
  if (!extra) continue;
  for (const [k, v] of new URLSearchParams(extra)) q.set(k, v);
}

const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });
// --dist 1: the production build (npm run build) served as it would be deployed
async function previewServer() {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('no dist/: run npm run build first');
  const { preview } = await import('vite');
  const srv = await preview({ root, configFile: path.join(root, 'vite.config.ts'), logLevel: 'error', preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false } });
  const url = (srv.resolvedUrls?.local?.[0] || '').replace(/\/$/, '');
  return { url, close: () => srv.close() };
}
const server = args.dist === '1' ? await previewServer() : await startServer();
const { browser, page, logs } = await launch({
  width: Number(args.w || 1600),
  height: Number(args.h || 900),
  backend,
  mobile,
});

const failures = [];
const t0 = Date.now();
const log = (...a) => console.log('  ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
const ev = (fn, arg) => page.evaluate(fn, arg);
const step = (n = 1, dt = 1 / 30) => page.evaluate(([n, dt]) => window.CS.step(n, dt), [n, dt]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// contact sheets: shot(name, { sheet: 'tour_dusk', label }) also keeps a quarter-size thumbnail;
// sheet('tour_dusk') writes shots/tour_dusk.png with every thumbnail in a grid
const sheets = new Map();
const shot = async (shotName, o = {}) => {
  await page.evaluate(() =>
    window.CS ? window.CS.shotReady() : new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const file = path.join(shots, shotName + '.jpg');
  // (a loaded machine can take a while to hand over a frame: more than playwright's default 30 s)
  await page.screenshot({ path: file, type: 'jpeg', quality: 88, timeout: 180000 });
  console.log('  shot ' + path.relative(root, file));
  if (o.sheet) {
    const png = PNG.sync.read(await page.screenshot({ type: 'png', timeout: 180000 }));
    const k = Number(o.scale || 4);
    const w = Math.floor(png.width / k), h = Math.floor(png.height / k);
    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            const i = ((y * k + dy) * png.width + (x * k + dx)) * 4;
            r += png.data[i];
            g += png.data[i + 1];
            b += png.data[i + 2];
          }
        }
        const j = (y * w + x) * 4, n = k * k;
        out.data[j] = r / n;
        out.data[j + 1] = g / n;
        out.data[j + 2] = b / n;
        out.data[j + 3] = 255;
      }
    }
    if (!sheets.has(o.sheet)) sheets.set(o.sheet, []);
    sheets.get(o.sheet).push(out);
  }
  return file;
};
const sheet = (sheetName, cols = 4) => {
  const list = sheets.get(sheetName) || [];
  if (!list.length) return null;
  const w = list[0].width, h = list[0].height, gap = 4;
  const rows = Math.ceil(list.length / cols);
  const out = new PNG({ width: cols * w + (cols - 1) * gap, height: rows * h + (rows - 1) * gap });
  out.data.fill(0);
  list.forEach((img, n) => {
    const ox = (n % cols) * (w + gap), oy = Math.floor(n / cols) * (h + gap);
    for (let y = 0; y < h; y++) img.data.copy(out.data, ((oy + y) * out.width + ox) * 4, y * w * 4, (y + 1) * w * 4);
  });
  const file = path.join(shots, sheetName + '.png');
  fs.writeFileSync(file, PNG.sync.write(out));
  console.log('  sheet ' + path.relative(root, file) + ` (${list.length} shots)`);
  return file;
};
const check = (cond, msg) => {
  if (cond) console.log('  ok   ' + msg);
  else {
    console.log('  FAIL ' + msg);
    failures.push(msg);
  }
  return !!cond;
};

let crashed = false;
try {
  const url = `${server.url}/?${q.toString()}`;
  console.log(`${name}: ${url} (${backend}${mobile ? ', mobile' : ''}${live ? ', live' : ''})`);
  // (the page's own load gets the same allowance as the boot: a loaded machine serves the dev modules slowly)
  await page.goto(url, { waitUntil: 'load', timeout: Number(args.timeout || 240000) });
  if (bare) {
    await page.waitForFunction(() => window.DONE === true, null, { timeout: Number(args.timeout || 240000) });
    console.log(`  ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${await page.evaluate(() => window.BACKEND)}`);
  } else {
    await page.waitForFunction(() => window.DONE === true && !!window.CS, null, { timeout: Number(args.timeout || 240000) });
    await page.evaluate(() => window.CS.ready);
    const boot = await page.evaluate(() => window.CS.stats());
    console.log(`  ready in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${boot.backend} ${boot.quality} ${boot.width}x${boot.height}, visuals ${JSON.stringify(boot.visuals)}`);
    if (boot.error) throw new Error('boot failed: ' + boot.error);
  }
  await scenario({ page, ev, step, shot, sheet, log, args, check, sleep, url, backend, mobile, live });
} catch (e) {
  crashed = true;
  console.log('FAILED: ' + (e && e.stack ? e.stack : e));
} finally {
  try {
    const s = await page.evaluate(() => (window.CS ? window.CS.stats() : null));
    if (s) console.log('STATS ' + JSON.stringify(s));
  } catch {
    /* the page is gone */
  }
  const bad = logs.filter((l) => /^\[(error|warning|pageerror)\]/.test(l));
  if (bad.length) {
    console.log(`PAGE LOG (${bad.length} errors / warnings):`);
    for (const l of bad.slice(0, 40)) console.log('  ' + l.slice(0, 1200));
  } else console.log('PAGE LOG: clean');
  await browser.close();
  await server.close();
  const pageErr = bad.some((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
  const ok = !crashed && failures.length === 0 && !pageErr;
  console.log(`${name}: ${ok ? 'PASS' : 'FAIL'}${failures.length ? ' (' + failures.length + ' checks failed)' : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(ok ? 0 : 1);
}
