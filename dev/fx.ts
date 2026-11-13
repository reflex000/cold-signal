// FX bench: one fire (campfire, barrel or stove) on the bench snowfield, optionally a flare,
// breathing players, the goggle overlays and the small effects, driven through a stand-in View
// exactly as the game drives the real system.
//
//   dev/fx.html?fire=1&light=night            fire stage: 0 laid, 1 burning, 2 embers, 3 dead
//   &type=campfire|barrel|stove  &heat=0..1  &size=0..1
//   &ignite=1                                  replay a match, the catch and the growth (live clock)
//   &wind=6 &wdir=90 &gust=0..1                wind m/s, toward this compass bearing (90 = east)
//   &flare=1 (on the ground) | 2 (in flight)   &breath=1 (players breathing)  &fp=1 (first person)
//   &frost=0..1 &wet=0..1 &lsnow=0..1 &hurt=0..1 &low=0..1     goggle overlays
//   &fx=muzzle|snow|chips|sparks|splash|shards (a burst just before the shot) &warm=8 (seconds of
//   particles simulated before the first frame) plus every createBench parameter (?q ?t ?az ...).
// Owner: FX.
import * as THREE from 'three/webgpu';
import { createBench, type LightName } from './bench';
import { Bus } from '../src/core/bus';
import { createFxSystem, type BurstKind, type FxSystem } from '../src/gfx/fx';
import { createPropsSystem } from '../src/models/instances';
import '../src/models/props';
import type { GameBus, Hud, View, ViewEnt } from '../src/game/view';
import type { Entity, EntityKind, Env, FireEnt, FireType, FlareEnt, PlayerEnt } from '../src/sim/types';
import type { World } from '../src/world/types';

const b = await createBench({ light: 'night' });
const { engine, scene, camera } = b;
const P = (n: string) => b.param(n);
const light = (P('light') ?? 'night') as LightName;

// ---- a flat stand-in world ----
const world = {
  seed: 1,
  size: 1600,
  half: 800,
  heightAt: () => 0,
  groundAt: () => ({ y: 0, surface: 'snow' as const }),
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
  slopeAt: () => 0,
  snowDepthAt: () => 0.35,
  surfaceAt: () => 'snow' as const,
  forestAt: () => 0,
  pois: [{ id: 'cabin', name: 'Ranger cabin', x: 0, y: 0, z: 3, yaw: 0, radius: 10 }],
  lake: { x: 0, z: 0, level: 0, n: 1, cell: 1, minX: 0, minZ: 0, thickness: new Float32Array(1) },
  props: [],
} as unknown as World;

// ---- the stand-in view ----
const stormy = light === 'storm';
const wind = b.num('wind', stormy ? 14 : light === 'day' ? 3 : 2);
const wdir = (b.num('wdir', 90) * Math.PI) / 180; // compass bearing the air moves toward
const env: Env = {
  t: 0, clock: 18, day: 0,
  storm: stormy ? 0.9 : 0,
  windX: Math.sin(wdir) * wind, windZ: -Math.cos(wdir) * wind,
  gust: b.num('gust', stormy ? 0.5 : 0),
  snowfall: stormy ? 1 : 0,
  visibility: stormy ? 60 : 4000,
  airTemp: -14, cloud: stormy ? 1 : 0.2, aurora: 0, snowAccum: 0,
};
const hud: Hud = {
  focus: null, crosshair: 'none', heading: 0, marks: [], place: '', hint: '', objective: '',
  frost: b.num('frost', 0), wetLens: b.num('wet', 0), hurt: b.num('hurt', 0), lowHealth: b.num('low', 0), whiteout: 0,
};
const ents = new Map<number, ViewEnt>();
const lists = new Map<EntityKind, ViewEnt[]>();
function put(e: Entity): ViewEnt {
  const v = Object.assign(e, { age: 30 }) as ViewEnt;
  ents.set(e.id, v);
  if (!lists.has(e.kind)) lists.set(e.kind, []);
  lists.get(e.kind)!.push(v);
  return v;
}
const camState = { x: 0, y: 1.7, z: 5, yaw: 0, pitch: 0, roll: 0, fov: 55, third: 0 };
const view = {
  world,
  bus: new Bus<GameBus>(),
  settings: { quality: 'medium', renderScale: 1, fov: 70, sensitivity: 1, invertY: false, master: 1, music: 1, sfx: 1, shake: true, grain: true, hints: true, bots: 0, showFps: false },
  touch: false,
  mode: 'play',
  time: 0,
  env,
  objective: { stage: 'search', parts: { battery: 'lost', handset: 'lost', coil: 'lost', tube: 'lost', fuse: 'lost' }, generator: 0, transmit: 0, eta: -1, signalled: false },
  stats: { distance: 0, firesLit: 0, wolvesKilled: 0, revives: 0, downs: 0, coldest: 37, shots: 0 },
  me: null as ViewEnt<PlayerEnt> | null,
  myId: 1,
  ents,
  list: (kind: EntityKind) => lists.get(kind) ?? [],
  ice: new Map(),
  camera: camState,
  hud,
  rig: { bob: 0, stride: 0, speed: 0, recoil: 0, sway: 0, breath: 0, shiver: 0, landing: 0 },
} as unknown as View;

