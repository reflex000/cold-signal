// Engine bench: a scene that stresses the post pipeline. Snow in sun and in shadow, near-black
// rock, a small hot fire and a red flare, thin geometry (mast, wires, fence, a dead tree) for the
// anti-aliasing, far ridges for depth precision and fog, shadows from a low sun.
//
//   dev/engine.html?light=day|dusk|night|storm&q=mobile|low|medium|high|ultra[&webgl=1]
//   &stages=mist,haze     add sample HDR stages through engine.post.addHdrStage
//   &overlays=frost,drops add sample overlays through engine.post.addOverlay
//   (plus everything dev/bench.ts reads: az, el, dist, tx, ty, tz, fov, t, hud, exp, tm, dyn ...)
// Owner: ENGINE.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { fbm2, noise2 } from '../src/core/noise';
import { Rng } from '../src/core/rng';
import { U } from '../src/gfx/shared';
import { createBench } from './bench';

const { uniform, vec2, vec3, float, mix, smoothstep, max, sin, positionWorld, positionLocal, normalWorld, mx_noise_float, mx_fractal_noise_float, bumpMap, uv, length, clamp } = TSL as any;

const b = await createBench({ light: 'day', ground: false });
const { engine, scene } = b;
const rng = new Rng(417);

// ---- ground: wind-drifted snow ----
const SIZE = 120;
const SEG = 220;
const height = (x: number, z: number): number => {
  const drift = fbm2(11, x * 0.045 + 3, z * 0.09, 4) * 0.9; // long drifts across the wind
  const dune = Math.max(0, noise2(5, x * 0.11, z * 0.035)) * 0.55;
  const slope = -z * 0.035 + x * 0.01; // the flank rises to the north
  const flat = Math.min(1, Math.hypot(x, z) / 9); // a trodden patch around the fire
  return slope + (drift + dune) * (0.25 + 0.75 * flat);
};
{
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG).rotateX(-Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, height(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  // Snow is never pure white and never one colour: packed crust is greyer, fresh powder brighter.
  const crust: any = mx_fractal_noise_float(positionWorld.xz.mul(vec2(0.5, 1.6)), 3, 2, 0.5).mul(0.5).add(0.5);
  mat.colorNode = mix(vec3(0.8, 0.83, 0.88), vec3(0.93, 0.94, 0.955), smoothstep(0.25, 0.75, crust));
  mat.roughnessNode = mix(float(0.62), float(0.9), smoothstep(0.3, 0.7, crust));
  // Sastrugi: small ridges the wind cuts, stretched along it.
  const ripples: any = mx_noise_float(positionWorld.xz.mul(vec2(2.2, 9.0))).mul(0.6).add(mx_noise_float(positionWorld.xz.mul(vec2(9.0, 31.0))).mul(0.25));
  mat.normalNode = bumpMap(ripples, float(0.012));
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  ground.castShadow = true;
  ground.name = 'snow';
  scene.add(ground);
}

// ---- far ridges: 1.5 to 4.5 km away, to look at depth precision and distance fog ----
{
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const steep: any = smoothstep(0.55, 0.8, normalWorld.y);
  mat.colorNode = mix(vec3(0.045, 0.05, 0.06), vec3(0.86, 0.88, 0.92), steep); // rock where it is too steep to hold snow
  for (let i = 0; i < 9; i++) {
    const a = (-0.75 + i * 0.19 + rng.range(-0.04, 0.04)) * Math.PI;
    const d = rng.range(1500, 4500);
    const h = rng.range(380, 900);
    const geo = new THREE.ConeGeometry(h * rng.range(1.3, 2.1), h, 7, 6);
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < p.count; k++) {
      const n = fbm2(40 + i, p.getX(k) * 0.004, p.getZ(k) * 0.004 + p.getY(k) * 0.003, 3);
      p.setXYZ(k, p.getX(k) * (1 + n * 0.35), p.getY(k) * (1 + n * 0.25), p.getZ(k) * (1 + n * 0.35));
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.sin(a) * d, h * 0.5 - 60, -Math.cos(a) * d);
    scene.add(m);
  }
}

