// The tutorial through play. One short line at a time, shown only while it is relevant and gone once it
// is done: look and move, take, the barrel fire, the pack, sticks, laying and lighting a fire, feeding it,
// the radio; then the lines a situation calls for (the cold, wet clothes, the whiteout, the wind taking a
// match, wolves, the ice, the water, the tools). A line that is not acted on steps back after a while and
// may come again later, a few times at most. Keys are named for the device in use: keyboard and mouse,
// gamepad or the on-screen touch controls, followed from the last input seen (DeviceWatch).
// Writing (DESIGN 2): plain, short, no exclamation marks.
// Owner: RELEASE.
import type { PlayerEnt, SimEvent } from '../sim/types';
import type { World } from '../world/types';
import type { View, ViewEnt } from './view';

export type Device = 'kbm' | 'pad' | 'touch';

/** The input device last used: key presses and the mouse, touches (only with the touch controls up), a gamepad. */
export class DeviceWatch {
  device: Device;
  private padPoll = 0;
  constructor(private readonly touchUi: boolean) {
    this.device = touchUi ? 'touch' : 'kbm';
    if (typeof window === 'undefined') return;
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('keydown', () => (this.device = 'kbm'), opts);
    window.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.device = 'kbm';
      else if (e.pointerType === 'touch' && this.touchUi) this.device = 'touch';
    }, opts);
  }

  /** A few times a second: a pressed button or a pushed stick makes the gamepad the device. */
  poll(dt: number): void {
    this.padPoll -= dt;
    if (this.padPoll > 0) return;
    this.padPoll = 0.25;
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return;
    }
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5)) {
        this.device = 'pad';
        return;
      }
    }
  }
}

/** Key names by device. */
const KEYS = {
  use: { kbm: 'E', pad: 'X', touch: 'the hand' },
  primary: { kbm: 'the left button', pad: 'RT', touch: 'the large button' },
  secondary: { kbm: 'the right button', pad: 'LT', touch: 'the sight button' },
  reload: { kbm: 'R', pad: 'Y', touch: 'the reload button' },
} as const;
const press = (d: Device, k: keyof typeof KEYS): string => (d === 'touch' ? 'Tap ' : 'Press ') + KEYS[k][d];
const hold = (d: Device, k: keyof typeof KEYS): string => 'Hold ' + KEYS[k][d];
/** How a fire is laid on each device (B on a keyboard; from the pack otherwise). */
const layFire = (d: Device): string =>
  d === 'kbm' ? 'press B to lay a fire with three sticks' : 'lay a fire from the pack with three sticks';

type Me = ViewEnt<PlayerEnt>;

interface Step {
  id: string;
  /** Relevant now: the line may show (or stays up while it is). */
  when(t: Tutor, v: View, me: Me): boolean;
  /** Done for good: the line goes and never comes back. Without it the line shows once, for `show` seconds. */
  done?(t: Tutor, v: View, me: Me): boolean;
  text(d: Device, t: Tutor, v: View, me: Me): string;
  /** Longest a showing lasts, seconds. */
  show?: number;
  /** Showings at most. */
  times?: number;
  /** A line without `done` that comes back whenever it is relevant again (after the cooldown, up to `times`). */
  again?: boolean;
  /** Cannot wait: it takes the place of any other line at once (the line it replaces may come back). */
  urgent?: boolean;
}

/** Seconds between two lines; seconds before a line that stepped back may come again. */
const GAP = 1.4;
const COOLDOWN = 45;
const SHOW = 16;
const WOLF_NEAR = 70;
const HUNTING = new Set(['stalk', 'circle', 'feint', 'charge']);

