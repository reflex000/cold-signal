// Bench for the figures (src/actors): the parka players and the wolves, animated from scripted
// entity states through the real actors system, on the real engine (dev/bench.ts).
//
//   dev/actors.html?show=all|player|wolf|pack   ?anim=<name>   ?slot=0..3   ?light=day|dusk|night|storm
//                  ?sheet=1 (contact sheet: every animation at a few phases)   ?sheet=player|wolf
//                  ?phases=0.4,1.1   ?lod=0..2 (force a level of detail)   ?webgl=1   ?q=<tier>
//   ?anim= player: idle cold walk run sprint wade crouch crouchwalk strafe back turn jump crawl downed dead
//          revive carry axe rifle aim shoot reload flashlight flare flarefire radio crank eat use ignite swim
//          wolf: w-idle w-walk w-trot w-gallop w-stalk w-circle w-howl w-snarl w-bite w-yelp w-cower w-rest
//          w-sleep w-dead w-drag w-flee w-feed
// The page sets window.DONE once its picture is on screen.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { Frame } from '../src/gfx/api';
import type { View, ViewEnt } from '../src/game/view';
import type { Entity, EntityKind, LogEnt, PlayerEnt, WolfEnt } from '../src/sim/types';
import { createActorsSystem } from '../src/actors';
import { PLAYER_SKEL } from '../src/actors/player_model';
import { WOLF_SKEL } from '../src/actors/wolf_model';
import { createBench } from './bench';

const info = document.getElementById('info')!;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

let nextId = 1;
function player(slot: number): PlayerEnt {
  return {
    id: nextId++, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, rev: 0, name: 'p' + slot, slot, bot: false,
    vx: 0, vy: 0, vz: 0, pitch: 0, onGround: true, crouch: false, sprint: false, surface: 'snow', swim: false, seq: 0,
    life: 'alive', health: 100, core: 37, wet: 0, stamina: 1, hunger: 0, feels: -10, shelter: 0, fireHeat: 0, huddle: 0, trend: 0,
    bleed: 0, revive: 0, reviver: 0, inv: {}, held: 'hands', act: 'none', actT: 0, loaded: 5, flareLoaded: 1, lightOn: false,
    cellCharge: 1, radioCharge: 1, radioSig: 0, radioDist: -1, aim: 0, carry: 0, isolation: 0, kills: 0,
  };
}
function wolf(variant: number, alpha = false): WolfEnt {
  return { id: nextId++, kind: 'wolf', x: 0, y: 0, z: 0, yaw: 0, rev: 0, pack: 0, alpha, mood: 'roam', moodT: 0, target: 0, vx: 0, vz: 0, speed: 0, health: 100, fear: 0, hunger: 0.5, variant };
}
function log(): LogEnt {
  return { id: nextId++, kind: 'log', x: 0, y: 0, z: 0, yaw: 0, rev: 0, a: 0, b: 0, len: 2.4, burn: 720 };
}

type Script = (t: number, ents: Entity[]) => void;
interface Anim { kind: 'player' | 'wolf'; script: Script; extra?: () => Entity[]; dist?: number }

/** Move along the facing at speed v (yaw 0 = north). */
function go(e: PlayerEnt | WolfEnt, t: number, v: number, yaw = 0): void {
  e.yaw = yaw;
  e.vx = -Math.sin(yaw) * v;
  e.vz = -Math.cos(yaw) * v;
  e.x = e.vx * t;
  e.z = e.vz * t;
  if (e.kind === 'wolf') e.speed = v;
}
const P = (s: (e: PlayerEnt, t: number, all: Entity[]) => void): Script => (t, ents) => s(ents[0] as PlayerEnt, t, ents);
const W = (s: (e: WolfEnt, t: number, all: Entity[]) => void): Script => (t, ents) => s(ents[0] as WolfEnt, t, ents);

