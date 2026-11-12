// UI bench: the whole interface over a still placeholder scene, driven by a complete fake View.
//
//   dev/ui.html?mode=title|play|pause|inventory|dead|won|boot
//     &cold=0..1   core from 37 down to 30.4 (cold, freezing, severe)
//     &hurt=0..1   health down, low-health
//     &touch=1     phone controls        &focus=1   something to use, with a hold ring
//     &team=0..3   teammates (one cold, one freezing, one downed)
//     &toasts=1    a few toasts, a lore line and a place card
//     &storm=1     whiteout background and wind
//     &down=1      the local player is downed     &held=rifle|flashlight|radio|flaregun|axe|hands
//     &page=settings|controls|how|credits|map      &sel=<item id> in the pack
//     &cause=wolf|cold|fall|water|fire  (dead)    &bg=night    &fps=1    &save=0
//     &age=N       N seconds of interface time pass at once (what fades when nothing changes)
//     &still=1     freeze the fake values and every transition (for screenshots)
//
// Fake values animate slowly unless still=1. The page sets window.DONE when its frame is up.
import { Bus } from '../src/core/bus';
import type { Camera, GameActions, GameBus, Hud, Mode, Settings, TouchSink, View, ViewEnt } from '../src/game/view';
import type { Entity, EntityKind, Env, FireEnt, HurtCause, NetId, Objective, PlayerEnt, Stats, ToolId } from '../src/sim/types';
import type { UiGame } from '../src/ui/api';
import { createUI } from '../src/ui/index';
import type { Poi, World } from '../src/world/types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = q.get(k);
  return v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v);
};
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const flag = (k: string) => q.get(k) === '1';

const mode0 = (q.get('mode') ?? 'play') as Mode;
const cold = clamp01(num('cold', 0));
const hurt = clamp01(num('hurt', 0));
const touch = flag('touch');
const focusOn = flag('focus');
const team = Math.max(0, Math.min(3, Math.round(num('team', 0))));
const toastsOn = flag('toasts');
const storm = flag('storm');
const still = flag('still');
const down = flag('down');
const page = q.get('page') ?? '';
const held = (q.get('held') ?? 'rifle') as ToolId;
const webgl = flag('webgl');
const bgKind = storm ? 'storm' : q.get('bg') ?? '';
if (bgKind) document.getElementById('bg')!.classList.add(bgKind);

// ------------------------------------------------------------------------- world (stub)
const P = (id: Poi['id'], name: string, x: number, z: number, radius = 40): Poi => ({ id, name, x, y: 0, z, yaw: 0, radius });
const pois: Poi[] = [
  P('wreck', 'The fuselage', -120, 520),
  P('tail', 'Tail section', 270, 380),
  P('cabin', 'Ranger cabin', -430, 130),
  P('lake', 'Frozen lake', 190, -40, 90),
  P('hut', 'Ice-fishing hut', 190, -40, 12),
  P('cave', 'The cave', -310, -290),
  P('camp', 'Survey camp', 480, -330),
  P('tower', 'Signal tower', 40, -610),
];
const world: World = {
  seed: 417,
  size: 1600,
  half: 800,
  heightAt: () => 0,
  groundAt: () => ({ y: 0, surface: 'snow' }),
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
  slopeAt: () => 0,
  snowDepthAt: () => 0.3,
  surfaceAt: () => 'snow',
  forestAt: () => 0,
  heightmap: { data: new Float32Array(4), n: 2, extent: 800, min: 0, max: 0 },
  masks: { data: new Uint8Array(16), n: 2, extent: 800 },
  pois,
  poi: (id) => pois.find((p) => p.id === id) ?? pois[0],
  lake: { x: 190, z: -40, level: 0, n: 1, cell: 4, minX: 100, minZ: -130, thickness: new Float32Array(1) },
  iceAt: () => 0,
  iceCell: () => -1,
  trees: [],
  treesIn: (_a, _b, _c, _d, out = []) => out,
  rocks: [],
  props: [],
  floors: [],
  shelters: [],
  collidersNear: (_x, _z, _r, out = []) => out,
  shelterAt: () => ({ amount: 0, indoor: false }),
  lineClear: () => true,
  raycast: () => null,
  spawn: {
    players: [{ x: -120, y: 0, z: 520, yaw: 0 }],
    defs: [],
    packs: [],
    parts: {
      battery: { poi: 'tail', x: 270, y: 0, z: 380 },
      handset: { poi: 'cabin', x: -430, y: 0, z: 130 },
      coil: { poi: 'camp', x: 480, y: 0, z: -330 },
      tube: { poi: 'cave', x: -310, y: 0, z: -290 },
      fuse: { poi: 'hut', x: 190, y: 0, z: -40 },
    },
  },
  route: pois.map((p) => ({ x: p.x, z: p.z, poi: p.id })),
  walkable: () => true,
};

