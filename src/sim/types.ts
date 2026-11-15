// CONTRACT. The whole simulation state, every action a player can send and every event the
// simulation emits. Everything here is plain JSON: no classes, no Maps, no typed arrays, no
// references between objects (use NetId). This file has no imports from three or the DOM.
//
// Owner: MAIN. Other modules read it. If a system needs a new field, action or event, add it
// here in the matching section and keep it JSON-safe.

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

/** Network id. Unique for the life of a session, never reused. 0 means "none". */
export type NetId = number;

// ------------------------------------------------------------------------------------------
// Items
// ------------------------------------------------------------------------------------------
export type ToolId = 'hands' | 'axe' | 'flashlight' | 'flaregun' | 'rifle' | 'radio';
export type PartId = 'battery' | 'handset' | 'coil' | 'tube' | 'fuse';
export type ItemId =
  | 'axe' | 'flashlight' | 'flaregun' | 'rifle' | 'radio' // tools (count 0 or 1)
  | 'stick' | 'log' | 'tinder' | 'matches' // fire making; 'log' is a split log that fits a pack
  | 'flare' | 'ammo' | 'cell' // flare cartridges, rifle rounds, flashlight cells
  | 'bandage' | 'ration' | 'thermos' // healing, food, hot drink
  | 'part_battery' | 'part_handset' | 'part_coil' | 'part_tube' | 'part_fuse';

export type Inventory = Partial<Record<ItemId, number>>;

// ------------------------------------------------------------------------------------------
// Input: one command per simulation tick per player. Movement is predicted on the client with
// the same pure function the host runs (src/sim/move.ts), so it must depend only on the
// command, the player and the static world.
// ------------------------------------------------------------------------------------------
export const BTN = {
  SPRINT: 1,
  CROUCH: 2,
  JUMP: 4,
  PRIMARY: 8, // swing axe, fire rifle / flare gun, crank radio
  SECONDARY: 16, // aim rifle, raise flashlight / focus beam
  USE: 32, // hold-to-use on `focus` (pick up, feed fire, revive, crank generator, install part)
} as const;

export interface InputCmd {
  seq: number; // increases by one per command
  mx: number; // strafe  -1..1 (right is +)
  mz: number; // forward -1..1 (forward is +)
  yaw: number; // radians, 0 looks north (-Z), positive turns left (counter-clockwise from above)
  pitch: number; // radians, positive looks up
  b: number; // BTN bits held this tick
  focus: NetId; // entity under the crosshair chosen by the client, validated by the host
}

/** Discrete requests. The host validates every one; a refused action emits nothing or a toast. */
export type Action =
  | { t: 'equip'; tool: ToolId }
  | { t: 'reload' }
  | { t: 'toggleLight' }
  | { t: 'consume'; item: 'bandage' | 'ration' | 'thermos' }
  | { t: 'drop'; item: ItemId; n: number }
  | { t: 'give'; to: NetId; item: ItemId; n: number }
  | { t: 'buildFire' } // lay a campfire at the spot in front of the player (needs sticks)
  | { t: 'ignite'; fire: NetId } // needs matches (+ tinder helps); wind can blow it out
  | { t: 'feed'; fire: NetId; item: 'stick' | 'log' | 'tinder' }
  | { t: 'carry'; log: NetId } // take one end of a heavy log (two carriers move at full speed)
  | { t: 'release' } // put the heavy log down
  /**
   * Start snapping the dead lower branches off a conifer (`tree` is an index into world.trees: trees are
   * static world instances, not entities). The host checks reach, sight, the tree and pack room, then
   * times a hold of USE (PlayerAct 'use'); each tree gives its dead wood once (SimState.gathered).
   * (Optional member added for the branch gathering.)
   */
  | { t: 'gather'; tree: number }
  | { t: 'ping'; x: number; y: number; z: number } // co-op marker
  | { t: 'respawn' } // after death, back to the last checkpoint (solo) or as a spectator-revive
  | { t: 'debug'; cmd: string; args?: number[] }; // dev tools only, ignored unless sim.debug

// ------------------------------------------------------------------------------------------
// Entities
// ------------------------------------------------------------------------------------------
export interface EntBase {
  id: NetId;
  kind: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Bumped by the sim whenever a slow-changing entity changes; drives delta snapshots. */
  rev: number;
}

