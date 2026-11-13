// Snow bench: the real terrain and the real snow system, fed by a scripted View (no game): a walker,
// a runner, a log dragged by one carrier, a player going down, a jump landing, a trotting and a
// galloping wolf, all through the same bus events and entity motion the game produces.
//
//   dev/snow.html?at=fresh|deep|packed &what=walk,run,log,body,land,wolf,gallop &light=day|dusk|night|storm
//   &fill=0.05     metres of snow laid down after the stamps (prints filling in)
//   &x= &z=        world spot (else one is searched near the wreck for `at`)
//   &az= &el= &dist=   orbit camera around the spot (degrees, metres)   &q= &webgl=1 &frames=40 &t=
//   &debug=1       show the trail atlas in a corner
// Owner: SNOW.
import * as THREE from 'three/webgpu';
import { Bus } from '../src/core/bus';
import type { GameBus, View } from '../src/game/view';
import type { Env, LogEnt, PlayerEnt, SimEvent, WolfEnt } from '../src/sim/types';
import { U } from '../src/gfx/shared';
import { createSnowSystem } from '../src/gfx/snow/index';
import { createTerrainSystem } from '../src/gfx/terrain/index';
import { createWorld } from '../src/world/index';
import { createBench } from './bench';

const b = await createBench({ light: 'day', ground: false });
const { engine } = b;
const world = createWorld(417);
const terrain = createTerrainSystem(engine, world);
engine.add(terrain);
const snow = createSnowSystem(engine, world);
(window as any).SNOW = snow;
(window as any).WORLD = world;
// &forest=1: the real forest too (judging trees on the real terrain, e.g. from above); &cover=0..1 U.snowCover
if (b.param('forest') === '1') {
  const { createForestSystem } = await import('../src/gfx/forest/index');
  engine.add(createForestSystem(engine, world));
}
if (b.param('cover') !== null) {
  const cover = b.num('cover', 0.8);
  b.onFrame(() => {
    U.snowCover.value = cover;
  });
}

// ---- where ----
const at = b.param('at') ?? 'fresh';
function find(): { x: number; z: number } {
  const w = world.poi('wreck');
  let best = { x: w.x + 30, z: w.z + 30 }, bs = -Infinity;
  for (let r = 20; r < 420; r += 6) {
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const x = w.x + Math.sin(a) * r, z = w.z + Math.cos(a) * r;
      if (world.slopeAt(x, z) > 0.12 || world.surfaceAt(x, z) === 'rock' || world.surfaceAt(x, z) === 'ice' || world.forestAt(x, z) > 0.2) continue;
      const sd = world.snowDepthAt(x, z);
      const m = world.masks;
      const i = Math.round(((x + m.extent) / (2 * m.extent)) * (m.n - 1)), j = Math.round(((z + m.extent) / (2 * m.extent)) * (m.n - 1));
      const packed = m.data[(j * m.n + i) * 4 + 3] / 255;
      // flat open ground of the kind asked for
      const score = at === 'deep' ? sd - world.slopeAt(x, z) * 2 - packed : at === 'packed' ? packed * 2 - Math.abs(sd - 0.2) : -Math.abs(sd - 0.26) - packed - world.slopeAt(x, z);
      if (score > bs) {
        bs = score;
        best = { x, z };
      }
    }
    if (bs > (at === 'deep' ? 0.7 : at === 'packed' ? 1.7 : -0.03)) break;
  }
  return best;
}
const spot = b.param('x') !== null ? { x: b.num('x', 0), z: b.num('z', 0) } : find();
const cy = terrain.heightAt(spot.x, spot.z);
console.log(`[snow bench] ${at} at ${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}: loose snow ${world.snowDepthAt(spot.x, spot.z).toFixed(2)} m, surface ${world.surfaceAt(spot.x, spot.z)}`);
b.orbit.target.set(spot.x, cy + 0.2, spot.z);
b.orbit.az = b.num('az', 200);
b.orbit.el = b.num('el', 38);
b.orbit.dist = b.num('dist', 6.5);

// ---- a scripted View ----
const bus = new Bus<GameBus>();
const env: Env = { t: 0, clock: 12, day: 0, storm: 0, windX: 1, windZ: 0.5, gust: 0, snowfall: 0, visibility: 4000, airTemp: -12, cloud: 0, aurora: 0, snowAccum: 0 };
const ents = new Map<number, any>();
const lists: Record<string, any[]> = { player: [], wolf: [], log: [] };
const view = {
  world, bus, settings: {} as any, touch: false, mode: 'play', time: 0, env, objective: {} as any, stats: {} as any, me: null, myId: 1, ents,
  list: (k: string) => lists[k] ?? [],
  ice: new Map(), hud: {} as any, rig: {} as any,
  camera: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 55, third: 0 },
} as unknown as View;
const camDir = new THREE.Vector3();
engine.add({
  name: 'snow-bench',
  update(f) {
    const c = engine.camera;
    c.getWorldDirection(camDir);
    view.camera.x = c.position.x;
    view.camera.y = c.position.y;
    view.camera.z = c.position.z;
    view.camera.yaw = Math.atan2(-camDir.x, -camDir.z);
    snow.update({ ...f, view });
  },
});

