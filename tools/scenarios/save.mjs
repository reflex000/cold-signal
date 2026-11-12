// Save and continue: play, walk somewhere, take a stick into the pack, save (a checkpoint does the
// same), quit to the title, continue, and find the player where they were with what they had.
// The headless browser profile is new and thrown away: no real save is touched.
//   node tools/play.mjs tools/scenarios/save.mjs
export const query = 'nosave=0';

export default async function ({ ev, step, log, check }) {
  await step(10);
  await ev(() => window.CS.go(-60, 470, 45, 0));
  await ev(() => window.CS.input({ mz: 1 }));
  await step(60);
  await ev(() => window.CS.input(null));
  await step(20);
  await ev(() => window.CS.give('stick', 4));
  await step(5);
  const before = await ev(() => {
    const me = window.CS.view.me;
    return { x: me.x, z: me.z, sticks: me.inv.stick ?? 0, tick: window.CS.sim.state.tick };
  });
  const saved = await ev(() => window.CS.game.saveNow());
  check(saved, 'saved');
  check(await ev(() => window.CS.game.actions.hasSave()), 'hasSave() after saving');
  await ev(() => window.CS.game.actions.quitToTitle());
  let s = await step(10);
  check(s.mode === 'title', 'at the title');
  await ev(() => window.CS.game.actions.continueGame());
  s = await step(15);
  check(s.mode === 'play', 'continue starts play');
  const after = await ev(() => {
    const me = window.CS.view.me;
    return { x: me.x, z: me.z, sticks: me.inv.stick ?? 0, tick: window.CS.sim.state.tick };
  });
  log('before', before, 'after', after);
  check(Math.hypot(after.x - before.x, after.z - before.z) < 0.3, 'the player is where they were');
  check(after.sticks === before.sticks, 'the pack came back');
  check(after.tick >= before.tick, 'the clock went on from the save');
  // a new game from the title clears the save
  await ev(() => window.CS.game.actions.quitToTitle());
  await step(5);
  await ev(() => window.CS.game.actions.newGame());
  await step(10);
  const fresh = await ev(() => {
    const me = window.CS.view.me;
    return { sticks: me.inv.stick ?? 0, tick: window.CS.sim.state.tick, has: window.CS.game.actions.hasSave() };
  });
  check(fresh.sticks === 0 && fresh.tick < 30, 'New game starts over');
  check(!fresh.has, 'and the old save is gone');
}