export type PlayerLife = 'alive' | 'downed' | 'dead' | 'rescued';
export type PlayerAct = 'none' | 'swing' | 'shoot' | 'reload' | 'crank' | 'ignite' | 'use' | 'revive' | 'eat' | 'climbOut';
export type Surface = 'snow' | 'deep' | 'rock' | 'ice' | 'wood' | 'metal' | 'water';

export interface PlayerEnt extends EntBase {
  kind: 'player';
  name: string;
  slot: number; // 0..3, picks the parka colour
  bot: boolean;
  // --- movement (predicted on the owning client)
  vx: number; vy: number; vz: number;
  pitch: number;
  onGround: boolean;
  crouch: boolean;
  sprint: boolean;
  surface: Surface;
  swim: boolean; // in the water after going through the ice
  seq: number; // last InputCmd.seq applied by the host
  // --- vitals
  life: PlayerLife;
  health: number; // 0..100
  core: number; // core body temperature, deg C. 37 healthy, 35 cold, 33 freezing, 30 collapse
  wet: number; // 0..1 wet clothes
  stamina: number; // 0..1
  hunger: number; // 0..1, 1 = starving (slows warming); rations reset it
  // --- what the body feels right now (derived each tick, for HUD, frost and audio)
  feels: number; // effective temperature, deg C
  shelter: number; // 0..1 protection from wind and snow
  fireHeat: number; // 0..1 warmth received from fires
  huddle: number; // 0..1 warmth bonus from other players close by
  trend: number; // core change, deg C per minute (negative = cooling)
  // --- downed / revive
  bleed: number; // seconds left while downed
  revive: number; // 0..1 progress of being revived
  reviver: NetId;
  // --- equipment
  inv: Inventory;
  held: ToolId;
  act: PlayerAct;
  actT: number; // seconds since act started
  loaded: number; // rounds in the rifle (0..5)
  flareLoaded: number; // 0..1
  lightOn: boolean;
  cellCharge: number; // 0..1 flashlight cell
  radioCharge: number; // 0..1 crank charge
  radioSig: number; // 0..1 strength of the nearest part / tower signal in the facing direction
  radioDist: number; // metres to that source, -1 if none
  aim: number; // 0..1 rifle raised
  /**
   * Flashlight output right now, 0..1: 0 when off or put away, 1 on a good cell, dimming below a
   * quarter charge (the wolves read it; so may the light cone). (Optional member added by HUNT.)
   */
  beam?: number;
  carry: NetId; // heavy log being carried, or 0
  /** True while a second player holds the other end of `carry`: walking pace instead of a drag (read by move.ts). */
  carryPair?: boolean;
  // --- co-op
  isolation: number; // 0..1 how alone the player is (wolves read this)
  kills: number;
}

export type WolfMood =
  | 'rest' | 'roam' | 'stalk' | 'circle' | 'feint' | 'charge' | 'bite' | 'drag' | 'flee' | 'cower' | 'howl' | 'feed' | 'dead';

export interface WolfEnt extends EntBase {
  kind: 'wolf';
  pack: number;
  alpha: boolean;
  mood: WolfMood;
  moodT: number; // seconds in this mood
  target: NetId;
  vx: number; vz: number;
  speed: number; // current ground speed, m/s (drives gait)
  health: number;
  fear: number; // 0..1
  hunger: number; // 0..1 boldness driver
  variant: number; // coat seed
}

export type FireType = 'campfire' | 'stove' | 'barrel';
export interface FireEnt extends EntBase {
  kind: 'fire';
  type: FireType;
  lit: boolean;
  fuel: number; // seconds of burn left at the current rate
  heat: number; // 0..1 current output (ramps up after lighting, sags when starved or snowed on)
  size: number; // 0..1 how much wood is stacked (visual)
  shelter: number; // 0..1 protection of the fire itself from wind
  embers: number; // seconds of glowing embers left after it dies (easy to relight)
  by: NetId; // builder
}

export interface PickupEnt extends EntBase {
  kind: 'pickup';
  item: ItemId;
  n: number;
  /** Visual hint: how it lies in the world ('ground', 'shelf', 'snow' half buried). */
  lie: 'ground' | 'shelf' | 'snow';
}

export interface CrateEnt extends EntBase {
  kind: 'crate';
  type: 'luggage' | 'locker' | 'crate' | 'medkit' | 'cupboard' | 'toolbox';
  loot: { item: ItemId; n: number }[];
  open: boolean;
}

