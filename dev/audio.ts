// Bench page for the sound (dev/audio.html): a button for every one-shot, loop and footstep,
// sliders for every ambience field, whole scenes in one click, the score's moods, the mix.
// It uses createAudio() exactly as the game does.
//
// It also hosts the offline checker: window.AUDIO_CHECK = { list, render, sheet } (src/audio/check.ts),
// which tools/audio-check.mjs drives.
//
//   ?auto=1   start at once (headless Chrome runs with autoplay allowed), play the 'stalked' scene
//             with footsteps and one-shots through the live path for a few seconds, suspend and
//             resume, then report window.AUDIO_LIVE = { ready, state, peak, rms, voices }
//   node tools/shot.mjs "dev/audio.html?auto=1" --out audio_bench
import type { Ambience, LoopHandle, LoopName, MusicMood, SfxName } from '../src/audio/api';
import { AMBIENCE_DEFAULT } from '../src/audio/ambience';
import { checkList, contactSheet, renderCheck } from '../src/audio/check';
import { LOOP_NAMES, SFX_NAMES, STEP_NAMES, createAudio } from '../src/audio/index';
import { SCENES, SceneRunner } from '../src/audio/scenes';
import type { Surface } from '../src/sim/types';

declare global {
  interface Window {
    DONE?: boolean;
    BACKEND?: string;
    AUDIO_CHECK?: { list: typeof checkList; render: typeof renderCheck; sheet: typeof contactSheet };
    AUDIO_LIVE?: { ready: boolean; state: string; peak: number; rms: number; voices: number; peakMax: number };
    AUDIO_BENCH?: unknown;
  }
}

window.BACKEND = 'none (audio page)';
window.AUDIO_CHECK = { list: checkList, render: renderCheck, sheet: contactSheet };

const audio = createAudio();
const $ = (id: string): HTMLElement => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', parent?: HTMLElement): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  parent?.appendChild(e);
  return e;
};
const words = (s: string): string => s.replace(/_/g, ' ');

function slider(parent: HTMLElement, name: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, on: (v: number) => void): HTMLInputElement {
  const l = el('label', '', parent);
  el('span', name, l).className = 'k';
  const r = el('input', '', l);
  r.type = 'range';
  r.min = String(min);
  r.max = String(max);
  r.step = String(step);
  r.value = String(value);
  const v = el('span', fmt(value), l);
  v.className = 'v';
  r.addEventListener('input', () => {
    const x = Number(r.value);
    v.textContent = fmt(x);
    on(x);
  });
  return r;
}
const f2 = (v: number): string => v.toFixed(2);
const deg = (v: number): string => `${v.toFixed(0)}°`;

// ---------------------------------------------------------------------------------------------
// listener and placement

let heading = 0; // degrees, the game's yaw: 0 north, counter-clockwise
let placeDist = 0; // 0: on you (not spatial)
let bearing = 0; // degrees from where you face, counter-clockwise

function setListener(): void {
  const y = (heading * Math.PI) / 180;
  audio.setListener(0, 1.7, 0, -Math.sin(y), 0, -Math.cos(y));
}
function where(): [number, number, number] | undefined {
  if (placeDist <= 0) return undefined;
  const y = ((heading + bearing) * Math.PI) / 180;
  const up = placeDist > 100 ? 25 : placeDist > 20 ? 4 : 0.6;
  return [-Math.sin(y) * placeDist, up, -Math.cos(y) * placeDist];
}

// ---------------------------------------------------------------------------------------------
// ambience

