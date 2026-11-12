import { describe, expect, it } from 'vitest';
import { makePlayer } from './entities';
import {
  CRAWL_SPEED, CROUCH_SPEED, DRAG_SPEED, JUMP_COST, movePlayer, PLAYER_RADIUS, SPRINT_SPEED, stepPlayerMove, SWIM_SPEED,
  WALK_SPEED, type Gait,
} from './move';
import { cmd } from './testkit';
import { createTestWorld, TEST_DECK, TEST_DRIFT, TEST_FLOOR, TEST_TREE, TEST_WALL } from './testworld';
import { BTN, DT, type InputCmd, type PlayerEnt, type SimEvent } from './types';

const world = createTestWorld();
const NORTH = 0;
const SOUTH = Math.PI;
const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;

function player(x: number, z: number, yaw = 0): PlayerEnt {
  const g = world.groundAt(x, z, world.heightAt(x, z) + 0.2);
  const p = makePlayer('test', 0, x, g.y, z, yaw);
  p.id = 1;
  p.rev = 1;
  p.surface = g.surface;
  return p;
}

/** Run a command for `seconds`; calls `each` after every tick. */
function run(p: PlayerEnt, c: InputCmd, seconds: number, each?: (p: PlayerEnt) => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    stepPlayerMove(p, c, world, DT);
    each?.(p);
  }
}

/** Ground speed over `seconds` after `settle` seconds to get up to pace. */
function paceOf(p: PlayerEnt, c: InputCmd, settle = 1.5, seconds = 1): number {
  run(p, c, settle);
  const x0 = p.x, z0 = p.z;
  run(p, c, seconds);
  return Math.hypot(p.x - x0, p.z - z0) / seconds;
}

const walk = (yaw: number, o: Partial<InputCmd> = {}) => cmd(1, { yaw, mz: 1, ...o });

describe('stepPlayerMove: pace', () => {
  it('walks at 2.6 m/s on flat, shallow snow', () => {
    const p = player(0, 30);
    expect(p.surface).toBe('snow');
    expect(paceOf(p, walk(NORTH))).toBeCloseTo(WALK_SPEED, 2);
    expect(p.onGround).toBe(true);
    expect(p.y).toBe(0);
    expect(p.surface).toBe('snow');
  });

  it('faces the way the yaw says: 0 north (-Z), positive turns left', () => {
    const n = player(0, 30);
    run(n, walk(NORTH), 1);
    expect(n.z).toBeLessThan(29);
    expect(Math.abs(n.x)).toBeLessThan(1e-9);
    const w = player(0, 30);
    run(w, walk(WEST), 1);
    expect(w.x).toBeLessThan(-1);
    const strafe = player(0, 30);
    run(strafe, cmd(1, { yaw: NORTH, mx: 1 }), 1); // strafe right while facing north = east
    expect(strafe.x).toBeGreaterThan(1);
  });

  it('accelerates with weight: a quarter second or so to walking pace, a short stop', () => {
    const p = player(0, 30);
    stepPlayerMove(p, walk(NORTH), world, DT);
    const v1 = Math.hypot(p.vx, p.vz);
    expect(v1).toBeGreaterThan(0.2);
    expect(v1).toBeLessThan(0.6);
    run(p, walk(NORTH), 0.3);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(WALK_SPEED, 5);
    const z0 = p.z;
    run(p, cmd(1, { yaw: NORTH }), 1);
    expect(Math.hypot(p.vx, p.vz)).toBe(0);
    expect(z0 - p.z).toBeGreaterThan(0.15);
    expect(z0 - p.z).toBeLessThan(0.45);
  });

  it('sprints at 4.6, crouches at 1.3, backs up slower than it walks', () => {
    expect(paceOf(player(0, 30), walk(SOUTH, { b: BTN.SPRINT }))).toBeCloseTo(SPRINT_SPEED, 2);
    const c = player(0, 30);
    expect(paceOf(c, walk(SOUTH, { b: BTN.CROUCH }))).toBeCloseTo(CROUCH_SPEED, 2);
    expect(c.crouch).toBe(true);
    expect(paceOf(player(0, 30), cmd(1, { yaw: NORTH, mz: -1 }))).toBeCloseTo(WALK_SPEED * 0.8, 2);
    // Sprint only works going forward.
    const s = player(0, 30);
    expect(paceOf(s, cmd(1, { yaw: NORTH, mx: 1, b: BTN.SPRINT }))).toBeCloseTo(WALK_SPEED, 2);
    expect(s.sprint).toBe(false);
  });

  it('slows to about 60 % in half a metre of loose snow', () => {
    const p = player((TEST_DRIFT.minX + TEST_DRIFT.maxX) / 2, TEST_DRIFT.maxZ - 1);
    expect(world.snowDepthAt(p.x, p.z)).toBe(0.5);
    const pace = paceOf(p, walk(NORTH));
    expect(pace / WALK_SPEED).toBeCloseTo(0.6, 2);
    expect(p.surface).toBe('deep');
  });

  it('takes speed modifiers from the player: downed, dragging a log, carrying with a partner, cold, swimming', () => {
    const d = player(0, 30);
    d.life = 'downed';
    expect(paceOf(d, walk(NORTH))).toBeCloseTo(CRAWL_SPEED, 2);
    const drag = player(0, 30);
    drag.carry = 99;
    expect(paceOf(drag, walk(NORTH, { b: BTN.SPRINT }))).toBeCloseTo(DRAG_SPEED, 2);
    const pair = player(0, 30);
    pair.carry = 99;
    pair.carryPair = true;
    expect(paceOf(pair, walk(NORTH))).toBeCloseTo(WALK_SPEED, 2);
    const cold = player(0, 30);
    cold.core = 30;
    expect(paceOf(cold, walk(NORTH))).toBeCloseTo(WALK_SPEED * 0.75, 2);
    const mild = player(0, 30);
    mild.core = 34;
    expect(paceOf(mild, walk(NORTH))).toBeCloseTo(WALK_SPEED, 2);
    const swim = player(0, 110);
    swim.swim = true;
    expect(paceOf(swim, walk(SOUTH), 3)).toBeCloseTo(SWIM_SPEED, 2);
    expect(swim.surface).toBe('water');
    expect(swim.y).toBeLessThan(-1);
  });

  it('cannot jump while downed, swimming or carrying', () => {
    for (const set of [(p: PlayerEnt) => (p.life = 'downed'), (p: PlayerEnt) => (p.carry = 5)]) {
      const p = player(0, 30);
      set(p);
      run(p, cmd(1, { b: BTN.JUMP }), 0.5);
      expect(p.y).toBe(0);
    }
    const s = player(0, 110);
    s.swim = true;
    run(s, cmd(1), 2); // settle at swimming depth
    let maxY = -Infinity;
    run(s, cmd(1, { b: BTN.JUMP }), 2, (q) => (maxY = Math.max(maxY, q.y)));
    expect(maxY).toBeLessThan(-1);
    expect(s.swim).toBe(true);
  });

  it('a rescued player does not move', () => {
    const p = player(0, 30);
    p.life = 'rescued';
    p.y = 12;
    p.onGround = false;
    run(p, walk(NORTH, { yaw: 1 }), 1);
    expect([p.x, p.y, p.z]).toEqual([0, 12, 30]);
    expect(p.yaw).toBe(1);
  });
});