const what = new Set((b.param('what') ?? 'walk,run,log,body,land,wolf,gallop').split(','));
const emit = (e: SimEvent): void => bus.emit('sim', e);

/** A path across the spot: start offset (along, across) and heading in degrees. */
function walker(id: number, s0: number, across: number, headDeg: number, n: number, stride: number, run: boolean, bend = 0.02): void {
  const h = (headDeg * Math.PI) / 180;
  const fx = Math.sin(h), fz = -Math.cos(h), lx = fz, lz = -fx;
  for (let k = 0; k < n; k++) {
    const s = s0 + k * stride;
    const off = across + bend * s * s;
    emit({ t: 'step', id, x: spot.x + fx * s + lx * off, y: cy, z: spot.z + fz * s + lz * off, surface: world.surfaceAt(spot.x, spot.z), run, left: k % 2 === 0 });
  }
}

let frameNo = 0;
const log: LogEnt = { id: 50, kind: 'log', x: 0, y: cy, z: 0, yaw: 0, rev: 0, a: 7, b: 0, len: 2.4, burn: 600 };
const wolf: WolfEnt = { id: 60, kind: 'wolf', x: 0, y: cy, z: 0, yaw: 0, rev: 0, pack: 0, alpha: false, mood: 'roam', moodT: 0, target: 0, vx: 0, vz: 0, speed: 2.6, health: 100, fear: 0, hunger: 0, variant: 0 };
const wolf2: WolfEnt = { ...wolf, id: 61, speed: 8.5, mood: 'charge' };
const downed = { id: 70, kind: 'player', x: spot.x + 2.2, y: cy, z: spot.z - 1.2, yaw: 1.1, vx: 0, vz: 0, life: 'downed' } as unknown as PlayerEnt;
const jumper = { id: 80, kind: 'player', x: spot.x - 2.4, y: cy, z: spot.z + 1.8, yaw: -0.6, vx: Math.sin(0.6) * 3, vz: -Math.cos(0.6) * 3, life: 'alive' } as unknown as PlayerEnt;

b.onFrame(() => {
  frameNo++;
  env.t += 1 / 30;
  if (frameNo === 2) {
    if (what.has('walk')) walker(1, -5, 0.4, 70, 16, 0.72, false);
    if (what.has('run')) walker(2, -6, -1.6, 82, 9, 1.35, true, 0.01);
    if (what.has('body')) {
      ents.set(downed.id, downed);
      emit({ t: 'downed', id: downed.id });
    }
    if (what.has('land')) {
      ents.set(jumper.id, jumper);
      emit({ t: 'land', id: jumper.id, speed: 5.5 });
    }
    if (what.has('log')) lists.log.push(log);
    if (what.has('wolf')) lists.wolf.push(wolf);
    if (what.has('gallop')) lists.wolf.push(wolf2);
  }
  // the dragged log and the wolves move a little each frame
  const k = frameNo - 2;
  if (k >= 0 && k <= 34) {
    const hd = 0.3;
    // the carrier walks along +x of a line south of the spot; end b trails
    const ax = spot.x - 4 + k * 0.24, az = spot.z + 2.6 + Math.sin(k * 0.12) * 0.4;
    log.yaw = Math.PI / 2 + hd * Math.sin(k * 0.1);
    log.x = ax - Math.sin(log.yaw) * log.len * 0.5;
    log.z = az - Math.cos(log.yaw) * log.len * 0.5;
    wolf.x = spot.x - 5 + k * 0.3;
    wolf.z = spot.z - 3.2 + Math.sin(k * 0.15) * 0.5;
    wolf2.x = spot.x - 7 + k * 0.45;
    wolf2.z = spot.z + 4.5;
  }
  if (frameNo === 40) {
    const fill = b.num('fill', 0);
    if (fill > 0) {
      env.snowAccum += fill;
      env.snowfall = 1;
    }
  }
});

// ---- debug: the atlas in a corner ----
if (b.param('debug') === '1') {
  const { texture, uv, vec4 } = await import('three/tsl');
  const m = new THREE.NodeMaterial();
  const t: any = texture(U.trailTex.value, uv());
  m.fragmentNode = vec4(t.x.mul(2), t.y, t.z.mul(4), 1);
  m.depthTest = false;
  const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.5), m);
  q.renderOrder = 1e9;
  q.frustumCulled = false;
  const hudCam = engine.camera;
  q.onBeforeRender = () => {
    q.position.copy(hudCam.position).addScaledVector(hudCam.getWorldDirection(camDir), 2);
    q.quaternion.copy(hudCam.quaternion);
    q.translateX(-0.45);
    q.translateY(0.3);
    q.scale.setScalar(0.5);
  };
  engine.scene.add(q);
}
