// Hunt: the wolves and the tools in the real game, through the same paths players use. Night at the
// wreck: the companion stands by the barrel fire; the player is out in the open beyond its light. A pack
// wakes and howls, stalks the player at the edge of sight, circles, feints and charges, and leaves the
// one by the fire alone. The player's flare breaks the circle, a rifle shot scatters the pack, and an axe
// blow makes a charging wolf yelp. A shot at every beat; the console must stay clean. Wolves are drawn
// by whatever draws them (stand-in markers until the figures land): judge the behaviour, not the looks.
//   node tools/play.mjs tools/scenarios/hunt.mjs [--backend webgl]
const PRIMARY = 8;
// pack phases (src/sim/systems/wolves.ts PHASE)
const PH = { rest: 0, roam: 1, gather: 2, stalk: 3, circle: 4, attack: 5, scatter: 6, feed: 7 };

export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  // ---------------------------------------------------------------- page-side helpers
  await ev(() => {
    const CS = window.CS;
    const H = (window.H = {});
    H.events = [];
    CS.view.bus.on('sim', (e) => H.events.push(e));
    H.mark = () => (H.from = H.events.length);
    H.since = (t) => H.events.slice(H.from || 0).filter((e) => !t || e.t === t);
    H.me = () => CS.sim.ctx.get(CS.view.myId); // the host's copy: exact numbers
    H.wolves = () => CS.sim.ctx.all('wolf').filter((w) => w.mood !== 'dead');
    H.phase = (k) => CS.sim.state.vars['wolves.ph.' + k] ?? -1;
    H.target = (k) => CS.sim.state.vars['wolves.tg.' + k] ?? 0;
    H.r = (v, k = 1) => Math.round(v * 10 ** k) / 10 ** k;
    H.bot = 0;
    H.botSeq = 1;
    H.botInput = (o) => CS.game.host.setBotInput(H.bot, { seq: H.botSeq++, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, focus: 0, ...o });
    H.botAct = (a) => CS.game.host.botAct(H.bot, a);
    H.botEnt = () => CS.sim.ctx.get(H.bot);
    H.barrel = () => CS.sim.ctx.all('fire').find((f) => f.type === 'barrel');
    /** Look (degrees) from the local player's eye at a point. */
    H.lookAt = (x, y, z) => {
      const me = H.me();
      const dx = x - me.x, dy = y - (me.y + 1.66), dz = z - me.z;
      CS.look((Math.atan2(-dx, -dz) * 180) / Math.PI, (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI);
    };
    H.dists = (p) => H.wolves().map((w) => H.r(Math.hypot(w.x - p.x, w.z - p.z)));
    H.moods = () => H.wolves().map((w) => w.mood);
    H.nearestWolf = (p, ok = () => true) => {
      let best = null, bd = Infinity;
      for (const w of H.wolves()) {
        const d = Math.hypot(w.x - p.x, w.z - p.z);
        if (ok(w) && d < bd) {
          bd = d;
          best = w;
        }
      }
      return best;
    };
    /** Open, level, walkable ground r0..r1 m from (x, z) with room all round; `from` must see it. */
    H.open = (x, z, r0, r1, from) => {
      const w = CS.world;
      for (let r = r0; r <= r1; r += 3) {
        for (let k = 0; k < 32; k++) {
          const a = (k / 32) * Math.PI * 2;
          const sx = x + Math.sin(a) * r, sz = z + Math.cos(a) * r;
          if (!w.walkable(sx, sz) || w.forestAt(sx, sz) > 0.15 || w.slopeAt(sx, sz) > 0.12) continue;
          let room = true;
          for (let s = 0; s < 12 && room; s++) room = w.walkable(sx + Math.sin(s * 0.52) * 12, sz + Math.cos(s * 0.52) * 12) && w.slopeAt(sx + Math.sin(s * 0.52) * 12, sz + Math.cos(s * 0.52) * 12) < 0.2;
          if (!room) continue;
          if (from) {
            const gy = w.groundAt(sx, sz, w.heightAt(sx, sz) + 1).y;
            if (!w.lineClear(from.x, from.y + 1.7, from.z, sx, gy + 1.2, sz)) continue;
          }
          return { x: sx, z: sz, a };
        }
      }
      return null;
    };
  });
  const stepUntil = async (cond, maxSeconds, chunk = 15, arg) => {
    let t = 0;
    while (t < maxSeconds) {
      if (await ev(cond, arg)) return t;
      await step(chunk);
      t += chunk / 30;
    }
    return (await ev(cond, arg)) ? t : Infinity;
  };
  /** Look at something (page function returning {x, y, z}), let the frame catch up, take the shot. */
  const shotAt = async (name, where, arg) => {
    await ev(
      ([src, a]) => {
        const p = new Function('H', 'CS', 'a', 'return (' + src + ')(H, CS, a)')(window.H, window.CS, a);
        if (p) window.H.lookAt(p.x, p.y, p.z);
      },
      [where.toString(), arg],
    );
    await step(2);
    await shot(name);
  };

  // ---------------------------------------------------------------- the night, the fire, the two of them
  await ev(() => window.CS.env({ storm: 0.1, clock: 20.5, lock: true }));
  const set = await ev(() => {
    const CS = window.CS, H = window.H, w = CS.world;
    const b = H.barrel();
    if (!b) return null;
    const by = H.open(b.x, b.z, 2.5, 4, null) ?? { x: b.x + 2.5, z: b.z };
    const from = { x: by.x, y: w.groundAt(by.x, by.z, b.y + 1).y, z: by.z };
    // the player out in the open, in sight of the fire, well beyond its light
    const out = H.open(b.x, b.z, 40, 75, from);
    if (!out) return null;
    H.bot = CS.game.host.addBot('Mara').id;
    H.botAct({ t: 'debug', cmd: 'tp', args: [by.x, by.z] });
    CS.go(out.x, out.z, 0, 0);
    // the pack wakes on the far side of the player from the fire
    const a = Math.atan2(out.x - b.x, out.z - b.z);
    let den = null;
    for (let k = 0; k < 9 && !den; k++) {
      const aa = a + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI) / 9;
      for (let r = 110; r <= 150 && !den; r += 10) {
        const x = out.x + Math.sin(aa) * r, z = out.z + Math.cos(aa) * r;
        if (w.walkable(x, z)) den = { x, z };
      }
    }
    return { barrel: { x: b.x, y: b.y, z: b.z, lit: b.lit, heat: H.r(b.heat, 2) }, by, out, den, k: w.spawn.packs.length };
  });
  check(!!set && !!set.den, 'found the fire, an open spot for the player and a place for the pack');
  if (!set || !set.den) return;
  log('set', set);
  check(set.barrel.lit, 'the barrel at the wreck burns');
  const K = set.k;
  await step(3);
  await ev((o) => {
    const H = window.H, b = H.botEnt(), me = H.me();
    H.botInput({ yaw: Math.atan2(-(me.x - b.x), -(me.z - b.z)) }); // the companion watches the player
    H.lookAt(o.den.x, window.CS.world.heightAt(o.den.x, o.den.z) + 1, o.den.z);
  }, set);
  await step(5);

  // ---------------------------------------------------------------- 1. a pack wakes and howls
  await ev(() => window.H.mark());
  await ev((d) => window.CS.act({ t: 'debug', cmd: 'wolves', args: [d.x, d.z, 4] }), set.den);
  await step(20);
  const woke = await ev((k) => {
    const H = window.H;
    const howls = H.since('howl');
    return { wolves: H.wolves().length, alpha: H.wolves().filter((w) => w.alpha).length, howls: howls.length, pack: howls[0] ? howls[0].pack : -1, phase: H.phase(k) };
  }, K);
  log('woke', woke);
  check(woke.wolves === 4 && woke.alpha === 1, `a pack of ${woke.wolves} with one alpha`);
  check(woke.howls >= 1 && woke.pack === K, `it howls (${woke.howls} howls, pack ${woke.pack})`);
  await shotAt('hunt_01_howl', (H) => {
    const a = H.wolves().find((w) => w.alpha);
    return { x: a.x, y: a.y + 0.6, z: a.z };
  });

  // ---------------------------------------------------------------- 2. it stalks the player at the edge of sight
  const tStalk = await stepUntil((k) => window.H.phase(k) === 3, 60, 15, K);
  check(tStalk < 60, `from the howl to stalking (${tStalk} s)`);
  await step(14 * 30);
  const stalk = await ev((k) => {
    const H = window.H, me = H.me();
    return { phase: H.phase(k), target: H.target(k), me: me.id, bot: H.bot, toMe: H.dists(me), moods: H.moods() };
  }, K);
  log('stalk', stalk);
  check(stalk.target === stalk.me, 'the player out in the open is the one they hunt');
  check(stalk.phase !== PH.stalk || stalk.toMe.every((d) => d > 12), `they keep to the edge of sight (${stalk.toMe.join(', ')} m)`);
  await shotAt('hunt_02_stalk', (H) => {
    const w = H.nearestWolf(H.me());
    return { x: w.x, y: w.y + 0.5, z: w.z };
  });

  // ---------------------------------------------------------------- 3. it circles; the one by the fire is left alone
  const tCircle = await stepUntil((k) => window.H.phase(k) === 4, 90, 15, K);
  check(tCircle < 90, `the stalk closes into a circle (${tCircle} s)`);
  await step(8 * 30);
  const circ = await ev((k) => {
    const H = window.H, me = H.me(), f = H.barrel(), bot = H.botEnt();
    return { phase: H.phase(k), toMe: H.dists(me), toFire: H.dists(f), fearR: H.r(4 + 8 * f.heat), heat: H.r(f.heat, 2), moods: H.moods(), bot: H.r(bot.health) };
  }, K);
  log('circle', circ);
  check(circ.toMe.filter((d) => d >= 11 && d <= 34).length >= 3, `wolves round the player at 15-30 m (${circ.toMe.join(', ')} m)`);
  check(circ.toFire.every((d) => d > circ.fearR - 0.5), `none inside the fire's light (${circ.fearR} m; nearest ${Math.min(...circ.toFire)} m)`);
  await shotAt('hunt_03_circle', (H) => {
    const w = H.nearestWolf(H.me(), (x) => x.mood === 'circle') ?? H.nearestWolf(H.me());
    return { x: w.x, y: w.y + 0.5, z: w.z };
  });

  // ---------------------------------------------------------------- 4. the isolated one is charged
  await ev(() => window.H.mark());
  const tCharge = await stepUntil(() => window.H.wolves().some((w) => (w.mood === 'charge' && Math.hypot(w.x - window.H.me().x, w.z - window.H.me().z) < 10) || w.mood === 'bite'), 120, 2);
  check(tCharge < 120, `a wolf charges the player (${Math.round(tCharge)} s into the circle)`);
  const charge = await ev((k) => {
    const H = window.H, me = H.me(), bot = H.botEnt();
    const w = H.wolves().find((x) => x.mood === 'charge' || x.mood === 'bite');
    return { mood: w.mood, d: H.r(Math.hypot(w.x - me.x, w.z - me.z)), target: w.target, me: me.id, feints: H.since('bark').length + H.since('growl').length, bot: H.r(bot.health), botTargeted: H.target(k) === bot.id };
  }, K);
  log('charge', charge);
  check(charge.target === charge.me, 'the charge is at the isolated player');
  check(charge.bot === 100 && !charge.botTargeted, 'the companion by the fire is left alone');
  await shotAt('hunt_04_charge', (H) => {
    const w = H.wolves().find((x) => x.mood === 'charge' || x.mood === 'bite');
    return { x: w.x, y: w.y + 0.45, z: w.z };
  });
  await step(30);
  const bit = await ev(() => ({ bites: window.H.since('bite').length, health: window.H.r(window.H.me().health), life: window.H.me().life }));
  log('after the charge', bit);
  check(bit.life === 'alive', 'still on their feet');

  // ---------------------------------------------------------------- 5. a flare breaks the circle
  await stepUntil((k) => [4, 5].includes(window.H.phase(k)), 30, 5, K);
  await ev(() => {
    const CS = window.CS, H = window.H;
    CS.give('flaregun', 1);
    CS.give('flare', 1);
    CS.equip('flaregun');
    H.mark();
  });
  await step(2);
  await ev(() => window.CS.act({ t: 'reload' }));
  await step(45);
  const loaded = await ev(() => window.H.me().flareLoaded);
  check(loaded === 1, 'R loads the flare gun');
  // fired down at the snow a few metres off
  await ev(() => {
    const me = window.H.me();
    window.CS.look((me.yaw * 180) / Math.PI, -28);
  });
  await step(1);
  await ev((b) => window.CS.input({ b }), PRIMARY);
  await step(1);
  await ev(() => window.CS.input(null));
  const tLand = await stepUntil(() => window.H.since('flareLand').length > 0, 6, 1);
  const fl = await ev((k) => {
    const H = window.H, me = H.me();
    const f = window.CS.sim.ctx.all('flare')[0];
    return { shot: H.since('flareShot').length, land: H.since('flareLand').length, f: f ? { fromMe: H.r(Math.hypot(f.x - me.x, f.z - me.z)), life: H.r(f.life) } : null, phase: H.phase(k) };
  }, K);
  log('flare', { ...fl, tLand });
  check(fl.shot === 1 && fl.land === 1, 'the flare flies and lands');
  await step(20);
  const broke = await ev((k) => ({ phase: window.H.phase(k), moods: window.H.moods() }), K);
  log('flare broke', broke);
  check(broke.phase === PH.stalk || broke.phase === PH.scatter, `the circle breaks (pack phase ${broke.phase})`);
  await step(4 * 30);
  const held = await ev(() => {
    const H = window.H, f = window.CS.sim.ctx.all('flare')[0];
    return { toFlare: H.dists(f), life: H.r(f.life) };
  });
  log('held off', held);
  check(held.toFlare.every((d) => d > 14), `held off past the flare's light (${held.toFlare.join(', ')} m)`);
  await shotAt('hunt_05_flare', (H) => {
    const f = window.CS.sim.ctx.all('flare')[0];
    const w = H.nearestWolf(f);
    // between the flare and the wolf it keeps off
    return { x: (f.x + w.x) / 2, y: f.y + 0.4, z: (f.z + w.z) / 2 };
  });

  // ---------------------------------------------------------------- 6. a rifle shot scatters them
  await ev(() => {
    const CS = window.CS, H = window.H;
    CS.give('rifle', 1);
    H.me().loaded = 5;
    CS.equip('rifle');
  });
  await step(4);
  const before = await ev(() => {
    const H = window.H, me = H.me();
    const d = H.dists(me);
    const w = H.nearestWolf(me);
    H.lookAt(w.x, w.y + 25, w.z); // over their heads
    H.mark();
    return d.reduce((a, x) => a + x, 0) / d.length;
  });
  await step(1);
  await ev((b) => window.CS.input({ b }), PRIMARY);
  await step(1);
  await ev(() => window.CS.input(null));
  await step(3);
  const shotRes = await ev((k) => {
    const H = window.H;
    const s = H.since('shot')[0];
    return { shots: H.since('shot').length, hit: s ? s.hit : '', phase: H.phase(k), moods: H.moods(), loaded: H.me().loaded };
  }, K);
  log('shot', shotRes);
  check(shotRes.shots === 1 && shotRes.loaded === 4, 'one round fired');
  check(shotRes.phase === PH.scatter && shotRes.moods.every((m) => m === 'flee'), 'the pack scatters at the shot');
  await step(5 * 30);
  const after = await ev(() => {
    const H = window.H, d = H.dists(H.me());
    return d.reduce((a, x) => a + x, 0) / d.length;
  });
  log('spread', { before: Math.round(before), after: Math.round(after) });
  check(after > before + 20, `they run (${Math.round(before)} -> ${Math.round(after)} m away)`);
  await shotAt('hunt_06_scatter', (H) => {
    const w = H.nearestWolf(H.me());
    return { x: w.x, y: w.y + 0.5, z: w.z };
  });

  // ---------------------------------------------------------------- 7. an axe blow makes one yelp
  // out of the flare's light (no wolf comes into it), a lone wolf comes straight out of the dark
  const away = await ev(() => {
    const CS = window.CS, H = window.H, b = H.barrel();
    const f = CS.sim.ctx.all('flare')[0];
    for (let r = 30; r <= 70; r += 5) {
      const s = H.open(f.x, f.z, r, r, null);
      if (s && Math.hypot(s.x - b.x, s.z - b.z) > 30) {
        CS.go(s.x, s.z, (Math.atan2(s.x - f.x, s.z - f.z) * 180) / Math.PI + 180, 0); // facing away from the flare
        return { x: H.r(s.x), z: H.r(s.z), fromFlare: H.r(Math.hypot(s.x - f.x, s.z - f.z)) };
      }
    }
    return null;
  });
  log('away from the flare', away);
  check(!!away, 'an open spot out of the light');
  if (!away) return;
  await step(2);
  await ev(() => {
    const CS = window.CS, H = window.H, me = H.me();
    CS.give('axe', 1);
    CS.equip('axe');
    const yaw = me.yaw;
    const x = me.x - Math.sin(yaw) * 9, z = me.z - Math.cos(yaw) * 9;
    CS.look((yaw * 180) / Math.PI, -10);
    const w = CS.sim.ctx.spawn({
      kind: 'wolf', x, y: CS.world.groundAt(x, z, me.y + 1).y, z, yaw: yaw + Math.PI, pack: 99, alpha: true, mood: 'charge', moodT: 0,
      target: me.id, vx: 0, vz: 0, speed: 6, health: 80, fear: 0, hunger: 0.9, variant: 7,
    });
    H.axeWolf = w.id;
    H.mark();
  });
  await step(2);
  await ev((b) => window.CS.input({ b }), PRIMARY);
  const tYelp = await stepUntil(() => window.H.since('yelp').length > 0 || window.H.since('wolfDie').length > 0, 5, 1);
  const axeRes = await ev(() => {
    const H = window.H, w = window.CS.sim.ctx.get(H.axeWolf), me = H.me();
    return { yelp: H.since('yelp').length, swings: H.since('swing').map((s) => s.hit), wolf: w ? { health: w.health, mood: w.mood, d: H.r(Math.hypot(w.x - me.x, w.z - me.z)) } : null };
  });
  log('axe', axeRes);
  check(tYelp < 5 && axeRes.yelp >= 1, `the axe lands and the wolf yelps (${tYelp} s)`);
  check(axeRes.swings.includes('wolf'), `the blade hits the wolf (${axeRes.swings.join(', ')})`);
  check(!!axeRes.wolf && axeRes.wolf.health < 80, 'it is hurt');
  await ev(() => window.CS.input(null));
  await shotAt('hunt_07_axe', (H) => {
    const w = window.CS.sim.ctx.get(H.axeWolf);
    return w ? { x: w.x, y: w.y + 0.5, z: w.z } : null;
  });
  await step(40);
  await shotAt('hunt_08_away', (H) => {
    const w = window.CS.sim.ctx.get(H.axeWolf);
    return w ? { x: w.x, y: w.y + 0.5, z: w.z } : null;
  });
  const end = await ev(() => ({ health: window.H.r(window.H.me().health), life: window.H.me().life, bot: window.H.r(window.H.botEnt().health) }));
  log('end', end);
}