// ------------------------------------------------------------------------- entities
function player(id: NetId, name: string, slot: number, x: number, z: number, over: Partial<PlayerEnt> = {}): ViewEnt<PlayerEnt> {
  return {
    id, kind: 'player', x, y: 0, z, yaw: 0, rev: 1, name, slot, bot: id !== 1,
    vx: 0, vy: 0, vz: 0, pitch: 0, onGround: true, crouch: false, sprint: false, surface: 'snow', swim: false, seq: 0,
    life: 'alive', health: 100, core: 36.8, wet: 0, stamina: 1, hunger: 0.2,
    feels: -14, shelter: 0, fireHeat: 0, huddle: 0, trend: 0,
    bleed: 90, revive: 0, reviver: 0,
    inv: {}, held: 'hands', act: 'none', actT: 0, loaded: 0, flareLoaded: 0, lightOn: false, cellCharge: 1,
    radioCharge: 0, radioSig: 0, radioDist: -1, aim: 0, carry: 0, isolation: 0, kills: 0,
    age: 60,
    ...over,
  };
}

const core0 = 37 - cold * 6.6;
const me = player(1, 'Ash', 0, -40, 300, {
  core: core0,
  trend: cold > 0 ? -(0.25 + cold * 1.1) : 0.02,
  health: 100 * (1 - hurt * 0.82),
  stamina: hurt > 0 ? 0.55 : 1,
  wet: clamp01(num('wet', storm ? 0.42 : 0)),
  feels: storm ? -31 : -14,
  shelter: storm ? 0.1 : 0.2,
  fireHeat: flag('fire') ? 0.55 : 0,
  huddle: team > 0 && flag('fire') ? 0.3 : 0,
  held: down ? 'hands' : held,
  inv: {
    axe: 1, flashlight: 1, flaregun: 1, rifle: 1, radio: 1,
    stick: 4, log: 1, tinder: 1, matches: 6, flare: 2, ammo: 7, cell: 1, bandage: 2, ration: 1, thermos: 1,
    part_battery: 1, part_handset: 1,
  },
  loaded: 3,
  flareLoaded: 1,
  cellCharge: 0.64,
  lightOn: true,
  radioCharge: 0.4,
  radioSig: 0.7,
  radioDist: 240,
  life: down ? 'downed' : 'alive',
  bleed: 47,
  revive: down && team > 0 ? 0.35 : 0,
  reviver: down && team > 0 ? 2 : 0,
});

// facing a little left of the objective (the tail section), so it shows right of centre
const TAIL = { x: 270, z: 380 };
const heading0 = Math.atan2(TAIL.x - me.x, -(TAIL.z - me.z)) - 0.3;
// teammates: one fine and close, one freezing, one downed in front of the camera
const mates: ViewEnt<PlayerEnt>[] = [
  player(2, 'Mara', 1, me.x + 9, me.z - 14, { core: 36.2, held: 'axe', inv: { axe: 1, stick: 2 } }),
  player(3, 'Tomas', 2, me.x - 50, me.z - 30, { core: 32.7, trend: -0.8, held: 'flashlight' }),
  player(4, 'Ines', 3, me.x + Math.sin(heading0 + 0.12) * 38, me.z - Math.cos(heading0 + 0.12) * 38, { life: 'downed', bleed: 52, core: 33.9, health: 0 }),
].slice(0, team);