// createBench's frames carry no view: hand every system this one, as the game does
const engineFrame = engine.frame.bind(engine);
engine.frame = (f) => {
  f.view = view;
  engineFrame(f);
};

// ---- props (the campfire model, a barrel) and the fx system ----
const props = createPropsSystem({ scene, camera }, [], { shadows: true });
engine.add(props);
const fx = createFxSystem(engine, world) as FxSystem;
// &nofx=1: the same scene without fx (a baseline for &perf=1)
if (P('nofx') !== '1') engine.add(fx);
(window as any).FX = fx;

// &perf=1: median GPU time over a few seconds of live frames, in the console and window.PERF
if (P('perf') === '1') {
  b.busy(
    new Promise<void>((done) => {
      const ms: number[] = [];
      const t0 = performance.now();
      const tick = (): void => {
        const t = performance.now() - t0;
        if (t > 3000 && engine.stats.gpuMs > 0) ms.push(engine.stats.gpuMs);
        if (t < 9000) {
          requestAnimationFrame(tick);
          return;
        }
        ms.sort((a, c) => a - c);
        const med = ms.length ? ms[ms.length >> 1] : 0;
        const perf = { fx: P('nofx') !== '1', q: engine.quality.name, gpuMedian: +med.toFixed(2), samples: ms.length, calls: engine.stats.calls, info: { ...fx.info } };
        (window as any).PERF = perf;
        console.log('PERF ' + JSON.stringify(perf));
        done();
      };
      requestAnimationFrame(tick);
    }),
  );
}

const type = (P('type') ?? 'campfire') as FireType;
const stage = Math.max(0, Math.min(3, Math.round(b.num('fire', 1))));
const ignite = P('ignite') === '1';
const fire = put({
  id: 10, kind: 'fire', type, x: 0, y: type === 'barrel' ? 0.9 : type === 'stove' ? 0.45 : 0, z: 0, yaw: 0.4, rev: 0,
  lit: !ignite && stage === 1, fuel: stage === 3 ? 0 : 300, heat: !ignite && stage === 1 ? b.num('heat', 0.9) : 0,
  size: b.num('size', 0.8), shelter: 0.15, embers: stage === 2 ? 150 : 0, by: 1,
} as FireEnt) as ViewEnt<FireEnt>;
if (type === 'barrel') props.add({ model: 'barrel', seed: 1, x: 0, y: 0, z: 0, yaw: 0.3, scale: 1 }, { lit: false });
if (type === 'stove') scene.add(standinStove());

// players: the local one (first person with &fp=1) and two others round the fire
const me = put(player(1, 0.3, 2.4, 0.15)) as ViewEnt<PlayerEnt>;
(view as any).me = me;
const fp = P('fp') === '1';
if (P('breath') === '1') {
  put(player(2, -1.6, 0.9, -1.9));
  put(player(3, 1.5, -1.1, 2.4));
} else if (!fp) me.feels = 12; // no breath from the invisible local player in a plain fire shot

// flare
const flareMode = Math.round(b.num('flare', 0));
let flare: ViewEnt<FlareEnt> | null = null;
if (flareMode > 0) {
  flare = put({ id: 20, kind: 'flare', x: 2.6, y: 0, z: 1.4, yaw: 0, rev: 0, vx: 0, vy: 0, vz: 0, life: 30, landed: flareMode === 1, by: 2 } as FlareEnt) as ViewEnt<FlareEnt>;
}

if (P('frost') || P('wet') || P('lsnow')) fx.forceOverlays(b.num('frost', 0), b.num('wet', 0), b.num('lsnow', 0));

// ---- clock, pre-roll, scripted moments ----
const warm = b.num('warm', 9);
let first = true;
let frameNo = 0;
const burst = P('fx') as BurstKind | null;
const framesWanted = Math.max(2, b.num('frames', 8));
const fwd = new THREE.Vector3();
let igniteT = 0;

