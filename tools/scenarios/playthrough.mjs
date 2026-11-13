// The release test: the whole run, played in the real game from the crash to the rescue.
//
// The autopilot (src/game/bots.ts, a bot mind in the 'lead' role) plays the LOCAL player through the
// same path a person's devices use: one InputCmd per tick into the client session, Actions through
// GameActions, reading only the client's View. One companion bot (?bots=1) goes along, driven by the
// same mind in the 'follow' role through the host's bot path. Nothing is handed over: every radio part
// is found where it lies (no CS.give), every fire is laid from gathered sticks and lit with a match.
//
// Passes when: all five parts are found from the world and installed, a whiteout is sat out by a lit
// fire, the lake is crossed to the hut and back, the tower is reached, the generator cranked, the call
// sent, the helicopter winches everyone up (stage 'won'), and the console stays clean. Time runs at three
// ticks per rendered frame (the host still ticks at exactly 30 Hz of game time; only drawing is skipped).
// Prints the in-game time the run took.
//   node tools/play.mjs tools/scenarios/playthrough.mjs [--backend webgl] [--query "wire=json&lag=120&jitter=30"]
export const query = 'bots=1';

const MAX_GAME_SECONDS = 95 * 60; // an hour's run, with room for a bad night
const FRAME_DT = 0.1; // seconds per frame: three host ticks