const fire: ViewEnt<FireEnt> = {
  id: 50, kind: 'fire', x: me.x + 8, y: 0, z: me.z + 12, yaw: 0, rev: 1, type: 'campfire', lit: true, fuel: 120, heat: 0.8, size: 0.6,
  shelter: 0.4, embers: 60, by: 1, age: 300,
};

const ents = new Map<NetId, ViewEnt>();
for (const e of [me, ...mates, fire] as ViewEnt[]) ents.set(e.id, e);

// ------------------------------------------------------------------------- view
const settings: Settings = {
  quality: 'auto', renderScale: 0.85, fov: 75, sensitivity: 1, invertY: false,
  master: 0.8, music: 0.6, sfx: 0.9, shake: true, grain: true, hints: q.get('hint') !== '0', bots: team, showFps: flag('fps'),
};
const env: Env = {
  t: 1930, clock: 17.7, day: 0, storm: storm ? 0.92 : 0.25,
  windX: storm ? 13 : 4.5, windZ: storm ? 5 : 1.5, gust: 0.3, snowfall: storm ? 0.9 : 0.2,
  visibility: storm ? 12 : 400, airTemp: storm ? -19 : -11, cloud: 0.6, aurora: 0, snowAccum: 0.1,
};
const objective: Objective = {
  stage: 'search',
  parts: { battery: 'held', handset: 'held', coil: 'lost', tube: 'lost', fuse: 'installed' },
  generator: 0, transmit: 0, eta: -1, signalled: false,
};
const stats: Stats = { distance: 3240, firesLit: 3, wolvesKilled: 1, revives: 2, downs: 1, coldest: Math.min(33.4, core0), shots: 6 };
const camera: Camera = { x: me.x, y: 1.6, z: me.z, yaw: -heading0, pitch: -0.04, roll: 0, fov: 70, third: 0 };

const hud: Hud = {
  focus: focusOn ? { id: 50, kind: 'fire', verb: 'Feed fire', name: 'Campfire', hold: 0.62, key: 'E', note: 'Burns for about two minutes' } : null,
  crosshair: focusOn ? 'ring' : held === 'rifle' && !down ? 'dot' : 'dot',
  heading: heading0,
  marks: [],
  place: '',
  hint: 'Sticks lie under the trees. Three lay a fire.',
  objective: 'Find the radio parts. Crank the radio and turn until the static clears.',
  frost: cold, wetLens: 0, hurt: 0, lowHealth: hurt, whiteout: storm ? 0.8 : 0,
};

const bus = new Bus<GameBus>();
const view: View = {
  world, bus, settings, touch, mode: 'boot', time: 0, env, objective, stats,
  me, myId: 1, ents,
  list: ((kind: EntityKind) => [...ents.values()].filter((e) => e.kind === kind)) as View['list'],
  ice: new Map(), camera, hud,
  rig: { bob: 0, stride: 0, speed: 0, recoil: 0, sway: 0, breath: 0, shiver: 0, landing: 0 },
};

function marks(): void {
  const m: Hud['marks'] = [
    { id: 'obj', kind: 'objective', bearing: Math.atan2(TAIL.x - me.x, -(TAIL.z - me.z)), dist: Math.hypot(TAIL.x - me.x, TAIL.z - me.z), label: 'Tail section' },
    { id: 'fire50', kind: 'fire', bearing: Math.atan2(fire.x - me.x, -(fire.z - me.z)), dist: Math.hypot(fire.x - me.x, fire.z - me.z) },
    { id: 'poi:tower', kind: 'poi', bearing: Math.atan2(40 - me.x, -(-610 - me.z)), dist: 900, label: 'Signal tower' },
  ];
  for (const p of mates) m.push({ id: 'pl' + p.id, kind: 'player', bearing: Math.atan2(p.x - me.x, -(p.z - me.z)), dist: Math.hypot(p.x - me.x, p.z - me.z), label: p.name });
  hud.marks = m;
}
marks();

