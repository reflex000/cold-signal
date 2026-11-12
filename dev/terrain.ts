// Terrain bench: the real world (createWorld(417)) drawn by the terrain system alone, under the
// bench's stand-in sky.
//
//   dev/terrain.html?view=wreck|tail|cabin|lake|cave|camp|ridge|aerial|map
//                   &light=day|dusk|night|storm &q=mobile|low|medium|high|ultra &webgl=1
//   &wire=1      wireframe coloured by LOD          &debug=1..4  LOD / horizon shadow / normals / masks
//   &prints=1    a test painter stamps footprints into U.trailTex (the M6 snow-deformation hook)
//   &perf=1      after warm-up, GPU time with and without the terrain, logged as PERF (window.PERF)
//   &yaw= &pitch= &fwd=   override the view's look direction (degrees) / move forward (m)
//   &x= &z= &up=          put the eye anywhere (world metres; up = height above the ground)
//   &holes=1              magenta background, no AO: cracks and holes in the ground show at once
//   &sparkle=1 &detail=1  scale the glints / the snow detail normals (TERRAIN_U)
//   (plus everything dev/bench.ts reads: t, frames, hud, exp, fov, ...)
// Views put the camera 1.7 m above the ground at a place from world.pois (aerial: 300 m up, map:
// high over the south valley looking at the whole ring). Owner: TERRAIN.
import * as THREE from 'three/webgpu';
import { createWorld } from '../src/world/index';
import { U } from '../src/gfx/shared';
import { TERRAIN_U, createTerrainSystem } from '../src/gfx/terrain/index';
import { createBench } from './bench';

const b = await createBench({ light: 'dusk', ground: false });
const { engine } = b;

const t0 = performance.now();
const world = createWorld(417);
const t1 = performance.now();
const terrain = createTerrainSystem(engine, world);
const t2 = performance.now();
engine.add(terrain);
console.log(`[terrain bench] createWorld ${(t1 - t0).toFixed(0)} ms, createTerrainSystem ${(t2 - t1).toFixed(0)} ms`);
(window as any).TERRAIN = terrain;
(window as any).WORLD = world;

// ---- views ----
interface View { x: number; z: number; up: number; yaw: number; pitch: number }
const poi = (id: Parameters<typeof world.poi>[0]) => world.poi(id);
const VIEWS: Record<string, () => View> = {
  wreck: () => ({ x: poi('wreck').x + 6, z: poi('wreck').z + 30, up: 1.7, yaw: 18, pitch: 3 }),
  tail: () => ({ x: poi('tail').x, z: poi('tail').z + 6, up: 1.7, yaw: 352, pitch: 5 }),
  cabin: () => ({ x: poi('cabin').x + 20, z: poi('cabin').z + 24, up: 1.7, yaw: 62, pitch: 1 }),
  lake: () => ({ x: poi('lake').x - 30, z: poi('lake').z + 175, up: 1.7, yaw: 8, pitch: -2 }),
  cave: () => ({ x: poi('cave').x + 10, z: poi('cave').z + 45, up: 1.7, yaw: 350, pitch: 10 }),
  camp: () => ({ x: poi('camp').x - 8, z: poi('camp').z + 12, up: 1.7, yaw: 228, pitch: -3 }),
  ridge: () => ({ x: poi('tower').x + 4, z: poi('tower').z + 26, up: 1.7, yaw: 182, pitch: -5 }),
  aerial: () => ({ x: -60, z: 980, up: 300, yaw: 2, pitch: -17 }),
  map: () => ({ x: 0, z: 3000, up: 4200, yaw: 0, pitch: -52 }),
};
const viewName = b.param('view') ?? 'wreck';
const v = (VIEWS[viewName] ?? VIEWS.wreck)();
v.x = b.num('x', v.x);
v.z = b.num('z', v.z);
v.up = b.num('up', v.up);
const yaw = b.num('yaw', v.yaw);
const pitch = b.num('pitch', v.pitch);
const fwd = b.num('fwd', 0);
const DEG = Math.PI / 180;
const dir = new THREE.Vector3(Math.sin(yaw * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG));
const ex = v.x + Math.sin(yaw * DEG) * fwd;
const ez = v.z - Math.cos(yaw * DEG) * fwd;
const eye = new THREE.Vector3(ex, terrain.heightAt(ex, ez) + v.up, ez);
// The bench orbit camera looks at its target from `dist` away: put the target in front of the eye.
const dist = v.up > 50 ? 400 : 12;
b.orbit.dist = dist;
b.orbit.az = yaw;
b.orbit.el = -pitch;
b.orbit.target.copy(eye).addScaledVector(dir, dist);