const ANIMS: Record<string, Anim> = {
  idle: { kind: 'player', script: P((e, t) => { e.pitch = Math.sin(t * 0.5) * 0.15; e.yaw = Math.sin(t * 0.3) * 0.6; }) },
  cold: { kind: 'player', script: P((e) => { e.core = 34.2; e.stamina = 0.4; }) },
  walk: { kind: 'player', script: P((e, t) => go(e, t, 2.6)) },
  run: { kind: 'player', script: P((e, t) => { go(e, t, 3.8); e.sprint = true; }) },
  sprint: { kind: 'player', script: P((e, t) => { go(e, t, 4.6); e.sprint = true; e.stamina = 0.6; }) },
  wade: { kind: 'player', script: P((e, t) => { go(e, t, 1.2); e.surface = 'deep'; }) },
  crouch: { kind: 'player', script: P((e) => { e.crouch = true; }) },
  crouchwalk: { kind: 'player', script: P((e, t) => { go(e, t, 1.3); e.crouch = true; }) },
  strafe: { kind: 'player', script: P((e, t) => { e.yaw = 0; e.vx = 2.2; e.vz = 0; e.x = 2.2 * t; e.z = 0; }) },
  back: { kind: 'player', script: P((e, t) => { e.yaw = 0; e.vx = 0; e.vz = 1.8; e.z = 1.8 * t; }) },
  turn: { kind: 'player', script: P((e, t) => { e.yaw = Math.min(2.4, t * 1.6); }) },
  jump: { kind: 'player', script: P((e, t) => {
    const tt = t % 1.6;
    go(e, t, 2.2);
    const air = tt > 0.4 && tt < 1.0;
    const u = (tt - 0.4) / 0.6;
    e.y = air ? 4.3 * u * 0.6 - 0.5 * 14 * (u * 0.6) ** 2 : 0;
    e.y = Math.max(0, e.y);
    e.onGround = !air;
    e.vy = air ? 4.3 - 14 * u * 0.6 : 0;
  }) },
  crawl: { kind: 'player', script: P((e, t) => { go(e, t, 0.5); e.life = 'downed'; e.bleed = 60; }) },
  downed: { kind: 'player', script: P((e) => { e.life = 'downed'; e.bleed = 60; }) },
  dead: { kind: 'player', script: P((e) => { e.life = 'dead'; }) },
  revive: {
    kind: 'player',
    extra: () => { const d = player(2); d.life = 'downed'; d.x = 0.25; d.z = -1.05; d.yaw = Math.PI * 0.5; return [d]; },
    script: P((e, t, all) => { const d = all[1] as PlayerEnt; e.act = 'revive'; e.actT = t; d.reviver = e.id; d.revive = Math.min(1, t / 5); e.yaw = Math.atan2(-(d.x - e.x), -(d.z - e.z)); }),
  },
  carry: {
    kind: 'player',
    extra: () => { const l = log(); return [l]; },
    script: P((e, t, all) => { go(e, t, 1.2); const l = all[1] as LogEnt; e.carry = l.id; l.yaw = 0; l.x = e.x; l.z = e.z + 1.35; l.y = 0; l.a = e.id; }),
  },
  axe: { kind: 'player', script: P((e, t) => { e.held = 'axe'; e.act = 'swing'; e.actT = t % 1.1; if (e.actT > 0.8) e.act = 'none'; }) },
  rifle: { kind: 'player', script: P((e, t) => { e.held = 'rifle'; go(e, t, 1.4); }) },
  aim: { kind: 'player', script: P((e, t) => { e.held = 'rifle'; e.aim = Math.min(1, t * 3); e.pitch = 0.05; e.yaw = Math.sin(t * 0.4) * 0.3; }) },
  shoot: { kind: 'player', script: P((e, t) => { e.held = 'rifle'; e.aim = 1; const tt = t % 1.6; e.act = tt < 1.2 ? 'shoot' : 'none'; e.actT = tt; }) },
  reload: { kind: 'player', script: P((e, t) => { e.held = 'rifle'; e.act = 'reload'; e.actT = t % 2.5; }) },
  flashlight: { kind: 'player', script: P((e, t) => { e.held = 'flashlight'; e.lightOn = true; e.pitch = -0.15 + Math.sin(t) * 0.1; e.yaw = Math.sin(t * 0.5) * 0.4; }) },
  flare: { kind: 'player', script: P((e, t) => { e.held = 'flaregun'; e.aim = Math.min(1, t * 2); e.pitch = 0.5; }) },
  flarefire: { kind: 'player', script: P((e, t) => { e.held = 'flaregun'; e.aim = 1; e.pitch = 0.6; const tt = t % 1.4; e.act = tt < 0.6 ? 'shoot' : 'none'; e.actT = tt; }) },
  radio: { kind: 'player', script: P((e, t) => { e.held = 'radio'; e.aim = t > 1 ? 1 : 0; e.yaw = Math.sin(t * 0.6) * 0.8; }) },
  crank: { kind: 'player', script: P((e, t) => { e.held = 'radio'; e.act = 'crank'; e.actT = t; }) },
  eat: { kind: 'player', script: P((e, t) => { e.act = 'eat'; e.actT = t % 1.6; }) },
  use: { kind: 'player', script: P((e, t) => { e.act = 'use'; e.actT = t % 0.8; }) },
  ignite: { kind: 'player', script: P((e, t) => { e.act = 'ignite'; e.actT = t % 1.2; e.pitch = -0.7; }) },
  swim: { kind: 'player', script: P((e) => { e.swim = true; e.onGround = false; e.y = -1.3; e.surface = 'water'; }) },
  // ---- wolves ----
  'w-idle': { kind: 'wolf', script: W((e) => { e.mood = 'roam'; }) },
  'w-walk': { kind: 'wolf', script: W((e, t) => { e.mood = 'roam'; go(e, t, 1.5); }) },
  'w-trot': { kind: 'wolf', script: W((e, t) => { e.mood = 'roam'; go(e, t, 4); }) },
  'w-gallop': { kind: 'wolf', script: W((e, t) => { e.mood = 'charge'; go(e, t, 11); }), dist: 5 },
  'w-stalk': { kind: 'wolf', script: W((e, t) => { e.mood = 'stalk'; go(e, t, 0.9); }) },
  'w-circle': { kind: 'wolf', extra: () => [player(1)], script: W((e, t, all) => {
    const p = all[1] as PlayerEnt;
    p.x = 0; p.z = 0;
    const a = t * 0.25, r = 6;
    e.mood = 'circle'; e.target = p.id;
    e.x = Math.sin(a) * r; e.z = Math.cos(a) * r;
    e.yaw = a + Math.PI / 2 - Math.PI;
    e.vx = Math.cos(a) * r * 0.25; e.vz = -Math.sin(a) * r * 0.25; e.speed = r * 0.25 * 1.0;
  }) },
  'w-howl': { kind: 'wolf', script: W((e, t) => { e.mood = 'howl'; e.moodT = t; }) },
  'w-snarl': { kind: 'wolf', extra: () => [player(1)], script: W((e, t, all) => { const p = all[1] as PlayerEnt; p.z = -5; e.mood = 'stalk'; e.target = p.id; e.moodT = t; }) },
  'w-bite': { kind: 'wolf', extra: () => [player(1)], script: W((e, t, all) => { const p = all[1] as PlayerEnt; p.z = -1.3; p.yaw = Math.PI; e.mood = 'bite'; e.target = p.id; e.moodT = t % 1.2; }) },
  'w-yelp': { kind: 'wolf', script: W((e) => { e.mood = 'flee'; }) },
  'w-cower': { kind: 'wolf', extra: () => [player(1)], script: W((e, t, all) => { const p = all[1] as PlayerEnt; p.z = -4; e.mood = 'cower'; e.target = p.id; }) },
  'w-rest': { kind: 'wolf', script: W((e, t) => { e.mood = 'rest'; e.moodT = t; }) },
  'w-sleep': { kind: 'wolf', script: W((e, t) => { e.mood = 'rest'; e.moodT = 40 + t; }) },
  'w-dead': { kind: 'wolf', script: W((e) => { e.mood = 'dead'; e.health = 0; }) },
  'w-drag': { kind: 'wolf', script: W((e, t) => { e.mood = 'drag'; e.yaw = 0; e.vx = 0; e.vz = 1.0; e.z = 1.0 * t; e.speed = 1; }) },
  'w-flee': { kind: 'wolf', script: W((e, t) => { e.mood = 'flee'; go(e, t, 9, Math.PI); }), dist: 5 },
  'w-feed': { kind: 'wolf', script: W((e) => { e.mood = 'feed'; }) },
};

