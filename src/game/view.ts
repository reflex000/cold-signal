// CONTRACT. What presentation (renderer, actors, audio, UI) may read each frame. It is built by
// the client session from snapshots (interpolated) and the predicted local player. Presentation
// never touches SimState, the Sim, or the host.
// Owner: MAIN.
import type { Bus } from '../core/bus';
import type { World } from '../world/types';
import type { Action, Entity, EntityKind, Env, IceCell, ItemId, NetId, Objective, PlayerEnt, SimEvent, Stats, ToolId } from '../sim/types';

/** An entity as presentation sees it: the latest state with position and yaw interpolated. */
export type ViewEnt<E extends Entity = Entity> = E & {
  /** Seconds since this entity first appeared on this client. */
  age: number;
};

export interface Camera {
  x: number; y: number; z: number; // eye position, world
  yaw: number; pitch: number; roll: number;
  fov: number; // vertical, degrees
  /** 0 first person .. 1 third person (dev / photo / downed). */
  third: number;
}

export interface Focus {
  id: NetId;
  kind: EntityKind;
  verb: string; // 'Take', 'Open', 'Feed fire', 'Light', 'Revive', 'Crank', 'Install', 'Chop', 'Lift'
  name: string; // 'Dry sticks', 'Campfire', ...
  hold: number | null; // 0..1 progress when the action is a hold, else null
  key: string; // 'E'
  note?: string; // 'needs matches'
}

export interface Hud {
  focus: Focus | null;
  crosshair: 'none' | 'dot' | 'ring' | 'aim';
  heading: number; // radians, 0 = north, clockwise
  marks: { id: string; kind: 'objective' | 'fire' | 'player' | 'ping' | 'poi'; bearing: number; dist: number; label?: string }[];
  place: string; // name of the POI the player is in, or ''
  hint: string; // tutorial line or ''
  objective: string; // one line: what to do now
  frost: number; // 0..1 screen frost
  wetLens: number; // 0..1 melt drops on the goggles
  hurt: number; // 0..1 recent damage flash
  lowHealth: number; // 0..1
  whiteout: number; // 0..1
}

export type Mode = 'boot' | 'title' | 'play' | 'pause' | 'inventory' | 'dead' | 'won' | 'photo';

export interface Settings {
  quality: 'mobile' | 'low' | 'medium' | 'high' | 'ultra' | 'auto';
  renderScale: number; // 0.5..1
  fov: number; // 60..100
  sensitivity: number; // 0.2..3
  invertY: boolean;
  master: number; music: number; sfx: number; // 0..1
  shake: boolean;
  grain: boolean;
  hints: boolean;
  bots: number; // 0..3 companions driven by the bot brain
  showFps: boolean;
}

/** Bus messages between game and presentation. Sim events are forwarded as `sim`. */
export interface GameBus {
  sim: SimEvent; // every simulation event, as it is presented (already delayed to render time)
  mode: { from: Mode; to: Mode };
  settings: { key: keyof Settings; value: unknown };
  loading: { progress: number; label: string };
  toast: { kind: 'info' | 'pickup' | 'warn' | 'part' | 'objective' | 'lore'; text: string; item?: ItemId };
  place: { id: string; name: string };
  save: {};
}

export interface View {
  readonly world: World;
  readonly bus: Bus<GameBus>;
  readonly settings: Settings;
  /** True on phones and tablets: touch controls are shown, there is no pointer lock, UI is larger. */
  readonly touch: boolean;
  mode: Mode;
  /** Render clock, seconds; advances with real time while playing. */
  time: number;
  /** Interpolated environment. */
  env: Env;
  objective: Objective;
  stats: Stats;
  /** The local player (predicted), or null before joining. Also present in `ents`. */
  me: ViewEnt<PlayerEnt> | null;
  myId: NetId;
  ents: Map<NetId, ViewEnt>;
  /** Cached per-kind lists, rebuilt when the entity set changes. */
  list<K extends EntityKind>(kind: K): ViewEnt<Extract<Entity, { kind: K }>>[];
  ice: Map<number, IceCell>;
  camera: Camera;
  hud: Hud;
  /** Local-only feel values for the first-person rig: 0..1 walk cycle phase, sway, recoil. */
  rig: { bob: number; stride: number; speed: number; recoil: number; sway: number; breath: number; shiver: number; landing: number };
  /**
   * Seconds left of the opening of a new game (black, wind, the lines about Flight 417, the fade into
   * the fuselage; ui/opening.ts draws it), 0 or absent otherwise. The player has no controls and the
   * world does not move on while it runs. (Optional member added by RELEASE.)
   */
  opening?: number;
}

/**
 * Touch controls. The UI draws the on-screen stick and buttons (DOM) and reports them here; the
 * game's input layer merges this with keyboard, mouse and gamepad into the same InputCmd.
 */
export interface TouchSink {
  /** Left stick, each axis -1..1 (x right, z forward). Call with (0, 0) on release. */
  move(x: number, z: number): void;
  /** Look drag in CSS pixels since the last call. */
  look(dx: number, dy: number): void;
  /** A BTN bit (see sim/types BTN) pressed or released. */
  button(btn: number, down: boolean): void;
}

/** What UI may call. Everything goes through the same action path as remote play. */
export interface GameActions {
  newGame(seed?: number): void;
  continueGame(): void;
  hasSave(): boolean;
  resume(): void;
  pause(): void;
  quitToTitle(): void;
  openInventory(): void;
  closeInventory(): void;
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  act(a: Action): void;
  equip(tool: ToolId): void;
  respawn(): void;
  photo(on: boolean): void;
}
