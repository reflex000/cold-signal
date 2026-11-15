// The View (src/game/view.ts) as the game fills it every frame from the ClientSession: the
// session's entity table (stable ViewEnt objects), its per-kind lists, the predicted local player,
// the interpolated environment, the objective and the ice; the camera (filled by camera.ts); the
// rig (first-person feel values computed from the predicted player); the HUD (hudmodel.ts and
// focus.ts). Sim events drained from the session are forwarded on bus 'sim', and the ones a
// player should read become bus 'toast'.
// Owner: GAME.
import type { Bus } from '../core/bus';
import { damp, sat, smoothstep } from '../core/math';
import type { ClientSession } from '../net/client';
import { makeEnv, makeObjective, makeStats } from '../sim/entities';
import { SPRINT_SPEED } from '../sim/move';
import type { Entity, EntityKind, Env, IceCell, NetId, Objective, PlayerEnt, SimEvent, Stats } from '../sim/types';
import { ITEM, PART_NAME } from '../ui/text';
import type { World } from '../world/types';
import { makeHud } from './hudmodel';
import type { Camera, GameBus, Hud, Mode, Settings, View, ViewEnt } from './view';

const EMPTY_LIST: never[] = [];
const NO_ENTS = new Map<NetId, ViewEnt>();
const NO_ICE = new Map<number, IceCell>();
const NO_TREES: ReadonlySet<number> = new Set<number>();

