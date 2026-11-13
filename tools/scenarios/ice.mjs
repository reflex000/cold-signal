// The lake ice drawn: a thin patch breaks under the player, the hole is open black water ringed by
// broken slabs; nobody swims in it and it skins over (the film greys the water), then it is new, dark,
// crazed ice. Checks that the view carries the skin and that the drawn cells follow it.
//   node tools/play.mjs tools/scenarios/ice.mjs [--backend webgl]
const USE = 32;

export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  await ev(() => window.CS.env({ storm: 0.2, clock: 12.5, lock: true }));
  const lake = await ev(() => {
    const w = window.CS.world;
    const hut = w.poi('hut');
    let best = null, bd = Infinity;
    for (const t of w.thinIce) {
      const d = Math.hypot(t.x - hut.x, t.z - hut.z);
      if (t.r < 20 && d < bd && w.iceAt(t.x, t.z) > 0) {
        bd = d;
        best = t;
      }
    }
    return { thin: best, level: w.lake.level };
  });
  check(!!lake.thin, 'a thin patch near the hut');
  // onto the thin ice, walk about until it gives
  await ev((t) => window.CS.go(t.x + 6, t.z, 90, -10), lake.thin);
  await ev(() => {
    window.ICE = { breaks: 0 };
    window.CS.view.bus.on('sim', (e) => {
      if (e.t === 'iceBreak') window.ICE.breaks++;
    });
  });
  let swim = false;
  for (let k = 0; k < 40 && !swim; k++) {
    await ev(() => window.CS.input({ mz: 1 }));
    await step(30);
    swim = await ev(() => window.CS.sim.ctx.get(window.CS.view.myId).swim);
  }
  await ev(() => window.CS.input(null));
  check(swim, 'the ice broke and the player went in');
  const hole = await ev(() => {
    const me = window.CS.sim.ctx.get(window.CS.view.myId);
    return { x: me.x, z: me.z };
  });
  // climb out: back the way we came, holding USE
  for (let k = 0; k < 30 && swim; k++) {
    await ev(() => window.CS.input({ mz: -1, b: 32 }));
    await step(15);
    swim = await ev(() => window.CS.sim.ctx.get(window.CS.view.myId).swim);
  }
  await ev(() => window.CS.input(null));
  check(!swim, 'climbed out');
  // look at the hole from a safe distance (on thick ice)
  const stand = await ev((h) => {
    const w = window.CS.world;
    for (let r = 4.5; r < 30; r += 1.5) {
      for (let a = 0; a < 16; a++) {
        const x = h.x + Math.sin((a / 16 + 0.3) * Math.PI * 2) * r, z = h.z + Math.cos((a / 16 + 0.3) * Math.PI * 2) * r;
        if (w.iceAt(x, z) > 0.12) return { x, z };
      }
    }
    return null;
  }, hole);
  check(!!stand, 'a safe spot to look from');
  const look = async () => {
    await ev(({ s, h }) => {
      const yaw = (Math.atan2(-(h.x - s.x), -(h.z - s.z)) * 180) / Math.PI;
      window.CS.go(s.x, s.z, yaw, -32);
    }, { s: stand, h: hole });
    await step(8);
  };
  await look();
  const open = await ev(() => {
    const cells = [...window.CS.view.ice.values()];
    return { holes: cells.filter((c) => c.hole).length, film: cells.filter((c) => c.hole).map((c) => c.skin ?? -1) };
  });
  log('open water', open);
  check(open.holes > 0, 'the view has the hole');
  await shot('ice_01_hole');
  // the film forms: step until the hole has some skin, then until it closes
  let film = 0;
  for (let k = 0; k < 60 && film < 0.012; k++) {
    await step(300, 0.1);
    film = await ev(() => Math.max(0, ...[...window.CS.view.ice.values()].filter((c) => c.hole).map((c) => c.skin ?? 0)));
  }
  log('film', film);
  check(film > 0, 'the skin reaches the client (IceCell.skin in the snapshots)');
  await look();
  await shot('ice_02_film');
  let closed = false;
  for (let k = 0; k < 80 && !closed; k++) {
    await step(300, 0.1);
    closed = await ev(() => [...window.CS.view.ice.values()].some((c) => !c.hole && c.skin !== undefined));
  }
  check(closed, 'the hole skinned over (a refrozen cell in the view)');
  await look();
  await shot('ice_03_refrozen');
  const drawn = await ev(() => {
    const g = window.CS.engine.scene.getObjectByName('lake-ice');
    return g ? g.children.map((m) => m.count) : null;
  });
  log('drawn (water, new ice, slabs)', drawn);
  check(drawn && drawn[1] > 0, 'new ice drawn');
}
