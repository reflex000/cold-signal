// Continuous distance-dependent LOD (CDLOD, Strugar 2009) over the terrain domain.
//
// A quadtree of square nodes: 3 x 3 roots of ROOT metres, each level halving. A node at LOD l is
// N x N quads of cell0 * 2^l metres. Selection walks down while the node intersects the sphere of
// LOD l-1; a child that does not is drawn as a quarter of its parent at the parent's LOD (an
// (N/2)^2 mesh). In the vertex shader every vertex morphs toward the parent grid over the outer
// 20 % of its LOD range, so neighbouring LODs meet exactly (k > 2.36) and nothing pops. Skirts on
// every node hide any sub-pixel T-junction gaps.
//
// Distance is 2D distance with the camera's height above the ground folded in
// (sqrt(d2^2 + hc^2)): the morph must depend on the vertex's world xz only, so neighbours agree.
//
// Output per frame: four instance lists (full / quarter nodes x near / far). Near nodes (within
// the shadow distance) cast sun shadows and are culled against the view frustum widened by
// NEAR_MARGIN (so casters just outside the view still shadow it); far nodes do not cast.
// Owner: TERRAIN.
import * as THREE from 'three/webgpu';
import { DOMAIN_HALF, RING_OUTER, ROOT, type LodConfig, lodRange } from './config';
import type { MinMax } from './data';

const NEAR_MARGIN = 30;

/** A grid of (m+1)^2 vertices with skirts. position = (i, flag, j): flag -1 marks a skirt vertex. */
export function makeGridGeometry(m: number, maxNodes: number): { geometry: THREE.InstancedBufferGeometry; attr: THREE.InstancedBufferAttribute } {
  const g = new THREE.InstancedBufferGeometry();
  const vCount = (m + 1) * (m + 1) + 4 * (m + 1);
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  let v = 0;
  const put = (i: number, f: number, j: number): number => {
    pos[v * 3] = i;
    pos[v * 3 + 1] = f;
    pos[v * 3 + 2] = j;
    nrm[v * 3 + 1] = 1;
    return v++;
  };
  for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) put(i, 0, j);
  const grid = (i: number, j: number) => j * (m + 1) + i;
  // skirts: one row of hanging vertices per side
  const sN: number[] = [], sS: number[] = [], sW: number[] = [], sE: number[] = [];
  for (let i = 0; i <= m; i++) sN.push(put(i, -1, 0));
  for (let i = 0; i <= m; i++) sS.push(put(i, -1, m));
  for (let j = 0; j <= m; j++) sW.push(put(0, -1, j));
  for (let j = 0; j <= m; j++) sE.push(put(m, -1, j));
  const idx: number[] = [];
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const a = grid(i, j), b = grid(i + 1, j), c = grid(i, j + 1), d = grid(i + 1, j + 1);
    // Counter-clockwise seen from above (+Y). One diagonal direction everywhere: a fully morphed
    // node collapses onto quads (2i+1, 2j+1), and only a uniform diagonal gives the collapsed grid
    // the same triangulation as the real coarse node that replaces it.
    idx.push(a, c, b, b, c, d);
  }
  for (let i = 0; i < m; i++) {
    // north edge (j = 0) faces -Z, south (j = m) +Z, west (i = 0) -X, east (i = m) +X
    let e0 = grid(i, 0), e1 = grid(i + 1, 0), s0 = sN[i], s1 = sN[i + 1];
    idx.push(e0, e1, s0, e1, s1, s0);
    e0 = grid(i, m); e1 = grid(i + 1, m); s0 = sS[i]; s1 = sS[i + 1];
    idx.push(e0, s0, e1, e1, s0, s1);
  }
  for (let j = 0; j < m; j++) {
    let e0 = grid(0, j), e1 = grid(0, j + 1), s0 = sW[j], s1 = sW[j + 1];
    idx.push(e0, s0, e1, e1, s0, s1);
    e0 = grid(m, j); e1 = grid(m, j + 1); s0 = sE[j]; s1 = sE[j + 1];
    idx.push(e0, e1, s0, e1, s1, s0);
  }
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(maxNodes * 4), 4);
  attr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aNode', attr);
  g.instanceCount = 0;
  // the shader places every vertex; a huge sphere keeps three from ever culling the mesh
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e7, -1e7, -1e7), new THREE.Vector3(1e7, 1e7, 1e7));
  return { geometry: g, attr };
}

/** One instance list: x0, z0, size, lod per node. */
export class NodeList {
  readonly data: Float32Array;
  count = 0;
  constructor(readonly max: number) {
    this.data = new Float32Array(max * 4);
  }
  push(x: number, z: number, size: number, lod: number): void {
    if (this.count >= this.max) return;
    const k = this.count * 4;
    this.data[k] = x;
    this.data[k + 1] = z;
    this.data[k + 2] = size;
    this.data[k + 3] = lod;
    this.count++;
  }
}

export interface Selection {
  fullNear: NodeList;
  quarterNear: NodeList;
  fullFar: NodeList;
  quarterFar: NodeList;
}

