// TERRAIN: the ground of the whole world and the mountains around it.
//
//   const terrain = createTerrainSystem(engine, world);   // adds its meshes to engine.scene
//   engine.add(terrain);                                  // update() selects LODs every frame
//
// - Geometry: CDLOD quadtree (lod.ts) over a 12 km square, four instanced draws, heights sampled on
//   the GPU from one R32F copy of world.heightmap (height.ts) and a generated far ring (ring.ts).
// - Material: snow / rock / ice / trail / footprints / far forest (material.ts).
// - Shadows: the near nodes cast and every node receives sun shadows; baked horizon maps
//   (horizon.ts) shade valleys from distant ridges beyond the shadow-map distance.
// - Quality: terrainDetail picks the mesh density (config.ts), the 'mobile' preset a simpler
//   material; setQuality() swaps both at run time. shadowDistance decides which nodes cast.
// Owner: TERRAIN.
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { Engine, Frame, GfxSystem, Quality } from '../api';
import type { World } from '../../world/types';
import { ATMOS } from '../shared';
import { lodConfig, lodRange, materialTier, type LodConfig, type MaterialTier } from './config';
import { buildTerrainData, type TerrainData } from './data';
import { createHeightFns, type HeightFns } from './height';
import { HorizonMaps } from './horizon';
import { LodSelector, makeGridGeometry, type NodeList } from './lod';
import { TERRAIN_U, createTerrainMaterial, type TerrainUniforms } from './material';
import { sampleFar } from './ring';

export { TERRAIN_U } from './material';

export interface TerrainStats {
  /** Nodes drawn last frame. */
  nodes: number;
  /** Triangles submitted last frame (main pass). */
  tris: number;
  /** Quadtree nodes visited by the selection. */
  visited: number;
  /** Horizon-map passes rendered since creation. */
  horizonBuilds: number;
}

export interface TerrainSystem extends GfxSystem {
  readonly name: 'terrain';
  /** Everything the terrain draws (already in engine.scene). */
  readonly object: THREE.Group;
  /**
   * Height of the drawn ground at world xz: world.heightAt inside the heightmap, the far ring
   * outside (the near-camera detail noise of a few centimetres is not included).
   */
  heightAt(x: number, z: number): number;
  /** 0 off, 1 LOD colours, 2 baked horizon shadow, 3 normals, 4 material masks, 5 NaN finder, 6 visible skirts. */
  debug: number;
  /** Draw the terrain as wireframe (with debug 1 it shows the LOD bands). */
  wireframe: boolean;
  readonly stats: TerrainStats;
}

interface Part {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  attr: THREE.InstancedBufferAttribute;
  quarter: boolean;
  near: boolean;
  tris: number;
}

class TerrainSystemImpl implements TerrainSystem {
  readonly name = 'terrain' as const;
  readonly object = new THREE.Group();
  readonly stats: TerrainStats = { nodes: 0, tris: 0, visited: 0, horizonBuilds: 0 };

  private data: TerrainData;
  private h: HeightFns;
  private horizon: HorizonMaps;
  private tu: TerrainUniforms;
  private cfg: LodConfig | null = null;
  private tier: MaterialTier | null = null;
  private selector: LodSelector | null = null;
  private parts: Part[] = [];
  private material: THREE.MeshStandardNodeMaterial | null = null;
  private shadowDist = 0;
  private wire = false;
  private camPos = new THREE.Vector3();
  private lightDir = new THREE.Vector3();
  private lastBody: 'sun' | 'moon' | null = null;

  constructor(private engine: Engine, private world: World) {
    this.data = buildTerrainData(world);
    this.tu = {
      lodCam: uniform(new THREE.Vector3()),
      hc: uniform(1.7),
      r0: uniform(20),
      cell0: uniform(0.25),
      cubicLod: uniform(3),
      detailFade: uniform(new THREE.Vector2(24, 72)),
      viewDist: uniform(2800),
    };
    this.h = createHeightFns(this.data, this.tu.cell0, this.tu.cubicLod);
    this.horizon = new HorizonMaps(this.data, this.h);
    this.object.name = 'terrain';
    engine.scene.add(this.object);
    this.setQuality(engine.quality);
  }

  get debug(): number {
    return TERRAIN_U.debug.value;
  }

  set debug(v: number) {
    TERRAIN_U.debug.value = Math.max(0, Math.min(6, Math.round(v)));
  }

  get wireframe(): boolean {
    return this.wire;
  }

  set wireframe(v: boolean) {
    this.wire = v;
    if (this.material) {
      this.material.wireframe = v;
      this.material.needsUpdate = true;
    }
  }

  heightAt(x: number, z: number): number {
    const E = this.data.fineExtent;
    const inside = E - Math.max(Math.abs(x), Math.abs(z));
    if (inside >= 96) return this.world.heightAt(x, z);
    const far = sampleFar(this.data.far, x, z);
    if (inside <= 0) return far;
    const t = inside / 96;
    const w = t * t * (3 - 2 * t);
    return far + (this.world.heightAt(x, z) - far) * w;
  }

