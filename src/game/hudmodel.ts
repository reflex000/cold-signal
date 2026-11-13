// The HUD view-model: everything in view.hud that is not the focus. Heading and bearings are
// radians, 0 = north (-Z), clockwise (ui/model.ts bearingTo). Marks point at the current
// objective, lit fires, teammates and nearby places. Entering a place emits bus 'place' once. The
// tutorial line (hud.hint) comes from hints.ts.
// Owner: GAME (hints: RELEASE).
import type { Bus } from '../core/bus';
import { sat, smoothstep, TAU } from '../core/math';
import type { PartId, PlayerEnt, SimEvent } from '../sim/types';
import { PART_NAME } from '../ui/text';
import { DeviceWatch, Tutor } from './hints';
import type { Poi, World } from '../world/types';
import type { GameBus, Hud, View, ViewEnt } from './view';

const FIRE_MARK_RANGE = 220; // metres
const POI_MARK_RANGE = 420;
/** A place is announced again only after this long away from it, seconds. */
const PLACE_REPEAT = 90;

export function makeHud(): Hud {
  return {
    focus: null, crosshair: 'none', heading: 0, marks: [], place: '', hint: '', objective: '',
    frost: 0, wetLens: 0, hurt: 0, lowHealth: 0, whiteout: 0,
  };
}

const bearing = (fx: number, fz: number, tx: number, tz: number) => Math.atan2(tx - fx, -(tz - fz));

export class HudModel {
  /** The place the player is in, '' outside every place. */
  placeId = '';
  private placeLeft = new Map<string, number>();
  private time = 0;
  private tutor: Tutor | null = null;
  private watch: DeviceWatch | null = null;
  private marks: Hud['marks'] = [];
  private markPool: Hud['marks'][number][] = [];
  private lastWet = 0;

  constructor(private readonly world: World, private readonly bus: Bus<GameBus>) {}

  /** A fresh game: places and hints start over. */
  reset(): void {
    this.placeId = '';
    this.placeLeft.clear();
    this.tutor = null; // a new one on the next frame
  }

  onEvent(ev: SimEvent, view: View): void {
    const hud = view.hud;
    if (ev.t === 'hurt' && ev.id === view.myId) hud.hurt = Math.min(1, hud.hurt + 0.25 + ev.amount / 25);
    this.tutor?.onEvent(ev, view);
  }

  /**
   * Once per frame. `inGame` is false behind the title (nothing is announced there), `playing`
   * true while the player has the controls (hints count play time).
   */
  update(view: View, dt: number, inGame: boolean, playing: boolean, whiteoutOverride: number | null): void {
    this.time += dt;
    const hud = view.hud;
    const me = inGame ? view.me : null;
    // (made on the first frame: the device watch needs to know whether the touch controls are up)
    const tutor = (this.tutor ??= new Tutor(this.world, (this.watch ??= new DeviceWatch(view.touch))));
    const cam = view.camera;
    hud.heading = ((-cam.yaw % TAU) + TAU) % TAU;
    hud.whiteout = whiteoutOverride ?? smoothstep(70, 9, view.env.visibility);
    hud.hurt = Math.max(0, hud.hurt - dt * 1.4);
    if (!me) {
      hud.marks = this.marks;
      this.marks.length = 0;
      hud.place = '';
      hud.objective = '';
      hud.hint = '';
      hud.frost = 0;
      hud.lowHealth = 0;
      hud.crosshair = 'none';
      tutor.update(view, null, dt, false);
      return;
    }

    // --- body
    hud.frost = smoothstep(35.2, 31.2, me.core);
    hud.lowHealth = me.life === 'alive' ? sat((40 - me.health) / 30) : 0;
    // melt drops: warming up by a fire (or indoors) with snow on the goggles
    const warm = sat(me.fireHeat * 1.3);
    const wetTarget = warm * sat(0.25 + me.wet + this.lastWet);
    this.lastWet = Math.max(0, this.lastWet - dt * 0.02) + view.env.snowfall * dt * 0.01;
    hud.wetLens += (wetTarget - hud.wetLens) * Math.min(1, dt * (wetTarget > hud.wetLens ? 0.6 : 0.15));

    // --- crosshair
    const third = cam.third > 0.5;
    // (raised rifle: the scope's own reticle aims; the HUD's cross inside it read as a second one. POLISH)
    hud.crosshair = third || me.life !== 'alive' ? 'none' : me.held === 'rifle' && me.aim > 0.5 ? 'none' : hud.focus ? 'ring' : 'dot';

    // --- where am I
    // (not under the opening's black: the place card comes up as the fuselage does)
    const poi = (view.opening ?? 0) > 0 ? null : this.placeAt(me.x, me.z);
    const id = poi ? poi.id : '';
    if (id !== this.placeId && (view.opening ?? 0) <= 0) {
      if (this.placeId) this.placeLeft.set(this.placeId, this.time);
      this.placeId = id;
      if (poi) {
        const left = this.placeLeft.get(id);
        if (left === undefined || this.time - left > PLACE_REPEAT) this.bus.emit('place', { id: poi.id, name: poi.name });
      }
    }
    hud.place = poi ? poi.name : '';

    // --- the objective and the marks
    hud.objective = this.objectiveLine(view);
    this.buildMarks(view, me);
    hud.marks = this.marks;

    // --- the tutorial line (counted even with hints off, so turning them on does not replay the start)
    const line = tutor.update(view, me, dt, playing);
    hud.hint = view.settings.hints ? line : '';
  }

