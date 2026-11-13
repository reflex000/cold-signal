import { describe, expect, it, vi } from 'vitest';
import { makeDevice } from '../entities';
import { Sim } from '../sim';
import { cmd } from '../testkit';
import { createTestWorld } from '../testworld';
import { BTN, type DeviceEnt, type InputCmd, type PlayerEnt, type SimEvent } from '../types';
import { whiteoutWindow } from './env';
import { SYSTEMS } from './index';
import { COUGH_CHARGE, HOWL_CLOCK, NOTES, TONE_SIG, WARN_LEAD } from './story';

// minutes of game time with every system on (the wolves too): room for a busy machine
vi.setConfig({ testTimeout: 30_000 });

const world = createTestWorld();

function setup(n = 1, systems = SYSTEMS) {
  const sim = new Sim(world, { seed: 31, debug: true, players: n }, systems);
  const ps: PlayerEnt[] = [];
  for (let k = 0; k < n; k++) ps.push(sim.addPlayer('P' + k));
  sim.act(ps[0].id, { t: 'debug', cmd: 'lockWeather', args: [1] });
  sim.act(ps[0].id, { t: 'debug', cmd: 'storm', args: [0.3] });
  return { sim, ps, p: ps[0] };
}
const tp = (sim: Sim, p: PlayerEnt, x: number, z: number) => sim.act(p.id, { t: 'debug', cmd: 'tp', args: [x, z] });
function input(sim: Sim, p: PlayerEnt, o: Partial<InputCmd> = {}): void {
  sim.setInput(p.id, cmd(sim.state.tick + 1, { yaw: p.yaw, ...o }));
}
function run(sim: Sim, seconds: number, each?: () => void): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    each?.();
    out.push(...sim.step());
  }
  return out;
}
const toasts = (evs: SimEvent[]) => evs.filter((e) => e.t === 'toast') as Extract<SimEvent, { t: 'toast' }>[];

describe('story: the notes', () => {
  it('one at each place, read with USE, for the reader alone; each points on to the next place', () => {
    const { sim, ps } = setup(2);
    const [p, q] = ps;
    // the test world has the wreck's note; lay the others out in a row
    const notes: DeviceEnt[] = [sim.ctx.all('device').find((d) => d.type === 'note')!];
    for (let k = 1; k < NOTES.length; k++) notes.push(sim.ctx.spawn(makeDevice('note', 'wreck', -40 + k * 6, 0.8, 60, { data: k })));
    const next = [/east|ravine|tail/i, /cabin/i, /hut|lake/i, /cave/i, /tents|shoulder/i, /ridge|five parts/i, /flare/i];
    notes.forEach((d, k) => {
      tp(sim, p, d.x, d.z + 1.1);
      run(sim, 0.1, () => input(sim, p, { focus: d.id }));
      const evs = run(sim, 0.2, () => input(sim, p, { b: BTN.USE, focus: d.id }));
      const lore = toasts(evs).filter((e) => e.kind === 'lore');
      expect(lore.length, `note ${k}`).toBe(1);
      expect(lore[0].to).toBe(p.id);
      expect(lore[0].text).toBe(NOTES[d.data]);
      expect(lore[0].text).toMatch(next[k]);
      expect(lore[0].text).not.toMatch(/!/);
    });
    // out of reach, nothing
    tp(sim, q, notes[3].x, notes[3].z + 6);
    run(sim, 0.1, () => input(sim, q, { focus: notes[3].id }));
    const evs = run(sim, 0.2, () => input(sim, q, { b: BTN.USE, focus: notes[3].id }));
    expect(toasts(evs).filter((e) => e.kind === 'lore')).toEqual([]);
    // plain and short
    for (const t of NOTES) expect(t.split(' ').length).toBeLessThan(48);
  });
});