/** In order of precedence: what cannot wait first, then the tutorial in the order it is met. */
const STEPS: Step[] = [
  {
    id: 'swim',
    when: (_t, _v, me) => me.swim,
    text: (d) => `In the water. Swim to the edge of the hole and ${d === 'touch' ? 'hold the hand' : 'hold ' + KEYS.use[d]} to climb out.`,
    show: 40,
    again: true,
    urgent: true,
  },
  {
    id: 'wolves',
    when: (t) => t.wolvesNear,
    text: () => 'Wolves. Keep to the firelight and together. A light in their eyes, a flare or a shot drives them off.',
    show: 10,
    times: 1,
    urgent: true,
  },
  {
    id: 'whiteout',
    when: (_t, v) => v.env.visibility < 60 && v.objective.stage !== 'holdout' && v.objective.stage !== 'rescue',
    text: () => 'Whiteout. Stay on the marked trail, or sit it out by a fire.',
    show: 9,
    times: 1,
  },
  {
    id: 'cold',
    when: (_t, _v, me) => me.core < 35.4 && me.fireHeat < 0.2,
    text: (d) => `You are getting cold. Get under a roof or into a cave, or ${layFire(d)}.`,
    show: 12,
    times: 3,
    again: true,
  },
  {
    id: 'wind',
    when: (t) => t.windFail,
    text: () => 'The wind took the match. Lay a fire in the lee of rock, among trees or under a roof.',
    show: 10,
    times: 1,
  },
  {
    id: 'wet',
    when: (_t, _v, me) => me.wet > 0.35 && !me.swim,
    text: () => 'Wet clothes lose heat three times as fast. Only a fire or a roof dries them.',
    show: 10,
    times: 1,
  },
  {
    id: 'ice',
    when: (_t, _v, me) => me.surface === 'ice' && !me.swim,
    text: () => 'Lake ice. It is thick along the line of poles; away from them it can be thin.',
    show: 9,
    times: 1,
  },
  // ---------------------------------------------------------------- the first minutes
  {
    id: 'move',
    // (after the place card that greets the end of the opening)
    when: (t) => t.playTime > 3.5,
    done: (t) => t.moved > 4 && t.turned > 0.9,
    text: (d) => (d === 'pad' ? 'Left stick to move, right stick to look.' : d === 'touch' ? 'Left thumb to move. Drag on the right to look.' : 'W A S D to move, the mouse to look.'),
    show: 14,
  },
  {
    id: 'take',
    when: (_t, v) => {
      const f = v.hud.focus;
      return !!f && (f.kind === 'pickup' || f.kind === 'crate');
    },
    done: (t) => t.took,
    text: (d) => `${press(d, 'use')} to take what you look at. Hold it for long actions.`,
  },
  {
    id: 'barrel',
    when: (t, v, me) =>
      t.barrelLit(v) && me.fireHeat < 0.2 && t.nearWreck && (v.objective.stage === 'crash' || me.core < 36.5) && (t.isDone('take') || t.playTime > 45),
    done: (t) => t.warmedAtFire,
    text: () => 'The barrel fire by the wreck is still burning. Stand close to it to warm up.',
  },
  {
    id: 'pack',
    when: (t) => t.picked >= 2 || t.playTime > 120,
    done: (t) => t.packOpened,
    text: (d) => (d === 'pad' ? 'View opens the pack: your tools, wood and supplies.' : d === 'touch' ? 'The pack button opens your pack: tools, wood and supplies.' : 'Tab opens the pack: your tools, wood and supplies.'),
  },
  {
    id: 'radio',
    when: (t, v, me) => (me.inv.radio ?? 0) > 0 && me.held !== 'radio' && (v.objective.stage === 'search' || t.playTime > 150),
    done: (t) => t.radioHeld,
    text: (d) => (d === 'pad' ? 'LB and RB change tools. The radio hears the missing parts.' : d === 'touch' ? 'Pick the radio on the tool ring. It hears the missing parts.' : 'Press 5 for the radio. It hears the missing parts.'),
  },
  {
    id: 'crank',
    when: (_t, _v, me) => me.held === 'radio',
    done: (t) => t.tuned,
    text: (d) => `${hold(d, 'primary')} to crank it, then turn slowly. The tone is clearest toward a part.`,
    show: 18,
  },
  {
    id: 'sticks',
    when: (t, v, me) => (me.inv.stick ?? 0) < 3 && (t.focusIs(v, 'stick') || (t.outside && t.playTime > 75)),
    done: (_t, _v, me) => (me.inv.stick ?? 0) >= 3,
    text: (_d, _t, _v, me) =>
      (me.inv.axe ?? 0) > 0 ? 'Sticks lie under the trees, and the axe cuts more from dead wood. Three lay a fire.' : 'Sticks lie half buried under the trees. Three lay a fire.',
  },
  {
    id: 'build',
    // (taught when a fire would help: cooling, a storm coming on, or the dark)
    when: (t, v, me) =>
      (me.inv.stick ?? 0) >= 3 && t.outside && !t.fireNear && me.surface !== 'ice' && (me.core < 36.3 || v.env.storm > 0.6 || v.env.clock > 18.5 || v.env.clock < 6),
    done: (t) => t.built,
    text: (d) => (d === 'kbm' ? 'Press B to lay a fire with three sticks, on open ground and out of the wind.' : 'To lay a fire, open the pack and choose Lay a campfire here. It takes three sticks.'),
  },
  {
    id: 'light',
    when: (_t, v) => {
      const f = v.hud.focus;
      if (!f || f.kind !== 'fire') return false;
      const e = v.ents.get(f.id);
      return !!e && e.kind === 'fire' && !e.lit && e.type === 'campfire';
    },
    done: (t) => t.lit,
    text: (d) => `${press(d, 'use')} to strike a match. Wind can take it; tinder makes it near certain.`,
  },
  {
    id: 'feed',
    when: (t, _v, me) => t.isDone('light') && me.fireHeat > 0.2 && t.fireLow && ((me.inv.stick ?? 0) > 0 || (me.inv.log ?? 0) > 0),
    done: (t) => t.fed,
    text: (d) => `A stick burns under a minute, a split log three. ${press(d, 'use')} on the fire to add wood.`,
  },
  // ---------------------------------------------------------------- tools and the body
  {
    id: 'flaregun',
    when: (_t, _v, me) => me.held === 'flaregun' && me.flareLoaded < 1 && (me.inv.flare ?? 0) > 0,
    done: (_t, _v, me) => me.flareLoaded >= 1,
    text: (d) => `${press(d, 'reload')} to load a cartridge. A flare burns forty seconds and holds wolves off.`,
  },
  {
    id: 'rifle',
    when: (_t, _v, me) => me.held === 'rifle',
    text: (d) => `${hold(d, 'secondary')} to raise the rifle. Cold and tiredness make it sway. ${d === 'touch' ? 'The reload button' : KEYS.reload[d]} reloads.`,
    show: 9,
    times: 1,
  },
  {
    id: 'flashlight',
    when: (_t, v, me) => me.held === 'flashlight' && !me.lightOn && (v.env.clock > 18 || v.env.clock < 6.5),
    done: (_t, _v, me) => me.lightOn,
    text: (d) => (d === 'pad' ? 'D-pad up switches the flashlight on and off.' : d === 'touch' ? 'The light button switches it on and off.' : 'F switches the flashlight on and off.'),
  },
  {
    id: 'stamina',
    when: (_t, _v, me) => me.stamina < 0.2,
    text: () => 'Out of breath. Sprinting warms you a little and tires you a lot.',
    show: 7,
    times: 1,
  },
];

