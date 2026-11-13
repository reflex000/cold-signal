// Snow: tracks in the real game. Walk, sprint and jump across fresh snow, look back down the trail
// at noon and at dusk; go down and get up (a body hollow); a companion drags a heavy log alone; a
// pack of wolves crosses the snow; then a storm fills the trail for three minutes (before / after).
//   node tools/play.mjs tools/scenarios/snow.mjs [--backend webgl] [--mobile 1] [--query "beats=walk,dusk"]
// beats: walk, dusk, deep, down, log, wolves, fill (default: all). Owner: SNOW.
const SPRINT = 1, JUMP = 4;

export default async function ({ ev, step, shot, log, check, args }) {
  const q = new URLSearchParams(args.query || '');
  const beats = new Set((q.get('beats') || 'walk,dusk,deep,down,log,wolves,fill').split(','));
  await step(10);
  await ev(() => {
    const CS = window.CS;
    const SN = (window.SN = {});
    SN.me = () => CS.sim.ctx.get(CS.view.myId);
    SN.snow = () => CS.engine.get('snow');
    /** The packed route trail 0..1 at (x, z) (world masks, A). */
    SN.packed = (x, z) => {
      const m = CS.world.masks;
      const i = Math.round(((x + m.extent) / (2 * m.extent)) * (m.n - 1)), j = Math.round(((z + m.extent) / (2 * m.extent)) * (m.n - 1));
      return m.data[(j * m.n + i) * 4 + 3] / 255;
    };
    /** Flat open snow of about `depth` m loose snow near (x, z), away from structures and trees (packed: on the route trail). */
    SN.find = (x0, z0, depth, maxR = 400, packed = false) => {
      const w = CS.world;
      let best = null, bs = -Infinity;
      for (let r = 25; r < maxR; r += 7) {
        for (let k = 0; k < 40; k++) {
          const a = (k / 40) * Math.PI * 2;
          const x = x0 + Math.sin(a) * r, z = z0 + Math.cos(a) * r;
          if (!w.walkable(x, z) || w.surfaceAt(x, z) === 'rock' || w.surfaceAt(x, z) === 'ice') continue;
          let flat = 0, open = true, pk = 0;
          // 14 m of flat walkable ground ahead along +x (the walk) with no trees close
          for (let s = -2; s <= 16 && open; s += 2) {
            open = w.walkable(x + s, z) && w.slopeAt(x + s, z) < 0.12 && w.collidersNear(x + s, z, 2.5).length === 0 && w.surfaceAt(x + s, z) !== 'rock';
            flat += w.slopeAt(x + s, z);
            pk += SN.packed(x + s, z) / 10;
          }
          if (!open) continue;
          const sd = w.snowDepthAt(x, z);
          const score = -Math.abs(sd - depth) * 4 - flat - r * 0.002 - w.forestAt(x, z) - (packed ? (1 - pk) * 3 : pk * 3);
          if (score > bs) {
            bs = score;
            best = { x, z, sd, score };
          }
        }
        if (best && bs > -0.25 && r > 60) break;
      }
      return best;
    };
    SN.lookAt = (x, y, z, fromX, fromZ) => {
      const me = SN.me();
      const fx = fromX ?? me.x, fz = fromZ ?? me.z;
      const yaw = (Math.atan2(-(x - fx), -(z - fz)) * 180) / Math.PI;
      const eye = me.y + 1.66;
      const pitch = (Math.atan2(y - eye, Math.hypot(x - fx, z - fz)) * 180) / Math.PI;
      CS.look(yaw, pitch);
    };
  });
  const walkFor = async (frames, b = 0) => {
    await ev((b) => window.CS.input({ mz: 1, b }), b);
    await step(frames);
    await ev(() => window.CS.input(null));
    await step(2);
  };
  const stats = () => ev(() => ({ ...window.SN.snow()?.stats, fill: window.SN.snow()?.fill }));
  const wreck = await ev(() => window.CS.world.poi('wreck'));

  let trail = null;
  if (beats.has('walk') || beats.has('dusk') || beats.has('fill')) {
    const spot = await ev((w) => window.SN.find(w.x, w.z, 0.22), wreck);
    check(!!spot, 'found open fresh snow near the wreck');
    log('walk spot', spot);
    await ev((s) => {
      window.CS.env({ storm: 0, clock: 12.2, lock: true });
      window.CS.go(s.x, s.z, -90, -10); // facing east (+x)
    }, spot);
    await step(30);
    await walkFor(120); // walk 4 s
    await walkFor(70, SPRINT); // sprint
    await ev(() => window.CS.input({ mz: 1, b: 1 | 4 }));
    await step(4);
    await ev(() => window.CS.input({ mz: 1, b: 1 }));
    await step(30);
    await ev(() => window.CS.input(null));
    await step(30);
    trail = await ev((s) => {
      const me = window.SN.me();
      return { x0: s.x, z0: s.z, x1: me.x, z1: me.z, y: me.y };
    }, spot);
    log('trail', trail, await stats());
    // stand beside the trail, a few metres on, and look back along it
    await ev((t) => {
      const CS = window.CS;
      CS.go(t.x1 + 1.2, t.z1 + 1.6, 0, 0);
    }, trail);
    await step(3);
    await ev((t) => window.SN.lookAt(t.x1 - 5, t.y, t.z1), trail);
    await step(4);
    if (beats.has('walk')) await shot('snow_noon_trail');
    await ev((t) => window.SN.lookAt(t.x1 - 1.8, t.y, t.z1 - 0.2), trail);
    await step(4);
    if (beats.has('walk')) await shot('snow_noon_close');
    if (beats.has('dusk')) {
      await ev(() => window.CS.env({ storm: 0, clock: 16.55, lock: true }));
      await step(12);
      await ev((t) => window.SN.lookAt(t.x1 - 5, t.y, t.z1), trail);
      await step(4);
      await shot('snow_dusk_trail');
      await ev(() => window.CS.env({ storm: 0, clock: 12.2, lock: true }));
      await step(12);
    }
  }

  if (beats.has('deep')) {
    const spot = await ev((w) => window.SN.find(w.x, w.z, 0.7, 500), wreck);
    log('deep spot', spot);
    if (spot) {
      await ev((s) => window.CS.go(s.x, s.z, -90, -10), spot);
      await step(10);
      await walkFor(150);
      const t = await ev((s) => ({ x0: s.x, z0: s.z, x1: window.SN.me().x, z1: window.SN.me().z, y: window.SN.me().y }), spot);
      await ev((t) => window.CS.go(t.x1 + 1.0, t.z1 + 1.4, 0, 0), t);
      await step(3);
      await ev((t) => window.SN.lookAt(t.x1 - 2.5, t.y, t.z1), t);
      await step(4);
      await shot('snow_deep_trail');
    }
  }

  if (beats.has('down')) {
    const spot = await ev((w) => window.SN.find(w.x + 40, w.z - 40, 0.3), wreck);
    await ev((s) => window.CS.go(s.x, s.z, -90, 0), spot);
    await step(10);
    await ev(() => {
      const me = window.SN.me();
      me.core = 29.6;
      me.health = 60;
    });
    let downed = false;
    for (let i = 0; i < 20 && !downed; i++) {
      await step(15);
      downed = await ev(() => window.SN.me().life === 'downed');
    }
    check(downed, 'the player went down');
    await step(60);
    const at = await ev(() => ({ x: window.SN.me().x, z: window.SN.me().z, y: window.SN.me().y, yaw: window.SN.me().yaw }));
    await ev(() => {
      const me = window.SN.me();
      me.life = 'alive';
      me.core = 37;
      me.health = 100;
      me.bleed = 0;
    });
    await step(10);
    await ev((a) => window.CS.go(a.x + 2.2, a.z + 2.4, 0, 0), at);
    await step(4);
    await ev((a) => window.SN.lookAt(a.x - Math.sin(a.yaw) * 0.0, a.y, a.z), at);
    await step(4);
    await shot('snow_downed');
  }

  if (beats.has('log')) {
    const res = await ev(() => {
      const CS = window.CS, SN = window.SN, w = CS.world;
      const me = SN.me();
      const logs = CS.view.list('log').slice().sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z));
      for (const l of logs) {
        if (w.surfaceAt(l.x, l.z) === 'rock') continue;
        const ux = Math.sin(l.yaw), uz = Math.cos(l.yaw), h = l.len / 2;
        let ok = true;
        for (let s = 1; s <= 12 && ok; s++) ok = w.walkable(l.x + ux * (h + s), l.z + uz * (h + s)) && w.collidersNear(l.x + ux * (h + s), l.z + uz * (h + s), 1.2).length === 0;
        if (!ok) continue;
        SN.bot = CS.game.host.addBot('Mara').id;
        const ax = l.x + ux * (h + 0.6), az = l.z + uz * (h + 0.6);
        CS.game.host.botAct(SN.bot, { t: 'debug', cmd: 'tp', args: [ax, az] });
        return { id: l.id, x: l.x, z: l.z, y: l.y, ux, uz, h, ax, az };
      }
      return null;
    });
    check(!!res, 'found a log with open ground ahead');
    if (res) {
      await step(4);
      await ev((r) => window.CS.game.host.botAct(window.SN.bot, { t: 'carry', log: r.id }), res);
      await step(3);
      const yaw = Math.atan2(-res.ux, -res.uz);
      let seq = 1;
      for (let i = 0; i < 12; i++) {
        await ev(([yaw, s]) => window.CS.game.host.setBotInput(window.SN.bot, { seq: s, mx: 0, mz: 1, yaw, pitch: 0, b: 0, focus: 0 }), [yaw, seq++]);
        await step(20);
      }
      await ev((s) => window.CS.game.host.setBotInput(window.SN.bot, { seq: s, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, focus: 0 }), seq++);
      await step(4);
      const end = await ev((id) => {
        const l = window.CS.sim.ctx.get(id);
        return { x: l.x, z: l.z, y: l.y, a: l.a, b: l.b };
      }, res.id);
      log('log dragged', res, end, await stats());
      check(end.a !== 0 || end.b !== 0, 'the companion holds the log');
      await ev(([r, e]) => {
        const CS = window.CS;
        CS.go(e.x - r.ux * 3 + r.uz * 2.2, e.z - r.uz * 3 - r.ux * 2.2, 0, 0);
      }, [res, end]);
      await step(3);
      await ev(([r, e]) => window.SN.lookAt(e.x - r.ux * 4.5, e.y, e.z - r.uz * 4.5), [res, end]);
      await step(4);
      await shot('snow_logdrag');
      await ev(() => window.CS.game.host.removeBot?.(window.SN.bot));
    }
  }

  if (beats.has('wolves')) {
    const spot = await ev((w) => window.SN.find(w.x - 60, w.z + 30, 0.3), wreck);
    await ev((s) => window.CS.go(s.x, s.z, -90, 0), spot);
    await step(10);
    await ev((s) => window.CS.act({ t: 'debug', cmd: 'wolves', args: [s.x + 25, s.z + 6, 4] }), spot);
    for (let i = 0; i < 10; i++) await step(60);
    await ev(() => window.CS.act({ t: 'debug', cmd: 'wolvesClear' }));
    await step(4);
    await ev((s) => window.SN.lookAt(s.x + 8, window.SN.me().y, s.z + 3), spot);
    await step(4);
    log('wolves', await stats());
    await shot('snow_wolves');
  }

  if (beats.has('fill') && trail) {
    await ev((t) => window.CS.go(t.x1 + 1.2, t.z1 + 1.6, 0, 0), trail);
    await step(3);
    await ev((t) => window.SN.lookAt(t.x1 - 5, t.y, t.z1), trail);
    await step(4);
    await shot('snow_fill_before');
    log('before', await stats());
    await ev(() => window.CS.env({ storm: 0.85, clock: 12.2, lock: true }));
    for (let i = 0; i < 30; i++) await step(180); // 3 minutes
    await ev(() => window.CS.env({ storm: 0.15, clock: 12.2, lock: true }));
    await step(60);
    await ev((t) => window.SN.lookAt(t.x1 - 5, t.y, t.z1), trail);
    await step(8);
    log('after', await stats());
    await shot('snow_fill_after');
  }
}