// ---- debug flags ----
if (b.param('holes') === '1') {
  // magenta behind everything: any crack or hole in the ground shows at once
  engine.scene.backgroundNode = null;
  engine.scene.background = new THREE.Color(1, 0, 1);
  engine.post.uniforms.aoStrength.value = 0;
}
if (b.param('wire') === '1') {
  terrain.wireframe = true;
  terrain.debug = 1;
}
TERRAIN_U.sparkle.value = b.num('sparkle', 1);
TERRAIN_U.detail.value = b.num('detail', 1);
TERRAIN_U.skirt.value = b.num('skirt', 1);
const dbg = b.num('debug', 0);
if (dbg > 0) terrain.debug = dbg;

// ---- test painter for the snow-deformation hook ----
if (b.param('prints') === '1') {
  const SIZE = 16; // metres covered by the map
  const PX = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PX;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, PX, PX);
  // map centre a few metres in front of the eye
  const cx = eye.x + Math.sin(yaw * DEG) * 6;
  const cz = eye.z - Math.cos(yaw * DEG) * 6;
  const toPx = (x: number, z: number): [number, number] => [((x - cx) / SIZE + 0.5) * PX, ((z - cz) / SIZE + 0.5) * PX];
  // a walker crossing the view: alternating boot prints along a gentle curve, 0.7 m stride
  const across = (yaw + 90) * DEG;
  const sx = Math.sin(across), sz = -Math.cos(across);
  const fx = Math.sin(yaw * DEG), fz = -Math.cos(yaw * DEG);
  for (let k = -11; k <= 11; k++) {
    const s = k * 0.7;
    const bend = 0.04 * s * s;
    const side = k % 2 === 0 ? 0.13 : -0.13;
    const px = cx + sx * s + fx * (bend + side), pz = cz + sz * s + fz * (bend + side);
    const [u, w] = toPx(px, pz);
    const ang = Math.atan2(sz, sx) + 0.08 * s;
    ctx.save();
    ctx.translate(u, w);
    ctx.rotate(ang);
    const L = (0.3 / SIZE) * PX, W = (0.12 / SIZE) * PX;
    ctx.scale(L, W);
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gr.addColorStop(0, 'rgb(255,0,0)');
    gr.addColorStop(0.65, 'rgb(235,0,0)');
    gr.addColorStop(1, 'rgb(0,0,0)');
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // a dragged log: a shallow groove
  ctx.strokeStyle = 'rgba(150,0,0,1)';
  ctx.lineCap = 'round';
  ctx.lineWidth = (0.35 / SIZE) * PX;
  ctx.beginPath();
  const [a0, b0] = toPx(cx - sx * 7 + fx * 2.5, cz - sz * 7 + fz * 2.5);
  const [a1, b1] = toPx(cx + sx * 7 + fx * 3.5, cz + sz * 7 + fz * 3.5);
  ctx.moveTo(a0, b0);
  ctx.lineTo(a1, b1);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  U.trailTex.value = tex;
  U.trailOrigin.value.set(cx, cz);
  U.trailSize.value = SIZE;
  U.trailOn.value = 1;
}

// ---- stats / perf ----
const stats = { frames: 0 };
(window as any).TERRAIN_STATS = terrain.stats;
let hud: HTMLDivElement | null = null;
if (b.param('hud') === '1') {
  hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:8px;top:56px;color:#dfe5ec;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none;text-shadow:0 1px 2px #000';
  document.body.appendChild(hud);
}
if (b.param('perf') === '1') {
  b.busy(
    new Promise<void>((resolve) => {
      const WARM = 90, N = 150;
      let on = 0, onN = 0, off = 0, offN = 0;
      b.onFrame(() => {
        stats.frames++;
        const f = stats.frames;
        const g = engine.stats.gpuMs;
        if (f > WARM && f <= WARM + N) {
          on += g;
          onN++;
        } else if (f === WARM + N + 1) {
          terrain.object.visible = false;
        } else if (f > WARM * 2 + N && f <= WARM * 2 + 2 * N) {
          off += g;
          offN++;
        } else if (f === WARM * 2 + 2 * N + 1) {
          terrain.object.visible = true;
          const r = {
            view: viewName, quality: engine.quality.name, backend: engine.backend, size: `${engine.width}x${engine.height}`,
            gpuWithTerrain: on / Math.max(1, onN), gpuWithout: off / Math.max(1, offN), terrainMs: on / Math.max(1, onN) - off / Math.max(1, offN),
            nodes: terrain.stats.nodes, tris: terrain.stats.tris, calls: engine.stats.calls,
          };
          (window as any).PERF = r;
          console.log('PERF ' + JSON.stringify(r));
          resolve();
        }
      });
    }),
  );
}
let hudTick = 0;
b.onFrame(() => {
  if (hud && hudTick++ % 10 === 0) {
    const s = terrain.stats;
    hud.textContent = `terrain ${s.nodes} nodes  ${(s.tris / 1000).toFixed(0)}k tris  visited ${s.visited}  horizon ${s.horizonBuilds}\neye ${eye.x.toFixed(0)} ${eye.y.toFixed(0)} ${eye.z.toFixed(0)}  view ${viewName}`;
  }
});
