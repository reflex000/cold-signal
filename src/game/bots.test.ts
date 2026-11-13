// Bots on the real world (the cabin and the woodshed stand at the same place on every seed).
//   npx vitest run src/game/bots
//
// Regression: on about one seed in six (tools/balance.mjs, seeds 7, 8, 13) the autopilot got cold
// behind the ranger cabin and both minds stood outside its back wall, 1.9 m from the stove, striking
// matches the host refused through the wall (and the wall keeps its warmth) until the run was lost.
// "By the fire" was a distance only. Next door, the minds' own reach test for pickups stopped its
// sight line 2 cm shorter than the host's and pressed USE at the woodshed's stack through its back
// wall for good. Now a spot to work a thing from must pass the host's own reach test (botnav inReach)
// and, by a fire, its heat's sight line (canWork), for the planner's goal (Planner.workSpot) and for
// arriving alike.
import { beforeAll, describe, expect, it } from 'vitest';
import { Sim } from '../sim/sim';
import { copyInput, neutralInput } from '../sim/entities';
import { canReach } from '../sim/systems/items';
import { DT, type Action, type FireEnt, type InputCmd, type PickupEnt, type PlayerEnt } from '../sim/types';
import { toWorld, type Pose } from '../world/blueprints';
import { createWorld, type WorldEx } from '../world/index';
import { canWork, inReach, Planner, SimReader } from './botnav';
import { litFires, Mind } from './bots';

const SEED = 7;
let W: WorldEx;

beforeAll(() => {
  W = createWorld(SEED);
}, 120000);

/** A point in the cabin's own frame (blueprints.ts CABIN: stove at (-2.2, -1.8), door at (-1.15, 2.4)). */
function cabin(lx: number, lz: number): { x: number; z: number } {
  const c = W.poi('cabin');
  return toWorld({ x: c.x, y: c.y, z: c.z, yaw: c.yaw }, lx, 0, lz);
}

/** A point in the woodshed's own frame (blueprints.ts WOODSHED: the stack at (0, -0.4), open at +Z). */
function woodshed(lx: number, lz: number): { x: number; z: number } {
  const a = W.anchors['cabin:woodshed.pile'];
  const pose: Pose = { x: a.x, y: a.y, z: a.z, yaw: a.yaw };
  return toWorld(pose, lx, 0, lz + 0.4);
}

/** A one-player game on the host, played by the autopilot's mind (the 'lead' role). */
function newGame(): { sim: Sim; p: PlayerEnt; reader: SimReader; planner: Planner; mind: Mind } {
  const sim = new Sim(W, { seed: SEED, players: 1 });
  const p = sim.addPlayer('You');
  return { sim, p, reader: new SimReader(W, sim.ctx), planner: new Planner(W), mind: new Mind(p.id, 'lead', 1) };
}

function place(p: PlayerEnt, at: { x: number; z: number }, yaw = 0): void {
  p.x = at.x;
  p.z = at.z;
  p.y = W.groundAt(at.x, at.z, W.heightAt(at.x, at.z) + 0.2).y;
  p.yaw = yaw;
}

/** Run the mind on the host for up to `seconds`, until `done`. Returns the seconds taken. */
function play(g: ReturnType<typeof newGame>, seconds: number, done: () => boolean): number {
  const mind = g.mind;
  const cmd = neutralInput();
  const link = {
    send: (c: InputCmd) => {
      copyInput(cmd, c);
      g.sim.setInput(g.p.id, cmd);
    },
    act: (a: Action) => g.sim.act(g.p.id, a),
  };
  let t = 0;
  for (; t < seconds && !done(); t += DT) {
    g.planner.fires = litFires(g.reader, g.planner.fires);
    mind.tick(g.reader, g.planner, DT, link);
    g.sim.step();
  }
  return t;
}

const indoor = (x: number, y: number, z: number): boolean => W.shelterAt(x, y + 1, z, 0, 0).indoor;

