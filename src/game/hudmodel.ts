// The HUD view-model: everything in view.hud that is not the focus. Heading and bearings are
// radians, 0 = north (-Z), clockwise (ui/model.ts bearingTo). Marks point at the current
// objective, lit fires, teammates and nearby places. Entering a place emits bus 'place' once.
// Owner: GAME.
import type { Bus } from '../core/bus';
import { sat, smoothstep, TAU } from '../core/math';
import type { PartId, PlayerEnt, SimEvent } from '../sim/types';
import { PART_NAME } from '../ui/text';
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

interface Hint { id: string; text: string; until: number }

export class HudModel {
  /** The place the player is in, '' outside every place. */
  placeId = '';
  private placeLeft = new Map<string, number>();
  private time = 0;
  private hint: Hint | null = null;
  private shown = new Set<string>();
  private playTime = 0;
  private marks: Hud['marks'] = [];
  private markPool: Hud['marks'][number][] = [];
  private lastWet = 0;

  constructor(private readonly world: World, private readonly bus: Bus<GameBus>) {}

  /** A fresh game: places and hints start over. */
  reset(): void {
    this.placeId = '';
    this.placeLeft.clear();
    this.hint = null;
    this.shown.clear();
    this.playTime = 0;
  }

  onEvent(ev: SimEvent, view: View): void {
    const hud = view.hud;
    if (ev.t === 'hurt' && ev.id === view.myId) hud.hurt = Math.min(1, hud.hurt + 0.25 + ev.amount / 25);
  }

  /**
   * Once per frame. `inGame` is false behind the title (nothing is announced there), `playing`
   * true while the player has the controls (hints count play time).
   */
  update(view: View, dt: number, inGame: boolean, playing: boolean, whiteoutOverride: number | null): void {
    this.time += dt;
    const hud = view.hud;
    const me = inGame ? view.me : null;
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
      return;
    }
    if (playing) this.playTime += dt;

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
    hud.crosshair = third || me.life !== 'alive' ? 'none' : me.held === 'rifle' && me.aim > 0.5 ? 'aim' : hud.focus ? 'ring' : 'dot';

    // --- where am I
    const poi = this.placeAt(me.x, me.z);
    const id = poi ? poi.id : '';
    if (id !== this.placeId) {
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

    // --- hints
    hud.hint = view.settings.hints ? this.hintLine(view, me) : '';
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

  private hintLine(view: View, me: PlayerEnt): string {
    // in the water the way out cannot wait for another line to time out, and goes once out of it
    if (me.swim && !this.shown.has('swim')) this.hint = null;
    if (!me.swim && this.hint && this.hint.id === 'swim') this.hint = null;
    const h = this.hint;
    if (h && this.time < h.until) return h.text;
    this.hint = null;
    const touch = view.touch;
    const want = (id: string, text: string, secs = 7) => {
      if (this.shown.has(id)) return false;
      this.shown.add(id);
      this.hint = { id, text, until: this.time + secs };
      return true;
    };
    if (this.playTime < 1.5) return '';
    if (want('move', touch ? 'Left thumb to move. Drag on the right to look.' : 'WASD to move, the mouse to look. Esc pauses.', 8)) return this.hint!.text;
    // the lake (sim/systems/ice.ts): the way out of a hole, and the poles that mark the thick ice
    if (me.swim && want('swim', touch ? 'In the water. Swim to the edge of the hole and hold the hand to climb out.' : 'In the water. Swim to the edge of the hole and hold E to climb out.', 9)) return this.hint!.text;
    if (view.hud.focus && want('use', touch ? 'Press the hand to use what you look at.' : 'Press E to use what you look at. Hold it for long actions.')) return this.hint!.text;
    if (me.surface === 'ice' && !me.swim && want('ice', 'Lake ice. It is thick along the line of poles; off them it can be thin.', 8)) return this.hint!.text;
    if (me.core < 35.5 && want('cold', touch ? 'You are getting cold. Find shelter, or lay a fire from the pack with three sticks.' : 'You are getting cold. Find shelter, or press B to lay a fire with three sticks.', 9)) return this.hint!.text;
    if (view.env.visibility < 60 && want('whiteout', 'Whiteout. Stay on the marked trail or wait it out by a fire.', 8)) return this.hint!.text;
    if (me.stamina < 0.2 && want('stamina', 'Out of breath. Sprinting warms you a little and tires you a lot.')) return this.hint!.text;
    // the hunt and the tools (sim/systems/wolves.ts, tools.ts)
    if (this.wolvesNear(view, me) && want('wolves', 'Wolves. Keep to the firelight and together. A light in their eyes, a flare or a shot drives them off.', 9)) return this.hint!.text;
    if (me.held === 'radio' && want('radio', touch ? 'Hold the tool button to crank the radio. Turn until the tone is clearest.' : 'Hold the left button to crank the radio. Turn until the tone is clearest.', 9)) return this.hint!.text;
    if (me.held === 'flaregun' && me.flareLoaded < 1 && (me.inv.flare ?? 0) > 0 && want('flaregun', touch ? 'Tap reload to load a cartridge.' : 'Press R to load a cartridge.')) return this.hint!.text;
    if (me.held === 'rifle' && want('rifle', touch ? 'Hold aim to raise the rifle. Cold and tiredness make it sway.' : 'Hold the right button to raise the rifle. Cold and tiredness make it sway. R reloads.', 8)) return this.hint!.text;
    if (me.held === 'flashlight' && !me.lightOn && (view.env.clock > 18 || view.env.clock < 6.5) && want('light', touch ? 'Tap the light button to switch it on.' : 'F switches the flashlight on and off.')) return this.hint!.text;
    return '';
  }

  /** A wolf on the hunt within 70 m. */
  private wolvesNear(view: View, me: PlayerEnt): boolean {
    for (const w of view.list('wolf')) {
      if (w.mood !== 'stalk' && w.mood !== 'circle' && w.mood !== 'feint' && w.mood !== 'charge') continue;
      if (Math.hypot(w.x - me.x, w.z - me.z) < 70) return true;
    }
    return false;
  }
}
