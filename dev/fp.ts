// Viewmodel bench: the first-person hands and tools on the bench snowfield, driven through a
// stand-in View exactly as the game drives the real system (src/actors/fp), with FX's light pool,
// a few props and an optional campfire.
//
//   dev/fp.html?tool=rifle&act=shoot             tool: axe | flashlight | flaregun | rifle | radio | hands
//   &act=idle|walk|sprint|aim|swing|shoot|dry|reload|crank|ignite|eat|thermos|bandage|use|revive|carry|downed|swim|equip
//   &at=0.35        freeze the act at this time (seconds into it); otherwise it loops
//   &light=day|dusk|night|storm|fire (fire: night with a campfire in front)
//   &cold=1 (shivering, cold sway)  &cell=0.1 (dying flashlight cell)  &sig=0.6 &charge=0.8 (radio)
//   &slot=0..3 (parka colour)  &fov=75 (player FOV)  &vmfov=62  &pitch=-10 &yaw=0 (degrees)
//   &orbit=1 &az &el &dist   dev: the viewmodel frozen in the world, seen by the orbit camera
//   &sheet=1 | tools | acts   a contact sheet of poses, one engine frame per tile
//   plus every createBench parameter (?q ?webgl=1 ?t ...).
// Owner: VIEWMODEL.
import * as THREE from 'three/webgpu';
import { createBench, type LightName } from './bench';
import { Bus } from '../src/core/bus';
import { createFxSystem } from '../src/gfx/fx';
import { createPropsSystem } from '../src/models/instances';
import '../src/models/props';
import '../src/models/tools';
import { createViewmodelSystem } from '../src/actors/fp';
import { makePlayer, makeFire, makePickup } from '../src/sim/entities';
import { BOLT_TIME, CELL_SWAP, FLARE_RECOVER, FLARE_RELOAD, RELOAD_CLOSE, RELOAD_OPEN, RELOAD_ROUND } from '../src/sim/systems/tools';
import { SWING_HIT, SWING_TIME } from '../src/sim/systems/wood';
import { EAT_TIME } from '../src/sim/systems/items';
import { IGNITE_TIME } from '../src/sim/systems/fire';
import type { Frame } from '../src/gfx/api';
import type { GameBus, Hud, View, ViewEnt } from '../src/game/view';
import type { Entity, EntityKind, Env, LogEnt, PlayerEnt, SimEvent, ToolId } from '../src/sim/types';
import type { World } from '../src/world/types';

const Q = new URLSearchParams(location.search);
const lightParam = Q.get('light') ?? 'dusk';
const sheet = Q.get('sheet');
if (sheet && !Q.has('gpu')) {
  // many engine frames run back to back in one task: no GPU timer queries
  const u = new URL(location.href);
  u.searchParams.set('gpu', '0');
  history.replaceState(null, '', u);
}
const b = await createBench({ light: (lightParam === 'fire' ? 'night' : lightParam) as LightName, orbit: false });
const { engine, scene, camera, canvas } = b;
const num = (n: string, f: number): number => b.num(n, f);

// ---- a flat stand-in world ----
const world = {
  seed: 1, size: 1600, half: 800,
  heightAt: () => 0,
  groundAt: () => ({ y: 0, surface: 'snow' as const }),
  normalAt: () => ({ x: 0, y: 1, z: 0 }),
  slopeAt: () => 0,
  snowDepthAt: () => 0.3,
  surfaceAt: () => 'snow' as const,
  forestAt: () => 0,
  raycast: () => null,
  lineClear: () => true,
  pois: [],
  lake: { x: 0, z: 0, level: 0, n: 1, cell: 1, minX: 0, minZ: 0, thickness: new Float32Array(1) },
  props: [],
} as unknown as World;

