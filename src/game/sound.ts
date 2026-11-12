// The game's side of sound: sim events become one-shots and footsteps, the view becomes the
// listener, the ambience (wind, shelter, indoors, forest, height, night, ice, cold) and the music
// mood, and lasting things (fires, the stove, flares, the generator, the radio, the helicopter)
// hold loops while they are near. AUDIO synthesises everything (src/audio, AudioApi).
// Owner: GAME.
import type { AudioApi, LoopHandle, LoopName, MusicMood, SfxName } from '../audio/api';
import { sat, smoothstep } from '../core/math';
import { nightAt } from '../sim/systems/env';
import type { NetId, SimEvent } from '../sim/types';
import type { World } from '../world/types';
import type { Mode, View } from './view';

const LOOP_RANGE = 45; // metres
const P: [number, number, number] = [0, 0, 0];

function pos(x: number, y: number, z: number): [number, number, number] {
  return [x, y, z];
}

interface Held { h: LoopHandle; seen: boolean }

export class SoundDirector {
  private loops = new Map<string, Held>();
  private shelter = 0;
  private indoor = 0;
  private cave = 0;
  private probe = 0;
  private forest = 0;
  private wreckY: number;
  private caveR: number;
  private cavePoi: { x: number; z: number };

  constructor(private readonly audio: AudioApi, private readonly world: World) {
    const w = world.poi('wreck');
    this.wreckY = w.y;
    const c = world.poi('cave');
    this.caveR = c.radius;
    this.cavePoi = { x: c.x, z: c.z };
  }

  private at(view: View, id: NetId): [number, number, number] | undefined {
    const e = view.ents.get(id);
    return e ? pos(e.x, e.y + 0.5, e.z) : undefined;
  }

  private sfx(name: SfxName, p?: [number, number, number], gain?: number, delay?: number): void {
    const o: { pos?: [number, number, number]; gain?: number; delay?: number } = {};
    if (p) o.pos = p;
    if (gain !== undefined) o.gain = gain;
    if (delay !== undefined) o.delay = delay;
    this.audio.sfx(name, o);
  }