  setQuality(q: Quality): void {
    const cfg = lodConfig(q.terrainDetail);
    const tier = materialTier(q);
    this.shadowDist = q.shadowCascades > 0 ? q.shadowDistance * 1.15 : 0;
    this.tu.viewDist.value = q.viewDistance;
    const cfgChanged = !this.cfg || this.cfg.n !== cfg.n || this.cfg.cell0 !== cfg.cell0 || this.cfg.k !== cfg.k;
    const tierChanged = !this.tier || this.tier.mobile !== tier.mobile || this.tier.sparkle !== tier.sparkle;
    if (cfgChanged) {
      this.cfg = cfg;
      this.selector = new LodSelector(cfg, this.data.minmax);
      this.tu.r0.value = lodRange(cfg, 0);
      this.tu.cell0.value = cfg.cell0;
      this.tu.cubicLod.value = cfg.cubicLod;
      // drift noise needs sub-metre vertices: fade it out across the LODs finer than 1 m
      const lod1m = Math.max(1, Math.round(Math.log2(1 / cfg.cell0)));
      this.tu.detailFade.value.set(lodRange(cfg, lod1m - 1) * 0.6, lodRange(cfg, lod1m) * 0.9);
    }
    if (tierChanged || !this.material) {
      this.tier = tier;
      const old = this.material;
      this.material = createTerrainMaterial(this.data, this.h, this.horizon, this.tu, tier);
      this.material.wireframe = this.wire;
      for (const p of this.parts) p.mesh.material = this.material;
      old?.dispose();
    }
    if (cfgChanged) this.buildParts(cfg);
  }

  private buildParts(cfg: LodConfig): void {
    for (const p of this.parts) {
      this.object.remove(p.mesh);
      p.geometry.dispose();
    }
    this.parts = [];
    const mat = this.material as THREE.MeshStandardNodeMaterial;
    for (const near of [true, false]) {
      for (const quarter of [false, true]) {
        const m = quarter ? cfg.n / 2 : cfg.n;
        const { geometry, attr } = makeGridGeometry(m, cfg.maxNodes);
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.name = `terrain-${near ? 'near' : 'far'}-${quarter ? 'quarter' : 'full'}`;
        mesh.frustumCulled = false; // the shader places the vertices; nodes are culled on the CPU
        mesh.castShadow = near;
        mesh.receiveShadow = true;
        // after the opaque props and trees, so early depth rejects ground hidden behind them
        mesh.renderOrder = near ? 1 : 2;
        mesh.matrixAutoUpdate = false;
        this.object.add(mesh);
        this.parts.push({ mesh, geometry, attr, quarter, near, tris: 2 * m * m + 8 * m });
      }
    }
  }

  update(_f: Frame): void {
    const sel = this.selector;
    if (!sel) return;
    const cam = this.engine.camera;
    cam.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
    const ground = this.heightAt(this.camPos.x, this.camPos.z);
    const hc = Math.max(0, this.camPos.y - ground);
    const s = sel.select(cam, hc, this.shadowDist);
    this.tu.lodCam.value.copy(this.camPos);
    this.tu.hc.value = hc;

    let nodes = 0, tris = 0;
    for (const p of this.parts) {
      const list: NodeList = p.quarter ? (p.near ? s.quarterNear : s.quarterFar) : p.near ? s.fullNear : s.fullFar;
      const n = list.count;
      if (n > 0) {
        (p.attr.array as Float32Array).set(list.data.subarray(0, n * 4));
        p.attr.clearUpdateRanges();
        p.attr.addUpdateRange(0, n * 4);
        p.attr.needsUpdate = true;
      }
      p.geometry.instanceCount = n;
      p.mesh.visible = n > 0;
      nodes += n;
      tris += n * p.tris;
    }
    this.stats.nodes = nodes;
    this.stats.tris = tris;
    this.stats.visited = sel.visited;

    // Horizon maps follow whichever body lights the world.
    const sunL = ATMOS.sunColor.r + ATMOS.sunColor.g + ATMOS.sunColor.b;
    const moonL = ATMOS.moonColor.r + ATMOS.moonColor.g + ATMOS.moonColor.b;
    const body = sunL >= moonL ? 'sun' : 'moon';
    this.lightDir.copy(body === 'sun' ? ATMOS.sunDir : ATMOS.moonDir).normalize();
    this.horizon.update(this.engine.renderer, this.lightDir, body !== this.lastBody);
    this.lastBody = body;
    this.stats.horizonBuilds = this.horizon.builds;
  }

  dispose(): void {
    this.engine.scene.remove(this.object);
    for (const p of this.parts) p.geometry.dispose();
    this.parts = [];
    this.material?.dispose();
    this.material = null;
    this.horizon.dispose();
    this.data.dispose();
  }
}

/** The terrain system. Adds its meshes to engine.scene; the caller adds the system to the engine. */
export function createTerrainSystem(engine: Engine, world: World): TerrainSystem {
  return new TerrainSystemImpl(engine, world);
}
