// Bots: two companions (?bots=2) join through the host like players; walk for 15 s and check they
// keep up (within about 15 m) and stand on the ground. A third-person shot shows the group.
//   node tools/play.mjs tools/scenarios/bots.mjs
export const query = 'bots=2';

export default async function ({ ev, step, shot, log, check }) {
  let s = await step(20);
  check((s.ents.player ?? 0) === 3, `three players in the game (${s.ents.player})`);
  await ev(() => window.CS.go(-60, 470, 45, 0));
  await step(30);
  await ev(() => window.CS.input({ mz: 1 }));
  let worst = 0;
  for (let i = 0; i < 15; i++) {
    await step(30);
    const d = await ev(() => {
      const me = window.CS.view.me;
      let far = 0;
      for (const p of window.CS.view.list('player')) if (p.id !== me.id) far = Math.max(far, Math.hypot(p.x - me.x, p.z - me.z));
      return far;
    });
    worst = Math.max(worst, i > 3 ? d : 0);
  }
  await ev(() => window.CS.input(null));
  await step(90);
  const end = await ev(() => {
    const me = window.CS.view.me, w = window.CS.world;
    return window.CS.view.list('player').filter((p) => p.id !== me.id).map((p) => ({
      name: p.name, d: +Math.hypot(p.x - me.x, p.z - me.z).toFixed(1), feet: +(p.y - w.groundAt(p.x, p.z, p.y + 0.6).y).toFixed(2),
    }));
  });
  log('companions after the walk', end, 'farthest while walking', worst.toFixed(1), 'm');
  check(worst < 18, 'companions keep up while walking');
  check(end.every((b) => b.d < 8), 'companions gather round when the player stops');
  check(end.every((b) => Math.abs(b.feet) < 0.2), 'companions stand on the ground');
  // look at them from behind in third person (dev V)
  await ev(() => {
    window.CS.game.input.setLook(window.CS.game.input.yaw + Math.PI, -0.25);
  });
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' })));
  await step(40);
  await shot('bots_group');
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV' })));
}
