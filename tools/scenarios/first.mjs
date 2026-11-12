// First look: spawn at the wreck, settle, look round the four quarters, one shot each.
//   node tools/play.mjs tools/scenarios/first.mjs [--backend webgl] [--mobile 1]
export default async function ({ ev, step, shot, log, check, args }) {
  const tag = args.backend === 'webgl' ? '_gl' : args.mobile === '1' ? '_mobile' : '';
  let s = await step(15);
  log('spawn', s.me, 'ents', s.ents);
  check(s.me && Number.isFinite(s.me.y), 'the local player exists');
  const ground = await ev(() => {
    const me = window.CS.view.me;
    return { feet: me.y, ground: window.CS.world.groundAt(me.x, me.z, me.y + 1).y, eye: window.CS.view.camera.y };
  });
  log('feet', ground.feet.toFixed(2), 'ground', ground.ground.toFixed(2), 'eye', ground.eye.toFixed(2));
  check(Math.abs(ground.feet - ground.ground) < 0.15, 'feet on the ground');
  check(ground.eye - ground.feet > 1.5 && ground.eye - ground.feet < 1.8, 'eye at standing height');
  const quarters = [
    ['n', 0],
    ['w', 90],
    ['s', 180],
    ['e', 270],
  ];
  for (const [q, yaw] of quarters) {
    await ev(([y]) => window.CS.look(y, -3), [yaw]);
    s = await step(3);
    await shot(`first_${q}${tag}`);
  }
  log('draw calls', s.calls, 'triangles', s.tris);
}
