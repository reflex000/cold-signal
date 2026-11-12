// Render the score offline in headless Chrome and look at it.
//
//   node tools/music-check.mjs [--moods title,calm] [--secs 60] [--intensity 0.5] [--wav 1]
//                              [--only moods|journeys|all]
//
// For every mood: 60 s through an OfflineAudioContext with the conductor's real update loop,
// then peak, RMS, the fraction of silence and the note count, and a picture in shots/
// (music_<mood>.png: the notes each player was given, over a log-frequency spectrogram).
// Then three journeys that change mood and intensity on the way, to see the cross-fades:
// music_journey.png, music_journey_holdout.png, music_journey_attack.png.
// --wav 1 also writes shots/music_<name>.wav to listen to.
//
// Each row also gives where the energy sits (low = below 250 Hz, body = 250-800 Hz, bright =
// above 2.5 kHz, as shares of the total) and the most notes written to sound at once.
//
// Exit code 1 when anything clips, exceeds the level the score is meant to sit at, is too quiet
// to be heard under the wind, is silent when it should not be, leaves too little silence in the
// sparse moods (calm, night), or the page logs an error.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, root } from './serve.mjs';
import { launch } from './pw.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : '1';
}
const secs = Number(args.secs || 60);
const intensity = Number(args.intensity || 0.5);
const wav = args.wav === '1';
const only = args.only || (args.moods ? 'moods' : 'all');

/** The score should peak near -14 dBFS (where the mixer's ceiling starts to bend); it stops at -10.5. */
const PEAK_MAX_DB = -12.5;
/** Quieter than this at its peak, a mood is lost under the wind. */
const PEAK_MIN_DB = -32;
/** calm and night: most of the time is silence. */
const SPARSE = { calm: 0.6, night: 0.6 };

const JOURNEYS = [
  {
    name: 'journey',
    secs: 200,
    cues: [
      { t: 0, mood: 'calm', intensity: 0.5 },
      { t: 22, mood: 'cold', intensity: 0.5 },
      { t: 50, mood: 'stalked', intensity: 0.4 },
      { t: 72, mood: 'stalked', intensity: 0.8 },
      { t: 86, mood: 'attack', intensity: 0.8 },
      { t: 104, mood: 'calm', intensity: 0.5 },
      { t: 120, mood: 'whiteout', intensity: 0.6 },
      { t: 160, mood: 'shelter', intensity: 0.5 },
      { t: 190, mood: 'none' },
    ],
  },
  {
    name: 'journey_holdout',
    secs: 140,
    cues: [
      { t: 0, mood: 'holdout', intensity: 0.1 },
      { t: 30, mood: 'holdout', intensity: 0.35 },
      { t: 60, mood: 'holdout', intensity: 0.6 },
      { t: 90, mood: 'holdout', intensity: 1 },
      { t: 122, mood: 'rescue', intensity: 1 },
    ],
  },
  {
    name: 'journey_attack',
    secs: 60,
    cues: [
      { t: 0, mood: 'stalked', intensity: 1 },
      { t: 12, mood: 'attack', intensity: 1 },
      { t: 30, mood: 'stalked', intensity: 0.6 },
      { t: 44, mood: 'death' },
    ],
  },
];

const server = await startServer();
const { browser, page, logs } = await launch({ width: 1280, height: 800 });
const shots = path.join(root, 'shots');
fs.mkdirSync(shots, { recursive: true });
let failed = false;

function save(name, res) {
  const file = path.join(shots, `music_${name}.png`);
  fs.writeFileSync(file, Buffer.from(res.image.split(',')[1], 'base64'));
  if (res.wav) fs.writeFileSync(path.join(shots, `music_${name}.wav`), Buffer.from(res.wav, 'base64'));
  return file;
}

function row(name, r) {
  const players = Object.entries(r.byPlayer)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const pct = (x) => `${Math.round(x * 100)}`.padStart(3) + '%';
  const b = r.bands;
  return (
    name.padEnd(16) +
    `peak ${r.peakDb.toFixed(1).padStart(6)} dBFS  rms ${r.rmsDb.toFixed(1).padStart(6)} dBFS  silence ${pct(r.silence)}  notes ${String(r.notes).padStart(3)}  ` +
    `low ${pct(b.sub + b.low)} body ${pct(b.lowmid)} bright ${pct(b.high + b.air)}  poly ${String(r.poly).padStart(2)}  ` +
    `(${players || 'none'})`
  );
}

function judge(name, r, { mustSound = true, mood = '' } = {}) {
  const bad = [];
  if (r.peak >= 0.999) bad.push('CLIPS');
  if (r.peakDb > PEAK_MAX_DB) bad.push(`peak above ${PEAK_MAX_DB} dBFS`);
  if (mustSound && (r.notes === 0 || r.peakDb < -50)) bad.push('silent');
  else if (mustSound && r.peakDb < PEAK_MIN_DB) bad.push(`peak under ${PEAK_MIN_DB} dBFS: lost under the wind`);
  if (SPARSE[mood] !== undefined && r.silence < SPARSE[mood]) bad.push(`only ${Math.round(r.silence * 100)}% silence, wants ${SPARSE[mood] * 100}%`);
  if (!Number.isFinite(r.rmsDb)) bad.push('not a number');
  if (bad.length) {
    failed = true;
    console.log(`  ^ ${name}: ${bad.join(', ')}`);
  }
}

try {
  await page.goto(`${server.url}/dev/music.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.DONE === true && window.MUSIC, null, { timeout: 60000 });
  const moods = (args.moods ? args.moods.split(',') : await page.evaluate(() => window.MUSIC.moods)).filter((m) => m !== 'none');

  if (only !== 'journeys') {
    console.log(`${secs} s of each mood at intensity ${intensity}`);
    for (const mood of moods) {
      const r = await page.evaluate(([m, s, i, w]) => window.MUSIC.render([{ t: 0, mood: m, intensity: i }], s, { wav: w, title: `${m}  intensity ${i}` }), [mood, secs, intensity, wav]);
      save(mood, r);
      console.log(row(mood, r));
      judge(mood, r, { mood });
    }
    const loud = ['attack', 'holdout', 'rescue', 'tower', 'whiteout', 'stalked'].filter((m) => moods.includes(m));
    if (loud.length) console.log('\nfull intensity (level check only)');
    for (const mood of loud) {
      const r = await page.evaluate(([m, s]) => window.MUSIC.render([{ t: 0, mood: m, intensity: 1 }], s, { title: `${m}  intensity 1` }), [mood, secs]);
      save(mood + '_full', r);
      console.log(row(mood, r));
      judge(mood, r);
    }
  }
  if (only !== 'moods') {
    console.log('\njourneys');
    for (const j of JOURNEYS) {
      const r = await page.evaluate(([c, s, w, n]) => window.MUSIC.render(c, s, { wav: w, title: n }), [j.cues, j.secs, wav, j.name]);
      save(j.name, r);
      console.log(row(j.name, r));
      judge(j.name, r);
    }
  }
  console.log(`\npictures: ${path.join(shots, 'music_*.png')}`);
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
