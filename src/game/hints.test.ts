// The tutorial lines (hints.ts) against a small fake View: what shows when, what makes a line go, and
// the keys named for each device.
import { describe, expect, it } from 'vitest';
import type { Entity, FireEnt, PickupEnt, PlayerEnt, SimEvent } from '../sim/types';
import type { World } from '../world/types';
import { DeviceWatch, Tutor, type Device } from './hints';
import type { Focus, View, ViewEnt } from './view';

const WRECK = { x: 0, z: 0 };
const world = { poi: () => ({ id: 'wreck', name: 'The fuselage', x: WRECK.x, z: WRECK.z, radius: 40 }) } as unknown as World;

function makeMe(o: Partial<PlayerEnt> = {}): ViewEnt<PlayerEnt> {
  return {
    id: 1, kind: 'player', x: 0, y: 0, z: 0, yaw: 0, rev: 0, age: 1, name: 'You', slot: 0, bot: false,
    vx: 0, vy: 0, vz: 0, pitch: 0, onGround: true, crouch: false, sprint: false, surface: 'snow', swim: false, seq: 0,
    life: 'alive', health: 100, core: 37, wet: 0, stamina: 1, hunger: 0, feels: -10, shelter: 0, fireHeat: 0, huddle: 0,
    trend: 0, bleed: 0, revive: 0, reviver: 0, inv: { flashlight: 1, matches: 4 }, held: 'hands', act: 'none', actT: 0,
    loaded: 0, flareLoaded: 0, lightOn: false, cellCharge: 1, radioCharge: 0, radioSig: 0, radioDist: -1, aim: 0,
    carry: 0, isolation: 1, kills: 0, ...o,
  } as ViewEnt<PlayerEnt>;
}

class Fake {
  me = makeMe();
  ents = new Map<number, ViewEnt>();
  focus: Focus | null = null;
  view: View;
  constructor() {
    const self = this;
    this.view = {
      world, mode: 'play', touch: false, time: 0, myId: 1, opening: 0,
      env: { t: 0, clock: 16.5, day: 0, storm: 0.45, windX: 6, windZ: 6, gust: 0, snowfall: 0.4, visibility: 400, airTemp: -12, cloud: 0.6, aurora: 0, snowAccum: 0 },
      objective: { stage: 'crash', parts: { battery: 'lost', handset: 'lost', coil: 'lost', tube: 'lost', fuse: 'lost' }, generator: 0, transmit: 0, eta: -1, signalled: false },
      camera: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, fov: 75, third: 0 },
      get ents() {
        return self.ents;
      },
      get hud() {
        return { focus: self.focus } as View['hud'];
      },
      list(kind: string) {
        return [...self.ents.values()].filter((e) => e.kind === kind);
      },
    } as unknown as View;
  }
  add<E extends Entity>(e: Partial<E> & { id: number; kind: E['kind'] }): ViewEnt<E> {
    const v = { x: 0, y: 0, z: 0, yaw: 0, rev: 0, age: 1, ...e } as unknown as ViewEnt<E>;
    this.ents.set(e.id, v as unknown as ViewEnt);
    return v;
  }
}

/** Run frames of dt seconds; returns the last line. */
function run(t: Tutor, f: Fake, seconds: number, each?: (k: number) => void, dt = 1 / 30): string {
  let line = '';
  for (let k = 0; k < Math.round(seconds / dt); k++) {
    each?.(k);
    line = t.update(f.view, f.me, dt, true);
  }
  return line;
}

function tutor(device: Device = 'kbm'): { t: Tutor; f: Fake; watch: DeviceWatch } {
  const watch = new DeviceWatch(device === 'touch');
  watch.device = device;
  watch.poll = () => {}; // no gamepads here
  return { t: new Tutor(world, watch), f: new Fake(), watch };
}

const ev = (e: SimEvent, t: Tutor, f: Fake) => t.onEvent(e, f.view);