export default async function ({ ev, step, shot, log, check }) {
  await step(5);
  // ---------------------------------------------------------------- page-side recorder
  await ev(() => {
    const CS = window.CS;
    const W = CS.world;
    const PT = (window.PT = {
      events: {}, found: [], installed: [], gives: 0, deaths: 0, downs: 0, revives: 0,
      whiteout: 0, whiteoutAtFire: 0, whiteoutMinCore: 99, whiteoutNow: false, spells: [], spell: null,
      onIce: 0, hut: false, crossed: false, tower: false, beats: [], last: '', firesLit: 0, partsSeen: {},
    });
    const hut = W.poi('hut'), tower = W.poi('tower');
    CS.view.bus.on('sim', (e) => {
      PT.events[e.t] = (PT.events[e.t] || 0) + 1;
      const me = CS.view.myId;
      if (e.t === 'partFound') PT.found.push({ part: e.part, by: e.by === me ? 'player' : 'bot', t: Math.round(CS.sim.state.env.t) });
      if (e.t === 'partInstalled') PT.installed.push(e.part);
      if (e.t === 'died') PT.deaths++;
      if (e.t === 'downed') PT.downs++;
      if (e.t === 'revived') PT.revives++;
      if (e.t === 'fireLit') PT.firesLit++;
    });
    // CS.give is never called; count it if anything does
    const give = CS.give;
    CS.give = (...a) => {
      PT.gives++;
      return give(...a);
    };
    // sample the authoritative state after every frame
    const orig = CS.game.stepFrame.bind(CS.game);
    CS.game.stepFrame = (dt, render) => {
      orig(dt, render);
      const st = CS.sim && CS.sim.state;
      if (!st) return;
      const p = CS.sim.ctx.get(CS.view.myId);
      if (!p) return;
      const storm = st.env.storm;
      PT.whiteoutNow = storm > 0.9;
      if (storm > 0.9 && st.objective.stage !== 'holdout' && st.objective.stage !== 'rescue') {
        PT.whiteout += dt;
        const warm = p.life === 'alive' && p.fireHeat > 0.2;
        if (warm) PT.whiteoutAtFire += dt;
        PT.whiteoutMinCore = Math.min(PT.whiteoutMinCore, p.core);
        // each whiteout spell on its own: how long, how much of it by a fire, did we come through
        if (!PT.spell) PT.spells.push((PT.spell = { t0: Math.round(st.env.t), dur: 0, atFire: 0, minCore: 99, died: false }));
        PT.spell.dur += dt;
        if (warm) PT.spell.atFire += dt;
        PT.spell.minCore = Math.min(PT.spell.minCore, p.core);
        if (p.life === 'dead') PT.spell.died = true;
      } else PT.spell = null;
      if (W.iceAt(p.x, p.z) > 0) PT.onIce += dt;
      if (Math.hypot(p.x - hut.x, p.z - hut.z) < 6) PT.hut = true;
      if (PT.hut && W.iceAt(p.x, p.z) <= 0 && Math.hypot(p.x - hut.x, p.z - hut.z) > 120) PT.crossed = true;
      if (Math.hypot(p.x - tower.x, p.z - tower.z) < 40) PT.tower = true;
    };
    PT.state = () => {
      const st = CS.sim.state, p = CS.sim.ctx.get(CS.view.myId);
      const parts = Object.entries(st.objective.parts).map(([k, v]) => k[0] + (v === 'installed' ? 'I' : v === 'held' ? 'H' : '-')).join('');
      const bots = CS.game.botsDoing();
      return {
        t: Math.round(st.env.t), clock: Math.round(st.env.clock * 10) / 10, storm: Math.round(st.env.storm * 100) / 100,
        stage: st.objective.stage, parts, x: Math.round(p.x), z: Math.round(p.z), core: Math.round(p.core * 10) / 10,
        life: p.life, kit: `sticks ${p.inv.stick ?? 0} matches ${p.inv.matches ?? 0}`, doing: bots.auto, bot: Object.entries(bots).filter(([k]) => k !== 'auto').map(([, v]) => v).join(', '),
      };
    };
  });
  await ev(() => window.CS.auto(true));
  const s0 = await ev(() => window.PT.state());
  check(s0.stage === 'crash' || s0.stage === 'search', 'starts at the crash');
  await shot('playthrough_00_start', { sheet: 'playthrough' });

  // ---------------------------------------------------------------- the run
  const shotAt = new Set();
  let last = null, lastLog = -999;
  for (let guard = 0; guard < 4000; guard++) {
    await step(150, FRAME_DT); // 15 s of game time, the last frame drawn
    const s = await ev(() => window.PT.state());
    const pt = await ev(() => ({ found: window.PT.found.length, whiteoutNow: window.PT.whiteoutNow, hut: window.PT.hut, tower: window.PT.tower, installed: window.PT.installed.length }));
    if (s.t - lastLog >= 120 || s.stage !== (last && last.stage)) {
      log(`t ${s.t}s ${s.clock}h storm ${s.storm} ${s.stage} ${s.parts} at ${s.x},${s.z} core ${s.core} ${s.life} (${s.kit}) | ${s.doing} | bot: ${s.bot}`);
      lastLog = s.t;
    }
    // a picture at each beat of the story
    const beat = (key, cond) => {
      if (cond && !shotAt.has(key)) {
        shotAt.add(key);
        return true;
      }
      return false;
    };
    if (beat('part1', pt.found >= 1)) await shot('playthrough_01_first_part', { sheet: 'playthrough' });
    if (beat('cabin', pt.found >= 2)) await shot('playthrough_02_second_part', { sheet: 'playthrough' });
    if (beat('whiteout', pt.whiteoutNow)) await shot('playthrough_03_whiteout', { sheet: 'playthrough' });
    if (beat('hut', pt.hut)) await shot('playthrough_04_lake_hut', { sheet: 'playthrough' });
    if (beat('fifth', pt.found >= 5)) await shot('playthrough_05_all_parts', { sheet: 'playthrough' });
    if (beat('tower', pt.tower)) await shot('playthrough_06_tower', { sheet: 'playthrough' });
    if (beat('installed', pt.installed >= 5)) await shot('playthrough_07_installed', { sheet: 'playthrough' });
    if (beat('holdout', s.stage === 'holdout')) await shot('playthrough_08_holdout', { sheet: 'playthrough' });
    if (beat('rescue', s.stage === 'rescue')) await shot('playthrough_09_rescue', { sheet: 'playthrough' });
    if (s.life === 'dead') await ev(() => window.CS.game.actions.respawn());
    last = s;
    if (s.stage === 'won' || s.t > MAX_GAME_SECONDS) break;
  }
  await step(60, 1 / 30);
  await shot('playthrough_10_end', { sheet: 'playthrough' });

  // ---------------------------------------------------------------- verdict
  const r = await ev(() => {
    const PT = window.PT, CS = window.CS;
    const st = CS.sim.state;
    return {
      stage: st.objective.stage, t: Math.round(st.env.t), clock: st.env.clock, day: st.env.day, mode: CS.game.mode,
      parts: st.objective.parts, found: PT.found, installed: PT.installed, gives: PT.gives, deaths: PT.deaths, downs: PT.downs,
      revives: PT.revives, spells: PT.spells.map((x) => ({ t0: x.t0, dur: Math.round(x.dur), atFire: Math.round(x.atFire), minCore: Math.round(x.minCore * 10) / 10, died: x.died })), whiteout: Math.round(PT.whiteout), whiteoutAtFire: Math.round(PT.whiteoutAtFire), whiteoutMinCore: Math.round(PT.whiteoutMinCore * 10) / 10,
      onIce: Math.round(PT.onIce), hut: PT.hut, crossed: PT.crossed, tower: PT.tower, firesLit: PT.firesLit, events: PT.events,
      rescued: CS.sim.ctx.players().map((p) => `${p.name}:${p.life}`),
    };
  });
  const mins = Math.floor(r.t / 60), secs = r.t % 60;
  log(`RESULT ${r.stage} after ${mins} min ${secs} s of game time (day ${r.day + 1}, ${r.clock.toFixed(1)} h), mode ${r.mode}`);
  log(`parts found ${JSON.stringify(r.found)}; installed ${r.installed.join(', ')}`);
  log(`whiteout ${r.whiteout} s, by a lit fire ${r.whiteoutAtFire} s (coldest ${r.whiteoutMinCore}); on the ice ${r.onIce} s, hut ${r.hut}, back across ${r.crossed}; fires lit ${r.firesLit}`);
  log(`deaths ${r.deaths}, downs ${r.downs}, revives ${r.revives}; aboard ${r.rescued.join(', ')}`);
  check(r.stage === 'won', 'the helicopter took everyone (stage won), got ' + r.stage);
  check(r.mode === 'won', 'the ending screen is up, mode ' + r.mode);
  check(r.gives === 0, 'nothing was handed over by the tools (CS.give)');
  check(r.found.length === 5 && new Set(r.found.map((f) => f.part)).size === 5, 'all five parts found where they lie');
  check(r.installed.length === 5, 'all five parts installed');
  check(r.whiteout >= 60, 'a whiteout came (' + r.whiteout + ' s)');
  log('whiteout spells ' + JSON.stringify(r.spells));
  const satOut = r.spells.filter((x) => x.dur >= 60 && x.atFire >= 0.7 * x.dur && !x.died);
  check(satOut.length > 0, 'a whiteout was sat out by a lit fire (' + satOut.length + ' of ' + r.spells.length + ' spells, at least 70 % of it by the fire)');
  check(r.hut && r.crossed, 'the lake was crossed to the hut and back');
  check(r.tower, 'the tower was reached');
}
