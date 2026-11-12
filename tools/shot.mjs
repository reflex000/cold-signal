// Open any page of the project in headless Chrome on the real GPU, wait until it says it is
// ready, and save a screenshot to shots/. Bench pages under dev/ use this.
//
//   node tools/shot.mjs <path-with-query> [--out name] [--w 1600] [--h 900] [--backend webgl]
//                       [--mobile 1] [--wait ms] [--eval "js run in the page before the shot"]
//
// The page signals readiness by setting `window.DONE = true` (after its frame is on screen).
// Prints the output path and every console error / warning the page produced. Exit code 1 if
// the page threw or never became ready.
import path from 'node:path';
import fs from 'node:fs';
import { startServer, root } from './serve.mjs';
import { launch } from './pw.mjs';

const args = { _: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1';
  else args._.push(a);
}
if (!args._[0]) {
  console.log('usage: node tools/shot.mjs <path?query> [--out name] [--w 1600] [--h 900] [--backend webgl] [--mobile 1]');
  process.exit(1);
}
const mobile = args.mobile === '1';
const server = await startServer();
const { browser, page, logs } = await launch({
  width: Number(args.w || 1600),
  height: Number(args.h || 900),
  backend: args.backend || (mobile ? 'webgl' : 'webgpu'),
  mobile,
});
const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });
let failed = false;
try {
  let target = args._[0].replace(/^\//, '');
  // Chrome keeps navigator.gpu even when asked not to, so the WebGL2 path is forced by the page:
  // every page honours `?webgl=1` (WebGPURenderer { forceWebGL: true }).
  const wantGL = (args.backend || (mobile ? 'webgl' : 'webgpu')) === 'webgl';
  if (wantGL && !/[?&]webgl=/.test(target)) target += (target.includes('?') ? '&' : '?') + 'webgl=1';
  await page.goto(`${server.url}/${target}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DONE === true, null, { timeout: Number(args.timeout || 120000) });
  if (args.eval) await page.evaluate(args.eval);
  if (args.wait) await page.waitForTimeout(Number(args.wait));
  const name = args.out || target.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  console.log('backend: ' + (await page.evaluate(() => window.BACKEND || 'unknown')));
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