describe('bots at the ranger cabin', () => {
  // just behind the back wall (where seeds 7, 8 and 13 stalled), right behind the stove, outside the west wall
  const outside: [string, number, number][] = [
    ['behind the back wall', -0.9, -3.25],
    ['behind the stove', -2.2, -3.05],
    ['outside the west wall', -3.6, -1.4],
  ];

  it('never takes a spot behind the wall for "by the stove": the plan goes in through the door', () => {
    const g = newGame();
    const stove = g.sim.ctx.all('fire').find((f) => f.type === 'stove')!;
    const door = W.anchors['cabin:cabin.door'];
    const spot = g.planner.workSpot(stove, 1.0, 1.7);
    for (const [where, lx, lz] of outside) {
      const s = cabin(lx, lz);
      const y = W.groundAt(s.x, s.z, stove.y).y;
      // the trap: walkable, near the stove, and out of its reach through the wall
      expect(g.planner.passable(g.reader, s.x, s.z), where).toBe(true);
      expect(Math.hypot(s.x - stove.x, s.z - stove.z), where).toBeLessThan(2.1);
      place(g.p, s);
      expect(canReach(g.sim.ctx, g.p, stove), where).toBe(false);
      expect(inReach(W, s.x, y, s.z, stove), where).toBe(false);
      expect(spot(s.x, s.z), where).toBe(false);

      const path = g.planner.plan(g.reader, s.x, s.z, stove.x, stove.z, spot);
      expect(path, where).not.toBeNull();
      const end = path![path!.length - 1];
      const ey = W.groundAt(end.x, end.z, stove.y).y;
      expect(indoor(end.x, ey, end.z), where).toBe(true);
      expect(canWork(W, end.x, ey, end.z, stove), where).toBe(true);
      expect(path!.some((q) => Math.hypot(q.x - door.x, q.z - door.z) < 0.3), where).toBe(true);
    }
  });

  it('a cold autopilot behind the cabin wall walks in through the door, lights the stove and warms up', () => {
    const g = newGame();
    const stove = g.sim.ctx.all('fire').find((f) => f.type === 'stove') as FireEnt;
    expect(stove.lit).toBe(false); // laid, waiting for a match
    place(g.p, cabin(-0.9, -3.25), 0.4 + Math.PI);
    g.p.core = 35.0; // below COLD_START: warm up first
    g.p.inv.matches = 4;
    g.p.inv.stick = 6;
    const t = play(g, 60, () => stove.lit);
    expect(stove.lit, `stove still cold after ${t.toFixed(0)} s, body at ${g.p.x.toFixed(1)}, ${g.p.z.toFixed(1)}`).toBe(true);
    expect(indoor(g.p.x, g.p.y, g.p.z)).toBe(true);
    expect(canReach(g.sim.ctx, g.p, stove)).toBe(true);
    // and stays by it, in its warmth
    const core = g.p.core;
    play(g, 120, () => g.p.core > core + 0.5);
    expect(g.p.core).toBeGreaterThan(core + 0.5);
    expect(indoor(g.p.x, g.p.y, g.p.z)).toBe(true);
  });
});

describe('bots at the woodshed', () => {
  it("a mind's reach never outruns the host's around the woodpile (no log through the plank wall)", () => {
    const g = newGame();
    const log = g.sim.ctx.all('pickup').find((k) => k.item === 'log' && Math.hypot(k.x - W.anchors['cabin:woodshed.pile'].x, k.z - W.anchors['cabin:woodshed.pile'].z) < 0.5) as PickupEnt;
    expect(log).toBeDefined();
    let behind = 0;
    for (let lx = -2.2; lx <= 2.2; lx += 0.1) {
      for (let lz = -2.4; lz <= 2.4; lz += 0.1) {
        const s = woodshed(lx, lz);
        if (!g.planner.walk.at(s.x, s.z)) continue;
        place(g.p, s);
        const host = canReach(g.sim.ctx, g.p, log);
        // the bot never thinks it can reach what the host refuses (it would press USE at it forever)
        if (inReach(W, g.p.x, g.p.y, g.p.z, log)) expect(host, `woodshed (${lx.toFixed(1)}, ${lz.toFixed(1)})`).toBe(true);
        if (lz < -0.9 && Math.abs(lx) < 1.4) behind++;
      }
    }
    expect(behind).toBeGreaterThan(50);
  });

  it('the autopilot behind the woodshed goes round to the open front for the log', () => {
    const g = newGame();
    const pile = W.anchors['cabin:woodshed.pile'];
    const log = g.sim.ctx.all('pickup').find((k) => k.item === 'log' && Math.hypot(k.x - pile.x, k.z - pile.z) < 0.5) as PickupEnt;
    // where seed 7 stood pressing USE at the stack through the back wall
    place(g.p, woodshed(0.34, -1.57));
    g.p.core = 36.5;
    g.p.inv.matches = 4;
    g.p.inv.stick = 9;
    const t = play(g, 40, () => (g.p.inv.log ?? 0) > 0);
    expect(g.p.inv.log ?? 0, `no log after ${t.toFixed(0)} s, body at ${g.p.x.toFixed(1)}, ${g.p.z.toFixed(1)}`).toBeGreaterThan(0);
    expect(g.sim.ctx.get(log.id) === undefined || (g.sim.ctx.get(log.id) as PickupEnt).n < 4).toBe(true);
  });
});