/** Dead standing tree or deadfall that the axe turns into sticks and logs. */
export interface WoodEnt extends EntBase {
  kind: 'wood';
  type: 'snag' | 'deadfall' | 'stump' | 'branchpile';
  hp: number; // chops left
  seed: number;
  scale: number;
}

/** A heavy log: too big for a pack. One player drags it slowly, two carry it at walking pace. */
export interface LogEnt extends EntBase {
  kind: 'log';
  a: NetId; // carrier at the front end, or 0
  b: NetId; // carrier at the back end, or 0
  len: number;
  burn: number; // seconds of fuel it adds when fed to a fire
}

export interface FlareEnt extends EntBase {
  kind: 'flare';
  vx: number; vy: number; vz: number;
  life: number; // seconds of burn left
  landed: boolean;
  by: NetId;
}

/** Fixed world machines and doors. */
export interface DeviceEnt extends EntBase {
  kind: 'device';
  type: 'panel' | 'generator' | 'door' | 'beacon' | 'bed' | 'note';
  poi: string;
  on: boolean;
  progress: number; // 0..1 (generator charge, door open amount, ...)
  data: number; // type-specific (note index, ...)
}

export interface HeliEnt extends EntBase {
  kind: 'heli';
  phase: 'inbound' | 'search' | 'hover' | 'winch' | 'away';
  vx: number; vy: number; vz: number;
  t: number;
}

export type Entity = PlayerEnt | WolfEnt | FireEnt | PickupEnt | CrateEnt | WoodEnt | LogEnt | FlareEnt | DeviceEnt | HeliEnt;
export type EntityKind = Entity['kind'];
/** Kinds that move every tick and are sent in every snapshot. The rest are sent when `rev` changes. */
export const DYNAMIC_KINDS: readonly EntityKind[] = ['player', 'wolf', 'flare', 'log', 'heli', 'fire'];

// ------------------------------------------------------------------------------------------
// Environment: one mountain, one weather. Deterministic from (seed, time) plus the story beats.
// ------------------------------------------------------------------------------------------
export interface Env {
  t: number; // seconds of simulated time since the crash
  clock: number; // hour of day 0..24
  day: number; // 0, 1, 2 ...
  storm: number; // 0 clear .. 1 whiteout
  windX: number; // wind velocity, m/s (direction the air moves toward)
  windZ: number;
  gust: number; // 0..1 momentary gust on top of the mean wind
  snowfall: number; // 0..1
  visibility: number; // metres
  airTemp: number; // deg C at the crash site altitude; drops 0.65 per 100 m of height
  cloud: number; // 0..1 cover
  aurora: number; // 0..1
  /** Fresh snow laid down so far, metres. Footprints and trails fill in as this grows. */
  snowAccum: number;
}

// ------------------------------------------------------------------------------------------
// Objective
// ------------------------------------------------------------------------------------------
export type Stage = 'crash' | 'search' | 'tower' | 'power' | 'holdout' | 'rescue' | 'won' | 'lost';
export interface Objective {
  stage: Stage;
  parts: Record<PartId, 'lost' | 'held' | 'installed'>;
  generator: number; // 0..1 charge
  transmit: number; // 0..1 progress of the distress call
  eta: number; // seconds until the helicopter arrives, -1 before the call is out
  signalled: boolean; // a flare has marked the pickup point
}

// ------------------------------------------------------------------------------------------
// Lake ice. Sparse: only cells that have been stressed appear.
// ------------------------------------------------------------------------------------------
export interface IceCell {
  i: number; // cell index in world.lake grid
  stress: number; // 0..1; at 1 it breaks
  hole: boolean;
  /**
   * Metres of new ice over a cell that broke (present only on such cells). While `hole` is true it is the film
   * forming on the open water; once it is thick enough to stand on, `hole` goes false and the cell is thin new
   * ice of this thickness. Host-side detail: snapshots carry i / stress / hole. (Optional member added by OBJECTIVE.)
   */
  skin?: number;
}

export interface Stats {
  distance: number;
  firesLit: number;
  wolvesKilled: number;
  revives: number;
  downs: number;
  coldest: number;
  shots: number;
}