const amb: Ambience & { cave: number } = { ...AMBIENCE_DEFAULT, windDir: [...AMBIENCE_DEFAULT.windDir] };
let windTo = 90; // compass degrees the wind blows toward (0 north, 90 east)
const ambInputs = new Map<string, HTMLInputElement>();
const AMB_FIELDS: [keyof Ambience | 'cave', number, number, number][] = [
  ['wind', 0, 1, 0.01], ['gust', 0, 1, 0.01], ['storm', 0, 1, 0.01], ['snowfall', 0, 1, 0.01],
  ['shelter', 0, 1, 0.01], ['indoor', 0, 1, 0.01], ['cave', 0, 1, 0.01], ['forest', 0, 1, 0.01],
  ['height', 0, 800, 5], ['night', 0, 1, 0.01], ['onIce', 0, 1, 0.01], ['cold', 0, 1, 0.01],
];
function windDir(): [number, number] {
  const a = (windTo * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}
function pushAmbience(): void {
  amb.windDir = windDir();
  audio.setAmbience(amb);
}
for (const [k, lo, hi, st] of AMB_FIELDS) {
  ambInputs.set(k, slider($('amb'), k === 'onIce' ? 'on ice' : k, lo, hi, st, amb[k] as number, k === 'height' ? (v) => `${v.toFixed(0)} m` : f2, (v) => {
    (amb[k] as number) = v;
    pushAmbience();
  }));
}
const windInput = slider($('amb'), 'wind toward', 0, 359, 1, windTo, deg, (v) => {
  windTo = v;
  pushAmbience();
});
const headInput = slider($('amb'), 'you face', 0, 359, 1, heading, deg, (v) => {
  heading = v;
  setListener();
});
function showAmbience(): void {
  for (const [k] of AMB_FIELDS) {
    const r = ambInputs.get(k)!;
    r.value = String(amb[k]);
    r.dispatchEvent(new Event('input'));
  }
  const [x, z] = amb.windDir;
  windTo = ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
  windInput.value = String(Math.round(windTo));
  windInput.dispatchEvent(new Event('input'));
}

// ---------------------------------------------------------------------------------------------
// scenes

let scene: SceneRunner | null = null;
const sceneButtons: HTMLButtonElement[] = [];
function playScene(i: number): void {
  scene?.stop(1.5);
  scene = null;
  sceneButtons.forEach((b, j) => b.classList.toggle('on', j === i));
  if (i < 0) {
    audio.setMusic('none');
    return;
  }
  const sc = SCENES[i];
  heading = sc.yaw ?? 0;
  headInput.value = String(heading);
  headInput.dispatchEvent(new Event('input'));
  scene = new SceneRunner(audio, sc);
  Object.assign(amb, AMBIENCE_DEFAULT, { windDir: [...AMBIENCE_DEFAULT.windDir] }, sc.amb, sc.drive?.(0) ?? {});
  showAmbience();
  moodButtons.forEach((b) => b.classList.toggle('on', b.dataset.mood === (sc.music ?? 'none')));
}
SCENES.forEach((sc, i) => {
  const b = el('button', sc.label, $('scenes'));
  b.addEventListener('click', () => playScene(i));
  sceneButtons.push(b);
});
el('button', 'stop', $('scenes')).addEventListener('click', () => playScene(-1));

// ---------------------------------------------------------------------------------------------
// placement

const PLACES: [string, number][] = [['on you', 0], ['near, 4 m', 4], ['close, 15 m', 15], ['across, 60 m', 60], ['far, 250 m', 250]];
const placeButtons: HTMLButtonElement[] = [];
PLACES.forEach(([name, d], i) => {
  const b = el('button', name, $('place'));
  b.classList.toggle('on', i === 0);
  b.addEventListener('click', () => {
    placeDist = d;
    placeButtons.forEach((x, j) => x.classList.toggle('on', j === i));
    for (const l of loops.values()) if (l.handle) l.handle.set({ pos: where() });
  });
  placeButtons.push(b);
});
slider($('placeSliders'), 'bearing', 0, 359, 1, 0, deg, (v) => {
  bearing = v;
  const p = where();
  if (p) for (const l of loops.values()) if (l.handle) l.handle.set({ pos: p });
});

// ---------------------------------------------------------------------------------------------
// one-shots

const GROUPS: [string, SfxName[]][] = [
  ['interface', ['ui_hover', 'ui_click', 'ui_open', 'ui_close', 'toast', 'objective', 'part_found']],
  ['body', ['jump', 'land', 'hurt', 'bite', 'downed', 'revived', 'death', 'shiver', 'gasp', 'cough', 'eat', 'drink', 'bandage', 'heartbeat']],
  ['tools', ['pickup', 'pickup_wood', 'open_crate', 'equip', 'axe_swing', 'axe_wood', 'axe_flesh', 'wood_split', 'tree_fall', 'light_click', 'radio_crank', 'radio_blip', 'match_strike', 'match_fail']],
  ['rifle and flare', ['rifle_shot', 'rifle_bolt', 'rifle_dry', 'rifle_reload', 'bullet_snow', 'bullet_wood', 'flare_shot', 'flare_land']],
  ['fire', ['fire_catch', 'fire_feed', 'fire_die', 'fire_pop']],
  ['wolves', ['howl', 'howl_far', 'growl', 'bark', 'yelp', 'wolf_die', 'paws']],
  ['ice and water', ['ice_creak', 'ice_crack', 'ice_break', 'ice_boom', 'splash']],
  ['world', ['gust', 'branch_snow', 'door', 'log_lift', 'log_drop', 'generator_start', 'generator_stop', 'panel_install', 'transmit', 'metal_creak', 'thunder']],
];
const listed = new Set(GROUPS.flatMap(([, n]) => n));
const rest = SFX_NAMES.filter((n) => !listed.has(n));
if (rest.length) GROUPS.push(['other', rest]);
function flash(b: HTMLElement): void {
  b.classList.add('hit');
  setTimeout(() => b.classList.remove('hit'), 160);
}
for (const [title, names] of GROUPS) {
  const g = el('div', '', $('sfx'));
  g.className = 'group';
  el('h3', title, g);
  for (const n of names) {
    const b = el('button', words(n), g);
    b.addEventListener('click', () => {
      audio.sfx(n, { pos: where() });
      flash(b);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// loops

const LOOP_PARAM: Partial<Record<LoopName, string>> = { fire: 'heat', flare: 'life', generator: 'charge', radio_static: 'signal', heli: 'closeness', wolf_breath: 'closeness' };
const loops = new Map<LoopName, { handle: LoopHandle | null; param: number }>();
for (const n of LOOP_NAMES) {
  const st = { handle: null as LoopHandle | null, param: n === 'flare' ? 1 : 0.6 };
  loops.set(n, st);
  const row = el('div', '', $('loops'));
  row.className = 'loop';
  const b = el('button', words(n), row);
  b.addEventListener('click', () => {
    if (st.handle) {
      st.handle.stop(0.6);
      st.handle = null;
    } else st.handle = audio.loop(n, { pos: where(), param: st.param });
    b.classList.toggle('on', !!st.handle);
  });
  const pname = LOOP_PARAM[n];
  if (pname) {
    const l = el('label', '', row);
    el('span', pname, l);
    const r = el('input', '', l);
    r.type = 'range';
    r.min = '0';
    r.max = '1';
    r.step = '0.01';
    r.value = String(st.param);
    r.addEventListener('input', () => {
      st.param = Number(r.value);
      st.handle?.set({ param: st.param });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// footsteps

let stepSpeed = 0.4;
let stepDepth = 0.5;
let walking: Surface | null = null;
let stepClock = 0;
const walkButtons = new Map<Surface, HTMLButtonElement>();
for (const s of STEP_NAMES) {
  const b = el('button', s, $('steps'));
  b.addEventListener('click', () => {
    audio.footstep(s, stepSpeed, { pos: where(), depth: stepDepth });
    flash(b);
  });
}
const walkRow = el('span', '', $('steps'));
walkRow.className = 'row';
el('span', 'walk on:', walkRow).style.color = 'var(--dim)';
for (const s of STEP_NAMES) {
  const b = el('button', s, walkRow);
  b.addEventListener('click', () => {
    walking = walking === s ? null : s;
    stepClock = 0;
    for (const [k, x] of walkButtons) x.classList.toggle('on', k === walking);
  });
  walkButtons.set(s, b);
}
slider($('stepSliders'), 'speed', 0, 1, 0.01, stepSpeed, f2, (v) => (stepSpeed = v));
slider($('stepSliders'), 'snow depth', 0, 1, 0.01, stepDepth, f2, (v) => (stepDepth = v));

// ---------------------------------------------------------------------------------------------
// score

const MOODS: MusicMood[] = ['none', 'title', 'calm', 'cold', 'night', 'stalked', 'attack', 'whiteout', 'shelter', 'tower', 'holdout', 'rescue', 'death'];
let intensity = 0.5;
const moodButtons: HTMLButtonElement[] = [];
for (const m of MOODS) {
  const b = el('button', m, $('moods'));
  b.dataset.mood = m;
  b.classList.toggle('on', m === 'none');
  b.addEventListener('click', () => {
    audio.setMusic(m, { intensity });
    moodButtons.forEach((x) => x.classList.toggle('on', x === b));
  });
  moodButtons.push(b);
}
slider($('moodSliders'), 'intensity', 0, 1, 0.01, intensity, f2, (v) => {
  intensity = v;
  const on = moodButtons.find((b) => b.classList.contains('on'));
  if (on) audio.setMusic(on.dataset.mood as MusicMood, { intensity });
});

// ---------------------------------------------------------------------------------------------
// mix

const vol = { master: 0.9, music: 0.8, sfx: 1 };
for (const k of ['master', 'music', 'sfx'] as const) slider($('mix'), k, 0, 1, 0.01, vol[k], f2, (v) => {
  vol[k] = v;
  audio.setVolumes(vol);
});
slider($('mix'), 'duck (menu)', 0, 1, 0.01, 0, f2, (v) => audio.setDuck(v));
audio.setVolumes(vol);
let held = false;
const holdBtn = el('button', 'suspend', $('mixButtons'));
holdBtn.addEventListener('click', () => {
  held = !held;
  if (held) audio.suspend();
  else audio.resume();
  holdBtn.textContent = held ? 'resume' : 'suspend';
  holdBtn.classList.toggle('on', held);
});

// ---------------------------------------------------------------------------------------------
// start, the frame loop, the meter

const startBtn = $('start') as HTMLButtonElement;
async function start(): Promise<void> {
  await audio.unlock();
  startBtn.textContent = audio.ready ? 'Audio on' : 'No audio';
  startBtn.classList.add('live');
}
startBtn.addEventListener('click', () => void start());
setListener();
pushAmbience();

const meter = $('meter') as HTMLCanvasElement;
const mg = meter.getContext('2d')!;
const HIST = 600;
const histPk = new Float32Array(HIST);
const histRms = new Float32Array(HIST);
let histAt = 0;
let meterAcc = 0;
let peakMax = 0;
const dbOf = (x: number): number => (x > 1e-6 ? 20 * Math.log10(x) : -120);

function drawMeter(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.floor(meter.clientWidth * dpr));
  const h = Math.max(1, Math.floor(meter.clientHeight * dpr));
  if (meter.width !== w || meter.height !== h) {
    meter.width = w;
    meter.height = h;
  }
  mg.fillStyle = '#0a0c0f';
  mg.fillRect(0, 0, w, h);
  const y = (d: number): number => h - ((Math.max(-60, Math.min(0, d)) + 60) / 60) * h;
  mg.strokeStyle = '#2a3038';
  mg.lineWidth = 1;
  for (const d of [-6, -20, -40]) {
    mg.beginPath();
    mg.moveTo(0, Math.round(y(d)) + 0.5);
    mg.lineTo(w, Math.round(y(d)) + 0.5);
    mg.stroke();
  }
  const bw = w / HIST;
  mg.fillStyle = '#9aa6b2';
  for (let i = 0; i < HIST; i++) {
    const v = histPk[(histAt + i) % HIST];
    const yy = y(dbOf(v));
    mg.fillRect(i * bw, yy, Math.max(1, bw), h - yy);
  }
  mg.strokeStyle = '#e6a84a';
  mg.beginPath();
  for (let i = 0; i < HIST; i++) {
    const yy = y(dbOf(histRms[(histAt + i) % HIST]));
    if (i) mg.lineTo(i * bw, yy);
    else mg.moveTo(0, yy);
  }
  mg.stroke();
}

let last = performance.now();
let driveAcc = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  scene?.tick(dt);
  // fields a scene drives (gusts) move their sliders, so the page shows what is playing
  driveAcc += dt;
  if (scene?.scene.drive && driveAcc > 0.2) {
    driveAcc = 0;
    for (const [k, v] of Object.entries(scene.scene.drive(scene.t))) {
      const r = ambInputs.get(k);
      if (r && typeof v === 'number') {
        r.value = String(v);
        r.dispatchEvent(new Event('input'));
      }
    }
  }
  if (walking) {
    stepClock -= dt;
    if (stepClock <= 0) {
      // a walking pace of about 1.7 steps a second, running about 2.8
      stepClock = 1 / (1.7 + 1.1 * stepSpeed);
      audio.footstep(walking, stepSpeed, { pos: where(), depth: stepDepth });
    }
  }
  audio.update(dt);
  meterAcc += dt;
  if (meterAcc >= 1 / 60) {
    meterAcc = 0;
    const m = audio.meter();
    histPk[histAt] = m.peak;
    histRms[histAt] = m.rms;
    histAt = (histAt + 1) % HIST;
    peakMax = Math.max(peakMax, m.peak);
    $('status').innerHTML = audio.ready
      ? `peak <b>${dbOf(m.peak).toFixed(1)}</b> dBFS &nbsp; rms <b>${dbOf(m.rms).toFixed(1)}</b> &nbsp; voices <b>${m.voices}</b>${held ? ' &nbsp; suspended' : ''}`
      : 'silent until started';
    drawMeter();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.AUDIO_BENCH = { audio, scenes: SCENES, playScene };

// ---------------------------------------------------------------------------------------------
// ?auto=1: the live path, end to end, for headless runs

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function auto(): Promise<void> {
  await start();
  playScene(SCENES.findIndex((s) => s.id === 'stalked'));
  placeDist = 4;
  walking = 'snow';
  await wait(1200);
  for (const n of ['axe_wood', 'rifle_shot', 'ui_click', 'pickup'] as SfxName[]) {
    audio.sfx(n, { pos: where() });
    await wait(250);
  }
  const fl = audio.loop('flare', { pos: [3, 0.2, -2], param: 1 });
  await wait(900);
  audio.suspend();
  await wait(300);
  audio.resume();
  await wait(900);
  fl.set({ param: 0.1 });
  await wait(600);
  fl.stop(0.3);
  walking = null;
  const m = audio.meter();
  window.AUDIO_LIVE = { ready: audio.ready, state: audio.ready ? 'running' : 'no context', peak: m.peak, rms: m.rms, voices: m.voices, peakMax };
  window.DONE = true;
}

if (new URLSearchParams(location.search).get('auto') === '1') void auto();
else requestAnimationFrame(() => requestAnimationFrame(() => (window.DONE = true)));