// ------------------------------------------------------------------------- game
const log: unknown[] = [];
const setMode = (m: Mode) => {
  const from = view.mode;
  if (from === m) return;
  view.mode = m;
  bus.emit('mode', { from, to: m });
};
const toast = (kind: GameBus['toast']['kind'], text: string, item?: GameBus['toast']['item']) => bus.emit('toast', { kind, text, item });
const actions: GameActions = {
  newGame: () => setMode('play'),
  continueGame: () => setMode('play'),
  hasSave: () => q.get('save') !== '0',
  resume: () => setMode('play'),
  pause: () => setMode('pause'),
  quitToTitle: () => setMode('title'),
  openInventory: () => setMode('inventory'),
  closeInventory: () => setMode('play'),
  setSetting: (k, v) => {
    (settings as unknown as Record<string, unknown>)[k] = v;
    bus.emit('settings', { key: k, value: v });
  },
  act: (a) => {
    log.push(a);
    const inv = me.inv;
    if (a.t === 'consume') {
      inv[a.item] = Math.max(0, (inv[a.item] ?? 0) - 1);
      toast('info', a.item === 'thermos' ? 'Hot and sweet. Your hands come back.' : a.item === 'ration' ? 'You eat it cold.' : 'Bandaged.');
    } else if (a.t === 'drop') inv[a.item] = Math.max(0, (inv[a.item] ?? 0) - a.n);
    else if (a.t === 'give') inv[a.item] = Math.max(0, (inv[a.item] ?? 0) - a.n);
    else if (a.t === 'reload') {
      if (me.held === 'rifle') me.loaded = 5;
      else if (me.held === 'flaregun') me.flareLoaded = 1;
      else if (me.held === 'flashlight') me.cellCharge = 1;
    } else if (a.t === 'toggleLight') me.lightOn = !me.lightOn;
    else if (a.t === 'buildFire') {
      inv.stick = Math.max(0, (inv.stick ?? 0) - 3);
      toast('info', 'Campfire laid. It needs a match.');
    }
  },
  equip: (t) => {
    log.push({ equip: t });
    me.held = t;
  },
  respawn: () => setMode('play'),
  photo: (on) => setMode(on ? 'photo' : 'play'),
};
const touchLog: unknown[] = [];
const sink: TouchSink = {
  move: (x, z) => touchLog.push(['move', +x.toFixed(2), +z.toFixed(2)]),
  look: (dx, dy) => touchLog.push(['look', Math.round(dx), Math.round(dy)]),
  button: (b, d) => touchLog.push(['button', b, d]),
};