  /** The smallest place whose radius holds the point. */
  placeAt(x: number, z: number): Poi | null {
    let best: Poi | null = null;
    for (const p of this.world.pois) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d <= p.radius && (!best || p.radius < best.radius)) best = p;
    }
    return best;
  }

  private partsLeft(view: View): PartId[] {
    const parts = view.objective.parts;
    return (Object.keys(PART_NAME) as PartId[]).filter((p) => parts[p] === 'lost');
  }

  objectiveLine(view: View): string {
    const o = view.objective;
    const left = this.partsLeft(view).length;
    switch (o.stage) {
      case 'crash':
        return 'Get warm at the barrel fire and search the wreck.';
      case 'search':
        return left === 5 ? 'Find the five radio parts. The radio hears them.' : `Find the radio parts. ${5 - left} of 5 found.`;
      case 'tower':
        return 'Carry the parts to the signal tower on the north ridge.';
      case 'power': {
        // (sim/systems/objective.ts: the call goes out while the generator holds charge)
        const fitted = (Object.keys(PART_NAME) as PartId[]).filter((p) => o.parts[p] === 'installed').length;
        if (fitted < 5) return `Fit the parts to the transmitter in the shed. ${fitted} of 5 in.`;
        if (o.transmit <= 0) return 'Crank the generator until it runs full.';
        return o.generator >= 0.3 ? 'Sending the call. Keep the generator turning.' : 'The set has dropped out. Crank the generator.';
      }
      case 'holdout':
        // (the HUD shows the time left under this line)
        return o.eta > 60 ? 'Hold the tower until the helicopter comes.' : 'Hold the tower. The helicopter is close: have a flare ready.';
      case 'rescue':
        return o.signalled ? 'Get onto the deck below the mast. The winch takes you up.' : 'Fire a flare onto the deck below the mast.';
      default:
        return '';
    }
  }

  /** Where the objective is: the place of the nearest missing part, or the tower. */
  private objectiveTarget(view: View, me: PlayerEnt): { x: number; z: number; label: string } | null {
    const o = view.objective;
    const w = this.world;
    if (o.stage === 'won' || o.stage === 'lost') return null;
    if (o.stage === 'crash') {
      const p = w.poi('wreck');
      return { x: p.x, z: p.z, label: p.name };
    }
    if (o.stage === 'search') {
      let best: { x: number; z: number; label: string } | null = null;
      let bd = Infinity;
      for (const part of this.partsLeft(view)) {
        const s = w.spawn.parts[part];
        if (!s) continue;
        const p = w.poi(s.poi);
        const d = Math.hypot(p.x - me.x, p.z - me.z);
        if (d < bd) {
          bd = d;
          best = { x: p.x, z: p.z, label: p.name };
        }
      }
      if (best) return best;
    }
    const t = w.poi('tower');
    return { x: t.x, z: t.z, label: t.name };
  }

  private mark(id: string, kind: Hud['marks'][number]['kind'], b: number, dist: number, label?: string): void {
    let m = this.markPool[this.marks.length];
    if (!m) this.markPool[this.marks.length] = m = { id, kind, bearing: b, dist };
    m.id = id;
    m.kind = kind;
    m.bearing = b;
    m.dist = dist;
    if (label === undefined) delete m.label;
    else m.label = label;
    this.marks.push(m);
  }

  private buildMarks(view: View, me: ViewEnt<PlayerEnt>): void {
    this.marks.length = 0;
    const x = me.x, z = me.z;
    const obj = this.objectiveTarget(view, me);
    let objPoi = '';
    if (obj) {
      const d = Math.hypot(obj.x - x, obj.z - z);
      if (d > 12) this.mark('objective', 'objective', bearing(x, z, obj.x, obj.z), d, obj.label);
      objPoi = obj.label;
    }
    for (const f of view.list('fire')) {
      if (!f.lit) continue;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < FIRE_MARK_RANGE && d > 3) this.mark('fire' + f.id, 'fire', bearing(x, z, f.x, f.z), d);
    }
    for (const p of view.list('player')) {
      if (p.id === view.myId) continue;
      this.mark('player' + p.id, 'player', bearing(x, z, p.x, p.z), Math.hypot(p.x - x, p.z - z), p.name);
    }
    for (const p of this.world.pois) {
      if (p.id === 'lake' || p.id === this.placeId || p.name === objPoi) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < POI_MARK_RANGE) this.mark('poi:' + p.id, 'poi', bearing(x, z, p.x, p.z), d, p.name);
    }
  }
}