  onEvent(ev: SimEvent, view: View): void {
    const me = view.myId;
    switch (ev.t) {
      case 'step': {
        const depth = this.world.snowDepthAt(ev.x, ev.z);
        if (ev.id === me) this.audio.footstep(ev.surface, ev.run ? 1 : 0.5, { depth });
        else this.audio.footstep(ev.surface, ev.run ? 1 : 0.5, { pos: pos(ev.x, ev.y, ev.z), depth });
        break;
      }
      case 'jump':
        if (ev.id === me) this.sfx('jump');
        break;
      case 'land':
        this.sfx('land', ev.id === me ? undefined : this.at(view, ev.id), Math.min(1, Math.max(0.3, ev.speed / 8)));
        break;
      case 'pickup':
        this.sfx(ev.item === 'stick' || ev.item === 'log' ? 'pickup_wood' : 'pickup', ev.by === me ? undefined : this.at(view, ev.by));
        break;
      case 'open':
        this.sfx('open_crate', this.at(view, ev.id));
        break;
      case 'equip':
        if (ev.id === me) this.sfx('equip');
        break;
      case 'swing':
        this.sfx('axe_swing', ev.by === me ? undefined : this.at(view, ev.by));
        if (ev.hit === 'wood') this.sfx('axe_wood', pos(ev.x, ev.y, ev.z), 1, 0.12);
        else if (ev.hit === 'wolf') this.sfx('axe_flesh', pos(ev.x, ev.y, ev.z), 1, 0.12);
        break;
      case 'chopped':
        this.sfx('wood_split', pos(ev.x, ev.y, ev.z));
        break;
      case 'shot':
        this.sfx('rifle_shot', ev.by === me ? undefined : pos(ev.x, ev.y, ev.z));
        if (ev.hit === 'ground') this.sfx('bullet_snow', pos(ev.hx, ev.hy, ev.hz), 1, 0.05);
        else if (ev.hit === 'wood') this.sfx('bullet_wood', pos(ev.hx, ev.hy, ev.hz), 1, 0.05);
        if (ev.by === me) this.sfx('rifle_bolt', undefined, 1, 0.55);
        break;
      case 'dry':
        if (ev.by === me) this.sfx('rifle_dry');
        break;
      case 'reload':
        this.sfx('rifle_reload', ev.by === me ? undefined : this.at(view, ev.by));
        break;
      case 'flareShot':
        this.sfx('flare_shot', ev.by === me ? undefined : this.at(view, ev.by));
        break;
      case 'flareLand':
        this.sfx('flare_land', pos(ev.x, ev.y, ev.z));
        break;
      case 'fireLit':
        this.sfx('match_strike', this.at(view, ev.id));
        this.sfx('fire_catch', this.at(view, ev.id), 1, 0.35);
        break;
      case 'igniteFail':
        this.sfx('match_strike', this.at(view, ev.id));
        this.sfx('match_fail', this.at(view, ev.id), 1, 0.3);
        break;
      case 'fireFed':
        this.sfx('fire_feed', this.at(view, ev.id));
        break;
      case 'fireOut':
        this.sfx('fire_die', this.at(view, ev.id));
        break;
      case 'howl':
        this.sfx('howl', pos(ev.x, ev.y + 0.7, ev.z));
        break;
      case 'growl':
        this.sfx('growl', pos(ev.x, ev.y + 0.6, ev.z));
        break;
      case 'bark':
        this.sfx('bark', pos(ev.x, ev.y + 0.6, ev.z));
        break;
      case 'yelp':
        this.sfx('yelp', pos(ev.x, ev.y + 0.6, ev.z));
        break;
      case 'wolfDie':
        this.sfx('wolf_die', pos(ev.x, ev.y + 0.5, ev.z));
        break;
      case 'bite':
        this.sfx('bite', ev.target === me ? undefined : this.at(view, ev.target));
        break;
      case 'hurt':
        if (ev.id === me && ev.cause !== 'cold') this.sfx('hurt', undefined, Math.min(1, 0.5 + ev.amount / 30));
        break;
      case 'downed':
        this.sfx('downed', ev.id === me ? undefined : this.at(view, ev.id));
        break;
      case 'revived':
        this.sfx('revived', ev.id === me ? undefined : this.at(view, ev.id));
        break;
      case 'died':
        if (ev.id === me) this.sfx('death');
        break;
      case 'iceCreak':
        this.sfx('ice_creak', pos(ev.x, this.world.lake.level, ev.z), 0.4 + 0.6 * sat(ev.stress));
        if (ev.stress > 0.7) this.sfx('ice_crack', pos(ev.x, this.world.lake.level, ev.z), 0.8, 0.1);
        break;
      case 'iceBreak':
        this.sfx('ice_break', pos(ev.x, this.world.lake.level, ev.z));
        break;
      case 'splash':
        this.sfx('splash', ev.id === me ? undefined : pos(ev.x, this.world.lake.level, ev.z));
        break;
      case 'logLift':
        this.sfx('log_lift', this.at(view, ev.id));
        break;
      case 'logDrop':
        this.sfx('log_drop', this.at(view, ev.id));
        break;
      case 'partFound':
        if (ev.by === me) this.sfx('part_found');
        break;
      case 'partInstalled':
        this.sfx('panel_install', this.at(view, ev.by));
        break;
      case 'stage':
        this.sfx('objective');
        break;
      case 'generator':
        this.sfx(ev.on ? 'generator_start' : 'generator_stop');
        break;
      case 'transmit':
        this.sfx('transmit');
        break;
      case 'door':
        this.sfx('door', this.at(view, ev.id));
        break;
      case 'gust':
        this.sfx('gust', undefined, 0.35 + 0.65 * sat(ev.strength));
        break;
      case 'thunderSnow':
        this.sfx('thunder');
        break;
      case 'toast':
        if (ev.to === me && ev.kind !== 'lore') this.sfx('toast');
        break;
    }
  }

  private hold(key: string, name: LoopName, p: [number, number, number], param: number, gain = 1): void {
    let l = this.loops.get(key);
    if (!l) {
      l = { h: this.audio.loop(name, { pos: p, param, gain }), seen: true };
      this.loops.set(key, l);
    } else {
      l.seen = true;
      l.h.set({ pos: p, param, gain });
    }
  }

  stopAll(): void {
    for (const l of this.loops.values()) l.h.stop(0.4);
    this.loops.clear();
  }