describe('stepPlayerMove: terrain', () => {
  it('cannot climb a cliff, walking or jumping', () => {
    for (const b of [0, BTN.JUMP | BTN.SPRINT]) {
      const p = player(50, 10);
      let maxY = 0;
      run(p, walk(EAST, { b }), 15, (q) => (maxY = Math.max(maxY, q.y)));
      expect(p.x).toBeLessThan(61.5);
      expect(maxY).toBeLessThan(2);
    }
  });

  it('slides down a face too steep to stand on', () => {
    const p = player(65, 10);
    const y0 = p.y;
    expect(y0).toBeGreaterThan(5);
    run(p, cmd(1, { yaw: EAST }), 4);
    expect(p.x).toBeLessThan(61);
    expect(p.y).toBeLessThan(1);
    // Trying to walk up it does not help.
    const q = player(65, 10);
    run(q, walk(EAST), 4);
    expect(q.x).toBeLessThan(61);
  });

  it('climbs a 27 degree ramp, slower than on the flat', () => {
    const p = player(-50, 10);
    run(p, walk(WEST), 6);
    expect(p.x).toBeLessThan(-62);
    const pace = paceOf(p, walk(WEST), 0.5, 1);
    expect(pace).toBeGreaterThan(1.7);
    expect(pace).toBeLessThan(2.2);
    run(p, walk(WEST), 15);
    expect(p.y).toBeCloseTo(10, 5);
  });

  it('is slippery on ice: slow to get going, slow to stop', () => {
    const ice = player(0, 95);
    expect(ice.surface).toBe('ice');
    run(ice, walk(SOUTH), 0.5);
    expect(Math.hypot(ice.vx, ice.vz)).toBeLessThan(1.3);
    run(ice, walk(SOUTH), 1.5);
    expect(Math.hypot(ice.vx, ice.vz)).toBeCloseTo(WALK_SPEED, 5);
    const z0 = ice.z;
    run(ice, cmd(1, { yaw: SOUTH }), 5);
    expect(ice.surface).toBe('ice');
    expect(ice.z - z0).toBeGreaterThan(2.5);

    const snow = player(0, 30);
    run(snow, walk(SOUTH), 2);
    const s0 = snow.z;
    run(snow, cmd(1, { yaw: SOUTH }), 5);
    expect(snow.z - s0).toBeLessThan(0.5);
  });

  it('steps up onto a low floor and off it again, and walks under a high deck', () => {
    const p = player(TEST_FLOOR.x, TEST_FLOOR.z + 5);
    expect(p.y).toBe(0);
    let onFloor = false;
    run(p, walk(NORTH), 4, (q) => {
      if (Math.abs(q.z - TEST_FLOOR.z) < 1) {
        expect(q.y).toBeCloseTo(TEST_FLOOR.y, 9);
        expect(q.surface).toBe('wood');
        onFloor = true;
      }
    });
    expect(onFloor).toBe(true);
    expect(p.z).toBeLessThan(TEST_FLOOR.z - TEST_FLOOR.hz - 0.5);
    expect(p.y).toBe(0);
    expect(p.surface).toBe('snow');

    const u = player(TEST_DECK.x, TEST_DECK.z + 5);
    run(u, walk(NORTH), 4, (q) => expect(q.y).toBe(0));
    expect(u.z).toBeLessThan(TEST_DECK.z - TEST_DECK.hz);
  });

  it('falls, and lands with a land event', () => {
    const p = player(0, 30);
    p.y = 5;
    p.onGround = false;
    const ev: SimEvent[] = [];
    const gait: Gait = { dist: 0, left: false };
    for (let i = 0; i < 40; i++) movePlayer(p, cmd(1), world, DT, gait, (e) => ev.push(e));
    expect(p.onGround).toBe(true);
    expect(p.y).toBe(0);
    const land = ev.find((e) => e.t === 'land');
    expect(land && land.t === 'land' && land.speed).toBeGreaterThan(9);
  });

  it('jumps about 0.6 m and comes down in about 0.6 s, paying stamina', () => {
    const p = player(0, 30);
    const still = player(0, 30);
    p.stamina = still.stamina = 0.5;
    const ev: SimEvent[] = [];
    const gait: Gait = { dist: 0, left: false };
    movePlayer(p, cmd(1, { b: BTN.JUMP }), world, DT, gait, (e) => ev.push(e));
    stepPlayerMove(still, cmd(1), world, DT);
    expect(ev.some((e) => e.t === 'jump')).toBe(true);
    expect(still.stamina - p.stamina).toBeCloseTo(JUMP_COST, 9);
    let maxY = p.y, ticks = 1;
    while (!p.onGround && ticks < 60) {
      movePlayer(p, cmd(1), world, DT, gait, (e) => ev.push(e));
      maxY = Math.max(maxY, p.y);
      ticks++;
    }
    expect(maxY).toBeGreaterThan(0.5);
    expect(maxY).toBeLessThan(0.7);
    expect(ticks * DT).toBeGreaterThan(0.5);
    expect(ticks * DT).toBeLessThan(0.7);
  });

  it('is held inside the world edge', () => {
    const p = player(185, 0);
    let maxX = 0;
    run(p, walk(EAST, { b: BTN.SPRINT }), 10, (q) => (maxX = Math.max(maxX, q.x)));
    expect(maxX).toBeLessThanOrEqual(world.half - 1.5 + 1e-9);
    expect(maxX).toBeGreaterThan(world.half - 8);
  });
});

