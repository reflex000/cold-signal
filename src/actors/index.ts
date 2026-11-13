// THE FIGURES SYSTEM ('actors'): every player except the local one in first person (the local one
// too when view.camera.third > 0) and every wolf, from view.list('player') / list('wolf').
//
// Drawing: one shared RGBA32F bone texture (gpu.ts), one row per figure on screen. Each (kind,
// colour variant, level of detail) is one THREE.Mesh at the origin drawing `count` instances whose
// rows are consecutive from mesh.userData.csRow, so all the wolves of one coat and LOD are a single
// draw, and a player is one draw plus the tool in hand. Rows are handed out every frame in mesh order.
// Animation: PlayerAnimator / WolfAnimator per entity (procedural, from entity fields only).
// Lights: a flashlight in hand asks FX's light pool (gfx/fx) for a spot; without FX the system keeps
// one capped SpotLight of its own. Eye shine: every wolf's eyes are lit by the lights of the frame
// (FX's active requests, or the flashlight) seen from the camera, written per row (gpu.ts eyes).
// GAME's stand-in markers stop drawing players and wolves once this system runs.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem, Quality } from '../gfx/api';
import type { CsEngine } from '../gfx/engine';
import type { View, ViewEnt } from '../game/view';
import type { Entity, EntityKind, LogEnt, NetId, PlayerEnt, SimEvent, ToolId, WolfEnt } from '../sim/types';
import type { World } from '../world/types';
import { BoneTexture, ROW_TEXELS, createEyeMaterial, createFigureMaterial, createSilhouetteMaterial } from './gpu';
import { ITEM_HAND, ITEM_POINTS, TOOLS, getItem, itemGeometry } from './items';
import { PlayerAnimator, type AnimCtx } from './player_anim';
import { PLAYER_SKEL, buildPlayerMesh, slotGeometry, type PlayerMesh } from './player_model';
import { Pose, writeRow } from './rig';
import { WolfAnimator } from './wolf_anim';
import { WOLF_COATS, buildWolfMesh, coatGeometry, eyeGeometry, type WolfMesh } from './wolf_model';

type Tool = Exclude<ToolId, 'hands'>;

/** Rows in the bone texture: figures drawn at once (players + wolves). */
const MAX_ROWS = 40;
/** LOD switch distances (m) and the distance past which nothing is drawn. */
const P_LOD = [16, 55];
const W_LOD = [18, 60];
const CULL = 320;

/** Minimal shape of FX's light pool (src/gfx/fx/lights.ts), looked up at run time. */
interface LightReq {
  on: boolean;
  readonly kind: 'point' | 'spot';
  readonly position: THREE.Vector3;
  readonly direction: THREE.Vector3;
  readonly color: THREE.Color;
  intensity: number;
  range: number;
  angle: number;
  penumbra: number;
  priority: number;
  level: number;
  release(): void;
}
interface LightPoolLike {
  acquire(kind: 'point' | 'spot', priority?: number): LightReq;
  readonly active: readonly LightReq[];
}

interface PlayerFig {
  id: NetId;
  anim: PlayerAnimator;
  lod: number;
  row: number;
  seen: number;
  drawn: boolean;
  slot: number;
  items: Partial<Record<Tool, THREE.Mesh>>;
  light: LightReq | null;
  e: ViewEnt<PlayerEnt> | null;
}

interface WolfFig {
  id: NetId;
  anim: WolfAnimator;
  lod: number;
  row: number;
  seen: number;
  coat: number;
  shine: number;
  e: ViewEnt<WolfEnt> | null;
}

interface Bucket {
  mesh: THREE.Mesh;
  list: (PlayerFig | WolfFig)[];
  kind: 'player' | 'wolf';
}

export interface ActorsSystem extends GfxSystem {
  /** World position of a named bone of a drawn figure ('head', 'handR', 'muzzle' for the held tool...). */
  point(id: NetId, name: string, out: THREE.Vector3): THREE.Vector3 | null;
  /** Figures drawn last frame. */
  readonly stats: { players: number; wolves: number; rows: number; draws: number };
  /** Dev: draw every figure at this level of detail (null: by distance). */
  forceLod: number | null;
  /** Dev: draw the bind pose (checks the meshes without the animation). */
  bindPose: boolean;
  /**
   * The local player's flashlight beam in first person (from where the right hand would be, along the
   * view). On by default; a first-person hands rig that lights its own beam turns it off.
   */
  localBeam: boolean;
  /** Dev: draw every figure flat black (silhouette checks). */
  setSilhouette(on: boolean): void;
}

