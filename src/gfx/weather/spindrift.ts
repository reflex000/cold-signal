// Spindrift: low sheets of snow blown along the ground in strong wind. Three thin layers draped
// over the terrain around the camera (heights from world.heightAt, refreshed when the camera has
// moved a cell), each streaming a stretched noise along the wind at its own speed (the wind is
// slower near the ground), fading in above about 8 m/s. Owner: ATMOS.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import type { World } from '../../world/types';
import { U } from '../shared';
import { fogAmount, fogColor, hgPhase, type N } from '../sky/common';
import { getNoise2D } from '../sky/textures';

const { attribute, uniform, varying, texture, vec2, vec3, vec4, float, abs, clamp, max, dot, mix, smoothstep, length, positionLocal, modelWorldMatrix } = TSL as any;

const CELLS = 36; // grid cells per side
const CELL = 2.5; // metres
const LAYERS = [0.1, 0.32, 0.7]; // metres above the snow

export const DRIFTU = {
  /** 0..1 how much spindrift there is (strong wind, fresh snow). */
  amount: uniform(0),
  /** Wind direction, unit world XZ. */
  dir: uniform(new THREE.Vector2(1, 0)),
  /** Scroll offset of the streak noise along the wind, per layer (uv units, wrapped). */
  scroll: uniform(new THREE.Vector3()),
};

export class Spindrift {
  readonly mesh: THREE.Mesh;
  private world: World | null;
  private heights: Float32Array;
  private heightAttr: THREE.BufferAttribute;
  private cx = NaN;
  private cz = NaN;

  constructor(world: World | null) {
    this.world = world;
    const n = CELLS + 1;
    const verts = n * n;
    const pos = new Float32Array(verts * 3 * LAYERS.length);
    const layer = new Float32Array(verts * LAYERS.length);
    this.heights = new Float32Array(verts * LAYERS.length);
    const idx: number[] = [];
    for (let l = 0; l < LAYERS.length; l++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const v = l * verts + j * n + i;
          pos[v * 3] = (i - CELLS / 2) * CELL;
          pos[v * 3 + 1] = 0;
          pos[v * 3 + 2] = (j - CELLS / 2) * CELL;
          layer[v] = l;
        }
      }
      for (let j = 0; j < CELLS; j++) {
        for (let i = 0; i < CELLS; i++) {
          const a = l * verts + j * n + i;
          idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));
    this.heightAttr = new THREE.BufferAttribute(this.heights, 1);
    this.heightAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aGround', this.heightAttr);
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.mesh = new THREE.Mesh(g, this.material());
    this.mesh.name = 'weather.spindrift';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
  }

  private material(): THREE.NodeMaterial {
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'Spindrift';
    m.transparent = true;
    m.depthWrite = false;
    m.fog = false;
    m.lights = false;
    m.side = THREE.DoubleSide;
    const layer: N = attribute('aLayer', 'float');
    const ground: N = attribute('aGround', 'float');
    const lift = mix(mix(float(LAYERS[0]), float(LAYERS[1]), clamp(layer, 0, 1)), float(LAYERS[2]), clamp(layer.sub(1), 0, 1));
    m.positionNode = vec3(positionLocal.x, ground.add(lift), positionLocal.z);
    const wpos = varying(modelWorldMatrix.mul(vec4(positionLocal.x, ground.add(lift), positionLocal.z, 1)).xyz, 'vDriftWorld');
    const vl = varying(layer, 'vDriftLayer');
    const tex = texture(getNoise2D());
    const dir = DRIFTU.dir;
    const along = wpos.x.mul(dir.x).add(wpos.z.mul(dir.y));
    const across = wpos.z.mul(dir.x).sub(wpos.x.mul(dir.y));
    const scroll = mix(mix(DRIFTU.scroll.x, DRIFTU.scroll.y, clamp(vl, 0, 1)), DRIFTU.scroll.z, clamp(vl.sub(1), 0, 1));
    // streaks: long along the wind, thin across it, two scales
    const a = tex.sample(vec2(along.mul(1 / 46).sub(scroll), across.mul(1 / 7).add(vl.mul(0.31)))).g;
    const b = tex.sample(vec2(along.mul(1 / 17).sub(scroll.mul(1.7)), across.mul(1 / 2.6).add(vl.mul(0.17)))).b;
    const sheet = smoothstep(0.46, 0.78, a.mul(0.7).add(b.mul(0.45)));
    const toCam = vec3(U.camPos).sub(wpos);
    const dist = length(toCam);
    const d = toCam.div(max(dist, 1e-3)).negate();
    const edge = smoothstep(CELLS * CELL * 0.5, CELLS * CELL * 0.3, max(abs(toCam.x), abs(toCam.z)));
    const near = smoothstep(0.8, 3.5, dist);
    const layerOpacity = mix(mix(float(0.42), float(0.3), clamp(vl, 0, 1)), float(0.16), clamp(vl.sub(1), 0, 1));
    const sunPh = hgPhase(dot(d, U.sunDir), float(0.5)).mul(4 * Math.PI).mul(0.4).add(0.4);
    const amb = vec3(U.skyAmbient).add(vec3(U.groundAmbient)).mul(0.5 / Math.PI);
    const lit = amb.add(vec3(U.sunColor).mul(sunPh).mul(1 / Math.PI)).add(vec3(U.moonColor).mul(0.6 / Math.PI)).mul(0.92);
    const fa = fogAmount(dist, d);
    const col = mix(lit, fogColor(d), fa);
    const alpha = sheet.mul(layerOpacity).mul(edge).mul(near).mul(DRIFTU.amount);
    m.fragmentNode = vec4(col, clamp(alpha, 0, 1));
    return m;
  }

  /** Follow the camera: re-drape when it has moved a cell. */
  follow(x: number, z: number): void {
    const sx = Math.round(x / CELL) * CELL;
    const sz = Math.round(z / CELL) * CELL;
    if (sx === this.cx && sz === this.cz) return;
    this.cx = sx;
    this.cz = sz;
    this.mesh.position.set(sx, 0, sz);
    this.mesh.updateMatrixWorld();
    const n = CELLS + 1;
    const verts = n * n;
    const w = this.world;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = w ? w.heightAt(sx + (i - CELLS / 2) * CELL, sz + (j - CELLS / 2) * CELL) : 0;
        for (let l = 0; l < LAYERS.length; l++) this.heights[l * verts + j * n + i] = h;
      }
    }
    this.heightAttr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