// ---- rock: near black ----
const rockMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
{
  const grain: any = mx_fractal_noise_float(positionLocal.mul(3.1), 4, 2.1, 0.55);
  rockMat.colorNode = mix(vec3(0.022, 0.024, 0.028), vec3(0.085, 0.082, 0.078), grain.mul(0.5).add(0.5));
  rockMat.normalNode = bumpMap(grain, float(0.035));
}
function boulder(x: number, z: number, r: number, seed: number, squash = 0.7): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(r, 4);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm2(seed, v.x * 0.9 / r + v.y / r, v.z * 0.9 / r - v.y * 0.6 / r, 4);
    const facet = Math.round(n * 4) / 4; // broken faces, not a potato
    v.multiplyScalar(1 + n * 0.22 + facet * 0.12);
    v.y *= squash;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, rockMat);
  m.position.set(x, height(x, z) + r * squash * 0.35, z);
  m.rotation.y = seed;
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  return m;
}
boulder(-4.6, -2.2, 1.7, 3, 0.75);
boulder(-6.9, -0.4, 0.9, 8, 0.6);
boulder(-3.1, -4.4, 0.55, 12, 0.6);
boulder(7.5, -7.5, 2.6, 21, 0.85);
boulder(10.4, -5.6, 1.1, 29, 0.6);
boulder(-12, -14, 3.4, 33, 0.9);

// ---- thin things: a guyed lattice mast, a wire fence, a dead tree ----
const steel = new THREE.MeshStandardNodeMaterial({ color: 0x555a5e, roughness: 0.55, metalness: 0.85 });
const wood = new THREE.MeshStandardNodeMaterial({ color: 0x1c1611, roughness: 0.9, metalness: 0 });
const thin: THREE.Object3D[] = [];
const yAxis = new THREE.Vector3(0, 1, 0);
function strut(a: THREE.Vector3, c: THREE.Vector3, r: number, mat: THREE.Material, sides = 6): void {
  const len = a.distanceTo(c);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, sides, 1, true), mat);
  m.position.copy(a).add(c).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(yAxis, c.clone().sub(a).normalize());
  m.castShadow = true;
  thin.push(m);
}
{
  // Mast: three legs, bracing every 1.2 m, guy wires 6 mm thick.
  const base = new THREE.Vector3(4.2, height(4.2, 1.5), 1.5);
  const H = 11;
  const leg = (i: number, y: number): THREE.Vector3 => {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const w = 0.42 - 0.3 * (y / H);
    return new THREE.Vector3(base.x + Math.cos(a) * w, base.y + y, base.z + Math.sin(a) * w);
  };
  for (let i = 0; i < 3; i++) strut(leg(i, -0.3), leg(i, H), 0.022, steel);
  for (let y = 0; y < H; y += 1.2) {
    for (let i = 0; i < 3; i++) {
      strut(leg(i, y), leg((i + 1) % 3, y), 0.011, steel, 5);
      strut(leg(i, y), leg((i + 1) % 3, Math.min(H, y + 1.2)), 0.009, steel, 5);
    }
  }
  const top = new THREE.Vector3(base.x, base.y + H, base.z);
  strut(top, top.clone().add(new THREE.Vector3(0, 2.4, 0)), 0.012, steel); // whip antenna
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.1;
    const gx = base.x + Math.cos(a) * 9, gz = base.z + Math.sin(a) * 9;
    strut(new THREE.Vector3(base.x, base.y + H * 0.85, base.z), new THREE.Vector3(gx, height(gx, gz), gz), 0.003, steel, 4);
  }
  // Fence running away north-east: posts and three wires, down to a pixel and below.
  let prev: THREE.Vector3 | null = null;
  for (let i = 0; i < 26; i++) {
    const x = -9 + i * 2.4, z = 6 - i * 3.1;
    const foot = new THREE.Vector3(x, height(x, z) - 0.2, z);
    const head = foot.clone().add(new THREE.Vector3(rng.range(-0.05, 0.05), 1.45, rng.range(-0.05, 0.05)));
    strut(foot, head, 0.035, wood, 6);
    if (prev) for (const k of [0.25, 0.55, 0.88]) strut(prev.clone().lerp(prev.clone().add(new THREE.Vector3(0, -1.45, 0)), 1 - k), head.clone().lerp(foot, 1 - k), 0.0025, steel, 3);
    prev = head;
  }
  // Dead tree: a trunk and bare branches down to twigs.
  const grow = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number): void => {
    const to = from.clone().addScaledVector(dir, len);
    strut(from, to, r, wood, depth > 2 ? 4 : 7);
    if (depth >= 5) return;
    const kids = depth === 0 ? 4 : 2 + (rng.next() < 0.4 ? 1 : 0);
    for (let k = 0; k < kids; k++) {
      const d2 = dir.clone().add(new THREE.Vector3(rng.range(-0.8, 0.8), rng.range(-0.15, 0.6), rng.range(-0.8, 0.8))).normalize();
      grow(from.clone().lerp(to, rng.range(0.45, 1)), d2, len * rng.range(0.55, 0.75), r * 0.55, depth + 1);
    }
  };
  const tx = -1.5, tz = -7.5;
  grow(new THREE.Vector3(tx, height(tx, tz) - 0.2, tz), new THREE.Vector3(0.08, 1, 0.05).normalize(), 3.2, 0.12, 0);
  scene.add(...thin);
}

