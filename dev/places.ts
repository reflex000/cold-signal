// PLACES BENCH. One place on the mountain at a time, laid out exactly as src/world/blueprints.ts
// SITES arranges it (every model the game places there, plus the crates and fires that are
// entities in the game), on a wind-drifted snow field, in the bench's four lights.
//
//   dev/places.html?place=wreck&view=out&light=dusk
//
//   place=wreck|tail|cabin|hut|cave|camp|tower      (default wreck)
//   view=out|honest|in|top|back                      named camera: a flattering three-quarter view,
//                                                    the honest eye-level view from the trail, inside,
//                                                    from above, from behind. az/el/dist/tx/ty/tz
//                                                    (the bench's orbit) override it when given.
//   light=day|dusk|night|storm   snow=0..1 (U.snowCover, default 0.75)   webgl=1   q=medium ...
//   fire=0|1     stand-in point lights on 'fire' emitters and model lights, stove lit, windows
//                glowing (default 1 except by day)
//   open=0..1    doors (every hinged part)        installed=0..5   radio modules in the panel
//   charge=0..1  generator charge (crank angle, gauge needle, tower lamps on above 0.2)
//   debug=1      anchors as small markers
// Sets window.DONE when the picture is on screen (bench), window.BACKEND, window.PLACE_INFO.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createBench, type LightName } from './bench';
import { U } from '../src/gfx/shared';
import type { PropInst } from '../src/world/types';
import { BLUEPRINTS, SITES, placeSite, toWorld, type Pose } from '../src/world/blueprints';
import { createPropsSystem } from '../src/models/instances';
import { fbm3 } from '../src/models/kit';
import { getModel, type ModelOpts } from '../src/models/registry';
import '../src/models/props';
import '../src/models/wreck';
import '../src/models/structures';
import { applyStructureState } from '../src/models/structures/drive';

const { positionWorld, float, mix, max, dot, vec3, mx_noise_float, normalWorld } = TSL as any;

