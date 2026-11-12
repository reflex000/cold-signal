// Title and menus over the live scene: the title, a new game from its menu, pause and resume,
// the pack, photo mode, quit to the title. Checks the bus 'mode' sequence and that the host stops
// while paused.
//   node tools/play.mjs tools/scenarios/title.mjs
export const query = 'skipTitle=0';

export default async function ({ ev, step, shot, log, check }) {
  await ev(() => {
    window.__modes = [];
    window.CS.view.bus.on('mode', (e) => window.__modes.push(e.to));
  });
  let s = await step(30);
  check(s.mode === 'title', `the game opens on the title (${s.mode})`);
  await shot('title');
  // the menu's first button starts a new game (a click the UI handles itself)
  const clicked = await ev(() => {
    const b = document.querySelector('.tt [data-id="new"]');
    if (!b) return false;
    b.click();
    return true;
  });
  check(clicked, 'the title has a New game button');
  s = await step(20);
  check(s.mode === 'play', `New game starts play (${s.mode})`);
  await shot('title_play');

  await ev(() => window.CS.game.actions.pause());
  const t0 = (await step(1)).ticks;
  s = await step(30);
  check(s.mode === 'pause', 'pause');
  check(s.ticks === t0, `the host does not tick while paused (${s.ticks - t0} ticks)`);
  await shot('title_pause');
  await ev(() => window.CS.game.actions.resume());
  s = await step(10);
  check(s.mode === 'play' && s.ticks > t0, 'resume');

  await ev(() => window.CS.game.actions.openInventory());
  s = await step(10);
  check(s.mode === 'inventory', 'the pack opens');
  await shot('title_pack');
  await ev(() => window.CS.game.actions.closeInventory());
  s = await step(5);
  check(s.mode === 'play', 'the pack closes');

  await ev(() => window.CS.game.actions.photo(true));
  s = await step(30);
  const third = await ev(() => window.CS.view.camera.third);
  check(s.mode === 'photo' && third > 0.9, `photo mode: third-person view (${third.toFixed(2)})`);
  await shot('title_photo');
  await ev(() => window.CS.game.actions.photo(false));
  s = await step(30);
  const back = await ev(() => window.CS.view.camera.third);
  check(s.mode === 'play' && back < 0.05, 'back to first person');

  await ev(() => window.CS.game.actions.quitToTitle());
  s = await step(20);
  check(s.mode === 'title', 'quit to the title');
  const modes = await ev(() => window.__modes);
  log('modes', modes.join(' > '));
  check(modes.join(',') === 'play,pause,play,inventory,play,photo,play,title', 'bus mode messages in order');
}