export interface SimState {
  version: number;
  seed: number;
  tick: number;
  nextId: NetId;
  rng: number; // state of the simulation's random stream (see core/rng rngStep)
  env: Env;
  objective: Objective;
  ents: Entity[];
  ice: IceCell[];
  /** Small story flags and timers owned by individual systems; keys are 'system.name'. */
  vars: Record<string, number>;
  stats: Stats;
  /**
   * Indices into world.trees whose dead lower branches have been snapped off (Action 'gather'), in the
   * order it happened; absent until the first. Clients read it from the welcome and then follow the
   * 'gathered' events. (Optional member added for the branch gathering.)
   */
  gathered?: number[];
}

// ------------------------------------------------------------------------------------------
// Events: things that happened this tick. Presentation (sound, particles, UI) is driven by
// these and by the snapshots; events never carry state that is not also in the state.
// ------------------------------------------------------------------------------------------
export type HurtCause = 'wolf' | 'cold' | 'fall' | 'water' | 'fire';
export type ToastKind = 'info' | 'pickup' | 'warn' | 'part' | 'objective' | 'lore';

export type SimEvent =
  | { t: 'step'; id: NetId; x: number; y: number; z: number; surface: Surface; run: boolean; left: boolean }
  | { t: 'jump'; id: NetId } | { t: 'land'; id: NetId; speed: number }
  | { t: 'pickup'; by: NetId; item: ItemId; n: number }
  | { t: 'open'; by: NetId; id: NetId }
  | { t: 'toast'; to: NetId; kind: ToastKind; text: string; item?: ItemId } // to = 0 for everyone
  | { t: 'equip'; id: NetId; tool: ToolId }
  | { t: 'swing'; by: NetId; hit: 'none' | 'wood' | 'wolf' | 'ground'; x: number; y: number; z: number }
  | { t: 'chopped'; by: NetId; id: NetId; x: number; y: number; z: number }
  /** The dead branches of world.trees[tree] snapped off (it joins SimState.gathered). (Optional member, branch gathering.) */
  | { t: 'gathered'; by: NetId; tree: number }
  | { t: 'shot'; by: NetId; x: number; y: number; z: number; dx: number; dy: number; dz: number; hx: number; hy: number; hz: number; hit: 'none' | 'ground' | 'wolf' | 'wood' }
  | { t: 'dry'; by: NetId } | { t: 'reload'; by: NetId }
  | { t: 'flareShot'; by: NetId; id: NetId } | { t: 'flareLand'; id: NetId; x: number; y: number; z: number } | { t: 'flareOut'; id: NetId }
  | { t: 'fireBuilt'; id: NetId; by: NetId } | { t: 'fireLit'; id: NetId; by: NetId } | { t: 'igniteFail'; id: NetId; by: NetId; why: 'wind' | 'wet' | 'luck' }
  | { t: 'fireFed'; id: NetId; by: NetId; item: ItemId } | { t: 'fireOut'; id: NetId; why: 'fuel' | 'wind' | 'snow' }
  | { t: 'howl'; id: NetId; x: number; y: number; z: number; pack: number }
  | { t: 'growl'; id: NetId; x: number; y: number; z: number } | { t: 'bark'; id: NetId; x: number; y: number; z: number }
  | { t: 'bite'; id: NetId; target: NetId } | { t: 'yelp'; id: NetId; x: number; y: number; z: number } | { t: 'wolfDie'; id: NetId; x: number; y: number; z: number }
  | { t: 'hurt'; id: NetId; amount: number; cause: HurtCause }
  | { t: 'downed'; id: NetId } | { t: 'revived'; id: NetId; by: NetId } | { t: 'died'; id: NetId }
  | { t: 'iceCreak'; x: number; z: number; stress: number } | { t: 'iceBreak'; x: number; z: number } | { t: 'splash'; id: NetId; x: number; z: number }
  | { t: 'logLift'; id: NetId; by: NetId } | { t: 'logDrop'; id: NetId }
  | { t: 'partFound'; by: NetId; part: PartId } | { t: 'partInstalled'; by: NetId; part: PartId }
  | { t: 'stage'; stage: Stage }
  | { t: 'generator'; on: boolean } | { t: 'transmit' } | { t: 'heli'; phase: HeliEnt['phase'] }
  | { t: 'door'; id: NetId; open: boolean }
  | { t: 'checkpoint' }
  | { t: 'ping'; by: NetId; x: number; y: number; z: number }
  | { t: 'gust'; strength: number } | { t: 'thunderSnow' }
  | { t: 'spawn'; id: NetId } | { t: 'despawn'; id: NetId };

export type EventType = SimEvent['t'];