  update(dt: number, view: View, mode: Mode): void {
    const a = this.audio;
    const cam = view.camera;
    const cp = Math.cos(cam.pitch);
    a.setListener(cam.x, cam.y, cam.z, -Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp);
    a.setDuck(mode === 'pause' ? 0.7 : mode === 'inventory' ? 0.25 : 0);

    const env = view.env;
    const me = view.me;
    const w = this.world;
    const ws = Math.hypot(env.windX, env.windZ);
    this.probe -= dt;
    if (me && this.probe <= 0) {
      this.probe = 0.12;
      const s = w.shelterAt(me.x, me.y + 1.2, me.z, env.windX, env.windZ);
      this.shelter = s.amount;
      this.indoor = s.indoor ? 1 : 0;
      this.forest = w.forestAt(me.x, me.z);
      const dc = Math.hypot(me.x - this.cavePoi.x, me.z - this.cavePoi.z);
      this.cave = s.indoor && dc < this.caveR ? 1 : 0;
    }
    const x = me ? me.x : cam.x, y = me ? me.y : cam.y, z = me ? me.z : cam.z;
    const night = nightAt(env.clock);
    a.setAmbience({
      wind: sat(ws / 22),
      gust: env.gust,
      storm: env.storm,
      snowfall: env.snowfall,
      shelter: this.shelter,
      indoor: this.indoor,
      forest: this.forest,
      height: Math.max(0, y - this.wreckY),
      night,
      onIce: w.iceAt(x, z) > 0 ? 1 : 0,
      cold: me ? sat((36.6 - me.core) / 5.5) : 0,
      windDir: ws > 1e-3 ? [env.windX / ws, env.windZ / ws] : [1, 0],
      cave: this.cave,
    });
    a.setMusic(...this.mood(view, mode, night));

    // loops for lasting things near the listener
    for (const l of this.loops.values()) l.seen = false;
    if (mode !== 'title' && mode !== 'boot') {
      const r2 = LOOP_RANGE * LOOP_RANGE;
      for (const f of view.list('fire')) {
        if (!f.lit) continue;
        const d2 = (f.x - x) ** 2 + (f.z - z) ** 2;
        if (d2 > r2) continue;
        this.hold('fire' + f.id, f.type === 'stove' ? 'stove' : 'fire', pos(f.x, f.y + 0.4, f.z), f.heat);
      }
      for (const f of view.list('flare')) {
        if (f.life <= 0) continue;
        const d2 = (f.x - x) ** 2 + (f.z - z) ** 2;
        if (d2 < r2 * 4) this.hold('flare' + f.id, 'flare', pos(f.x, f.y, f.z), sat(f.life / 40));
      }
      for (const d of view.list('device')) {
        if (d.type === 'generator' && d.on) this.hold('gen' + d.id, 'generator', pos(d.x, d.y + 0.5, d.z), d.progress);
        if (d.type === 'beacon' && d.on) this.hold('beacon' + d.id, 'beacon', pos(d.x, d.y + 0.3, d.z), 1);
      }
      for (const hli of view.list('heli')) {
        const d = Math.hypot(hli.x - x, hli.y - y, hli.z - z);
        this.hold('heli' + hli.id, 'heli', pos(hli.x, hli.y, hli.z), sat(1 - d / 900));
      }
      if (me && me.held === 'radio' && me.radioCharge > 0.001 && me.life === 'alive') {
        P[0] = cam.x;
        P[1] = cam.y - 0.2;
        P[2] = cam.z;
        this.hold('radio', 'radio_static', [P[0], P[1], P[2]], sat(me.radioSig), 0.8);
      }
      let near = Infinity;
      let nw: { x: number; y: number; z: number } | null = null;
      for (const wf of view.list('wolf')) {
        if (wf.mood !== 'charge' && wf.mood !== 'bite' && wf.mood !== 'stalk' && wf.mood !== 'circle') continue;
        const d = Math.hypot(wf.x - x, wf.z - z);
        if (d < near) {
          near = d;
          nw = wf;
        }
      }
      if (nw && near < 9) this.hold('wolfbreath', 'wolf_breath', pos(nw.x, nw.y + 0.6, nw.z), sat(1 - near / 9));
    }
    for (const [k, l] of this.loops) {
      if (!l.seen) {
        l.h.stop(0.8);
        this.loops.delete(k);
      }
    }
    a.update(dt);
  }

  private mood(view: View, mode: Mode, night: number): [MusicMood, { intensity: number }] {
    if (mode === 'boot') return ['none', { intensity: 0 }];
    if (mode === 'title') return ['title', { intensity: 0.5 }];
    if (mode === 'dead') return ['death', { intensity: 0.7 }];
    if (mode === 'won') return ['rescue', { intensity: 1 }];
    const o = view.objective;
    const me = view.me;
    if (o.stage === 'holdout') return ['holdout', { intensity: 0.6 + 0.4 * sat(1 - o.eta / 180) }];
    if (o.stage === 'rescue') return ['rescue', { intensity: 0.8 }];
    // wolves: the nearest that means it
    let attack = 0, stalk = 0;
    if (me) {
      for (const w of view.list('wolf')) {
        const d = Math.hypot(w.x - me.x, w.z - me.z);
        if ((w.mood === 'charge' || w.mood === 'bite') && d < 60) attack = Math.max(attack, 1 - d / 60);
        else if ((w.mood === 'stalk' || w.mood === 'circle' || w.mood === 'feint') && d < 120) stalk = Math.max(stalk, 1 - d / 120);
      }
    }
    if (attack > 0) return ['attack', { intensity: 0.5 + 0.5 * attack }];
    if (stalk > 0) return ['stalked', { intensity: 0.4 + 0.6 * stalk }];
    if (view.env.visibility < 40) return ['whiteout', { intensity: smoothstep(40, 6, view.env.visibility) }];
    if (this.indoor > 0.5 || (me && me.fireHeat > 0.4)) return ['shelter', { intensity: 0.5 }];
    if (o.stage === 'tower' || o.stage === 'power') return ['tower', { intensity: 0.6 }];
    if (me && me.core < 34.2) return ['cold', { intensity: sat((34.2 - me.core) / 3) }];
    if (night > 0.6) return ['night', { intensity: 0.5 }];
    return ['calm', { intensity: 0.45 + 0.3 * view.env.storm }];
  }
}
