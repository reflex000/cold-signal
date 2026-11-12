// CONTRACT. The static world: everything that is a pure function of the seed. The simulation,
// the renderer, the audio and the UI all read the same World object, and a remote client
// builds an identical one from the seed alone. No imports from three or the DOM.
//
// Axes: metres, Y up, X east, Z south (north is -Z). The playable square is centred on the
// origin. Uphill is north: the crash site is in the south, the signal tower on the north ridge.
// Owner: WORLD (the interface is frozen by MAIN; extend it only by adding optional members).
import type { ItemId, PartId, Surface } from '../sim/types';

export const WORLD_SIZE = 1600; // metres across the playable square
export const WORLD_HALF = WORLD_SIZE / 2;

export type PoiId = 'wreck' | 'tail' | 'cabin' | 'lake' | 'hut' | 'cave' | 'camp' | 'tower';

export interface Poi {
  id: PoiId;
  name: string; // shown on the HUD when entering
  x: number;
  y: number; // ground height at the anchor
  z: number;
  yaw: number; // facing of the main structure
  radius: number; // metres; inside this the POI counts as "here"
}

export interface TreeInst {
  x: number; y: number; z: number;
  scale: number; // 1 = a 14 m pine
  yaw: number;
  variant: number; // 0..7 mesh variant
  kind: 'pine' | 'fir' | 'snag' | 'sapling';
  snow: number; // 0..1 snow load
}

export interface RockInst {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  yaw: number; tilt: number;
  variant: number;
}

/** A static model placed in the world: `model` is a name in src/models/registry. */
export interface PropInst {
  model: string;
  seed: number;
  x: number; y: number; z: number;
  yaw: number;
  scale: number;
  poi?: PoiId;
}

/** Static collision. Circles are vertical cylinders, boxes are oriented in the XZ plane. */
export type Collider =
  | { s: 'c'; x: number; z: number; r: number; y0: number; y1: number }
  | { s: 'b'; x: number; z: number; hx: number; hz: number; yaw: number; y0: number; y1: number };

/** A walkable platform above (or instead of) the terrain: cabin floor, tower deck, fuselage floor. */
export interface Floor {
  x: number; z: number; hx: number; hz: number; yaw: number;
  y: number; // surface height
  surface: Surface;
}

/** A volume that shelters from wind and snowfall. */
export interface ShelterVol {
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number; yaw: number;
  amount: number; // 0..1 at the core
  /** Indoors: no snowfall, muffled wind, room reverb. */
  indoor: boolean;
  poi?: PoiId;
}

export interface LakeInfo {
  x: number; z: number; // centre
  level: number; // ice surface height
  /** Grid of ice over the lake bounding square. Cell index i = cz * n + cx. */
  n: number;
  cell: number; // metres per cell
  minX: number;
  minZ: number;
  /** Ice thickness in metres per cell; 0 outside the lake. */
  thickness: Float32Array;
}

export interface SpawnItem { kind: 'pickup'; item: ItemId; n: number; x: number; y: number; z: number; yaw: number; lie: 'ground' | 'shelf' | 'snow' }
export interface SpawnCrate { kind: 'crate'; type: 'luggage' | 'locker' | 'crate' | 'medkit' | 'cupboard' | 'toolbox'; loot: { item: ItemId; n: number }[]; x: number; y: number; z: number; yaw: number }
export interface SpawnWood { kind: 'wood'; type: 'snag' | 'deadfall' | 'stump' | 'branchpile'; x: number; y: number; z: number; yaw: number; seed: number; scale: number }
export interface SpawnLog { kind: 'log'; x: number; y: number; z: number; yaw: number; len: number }
export interface SpawnFire { kind: 'fire'; type: 'campfire' | 'stove' | 'barrel'; x: number; y: number; z: number; shelter: number }
export interface SpawnDevice { kind: 'device'; type: 'panel' | 'generator' | 'door' | 'beacon' | 'bed' | 'note'; poi: PoiId; x: number; y: number; z: number; yaw: number; data: number }
export type SpawnDef = SpawnItem | SpawnCrate | SpawnWood | SpawnLog | SpawnFire | SpawnDevice;