/** What the tutorial knows of the run: counters fed by the frame and by the local player's sim events. */
export class Tutor {
  playTime = 0;
  moved = 0;
  turned = 0;
  picked = 0;
  took = false;
  packOpened = false;
  built = false;
  lit = false;
  fed = false;
  radioHeld = false;
  tuned = false;
  swam = false;
  warmedAtFire = false;
  windFail = false;
  // per frame
  wolvesNear = false;
  outside = false;
  nearWreck = false;
  fireNear = false;
  fireLow = false;

  private readonly done = new Set<string>();
  private readonly times = new Map<string, number>();
  private readonly back = new Map<string, number>(); // id -> time it stepped back
  private active: Step | null = null;
  private since = 0;
  private offFor = 0;
  private clearAt = -1e9;
  private time = 0;
  private lastX = NaN;
  private lastZ = 0;
  private lastYaw = NaN;
  private doneCheck = 0;
  constructor(private readonly world: World, private readonly watch: DeviceWatch) {}

  get device(): Device {
    return this.watch.device;
  }

  isDone(id: string): boolean {
    return this.done.has(id);
  }

  /** The barrel fire at the wreck is burning. */
  barrelLit(v: View): boolean {
    for (const f of v.list('fire')) if (f.type === 'barrel' && f.lit) return true;
    return false;
  }

  /** The thing under the crosshair is a pickup of this item. */
  focusIs(v: View, item: string): boolean {
    const f = v.hud.focus;
    if (!f || f.kind !== 'pickup') return false;
    const e = v.ents.get(f.id);
    return !!e && e.kind === 'pickup' && e.item === item;
  }

  onEvent(ev: SimEvent, v: View): void {
    const me = v.myId;
    switch (ev.t) {
      case 'pickup':
        if (ev.by === me) {
          this.took = true;
          this.picked++;
        }
        break;
      case 'open':
        if (ev.by === me) this.took = true;
        break;
      case 'fireBuilt':
        if (ev.by === me) this.built = true;
        break;
      case 'fireLit':
        if (ev.by === me) this.lit = true;
        break;
      case 'fireFed':
        if (ev.by === me) this.fed = true;
        break;
      case 'igniteFail':
        if (ev.by === me && ev.why === 'wind') this.windFail = true;
        break;
      case 'equip':
        if (ev.id === me && ev.tool === 'radio') this.radioHeld = true;
        break;
    }
  }

