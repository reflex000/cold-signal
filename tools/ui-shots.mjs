// Shoot every interface screen from the UI bench (dev/ui.html) at 1600 x 900, 1280 x 720 and on
// a phone in landscape (844 x 390, touch controls), into shots/ui_<screen>_<size>.jpg.
//
//   node tools/ui-shots.mjs [--only play,pack] [--sizes 1600,1280,phone,4k]
//
// Every capture uses ?still=1 (fake values frozen, transitions off), so runs are comparable.
// Prints one line per file and every console error / warning a page produced; exit code 1 if
// any page threw or never became ready.
import path from 'node:path';
import fs from 'node:fs';
import { startServer, root } from './serve.mjs';
import { launch } from './pw.mjs';

const SCREENS = [
  ['boot', 'mode=boot'],
  ['title', 'mode=title'],
  ['title_settings', 'mode=title&page=settings'],
  ['calm', 'mode=play&held=axe&hint=0&age=30'],
  ['play', 'mode=play&team=3&focus=1&toasts=1&cold=0.35'],
  ['cold', 'mode=play&cold=0.62&hurt=0.4&held=radio&team=1&wet=0.3'],
  ['severe', 'mode=play&cold=1&hurt=0.75&held=flashlight&hint=0'],
  ['storm', 'mode=play&storm=1&cold=0.45&held=rifle&team=2&toasts=1'],
  ['fire', 'mode=play&fire=1&team=2&held=axe&wet=0.3&focus=1'],
  ['night', 'mode=play&bg=night&team=2&held=flashlight&cold=0.2'],
  ['downed', 'mode=play&down=1&team=3'],
  ['pause', 'mode=pause'],
  ['settings', 'mode=pause&page=settings'],
  ['controls', 'mode=pause&page=controls'],
  ['howto', 'mode=pause&page=how'],
  ['pack', 'mode=inventory&team=1'],
  ['pack_ammo', 'mode=inventory&sel=ammo'],
  ['map', 'mode=inventory&page=map&team=2'],
  ['dead', 'mode=dead&cause=wolf'],
  ['won', 'mode=won'],
];
const SIZES = {
  1600: { w: 1600, h: 900, mobile: false },
  1280: { w: 1280, h: 720, mobile: false },
  phone: { w: 844, h: 390, mobile: true },
  '4k': { w: 3840, h: 2160, mobile: false },
};

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1';
}
const only = args.only ? new Set(args.only.split(',')) : null;
const sizes = (args.sizes || '1600,1280,phone').split(',').filter((s) => SIZES[s]);

const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });
const server = await startServer();
let failed = false;
try {
  for (const sz of sizes) {
    const S = SIZES[sz];
    const { browser, page, logs } = await launch({ width: S.w, height: S.h, mobile: S.mobile, backend: S.mobile ? 'webgl' : 'webgpu' });
    const list = SCREENS.filter(([n]) => !only || only.has(n));
    if (S.mobile && (!only || only.has('rotate'))) list.push(['rotate', 'mode=play', { width: 390, height: 844 }]);
    for (const [name, query, viewport] of list) {
      const from = logs.length;
      const q = `${query}&still=1${S.mobile ? '&touch=1&webgl=1' : ''}`;
      try {
        await page.setViewportSize(viewport || { width: S.w, height: S.h });
        await page.goto(`${server.url}/dev/ui.html?${q}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.DONE === true, null, { timeout: 30000 });
        const file = path.join(shots, `ui_${name}_${sz}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
        console.log(path.relative(root, file));
      } catch (e) {
        failed = true;
        console.log(`FAILED ${name} ${sz}: ${e && e.message ? e.message : e}`);
      }
      const bad = logs.slice(from).filter((l) => /^\[(error|warning|pageerror)\]/.test(l));
      for (const l of bad.slice(0, 10)) console.log(`  ${name}/${sz}: ${l.slice(0, 400)}`);
      if (bad.some((l) => l.startsWith('[pageerror]'))) failed = true;
    }
    await browser.close();
  }
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
