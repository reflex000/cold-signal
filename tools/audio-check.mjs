// Render every sound offline in headless Chrome, measure it, and draw it so it can be looked at.
//
//   node tools/audio-check.mjs [--only sfx,loop,step,scene,stress] [--names id1,id2,...]
//                              [--lite 1] [--dry 1] [--wav 1] [--seed 4170] [--sheets 0]
//
// Each check renders through the game's own graph (src/audio/check.ts, hosted by dev/audio.html):
// every one-shot (plus far variants and the internal sounds the ambience plays), every loop with
// its param swept, six footsteps per surface, the listening scenes, and a stress test of twenty-odd
// voices over a storm. For each it prints the audible duration, master peak, raw peak (before the
// master dynamics), RMS over the audible part, the loudest 50 ms, the spectral centroid and flags,
// and writes shots/audio/<id>.png (level over time above a log-frequency spectrogram) and contact
// sheets shots/audio_sheet_<n>.png with many sounds per picture.
// --wav 1 also writes shots/audio/<id>.wav to listen to. --lite 1 renders the phone profile.
// --dry 1 mutes the reverb returns, to measure the voices alone.
//
// Flags: SILENT, CLIP and NAN fail (exit code 1), as does any page error. Warnings: LIMIT (samples
// held at the limiter's ceiling), HOT (raw bus over full scale), DC, CUT (still sounding when the
// render ended), QUIET (peak under -42 dBFS).
import fs from 'node:fs';
import path from 'node:path';
import { startServer, root } from './serve.mjs';
import { launch } from './pw.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1';
}
const only = args.only ? new Set(args.only.split(',')) : null;
const names = args.names ? new Set(args.names.split(',')) : null;
const opts = { lite: args.lite === '1', wav: args.wav === '1', seed: Number(args.seed || 4170), dry: args.dry === '1' };
const sheets = args.sheets !== '0';

const server = await startServer();
const { browser, page, logs } = await launch({ width: 1280, height: 800 });
// variants keep their own pictures: shots/audio, shots/audio_dry, shots/audio_lite
const suffix = (opts.dry ? '_dry' : '') + (opts.lite ? '_lite' : '');
const outDir = path.join(root, 'shots', 'audio' + suffix);
fs.mkdirSync(outDir, { recursive: true });
let failed = false;
const t0 = Date.now();

const fmtHz = (c) => (c < 1000 ? `${c.toFixed(0)} Hz` : `${(c / 1000).toFixed(2)} kHz`);
const num = (v, w = 6) => (v <= -199 ? '  -inf' : v.toFixed(1)).padStart(w);
function row(r) {
  return (
    r.id.padEnd(22) +
    `${r.dur.toFixed(2).padStart(6)} s ` +
    `pk ${num(r.peakDb)} raw ${num(r.rawPeakDb)} rms ${num(r.rmsDb)} 50ms ${num(r.rms50Db)}  ` +
    `${fmtHz(r.centroid).padStart(9)}` +
    (r.voicesMax > 1 ? `  v${r.voicesMax}` : '') +
    (r.flags.length ? `  ${r.flags.join(' ')}` : '')
  );
}

try {
  await page.goto(`${server.url}/dev/audio.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DONE === true && window.AUDIO_CHECK, null, { timeout: 60000 });
  let list = await page.evaluate(() => window.AUDIO_CHECK.list());
  if (only) list = list.filter((s) => only.has(s.kind));
  if (names) list = list.filter((s) => names.has(s.id) || names.has(s.name));
  console.log(`${list.length} checks${opts.lite ? ' (phone profile)' : ''}; levels in dBFS; raw = before the master dynamics`);
  const done = [];
  let kind = '';
  for (const spec of list) {
    if (spec.kind !== kind) {
      kind = spec.kind;
      console.log(`-- ${kind}`);
    }
    const r = await page.evaluate(([s, o]) => window.AUDIO_CHECK.render(s, o), [spec, opts]);
    fs.writeFileSync(path.join(outDir, `${r.id}.png`), Buffer.from(r.image.split(',')[1], 'base64'));
    if (r.wav) fs.writeFileSync(path.join(outDir, `${r.id}.wav`), Buffer.from(r.wav, 'base64'));
    console.log(row(r));
    if (r.fail) failed = true;
    done.push(r);
  }
  if (sheets && done.length) {
    // one picture per group of up to 24, in list order, never mixing kinds
    const groups = [];
    for (const r of done) {
      const g = groups[groups.length - 1];
      const k = r.kind === 'loop' || r.kind === 'step' ? 'loops and steps' : r.kind === 'scene' || r.kind === 'stress' ? 'scenes' : r.kind;
      if (g && g.k === k && g.ids.length < 24) g.ids.push(r.id);
      else groups.push({ k, ids: [r.id] });
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const head = `${g.k} ${i + 1}/${groups.length}${opts.lite ? '  (phone profile)' : ''}  spectrogram: 84 dB under each sound's loudest bin, 30 Hz to 20 kHz; strip: master peak, amber = raw bus`;
      const url = await page.evaluate(([ids, h]) => window.AUDIO_CHECK.sheet(ids, h), [g.ids, head]);
      const file = path.join(root, 'shots', `audio_sheet_${i + 1}${suffix}.png`);
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      console.log(`sheet ${file} (${g.ids.length})`);
    }
  }
  const bad = done.filter((r) => r.fail);
  const warn = done.filter((r) => !r.fail && r.flags.length);
  console.log(`\n${done.length} rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${bad.length} failed, ${warn.length} with warnings. Pictures: ${outDir}`);
} catch (e) {
  failed = true;
  console.log('FAILED: ' + (e && e.stack ? e.stack : e));
} finally {
  const bad = logs.filter((l) => /^\[(error|warning|pageerror)\]/.test(l));
  if (bad.length) {
    failed = true;
    console.log('PAGE LOG:');
    for (const l of bad.slice(0, 40)) console.log('  ' + l.slice(0, 1500));
  }
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