// ---- the stand-in view ----
const stormy = lightParam === 'storm';
const env: Env = {
  t: 100, clock: 18, day: 0, storm: stormy ? 0.85 : 0.1,
  windX: stormy ? 9 : 2, windZ: 1, gust: stormy ? 0.5 : 0, snowfall: stormy ? 1 : 0,
  visibility: stormy ? 60 : 4000, airTemp: -14, cloud: 0.3, aurora: 0, snowAccum: 0,
};
const hud: Hud = { focus: null, crosshair: 'none', heading: 0, marks: [], place: '', hint: '', objective: '', frost: 0, wetLens: 0, hurt: 0, lowHealth: 0, whiteout: 0 };
const ents = new Map<number, ViewEnt>();
const lists = new Map<EntityKind, ViewEnt[]>();
let nextId = 1;
function put<E extends Entity>(e: E): ViewEnt<E> {
  e.id = nextId++;
  const v = Object.assign(e, { age: 30 }) as ViewEnt<E>;
  ents.set(e.id, v as ViewEnt);
  if (!lists.has(e.kind)) lists.set(e.kind, []);
  lists.get(e.kind)!.push(v as ViewEnt);
  return v;
}
const EYE = 1.66;
const me = put(makePlayer('Me', num('slot', 0), 0, 0, 3, 0)) as ViewEnt<PlayerEnt>;
me.inv = { axe: 1, flashlight: 1, flaregun: 1, rifle: 1, radio: 1, ammo: 12, flare: 4, cell: 2, matches: 6, ration: 3, thermos: 2, bandage: 3 };
const camState = { x: 0, y: EYE, z: 3, yaw: 0, pitch: 0, roll: 0, fov: num('fov', 75), third: 0 };
const bus = new Bus<GameBus>();
const view = {
  world, bus,
  settings: { quality: 'medium', renderScale: 1, fov: camState.fov, sensitivity: 1, invertY: false, master: 1, music: 1, sfx: 1, shake: true, grain: true, hints: true, bots: 0, showFps: false },
  touch: false, mode: 'play', time: 0, env,
  objective: { stage: 'search', parts: { battery: 'lost', handset: 'lost', coil: 'lost', tube: 'lost', fuse: 'lost' }, generator: 0, transmit: 0, eta: -1, signalled: false },
  stats: { distance: 0, firesLit: 0, wolvesKilled: 0, revives: 0, downs: 0, coldest: 37, shots: 0 },
  me, myId: me.id, ents,
  list: (kind: EntityKind) => lists.get(kind) ?? [],
  ice: new Map(), camera: camState, hud,
  rig: { bob: 0, stride: 0, speed: 0, recoil: 0, sway: 0, breath: 0, shiver: 0, landing: 0 },
} as unknown as View;
const engineFrame = engine.frame.bind(engine);
engine.frame = (f: Frame) => {
  f.view = view;
  engineFrame(f);
};

// ---- the scene in front: props, a fire, tools lying in the snow ----
const props = createPropsSystem({ scene, camera }, [
  { model: 'crate', x: 1.1, y: 0, z: 0.6, yaw: 0.4, seed: 1 },
  { model: 'barrel', x: -1.6, y: 0, z: -1.2, yaw: 0, seed: 0, opts: { lit: false } },
  { model: 'log_heavy', x: 0.2, y: 0, z: -2.6, yaw: 1.2, seed: 2 },
] as never, { shadows: true });
engine.add(props);
if (lightParam === 'fire') {
  const f = put(makeFire('campfire', 0.35, 0, 0.8));
  f.lit = true; f.heat = 0.9; f.size = 0.7; f.fuel = 600;
}
put(makePickup('rifle', 1, -0.9, 0, 1.2, { yaw: 0.6, lie: 'ground' }));
put(makePickup('axe', 1, 0.9, 0, 1.7, { yaw: -0.4, lie: 'snow' }));
const fx = createFxSystem(engine, world);
engine.add(fx);
const vm = createViewmodelSystem(engine, world);
vm.fov = num('vmfov', 62);
engine.add(vm);
(window as any).VM = vm;
(window as any).VIEW = view;

// ---- the act being shown ----
type Act = 'idle' | 'walk' | 'sprint' | 'aim' | 'swing' | 'shoot' | 'dry' | 'reload' | 'crank' | 'ignite' | 'eat' | 'thermos' | 'bandage' | 'use' | 'revive' | 'carry' | 'downed' | 'swim' | 'equip';

interface Shot { tool: ToolId; act: Act; at: number | null }

