// MODEL VIEWER. Lays the requested models out on a wind-drifted snow field and frames them from one
// or more views, tiled in one picture. Built on dev/bench.ts (createBench): the real engine, post
// pipeline (tone mapping, grade, AO, bloom, AA) and the bench's stand-in sky in four lights, so a
// model judged here looks the way the game draws it.
//
//   dev/models.html?m=crate,barrel&seed=1-4&light=dusk&views=30,20;200,35&snow=0.8
//
//   m=name[,name...]      models (default: every registered model). Model options go after a
//                         colon: m=campfire:stage=2,campfire:stage=3:big=true
//   seed=1-4 | 3 | 0,2,5  seeds shown for each model (default 0). Seeds that fold onto the same
//                         variant are shown once.
//   light=day|dusk|night|storm   (default day)        snow=0..1  U.snowCover (default 0)
//   views=az,el;az,el     camera directions in degrees: az 0 looks at the front (+Z side) of the
//                         models, 90 from their +X side; el is the height angle. Default 35,20.
//   debug=1               bounds, anchors, emitters, lights and part pivots, with labels
//   open=0..1             swing every hinged part (lids, doors) open by this fraction
//   webgl=1               force the WebGL2 backend          q=mobile|low|medium|high (default high)
//   yaw=deg  scale=k      placement of every prop (checks instancing with a rotated matrix)
//   wind=m/s  gust=0..1  wet=0..1  t=seconds (freeze the clock)  fov=deg  exp=k (exposure multiplier)
//   fire=0                no stand-in point light on 'fire' emitters and model lights
//   labels=0              hide the name tags            zoom=k  move the cameras in (k > 1) or out
//
// One view: drag to orbit (the bench's camera). Several views: each is rendered by the engine in
// turn and copied into a 2D overlay, tile by tile, in the same task (so the canvas still holds the
// frame). The page sets window.DONE when the picture is on screen (the bench does, after this page
// releases it), window.BACKEND, and window.MODEL_INFO (per model: triangles, size, anchors,
// emitters, parts) for tools/shot-models.mjs.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createBench } from './bench';
import { U } from '../src/gfx/shared';
import type { Frame } from '../src/gfx/api';
import type { PropInst } from '../src/world/types';
import { createPropsSystem } from '../src/models/instances';
import { fbm3, type ModelDef } from '../src/models/kit';
import { PROP_U } from '../src/models/material';
import { getModel, hasModel, listModels, modelKey, modelMeta, type ModelOpts } from '../src/models/registry';

const { positionWorld, float, mix, max, dot, vec3, mx_noise_float, normalWorld } = TSL as any;

// ------------------------------------------------------------------------------------------
// Parameters
// ------------------------------------------------------------------------------------------

const Q = new URLSearchParams(location.search);
const str = (k: string, d = ''): string => Q.get(k) ?? d;
const num = (k: string, d: number): number => {
  const v = Q.get(k);
  const n = v === null || v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (k: string, d: boolean): boolean => {
  const v = Q.get(k);
  return v === null ? d : v !== '0' && v !== 'false';
};

function parseSeeds(s: string): number[] {
  const out: number[] = [];
  for (const tok of s.split(',')) {
    const m = tok.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]) && out.length < 64; i++) out.push(i);
    else if (tok.trim() !== '' && Number.isFinite(Number(tok))) out.push(Math.floor(Number(tok)));
  }
  return out.length ? out : [0];
}