describe('stepPlayerMove: colliders', () => {
  it('stops against a tree trunk and slides round it', () => {
    const rr = TEST_TREE.r + PLAYER_RADIUS;
    const head = player(TEST_TREE.x - 5, TEST_TREE.z);
    run(head, walk(EAST), 5, (q) => expect(Math.hypot(q.x - TEST_TREE.x, q.z - TEST_TREE.z)).toBeGreaterThanOrEqual(rr - 1e-6));
    expect(head.x).toBeGreaterThan(TEST_TREE.x - rr - 0.05);
    expect(head.x).toBeLessThan(TEST_TREE.x - rr + 1e-6);

    const glance = player(TEST_TREE.x - 5, TEST_TREE.z + 0.3);
    run(glance, walk(EAST), 6, (q) => expect(Math.hypot(q.x - TEST_TREE.x, q.z - TEST_TREE.z)).toBeGreaterThanOrEqual(rr - 1e-6));
    expect(glance.x).toBeGreaterThan(TEST_TREE.x + 2);
  });

  it('never passes through a turned wall', () => {
    const w = TEST_WALL;
    const cs = Math.cos(w.yaw), sn = Math.sin(w.yaw);
    const boxDist = (x: number, z: number) => {
      const dx = x - w.x, dz = z - w.z;
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      return Math.hypot(Math.max(0, Math.abs(lx) - w.hx), Math.max(0, Math.abs(lz) - w.hz));
    };
    for (const x0 of [-2, 0, 2]) {
      const p = player(w.x + x0, w.z + 5);
      run(p, walk(NORTH), 6, (q) => expect(boxDist(q.x, q.z)).toBeGreaterThanOrEqual(PLAYER_RADIUS - 1e-6));
    }
  });

  it('steps over a stump lower than a step', () => {
    const p = player(17, 5);
    run(p, walk(EAST), 3);
    expect(p.x).toBeGreaterThan(22);
    expect(Math.abs(p.z - 5)).toBeLessThan(1e-9);
  });
});