// ---- a hut wall and roof: one big hard-edged shadow across the drifts ----
{
  const hx = 9.5, hz = 3.5;
  const y0 = height(hx, hz) - 0.2;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.5, 3.2), wood);
  wall.position.set(hx, y0 + 1.25, hz);
  const roofMat = new THREE.MeshStandardNodeMaterial({ color: 0xe6e9ee, roughness: 0.85 }); // snow load
  const roof = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.32, 4.0), roofMat);
  roof.position.set(hx, y0 + 2.7, hz);
  roof.rotation.z = 0.12;
  for (const m of [wall, roof]) {
    m.rotation.y = 0.5;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }
  // An oil drum: the one glossy thing, for a hard sun glint.
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.9, 28), new THREE.MeshStandardNodeMaterial({ color: 0x7a2b22, roughness: 0.32, metalness: 0.9 }));
  drum.position.set(2.2, height(2.2, -2.6) + 0.42, -2.6);
  drum.castShadow = drum.receiveShadow = true;
  scene.add(drum);
}

// ---- fire: small and hot ----
const fire = new THREE.Group();
const fireLight = new THREE.PointLight(new THREE.Color(1.0, 0.42, 0.12), 60, 22, 2);
const flameHeat: any = uniform(1);
{
  const fy = height(0, 0);
  fire.position.set(0, fy, 0);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(rng.range(0.11, 0.17), 1), rockMat);
    s.position.set(Math.cos(a) * 0.52, 0.05, Math.sin(a) * 0.52);
    s.scale.y = 0.7;
    s.castShadow = true;
    fire.add(s);
  }
  for (let i = 0; i < 4; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.7, 7), wood);
    log.rotation.set(Math.PI / 2 - 0.5, (i / 4) * Math.PI * 2, 0, 'YXZ');
    log.position.set(Math.sin((i / 4) * Math.PI * 2) * 0.14, 0.16, Math.cos((i / 4) * Math.PI * 2) * 0.14);
    fire.add(log);
  }
  // Flames: scene-referred emission. The base is far above white, the tips fall off to deep orange.
  const flameMat = new THREE.MeshBasicNodeMaterial();
  const t: any = clamp(positionLocal.y.add(0.5), 0, 1); // 0 base .. 1 tip of the unit cone
  const flick: any = sin(positionWorld.y.mul(23).sub(U.time.mul(9))).mul(0.15).add(0.85);
  flameMat.colorNode = mix(vec3(34, 13, 2.2), vec3(9, 1.6, 0.12), smoothstep(0.1, 0.95, t)).mul(flick).mul(flameHeat);
  flameMat.fog = false;
  for (let i = 0; i < 6; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 7, 1, true), flameMat);
    const hgt = rng.range(0.28, 0.62);
    f.scale.set(rng.range(0.12, 0.2), hgt, rng.range(0.12, 0.2));
    f.position.set(rng.range(-0.12, 0.12), 0.14 + hgt / 2, rng.range(-0.12, 0.12));
    f.userData.h = hgt;
    f.userData.phase = rng.range(0, 6.28);
    f.name = 'flame';
    fire.add(f);
  }
  // Embers: single hot pixels drifting up (what the bloom's first downsample must not flicker on).
  const emberMat = new THREE.MeshBasicNodeMaterial();
  emberMat.colorNode = vec3(40, 12, 1.5);
  for (let i = 0; i < 14; i++) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.006, 5, 4), emberMat);
    e.userData.seed = rng.range(0, 100);
    e.name = 'ember';
    fire.add(e);
  }
  fireLight.position.set(0, 0.45, 0);
  fireLight.castShadow = engine.quality.fireShadows;
  fireLight.shadow.mapSize.set(512, 512);
  fireLight.shadow.bias = -0.002;
  fire.add(fireLight);
  scene.add(fire);

  // A red hand flare burning in the snow, 28 m off.
  const flare = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicNodeMaterial());
  (flare.material as any).colorNode = vec3(160, 9, 5);
  const fx = -17, fz = -21;
  flare.position.set(fx, height(fx, fz) + 0.12, fz);
  const flareLight = new THREE.PointLight(new THREE.Color(1, 0.06, 0.03), 220, 40, 2);
  flareLight.position.set(0, 0.25, 0);
  flare.add(flareLight);
  scene.add(flare);
}