function actLength(tool: ToolId, act: Act): number {
  switch (act) {
    case 'swing': return SWING_TIME;
    case 'shoot': return tool === 'rifle' ? BOLT_TIME : FLARE_RECOVER;
    case 'reload': return tool === 'rifle' ? RELOAD_OPEN + 3 * RELOAD_ROUND + RELOAD_CLOSE : tool === 'flaregun' ? FLARE_RELOAD : CELL_SWAP;
    case 'ignite': return IGNITE_TIME;
    case 'eat': case 'thermos': case 'bandage': return EAT_TIME;
    case 'use': return 0.6;
    case 'equip': return 1.2;
    default: return 2.4;
  }
}

let log: ViewEnt<LogEnt> | null = null;
let lastT = -1;
// events go straight to the animator (on the bus FX would answer them: a flare light lingering
// from one contact-sheet tile to the next); &fx=1 sends them through the bus as the game does
const emit = (ev: SimEvent): void => {
  if (Q.get('fx') === '1') bus.emit('sim', ev);
  else vm.anim.event(ev.t, ev.t === 'swing' ? ev.hit : undefined);
};

/** Put the stand-in player in the state of `s` at act time t (seconds). */
function pose(s: Shot, t: number, dt: number): void {
  const { tool, act } = s;
  me.held = act === 'carry' || act === 'downed' || act === 'swim' ? 'hands' : tool;
  me.act = 'none';
  me.actT = 0;
  me.aim = act === 'aim' ? Math.min(1, t / 0.3) : 0;
  me.sprint = act === 'sprint';
  me.lightOn = tool === 'flashlight';
  me.cellCharge = num('cell', 0.9);
  me.beam = me.lightOn ? (me.cellCharge >= 0.25 ? 1 : 0.2 + 0.8 * (me.cellCharge / 0.25)) : 0;
  me.radioCharge = num('charge', 0.8);
  me.radioSig = Q.has('sig') ? num('sig', 0.5) : 0.5 + 0.45 * Math.sin(t * 0.9);
  me.loaded = 5;
  me.flareLoaded = 1;
  me.life = act === 'downed' ? 'downed' : 'alive';
  me.swim = act === 'swim';
  me.carry = 0;
  const L = actLength(tool, act);
  const at = t;
  switch (act) {
    case 'swing': me.act = 'swing'; me.actT = at; if (lastT < SWING_HIT && at >= SWING_HIT) emit({ t: 'swing', by: me.id, hit: 'wood', x: 0, y: 1, z: 1 }); break;
    case 'shoot':
      me.act = 'shoot'; me.actT = at;
      if (lastT > at || lastT < 0) emit(tool === 'rifle' ? { t: 'shot', by: me.id, x: 0, y: EYE, z: 3, dx: 0, dy: 0, dz: -1, hx: 0, hy: EYE, hz: -50, hit: 'none' } : { t: 'flareShot', by: me.id, id: 0 });
      if (tool === 'rifle') me.loaded = 4; else me.flareLoaded = 0;
      break;
    case 'dry': if (lastT > at || lastT < 0) emit({ t: 'dry', by: me.id }); me.loaded = 0; break;
    case 'reload': {
      me.act = 'reload'; me.actT = at;
      if (tool === 'rifle') {
        const n = at < RELOAD_OPEN + RELOAD_ROUND ? 0 : Math.min(3, 1 + Math.floor((at - RELOAD_OPEN - RELOAD_ROUND) / RELOAD_ROUND));
        me.loaded = 2 + n;
        me.inv.ammo = n >= 3 ? 0 : 3 - n;
      } else if (tool === 'flaregun') me.flareLoaded = at > 0.9 ? 1 : 0;
      break;
    }
    case 'crank': me.act = 'crank'; me.actT = at; break;
    case 'ignite': me.act = 'ignite'; me.actT = at; break;
    case 'eat': case 'thermos': case 'bandage': {
      // the item leaves the pack as the act starts (that is how the animator knows which)
      const item = act === 'eat' ? 'ration' : act;
      if (at < 1 / 120) me.inv[item] = 3;
      else {
        me.inv[item] = 2;
        me.act = 'eat';
        me.actT = at;
      }
      break;
    }
    case 'use': me.act = 'use'; me.actT = at; break;
    case 'revive': me.act = 'revive'; me.actT = at; break;
    case 'carry': {
      if (!log) {
        log = put({ id: 0, kind: 'log', x: 0, y: 0.6, z: 3 - 1.8, yaw: 0, rev: 0, a: 0, b: 0, len: 3.2, burn: 700 } as LogEnt);
      }
      me.carry = log.id;
      log.b = me.id;
      // the log ahead, its back end in the hands
      log.x = 0.05; log.z = 3 - 0.45 - 1.6; log.y = 0.95; log.yaw = 0;
      break;
    }
    case 'equip': {
      // switch tools every 1.2 s: down, the next one up
      const order: ToolId[] = ['axe', 'flashlight', 'flaregun', 'rifle', 'radio'];
      const i = Math.floor(t / 1.2) % order.length;
      me.held = order[i];
      me.lightOn = me.held === 'flashlight';
      break;
    }
  }
  void L;
  lastT = at;
  // walking / sprinting: the rig's stride and bob as the game makes them
  const rig = view.rig;
  const moving = act === 'walk' || act === 'sprint' || act === 'carry';
  const sp = act === 'sprint' ? 4.6 : moving ? 2.4 : 0;
  rig.speed = sp;
  rig.stride = moving ? Math.min(1, sp / 4.6) : 0;
  rig.bob = moving ? ((t * sp) / (2 * (0.55 + 0.11 * sp))) % 1 : 0;
  rig.breath = (t * (0.22 + (act === 'sprint' ? 0.25 : 0))) % 1;
  rig.shiver = Q.get('cold') === '1' ? 1 : 0;
  rig.sway = Q.get('cold') === '1' ? 0.7 : 0;
  me.vx = 0; me.vz = moving ? -sp : 0;
  void dt;
}