interface Spec { name: string; opts: ModelOpts | undefined }
function parseSpecs(s: string): Spec[] {
  const out: Spec[] = [];
  for (const tok of s.split(',')) {
    const [name, ...rest] = tok.trim().split(':');
    if (!name) continue;
    let opts: ModelOpts | undefined;
    for (const kv of rest) {
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const k = kv.slice(0, eq), v = kv.slice(eq + 1);
      (opts ??= {})[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    out.push({ name, opts });
  }
  return out;
}

function parseViews(s: string): { az: number; el: number }[] {
  const out: { az: number; el: number }[] = [];
  for (const tok of s.split(';')) {
    const [a, e] = tok.split(',').map((v) => Number(v));
    if (Number.isFinite(a)) out.push({ az: a, el: Number.isFinite(e) ? Math.max(-5, Math.min(89, e)) : 20 });
  }
  return out.length ? out.slice(0, 9) : [{ az: 35, el: 20 }];
}

const DEG = Math.PI / 180;
const info = document.getElementById('info') as HTMLDivElement;

async function main(): Promise<void> {
  // Every model file of every group registers itself when it is loaded. A file that fails to
  // load (someone else's work in progress) must not take the viewer down with it.
  const files = import.meta.glob(['../src/models/*/*.ts', '!../src/models/*/*.test.ts']);
  const failed: string[] = [];
  await Promise.all(Object.entries(files).map(async ([path, load]) => {
    try {
      await load();
    } catch (err) {
      failed.push(path.replace('../src/models/', ''));
      console.warn(`[models] ${path} failed to load:`, err);
    }
  }));

  const views = parseViews(str('views', '35,20'));
  const n = views.length;
  // Several engine frames run back to back in one task here: the engine's GPU timer queries
  // would nest (a WebGL warning). This page never needs GPU timing, so ask the bench for none.
  if (!Q.has('gpu')) {
    const u = new URL(location.href);
    u.searchParams.set('gpu', '0');
    history.replaceState(null, '', u);
  }
  const bench = await createBench({ ground: false, orbit: n === 1, quality: 'high' });
  const { engine, scene, camera, canvas } = bench;
  let release: () => void = () => {};
  bench.busy(new Promise<void>((ok) => (release = ok)));
  const fov = num('fov', 32);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  const debug = flag('debug', false);

  // the bench set the light; what this page adds on top of it
  U.snowCover.value = Math.max(0, Math.min(1, num('snow', 0)));
  if (Q.has('wind')) U.windSpeed.value = num('wind', 4);
  if (Q.has('gust')) U.gust.value = num('gust', 0);
  PROP_U.wet.value = Math.max(0, Math.min(1, num('wet', 0)));

  // ---- what to show ----
  const seeds = parseSeeds(str('seed', '0'));
  let specs = parseSpecs(str('m', ''));
  if (specs.length === 0) specs = listModels().map((e) => ({ name: e.name, opts: undefined }));
  interface Item { spec: Spec; seed: number; def: ModelDef; hx: number; hz: number; x: number; z: number; id: number }
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    for (const seed of seeds) {
      const key = modelKey(spec.name, seed, spec.opts);
      if (seen.has(key)) continue;
      seen.add(key);
      const def = getModel(spec.name, seed, spec.opts);
      // footprint about the origin: the model is placed by its origin
      const b = def.bounds;
      const hx = Math.max(Math.abs(b.min.x), Math.abs(b.max.x), 0.05), hz = Math.max(Math.abs(b.min.z), Math.abs(b.max.z), 0.05);
      items.push({ spec, seed, def, hx, hz, x: 0, z: 0, id: -1 });
    }
  }

  // ---- layout: rows along X, wrapped so the block is roughly 2:1 ----
  const yaw = num('yaw', 0) * DEG, scale = num('scale', 1);
  {
    const big = items.reduce((m, it) => Math.max(m, it.hx, it.hz), 0.05) * scale;
    const gap = Math.max(0.12, big * 0.45);
    // a yawed box needs its diagonal
    const ext = (it: Item): [number, number] => {
      const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
      return [(it.hx * c + it.hz * s) * scale, (it.hx * s + it.hz * c) * scale];
    };
    let area = 0, widest = 0;
    for (const it of items) {
      const [ex, ez] = ext(it);
      area += (2 * ex + gap) * (2 * ez + gap);
      widest = Math.max(widest, 2 * ex + gap);
    }
    const rowW = Math.max(widest, Math.sqrt(area * 2.4));
    let x = 0, z = 0, rowD = 0;
    const rows: Item[][] = [[]];
    for (const it of items) {
      const [ex, ez] = ext(it);
      if (x > 0 && x + 2 * ex + gap > rowW + 1e-6) {
        z -= rowD;
        x = 0;
        rowD = 0;
        rows.push([]);
      }
      it.x = x + ex + gap / 2;
      it.z = z - ez - gap / 2;
      x += 2 * ex + gap;
      rowD = Math.max(rowD, 2 * ez + gap);
      rows[rows.length - 1].push(it);
    }
    // centre every row, then the block
    let minZ = 0;
    for (const row of rows) {
      const w = row.reduce((m, it) => Math.max(m, it.x + ext(it)[0] + gap / 2), 0);
      for (const it of row) {
        it.x -= w / 2;
        minZ = Math.min(minZ, it.z - ext(it)[1] - gap / 2);
      }
    }
    for (const it of items) it.z -= minZ / 2;
  }

  // ---- the props, drawn the way the game draws them ----
  const list: PropInst[] = items.map((it) => ({ model: it.spec.name, seed: it.seed, x: it.x, y: 0, z: it.z, yaw, scale }));
  const props = createPropsSystem({ scene, camera }, list, { opts: (_inst, id) => items[id].spec.opts });
  engine.add(props);
  items.forEach((it, i) => (it.id = i));
  (window as any).PROPS = props;

  // bounds of everything, in world space
  const box = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  for (const it of items) {
    props.matrix(it.id, m4);
    box.union(it.def.bounds.clone().applyMatrix4(m4));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  box.min.y = Math.min(box.min.y, 0);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;

  // The bench's sun covers 52 m with one map: hug the models instead, for crisp contact shadows.
  {
    const r = radius * 1.15 + 0.3;
    const sc = bench.sun.shadow.camera;
    sc.left = sc.bottom = -r;
    sc.right = sc.top = r;
    sc.updateProjectionMatrix();
    bench.sun.shadow.bias = -0.0002;
    bench.sun.shadow.normalBias = Math.max(0.004, ((2 * r) / bench.sun.shadow.mapSize.x) * 2.5);
  }
  bench.orbit.target.copy(centre);

  // snowy ground: flat where the models stand, wind-drifted around them so the light has
  // something to roll over, out to the horizon (never white: the bench's snow tint)
  {
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
    const nz = mx_noise_float(positionWorld.xz.mul(0.6)).mul(0.5).add(mx_noise_float(positionWorld.xz.mul(4.3)).mul(0.3)).add(mx_noise_float(positionWorld.xz.mul(37)).mul(0.2));
    const sunFacing = max(dot(normalWorld, vec3(U.sunDir)), 0.0);
    mat.colorNode = vec3(0.86, 0.885, 0.93).mul(float(0.95).add(nz.mul(0.05))).mul(mix(vec3(0.9, 0.95, 1.0), vec3(1.0, 0.99, 0.97), sunFacing));
    mat.fog = true;
    // one wide field and no far disc: a 900 m disc of a few huge triangles drew a dark band on
    // the horizon through the post pipeline
    const size = Math.max(220, radius * 30);
    const geo = new THREE.PlaneGeometry(size, size, 288, 288).rotateX(-Math.PI / 2).translate(centre.x, 0, centre.z);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const flatR = radius * 1.05 + 0.3;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const d = Math.hypot(x - centre.x, z - centre.z);
      const k = Math.min(1, Math.max(0, (d - flatR) / (1.5 + radius)));
      const edge = Math.min(1, Math.max(0, (size * 0.5 - Math.max(Math.abs(x - centre.x), Math.abs(z - centre.z))) / (size * 0.08)));
      // drifts stretched across the wind (windDir is roughly +X)
      const h = fbm3(11, x * 0.16, 0, z * 0.32, 3) * 0.55;
      pos.setY(i, h * k * edge - 0.02 * (1 - edge));
    }
    geo.computeVertexNormals();
    const g = new THREE.Mesh(geo, mat);
    g.receiveShadow = true;
    g.name = 'ground';
    scene.add(g);
  }

  // stand-in fire and lamp light, so a model can be judged by its own glow: the engine bench's
  // test fire (14 at 18 m, decay 2) at the heart of the flame, scaled by the emitter's strength.
  // That value is tuned for the night; by day a fire's light is lost in the sun, so less of it.
  if (flag('fire', true)) {
    const byLight = ({ day: 0.06, dusk: 0.35, night: 1, storm: 0.2 } as Record<string, number>)[bench.light] ?? 1;
    for (const e of props.emitters('fire')) {
      if (e.def.lit === false) continue;
      const k = byLight * Math.max(0.3, Math.min(2, e.size / 0.22)) * (typeof e.def.strength === 'number' ? Math.max(0.15, e.def.strength) : 1);
      const p = new THREE.PointLight(new THREE.Color(1.0, 0.42, 0.12), 14 * k, 18, 2);
      // flames stand well above small fires too: never closer than 35 cm to the bed
      p.position.copy(e.position).addScaledVector(e.dir, Math.max(0.35, 0.1 + e.size));
      scene.add(p);
    }
    for (const l of props.lights()) {
      const p = new THREE.PointLight(new THREE.Color(l.def.color[0], l.def.color[1], l.def.color[2]), l.def.intensity, l.def.range, 2);
      p.position.copy(l.position);
      scene.add(p);
    }
  }

  // hinged parts
  const open = Math.max(0, Math.min(1, num('open', 0)));
  if (open > 0) for (const it of items) props.setOpen(it.id, open);

  // ---- debug drawing ----
  interface Tag { p: THREE.Vector3; text: string; dbg: boolean }
  const tags: Tag[] = [];
  if (flag('labels', true)) {
    for (const it of items) {
      props.matrix(it.id, m4);
      const p = new THREE.Vector3(0, 0, it.def.bounds.max.z + 0.02).applyMatrix4(m4);
      p.y = 0;
      const o = it.spec.opts ? ' ' + Object.entries(it.spec.opts).map(([k, v]) => `${k}=${v}`).join(' ') : '';
      tags.push({ p, text: `${it.spec.name} #${it.seed}${o}  ${it.def.tris}t`, dbg: false });
    }
  }
  if (debug) {
    const pos: number[] = [], col: number[] = [];
    const line = (a: THREE.Vector3, b: THREE.Vector3, c: [number, number, number]): void => {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      col.push(...c, ...c);
    };
    const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).applyMatrix4(m4);
    for (const it of items) {
      props.matrix(it.id, m4);
      const b = it.def.bounds;
      const cs = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => v(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
      for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) line(cs[i], cs[j], [0.25, 0.6, 1]);
      const k = Math.max(0.03, it.def.radius * 0.06);
      const cross = (p: THREE.Vector3, c: [number, number, number]): void => {
        line(p.clone().setX(p.x - k), p.clone().setX(p.x + k), c);
        line(p.clone().setY(p.y - k), p.clone().setY(p.y + k), c);
        line(p.clone().setZ(p.z - k), p.clone().setZ(p.z + k), c);
      };
      for (const a of Object.values(it.def.anchors)) {
        const p = a.position.clone().applyMatrix4(m4);
        cross(p, [0.3, 1, 0.4]);
        tags.push({ p, text: a.name, dbg: true });
      }
      for (const e of props.emittersOf(it.id)) {
        cross(e.position, [1, 0.5, 0.1]);
        line(e.position, e.position.clone().addScaledVector(e.dir, e.size * 2 + 0.1), [1, 0.5, 0.1]);
        tags.push({ p: e.position, text: e.type + (e.name ? ' ' + e.name : ''), dbg: true });
      }
      for (const l of it.def.lights) {
        const p = l.position.clone().applyMatrix4(m4);
        cross(p, [1, 1, 0.3]);
        tags.push({ p, text: 'light' + (l.name ? ' ' + l.name : ''), dbg: true });
      }
      for (const part of Object.values(it.def.parts)) {
        const p = part.pivot.clone().applyMatrix4(m4);
        cross(p, [1, 0.3, 1]);
        line(p, p.clone().add(part.axis.clone().transformDirection(m4).multiplyScalar(k * 4)), [1, 0.3, 1]);
        tags.push({ p, text: 'part ' + part.name, dbg: true });
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const lm = new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false, transparent: true, fog: false });
    const lines = new THREE.LineSegments(g, lm);
    lines.renderOrder = 10;
    lines.frustumCulled = false;
    scene.add(lines);
  }

  // ---- views ----
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  const rowsN = Math.ceil(n / cols);
  const zoom = num('zoom', 1);
  const tagLayers: HTMLDivElement[] = [];
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;overflow:hidden;pointer-events:none;z-index:3';
    document.body.appendChild(d);
    tagLayers.push(d);
    for (const t of tags) {
      const e = document.createElement('div');
      e.className = t.dbg ? 'tag dbg' : 'tag';
      e.textContent = t.text;
      d.appendChild(e);
    }
  }
  info.style.zIndex = '4';

  /** The part of the full frame a tile of aspect `aspect` shows (centred crop), as fractions. */
  const cropOf = (aspect: number): { fx: number; fy: number } => {
    const ca = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    return aspect <= ca ? { fx: aspect / ca, fy: 1 } : { fx: 1, fy: ca / aspect };
  };
  const toCam = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), corner = new THREE.Vector3();
  /** Distance along the (az, el) direction at which the bounds just fit a tile of this aspect. */
  function fitDistance(view: { az: number; el: number }, aspect: number): number {
    const az = view.az * DEG, el = view.el * DEG;
    toCam.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    right.set(Math.cos(az), 0, -Math.sin(az));
    up.crossVectors(toCam, right).normalize();
    const { fy } = cropOf(aspect);
    const ty = Math.tan((fov * DEG) / 2) * fy, tx = ty * aspect;
    let dist = 0.2;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(centre);
      const z = corner.dot(toCam);
      dist = Math.max(dist, z + Math.abs(corner.dot(up)) / ty, z + Math.abs(corner.dot(right)) / tx);
    }
    return (dist * 1.12) / zoom;
  }

  const proj = new THREE.Vector3();
  /** Put the tags of tile i on screen: tile rect (CSS px) and the crop of the frame it shows. */
  function placeTags(i: number, x: number, y: number, w: number, h: number, crop: { fx: number; fy: number }): void {
    const layer = tagLayers[i];
    layer.style.left = x + 'px';
    layer.style.top = y + 'px';
    layer.style.width = w + 'px';
    layer.style.height = h + 'px';
    camera.updateMatrixWorld(true);
    for (let k = 0; k < tags.length; k++) {
      const e = layer.children[k] as HTMLDivElement;
      proj.copy(tags[k].p).project(camera);
      const vis = proj.z > -1 && proj.z < 1;
      e.style.display = vis ? '' : 'none';
      e.style.position = 'absolute';
      e.style.left = ((proj.x / crop.fx) * 0.5 * w + 0.5 * w).toFixed(1) + 'px';
      e.style.top = ((-proj.y / crop.fy) * 0.5 * h + 0.5 * h + (tags[k].dbg ? -14 : 4)).toFixed(1) + 'px';
    }
  }

  (window as any).MODEL_INFO = items.map((it) => {
    const s = it.def.bounds.getSize(new THREE.Vector3());
    return {
      name: it.spec.name, seed: it.seed, opts: it.spec.opts ?? null, tris: it.def.tris,
      size: [s.x, s.y, s.z].map((v) => Math.round(v * 1000) / 1000),
      anchors: Object.keys(it.def.anchors), emitters: it.def.emitters.map((e) => e.type + (e.name ? ':' + e.name : '')),
      lights: it.def.lights.length, parts: Object.keys(it.def.parts), glass: !!it.def.glass,
      registered: hasModel(it.spec.name), size_class: modelMeta(it.spec.name).size,
    };
  });
  const writeInfo = (calls: number, tris: number): void => {
    const totalTris = items.reduce((s, it) => s + it.def.tris, 0);
    info.textContent = `three r${THREE.REVISION} ${engine.backend} ${engine.quality.name}  ${bench.light}  snow ${U.snowCover.value}  ${items.length} models ${totalTris} tris  ${props.info.batches} batches  ${calls} calls ${(tris / 1000).toFixed(1)}k tris drawn` + (failed.length ? `\nfailed to load: ${failed.join(', ')}` : '');
  };

  if (n === 1) {
    // one view: the bench's orbit camera (its az runs the other way round from this page's)
    const W = canvas.clientWidth, H = canvas.clientHeight;
    bench.orbit.az = -views[0].az;
    bench.orbit.el = views[0].el;
    bench.orbit.dist = fitDistance(views[0], W / H);
    let frames = 0;
    bench.onFrame(() => {
      camera.near = Math.max(0.02, bench.orbit.dist * 0.02);
      camera.updateProjectionMatrix();
      placeTags(0, 0, 0, canvas.clientWidth, canvas.clientHeight, { fx: 1, fy: 1 });
      if (++frames === 3) release();
      if (frames % 30 === 3) writeInfo(engine.stats.calls, engine.stats.tris);
    });
  } else {
    // several views: render each in turn, copy the crop it needs into its tile
    const overlay = document.createElement('canvas');
    overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
    document.body.appendChild(overlay);
    let done = false;
    bench.onFrame((_dt, time) => {
      if (done) return;
      done = true;
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      const ctx = overlay.getContext('2d')!;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const tw = W / cols, th = H / rowsN;
      const f: Frame = { dt: 1 / 60, time, view: undefined as unknown as Frame['view'] };
      let calls = 0, tris = 0;
      for (let i = 0; i < n; i++) {
        const crop = cropOf(tw / th);
        const dist = fitDistance(views[i], tw / th);
        camera.position.copy(centre).addScaledVector(toCam, dist);
        camera.lookAt(centre);
        camera.near = Math.max(0.02, dist * 0.02);
        camera.updateProjectionMatrix();
        // a few frames on the same view: AO and the like settle, nothing carries over from the last
        for (let k = 0; k < 3; k++) engine.frame(f);
        calls += engine.stats.calls;
        tris += engine.stats.tris;
        const sw = canvas.width * crop.fx, sh = canvas.height * crop.fy;
        const sx = (canvas.width - sw) / 2, sy = (canvas.height - sh) / 2;
        const k = canvas.width / W;
        const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
        ctx.drawImage(canvas, sx, sy, sw, sh, x * k, y * k, tw * k, th * k);
        placeTags(i, x, y, tw, th, crop);
      }
      writeInfo(calls, tris);
      release();
    });
  }
}

main().catch((err) => {
  console.error(err);
  info.textContent = String(err && err.stack ? err.stack : err);
  (window as any).DONE = true;
});
