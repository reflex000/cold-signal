// The pack shows its things as pictures: UiGame.icon(item) draws each item on a canvas (game/icons.ts)
// and the inventory copies them into its cells. Fills the pack with one of everything and looks.
//   node tools/play.mjs tools/scenarios/pack.mjs [--mobile 1]
export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  await ev(() => {
    const CS = window.CS;
    for (const [item, n] of [['axe', 1], ['flaregun', 1], ['rifle', 1], ['radio', 1], ['stick', 7], ['log', 2], ['tinder', 2], ['matches', 9], ['flare', 2], ['ammo', 6], ['cell', 1], ['bandage', 2], ['ration', 1], ['thermos', 1], ['part_battery', 1], ['part_handset', 1], ['part_coil', 1], ['part_tube', 1], ['part_fuse', 1]]) CS.give(item, n);
  });
  await step(10);
  await ev(() => window.CS.mode('inventory'));
  await step(20);
  const cells = await ev(() => ({ cells: document.querySelectorAll('.cell').length, pictures: document.querySelectorAll('.cell.cv canvas').length }));
  log(`pack: ${cells.cells} cells, ${cells.pictures} with a drawn picture`);
  check(cells.pictures >= 19, 'every item in the pack has its picture');
  await shot('pack_icons');
  await ev(() => window.CS.mode('play'));
  await step(4);
}
