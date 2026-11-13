// Open water and new ice on the frozen lake: what the terrain's ice surface cannot show (view.ice).
//   a broken cell (hole):        black water, still and glassy, inside a ragged edge of broken slabs;
//                                as the film forms (IceCell.skin) the water greys over toward ice
//   a refrozen cell (skin, no hole): dark, clear new ice, smooth and crazed with white fractures,
//                                the old slabs frozen into its edge
// Every cell is a ragged disc a little larger than the 4 m grid cell, so neighbouring holes run
// together into one opening. Drawn as decals a hair above the lake surface (polygon offset): one
// instanced mesh for water, one for new ice, one for the slabs, rebuilt only when the cells change.
// The splash and the flying shards when the ice goes are FX's (impacts.ts, on 'iceBreak' / 'splash').
// Owner: TOGETHER.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { hash01 } from '../core/rng';
import type { Frame, GfxSystem } from '../gfx/api';
import type { CsEngine } from '../gfx/engine';
import { U } from '../gfx/shared';
import type { IceCell } from '../sim/types';
import type { World } from '../world/types';

const MAX_CELLS = 96;
const SLABS_PER_CELL = 13;
const SKIN_WALK = 0.025; // ice.ts: the film that closes a hole again (m)
const LIFT = 0.012; // metres above the ice surface

/** A flat ragged disc of radius about 1 (y up), centred on the origin. */
function raggedDisc(seed: number): THREE.BufferGeometry {
  const N = 28;
  const pos: number[] = [0, 0, 0];
  const idx: number[] = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    // a broken edge: a few big bites plus small teeth
    const r = 0.86 + 0.12 * Math.sin(a * 3 + seed) + 0.07 * Math.sin(a * 7 + seed * 2.3) + 0.05 * (hash01(seed, k) - 0.5);
    pos.push(Math.sin(a) * r, 0, Math.cos(a) * r);
  }
  // counter-clockwise seen from above: the face points up (+Y)
  for (let k = 0; k < N; k++) idx.push(0, 1 + k, 1 + ((k + 1) % N));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/**
 * A shard of broken lake ice: an irregular flat polygon (about 1 x 1 across), 1 thick, standing on
 * y = 0; scaled per instance to a few centimetres thick. Flat-shaded (each face its own vertices).
 */