  /**
   * Once per frame: the line to show, or ''. `playing` is true while the player has the controls; the
   * opening (view.opening) and anything but a living body show nothing.
   */
  update(v: View, me: Me | null, dt: number, playing: boolean): string {
    this.time += dt;
    this.watch.poll(dt);
    if (v.mode === 'inventory') this.packOpened = true;
    if (!me || (v.opening ?? 0) > 0) {
      this.lastX = NaN;
      this.lastYaw = NaN;
      return '';
    }
    if (playing) this.playTime += dt;
    this.observe(v, me, playing);
    if (me.life !== 'alive') {
      this.drop();
      return '';
    }

    // what is done is done, shown or not (a few times a second)
    this.doneCheck -= dt;
    if (this.doneCheck <= 0) {
      this.doneCheck = 0.25;
      for (const s of STEPS) if (s.done && !this.done.has(s.id) && s.done(this, v, me)) this.done.add(s.id);
    }

    // what cannot wait pushes any other line aside (that one steps back and may come again)
    if (this.active && !this.active.urgent) {
      for (const s of STEPS) {
        if (!s.urgent || this.done.has(s.id) || (this.times.get(s.id) ?? 0) >= (s.times ?? 3)) continue;
        if (this.time - (this.back.get(s.id) ?? -1e9) < COOLDOWN || !s.when(this, v, me)) continue;
        this.back.set(this.active.id, this.time - COOLDOWN + 8);
        this.active = s;
        this.since = 0;
        this.offFor = 0;
        this.times.set(s.id, (this.times.get(s.id) ?? 0) + 1);
        break;
      }
    }

    const a = this.active;
    if (a) {
      this.since += dt;
      this.offFor = a.when(this, v, me) ? 0 : this.offFor + dt;
      const limit = a.show ?? SHOW;
      if (this.done.has(a.id)) this.drop();
      else if (this.offFor > 1.5 || this.since > limit) {
        this.back.set(a.id, this.time);
        if (!a.done && !a.again) this.done.add(a.id); // a line without an end shows its time once
        this.drop();
      }
    }
    if (!this.active && playing && this.time - this.clearAt >= GAP) {
      for (const s of STEPS) {
        if (this.done.has(s.id)) continue;
        const n = this.times.get(s.id) ?? 0;
        if (n >= (s.times ?? 3)) continue;
        if (this.time - (this.back.get(s.id) ?? -1e9) < COOLDOWN) continue;
        if (!s.when(this, v, me)) continue;
        this.active = s;
        this.since = 0;
        this.offFor = 0;
        this.times.set(s.id, n + 1);
        break;
      }
    }
    return this.active ? this.active.text(this.device, this, v, me) : '';
  }

  private drop(): void {
    if (this.active) this.clearAt = this.time;
    this.active = null;
  }

  /** Movement, look and the surroundings for this frame. */
  private observe(v: View, me: Me, playing: boolean): void {
    if (playing) {
      if (!Number.isNaN(this.lastX)) this.moved += Math.min(2, Math.hypot(me.x - this.lastX, me.z - this.lastZ));
      if (!Number.isNaN(this.lastYaw)) {
        let d = Math.abs(v.camera.yaw - this.lastYaw);
        if (d > Math.PI) d = 2 * Math.PI - d;
        this.turned += Math.min(0.5, d);
      }
    }
    this.lastX = me.x;
    this.lastZ = me.z;
    this.lastYaw = v.camera.yaw;
    if (me.swim) this.swam = true;
    if (me.fireHeat > 0.3) this.warmedAtFire = true;
    if (me.held === 'radio' && me.radioCharge > 0.4 && me.radioSig > 0.5) this.tuned = true;
    // out in the open: off the wreck's site and not under a roof
    const wreck = this.world.poi('wreck');
    const dw = Math.hypot(me.x - wreck.x, me.z - wreck.z);
    this.outside = dw > 22 && me.shelter < 0.75;
    this.nearWreck = dw < 60;
    let near = false, low = false;
    for (const f of v.list('fire')) {
      if (!f.lit) continue;
      const d = Math.hypot(f.x - me.x, f.z - me.z);
      if (d < 10) near = true;
      if (d < 4 && f.fuel < 60) low = true;
    }
    this.fireNear = near;
    this.fireLow = low;
    let wolves = false;
    for (const w of v.list('wolf')) {
      if (HUNTING.has(w.mood) && Math.hypot(w.x - me.x, w.z - me.z) < WOLF_NEAR) {
        wolves = true;
        break;
      }
    }
    this.wolvesNear = wolves;
  }
}