// ---- the extension API, exercised ----
const stages = (b.param('stages') ?? '').split(',');
const overlays = (b.param('overlays') ?? '').split(',');
if (stages.includes('mist')) {
  // Ground mist pooled below the fire's height: needs the world position behind each pixel.
  const amount: any = uniform(0.75);
  engine.post.addHdrStage('mist', 100, (i) => {
    const below = smoothstep(float(1.4), float(-0.6), i.worldPos.y.sub(float(height(0, 0))));
    const far = float(1).sub(i.viewDepth.mul(-0.03).exp());
    return mix(i.color, U.fogColor.mul(1.1), below.mul(far).mul(amount));
  });
}
if (stages.includes('haze')) {
  // Heat shimmer: re-reads the picture at a wobbling position, so it asks for `resample`.
  engine.post.addHdrStage('haze', 300, (i) => {
    const wob = vec2(sin(i.uv.y.mul(190).add(U.time.mul(7))), sin(i.uv.x.mul(160).sub(U.time.mul(5)))).mul(0.0022);
    const near = smoothstep(0.22, 0.0, length(i.uv.sub(vec2(0.5, 0.62))));
    return i.sample(i.uv.add(wob.mul(near)));
  }, { resample: true });
}
if (overlays.includes('frost')) {
  // Frost creeping in from the edges of the goggles.
  const frost: any = uniform(0.8);
  engine.post.addOverlay('frost', 200, (color, at, i) => {
    const p = at.sub(0.5).mul(vec2(i.aspect, 1));
    const edge = smoothstep(float(0.62).sub(frost.mul(0.3)), float(0.95), length(p).mul(1.35));
    const crystals = mx_fractal_noise_float(p.mul(26), 4, 2.2, 0.55).mul(0.5).add(0.5);
    const mask = clamp(edge.mul(crystals.mul(1.5).add(0.25)), 0, 1).mul(frost);
    return mix(color, vec3(0.82, 0.88, 0.95), mask);
  });
}
if (overlays.includes('drops')) {
  // Melt drops on the lens: each refracts the picture behind it, so it asks for `resample`.
  engine.post.addOverlay('drops', 300, (color, at, i) => {
    let out: any = color;
    for (const [cx, cy, r] of [[0.28, 0.36, 0.05], [0.71, 0.3, 0.035], [0.6, 0.72, 0.06]]) {
      const d = at.sub(vec2(cx, cy)).mul(vec2(i.aspect, 1));
      const inside = smoothstep(float(r), float(r * 0.82), length(d));
      const bent = i.sample(vec2(cx, cy).sub(at.sub(vec2(cx, cy)).mul(0.6))); // a drop is a little fisheye lens
      out = mix(out, bent.mul(1.06), inside);
    }
    return out;
  }, { resample: true });
}

// ---- animate ----
b.onFrame((_dt, time) => {
  const night = U.night.value as number;
  for (const o of fire.children) {
    if (o.name === 'flame') {
      const k = 0.8 + 0.3 * Math.sin(time * 11 + o.userData.phase) + 0.12 * Math.sin(time * 27.3 + o.userData.phase * 2);
      o.scale.y = o.userData.h * k;
      o.position.y = 0.14 + (o.userData.h * k) / 2;
    } else if (o.name === 'ember') {
      const s = o.userData.seed as number;
      const life = (time * 0.55 + s) % 1;
      o.position.set(Math.sin(s * 9 + life * 5) * 0.22 * life, 0.4 + life * 2.6, Math.cos(s * 7 + life * 4) * 0.22 * life);
      o.visible = life < 0.85;
    }
  }
  const flick = 0.82 + 0.12 * Math.sin(time * 13.1) + 0.08 * Math.sin(time * 31.7 + 1.3);
  fireLight.intensity = 60 * flick;
  flameHeat.value = 0.9 + 0.2 * flick;
  void night;
});
(window as any).BENCH = b;