type PlaceId = 'wreck' | 'tail' | 'cabin' | 'hut' | 'cave' | 'camp' | 'tower';
const Q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => {
  const v = Q.get(k);
  const n = v === null || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const place = ((Q.get('place') ?? 'wreck') as PlaceId) in SITES ? ((Q.get('place') ?? 'wreck') as PlaceId) : 'wreck';
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------
// What stands at each place: the site parts plus what the game adds there (dressing, signs,
// fire barrels, crates that are entities, debris of the skid scar near the wreck)
// ------------------------------------------------------------------------------------------
interface Extra { model: string; x: number; z: number; yaw: number; scale?: number; seed?: number; y?: number; opts?: ModelOpts }
const EXTRA: Record<PlaceId, Extra[]> = {
  wreck: [
    { model: 'barrel', x: 3.6, z: -11.6, yaw: 0.4, opts: { lit: true } },
    { model: 'luggage', x: -3.2, z: -11.2, yaw: 0.7, seed: 0 },
    { model: 'luggage', x: 5.6, z: -15.5, yaw: 2.1, seed: 1 },
    { model: 'sign_post', x: -3.4, z: -17.5, yaw: Math.PI },
    // the near end of the skid scar, pulled in so the bench shows it
    { model: 'debris_panel', x: -4.6, z: -19, yaw: 0.6, scale: 1.2, seed: 0 },
    { model: 'debris_panel', x: 2.4, z: -22, yaw: 2.2, scale: 0.9, seed: 1 },
    { model: 'debris_panel', x: 6.5, z: -26, yaw: 4.1, scale: 1.3, seed: 2 },
    { model: 'debris_panel', x: -2.5, z: -30, yaw: 1.0, scale: 0.8, seed: 3 },
    { model: 'seat_row', x: -6.5, z: -24, yaw: 0.8, seed: 0 },
    { model: 'seat_row', x: 4.5, z: -33, yaw: 2.6, seed: 1 },
    { model: 'engine_nacelle', x: -8, z: -38, yaw: 0.6, seed: 0 },
    { model: 'luggage', x: 1.2, z: -27, yaw: 1.4, seed: 2 },
    { model: 'luggage', x: -5.5, z: -31, yaw: 3.4, seed: 3 },
    { model: 'wing', x: 12, z: -44, yaw: Math.PI / 2 + 0.35, seed: 1 },
    { model: 'trail_marker', x: -2.4, z: -36, yaw: 1.2 },
  ],
  tail: [
    { model: 'crate', x: -0.7, z: 2.3, yaw: Math.PI / 2, y: 0.3 },
    { model: 'debris_panel', x: 4.2, z: 7.5, yaw: 1.3, scale: 1.1, seed: 2 },
    { model: 'luggage', x: -3.0, z: 6.6, yaw: 0.5, seed: 1 },
  ],
  cabin: [
    { model: 'log_heavy', x: 5.6, z: 3.6, yaw: 0.2 },
    { model: 'log_heavy', x: 6.6, z: 4.4, yaw: 0.3, seed: 1 },
    { model: 'log_heavy', x: 7.9, z: 3.4, yaw: -0.4, seed: 2 },
    { model: 'sign_post', x: -3.6, z: 9.4, yaw: 0, seed: 1 },
    { model: 'fence_post', x: -6.3, z: 0.5, yaw: 0.2, seed: 0 },
    { model: 'fence_post', x: -6.6, z: 3.0, yaw: 0, seed: 1 },
    { model: 'fence_post', x: -6.4, z: 5.5, yaw: 0.15, seed: 2 },
    { model: 'fence_post', x: -5.6, z: 8.2, yaw: 0.4, seed: 3 },
  ],
  hut: [
    { model: 'toolbox', x: 0.72, z: 0.55, yaw: -Math.PI / 2, y: 0.1 },
    { model: 'trail_marker', x: -1.8, z: 6.5, yaw: 0.4 },
    { model: 'trail_marker', x: 1.2, z: -9, yaw: 2.4, seed: 1 },
  ],
  cave: [
    { model: 'crate', x: 2.3, z: -5.6, yaw: -Math.PI / 2, y: 0.03 },
    { model: 'sign_post', x: 3.4, z: 8.4, yaw: 0, seed: 2 },
  ],
  camp: [
    { model: 'barrel', x: 6.1, z: -0.8, yaw: 0, seed: 1, opts: { lit: false } },
    { model: 'sign_post', x: -3.0, z: 9.0, yaw: 0, seed: 3 },
    { model: 'campfire', x: 0.6, z: 0.4, yaw: 0.3, opts: { stage: 3 } },
  ],
  tower: [
    { model: 'sign_post', x: 8.5, z: 9.5, yaw: 0 },
    { model: 'fence_post', x: -11.5, z: 9.5, yaw: 0, seed: 0 },
    { model: 'fence_post', x: -8.9, z: 11.2, yaw: 0.2, seed: 1 },
    { model: 'fence_post', x: -6.0, z: 12.4, yaw: -0.1, seed: 2 },
    { model: 'fence_post', x: 0.5, z: 12.9, yaw: 0.1, seed: 3 },
    { model: 'fence_post', x: 3.4, z: 12.6, yaw: 0.3, seed: 0 },
  ],
};

// eye / look-at per view, site-local
type View = { eye: [number, number, number]; at: [number, number, number] };
function views(): Record<string, View> {
  const shed = (lx: number, ly: number, lz: number): [number, number, number] => {
    const w = toWorld({ x: -7.6, y: 0, z: -0.6, yaw: Math.PI / 2 }, lx, ly, lz);
    return [w.x, w.y, w.z];
  };
  const V: Record<PlaceId, Record<string, View>> = {
    wreck: {
      out: { eye: [9.5, 2.4, -16], at: [0.5, 1.4, -3] },
      honest: { eye: [-0.8, 1.66, -27], at: [0, 1.5, -6] },
      in: { eye: [0.15, 2.0, -6.8], at: [0, 1.35, 4] },
      back: { eye: [-6, 2.0, 14], at: [0, 1.4, 2] },
      top: { eye: [16, 16, -22], at: [0, 0.5, -6] },
    },
    tail: {
      out: { eye: [7, 2.2, 12], at: [0, 2, -0.5] },
      honest: { eye: [0.6, 1.66, 20], at: [0, 1.8, 0] },
      in: { eye: [0.1, 1.9, 3.9], at: [-0.6, 0.9, -2.5] },
      back: { eye: [-7, 3, -10], at: [0, 2.5, 0] },
      top: { eye: [10, 12, 12], at: [0, 1, 0] },
    },
    cabin: {
      out: { eye: [-7.5, 2.2, 10.5], at: [0, 1.7, 0.5] },
      honest: { eye: [-1.2, 1.66, 17], at: [0, 1.8, 0] },
      in: { eye: [1.6, 1.95, 1.2], at: [-2.2, 1.0, -1.8] },
      back: { eye: [9, 3, -9], at: [0, 1.8, 0] },
      top: { eye: [12, 13, 14], at: [2, 1, 0] },
    },
    hut: {
      out: { eye: [4.5, 1.9, 6.5], at: [0, 1.1, 0] },
      honest: { eye: [0.2, 1.66, 11], at: [0, 1.2, 0] },
      in: { eye: [0.25, 1.75, 0.95], at: [0.3, 0.8, -1.2] },
      back: { eye: [-5, 2.2, -6], at: [0, 1.1, 0] },
      top: { eye: [6, 7, 7], at: [0, 0.5, 0] },
    },
    cave: {
      out: { eye: [5, 2.2, 12], at: [0, 2, -2] },
      honest: { eye: [0.4, 1.66, 17], at: [0, 1.8, -2] },
      in: { eye: [0.6, 1.7, -1.4], at: [0.4, 0.9, -7.6] },
      back: { eye: [-10, 6, -14], at: [0, 2, -4] },
      top: { eye: [12, 14, 10], at: [0, 1, -4] },
    },
    camp: {
      out: { eye: [8, 2.6, 11], at: [0, 1, -1] },
      honest: { eye: [-1.2, 1.66, 19], at: [0, 1.2, -1] },
      in: { eye: [-3.4, 0.95, 0.1], at: [-5.2, 0.6, -2.3] },
      back: { eye: [-6, 4, -14], at: [0, 1, -1] },
      top: { eye: [14, 16, 14], at: [0, 0, -1] },
    },
    tower: {
      out: { eye: [15, 3.2, 16], at: [-1, 7, -2] },
      honest: { eye: [6.8, 1.66, 23], at: [0, 6, -2] },
      in: { eye: shed(0.1, 1.85, 1.2), at: shed(0.15, 1.1, -1.6) },
      back: { eye: [-14, 4, -16], at: [-2, 6, -2] },
      top: { eye: [22, 30, 26], at: [-1, 2, 0] },
    },
  };
  return V[place];
}

(async () => {
  const fireDefault = Q.get('light') !== 'day' && Q.get('light') !== null ? 1 : Q.get('light') === null ? 0 : 0;
  const bench = await createBench({ light: 'day', ground: false });
  const { scene, camera, engine } = bench;
  const light = bench.light as LightName;
  U.snowCover.value = num('snow', 0.75);
  const fire = num('fire', light === 'day' ? 0 : 1) > 0 || fireDefault > 1;

  // ---- props ----
  const site = SITES[place];
  const at: Pose = { x: 0, y: place === 'hut' ? 0 : 0, z: 0, yaw: 0 };
  const placed = placeSite(site, at);
  const list: PropInst[] = [];
  const optsOf: (ModelOpts | undefined)[] = [];
  for (const p of placed.parts) {
    list.push({ model: p.model, seed: 0, x: p.pose.x, y: 0, z: p.pose.z, yaw: p.pose.yaw, scale: 1, poi: place });
    optsOf.push(p.model === 'barrel' ? { lit: false } : undefined);
  }
  for (const e of EXTRA[place]) {
    list.push({ model: e.model, seed: e.seed ?? 0, x: e.x, y: e.y ?? 0, z: e.z, yaw: e.yaw, scale: e.scale ?? 1 });
    optsOf.push(e.opts);
  }
  const t0 = performance.now();
  for (let i = 0; i < list.length; i++) getModel(list[i].model, list[i].seed, optsOf[i]);
  const buildMs = performance.now() - t0;
  const props = createPropsSystem({ scene, camera }, list, { opts: (_i, id) => optsOf[id] });
  engine.add(props);
  (window as any).PROPS = props;

  // ---- state of the moving parts, the way the game's driver sets them ----
  const charge = Math.max(0, Math.min(1, num('charge', 0)));
  applyStructureState(props, {
    open: Math.max(0, Math.min(1, num('open', 0))),
    stove: fire ? 0.9 : 0,
    installed: Math.round(num('installed', 0)),
    charge,
    crank: charge * 40 * Math.PI * 2,
    beacon: num('beacon', 0) > 0,
  });

  // ---- stand-in fire and lamp light (the game's lights come from gfx/fx) ----
  if (fire) {
    const byLight = ({ day: 0.06, dusk: 0.35, night: 1, storm: 0.2 } as Record<string, number>)[light] ?? 1;
    for (const e of props.emitters('fire')) {
      if (e.def.lit === false) continue;
      const k = byLight * Math.max(0.3, Math.min(2, e.size / 0.22)) * (typeof e.def.strength === 'number' ? Math.max(0.15, e.def.strength) : 1);
      const p = new THREE.PointLight(new THREE.Color(1.0, 0.42, 0.12), 14 * k, 18, 2);
      p.position.copy(e.position).addScaledVector(e.dir, Math.max(0.3, 0.1 + e.size));
      scene.add(p);
    }
    // the stove is a fire entity in the game (gfx/fx draws it): a stand-in light at each 'stove' anchor
    for (let id = 0; id < props.count; id++) {
      const p = props.anchor(id, 'stove');
      if (!p) continue;
      const pl = new THREE.PointLight(new THREE.Color(1.0, 0.45, 0.15), 9 * Math.max(byLight, 0.35), 9, 2);
      pl.position.copy(p).add(new THREE.Vector3(0, 0.55, 0.45));
      scene.add(pl);
    }
    for (const l of props.lights()) {
      if (l.def.name && /beacon|lamp_red/.test(l.def.name) && charge < 0.2) continue;
      const p = new THREE.PointLight(new THREE.Color(l.def.color[0], l.def.color[1], l.def.color[2]), l.def.intensity * byLight, l.def.range, 2);
      p.position.copy(l.position);
      scene.add(p);
    }
  }

// lamps declared as 'light' emitters: the lantern burns with the stove, the shed lamp with power
  for (const e of props.emitters('light')) {
    if (e.def.powered ? charge < 0.05 : !fire) continue;
    const c = (e.def.color as [number, number, number] | undefined) ?? [1, 0.75, 0.45];
    const pl = new THREE.PointLight(new THREE.Color(c[0], c[1], c[2]), typeof e.def.intensity === 'number' ? e.def.intensity : 5, typeof e.def.range === 'number' ? e.def.range : 7, 2);
    pl.position.copy(e.position);
    scene.add(pl);
  }

  // ---- the snow field: level where the site's pads are, drifted beyond ----
  {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
    const nz = mx_noise_float(positionWorld.xz.mul(0.6)).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(4.3)).mul(0.3)).add(mx_noise_float(positionWorld.xz.mul(37)).mul(0.2));
    const sunFacing = max(dot(normalWorld, vec3(U.sunDir)), 0.0);
    mat.colorNode = vec3(0.86, 0.885, 0.93).mul(float(0.95).add(nz.mul(0.05))).mul(mix(vec3(0.9, 0.95, 1.0), vec3(1.0, 0.99, 0.97), sunFacing));
    mat.fog = true;
    const size = 360;
    const geo = new THREE.PlaneGeometry(size, size, 300, 300).rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const pads = site.pads.length ? site.pads : [{ x: 0, z: 0, r: 6, feather: 6 }];
    const flatR = Math.max(...pads.map((p) => Math.hypot(p.x, p.z) + p.r));
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const d = Math.hypot(x, z);
      const k = Math.min(1, Math.max(0, (d - flatR) / 14));
      const edge = Math.min(1, Math.max(0, (size * 0.5 - Math.max(Math.abs(x), Math.abs(z))) / (size * 0.08)));
      const h = fbm3(11, x * 0.08, 0, z * 0.16, 3) * 1.4 + fbm3(5, x * 0.3, 1, z * 0.3, 2) * 0.25;
      pos.setY(i, h * k * edge - 0.03);
    }
    geo.computeVertexNormals();
    const g = new THREE.Mesh(geo, mat);
    g.receiveShadow = true;
    scene.add(g);
  }

  // ---- debug markers on every anchor ----
  if (num('debug', 0) > 0) {
    const geo = new THREE.OctahedronGeometry(0.06);
    const m = new THREE.MeshBasicNodeMaterial({ color: 0xffc040 });
    for (let id = 0; id < props.count; id++) {
      const def = props.model(id);
      if (!def) continue;
      for (const name in def.anchors) {
        const mk = new THREE.Mesh(geo, m);
        props.anchor(id, name, mk.position);
        scene.add(mk);
      }
    }
  }

  // ---- camera ----
  const vs = views();
  const vname = Q.get('view') ?? 'out';
  if (!Q.has('az') && vs[vname]) {
    const v = vs[vname];
    const dx = v.eye[0] - v.at[0], dy = v.eye[1] - v.at[1], dz = v.eye[2] - v.at[2];
    const dist = Math.hypot(dx, dy, dz);
    bench.orbit.dist = dist;
    bench.orbit.el = Math.asin(dy / dist) / DEG;
    bench.orbit.az = Math.atan2(-dx, dz) / DEG;
    bench.orbit.target.set(v.at[0], v.at[1], v.at[2]);
  }
  camera.near = vname === 'in' ? 0.05 : 0.1;
  camera.updateProjectionMatrix();
  // the bench's sun covers a box round the target: big places need a bigger one
  {
    const r = place === 'tower' ? 36 : place === 'wreck' ? 30 : 18;
    const sc = bench.sun.shadow.camera;
    sc.left = sc.bottom = -r;
    sc.right = sc.top = r;
    sc.updateProjectionMatrix();
    bench.sun.shadow.normalBias = Math.max(0.01, ((2 * r) / bench.sun.shadow.mapSize.x) * 2.0);
  }

  // ---- info ----
  const info: Record<string, unknown> = { place, view: vname, light, buildMs: Math.round(buildMs), models: {} as Record<string, unknown> };
  let tris = 0;
  for (let id = 0; id < props.count; id++) {
    const def = props.model(id)!;
    tris += def.tris;
    (info.models as Record<string, unknown>)[list[id].model + '#' + list[id].seed] = { tris: def.tris, parts: Object.keys(def.parts) };
  }
  info.tris = tris;
  (window as any).PLACE_INFO = info;
  const el = document.getElementById('info');
  if (el && Q.get('labels') !== '0') el.textContent = `${place} / ${vname} / ${light}   ${(tris / 1000).toFixed(1)}k tris   built in ${Math.round(buildMs)} ms`;
  void BLUEPRINTS;
})();