describe('tutorial lines', () => {
  it('say nothing under the opening, then teach moving and looking, and stop once both are done', () => {
    const { t, f } = tutor();
    f.view.opening = 5;
    expect(run(t, f, 5)).toBe('');
    f.view.opening = 0;
    expect(run(t, f, 2)).toBe(''); // the place card has the screen first
    expect(run(t, f, 2)).toBe('W A S D to move, the mouse to look.');
    // walk and turn
    const line = run(t, f, 4, (k) => {
      f.me.x += 0.05;
      f.view.camera.yaw += 0.02;
      void k;
    });
    expect(line).toBe('');
    expect(t.isDone('move')).toBe(true);
  });

  it('teach taking when something to take is under the crosshair; a pickup ends it', () => {
    const { t, f } = tutor();
    t.moved = 10;
    t.turned = 2;
    run(t, f, 5);
    const p = f.add<PickupEnt>({ id: 7, kind: 'pickup', item: 'radio', n: 1, lie: 'ground' });
    f.focus = { id: p.id, kind: 'pickup', verb: 'Take', name: 'Hand-crank radio', hold: null, key: 'E' };
    expect(run(t, f, 2)).toBe('Press E to take what you look at. Hold it for long actions.');
    ev({ t: 'pickup', by: 1, item: 'radio', n: 1 }, t, f);
    f.focus = null;
    f.me.inv.radio = 1;
    f.view.objective.stage = 'search'; // (taking the radio starts the search, objective.ts)
    // the radio line follows: it is what taking the radio made relevant
    expect(run(t, f, 3)).toBe('Press 5 for the radio. It hears the missing parts.');
  });

  it('name the keys of the device in use', () => {
    for (const [d, take, radio] of [
      ['pad', 'Press X to take', 'LB and RB change tools.'],
      ['touch', 'Tap the hand to take', 'Pick the radio on the tool ring.'],
    ] as const) {
      const { t, f } = tutor(d);
      t.moved = 10;
      t.turned = 2;
      run(t, f, 5);
      f.add<PickupEnt>({ id: 7, kind: 'pickup', item: 'cell', n: 1, lie: 'ground' });
      f.focus = { id: 7, kind: 'pickup', verb: 'Take', name: 'Cell', hold: null, key: '' };
      expect(run(t, f, 2)).toContain(take);
      ev({ t: 'pickup', by: 1, item: 'cell', n: 1 }, t, f);
      f.focus = null;
      f.me.inv.radio = 1;
      f.view.objective.stage = 'search';
      expect(run(t, f, 3)).toContain(radio);
    }
  });

  it('lay and light a fire: the lines come when a fire would help, and go when it is done', () => {
    const { t, f } = tutor('pad');
    t.moved = 10;
    t.turned = 2;
    f.view.objective.stage = 'search';
    f.me.x = 200; // out on the mountain
    f.me.inv.stick = 3;
    f.view.env.clock = 20; // night
    run(t, f, 5);
    let line = run(t, f, 2);
    expect(line).toBe('To lay a fire, open the pack and choose Lay a campfire here. It takes three sticks.');
    ev({ t: 'fireBuilt', id: 30, by: 1 }, t, f);
    const fire = f.add<FireEnt>({ id: 30, kind: 'fire', type: 'campfire', lit: false, fuel: 0, heat: 0, size: 0.3, shelter: 0, embers: 0, by: 1, x: 201, z: 0 });
    f.focus = { id: fire.id, kind: 'fire', verb: 'Light', name: 'Campfire', hold: null, key: '' };
    line = run(t, f, 2);
    expect(line).toBe('Press X to strike a match. Wind can take it; tinder makes it near certain.');
    ev({ t: 'fireLit', id: 30, by: 1 }, t, f);
    fire.lit = true;
    f.focus = null;
    line = run(t, f, 2.5);
    expect(line).not.toContain('strike a match');
    expect(t.isDone('light')).toBe(true);
  });

  it('the cold: a line that comes back when it matters again, a few times at most', () => {
    const { t, f } = tutor();
    t.moved = 10;
    t.turned = 2;
    run(t, f, 5);
    f.me.core = 35;
    expect(run(t, f, 2)).toBe('You are getting cold. Get under a roof or into a cave, or press B to lay a fire with three sticks.');
    // warm again: the line goes (and may come back later, after the cooldown)
    f.me.core = 36.8;
    f.me.fireHeat = 0.5;
    expect(run(t, f, 3)).not.toContain('getting cold');
    expect(t.isDone('cold')).toBe(false);
  });

  it('the water cannot wait: it pushes a tutorial line aside at once', () => {
    const { t, f } = tutor();
    run(t, f, 5);
    expect(run(t, f, 0.2)).toBe('W A S D to move, the mouse to look.');
    f.me.swim = true;
    expect(run(t, f, 0.1)).toBe('In the water. Swim to the edge of the hole and hold E to climb out.');
    f.me.swim = false;
    expect(run(t, f, 2)).not.toContain('In the water');
  });

  it('nothing while down', () => {
    const { t, f } = tutor();
    run(t, f, 5);
    f.me.life = 'downed';
    expect(run(t, f, 2)).toBe('');
  });
});