describe('story: beats', () => {
  it('the first howl comes at dusk on the first day, once, from far up the mountain', () => {
    const { sim, p } = setup();
    const before = run(sim, ((HOWL_CLOCK - sim.state.env.clock) * 60) - 2, () => input(sim, p));
    expect(before.filter((e) => e.t === 'howl')).toEqual([]);
    const evs = run(sim, 4, () => input(sim, p));
    const howl = evs.filter((e) => e.t === 'howl') as Extract<SimEvent, { t: 'howl' }>[];
    expect(howl.length).toBe(1);
    expect(howl[0].id).toBe(0);
    expect(Math.hypot(howl[0].x - p.x, howl[0].z - p.z)).toBeGreaterThan(100);
    expect(toasts(evs).filter((e) => /Wolves/.test(e.text)).length).toBe(1);
    const later = run(sim, 120, () => input(sim, p));
    expect(later.filter((e) => e.t === 'howl' && e.id === 0)).toEqual([]);
  });

  it('warns of each scripted whiteout before it comes, once, and skips the ones already past', () => {
    const { sim, p } = setup();
    for (const k of [0, 1, 2]) {
      const w = whiteoutWindow(sim.state.seed, k);
      sim.state.tick = Math.floor((w.t0 - WARN_LEAD - 2) * 30);
      const quiet = run(sim, 1.5, () => input(sim, p));
      expect(toasts(quiet).filter((e) => e.kind === 'warn' && /hiteout/.test(e.text)), `before ${k}`).toEqual([]);
      const evs = run(sim, 1, () => input(sim, p));
      const warn = toasts(evs).filter((e) => e.kind === 'warn' && e.to === 0);
      expect(warn.length, `whiteout ${k}`).toBe(1);
      expect(sim.state.env.t).toBeLessThan(w.t0 - WARN_LEAD + 1.5);
      const after = run(sim, 2, () => input(sim, p));
      expect(toasts(after).filter((e) => e.kind === 'warn')).toEqual([]);
    }
    // a game loaded long after the next two: they pass without a word
    const w5 = whiteoutWindow(sim.state.seed, 5);
    sim.state.tick = Math.floor((w5.t0 - WARN_LEAD - 30) * 30);
    const evs = run(sim, 1, () => input(sim, p));
    expect(toasts(evs).filter((e) => e.kind === 'warn')).toEqual([]);
    expect(sim.state.vars['story.wo']).toBe(5);
  });

  it("the radio's first clear tone, and the generator's first cough, each once", () => {
    // without the tools system, which would work out radioSig itself
    const { sim, ps } = setup(2, SYSTEMS.filter((s) => s.name !== 'tools'));
    const [p, q] = ps;
    p.inv.radio = 1;
    p.held = 'radio';
    p.radioCharge = 0.6;
    p.radioSig = TONE_SIG - 0.1;
    let evs = run(sim, 0.5, () => input(sim, p));
    expect(toasts(evs).filter((e) => /tone/.test(e.text))).toEqual([]);
    p.radioSig = TONE_SIG + 0.05;
    evs = run(sim, 0.5, () => input(sim, p));
    const tone = toasts(evs).filter((e) => /tone/.test(e.text));
    expect(tone.length).toBe(1);
    expect(tone[0].to).toBe(p.id);
    q.inv.radio = 1;
    q.held = 'radio';
    q.radioCharge = 0.6;
    q.radioSig = 1;
    evs = run(sim, 1, () => input(sim, p));
    expect(toasts(evs).filter((e) => /tone/.test(e.text))).toEqual([]);

    sim.state.objective.generator = COUGH_CHARGE + 0.05;
    evs = run(sim, 0.2);
    expect(toasts(evs).filter((e) => /coughs/.test(e.text) && e.to === 0).length).toBe(1);
    sim.state.objective.generator = 0;
    run(sim, 1);
    sim.state.objective.generator = 0.5;
    evs = run(sim, 0.5);
    expect(toasts(evs).filter((e) => /coughs/.test(e.text))).toEqual([]);
  });

  it('keeps quiet once the call is out', () => {
    const { sim, p } = setup();
    sim.act(p.id, { t: 'debug', cmd: 'obj.stage', args: [4] });
    const w = whiteoutWindow(sim.state.seed, 0);
    sim.state.tick = Math.floor((w.t0 - WARN_LEAD - 1) * 30);
    const evs = run(sim, 3, () => input(sim, p));
    expect(toasts(evs).filter((e) => e.kind === 'warn' && /hiteout/.test(e.text))).toEqual([]);
  });
});