// ---------------------------------------------------------------------------------------------
// A view the actors system can read
// ---------------------------------------------------------------------------------------------

function makeView(): View & { set(ents: Entity[]): void } {
  let ents: Entity[] = [];
  const map = new Map<number, ViewEnt>();
  const lists: Record<string, ViewEnt[]> = {};
  const view = {
    world: null, bus: { on: () => () => {}, emit: () => {} }, settings: {}, touch: false, mode: 'play', time: 0,
    env: {}, objective: {}, stats: {}, me: null, myId: -1, ents: map, ice: new Map(),
    camera: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 55, third: 1 },
    hud: {}, rig: {},
    list(kind: EntityKind) {
      return (lists[kind] ?? []) as never;
    },
    set(next: Entity[]) {
      ents = next;
      map.clear();
      for (const k of Object.keys(lists)) lists[k].length = 0;
      for (const e of ents) {
        const v = e as ViewEnt;
        (v as { age: number }).age = 1;
        map.set(e.id, v);
        (lists[e.kind] ??= []).push(v);
      }
    },
  };
  return view as unknown as View & { set(ents: Entity[]): void };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const bench = await createBench({ light: 'dusk' });
  const { engine, camera, canvas } = bench;
  const sys = createActorsSystem(engine, null);
  const view = makeView();
  const forced = bench.param('lod');
  if (forced !== null) sys.forceLod = Number(forced);
  sys.bindPose = bench.param('bind') === '1';
  if (bench.param('sil') === '1') {
    // silhouettes: flat black figures on white, no ground
    sys.setSilhouette(true);
    bench.scene.backgroundNode = (TSL as any).vec3(2.2, 2.2, 2.2);
    const g = bench.scene.getObjectByName('bench-ground');
    if (g) g.visible = false;
  }
  // the system reads the fake view through this wrapper (the bench's frames carry no view)
  let current: Entity[] = [];
  let script: ((t: number) => void) | null = null;
  let cpuMs = 0;
  engine.add({
    name: 'actors-bench',
    update: (f: Frame) => {
      if (script) script(f.time);
      view.set(current);
      const t0 = performance.now();
      sys.update({ dt: f.dt, time: f.time, view });
      cpuMs += (performance.now() - t0 - cpuMs) * 0.1;
    },
  });

  const sheet = bench.param('sheet');
  const show = bench.param('show') ?? 'all';
  const animName = bench.param('anim');
  const slot = bench.num('slot', 0);

  const setup = (name: string, sl: number): { ents: Entity[]; run: (t: number) => void; anim: Anim } => {
    const a = ANIMS[name] ?? ANIMS.idle;
    const main = a.kind === 'player' ? player(sl) : wolf(sl * 7 + 3, false);
    const ents: Entity[] = [main, ...(a.extra ? a.extra() : [])];
    return { ents, run: (t: number) => a.script(t, ents), anim: a };
  };

  if (sheet) {
    // ---------------- contact sheet ----------------
    const list = Object.keys(ANIMS).filter((n) => (sheet === 'player' ? ANIMS[n].kind === 'player' : sheet === 'wolf' ? ANIMS[n].kind === 'wolf' : true));
    const phases = (bench.param('phases') ?? '0.45,1.2').split(',').map(Number);
    const tiles: { name: string; t: number }[] = [];
    for (const n of list) for (const p of phases) tiles.push({ name: n, t: p });
    const cols = Math.ceil(Math.sqrt(tiles.length * 1.6));
    const rows = Math.ceil(tiles.length / cols);
    const overlay = document.createElement('canvas');
    overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
    document.body.appendChild(overlay);
    const tagBox = document.createElement('div');
    document.body.appendChild(tagBox);
    let done = false;
    let held = false;
    bench.onFrame(() => {
      if (done) return;
      done = true;
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      const ctx = overlay.getContext('2d')!;
      const Wc = canvas.clientWidth, Hc = canvas.clientHeight;
      const tw = Wc / cols, th = Hc / rows;
      const kpx = canvas.width / Wc;
      script = null;
      let draws = 0;
      tiles.forEach((tile, i) => {
        const s = setup(tile.name, i % 4);
        current = s.ents;
        // simulate from 0 to the phase without drawing
        const dt = 1 / 30;
        for (let t = 0; t <= tile.t + 1e-6; t += dt) {
          s.run(t);
          view.set(current);
          sys.update({ dt, time: t, view });
        }
        // frame the figure: three-quarter front, figure height fills the tile
        const e = s.ents[0] as PlayerEnt | WolfEnt;
        const isWolf = e.kind === 'wolf';
        const cy = isWolf ? 0.55 : 0.95;
        const side = bench.param('side') === '1';
        const dist = (isWolf ? 3.2 : 3.4) * (s.anim.dist ? 1.15 : 1);
        const az = e.yaw + (side ? 90 : isWolf ? 70 : 35) * DEG;
        const c = new THREE.Vector3(e.x, (e.kind === 'player' ? Math.max(0, e.y) : e.y) + cy, e.z);
        camera.position.set(c.x - Math.sin(az) * dist, c.y + (side ? 0.05 : 0.6), c.z - Math.cos(az) * dist);
        camera.lookAt(c);
        bench.orbit.target.copy(c);
        for (let k = 0; k < 2; k++) engine.frame({ dt: 0, time: tile.t, view: undefined as unknown as View });
        draws = Math.max(draws, engine.stats.calls);
        // the frame was rendered at the canvas aspect: take the centre crop of the tile's aspect
        const fullA = canvas.width / canvas.height, tileA = tw / th;
        const sw = tileA < fullA ? canvas.height * tileA : canvas.width;
        const sh = tileA < fullA ? canvas.height : canvas.width / tileA;
        ctx.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, (i % cols) * tw * kpx, Math.floor(i / cols) * th * kpx, tw * kpx, th * kpx);
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.style.left = `${(i % cols) * tw + 4}px`;
        tag.style.top = `${Math.floor(i / cols) * th + 2}px`;
        tag.textContent = `${tile.name} ${tile.t.toFixed(2)}s`;
        tagBox.appendChild(tag);
      });
      info.textContent = `${engine.backend} ${engine.quality.name} ${bench.light}  ${tiles.length} tiles  max ${draws} calls`;
      held = true;
      // the overlay holds the sheet: stop drawing so the page is idle for the screenshot
      (engine as unknown as { frame: () => void }).frame = () => {};
    });
    // hold DONE until the sheet is drawn
    bench.busy(new Promise<void>((res) => {
      const check = (): void => (held ? res() : void requestAnimationFrame(check));
      check();
    }));
    return;
  }

  // ---------------- one scene ----------------
  const scripts: ((t: number) => void)[] = [];
  const all: Entity[] = [];
  const place = (name: string, sl: number, x: number, z: number, yaw = 0): void => {
    const s = setup(name, sl);
    const dx = x, dz = z;
    scripts.push((t) => {
      s.run(t);
      // offset the scripted motion to its spot; turn it by `yaw`
      for (const e of s.ents) {
        const lx = (e as { x: number }).x, lz = (e as { z: number }).z;
        const c = Math.cos(yaw), sn = Math.sin(yaw);
        (e as { x: number }).x = dx + lx * c + lz * sn;
        (e as { z: number }).z = dz - lx * sn + lz * c;
        if ('yaw' in e) (e as { yaw: number }).yaw += yaw;
        if ('vx' in e) {
          const vx = (e as { vx: number }).vx, vz = (e as { vz: number }).vz;
          (e as { vx: number }).vx = vx * c + vz * sn;
          (e as { vz: number }).vz = -vx * sn + vz * c;
        }
      }
    });
    all.push(...s.ents);
  };
  if (animName) {
    place(animName, slot, 0, 0, bench.num('yaw', 0) * DEG);
    const e = all[0];
    bench.orbit.target.set(0, e.kind === 'wolf' ? 0.55 : 0.95, 0);
    const ty = bench.param('ty') !== null ? bench.num('ty', 0.95) : -1;
    bench.onFrame(() => {
      const m = all[0] as PlayerEnt | WolfEnt;
      const h = ty >= 0 ? ty : m.kind === 'wolf' ? 0.55 : 0.95;
      bench.orbit.target.set(m.x, (m.kind === 'player' ? Math.max(0, m.y) : 0) + h, m.z);
    });
  } else if (show === 'player') {
    ['idle', 'walk', 'aim', 'flashlight'].forEach((n, i) => place(n, i, (i - 1.5) * 1.4, 0));
  } else if (show === 'wolf') {
    ['w-idle', 'w-stalk', 'w-howl', 'w-rest'].forEach((n, i) => place(n, i, (i - 1.5) * 1.6, 0));
  } else if (show === 'crowd') {
    // the budget case: 4 players and 16 wolves on screen, spread from near to far
    ['walk', 'flashlight', 'aim', 'run'].forEach((n, i) => place(n, i, (i - 1.5) * 2.2, 2 + i * 1.5, Math.PI));
    const moods = ['w-trot', 'w-walk', 'w-stalk', 'w-idle', 'w-howl', 'w-rest', 'w-gallop', 'w-circle'];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = 6 + (i % 4) * 9;
      place(moods[i % moods.length], i + 4, Math.sin(a) * r, -Math.cos(a) * r - 6, a);
    }
    for (let i = all.length - 1; i > 3; i--) if (all[i].kind === 'player') all.splice(i, 1);
    bench.orbit.target.set(0, 0.8, -6);
  } else if (show === 'pack') {
    // a player with a flashlight, wolves around: circling, stalking, howling, one lying
    place('flashlight', slot, 0, 0);
    const p = all[0] as PlayerEnt;
    const ring = [['w-stalk', 5, -6, 0.2], ['w-snarl', 2, -4, -0.3], ['w-howl', -5, -8, 0.5], ['w-rest', -7, -3, 1.2], ['w-idle', 3, -9, -0.4], ['w-cower', -2, -6, 0.1]] as [string, number, number, number][];
    ring.forEach(([n, x, z, yaw], i) => {
      place(n, i + 1, x, z, yaw);
      const w = all[all.length - (ANIMS[n].extra ? 2 : 1)] as WolfEnt;
      w.target = p.id;
    });
    // drop the helper players the wolf scripts made (keep the main player)
    for (let i = all.length - 1; i > 0; i--) if (all[i].kind === 'player') all.splice(i, 1);
    bench.orbit.target.set(0, 0.8, -4);
  } else {
    ['walk', 'aim', 'flashlight', 'axe'].forEach((n, i) => place(n, i, (i - 1.5) * 1.5, 0));
    ['w-stalk', 'w-howl', 'w-trot'].forEach((n, i) => place(n, i + 2, (i - 1) * 1.8, -3.5));
    bench.orbit.target.set(0, 0.8, -1.5);
  }
  current = all;
  script = (t) => {
    for (const s of scripts) s(t);
  };
  // a frozen clock (?t=) freezes the figures too: play the scripts up to it first, like the contact sheet
  const tFrozen = bench.param('t') !== null ? bench.num('t', 0) : 0;
  for (let t = 0; t < tFrozen - 1e-6; t += 1 / 30) {
    script(t);
    view.set(current);
    sys.update({ dt: 1 / 30, time: t, view });
  }
  if (bench.param('joints') === '1') {
    // joint overlay: a small sphere on every bone joint of every figure (red: wolves, yellow: players)
    const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 6, 4), new THREE.MeshBasicNodeMaterial({ color: 0xff3322, depthTest: false }), 256);
    dots.frustumCulled = false;
    dots.renderOrder = 10;
    bench.scene.add(dots);
    const m4 = new THREE.Matrix4();
    const pv = new THREE.Vector3();
    bench.onFrame(() => {
      let n = 0;
      for (const e of current) {
        const names = e.kind === 'wolf' ? WOLF_SKEL.names : e.kind === 'player' ? PLAYER_SKEL.names : [];
        for (const name of names) {
          if (n >= 256 || !sys.point(e.id, name, pv)) continue;
          dots.setMatrixAt(n++, m4.makeTranslation(pv.x, pv.y, pv.z));
        }
      }
      dots.count = n;
      dots.instanceMatrix.needsUpdate = true;
    });
  }
  let frames = 0;
  // with a frozen clock (?t=) the picture is final once DONE is set: stop drawing so a loaded,
  // shared GPU can still take the screenshot (?live=1 keeps rendering)
  const stopAt = bench.param('t') !== null && bench.param('live') !== '1' ? bench.num('frames', 8) + 2 : -1;
  bench.onFrame(() => {
    frames++;
    if (frames % 30 === 2 || frames === stopAt - 1) info.textContent = `${engine.backend} ${engine.quality.name} ${bench.light}  ${engine.stats.calls} calls ${(engine.stats.tris / 1000).toFixed(1)}k tris  figures ${sys.stats.players}p ${sys.stats.wolves}w  rows ${sys.stats.rows} draws ${sys.stats.draws}  actors cpu ${cpuMs.toFixed(2)} ms`;
    if (frames === stopAt) (engine as unknown as { frame: () => void }).frame = () => {};
  });
}

main().catch((e) => {
  console.error(e);
  info.textContent = String(e?.stack ?? e);
  (window as any).DONE = true;
});