/** Overwrite a pose with the bind pose, standing at (x, y, z) facing yaw. */
function bindPoseAt(pose: Pose, x: number, y: number, z: number, yaw: number): void {
  const q = _bq.setFromAxisAngle(_bv.set(0, 1, 0), yaw);
  const def = pose.def;
  for (let b = 0; b < def.n; b++) {
    pose.q[b].copy(q);
    def.joint(b, pose.p[b]).multiplyScalar(pose.scale).applyQuaternion(q).add(_bv2.set(x, y, z));
  }
}
const _bq = new THREE.Quaternion();
const _bv = new THREE.Vector3();
const _bv2 = new THREE.Vector3();

const EMPTY: never[] = [];
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _cam = new THREE.Vector3();

/**
 * Stop GAME's stand-in markers from drawing the kinds this system draws: its update gets a view whose
 * list() is empty for 'player' and 'wolf' (the markers file is GAME's; this only wraps the call).
 */
function muteMarkers(engine: CsEngine): boolean {
  const m = engine.get('markers') as (GfxSystem & { __csMuted?: boolean }) | undefined;
  if (!m) return false;
  if (m.__csMuted) return true;
  const orig = m.update.bind(m);
  let seen: View | null = null;
  let proxy: View | null = null;
  const frame: Frame = { dt: 0, time: 0, view: null as unknown as View };
  m.update = (f: Frame): void => {
    if (f.view !== seen) {
      seen = f.view;
      const real = f.view;
      proxy = Object.create(real, {
        list: { value: (k: EntityKind) => (k === 'player' || k === 'wolf' ? EMPTY : real.list(k)) },
      }) as View;
    }
    frame.dt = f.dt;
    frame.time = f.time;
    frame.view = proxy as View;
    orig(frame);
  };
  m.__csMuted = true;
  return true;
}