export class LodSelector {
  readonly sel: Selection;
  private ranges: number[] = [];
  private s0: number;
  private camX = 0;
  private camZ = 0;
  private hc = 0;
  private shadowDist = 0;
  private frustum = new THREE.Frustum();
  private nearFrustum = new THREE.Frustum();
  private box = new THREE.Box3();
  private mm = { min: 0, max: 0 };
  private m4 = new THREE.Matrix4();
  /** Nodes visited last frame (for stats). */
  visited = 0;

  constructor(readonly cfg: LodConfig, private minmax: MinMax) {
    this.s0 = cfg.n * cfg.cell0;
    for (let l = 0; l < cfg.levels; l++) this.ranges.push(lodRange(cfg, l));
    this.sel = {
      fullNear: new NodeList(cfg.maxNodes),
      quarterNear: new NodeList(cfg.maxNodes),
      fullFar: new NodeList(cfg.maxNodes),
      quarterFar: new NodeList(cfg.maxNodes),
    };
  }

  /**
   * Select the nodes for this camera. hc = camera height above the ground (m, >= 0).
   * shadowDist: nodes nearer than this go to the near (shadow-casting) lists.
   */
  select(camera: THREE.PerspectiveCamera, hc: number, shadowDist: number): Selection {
    const s = this.sel;
    s.fullNear.count = s.quarterNear.count = s.fullFar.count = s.quarterFar.count = 0;
    this.visited = 0;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    this.camX = e[12];
    this.camZ = e[14];
    this.hc = Math.max(0, hc);
    this.shadowDist = shadowDist;
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4, camera.coordinateSystem, (camera as any).reversedDepth === true);
    // The far plane is the camera's; the ring is sized to stay inside it, so drop it from the test.
    this.frustum.planes[4].constant += 1e6;
    this.nearFrustum.copy(this.frustum);
    for (const i of [0, 1, 2, 3, 5]) this.nearFrustum.planes[i].constant += NEAR_MARGIN;

    const top = this.cfg.levels - 1;
    const rootN = Math.round((2 * DOMAIN_HALF) / ROOT);
    for (let j = 0; j < rootN; j++) {
      for (let i = 0; i < rootN; i++) {
        const x0 = -DOMAIN_HALF + i * ROOT, z0 = -DOMAIN_HALF + j * ROOT;
        if (!this.visit(x0, z0, top)) this.emit(x0, z0, ROOT, top, false);
      }
    }
    return s;
  }

  private dist2(x0: number, z0: number, size: number): number {
    const dx = Math.max(x0 - this.camX, 0, this.camX - (x0 + size));
    const dz = Math.max(z0 - this.camZ, 0, this.camZ - (z0 + size));
    return Math.sqrt(dx * dx + dz * dz);
  }

  private visible(x0: number, z0: number, size: number, near: boolean): boolean {
    this.minmax.query(x0, z0, size, this.mm);
    this.box.min.set(x0, this.mm.min - 2, z0);
    this.box.max.set(x0 + size, this.mm.max + 2, z0 + size);
    return (near ? this.nearFrustum : this.frustum).intersectsBox(this.box);
  }

  private outsideRing(x0: number, z0: number, size: number): boolean {
    const dx = Math.max(x0, 0, -(x0 + size));
    const dz = Math.max(z0, 0, -(z0 + size));
    return dx * dx + dz * dz > RING_OUTER * RING_OUTER;
  }

  /** Returns false when the node is beyond its LOD range (the caller draws the area coarser). */
  private visit(x0: number, z0: number, l: number): boolean {
    this.visited++;
    const size = this.s0 * Math.pow(2, l);
    if (this.outsideRing(x0, z0, size)) return true;
    const d2 = this.dist2(x0, z0, size);
    const deff = Math.sqrt(d2 * d2 + this.hc * this.hc);
    if (deff > this.ranges[l]) return false;
    const near = d2 <= this.shadowDist;
    if (!this.visible(x0, z0, size, near)) return true;
    if (l === 0 || deff > this.ranges[l - 1]) {
      this.push(x0, z0, size, l, false, near);
      return true;
    }
    // children, nearest first (roughly front to back)
    const h = size / 2;
    const cxRight = this.camX > x0 + h, czBack = this.camZ > z0 + h;
    for (let k = 0; k < 4; k++) {
      const ox = (k & 1) ^ (cxRight ? 1 : 0);
      const oz = ((k >> 1) & 1) ^ (czBack ? 1 : 0);
      const cx = x0 + ox * h, cz = z0 + oz * h;
      if (!this.visit(cx, cz, l - 1)) this.emit(cx, cz, h, l, true);
    }
    return true;
  }

  /** Draw an area that its own visit() did not test for visibility (beyond the finer range). */
  private emit(x0: number, z0: number, size: number, l: number, quarter: boolean): void {
    if (this.outsideRing(x0, z0, size)) return;
    const near = this.dist2(x0, z0, size) <= this.shadowDist;
    if (!this.visible(x0, z0, size, near)) return;
    this.push(x0, z0, size, l, quarter, near);
  }

  private push(x0: number, z0: number, size: number, l: number, quarter: boolean, near: boolean): void {
    const s = this.sel;
    const list = quarter ? (near ? s.quarterNear : s.quarterFar) : near ? s.fullNear : s.fullFar;
    list.push(x0, z0, size, l);
  }
}