function placeCamera(): void {
  const pitch = (num('pitch', -6) * Math.PI) / 180, yaw = (num('yaw', 0) * Math.PI) / 180;
  const downed = me.life === 'downed';
  camState.x = 0; camState.y = downed ? 0.38 : me.swim ? 1.46 : EYE; camState.z = 3;
  camState.yaw = yaw; camState.pitch = pitch; camState.roll = 0; camState.fov = num('fov', 75);
  camera.position.set(camState.x, camState.y, camState.z);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
  camera.fov = camState.fov;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  // the bench sun's shadow box follows its orbit target: keep it in front of us
  b.orbit.target.set(0, 0.5, 1.2);
}

const tool0 = (Q.get('tool') ?? 'flashlight') as ToolId;
const act0 = (Q.get('act') ?? 'idle') as Act;
const at0 = Q.has('at') ? num('at', 0) : null;

if (Q.get('orbit') === '1') {
  // dev: the viewmodel frozen where the eye was, looked at by the bench's orbit camera
  // (&az &el &dist about a point 30 cm in front of the eye)
  const shot: Shot = { tool: tool0, act: act0, at: at0 };
  const eye = new THREE.Object3D();
  eye.position.set(0, EYE, 3);
  eye.rotation.set((num('pitch', -6) * Math.PI) / 180, (num('yaw', 0) * Math.PI) / 180, 0, 'YXZ');
  eye.updateMatrixWorld();
  camera.remove(vm.root);
  scene.add(vm.root);
  vm.root.matrix.copy(eye.matrixWorld);
  vm.debugFree = true;
  b.orbit.target.set(0.06, EYE - 0.16, 3 - 0.34);
  b.orbit.az = num('az', 120);
  b.orbit.el = num('el', 10);
  b.orbit.dist = num('dist', 0.75);
  camera.near = 0.02;
  camera.fov = 50;
  camera.updateProjectionMatrix();
  let first = true;
  b.onFrame((dt, time) => {
    const L = actLength(shot.tool, shot.act);
    const loopT = shot.at !== null ? shot.at : (time % (L + 0.7));
    pose(shot, Math.min(loopT, L), dt);
    if (first) {
      first = false;
      vm.anim.snap(me);
    }
    view.time = time;
    camera.near = 0.02;
    camera.updateProjectionMatrix();
  });
} else if (!sheet) {
  const shot: Shot = { tool: tool0, act: act0, at: at0 };
  let first = true;
  b.onFrame((dt, time) => {
    const L = actLength(shot.tool, shot.act);
    const loopT = shot.at !== null ? shot.at : (time % (L + 0.7));
    pose(shot, Math.min(loopT, L), dt);
    if (first) {
      first = false;
      vm.anim.snap(me);
    }
    view.time = time;
    placeCamera();
  });
} else {
  // ---- contact sheet ----
  const cells: Shot[] = [];
  const add = (tool: ToolId, act: Act, at: number | null): void => {
    cells.push({ tool, act, at });
  };
  if (sheet === '1' || sheet === 'tools') {
    add('axe', 'idle', null); add('axe', 'swing', 0.17); add('axe', 'swing', SWING_HIT); add('axe', 'swing', 0.5);
    add('flashlight', 'idle', null); add('flashlight', 'aim', 0.6); add('flashlight', 'reload', 0.35); add('flashlight', 'reload', 0.62);
    add('flaregun', 'idle', null); add('flaregun', 'shoot', 0.06); add('flaregun', 'reload', 0.5); add('flaregun', 'reload', 0.72);
    add('rifle', 'idle', null); add('rifle', 'aim', 0.18); add('rifle', 'shoot', 0.5); add('rifle', 'reload', 1.1);
    add('radio', 'idle', null); add('radio', 'crank', 0.4); add('radio', 'aim', 0.6); add('rifle', 'aim', 0.6);
  }
  if (sheet === '1' || sheet === 'acts') {
    add('hands', 'ignite', 0.3); add('hands', 'ignite', 0.62); add('hands', 'eat', 0.7); add('hands', 'thermos', 0.8);
    add('hands', 'bandage', 0.6); add('hands', 'use', 0.4); add('hands', 'revive', 1.0); add('hands', 'carry', 1.0);
    add('rifle', 'sprint', 0.3); add('hands', 'downed', 0.6); add('hands', 'swim', 0.6); add('axe', 'walk', 0.4);
  }
  // &cells=tool:act:at,tool:act:at ... (at may be empty: idle loops run 1 s)
  for (const c of (Q.get('cells') ?? '').split(',').filter(Boolean)) {
    const [tool, act, at] = c.split(':');
    add(tool as ToolId, (act || 'idle') as Act, at ? Number(at) : null);
  }
  const n = cells.length;
  const cols = Q.has('cols') ? num('cols', 4) : n <= 4 ? 2 : n <= 9 ? 3 : n <= 12 ? 4 : n <= 20 ? 5 : 6;
  const rowsN = Math.ceil(n / cols);
  const overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
  document.body.appendChild(overlay);
  let release: () => void = () => {};
  b.busy(new Promise<void>((ok) => (release = ok)));
  let done = false;
  let frames = 0;
  b.onFrame((_dt, time) => {
    placeCamera();
    if (++frames < 3 || done) return;
    done = true;
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const ctx = overlay.getContext('2d')!;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const tw = W / cols, th = H / rowsN;
    const k = canvas.width / W;
    const f: Frame = { dt: 1 / 60, time, view };
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      lastT = -1;
      // play the act from its start up to the frozen moment, so springs and eased values are where
      // they would be live (and the animator sees the act begin, as in the game)
      const at = c.at ?? 1.0;
      const steps = Math.max(2, Math.ceil(at * 60));
      for (let s = 0; s <= steps; s++) {
        const t = (at * s) / steps;
        pose(c, t, at / steps);
        if (s === 0) vm.anim.snap(me);
        view.time = time + t;
        f.time = time + t;
        placeCamera();
        if (s < steps) vm.update(f);
      }
      for (let r = 0; r < 2; r++) engine.frame(f);
      // a crop of the frame with the tile's aspect, keeping the bottom (where the hands are)
      const ta = tw / th, ca = W / H;
      let sw: number, sh: number, sx: number, sy: number;
      if (ta < ca) { sh = canvas.height; sw = sh * ta; sx = (canvas.width - sw) * 0.6; sy = 0; }
      else { sw = canvas.width; sh = sw / ta; sx = 0; sy = canvas.height - sh; }
      const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
      ctx.drawImage(canvas, sx, sy, sw, sh, x * k, y * k, tw * k, th * k);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x * k, y * k, 190 * k, 18 * k);
      ctx.fillStyle = '#e8ecf0';
      ctx.font = `${11 * k}px monospace`;
      ctx.fillText(`${c.tool} ${c.act}${c.at !== null ? ' @' + c.at.toFixed(2) : ''}`, (x + 5) * k, (y + 13) * k);
    }
    release();
  });
}