function slabGeometry(): THREE.BufferGeometry {
  const N = 7;
  const ring: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2 + 0.35 * (hash01(k, 5) - 0.5);
    const r = 0.5 * (0.62 + 0.45 * hash01(k, 9));
    ring.push([Math.sin(a) * r, Math.cos(a) * r]);
  }
  const pos: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
  for (let k = 0; k < N; k++) {
    const [x0, z0] = ring[k], [x1, z1] = ring[(k + 1) % N];
    tri([0, 1, 0], [x0, 1, z0], [x1, 1, z1]); // top, facing up
    tri([0, 0, 0], [x1, 0, z1], [x0, 0, z0]); // bottom
    tri([x0, 0, z0], [x1, 0, z1], [x1, 1, z1]); // the broken edge
    tri([x0, 0, z0], [x1, 1, z1], [x0, 1, z0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function decalMaterial(m: THREE.MeshStandardNodeMaterial): THREE.MeshStandardNodeMaterial {
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -4;
  return m;
}

export function createIceVisuals(engine: CsEngine, world: World): GfxSystem {
  const { positionWorld, float, sin, max, smoothstep, mix, vec2, vec3, length, instanceColor, mx_worley_noise_vec2, mx_noise_float } = TSL as any;
  const lake = world.lake;
  const group = new THREE.Group();
  group.name = 'lake-ice';
  engine.scene.add(group);

  // --- black water: dark, glassy (the sky and the snow banks reflect in it); the film greys it.
  // The instance colour is the albedo (three multiplies it into the diffuse colour by itself: the
  // material's own colour stays white); it also says how far the film has come, which roughens it.
  const waterMat = decalMaterial(new THREE.MeshStandardNodeMaterial({ metalness: 0 }));
  // still water under a grey sky is dark: keep the reflection of the sky dome down to a sheen
  (waterMat as unknown as { envMapIntensity: number }).envMapIntensity = 0.35;
  waterMat.name = 'lake-water';
  const film = instanceColor.r.sub(0.012).div(0.2).clamp(0, 1);
  waterMat.roughnessNode = mix(float(0.09), float(0.5), film);

  // --- new ice: clear and dark, white fracture lines crazing it (two warped line families)
  const newMat = decalMaterial(new THREE.MeshStandardNodeMaterial({ metalness: 0 }));
  newMat.name = 'lake-newice';
  // fractures: the edges of two Worley cell patterns (big plates, fine crazing), a few centimetres
  // wide at most, fading out with distance so they do not shimmer
  const p0 = positionWorld.xz;
  const p = p0.add(vec2(mx_noise_float(p0.mul(0.45)), mx_noise_float(p0.mul(0.45).add(3.1))).mul(0.7));
  const big = mx_worley_noise_vec2(p.mul(0.75), 0.9);
  const fine = mx_worley_noise_vec2(p.mul(2.6).add(7.3), 0.85);
  const far = smoothstep(18, 6, length(positionWorld.sub(U.camPos)));
  const cracks = max(smoothstep(0.022, 0.0, big.y.sub(big.x)).mul(0.85), smoothstep(0.012, 0.0, fine.y.sub(fine.x)).mul(0.25)).mul(far.mul(0.7).add(0.3));
  newMat.colorNode = mix(vec3(0.05, 0.066, 0.082), vec3(0.34, 0.39, 0.44), cracks);
  newMat.roughnessNode = mix(float(0.14), float(0.6), cracks);

  // --- broken slabs: old lake ice, white-blue, snow-dusted on top
  const slabMat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  slabMat.name = 'lake-slab';
  const up = smoothstep(0.35, 0.85, (TSL as any).normalWorld.y);
  // glassy broken edges; on top a dusting of snow, uneven (wind-packed patches and bare ice)
  const dust = sin(positionWorld.x.mul(5.3).add(sin(positionWorld.z.mul(3.7)))).mul(sin(positionWorld.z.mul(6.1).add(positionWorld.x.mul(1.3)))).mul(0.5).add(0.5);
  slabMat.colorNode = mix(vec3(0.16, 0.22, 0.27), mix(vec3(0.4, 0.46, 0.51), vec3(0.72, 0.75, 0.78), dust.mul(0.7).add(0.3)), up);
  slabMat.roughnessNode = mix(float(0.1), float(0.65), up);

  const disc = raggedDisc(1.7);
  const slab = slabGeometry();
  const water = new THREE.InstancedMesh(disc, waterMat, MAX_CELLS);
  const fresh = new THREE.InstancedMesh(disc, newMat, MAX_CELLS);
  const slabs = new THREE.InstancedMesh(slab, slabMat, MAX_CELLS * SLABS_PER_CELL);
  water.setColorAt(0, new THREE.Color(0, 0, 0));
  for (const m of [water, fresh, slabs]) {
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
  }
  slabs.castShadow = true;

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const _c = new THREE.Color();
  let sig = '';
  const holes: { x: number; z: number }[] = [];

  const centre = (i: number): { x: number; z: number } => {
    const cx = i % lake.n, cz = Math.floor(i / lake.n);
    return { x: lake.minX + (cx + 0.5) * lake.cell, z: lake.minZ + (cz + 0.5) * lake.cell };
  };

  function rebuild(cells: Map<number, IceCell>): void {
    let nw = 0, nf = 0, ns = 0;
    holes.length = 0;
    for (const c of cells.values()) if (c.hole) holes.push(centre(c.i));
    const R = lake.cell * 0.62;
    for (const c of cells.values()) {
      const open = c.hole;
      const refrozen = !c.hole && c.skin !== undefined;
      if (!open && !refrozen) continue; // stressed sound ice: the terrain's ice and the creaks tell it
      if (nw >= MAX_CELLS || nf >= MAX_CELLS) break;
      const { x, z } = centre(c.i);
      const h = (k: number) => hash01(c.i, k, 911);
      const y = lake.level + LIFT;
      const size = R * (0.92 + 0.16 * h(1));
      _e.set(0, h(2) * Math.PI * 2, 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set(x, y, z), _q, _s.set(size, 1, size * (0.9 + 0.2 * h(3))));
      if (open) {
        // the film greys the water as it thickens toward the skin that closes it
        const f = Math.min(1, (c.skin ?? 0) / SKIN_WALK);
        water.setMatrixAt(nw, _m);
        _c.setRGB(0.012 + 0.2 * f, 0.016 + 0.23 * f, 0.02 + 0.26 * f);
        water.setColorAt(nw, _c);
        nw++;
      } else {
        fresh.setMatrixAt(nf++, _m);
      }
      // the ragged edge: slabs of the old ice round the rim, tipped up where the water lifted them,
      // none inside a neighbouring hole (they would float in the middle of an opening)
      const slabsHere = open ? SLABS_PER_CELL : Math.ceil(SLABS_PER_CELL * 0.5);
      for (let k = 0; k < slabsHere && ns < slabs.instanceMatrix.count; k++) {
        const a = (k / slabsHere) * Math.PI * 2 + h(10 + k) * 0.6;
        const rr = size * (0.86 + 0.18 * h(20 + k));
        const sx = x + Math.sin(a) * rr, sz = z + Math.cos(a) * rr;
        let inside = false;
        for (const o of holes) if ((o.x !== x || o.z !== z) && Math.hypot(sx - o.x, sz - o.z) < R * 0.8) inside = true;
        if (inside) continue;
        const len = 0.3 + 0.55 * h(30 + k), wid = 0.25 + 0.4 * h(40 + k), thick = 0.035 + 0.045 * h(80 + k);
        const tilt = open ? 0.02 + 0.16 * h(50 + k) : 0.01 + 0.035 * h(50 + k);
        _e.set(tilt * (h(60 + k) > 0.5 ? 1 : -1), a + Math.PI / 2 + (h(70 + k) - 0.5) * 0.8, tilt * 0.5, 'YXZ');
        _q.setFromEuler(_e);
        // afloat half under in open water; frozen in up to their top in new ice
        _m.compose(_p.set(sx, lake.level - thick * (open ? 0.55 : 0.85), sz), _q, _s.set(len, thick, wid));
        slabs.setMatrixAt(ns++, _m);
      }
    }
    water.count = nw;
    fresh.count = nf;
    slabs.count = ns;
    for (const m of [water, fresh, slabs]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  return {
    name: 'lakeice',
    update(f: Frame): void {
      const cells = f.view.ice;
      if (!cells || cells.size === 0) {
        if (sig !== '') {
          sig = '';
          water.count = fresh.count = slabs.count = 0;
        }
        return;
      }
      // what is drawn changes only when a cell opens, closes or its film moves by a millimetre
      let s = '';
      for (const c of cells.values()) if (c.hole || c.skin !== undefined) s += c.i + (c.hole ? 'h' : 'f') + Math.round((c.skin ?? 0) * 1000) + ',';
      if (s === sig) return;
      sig = s;
      rebuild(cells);
    },
    dispose(): void {
      engine.scene.remove(group);
      disc.dispose();
      slab.dispose();
      waterMat.dispose();
      newMat.dispose();
      slabMat.dispose();
    },
  };
}
