// Survive: the survival loop played for real in the game, through the same input path a player uses.
// Walk into a whiteout and get cold, gather sticks, lay a fire and fail to light it in the wind,
// light it, warm up, feed it, rest (a checkpoint), chop deadfall with the axe, carry a heavy log with a
// companion, go down from the cold, get revived by the companion, open a crate, eat. A shot at every
// beat; the HUD must show it (temperature and stage, the effect chips, the focus prompt, toasts, the
// downed panel); the console must stay clean.
//   node tools/play.mjs tools/scenarios/survive.mjs [--backend webgl]
const USE = 32, PRIMARY = 8;

export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  // ---------------------------------------------------------------- page-side helpers
  await ev(() => {
    const CS = window.CS;
    const SV = (window.SV = {});
    SV.events = [];
    CS.view.bus.on('sim', (e) => SV.events.push(e));
    SV.mark = () => (SV.from = SV.events.length);
    SV.since = (t) => SV.events.slice(SV.from || 0).filter((e) => !t || e.t === t);
    SV.me = () => CS.sim.ctx.get(CS.view.myId); // the host's copy: exact numbers
    SV.round = (v, k = 2) => Math.round(v * 10 ** k) / 10 ** k;
    SV.body = () => {
      const p = SV.me();
      return {
        core: SV.round(p.core), feels: SV.round(p.feels, 1), trend: SV.round(p.trend), wet: SV.round(p.wet), fire: SV.round(p.fireHeat),
        shelter: SV.round(p.shelter), health: SV.round(p.health, 1), life: p.life, hunger: SV.round(p.hunger, 3), inv: { ...p.inv },
      };
    };
    SV.hud = () => {
      const q = (s) => document.querySelector(s);
      const chips = [...document.querySelectorAll('.tp-fx .fx')].map((e) => e.classList.contains('on'));
      const f = CS.view.hud.focus;
      return {
        temp: q('.tp-num span')?.textContent ?? '',
        stage: q('.tp-st')?.textContent ?? '',
        chips: { shelter: chips[0], fire: chips[1], huddle: chips[2], wet: chips[3], wind: chips[4] },
        focus: f ? `${f.verb} ${f.name}${f.note ? ' (' + f.note + ')' : ''}` : '',
        focusShown: !!q('.fc') && getComputedStyle(q('.fc')).opacity !== '0',
        toasts: [...document.querySelectorAll('.ts .to')].map((e) => e.textContent.trim()),
        down: !!q('.dw.on'),
        reviving: q('.rv.on') ? q('.rv')?.textContent.trim() : '',
        frost: SV.round(CS.view.hud.frost),
        hint: CS.view.hud.hint,
      };
    };
    SV.nearest = (kind, ok = () => true, from = SV.me()) => {
      let best = null, bd = Infinity;
      for (const e of CS.view.list(kind)) {
        if (!ok(e)) continue;
        const d = Math.hypot(e.x - from.x, e.z - from.z);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      return best;
    };
    /** Stand `dist` from (x, y, z) on level open ground, facing it; aim the eye at height y + h. */
    SV.standBy = (x, y, z, dist, h, prefer) => {
      const w = CS.world;
      let best = null, bs = -Infinity;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const sx = x + Math.sin(a) * dist, sz = z + Math.cos(a) * dist;
        if (!w.walkable(sx, sz)) continue;
        const gy = w.groundAt(sx, sz, y + 1).y;
        if (Math.abs(gy - y) > 0.7) continue;
        if (!w.lineClear(sx, gy + 1.6, sz, x, y + h, z)) continue;
        const score = prefer ? -Math.hypot(sx - prefer.x, sz - prefer.z) : -k;
        if (score > bs) {
          bs = score;
          best = { sx, sz };
        }
      }
      if (!best) return null;
      const yaw = (Math.atan2(-(x - best.sx), -(z - best.sz)) * 180) / Math.PI;
      CS.go(best.sx, best.sz, yaw, 0);
      const c = CS.view.camera;
      const me = SV.me();
      const eye = me.y + 1.66;
      const pitch = (Math.atan2(y + h - eye, Math.hypot(x - best.sx, z - best.sz)) * 180) / Math.PI;
      CS.look(yaw, pitch);
      return { ...best, yaw, pitch, cam: c.y };
    };
    SV.bot = 0;
    SV.botSeq = 1;
    SV.botInput = (o) => CS.game.host.setBotInput(SV.bot, { seq: SV.botSeq++, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, focus: 0, ...o });
    SV.botTo = (x, z) => CS.game.host.botAct(SV.bot, { t: 'debug', cmd: 'tp', args: [x, z] });
  });

  const body = () => ev(() => window.SV.body());
  const hud = () => ev(() => window.SV.hud());
  const mark = () => ev(() => window.SV.mark());
  const since = (t) => ev((t) => window.SV.since(t), t);
  const press = async (b, frames = 1) => {
    await ev((b) => window.CS.input({ b }), b);
    await step(frames);
    await ev(() => window.CS.input(null));
    await step(1);
  };
  /** Step in chunks until cond() (evaluated in the page) holds; returns seconds stepped. */
  const stepUntil = async (cond, maxSeconds, chunk = 60) => {
    let t = 0;
    while (t < maxSeconds) {
      await step(chunk);
      t += chunk / 30;
      if (await ev(cond)) return t;
    }
    return Infinity;
  };

  const start = await body();
  log('start', start);
  check(start.life === 'alive' && start.core === 37, 'a healthy survivor at the wreck');
  const barrel = await ev(() => {
    const b = window.CS.view.list('fire').find((f) => f.type === 'barrel');
    return b ? { lit: b.lit, d: window.SV.round(Math.hypot(b.x - window.SV.me().x, b.z - window.SV.me().z), 1), heat: b.heat } : null;
  });
  log('barrel', barrel);
  check(barrel && barrel.lit, 'the barrel at the wreck is burning when you crawl out');

  // ---------------------------------------------------------------- 1. into the storm
  // a whiteout at dusk, walking out over open ground away from the barrel
  await ev(() => window.CS.env({ storm: 1, clock: 17.5, lock: true }));
  const out = await ev(() => {
    const CS = window.CS, w = CS.world, me = window.SV.me();
    const b = CS.view.list('fire').find((f) => f.type === 'barrel');
    // a walkable open spot 40-60 m from the wreck, away from the barrel, with room to walk on
    for (let r = 45; r < 120; r += 5) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = me.x + Math.sin(a) * r, z = me.z + Math.cos(a) * r;
        if (!w.walkable(x, z) || w.forestAt(x, z) > 0.15 || w.slopeAt(x, z) > 0.18) continue;
        let room = true;
        for (let s = 2; s <= 12 && room; s += 2) room = w.walkable(x + Math.sin(a) * s, z + Math.cos(a) * s);
        if (room && (!b || Math.hypot(x - b.x, z - b.z) > 30)) return { x, z, yaw: (-a * 180) / Math.PI + 180 };
      }
    }
    return null;
  });
  check(!!out, 'found open ground out in the storm');
  await ev((o) => window.CS.go(o.x, o.z, o.yaw, 0), out);
  // walk in a slow circle (so the body keeps working), looking about
  let walked = 0;
  for (let i = 0; i < 120; i++) {
    await ev((i) => {
      window.CS.look((i * 18) % 360, 0);
      window.CS.input({ mz: 1 });
    }, i);
    await step(90);
    walked += 3;
    const b = await body();
    if (b.core <= 34.4) break;
  }
  await ev(() => window.CS.input(null));
  await step(5);
  let b = await body();
  let h = await hud();
  log(`after ${walked} s in the whiteout`, b, 'hud', { temp: h.temp, stage: h.stage, frost: h.frost, chips: h.chips, hint: h.hint });
  check(b.core < 35 && b.trend < -0.5, `cold and cooling fast in the whiteout (${b.core}, ${b.trend}/min)`);
  check(walked >= 150 && walked <= 330, `37 to 34.4 took ${walked} s, the design pace (37 to 33 in 4-5 min)`);
  check(h.stage === 'Cold' || h.stage === 'Freezing', `the HUD stage reads "${h.stage}"`);
  check(Math.abs(parseFloat(h.temp) - b.core) < 0.15, `the HUD temperature ${h.temp} matches the body`);
  check(h.chips.wind && b.feels < -25, `the wind chip is on, feels ${b.feels}`);
  check(h.frost > 0, 'frost creeps over the screen edges');
  await shot('survive_01_whiteout');

  // ---------------------------------------------------------------- 2. sticks
  await ev(() => window.CS.env({ storm: 0.55, lock: true }));
  let gathered = 0;
  for (let k = 0; k < 4 && gathered < 3; k++) {
    const t = await ev(() => {
      const SV = window.SV;
      const pk = SV.nearest('pickup', (e) => e.item === 'stick' && e.lie !== 'shelf');
      if (!pk) return null;
      const s = SV.standBy(pk.x, pk.y, pk.z, 1.3, 0.1);
      return s ? { id: pk.id, n: pk.n, d: Math.hypot(pk.x - SV.me().x, pk.z - SV.me().z) } : { id: pk.id, n: pk.n, fail: true };
    });
    if (!t || t.fail) {
      if (t) await ev((id) => window.CS.sim.ctx.remove(id), t.id); // unreachable: forget it
      continue;
    }
    await step(4);
    h = await hud();
    if (k === 0) {
      check(h.focus.startsWith('Take Dry sticks'), `the focus offers "${h.focus}"`);
      await shot('survive_02_stick');
    }
    const n0 = (await body()).inv.stick ?? 0;
    await press(USE);
    await step(6); // the client shows a removal ~100 ms later
    const n1 = (await body()).inv.stick ?? 0;
    gathered += n1 - n0;
    log(`stick pickup ${t.id}: +${n1 - n0}`);
  }
  check(gathered >= 2, `gathered ${gathered} sticks by hand`);
  await ev(() => {
    const p = window.SV.me();
    // three to lay the fire, three to feed it, three to keep it going while warming up (step 5)
    p.inv.stick = Math.max(p.inv.stick ?? 0, 9);
    delete p.inv.tinder;
  });

  // ---------------------------------------------------------------- 3. lay and light a fire in the wind
  // an exposed spot: the wind must have its say on an open fire
  await ev(() => window.CS.env({ storm: 0.8, lock: true }));
  const fireSpot = await ev((o) => {
    const CS = window.CS, w = CS.world, me = window.SV.me(), env = CS.view.env;
    let best = null, bs = 1;
    for (const c of [me, o]) for (let r = 0; r < 150; r += 3) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = c.x + Math.sin(a) * r, z = c.z + Math.cos(a) * r;
        if (!w.walkable(x, z) || w.slopeAt(x, z) > 0.2) continue;
        let ok = true;
        for (let q = 0; q < 8 && ok; q++) ok = w.walkable(x + Math.sin(q * 0.785) * 3, z + Math.cos(q * 0.785) * 3);
        if (!ok) continue;
        const sh = w.shelterAt(x, w.heightAt(x, z) + 0.5, z, env.windX, env.windZ).amount;
        if (sh < bs) {
          bs = sh;
          best = { x, z, shelter: Math.round(sh * 100) / 100 };
        }
        if (sh < 0.08) return best;
      }
    }
    return best;
  }, out);
  log('fire spot', fireSpot);
  check(!!fireSpot && fireSpot.shelter < 0.2, 'found an open, exposed spot for a fire');
  // stand just south of it, facing north: B lays the fire 1.1 m in front
  await ev((s) => window.CS.go(s.x, s.z + 1.1, 0, -20), fireSpot);
  await mark();
  await ev(() => window.CS.act({ t: 'buildFire' }));
  await step(3);
  const built = await since('fireBuilt');
  check(built.length === 1, 'B lays a campfire from three sticks');
  const fid = built.length ? built[0].id : 0;
  const lay = await ev((fid) => {
    const f = window.CS.sim.ctx.get(fid);
    return f ? { shelter: Math.round(f.shelter * 100) / 100, size: Math.round(f.size * 100) / 100 } : null;
  }, fid);
  log('the lay', lay);
  // look at it and strike matches with E until it catches (the wind should beat the first ones)
  await ev((fid) => {
    const f = window.CS.sim.ctx.get(fid);
    window.SV.standBy(f.x, f.y, f.z, 1.3, 0.3, window.SV.me());
  }, fid);
  await step(4);
  h = await hud();
  check(h.focus.startsWith('Light Campfire'), `the focus offers "${h.focus}"`);
  let fails = [], lit = false, failShot = false;
  for (let k = 0; k < 10 && !lit; k++) {
    await mark();
    await press(USE);
    await step(2);
    const evs = await since();
    for (const e of evs) {
      if (e.t === 'igniteFail') fails.push(e.why);
      if (e.t === 'fireLit') lit = true;
    }
    if (fails.length >= 1 && !failShot) {
      failShot = true;
      h = await hud();
      log('after a failed match: toasts', h.toasts);
      check(h.toasts.some((t) => t.includes('wind took the match')), 'the HUD says the wind took the match');
      await shot('survive_03_match_fails');
    }
    await step(40);
  }
  if (!lit) {
    // tinder makes it near certain
    await ev(() => (window.SV.me().inv.tinder = 2));
    for (let k = 0; k < 3 && !lit; k++) {
      await mark();
      await press(USE);
      await step(2);
      lit = (await since('fireLit')).length > 0;
      await step(40);
    }
  }
  log('ignite failures', fails, 'lit', lit, 'matches left', (await body()).inv.matches);
  check(fails.length >= 1 && fails.every((w) => w === 'wind'), `the wind failed ${fails.length} match(es) on the open fire`);
  check(lit, 'the fire caught in the end');

  // ---------------------------------------------------------------- 4. feed it
  await step(6);
  h = await hud();
  check(h.focus.startsWith('Feed fire'), `the focus offers "${h.focus}"`);
  await mark();
  const s0 = (await body()).inv.stick ?? 0;
  for (let k = 0; k < 3; k++) {
    await press(USE);
    await step(4);
  }
  const fed = await since('fireFed');
  check(fed.length === 3 && fed.every((e) => e.item === 'stick') && ((await body()).inv.stick ?? 0) === s0 - 3, 'E feeds the fire, a stick at a time');
  await shot('survive_04_fed');

  // ---------------------------------------------------------------- 5. warm up and rest (a checkpoint)
  await ev(() => window.CS.env({ storm: 0.45, lock: true }));
  await ev(() => (window.SV.me().core = Math.min(window.SV.me().core, 33.5)));
  await ev((fid) => {
    const f = window.CS.sim.ctx.get(fid);
    const env = window.CS.view.env;
    const wl = Math.hypot(env.windX, env.windZ) || 1;
    // across the wind from the fire, 1.4 m
    const sx = f.x - (env.windZ / wl) * 1.4, sz = f.z + (env.windX / wl) * 1.4;
    window.SV.standBy(f.x, f.y, f.z, 1.4, 0.3, { x: sx, z: sz });
  }, fid);
  await step(30 * 30); // the fire is still taking hold: half a minute in
  b = await body();
  h = await hud();
  const fireNow = await ev((fid) => { const f = window.CS.sim.ctx.get(fid); return { heat: window.SV.round(f.heat), fuel: Math.round(f.fuel), shelter: window.SV.round(f.shelter) }; }, fid);
  log('by the fire', b, { chips: h.chips, stage: h.stage, temp: h.temp }, 'fire', fireNow);
  check(b.fire > 0.3 && b.trend > 0.8, `the fire warms (fireHeat ${b.fire}, ${b.trend}/min)`);
  check(h.chips.fire, 'the HUD fire chip is on');
  await shot('survive_05_warming');
  await mark();
  // warm until 36.9; resting warm by the fire also makes a checkpoint on the way (read its toast then).
  // A good fire is kept fed: E on it whenever it burns low (under a minute of fuel, where the feed line
  // comes), as a player keeps it. (Laid from three sticks and fed three, it alone lasts about as long
  // as the warming takes in this wind: whether it outlasts it was down to the spot the search finds.)
  let warmT = 30, cpSeen = false, fedWarm = 0, wentOut = false;
  for (let i = 0; i < 480 && (!cpSeen || b.core < 36.9); i++) {
    await step(15);
    if (b.core < 36.9) warmT += 0.5;
    b = await body();
    const fl = await ev((fid) => {
      const f = window.CS.sim.ctx.get(fid);
      return { lit: f.lit, fuel: f.fuel };
    }, fid);
    if (!fl.lit && b.core < 36.9) wentOut = true;
    if (fl.lit && fl.fuel < 60 && b.core < 36.9 && (b.inv.stick ?? 0) > 0) {
      await press(USE);
      fedWarm++;
    }
    if (!cpSeen && (await since('checkpoint')).length > 0) {
      cpSeen = true;
      h = await hud();
      log('checkpoint at core', b.core, 'toasts', h.toasts);
      check(h.toasts.some((t) => t.includes('Progress saved')), 'the HUD says progress saved');
      await shot('survive_05b_rested');
    }
  }
  const fedOnWay = (await since('fireFed')).filter((e) => e.id === fid && e.item === 'stick').length;
  log(`33.5 -> 36.9 by the fire (lit just before) ${b.core >= 36.9 ? 'in ' + warmT + ' s' : 'NOT reached in ' + warmT + ' s'}, ${fedWarm} stick(s) fed on the way`);
  check(!wentOut && fedOnWay === fedWarm, `the fire, fed with E as it burned low (${fedOnWay} sticks), kept burning until warm`);
  check(b.core >= 36.9 && warmT <= 170, 'warm again in about two minutes, the fire taking hold included');
  check(cpSeen, 'resting warm at the fire makes a checkpoint');


  // ---------------------------------------------------------------- 6. the axe on deadfall
  await ev(() => {
    window.CS.give('axe', 1);
  });
  await step(2);
  await ev(() => window.CS.equip('axe'));
  await step(2);
  const df = await ev(() => {
    const SV = window.SV, CS = window.CS;
    const cands = CS.view.list('wood').filter((w) => w.type === 'deadfall').sort((a, b) => Math.hypot(a.x - SV.me().x, a.z - SV.me().z) - Math.hypot(b.x - SV.me().x, b.z - SV.me().z));
    for (const w of cands.slice(0, 12)) {
      // beside its middle, off the axis (cos yaw, -sin yaw)
      for (const side of [1, -1]) {
        const sx = w.x + Math.sin(w.yaw) * 1.3 * side, sz = w.z + Math.cos(w.yaw) * 1.3 * side;
        if (!CS.world.walkable(sx, sz) || Math.abs(CS.world.groundAt(sx, sz, w.y + 1).y - w.y) > 0.6) continue;
        const yaw = (Math.atan2(-(w.x - sx), -(w.z - sz)) * 180) / Math.PI;
        CS.go(sx, sz, yaw, 0);
        const eye = SV.me().y + 1.66;
        CS.look(yaw, (Math.atan2(w.y + 0.6 - eye, 1.3) * 180) / Math.PI);
        return { id: w.id, hp: w.hp, scale: w.scale, d: Math.round(Math.hypot(w.x - sx, w.z - sz) * 10) / 10 };
      }
    }
    return null;
  });
  check(!!df, 'found deadfall to chop');
  await step(4);
  h = await hud();
  check(h.focus.startsWith('Chop Deadfall'), `the focus offers "${h.focus}"`);
  await mark();
  await ev(() => window.CS.input({ b: 8 }));
  await step(Math.round(0.8 * 30 * 2.5));
  await shot('survive_06_chopping');
  await step(Math.round(0.8 * 30 * (df.hp + 1)));
  await ev(() => window.CS.input(null));
  await step(5);
  const swings = await since('swing');
  const chopped = await since('chopped');
  log(`deadfall hp ${df.hp}: ${swings.length} swings, ${swings.filter((s) => s.hit === 'wood').length} on wood, chopped ${chopped.length}`);
  check(chopped.length === 1 && chopped[0].id === df.id, 'the deadfall is chopped through');
  const logsDown = await ev((id) => {
    const me = window.SV.me();
    return window.CS.view.list('pickup').filter((e) => e.item === 'log' && Math.hypot(e.x - me.x, e.z - me.z) < 4).map((e) => ({ id: e.id, n: e.n, x: e.x, y: e.y, z: e.z }));
  }, df.id);
  check(logsDown.length === 1 && logsDown[0].n >= 2, `split logs on the snow (${logsDown.map((l) => l.n).join(', ')})`);
  if (logsDown.length) {
    await ev((l) => window.SV.standBy(l.x, l.y, l.z, 1.2, 0.1, window.SV.me()), logsDown[0]);
    await step(4);
    await press(USE);
    check(((await body()).inv.log ?? 0) >= 2, 'took the split logs');
  }
  await shot('survive_06b_chopped');

  // ---------------------------------------------------------------- 7. a heavy log with a companion
  await ev(() => window.CS.equip('hands'));
  const carry = await ev(() => {
    const SV = window.SV, CS = window.CS, w = CS.world;
    SV.bot = CS.game.host.addBot('Mara').id;
    const logs = CS.view.list('log').slice().sort((a, b) => Math.hypot(a.x - SV.me().x, a.z - SV.me().z) - Math.hypot(b.x - SV.me().x, b.z - SV.me().z));
    for (const l of logs.slice(0, 8)) {
      const ux = Math.sin(l.yaw), uz = Math.cos(l.yaw), h = l.len / 2;
      // walk the way with more open ground: a-end first (dir +u) or b-end first (dir -u)
      for (const dir of [1, -1]) {
        let ok = true;
        for (let s = 0; s <= 10 && ok; s += 1) {
          for (const off of [h + 0.9, -h - 0.9]) ok = ok && w.walkable(l.x + ux * (off + s * dir), l.z + uz * (off + s * dir));
        }
        if (!ok) continue;
        const ax = l.x + ux * (h + 0.7), az = l.z + uz * (h + 0.7);
        const bx = l.x - ux * (h + 0.7), bz = l.z - uz * (h + 0.7);
        return { id: l.id, len: l.len, yaw: l.yaw, ax, az, bx, bz, dir, x: l.x, y: l.y, z: l.z };
      }
    }
    return null;
  });
  check(!!carry, 'found a heavy log with room to carry it');
  // the player at the front end (a), the companion at the back (b)
  await ev((c) => {
    const CS = window.CS, SV = window.SV;
    const yawToLog = (Math.atan2(-(c.x - c.ax), -(c.z - c.az)) * 180) / Math.PI;
    CS.go(c.ax, c.az, yawToLog, -25);
    SV.botTo(c.bx, c.bz);
    SV.botInput({ yaw: Math.atan2(-(c.x - c.bx), -(c.z - c.bz)) });
  }, carry);
  await step(3);
  await ev((c) => {
    const SV = window.SV;
    const eye = SV.me().y + 1.66;
    const yaw = (Math.atan2(-(c.x - SV.me().x), -(c.z - SV.me().z)) * 180) / Math.PI;
    window.CS.look(yaw, (Math.atan2(c.y + 0.25 - eye, Math.hypot(c.x - SV.me().x, c.z - SV.me().z)) * 180) / Math.PI);
  }, carry);
  await step(4);
  h = await hud();
  check(h.focus.startsWith('Lift Heavy log'), `the focus offers "${h.focus}"`);
  await mark();
  await press(USE);
  await ev((id) => window.CS.game.host.botAct(window.SV.bot, { t: 'carry', log: id }), carry.id);
  await step(2);
  const pair = await ev((id) => {
    const l = window.CS.sim.ctx.get(id), me = window.SV.me(), bot = window.CS.sim.ctx.get(window.SV.bot);
    return { a: l.a, b: l.b, me: me.id, bot: bot.id, pair: me.carryPair && bot.carryPair };
  }, carry.id);
  check(pair.pair && pair.a === pair.me && pair.b === pair.bot, 'both ends taken: carried between two');
  // both walk the same way along the log
  const walkDir = await ev((c) => {
    const fx = Math.sin(c.yaw) * c.dir, fz = Math.cos(c.yaw) * c.dir;
    return Math.atan2(-fx, -fz);
  }, carry);
  const pos = () => ev(() => ({ x: window.SV.me().x, z: window.SV.me().z }));
  await ev((yaw) => {
    window.CS.look((yaw * 180) / Math.PI, -8);
    window.CS.input({ mz: 1 });
    window.SV.botInput({ yaw, mz: 1 });
  }, walkDir);
  await step(30); // up to pace
  const p0 = await pos();
  await step(40);
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' }))); // a look in third person
  await step(35);
  await shot('survive_07_carry_pair');
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' })));
  const p1 = await pos();
  const carried = await ev((id) => {
    const l = window.CS.sim.ctx.get(id), me = window.SV.me(), bot = window.CS.sim.ctx.get(window.SV.bot);
    return { mid: window.SV.round(Math.hypot(l.x - (me.x + bot.x) / 2, l.z - (me.z + bot.z) / 2), 3), apart: window.SV.round(Math.hypot(me.x - bot.x, me.z - bot.z)), len: window.SV.round(l.len), held: l.a !== 0 && l.b !== 0 };
  }, carry.id);
  // the companion lets go: the player drags it on alone along the same line
  await ev(() => {
    window.CS.game.host.botAct(window.SV.bot, { t: 'release' });
    window.SV.botInput({});
  });
  await step(30);
  const p2 = await pos();
  await step(60);
  const p3 = await pos();
  const pairSpeed = Math.hypot(p1.x - p0.x, p1.z - p0.z) / (75 / 30);
  const dragSpeed = Math.hypot(p3.x - p2.x, p3.z - p2.z) / 2;
  log(`carried by two at ${pairSpeed.toFixed(2)} m/s, dragged alone at ${dragSpeed.toFixed(2)} m/s`, carried);
  check(carried.held && pairSpeed > dragSpeed * 1.6, 'two carry it at a walk; one alone only drags it');
  check(carried.mid < 0.05, 'the log stays between its carriers');
  await ev(() => window.CS.input(null));
  await mark();
  await ev(() => window.CS.act({ t: 'release' }));
  // The host lets go at once. The drop is an event about the log, not the player, so the client shows
  // it with the log as drawn: INTERP_DELAY (net/client.ts, 0.1 s) behind, 3 or 4 frames.
  let dropFrames = 0;
  while (dropFrames < 6 && (await since('logDrop')).length === 0) {
    await step(1);
    dropFrames++;
  }
  const down = await ev((id) => {
    const l = window.CS.sim.ctx.get(id);
    return { a: l.a, b: l.b, host: window.SV.me().carry, client: window.CS.view.me.carry };
  }, carry.id);
  log(`put down: the drop on the client after ${dropFrames} frames`, down);
  check((await since('logDrop')).length === 1 && down.a === 0 && down.b === 0 && down.host === 0 && down.client === 0, 'put down: nobody holds the log, on the host and on the client');

  // ---------------------------------------------------------------- 8. down from the cold
  // the companion waits by the fire; the player goes out alone into a whiteout at night
  await ev((fid) => {
    const f = window.CS.sim.ctx.get(fid);
    window.SV.botTo(f.x + 1.3, f.z);
    if (f) {
      window.CS.sim.ctx.setV('fire.wood.' + fid, 1200);
      // the three sticks fed in step 4 can burn down during the chopping and the carry (by seconds either
      // way, with the cold's pace): the companion keeps the fire going while the player is out
      if (!f.lit) {
        f.lit = true;
        f.embers = 0;
        f.heat = Math.max(f.heat, 0.5);
      }
    }
  }, fid);
  await ev(() => window.CS.env({ storm: 1, clock: 1.5, lock: true }));
  await ev((o) => window.CS.go(o.x, o.z, o.yaw, 0), out);
  await ev(() => window.CS.input({ mz: 0.6 }));
  let shotFreezing = false;
  let downT = Infinity;
  for (let t = 0; t < 900; t += 3) {
    await ev((t) => window.CS.look((t * 7) % 360, -5), t);
    await step(90);
    b = await body();
    if (!shotFreezing && b.core <= 32.2) {
      shotFreezing = true;
      h = await hud();
      log('freezing', b, { stage: h.stage, frost: h.frost, temp: h.temp });
      check(h.stage === 'Freezing' || h.stage === 'Severe', `the HUD stage reads "${h.stage}"`);
      check(h.frost > 0.6, `heavy frost on the screen (${h.frost})`);
      await shot('survive_08_freezing');
    }
    if (b.life === 'downed') {
      downT = t + 3;
      break;
    }
  }
  await ev(() => window.CS.input(null));
  await step(20);
  b = await body();
  h = await hud();
  log(`down after ${downT} s`, b, { down: h.down });
  check(b.life === 'downed', 'the cold took the player down');
  check(h.down, 'the HUD shows the downed panel');
  const hurtCold = (await ev(() => window.SV.events.filter((e) => e.t === 'hurt' && e.cause === 'cold' && e.id === window.CS.view.myId).length)) > 0;
  check(hurtCold, 'the cold drained health on the way down (hurt, cause cold)');
  await shot('survive_09_downed');

  // ---------------------------------------------------------------- 9. revived by the companion
  await ev(() => {
    const me = window.SV.me(), SV = window.SV;
    SV.botTo(me.x + 1.0, me.z);
  });
  await step(2);
  await ev(() => {
    const me = window.SV.me(), bot = window.CS.sim.ctx.get(window.SV.bot);
    window.SV.botInput({ yaw: Math.atan2(-(me.x - bot.x), -(me.z - bot.z)), b: 32, focus: me.id });
  });
  await mark();
  await step(75);
  h = await hud();
  b = await body();
  log('being revived', { revive: (await ev(() => window.SV.me().revive)), reviving: h.reviving });
  check(h.reviving.includes('Mara'), `the HUD says "${h.reviving}"`);
  await shot('survive_10_revive');
  await step(90);
  await ev(() => window.SV.botInput({}));
  await step(5);
  const rev = await since('revived');
  b = await body();
  log('revived', b);
  check(rev.length === 1 && rev[0].by === (await ev(() => window.SV.bot)), 'the companion got the player up');
  check(b.life === 'alive' && b.health === 30 && b.core >= 31.9, `back up with health ${b.health} and a little warmth (${b.core})`);

  // ---------------------------------------------------------------- 10. a crate, and food
  await ev(() => window.CS.env({ storm: 0.3, clock: 17, lock: true }));
  const crate = await ev(() => {
    const SV = window.SV, CS = window.CS;
    const wreck = CS.world.poi('wreck');
    const list = CS.view.list('crate').filter((c) => !c.open).sort((a, b) => Math.hypot(a.x - wreck.x, a.z - wreck.z) - Math.hypot(b.x - wreck.x, b.z - wreck.z));
    for (const c of list.slice(0, 10)) {
      const s = SV.standBy(c.x, c.y, c.z, 1.35, 0.35);
      if (s) return { id: c.id, type: c.type, loot: c.loot };
    }
    return null;
  });
  check(!!crate, 'found a closed crate');
  await step(4);
  h = await hud();
  check(/^Open /.test(h.focus), `the focus offers "${h.focus}"`);
  await mark();
  await ev(() => window.CS.input({ b: 32 }));
  await step(8);
  h = await hud();
  await step(20);
  await ev(() => window.CS.input(null));
  await step(3);
  const opened = await since('open');
  const got = await since('pickup');
  h = await hud();
  log('crate', crate.type, crate.loot, '->', got.map((g) => `${g.item} ${g.n}`), 'toasts', h.toasts);
  check(opened.length === 1 && opened[0].id === crate.id, 'a short hold of E opens the crate');
  check(got.length === crate.loot.length, 'its loot is in the pack');
  await shot('survive_11_crate');
  await ev(() => {
    const p = window.SV.me();
    p.hunger = Math.max(p.hunger, 0.6);
    if (!(p.inv.ration > 0)) window.CS.give('ration', 1);
  });
  const r0 = (await body()).inv.ration;
  await ev(() => window.CS.act({ t: 'consume', item: 'ration' }));
  await step(10);
  b = await body();
  check(b.hunger < 0.01 && (b.inv.ration ?? 0) === r0 - 1, `ate a ration (hunger ${b.hunger})`);
  await ev(() => window.CS.mode('inventory'));
  await step(45); // past the fade and the place card
  await shot('survive_12_pack');
  await ev(() => window.CS.mode('play'));
  await step(5);
  const stats = await ev(() => window.CS.view.stats);
  log('stats', stats);
  check(stats.firesLit >= 1 && stats.downs >= 1 && stats.revives >= 1, 'the run is in the stats');
}