let mapCache: { canvas: HTMLCanvasElement; toUV(x: number, z: number): [number, number] } | null = null;
function fakeMap() {
  if (mapCache) return mapCache;
  const c = document.createElement('canvas');
  c.width = c.height = 768;
  const g = c.getContext('2d')!;
  const uv = (x: number, z: number): [number, number] => [(x + 800) / 1600, (z + 800) / 1600];
  g.fillStyle = '#0f141a';
  g.fillRect(0, 0, 768, 768);
  // contour lines around the summit ridge in the north
  const [sx, sz] = uv(40, -660);
  g.lineWidth = 1;
  for (let i = 1; i < 26; i++) {
    g.strokeStyle = i % 5 === 0 ? 'rgba(235,232,225,.2)' : 'rgba(235,232,225,.08)';
    g.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
      const r = i * 34 * (1 + 0.16 * Math.sin(a * 3 + i * 0.4) + 0.08 * Math.sin(a * 7 - i));
      const x = sx * 768 + Math.sin(a) * r * 1.15, y = sz * 768 + Math.cos(a) * r * 0.9;
      if (a === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // forest as a fine stipple
  g.fillStyle = 'rgba(120,140,128,.28)';
  for (let i = 0; i < 2600; i++) {
    const x = (Math.sin(i * 12.9898) * 43758.5453) % 1, y = (Math.sin(i * 78.233) * 12345.678) % 1;
    const px = Math.abs(x) * 768, py = Math.abs(y) * 768;
    if (py < 260 || (px > 420 && py < 420)) continue;
    g.fillRect(px, py, 1.5, 1.5);
  }
  // the lake
  const [lx, lz] = uv(190, -40);
  g.fillStyle = 'rgba(195,222,242,.14)';
  g.strokeStyle = 'rgba(195,222,242,.35)';
  g.beginPath();
  g.ellipse(lx * 768, lz * 768, 52, 34, 0.4, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  mapCache = { canvas: c, toUV: uv };
  return mapCache;
}

const game: UiGame = {
  view,
  actions,
  touch: sink,
  icon: () => null,
  map: fakeMap,
  gpu: { backend: webgl ? 'webgl2' : 'webgpu', adapter: 'Bench adapter (no renderer)' },
  sfx: () => {},
};

const ui = createUI(game);
if (still) document.querySelector('.cs')?.classList.add('still');
(window as unknown as Record<string, unknown>).BACKEND = webgl ? 'webgl2' : 'webgpu';
Object.assign(window as unknown as Record<string, unknown>, { UI: ui, VIEW: view, ACTIONS: actions, TOUCH_LOG: touchLog, ACT_LOG: log, setMode, toast });

// ------------------------------------------------------------------------- start the screen
const click = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.click();
if (mode0 === 'boot') bus.emit('loading', { progress: 0.62, label: 'Laying the snow' });
else if (mode0 === 'dead') {
  setMode('play');
  const cause = (q.get('cause') ?? (cold > 0.7 ? 'cold' : 'wolf')) as HurtCause;
  bus.emit('sim', { t: 'hurt', id: 1, amount: 30, cause });
  setMode('dead');
} else setMode(mode0);
ui.update(1 / 60);
// &age=N: let N seconds of interface time pass at once (what fades when nothing changes)
const age = num('age', 0);
if (age > 0) ui.update(age);
if (page) {
  if (mode0 === 'pause') click(`.ov .ni[data-id="${page}"]`);
  else if (mode0 === 'title') click(`.tt .mi[data-id="${page}"]`);
  else if (mode0 === 'inventory') click(`.inv .mi[data-id="${page}"]`);
}
const sel = q.get('sel');
if (sel && mode0 === 'inventory') click(`.inv .cell[data-id="${sel}"]`);
if (toastsOn && view.mode === 'play') {
  toast('pickup', 'Dry sticks', 'stick');
  toast('pickup', 'Dry sticks', 'stick');
  toast('part', 'The battery. Four parts to go.', 'part_battery');
  toast('warn', 'Too much wind to strike a match here.');
  toast('lore', '“If anyone finds this, we went up toward the tower. Ruth.”');
  bus.emit('place', { id: 'tail', name: 'Tail section' });
}

// ------------------------------------------------------------------------- loop
const AMBIENT = ['Matches', 'Split logs', 'Rifle rounds', 'Tinder'];
let t = 0, frames = 0, nextToast = 7;
let last = performance.now();
function animate(dt: number): void {
  t += dt;
  view.time += dt;
  env.t += dt;
  env.clock = (env.clock + dt / 60) % 24;
  hud.heading = heading0 + Math.sin(t * 0.15) * 0.5 + Math.sin(t * 0.041) * 0.9;
  camera.yaw = -hud.heading;
  me.stamina = hurt > 0 ? 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.4)) : me.stamina;
  me.core = core0 + Math.sin(t * 0.2) * 0.12;
  me.radioSig = 0.5 + 0.45 * Math.sin(t * 0.3);
  if (hud.focus && hud.focus.hold !== null) hud.focus.hold = (t * 0.25) % 1;
  if (down) {
    me.bleed = Math.max(0, 47 - t);
    if (team > 0) me.revive = (0.35 + t * 0.08) % 1;
  }
  for (const p of mates) if (p.life === 'downed') p.bleed = Math.max(0, 52 - t);
  marks();
  if (toastsOn && t > nextToast && view.mode === 'play') {
    nextToast = t + 6;
    const name = AMBIENT[Math.floor(t) % AMBIENT.length];
    toast('pickup', name, name === 'Matches' ? 'matches' : name === 'Split logs' ? 'log' : name === 'Rifle rounds' ? 'ammo' : 'tinder');
  }
}
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!still) animate(dt);
  ui.update(still ? 1 / 60 : dt);
  frames++;
  if (frames === 12) (window as unknown as Record<string, unknown>).DONE = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