export interface PackDef {
  x: number; z: number; // den / home range centre
  range: number; // metres
  count: number; // wolves for one player; the sim adds for more
  /** Sim time (s) before this pack becomes active. */
  wakeAt: number;
}

export interface World {
  readonly seed: number;
  readonly size: number; // WORLD_SIZE
  readonly half: number;

  // --- terrain ---------------------------------------------------------------------------
  /** Terrain height, bilinear on the heightmap. Valid for any x, z (clamped outside). */
  heightAt(x: number, z: number): number;
  /** Walkable height: terrain or a floor, whichever is the highest surface not above y + step. */
  groundAt(x: number, z: number, y: number): { y: number; surface: Surface };
  /** Unit normal of the terrain. */
  normalAt(x: number, z: number): { x: number; y: number; z: number };
  /** 0 flat .. 1 vertical. */
  slopeAt(x: number, z: number): number;
  /** Loose snow depth in metres (0 on rock, ice, floors and wind-scoured ridges; up to ~0.9 in drifts). */
  snowDepthAt(x: number, z: number): number;
  surfaceAt(x: number, z: number): Surface;
  /** Forest density 0..1. */
  forestAt(x: number, z: number): number;
  /** Raw grids for the renderer: n x n samples covering [-extent, extent] on both axes. */
  readonly heightmap: { data: Float32Array; n: number; extent: number; min: number; max: number };
  /** RGBA8, same footprint as the heightmap: R forest, G bare rock, B ice / lake, A trail (packed path). */
  readonly masks: { data: Uint8Array; n: number; extent: number };

  // --- things on it -----------------------------------------------------------------------
  readonly pois: Poi[];
  poi(id: PoiId): Poi;
  readonly lake: LakeInfo;
  /** Ice thickness in metres at a point, 0 if not over the lake. */
  iceAt(x: number, z: number): number;
  iceCell(x: number, z: number): number; // cell index or -1
  readonly trees: TreeInst[];
  /** Indices into `trees` whose trunk is within the box. */
  treesIn(minX: number, minZ: number, maxX: number, maxZ: number, out?: number[]): number[];
  readonly rocks: RockInst[];
  readonly props: PropInst[];
  readonly floors: Floor[];
  readonly shelters: ShelterVol[];
  /** Static colliders near a point (trees, rocks, walls). */
  collidersNear(x: number, z: number, r: number, out?: Collider[]): Collider[];
  /**
   * Protection from wind and falling snow at a point, 0..1. Combines shelter volumes, the lee
   * of terrain and rocks upwind, and forest canopy. wind is the direction the air moves toward.
   */
  shelterAt(x: number, y: number, z: number, windX: number, windZ: number): { amount: number; indoor: boolean };
  /** True if the straight segment is not blocked by terrain or walls (wolves, sight, shots). */
  lineClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean;
  /** First hit of a ray against terrain and static colliders, or null. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): { x: number; y: number; z: number; dist: number; what: 'ground' | 'tree' | 'rock' | 'wall' } | null;

  // --- what the simulation starts with ---------------------------------------------------
  readonly spawn: {
    players: { x: number; y: number; z: number; yaw: number }[]; // 4 slots near the wreck
    defs: SpawnDef[];
    packs: PackDef[];
    parts: Record<PartId, { poi: PoiId; x: number; y: number; z: number }>;
  };
  /** A walkable route crash site -> ... -> tower for bots and for trail markers. */
  readonly route: { x: number; z: number; poi?: PoiId }[];
  /** Simple walkable-direction helper for AI: is this spot passable on foot? */
  walkable(x: number, z: number): boolean;
}