export function createActorsSystem(engine: CsEngine, world: World | null): ActorsSystem {
  const scene = engine.scene;
  const group = new THREE.Group();
  group.name = 'actors';
  scene.add(group);
  const bones = new BoneTexture(MAX_ROWS);
  const figMat = createFigureMaterial(bones);
  const eyeMat = createEyeMaterial(bones);
  let quality: Quality = engine.quality;

  const mkMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, shadow = true): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.frustumCulled = false;
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.count = 0;
    m.visible = false;
    m.userData.csRow = 0;
    group.add(m);
    return m;
  };

  // ---- player meshes: 4 slots x 3 LODs, sharing geometry except colour ----
  const pBase: PlayerMesh[] = [buildPlayerMesh(0), buildPlayerMesh(1), buildPlayerMesh(2)];
  const buckets: Bucket[] = [];
  const pBucket: Bucket[][] = [];
  for (let slot = 0; slot < 4; slot++) {
    pBucket.push([]);
    for (let lod = 0; lod < 3; lod++) {
      const b: Bucket = { mesh: mkMesh(slotGeometry(pBase[lod], slot), figMat, `actors-player-${slot}-${lod}`, lod < 2), list: [], kind: 'player' };
      pBucket[slot].push(b);
      buckets.push(b);
    }
  }
  // ---- wolf meshes: coats x 3 LODs ----
  const wBase: WolfMesh[] = [buildWolfMesh(0), buildWolfMesh(1), buildWolfMesh(2)];
  const wBucket: Bucket[][] = [];
  for (let coat = 0; coat < WOLF_COATS.length; coat++) {
    wBucket.push([]);
    for (let lod = 0; lod < 3; lod++) {
      const b: Bucket = { mesh: mkMesh(coatGeometry(wBase[lod], coat), figMat, `actors-wolf-${coat}-${lod}`, lod < 2), list: [], kind: 'wolf' };
      wBucket[coat].push(b);
      buckets.push(b);
    }
  }
  const eyes = mkMesh(eyeGeometry(), eyeMat, 'actors-wolf-eyes', false);
  // ---- tools in hand (one mesh per figure and tool, created on demand) ----
  const itemGeo: Partial<Record<Tool, THREE.BufferGeometry>> = {};
  const itemGeometryOf = (t: Tool): THREE.BufferGeometry => (itemGeo[t] ??= itemGeometry(getItem(t, 0)));

  let silMat: THREE.Material | null = null;
  let silOn = false;
  const players = new Map<NetId, PlayerFig>();
  const wolves = new Map<NetId, WolfFig>();
  let frameNo = 0;
  let muted = false;
  let pool: LightPoolLike | null = null;
  let poolChecked = false;
  // fallback flashlight (no FX): one spotlight, fixed, off unless used
  let ownSpot: THREE.SpotLight | null = null;
  const stats = { players: 0, wolves: 0, rows: 0, draws: 0 };
  const ctx: AnimCtx = { dt: 0, time: 0, world, log: null, revivee: null, far: false };

  const findPool = (): void => {
    if (poolChecked) return;
    const fx = engine.get('fx') as (GfxSystem & { lights?: LightPoolLike }) | undefined;
    if (fx && fx.lights && typeof fx.lights.acquire === 'function') pool = fx.lights;
    poolChecked = true;
  };
  // FX may be added after this system: look once now, and again on the first frame
  findPool();
  poolChecked = false;
  if (!engine.get('fx')) {
    ownSpot = new THREE.SpotLight(0xfff0d8, 0, 38, 0.42, 0.55, 2);
    ownSpot.name = 'actors-flashlight';
    ownSpot.castShadow = false;
    group.add(ownSpot, ownSpot.target);
  }

  function pickLod(cur: number, d: number, th: number[]): number {
    if (api.forceLod !== null) return Math.max(0, Math.min(2, api.forceLod | 0));
    // hysteresis: 8 % either side of each threshold
    let lod = 0;
    for (let i = 0; i < th.length; i++) if (d > th[i] * (cur > i ? 0.92 : 1.08)) lod++;
    return Math.min(2, lod);
  }

  function dropPlayer(fig: PlayerFig): void {
    for (const t of TOOLS) {
      const m = fig.items[t];
      if (m) {
        group.remove(m);
        delete fig.items[t];
      }
    }
    if (fig.light) {
      fig.light.release();
      fig.light = null;
    }
  }

  function revivee(view: View, id: NetId): PlayerEnt | null {
    for (const p of view.list('player')) if (p.life === 'downed' && p.reviver === id) return p;
    return null;
  }

  // presentation events: yelps, growls, barks and bites move the wolves' bodies
  let busOff: (() => void) | null = null;
  let busView: View | null = null;
  function listen(view: View): void {
    if (busView === view) return;
    busOff?.();
    busView = view;
    busOff = view.bus?.on?.('sim', (ev: SimEvent) => {
      switch (ev.t) {
        case 'yelp':
          wolves.get(ev.id)?.anim.event('yelp', ev.x, ev.z);
          break;
        case 'growl':
          wolves.get(ev.id)?.anim.event('growl');
          break;
        case 'bark':
          wolves.get(ev.id)?.anim.event('bark');
          break;
        case 'bite':
          wolves.get(ev.id)?.anim.event('bite');
          break;
      }
    }) ?? null;
  }

  function update(f: Frame): void {
    const view = f.view;
    if (!view) return;
    frameNo++;
    listen(view);
    if (!muted) muted = muteMarkers(engine);
    findPool();
    const dt = Math.min(0.1, Math.max(0, f.dt));
    ctx.dt = dt;
    ctx.time = f.time;
    _cam.copy(engine.camera.position);
    for (const b of buckets) b.list.length = 0;
    const third = view.camera.third > 0.01;

    // ---------------- players ----------------
    let np = 0;
    for (const e of view.list('player') as ViewEnt<PlayerEnt>[]) {
      if (e.id === view.myId && !third) continue;
      let fig = players.get(e.id);
      if (!fig) {
        fig = { id: e.id, anim: new PlayerAnimator(e.id), lod: 0, row: -1, seen: 0, drawn: false, slot: e.slot, items: {}, light: null, e };
        players.set(e.id, fig);
      }
      fig.seen = frameNo;
      fig.e = e;
      fig.drawn = false;
      const d = Math.hypot(e.x - _cam.x, e.y - _cam.y, e.z - _cam.z);
      if (d > CULL) continue;
      fig.lod = pickLod(fig.lod, d, P_LOD);
      ctx.far = fig.lod >= 2;
      ctx.log = e.carry ? ((view.ents.get(e.carry) as Entity | undefined)?.kind === 'log' ? (view.ents.get(e.carry) as LogEnt) : null) : null;
      ctx.revivee = e.act === 'revive' ? revivee(view, e.id) : null;
      fig.anim.update(e, ctx);
      if (np >= MAX_ROWS - 1) continue;
      pBucket[((e.slot % 4) + 4) % 4][fig.lod].list.push(fig);
      fig.drawn = true;
      np++;
    }
    for (const [id, fig] of players) {
      if (fig.seen !== frameNo) {
        dropPlayer(fig);
        players.delete(id);
      }
    }

    // ---------------- wolves ----------------
    let nw = 0;
    for (const e of view.list('wolf') as ViewEnt<WolfEnt>[]) {
      let fig = wolves.get(e.id);
      if (!fig) {
        fig = { id: e.id, anim: new WolfAnimator(e.variant, e.alpha), lod: 0, row: -1, seen: 0, coat: coatOf(e), shine: 0, e };
        wolves.set(e.id, fig);
      }
      fig.seen = frameNo;
      fig.e = e;
      const d = Math.hypot(e.x - _cam.x, e.y - _cam.y, e.z - _cam.z);
      if (d > CULL) continue;
      fig.lod = pickLod(fig.lod, d, W_LOD);
      ctx.far = fig.lod >= 2;
      const target = e.target ? (view.ents.get(e.target) as Entity | undefined) ?? null : null;
      fig.anim.update(e, ctx, target, _cam);
      if (np + nw >= MAX_ROWS) continue;
      wBucket[fig.coat][fig.lod].list.push(fig);
      nw++;
    }
    for (const [id, fig] of wolves) if (fig.seen !== frameNo) wolves.delete(id);

    // ---------------- rows ----------------
    let row = 0;
    let draws = 0;
    let wolfRow0 = -1, wolfRows = 0;
    for (const b of buckets) {
      const n = b.list.length;
      b.mesh.visible = n > 0;
      b.mesh.count = n;
      b.mesh.userData.csRow = row;
      if (n > 0) draws++;
      if (b.kind === 'wolf' && n > 0 && wolfRow0 < 0) wolfRow0 = row;
      for (const fig of b.list) {
        fig.row = row;
        const pose = b.kind === 'player' ? (fig as PlayerFig).anim.pose : (fig as WolfFig).anim.pose;
        if (api.bindPose && fig.e) bindPoseAt(pose, fig.e.x, fig.e.y, fig.e.z, fig.e.yaw);
        writeRow(pose, bones.data, row, ROW_TEXELS);
        if (b.kind === 'wolf') wolfRows++;
        row++;
      }
    }
    // the wolves' eyes: every wolf row (wolf buckets are consecutive)
    eyes.visible = wolfRows > 0;
    eyes.count = wolfRows;
    eyes.userData.csRow = Math.max(0, wolfRow0);
    if (wolfRows > 0) draws++;

    // ---------------- tools in hand, flashlights ----------------
    for (const fig of players.values()) {
      const e = fig.e!;
      const held = e.held;
      for (const t of TOOLS) {
        const want = fig.drawn && held === t && fig.lod < 2;
        let m = fig.items[t];
        if (want && !m) {
          m = mkMesh(itemGeometryOf(t), silOn && silMat ? silMat : figMat, `actors-item-${t}`, true);
          if (silOn) m.userData.csMat = figMat;
          fig.items[t] = m;
        }
        if (m) {
          m.visible = want;
          m.count = want ? 1 : 0;
          m.userData.csRow = fig.row;
          if (want) draws++;
        }
      }
      flashlight(fig, e, view);
    }
    localFlashlight(view, dt);
    if (ownSpot && !ownUsed) ownSpot.intensity = 0;
    ownUsed = false;

    // ---------------- eye shine ----------------
    eyeShine(view);
    bones.commit();
    stats.players = np;
    stats.wolves = nw;
    stats.rows = row;
    stats.draws = draws;
  }

  let ownUsed = false;
  function flashlight(fig: PlayerFig, e: ViewEnt<PlayerEnt>, view: View): void {
    const on = fig.drawn && e.held === 'flashlight' && e.lightOn && e.life === 'alive';
    // the local player's own beam in first person is the first-person rig's business
    if (pool) {
      if (on && !fig.light) fig.light = pool.acquire('spot', e.id === view.myId ? 6 : 2);
      if (fig.light) {
        const L = fig.light;
        L.on = on;
        if (on) {
          lampPose(fig, L.position, L.direction);
          const charge = (e as PlayerEnt & { cellCharge?: number }).cellCharge ?? 1;
          const dim = charge < 0.25 ? 0.35 + 0.65 * (charge / 0.25) : 1;
          const focus = e.aim;
          L.color.setRGB(1, 0.93, 0.8);
          L.intensity = (55 + 30 * focus) * dim;
          L.range = 34 + 12 * focus;
          L.angle = 0.42 - 0.14 * focus;
          L.penumbra = 0.55;
        }
      }
      return;
    }
    if (ownSpot && on && !ownUsed) {
      // without FX: the nearest beam gets the one spotlight
      lampPose(fig, ownSpot.position, _v2);
      ownSpot.target.position.copy(ownSpot.position).add(_v2);
      ownSpot.target.updateMatrixWorld();
      ownSpot.intensity = 55 + 30 * e.aim;
      ownSpot.angle = 0.42 - 0.14 * e.aim;
      ownUsed = true;
    }
  }

  // the local player's beam in first person: from the right hand's place below the eye, along the
  // view with a little lag (a hand, not a camera mount)
  let localLight: LightReq | null = null;
  const localDir = new THREE.Vector3(0, 0, -1);
  const _ld = new THREE.Vector3();
  function localFlashlight(view: View, dt: number): void {
    const me = view.me;
    const cam = view.camera;
    const on = api.localBeam && !!me && me.held === 'flashlight' && me.lightOn && me.life === 'alive' && cam.third < 0.5;
    if (!on) {
      if (localLight) localLight.on = false;
      return;
    }
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    _ld.set(-sy * cp, sp, -cy * cp);
    localDir.lerp(_ld, 1 - Math.exp(-14 * dt)).normalize();
    // right of and below the eye, a little ahead
    const px = cam.x + cy * 0.2 + _ld.x * 0.25, py = cam.y - 0.26 + _ld.y * 0.25, pz = cam.z - sy * 0.2 + _ld.z * 0.25;
    const charge = me!.cellCharge ?? 1;
    const dim = charge < 0.25 ? 0.35 + 0.65 * (charge / 0.25) : 1;
    const focus = me!.aim;
    if (pool) {
      if (!localLight) localLight = pool.acquire('spot', 6);
      const L = localLight;
      L.on = true;
      L.position.set(px, py, pz);
      L.direction.copy(localDir);
      L.color.setRGB(1, 0.93, 0.8);
      L.intensity = (55 + 30 * focus) * dim;
      L.range = 34 + 12 * focus;
      L.angle = 0.42 - 0.14 * focus;
      L.penumbra = 0.55;
    } else if (ownSpot && !ownUsed) {
      ownSpot.position.set(px, py, pz);
      ownSpot.target.position.set(px + localDir.x, py + localDir.y, pz + localDir.z);
      ownSpot.target.updateMatrixWorld();
      ownSpot.intensity = (55 + 30 * focus) * dim;
      ownSpot.angle = 0.42 - 0.14 * focus;
      ownUsed = true;
    }
  }

  /** World position and beam direction of a figure's flashlight lens. */
  function lampPose(fig: PlayerFig, pos: THREE.Vector3, dir: THREE.Vector3): void {
    const g = fig.anim.grip;
    const lamp = ITEM_POINTS.flashlight.lamp;
    pos.set(lamp[0], lamp[1], lamp[2]).applyQuaternion(g.rot).add(g.pos);
    dir.set(0, 0, -1).applyQuaternion(g.rot).normalize();
    // just in front of the lens, so the cone does not light the torch itself
    pos.addScaledVector(dir, 0.02);
  }

  function eyeShine(view: View): void {
    if (wolves.size === 0) return;
    const lights = pool ? pool.active : null;
    for (const fig of wolves.values()) {
      if (fig.row < 0 || !fig.e) continue;
      const eye = fig.anim.eyePos(_v);
      const fwd = fig.anim.headDir(_v2);
      // the eyes must face the viewer
      const cx = _cam.x - eye.x, cy = _cam.y - eye.y, cz = _cam.z - eye.z;
      const cd = Math.hypot(cx, cy, cz) || 1;
      const facing = Math.max(0, (fwd.x * cx + fwd.y * cy + fwd.z * cz) / cd);
      let shine = 0;
      if (facing > 0.05) {
        const add = (lx: number, ly: number, lz: number, intensity: number, spot: { dx: number; dy: number; dz: number; cos: number } | null): void => {
          const dx = lx - eye.x, dy = ly - eye.y, dz = lz - eye.z;
          const d2 = Math.max(0.25, dx * dx + dy * dy + dz * dz);
          const d = Math.sqrt(d2);
          let k = intensity / d2;
          if (spot) {
            // inside the beam?
            const c = -(dx * spot.dx + dy * spot.dy + dz * spot.dz) / d;
            k *= Math.min(1, Math.max(0, (c - spot.cos) / (1 - spot.cos)) * 3);
          }
          // the tapetum sends light back toward its source: the viewer must be near the light's line
          const retro = (dx * cx + dy * cy + dz * cz) / (d * cd);
          const r = Math.min(1, Math.max(0, (retro - 0.965) / 0.03));
          shine += k * r * r;
        };
        if (lights) {
          for (const L of lights) {
            if (L.level <= 0) continue;
            add(L.position.x, L.position.y, L.position.z, L.level, L.kind === 'spot' ? { dx: L.direction.x, dy: L.direction.y, dz: L.direction.z, cos: Math.cos(L.angle) } : null);
          }
        } else if (ownSpot && ownSpot.intensity > 0) {
          _v2.subVectors(ownSpot.target.position, ownSpot.position).normalize();
          add(ownSpot.position.x, ownSpot.position.y, ownSpot.position.z, ownSpot.intensity, { dx: _v2.x, dy: _v2.y, dz: _v2.z, cos: Math.cos(ownSpot.angle) });
        }
      }
      // radiance of the tapetum: a strong retroreflector; capped so a beam in the face blooms, not explodes
      const target = Math.min(40, shine * 260 * facing * facing);
      fig.shine += (target - fig.shine) * Math.min(1, ctx.dt * 20 + 0.05);
      bones.setData(fig.row, fig.shine);
    }
    void view;
  }

  function point(id: NetId, name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const p = players.get(id);
    if (p) {
      if (name === 'muzzle' || name === 'lamp') {
        const t = p.anim.grip.tool;
        if (t === 'hands') return null;
        const pt = ITEM_POINTS[t][name];
        if (!pt) return null;
        return out.set(pt[0], pt[1], pt[2]).applyQuaternion(p.anim.grip.rot).add(p.anim.grip.pos);
      }
      const b = PLAYER_SKEL.index[name];
      return b === undefined ? null : out.copy(p.anim.pose.p[b]);
    }
    const w = wolves.get(id);
    if (w) return w.anim.point(name, out);
    return null;
  }

  const api: ActorsSystem = {
    name: 'actors',
    stats,
    point,
    update,
    forceLod: null,
    bindPose: false,
    localBeam: true,
    setSilhouette(on: boolean): void {
      silMat ??= createSilhouetteMaterial(bones);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (on) {
          m.userData.csMat ??= m.material;
          m.material = silMat!;
        } else if (m.userData.csMat) m.material = m.userData.csMat;
      });
      silOn = on;
    },
    setQuality(q: Quality): void {
      quality = q;
      void quality;
    },
    dispose(): void {
      busOff?.();
      busOff = null;
      localLight?.release();
      localLight = null;
      for (const fig of players.values()) dropPlayer(fig);
      players.clear();
      wolves.clear();
      scene.remove(group);
      if (ownSpot) ownSpot.dispose();
      const geos = new Set<THREE.BufferGeometry>();
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) geos.add((o as THREE.Mesh).geometry);
      });
      for (const b of buckets) geos.add(b.mesh.geometry);
      for (const g of Object.values(itemGeo)) if (g) geos.add(g);
      geos.forEach((g) => g.dispose());
      figMat.dispose();
      eyeMat.dispose();
      silMat?.dispose();
      bones.dispose();
    },
  };
  return api;
}

/** Coat of a wolf from its variant: mostly grey, some darker, a few pale or brown. */
function coatOf(e: WolfEnt): number {
  const v = ((e.variant % 10) + 10) % 10;
  if (e.alpha) return v < 5 ? 1 : 0;
  return v < 5 ? 0 : v < 7 ? 3 : v < 9 ? 1 : 2;
}

export { ITEM_HAND };