export class ViewImpl implements View {
  readonly world: World;
  readonly bus: Bus<GameBus>;
  readonly settings: Settings;
  readonly touch: boolean;
  mode: Mode = 'boot';
  time = 0;
  env: Env = makeEnv();
  objective: Objective = makeObjective();
  stats: Stats = makeStats();
  me: ViewEnt<PlayerEnt> | null = null;
  myId: NetId = 0;
  ents: Map<NetId, ViewEnt> = NO_ENTS;
  ice: Map<number, IceCell> = NO_ICE;
  /** Trees stripped of their dead branches (the session's set). */
  gathered: ReadonlySet<number> = NO_TREES;
  readonly camera: Camera = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 75, third: 0 };
  readonly hud: Hud = makeHud();
  readonly rig = { bob: 0, stride: 0, speed: 0, recoil: 0, sway: 0, breath: 0, shiver: 0, landing: 0 };
  /** Seconds left of a new game's opening (game.ts counts it down; ui/opening.ts draws it). */
  opening = 0;
  /** The world has been drawn (game.ts: false while the shaders compile behind the title at boot). */
  drawn = true;

  private session: ClientSession | null = null;
  private phase = 0;
  private breathPhase = 0;

  constructor(world: World, bus: Bus<GameBus>, settings: Settings, touch: boolean) {
    this.world = world;
    this.bus = bus;
    this.settings = settings;
    this.touch = touch;
  }

  list<K extends EntityKind>(kind: K): ViewEnt<Extract<Entity, { kind: K }>>[] {
    return this.session ? this.session.list(kind) : (EMPTY_LIST as ViewEnt<Extract<Entity, { kind: K }>>[]);
  }

  /** Read from this session from now on (a new game, a loaded one). */
  attach(session: ClientSession | null): void {
    this.session = session;
    this.phase = 0;
    this.breathPhase = 0;
    const r = this.rig;
    r.bob = r.stride = r.speed = r.recoil = r.sway = r.shiver = r.landing = 0;
    this.hud.focus = null;
    this.pull();
  }

  private pull(): void {
    const s = this.session;
    if (!s) {
      this.me = null;
      this.myId = 0;
      this.ents = NO_ENTS;
      this.ice = NO_ICE;
      this.gathered = NO_TREES;
      return;
    }
    this.env = s.env;
    this.objective = s.objective;
    this.stats = s.stats;
    this.ents = s.ents;
    this.ice = s.ice;
    this.gathered = s.gathered;
    this.myId = s.myId;
    this.me = s.me;
  }

  /** Once per frame after session.advance(). */
  update(dt: number): void {
    this.pull();
    const me = this.me;
    const r = this.rig;
    r.recoil = damp(r.recoil, 0, 9, dt);
    r.landing = damp(r.landing, 0, 3.5, dt);
    if (!me) return;
    const sp = Math.hypot(me.vx, me.vz);
    r.speed = damp(r.speed, sp, 12, dt);
    const alive = me.life === 'alive';
    const moving = alive && me.onGround && !me.swim && sp > 0.2;
    r.stride = damp(r.stride, moving ? Math.min(1, sp / SPRINT_SPEED) : 0, 7, dt);
    if (moving) {
      // two footfalls per cycle; a stride at walking pace is about 0.75 m (sim/move strideLength)
      const strideLen = 0.55 + 0.11 * sp;
      this.phase = (this.phase + (sp * dt) / (2 * strideLen)) % 1;
    } else {
      // settle on the nearest footfall so standing still is a rest pose, not a frozen half step
      const target = this.phase < 0.25 ? 0 : this.phase < 0.75 ? 0.5 : 1;
      this.phase += (target - this.phase) * Math.min(1, dt * 4);
      if (this.phase >= 1) this.phase -= 1;
    }
    r.bob = this.phase;
    // cold and exhaustion
    const cold = smoothstep(35.5, 31, me.core);
    r.sway = damp(r.sway, sat(cold * 0.8 + (1 - me.stamina) * 0.35), 2, dt);
    r.shiver = damp(r.shiver, smoothstep(35.6, 33.5, me.core) * (1 - smoothstep(32, 30.5, me.core)), 2, dt);
    const rate = 0.22 + 0.55 * (1 - me.stamina) + (me.sprint ? 0.25 : 0);
    this.breathPhase = (this.breathPhase + rate * dt) % 1;
    r.breath = this.breathPhase;
  }

  /** React to one drained sim event (rig), then forward it to the bus. */
  onEvent(ev: SimEvent): void {
    const me = this.myId;
    const r = this.rig;
    switch (ev.t) {
      case 'land':
        if (ev.id === me) r.landing = Math.max(r.landing, Math.min(1, ev.speed / 9));
        break;
      case 'shot':
        if (ev.by === me) r.recoil = 1;
        break;
      case 'flareShot':
        if (ev.by === me) r.recoil = Math.max(r.recoil, 0.6);
        break;
      case 'swing':
        if (ev.by === me) r.recoil = Math.max(r.recoil, 0.25);
        break;
    }
    this.bus.emit('sim', ev);
    this.toast(ev);
  }

  private nameOf(id: NetId): string {
    const e = this.ents.get(id);
    return e && e.kind === 'player' ? (e as ViewEnt<PlayerEnt>).name : 'Someone';
  }

  /** Sim events a player should read, as bus toasts. */
  private toast(ev: SimEvent): void {
    const me = this.myId;
    const bus = this.bus;
    switch (ev.t) {
      case 'toast':
        if (ev.to === 0 || ev.to === me) bus.emit('toast', ev.item ? { kind: ev.kind, text: ev.text, item: ev.item } : { kind: ev.kind, text: ev.text });
        break;
      case 'pickup':
        if (ev.by === me && !ev.item.startsWith('part_')) {
          const t = ITEM[ev.item];
          bus.emit('toast', { kind: 'pickup', text: ev.n > 1 ? `${t ? t.name : ev.item} +${ev.n}` : t ? t.name : ev.item, item: ev.item });
        }
        break;
      case 'partFound':
        bus.emit('toast', { kind: 'part', text: ev.by === me ? `${PART_NAME[ev.part]} found.` : `${this.nameOf(ev.by)} found the ${PART_NAME[ev.part].toLowerCase()}.`, item: `part_${ev.part}` });
        break;
      case 'partInstalled':
        bus.emit('toast', { kind: 'part', text: `${PART_NAME[ev.part]} installed.`, item: `part_${ev.part}` });
        break;
      case 'checkpoint':
        bus.emit('toast', { kind: 'info', text: 'Progress saved.' });
        break;
      case 'downed':
        if (ev.id !== me) bus.emit('toast', { kind: 'warn', text: `${this.nameOf(ev.id)} is down.` });
        break;
      case 'revived':
        if (ev.id === me) bus.emit('toast', { kind: 'info', text: `${this.nameOf(ev.by)} got you up.` });
        break;
      case 'died':
        if (ev.id !== me) bus.emit('toast', { kind: 'warn', text: `${this.nameOf(ev.id)} did not make it.` });
        break;
      case 'transmit':
        bus.emit('toast', { kind: 'objective', text: 'The call is out. Hold on.' });
        break;
    }
  }
}
