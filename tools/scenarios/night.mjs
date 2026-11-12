// Night: the wreck under a clear night sky, then with the barrel fire burning (lit on the host by
// hand: the fire system arrives later), then a night storm. The fire must glow and light the snow.
//   node tools/play.mjs tools/scenarios/night.mjs
export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  await ev(() => window.CS.env({ storm: 0.05, clock: 22, lock: true }));
  // stand back from the barrel fire, facing it
  const at = await ev(() => {
    const f = window.CS.view.list('fire').find((e) => e.type === 'barrel');
    return f ? { x: f.x, z: f.z, y: f.y } : null;
  });
  check(!!at, 'the wreck has a barrel fire');
  if (!at) return;
  const sx = at.x + 4.5, sz = at.z + 3.5;
  const yaw = (Math.atan2(-(at.x - sx), -(at.z - sz)) * 180) / Math.PI;
  await ev((o) => window.CS.go(o.sx, o.sz, o.yaw, -6), { sx, sz, yaw });
  await step(10);
  await shot('night_clear');
  const lit = await ev(() => {
    const sim = window.CS.sim;
    const f = sim.ctx.all('fire').find((e) => e.type === 'barrel');
    f.lit = true;
    f.heat = 0.85;
    f.fuel = 600;
    f.size = 0.7;
    sim.ctx.touch(f);
    return f.id;
  });
  await step(10);
  const glow = await ev((id) => {
    const f = window.CS.view.ents.get(id);
    const l = [];
    window.CS.engine.scene.traverse((o) => {
      if (o.isPointLight && o.intensity > 0) l.push(+o.intensity.toFixed(1));
    });
    return { lit: f.lit, lights: l };
  }, lit);
  log('fire', glow);
  check(glow.lit, 'the client sees the fire burning');
  check(glow.lights.length > 0, 'a point light follows the flames');
  await shot('night_fire');
  await ev(() => window.CS.env({ storm: 0.7, clock: 2, lock: true }));
  await step(10);
  await shot('night_storm');
}