function syncView(time: number, dt: number): void {
  (view as any).time = time;
  env.t = time;
  camera.updateMatrixWorld();
  camera.getWorldDirection(fwd);
  camState.x = camera.position.x;
  camState.y = camera.position.y;
  camState.z = camera.position.z;
  camState.yaw = Math.atan2(-fwd.x, -fwd.z);
  camState.pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
  // the bench camera is the goggles (overlays on) unless asked to be a third-person camera
  camState.third = P('third') === '1' ? 1 : 0;
  // the local player's breathing cycle (as the view rig does it)
  const r = view.rig;
  r.breath = (r.breath + (0.22 + 0.55 * (1 - me.stamina)) * dt) % 1;
  if (fp) {
    me.x = camera.position.x;
    me.z = camera.position.z;
    me.y = camera.position.y - 1.62;
    me.yaw = camState.yaw;
  }
  if (ignite) {
    // a match at 0.6 s for 1.2 s, lit at 1.8 s, the heat ramps like the sim (tau 22 s)
    igniteT += dt;
    const p2 = ents.get(1) as ViewEnt<PlayerEnt>;
    p2.act = igniteT > 0.6 && igniteT < 1.8 ? 'ignite' : 'none';
    p2.actT = Math.max(0, igniteT - 0.6);
    if (igniteT >= 1.8 && !fire.lit) {
      fire.lit = true;
      view.bus.emit('sim', { t: 'fireLit', id: fire.id, by: 1 });
    }
    if (fire.lit) fire.heat += (0.9 - fire.heat) * (1 - Math.exp(-dt / 22));
  }
  if (flare && flareMode === 2) {
    // a flare climbing and falling over the field
    const ft = (time % 6) / 6;
    flare.x = -6 + ft * 12;
    flare.y = 2 + Math.sin(ft * Math.PI) * 9;
    flare.z = -4;
    flare.vx = 2;
    flare.vy = Math.cos(ft * Math.PI) * 9 * Math.PI / 6;
    flare.vz = 0;
  }
}

b.onFrame((dt, time) => {
  if (first) {
    first = false;
    // simulate the particles for a while so the smoke column is there in the first frame
    const step = 1 / 30;
    for (let t = time - warm; t < time; t += step) {
      syncView(t, step);
      fx.update({ dt: step, time: t, view });
    }
  }
  syncView(time, dt);
  frameNo++;
  if (burst && frameNo === framesWanted - 2) {
    const tx = b.orbit.target.x, tz = b.orbit.target.z;
    if (burst === 'muzzle') view.bus.emit('sim', { t: 'shot', by: 2, x: tx - 0.6, y: 1.45, z: tz + 0.4, dx: 1, dy: 0.02, dz: -0.2, hx: tx + 30, hy: 0, hz: tz - 6, hit: 'ground' });
    else fx.burst(burst, tx, 0, tz, 0.3, 0.5, 0.8, 1.2);
  }
});

// a HUD line with the fx counts
const hudEl = document.createElement('div');
hudEl.style.cssText = 'position:fixed;right:8px;top:8px;color:#dfe5ec;font:11px/1.35 ui-monospace,Consolas,monospace;white-space:pre;pointer-events:none;text-shadow:0 1px 2px #000';
if (P('hud') === '1') document.body.appendChild(hudEl);
setInterval(() => {
  const i = fx.info;
  const c = fx.lights.counts;
  hudEl.textContent = `fx fires ${i.fires} flares ${i.flares}\npuffs ${i.puffs} glow ${i.glow} debris ${i.debris}\nlights ${c.point}p+${c.spot}s${c.shadow ? ' shadow' : ''}  active ${fx.lights.active.length}`;
}, 250);

function player(id: number, x: number, z: number, yaw: number): PlayerEnt {
  return {
    id, kind: 'player', x, y: 0, z, yaw, rev: 0, name: 'p' + id, slot: id % 4, bot: id !== 1,
    vx: 0, vy: 0, vz: 0, pitch: -0.1, onGround: true, crouch: false, sprint: false, surface: 'snow', swim: false, seq: 0,
    life: 'alive', health: 100, core: 36.5, wet: 0, stamina: id === 3 ? 0.3 : 0.9, hunger: 0,
    feels: -14, shelter: 0, fireHeat: 0, huddle: 0, trend: 0,
    bleed: 0, revive: 0, reviver: 0,
    inv: {}, held: 'hands', act: 'none', actT: 0, loaded: 0, flareLoaded: 0, lightOn: false, cellCharge: 1, radioCharge: 0, radioSig: 0, radioDist: -1, aim: 0, carry: 0,
    isolation: 0, kills: 0,
  };
}

/** A plain iron box stove with an open firebox door, so the stove fire can be judged here. */
function standinStove(): THREE.Group {
  const g = new THREE.Group();
  const iron = new THREE.MeshStandardNodeMaterial({ color: 0x1b1a19, roughness: 0.7, metalness: 0.6 });
  const W = 0.72, H = 0.85, y0 = 0.02;
  const add = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), iron);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
  };
  add(W, 0.04, W, 0, y0 + H, 0); // top
  add(W, 0.04, W, 0, y0 + 0.12, 0); // floor of the firebox
  add(0.04, H, W, -W / 2, y0 + H / 2, 0);
  add(0.04, H, W, W / 2, y0 + H / 2, 0);
  add(W, H, 0.04, 0, y0 + H / 2, -W / 2);
  // front: a frame round the open door
  add(W, 0.25, 0.04, 0, y0 + H - 0.125, W / 2);
  add(W, 0.18, 0.04, 0, y0 + 0.2, W / 2);
  add(0.16, 0.42, 0.04, -W / 2 + 0.08, y0 + 0.5, W / 2);
  add(0.16, 0.42, 0.04, W / 2 - 0.08, y0 + 0.5, W / 2);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 14), iron);
  pipe.position.set(0, y0 + H + 1.3, -0.15);
  g.add(pipe);
  return g;
}