describe('stepPlayerMove: stamina', () => {
  it('sprints about 12 s from full to empty, then walks until it has recovered a little', () => {
    const p = player(-150, -40);
    const c = walk(SOUTH, { b: BTN.SPRINT });
    let emptyAt = -1, t = 0;
    while (t < 16 && emptyAt < 0) {
      stepPlayerMove(p, c, world, DT);
      t += DT;
      if (p.stamina === 0) emptyAt = t;
    }
    expect(emptyAt).toBeGreaterThan(11.5);
    expect(emptyAt).toBeLessThan(12.5);
    run(p, c, 0.5);
    expect(p.sprint).toBe(false);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(WALK_SPEED, 1);
    // Recovers while walking; sprints again once above the threshold.
    run(p, c, 3);
    expect(p.stamina).toBeGreaterThan(0);
  });

  it('recovers standing still in about 8 s, and much slower when cold', () => {
    const p = player(0, 30);
    p.stamina = 0;
    run(p, cmd(1), 8.1);
    expect(p.stamina).toBe(1);
    const cold = player(0, 30);
    cold.stamina = 0;
    cold.core = 31;
    run(cold, cmd(1), 8);
    expect(cold.stamina).toBeGreaterThan(0.25);
    expect(cold.stamina).toBeLessThan(0.45);
  });
});

describe('stepPlayerMove: purity', () => {
  it('touches only the movement fields and is repeatable', () => {
    const a = player(3, 12);
    const b = player(3, 12);
    const movement = new Set(['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch', 'onGround', 'crouch', 'sprint', 'surface', 'swim', 'stamina']);
    const rest = (p: PlayerEnt) => JSON.stringify(Object.entries(p).filter(([k]) => !movement.has(k)));
    const before = rest(a);
    const c = cmd(0);
    let path = 0;
    for (let n = 0; n < 600; n++) {
      c.yaw = n * 0.02;
      c.pitch = Math.sin(n * 0.1);
      c.mz = n % 90 < 60 ? 1 : -0.4;
      c.mx = n % 40 < 10 ? 1 : 0;
      c.b = (n % 200 < 80 ? BTN.SPRINT : 0) | (n % 33 === 0 ? BTN.JUMP : 0) | (n % 150 > 130 ? BTN.CROUCH : 0);
      const x0 = a.x, z0 = a.z;
      stepPlayerMove(a, c, world, DT);
      stepPlayerMove(b, c, world, DT);
      path += Math.hypot(a.x - x0, a.z - z0);
    }
    expect(rest(a)).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(path).toBeGreaterThan(30);
  });
});

describe('movePlayer: footsteps', () => {
  it('steps on a cadence that follows the speed, alternating feet, on the right surface', () => {
    const count = (c: InputCmd, x: number, z: number) => {
      const p = player(x, z);
      const ev: SimEvent[] = [];
      const gait: Gait = { dist: 0, left: false };
      for (let i = 0; i < 300; i++) movePlayer(p, c, world, DT, gait, (e) => ev.push(e));
      return ev.filter((e) => e.t === 'step') as Extract<SimEvent, { t: 'step' }>[];
    };
    const w = count(walk(SOUTH), 0, 20);
    expect(w.length).toBeGreaterThanOrEqual(21);
    expect(w.length).toBeLessThanOrEqual(25);
    expect(w.every((e) => e.surface === 'snow' && !e.run && e.id === 1)).toBe(true);
    for (let i = 1; i < w.length; i++) expect(w[i].left).toBe(!w[i - 1].left);
    const s = count(walk(SOUTH, { b: BTN.SPRINT }), -150, -40);
    expect(s.length).toBeGreaterThan(w.length + 4);
    expect(s.some((e) => e.run)).toBe(true);
    const ice = count(walk(SOUTH), 0, 92);
    expect(ice.some((e) => e.surface === 'ice')).toBe(true);
    expect(count(cmd(1), 0, 20).length).toBe(0);
  });
});
