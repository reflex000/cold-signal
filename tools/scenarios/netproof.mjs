// The network path under lag: the whole game over a wire that serialises every message and delays it
// 120 ms each way with 30 ms of jitter, with three companion bots (four players) and, for a while,
// sixteen wolves hunting them. Every beat is checked on the CLIENT (the View, the bus), not the host:
// walking (prediction against the host, command by command), a wolf attack, a revive, chopping, laying
// and lighting a fire, the ice breaking, installing a part. Measures the snapshot size per tick (the
// JSON the host sends) and the prediction error.
//   node tools/play.mjs tools/scenarios/netproof.mjs [--backend webgl]
export const query = 'wire=json&lag=120&jitter=30&bots=3';
const USE = 32;

export default async function ({ ev, step, shot, log, check }) {
  // ---------------------------------------------------------------- hooks: snapshot bytes, prediction
  const hooked = await ev(() => {
    const CS = window.CS, g = CS.game, s = CS.session;
    if (!g.lb || !s) return false;
    const NP = (window.NP = { bytes: [], phase: '', byPhase: {}, err: { max: 0, sum: 0, n: 0 }, events: [], pred: new Map() });
    const send = g.lb.host.send.bind(g.lb.host);
    g.lb.host.send = (m) => {
      if (m && m.t === 'snap') {
        const n = JSON.stringify(m).length;
        (NP.byPhase[NP.phase] ??= []).push(n);
      }
      send(m);
    };
    const sendInput = s.sendInput.bind(s);
    s.sendInput = (cmd) => {
      sendInput(cmd);
      const p = s.predicted;
      if (p) NP.pred.set(s.seq, { x: p.x, y: p.y, z: p.z });
      if (NP.pred.size > 600) NP.pred.delete(NP.pred.keys().next().value);
    };
    CS.view.bus.on('sim', (e) => NP.events.push({ ...e, at: CS.view.time }));
    NP.since = (from, t) => NP.events.slice(from).filter((e) => e.t === t);
    NP.me = () => CS.view.me; // the client's (predicted) player
    NP.host = () => CS.sim.ctx.get(CS.view.myId);
    NP.measure = () => {
      if (NP.phase !== 'walk') return;
      const h = NP.host();
      if (!h) return; // not joined yet
      const p = NP.pred.get(h.seq);
      if (p && h.life === "alive" && !h.swim) {
        const d = Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z);
        NP.err.max = Math.max(NP.err.max, d);
        NP.err.sum += d;
        NP.err.n++;
      }
    };
    const orig = g.stepFrame.bind(g);
    g.stepFrame = (dt, render) => {
      orig(dt, render);
      NP.measure();
    };
    NP.lookAt = (x, y, z) => {
      const me = CS.view.me;
      const eye = me.y + 1.66;
      const yaw = (Math.atan2(-(x - me.x), -(z - me.z)) * 180) / Math.PI;
      const pitch = (Math.atan2(y - eye, Math.hypot(x - me.x, z - me.z)) * 180) / Math.PI;
      CS.look(yaw, pitch);
    };
    return true;
  });
  check(hooked, 'hooked the json wire and the session');
  await step(30);
  check(await ev(() => !!window.CS.view.me && window.CS.game.botsDoing && Object.keys(window.CS.game.botsDoing()).length === 3), 'joined over the lagged wire with three companions');
  const mark = () => ev(() => window.NP.events.length);
  const since = (from, t) => ev(({ from, t }) => window.NP.since(from, t), { from, t });
  const phase = (p) => ev((p) => (window.NP.phase = p), p);
  const stepUntil = async (cond, seconds, arg) => {
    for (let t = 0; t < seconds; t += 0.5) {
      await step(15);
      if (await ev(cond, arg)) return true;
    }
    return false;
  };
  await ev(() => window.CS.env({ storm: 0.3, clock: 13, lock: true }));

  // ---------------------------------------------------------------- 1. walking: prediction vs host
  await phase('walk');
  for (const [yaw, b, frames] of [[0, 0, 90], [80, 1, 90], [170, 0, 60], [250, 4, 6], [250, 0, 80]]) {
    await ev(({ yaw, b }) => {
      window.CS.look(yaw, -5);
      window.CS.input({ mz: 1, b });
    }, { yaw, b });
    await step(frames);
  }
  await ev(() => window.CS.input(null));
  await step(45);
  const walk = await ev(() => {
    const e = window.NP.err, me = window.NP.me(), h = window.NP.host();
    return { max: e.max, mean: e.sum / Math.max(1, e.n), n: e.n, rest: Math.hypot(me.x - h.x, me.z - h.z) };
  });
  log(`walking: prediction error over ${walk.n} commands max ${walk.max.toFixed(4)} m, mean ${walk.mean.toFixed(5)} m; client vs host at rest ${walk.rest.toFixed(4)} m`);
  check(walk.n > 300 && walk.max < 0.1, 'the client predicts the host to within 10 cm');
  check(walk.rest < 0.02, 'client and host agree at rest');
  await shot('netproof_01_walk');

  // ---------------------------------------------------------------- 2. sixteen wolves on four players
  await phase('wolves');
  let m0 = await mark();
  await ev(() => {
    const CS = window.CS, me = CS.view.me;
    CS.env({ clock: 23, lock: true });
    for (const [dx, dz] of [[35, 0], [-35, 0], [0, 35], [0, -35]]) CS.act({ t: 'debug', cmd: 'wolves', args: [me.x + dx, me.z + dz, 4] });
  });
  await step(900); // 30 s with the packs about the group: the snapshot sizes
  const wolves = await ev(() => ({ client: window.CS.view.list('wolf').length, host: window.CS.sim.ctx.all('wolf').length, players: window.CS.view.list('player').length }));
  await phase('attack');
  // then a lone, hurt player: the packs are called to them and someone gets bitten
  await ev(() => {
    const CS = window.CS, me = CS.view.me;
    CS.go(me.x + 45, me.z + 10, 0, 0);
    CS.sim.ctx.get(CS.view.myId).health = 45;
  });
  await step(30);
  await ev(() => { const me = window.CS.view.me; window.CS.act({ t: 'debug', cmd: 'wolvesRally', args: [me.x, me.z] }); });
  const attacked = await stepUntil(() => window.NP.events.some((e) => e.t === 'bite' || (e.t === 'swing' && e.hit === 'wolf') || e.t === 'shot'), 150);
  const bites = await since(m0, 'bite');
  const hurts = (await since(m0, 'hurt')).filter((e) => e.cause === 'wolf');
  log(`wolves: ${wolves.client} on the client (${wolves.host} on the host), ${wolves.players} players; bites ${bites.length}, wolf hurts ${hurts.length}`);
  check(wolves.client === 16 && wolves.players === 4, 'the client sees sixteen wolves and four players');
  check(attacked, 'the pack attacked and the group fought back (events on the client)');
  if (hurts.length > 0) {
    // the bitten player's health on the client follows the host's
    const sync = await ev(() => {
      const CS = window.CS;
      let worst = 0;
      for (const v of CS.view.list('player')) {
        const h = CS.sim.ctx.get(v.id);
        if (h) worst = Math.max(worst, Math.abs(h.health - v.health));
      }
      return worst;
    });
    check(sync < 20, `health on the client follows the host (largest gap ${sync.toFixed(1)}, a few ticks of lag)`);
  }
  await shot('netproof_02_wolves');
  const sizes = await ev(() => {
    const b = window.NP.byPhase.wolves.slice().sort((a, c) => a - c);
    const avg = b.reduce((a, c) => a + c, 0) / b.length;
    return { n: b.length, avg, p95: b[Math.floor(b.length * 0.95)], max: b[b.length - 1] };
  });
  log(`snapshot size, 4 players + 16 wolves: avg ${(sizes.avg / 1024).toFixed(2)} KB, p95 ${(sizes.p95 / 1024).toFixed(2)} KB, max ${(sizes.max / 1024).toFixed(2)} KB over ${sizes.n} snapshots`);
  check(sizes.avg < 8 * 1024, 'snapshots average under 8 KB');
  await ev(() => window.CS.act({ t: 'debug', cmd: 'wolvesClear' }));
  await ev(() => window.CS.env({ clock: 13, lock: true }));
  await step(60);
  // if the pack got the player down, the companions get them up (their revive rule)
  const upAgain = await stepUntil(() => window.CS.view.me.life === 'alive', 40);
  check(upAgain, 'on our feet after the attack');

  // ---------------------------------------------------------------- 3. a revive
  await phase('revive');
  m0 = await mark();
  const botId = await ev(() => {
    const CS = window.CS;
    const ids = Object.keys(CS.game.botsDoing()).filter((k) => k !== 'auto').map(Number);
    const b = CS.sim.ctx.get(ids[0]);
    for (const id of ids) CS.game.host.botAct(id, { t: 'debug', cmd: 'tp', args: [b.x + (id === ids[0] ? 0 : 30), b.z + 30] });
    // knocked down by the cold (host side, by the tool), with nothing in the pack to patch it up
    b.inv.bandage = 0;
    b.inv.thermos = 0;
    b.health = 0;
    b.core = 29.9;
    const me = CS.view.me;
    CS.go(b.x + 2.5, b.z, 90, -30);
    return ids[0];
  });
  check(await stepUntil((id) => window.CS.view.ents.get(id)?.life === 'downed', 5, botId), 'the client sees the companion go down');
  // kneel by them and hold USE on them (the focus picker takes what the crosshair is on)
  await ev((id) => {
    const v = window.CS.view.ents.get(id);
    window.CS.go(v.x + 1.1, v.z, 90, -40);
    window.NP.lookAt(v.x, v.y + 0.3, v.z);
    window.CS.input({ b: 32 });
  }, botId);
  const up = await stepUntil((id) => window.CS.view.ents.get(id)?.life === 'alive', 12, botId);
  await ev(() => window.CS.input(null));
  const revived = await since(m0, 'revived');
  check(up && revived.some((e) => e.id === botId), 'revived: the event and the companion on its feet, on the client');
  await shot('netproof_03_revive');

  // ---------------------------------------------------------------- 4. chopping
  await phase('chop');
  m0 = await mark();
  const wood = await ev(() => {
    const CS = window.CS, me = CS.view.me;
    const h = CS.sim.ctx.get(CS.view.myId);
    h.health = 100; // whatever the wolves left
    h.stamina = 1;
    CS.give('axe', 1);
    let best = null, bd = Infinity;
    for (const w of CS.view.list('wood')) {
      if (w.type !== 'stump' && w.type !== 'branchpile') continue;
      const d = Math.hypot(w.x - me.x, w.z - me.z);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    if (!best) return null;
    CS.go(best.x + 1.3, best.z, 90, -35);
    return { id: best.id, x: best.x, y: best.y, z: best.z };
  });
  check(!!wood, 'dead wood to chop');
  if (wood) {
    await step(10);
    await ev((w) => {
      window.NP.lookAt(w.x, w.y + 0.5, w.z);
      window.CS.input({ b: 32 });
    }, wood);
    const gone = await stepUntil((id) => !window.CS.view.ents.has(id), 25, wood.id);
    await ev(() => window.CS.input(null));
    await stepUntil((w) => window.CS.view.list('pickup').some((p) => Math.hypot(p.x - w.x, p.z - w.z) < 3.5), 3, wood);
    const chopped = await since(m0, 'chopped');
    const swings = (await since(m0, 'swing')).filter((e) => e.hit === 'wood');
    const yields = await ev((w) => window.CS.view.list('pickup').filter((p) => Math.hypot(p.x - w.x, p.z - w.z) < 3.5 && (p.item === 'stick' || p.item === 'log' || p.item === 'tinder')).length, wood);
    log(`chopping: ${swings.length} blows, chopped ${chopped.length}, gone on the client ${gone}, ${yields} pickups beside it`);
    check(gone && chopped.length === 1 && yields > 0, 'chopped: blows, the wood gone and its sticks lying there, on the client');
  }
  await shot('netproof_04_chop');

  // ---------------------------------------------------------------- 5. lay and light a fire
  await phase('fire');
  m0 = await mark();
  await ev(() => {
    const CS = window.CS;
    CS.give('stick', 3);
    CS.give('tinder', 1);
    CS.look(0, -30);
    CS.act({ t: 'buildFire' });
  });
  const built = await stepUntil((from) => window.NP.since(from, 'fireBuilt').length > 0, 5, m0);
  const fireId = await ev((from) => (window.NP.since(from, 'fireBuilt')[0] || {}).id, m0);
  check(built && !!fireId, 'the campfire laid (fireBuilt on the client)');
  if (fireId) {
    await ev((id) => window.CS.act({ t: 'ignite', fire: id }), fireId);
    const lit = await stepUntil((id) => window.CS.view.ents.get(id)?.lit === true, 6, fireId);
    check(lit && (await since(m0, 'fireLit')).length > 0, 'lit: the event and the fire burning in the client view');
    await step(60);
    await ev((id) => {
      const f = window.CS.view.ents.get(id);
      window.NP.lookAt(f.x, f.y + 0.3, f.z);
    }, fireId);
    await step(4);
    await shot('netproof_05_fire');
  }

  // ---------------------------------------------------------------- 6. the ice breaks
  await phase('ice');
  m0 = await mark();
  const thin = await ev(() => {
    const w = window.CS.world, hut = w.poi('hut');
    let best = null, bd = Infinity;
    for (const t of w.thinIce) {
      const d = Math.hypot(t.x - hut.x, t.z - hut.z);
      if (t.r < 20 && d < bd && w.iceAt(t.x, t.z) > 0) {
        bd = d;
        best = t;
      }
    }
    return best;
  });
  check(!!thin, 'a thin patch on the lake');
  if (thin) {
    await ev((t) => window.CS.go(t.x + 6, t.z, 90, -10), thin);
    await ev(() => window.CS.input({ mz: 1 }));
    const wet = await stepUntil(() => window.CS.view.me.swim === true, 30);
    await ev(() => window.CS.input(null));
    const breaks = await since(m0, 'iceBreak');
    const hole = await ev(() => [...window.CS.view.ice.values()].some((c) => c.hole));
    check(wet && breaks.length > 0 && hole, 'the ice broke: the event, the player swimming and the hole in the client view');
    await step(20);
    await shot('netproof_06_ice');
    // out again: back the way we came, holding USE
    for (let k = 0; k < 30; k++) {
      if (!(await ev(() => window.CS.view.me.swim))) break;
      await ev(() => window.CS.input({ mz: -1, b: 32 }));
      await step(15);
    }
    await ev(() => window.CS.input(null));
  }

  // ---------------------------------------------------------------- 7. install a part
  await phase('install');
  m0 = await mark();
  const panel = await ev(() => {
    const CS = window.CS;
    CS.give('part_fuse', 1);
    const p = CS.view.list('device').find((d) => d.type === 'panel');
    const door = CS.world.anchors['tower:shed.door'];
    // stand inside the shed between the door and the panel
    CS.go(p.x + (door.x - p.x) * 0.45, p.z + (door.z - p.z) * 0.45, 0, 0);
    return { id: p.id, x: p.x, y: p.y, z: p.z };
  });
  await step(10);
  await ev((p) => {
    window.NP.lookAt(p.x, p.y + 0.05, p.z);
    window.CS.input({ b: 32 });
  }, panel);
  const installed = await stepUntil(() => window.CS.view.objective.parts.fuse === 'installed', 8);
  await ev(() => window.CS.input(null));
  check(installed && (await since(m0, 'partInstalled')).some((e) => e.part === 'fuse'), 'installed: the event and the panel state on the client');
  await shot('netproof_07_install');

  const all = await ev(() => {
    const all = Object.values(window.NP.byPhase).flat();
    return { n: all.length, avg: all.reduce((a, c) => a + c, 0) / all.length, err: window.NP.err };
  });
  log(`all snapshots: ${all.n}, avg ${(all.avg / 1024).toFixed(2)} KB`);
}
