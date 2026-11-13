// Endgame: the way off the mountain played in the real game, through the same input path a player uses.
// The radio parts are handed over (CS.give); out on the lake the ice creaks, warns and breaks, the player
// goes in and climbs out; at the tower the parts go into the panel, a companion bot and the player crank
// the generator, the call goes out; the hold-out in the worst of the storm by a fire on the deck; a flare
// onto the deck when the rotors come; the winch; the ending screen. A shot at every beat, a clean console.
// The tower, the hole in the ice and the helicopter are stand-ins until STRUCTURES / FX draw them.
//   node tools/play.mjs tools/scenarios/endgame.mjs [--backend webgl]
const USE = 32, PRIMARY = 8;

export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  // ---------------------------------------------------------------- page-side helpers
  await ev(() => {
    const CS = window.CS;
    const EG = (window.EG = {});
    EG.events = [];
    CS.view.bus.on('sim', (e) => EG.events.push(e));
    EG.mark = () => (EG.from = EG.events.length);
    EG.since = (t) => EG.events.slice(EG.from || 0).filter((e) => !t || e.t === t);
    EG.all = (t) => EG.events.filter((e) => e.t === t);
    EG.me = () => CS.sim.ctx.get(CS.view.myId); // the host's copy: exact numbers
    EG.o = () => CS.sim.state.objective;
    EG.r = (v, k = 2) => Math.round(v * 10 ** k) / 10 ** k;
    EG.dev = (type) => CS.sim.ctx.all('device').find((d) => d.type === type);
    EG.anchor = (k) => CS.world.anchors[k];
    EG.hud = () => {
      const f = CS.view.hud.focus;
      return {
        objective: (document.querySelector('.ob')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        line: CS.view.hud.objective,
        focus: f ? `${f.verb} ${f.name}${f.note ? ' (' + f.note + ')' : ''}${f.hold !== null && f.hold !== undefined ? ' ' + Math.round(f.hold * 100) + '%' : ''}` : '',
        toasts: [...document.querySelectorAll('.ts .to')].map((e) => e.textContent.trim()),
        hint: CS.view.hud.hint,
      };
    };
    EG.body = () => {
      const p = EG.me();
      return { core: EG.r(p.core), wet: EG.r(p.wet), health: EG.r(p.health, 1), life: p.life, swim: p.swim, act: p.act, x: EG.r(p.x, 1), y: EG.r(p.y, 2), z: EG.r(p.z, 1) };
    };
    /** Look from the player's eye at a point (degrees, the game's yaw: 0 north, counter-clockwise). */
    EG.lookAt = (x, y, z) => {
      const p = EG.me();
      const eye = p.y + (p.swim ? 1.46 : 1.66);
      const yaw = (Math.atan2(-(x - p.x), -(z - p.z)) * 180) / Math.PI;
      const pitch = (Math.atan2(y - eye, Math.hypot(x - p.x, z - p.z)) * 180) / Math.PI;
      CS.look(yaw, pitch);
      return { yaw, pitch };
    };
    EG.bot = 0;
    EG.botSeq = 1;
    EG.botInput = (o) => CS.game.host.setBotInput(EG.bot, { seq: EG.botSeq++, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, focus: 0, ...o });
    EG.botTo = (x, z) => CS.game.host.botAct(EG.bot, { t: 'debug', cmd: 'tp', args: [x, z] });
    EG.botP = () => CS.sim.ctx.get(EG.bot);
  });
  const hud = () => ev(() => window.EG.hud());
  const body = () => ev(() => window.EG.body());
  const mark = () => ev(() => window.EG.mark());
  const since = (t) => ev((t) => window.EG.since(t), t);
  const o = () => ev(() => ({ ...window.EG.o(), parts: { ...window.EG.o().parts } }));
  /** Step in chunks until cond() (evaluated in the page) holds; returns seconds stepped (Infinity on timeout). */
  const stepUntil = async (cond, maxSeconds, chunk = 30, arg) => {
    let t = 0;
    while (t < maxSeconds) {
      await step(chunk);
      t += chunk / 30;
      if (await ev(cond, arg)) return t;
    }
    return Infinity;
  };

  // ---------------------------------------------------------------- 1. the crash
  let h = await hud();
  log('start', await body(), h.line);
  check((await o()).stage === 'crash', 'the run opens at the crash');
  await ev(() => window.CS.env({ storm: 0.4, clock: 16.6, lock: true }));
  await step(20);
  await shot('endgame_01_crash');

  // ---------------------------------------------------------------- 2. the radio and the five parts
  await mark();
  await ev(() => {
    const CS = window.CS;
    CS.give('radio', 1);
    for (const p of ['battery', 'handset', 'coil', 'tube', 'fuse']) CS.give('part_' + p, 1);
  });
  await step(20);
  const found = await since('partFound');
  check(found.length === 5, `all five parts found (${found.map((e) => e.part).join(', ')})`);
  check((await since('stage')).map((e) => e.stage).join() === 'search,tower', 'crash -> search -> tower');
  h = await hud();
  log('objective', h.line);
  check(/signal tower/.test(h.line), `the HUD sends you to the tower: "${h.line}"`);
  await shot('endgame_02_parts');

  // ---------------------------------------------------------------- 3. on the lake: the poles, a thin patch
  await ev(() => window.CS.env({ storm: 0.25, clock: 12.5, lock: true }));
  const lake = await ev(() => {
    const w = window.CS.world;
    // the thin patch nearest the hut (south of it, off the safe line)
    const hut = w.poi('hut');
    let best = null, bd = Infinity;
    for (const t of w.thinIce) {
      const d = Math.hypot(t.x - hut.x, t.z - hut.z);
      if (t.r < 20 && d < bd && w.iceAt(t.x, t.z) > 0) {
        bd = d;
        best = t;
      }
    }
    return { thin: best, safe: w.safeLine, hut: { x: hut.x, z: hut.z }, level: w.lake.level };
  });
  log('lake', lake);
  check(!!lake.thin, 'found a thin patch near the hut');
  // along the safe line toward the hut: the poles
  await ev((L) => {
    const s = L.safe, u = 0.55;
    const x = s.ax + (s.bx - s.ax) * u, z = s.az + (s.bz - s.az) * u;
    const yaw = (Math.atan2(-(s.bx - s.ax), -(s.bz - s.az)) * 180) / Math.PI;
    window.CS.go(x, z, yaw, -4);
  }, lake);
  await step(20);
  h = await hud();
  log('on the poles', await body(), 'hint', h.hint);
  await shot('endgame_03_poles');
  // walk from sound ice straight into the patch, from the hut's side
  const start = await ev((L) => {
    const t = L.thin, w = window.CS.world;
    let dx = L.hut.x - t.x, dz = L.hut.z - t.z;
    const d = Math.hypot(dx, dz);
    dx /= d;
    dz /= d;
    for (let r = t.r + 10; r < t.r + 30; r += 2) {
      const x = t.x + dx * r, z = t.z + dz * r;
      if (w.iceAt(x, z) >= 0.25) return { x, z, yaw: (Math.atan2(dx, dz) * 180) / Math.PI, h: w.iceAt(x, z) };
    }
    return null;
  }, lake);
  log('walk in from', start);
  check(!!start, 'sound ice to start from');
  await ev((s) => window.CS.go(s.x, s.z, s.yaw, -6), start);
  await step(10);
  await mark();
  await ev(() => window.CS.input({ mz: 1 }));
  let creakShot = false, broke = false;
  for (let k = 0; k < 120 && !broke; k++) {
    await step(5);
    const evs = await since();
    if (!creakShot && evs.some((e) => e.t === 'iceCreak')) {
      creakShot = true;
      const where = await body();
      h = await hud();
      log('first creak at', where, 'toasts', h.toasts);
      check(h.toasts.some((t) => /groans/.test(t)), 'the first creak warns: "The ice groans under you..."');
      await shot('endgame_04_creak');
    }
    broke = evs.some((e) => e.t === 'splash');
  }
  await ev(() => window.CS.input(null));
  await step(6); // events without a player id, and the ice, are presented ~0.1 s behind
  const creaks = (await since('iceCreak')).map((e) => e.stress);
  log('creaks', creaks.length, creaks.map((s) => Math.round(s * 100) / 100).join(' '));
  check(creaks.length >= 3, 'the ice creaked as the stress grew');
  check((await since('iceBreak')).length === 1, 'it broke with a crack (iceBreak)');
  let b = await body();
  log('in the water', b);
  check(b.swim && b.wet === 1, 'through the ice: in the water and soaked at once');
  const hole = await ev(() => {
    const CS = window.CS, me = window.EG.me(), L = CS.world.lake;
    const i = CS.sim.state.vars['ice.in.' + me.id];
    const cell = CS.view.ice.get(i);
    const cx = i % L.n, cz = Math.floor(i / L.n);
    return { i, open: !!(cell && cell.hole), x0: L.minX + cx * L.cell, z0: L.minZ + cz * L.cell, size: L.cell };
  });
  check(hole.open, `the client sees the hole (cell ${hole.i})`);
  await step(20);
  h = await hud();
  log('in the water, hint:', h.hint);
  check(/edge of the hole/.test(h.hint), 'the hint says how to get out');
  await shot('endgame_05_in_the_water');
  // swim to the nearest edge and hold USE to climb out
  const c0 = (await body()).core;
  await ev((H) => {
    const me = window.EG.me();
    const sides = [
      { d: me.x - H.x0, x: H.x0 - 1, z: me.z },
      { d: H.x0 + H.size - me.x, x: H.x0 + H.size + 1, z: me.z },
      { d: me.z - H.z0, x: me.x, z: H.z0 - 1 },
      { d: H.z0 + H.size - me.z, x: me.x, z: H.z0 + H.size + 1 },
    ].sort((a, b) => a.d - b.d);
    window.EG.lookAt(sides[0].x, window.CS.world.lake.level, sides[0].z);
    window.CS.input({ mz: 1 });
  }, hole);
  await step(75);
  await mark();
  await ev(() => window.CS.input({ b: 32 }));
  const climbed = await stepUntil(() => !window.EG.me().swim, 8, 10);
  await ev(() => window.CS.input(null));
  b = await body();
  log('climbed out after', climbed, 's:', b, 'core lost in the water', Math.round((c0 - b.core) * 100) / 100);
  check(climbed < 8 && !b.swim && b.life === 'alive', 'held USE at the edge and climbed out onto the ice');
  check(Math.abs(b.y - lake.level) < 0.05, 'standing on the ice again');
  await ev((H) => window.EG.lookAt(H.x0 + H.size / 2, window.CS.world.lake.level, H.z0 + H.size / 2), hole);
  await step(10);
  await shot('endgame_06_out');

  // ---------------------------------------------------------------- 4. the tower: a companion, the panel
  await ev(() => {
    const CS = window.CS;
    CS.env({ storm: -1, lock: false }); // the weather runs free again: the hold-out will force its worst
    CS.act({ t: 'debug', cmd: 'lockClock', args: [1] });
    CS.env({ clock: 15.6 });
    const me = window.EG.me();
    me.wet = 0.35; // (dried off on the way up; the climb is not part of this run)
    me.core = Math.max(me.core, 36.2);
    window.EG.bot = CS.game.host.addBot('Mara').id;
  });
  const T = await ev(() => {
    const A = window.EG.anchor;
    const f = (k) => ({ x: A(k).x, y: A(k).y, z: A(k).z, yaw: A(k).yaw });
    return { panel: f('tower:shed.panel'), stand: f('tower:shed.stand'), crank: f('tower:gen.crank'), gstand: f('tower:gen.stand'), deck: f('tower:mast.deck'), fire: f('tower:site.fire') };
  });
  log('tower', T);
  await mark();
  await ev((T) => {
    window.CS.go(T.stand.x, T.stand.z, 90, -30);
    window.EG.lookAt(T.panel.x, T.panel.y + 0.05, T.panel.z);
  }, T);
  await step(6);
  check((await since('stage')).some((e) => e.stage === 'power'), 'at the tower: the last stage begins (power)');
  h = await hud();
  log('at the panel', h.focus, '|', h.line);
  check(h.focus.startsWith('Install Transmitter'), `the focus offers "${h.focus}"`);
  await shot('endgame_07_panel');
  await mark();
  await ev(() => window.CS.input({ b: 32 }));
  await step(60);
  h = await hud();
  log('installing', h.focus);
  await shot('endgame_08_install');
  await stepUntil(() => window.EG.since('partInstalled').length >= 5, 20, 15);
  await ev(() => window.CS.input(null));
  const installed = (await since('partInstalled')).map((e) => e.part);
  check(installed.length === 5, `the five parts went in one by one (${installed.join(', ')})`);
  check(Object.values((await o()).parts).every((s) => s === 'installed'), 'every part installed');

  // ---------------------------------------------------------------- 5. the generator: the bot and the player crank
  const gen = await ev(() => window.EG.dev('generator').id);
  await ev(([T, gid]) => {
    const EG = window.EG;
    EG.botTo(T.gstand.x, T.gstand.z);
    EG.botInput({ yaw: Math.atan2(-(T.crank.x - T.gstand.x), -(T.crank.z - T.gstand.z)), b: 32, focus: gid });
    window.CS.go(T.gstand.x + 0.1, T.gstand.z + 1.1, 0, 0);
  }, [T, gen]);
  await step(3);
  await ev((T) => window.EG.lookAt(T.crank.x, T.crank.y + 0.05, T.crank.z), T);
  await step(3);
  h = await hud();
  log('at the crank', h.focus);
  check(h.focus.startsWith('Crank Generator'), `the focus offers "${h.focus}"`);
  await mark();
  await ev(() => window.CS.input({ b: 32 }));
  const tFull = await stepUntil(() => window.EG.o().generator >= 1, 40, 15);
  const crankers = await ev(() => [window.EG.me().act, window.EG.botP().act]);
  log('full charge after', tFull, 's, acts', crankers);
  check(tFull < 25, `two on the handles charge it in ${tFull} s`);
  check((await since('generator')).some((e) => e.on), 'the generator catches (generator on)');
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }))); // third person
  await step(4);
  await shot('endgame_09_crank');
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' })));
  await ev(() => window.CS.input(null));

  // a fire beside the deck for the hold-out, while the bot keeps the set powered
  await mark();
  await ev((T) => {
    const CS = window.CS;
    CS.give('stick', 6);
    CS.give('tinder', 2);
    CS.give('log', 4);
    CS.give('thermos', 2);
    CS.go(T.fire.x, T.fire.z + 1.1, 0, -20);
  }, T);
  await step(3);
  await ev(() => window.CS.act({ t: 'buildFire' }));
  await step(3);
  const fire = (await since('fireBuilt'))[0];
  check(!!fire, 'a campfire laid beside the deck');
  for (let k = 0; k < 4 && fire; k++) {
    await ev((id) => window.CS.act({ t: 'ignite', fire: id }), fire.id);
    await step(45);
    if ((await since('fireLit')).length) break;
  }
  check((await since('fireLit')).length > 0, 'the fire is lit');
  if (fire) {
    for (let k = 0; k < 3; k++) {
      await ev((id) => window.CS.act({ t: 'feed', fire: id, item: 'log' }), fire.id);
      await step(2);
    }
  }
  const tCall = await stepUntil(() => window.EG.o().stage === 'holdout', 90, 30);
  await step(6);
  log('the call is out after', tCall, 's more; transmit', (await o()).transmit);
  check((await since('transmit')).length === 1, 'the call went out (transmit)');
  check((await o()).stage === 'holdout' && Math.abs((await o()).eta - 180) < 5, 'the hold-out: the helicopter is 3 minutes out');
  await step(20);
  h = await hud();
  log('hold-out', h.line, h.toasts);
  await shot('endgame_10_call');

  // ---------------------------------------------------------------- 6. the hold-out by the fire on the deck
  await ev((T) => {
    const EG = window.EG;
    EG.botTo(T.fire.x + 1.3, T.fire.z + 0.4);
    EG.botInput({ yaw: Math.PI / 2 });
    window.CS.go(T.fire.x + 1.2, T.fire.z - 0.9, 90, -10);
  }, T);
  let shotStorm = false, shotRotors = false, flared = false;
  const bites = [];
  for (let k = 0; k < 70; k++) {
    await step(90);
    const s = await ev(() => {
      const EG = window.EG, me = EG.me(), CS = window.CS;
      const f = CS.sim.ctx.all('fire').filter((q) => q.type === 'campfire' && q.lit)[0];
      return { eta: EG.o().eta, stage: EG.o().stage, storm: CS.sim.state.env.storm, core: me.core, life: me.life, health: me.health, fire: f ? { id: f.id, fuel: f.fuel } : null, heli: CS.sim.ctx.all('heli').length };
    });
    for (const e of await since('bite')) bites.push(e);
    await mark();
    if (s.life !== 'alive') {
      log('the player is', s.life, 'at eta', s.eta);
      break;
    }
    if (s.core < 34) await ev(() => window.CS.act({ t: 'consume', item: 'thermos' }));
    if (s.fire && s.fire.fuel < 60) await ev((id) => window.CS.act({ t: 'feed', fire: id, item: 'log' }), s.fire.id);
    if (!shotStorm && s.eta < 130) {
      shotStorm = true;
      log('storm', s);
      check(s.storm > 0.95, `the worst of the storm (${Math.round(s.storm * 100) / 100})`);
      await shot('endgame_11_holdout');
    }
    if (!shotRotors && s.heli) {
      shotRotors = true;
      check((await ev(() => window.EG.all('heli').map((e) => e.phase))).includes('inbound'), 'the helicopter is inbound');
      await ev(() => {
        const h = window.CS.view.list('heli')[0];
        if (h) window.EG.lookAt(h.x, h.y, h.z);
      });
      await step(2);
      await shot('endgame_12_rotors');
    }
    // ---------------------------------------------------------------- 7. a flare onto the deck
    if (!flared && s.heli && s.eta < 45) {
      flared = true;
      await ev((T) => {
        const CS = window.CS;
        CS.give('flaregun', 1);
        CS.give('flare', 2);
        CS.equip('flaregun');
        CS.go(T.deck.x, T.deck.z, 180, -80);
      }, T);
      await step(4);
      await ev(() => window.CS.act({ t: 'reload' }));
      await step(50);
      await mark();
      await ev(() => window.CS.input({ b: 8 }));
      await step(1);
      await ev(() => window.CS.input(null));
      await stepUntil(() => window.EG.since('flareLand').length > 0, 6, 5);
      const land = (await since('flareLand'))[0];
      log('flare landed', land);
      await step(10);
      check((await o()).signalled, 'the flare on the deck marks the pickup (signalled)');
      await ev((T) => window.EG.lookAt(T.deck.x + 2, T.deck.y, T.deck.z + 2), T);
      await ev(() => window.CS.equip('hands'));
      await step(4);
      await shot('endgame_13_flare');
    }
    if (s.stage === 'rescue') break;
  }
  log('bites during the hold-out', bites.length);
  check((await o()).stage === 'rescue', 'the hold-out was survived: the helicopter is here');

  // ---------------------------------------------------------------- 8. the winch
  await ev((T) => {
    const EG = window.EG;
    EG.botTo(T.deck.x - 1.2, T.deck.z + 0.6);
    EG.botInput({ yaw: 0 });
    window.CS.go(T.deck.x + 0.6, T.deck.z - 0.4, 180, 0);
  }, T);
  const tHover = await stepUntil(() => {
    const h = window.CS.sim.ctx.all('heli')[0];
    return h && h.phase === 'winch';
  }, 120, 15);
  log('over the deck after', tHover, 's');
  await ev(() => {
    const h = window.CS.view.list('heli')[0];
    if (h) window.EG.lookAt(h.x, h.y, h.z);
  });
  await step(3);
  await shot('endgame_14_hover');
  const tHook = await stepUntil(() => window.EG.me().life === 'rescued', 60, 15);
  check(tHook < 60, 'the winch took the player');
  await step(75);
  b = await body();
  log('on the line', b);
  await shot('endgame_15_winch');
  const tWon = await stepUntil(() => window.EG.o().stage === 'won', 60, 30);
  check(tWon < 60, 'everyone aboard: won');
  const botLife = await ev(() => window.EG.botP().life);
  check(botLife === 'rescued', 'the companion on the deck went up after the player');
  await step(45);
  const mode = await ev(() => window.CS.game.mode);
  check(mode === 'won', `the game shows the ending (mode ${mode})`);
  const endText = await ev(() => (document.querySelector('.end')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160));
  log('ending', endText);
  check(/Rescued/.test(endText), 'the ending screen says Rescued');
  await step(120); // the card sets itself line by line
  await shot('endgame_16_end');

  const stages = await ev(() => window.EG.all('stage').map((e) => e.stage));
  log('stages', stages.join(' > '));
  check(stages.join() === 'search,tower,power,holdout,rescue,won', 'every stage in order');
}
