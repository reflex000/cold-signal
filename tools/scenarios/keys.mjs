// Input devices: real keyboard events (W walks, Shift sprints, Space jumps, 1-5 and Q pick tools,
// Tab opens the pack, Esc pauses), and a gamepad faked through navigator.getGamepads (left stick
// walks, right stick turns, A jumps, Menu pauses). Checks each reaches the game the same way.
//   node tools/play.mjs tools/scenarios/keys.mjs
export default async function ({ page, ev, step, log, check }) {
  await step(10);
  await ev(() => window.CS.go(-60, 470, 45, 0));
  await step(10);
  const at = () => ev(() => ({ x: window.CS.view.me.x, y: window.CS.view.me.y, z: window.CS.view.me.z, yaw: window.CS.game.input.yaw, held: window.CS.view.me.held }));

  // W for one second
  let a = await at();
  await page.keyboard.down('KeyW');
  await step(30);
  await page.keyboard.up('KeyW');
  await step(10);
  let b = await at();
  const walked = Math.hypot(b.x - a.x, b.z - a.z);
  log(`W for 1 s: ${walked.toFixed(2)} m`);
  check(walked > 1.5 && walked < 3.5, 'W walks');

  // Shift + W: faster
  a = b;
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyW');
  await step(30);
  await page.keyboard.up('KeyW');
  await page.keyboard.up('ShiftLeft');
  await step(10);
  b = await at();
  const ran = Math.hypot(b.x - a.x, b.z - a.z);
  log(`Shift+W for 1 s: ${ran.toFixed(2)} m`);
  check(ran > walked * 1.25, 'Shift sprints');

  // Space: one hop, even when held
  const y0 = b.y;
  await page.keyboard.down('Space');
  let top = y0;
  let landed = 0;
  for (let i = 0; i < 40; i++) {
    await step(1);
    const y = await ev(() => window.CS.view.me.y);
    top = Math.max(top, y);
    if (i > 10 && Math.abs(y - y0) < 0.02) landed++;
  }
  await page.keyboard.up('Space');
  log(`Space held: rose ${(top - y0).toFixed(2)} m, then stayed down ${landed} frames`);
  check(top - y0 > 0.3, 'Space jumps');
  check(landed > 5, 'holding Space does not keep hopping');

  // tools: 2 = flashlight (in the starting kit), Q = hands
  await page.keyboard.press('Digit2');
  await step(5);
  check((await at()).held === 'flashlight', '2 takes the flashlight');
  await page.keyboard.press('KeyQ');
  await step(5);
  check((await at()).held === 'hands', 'Q puts it away');

  // Tab: the pack; Esc: pause (the UI owns keys while its screens are up)
  await page.keyboard.press('Tab');
  let s = await step(5);
  check(s.mode === 'inventory', 'Tab opens the pack');
  await ev(() => window.CS.game.actions.closeInventory());
  await step(5);
  await page.keyboard.press('Escape');
  s = await step(5);
  check(s.mode === 'pause', 'Esc pauses');
  await ev(() => window.CS.game.actions.resume());
  await step(5);

  // a gamepad, faked
  await ev(() => {
    const pad = {
      id: 'fake pad', index: 0, connected: true, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    window.__pad = pad;
    navigator.getGamepads = () => [pad, null, null, null];
  });
  const setPad = (o) => ev((o) => {
    const p = window.__pad;
    if (o.axes) p.axes = o.axes;
    for (const [i, v] of Object.entries(o.buttons || {})) p.buttons[+i] = { pressed: v > 0.5, touched: v > 0, value: v };
  }, o);
  a = await at();
  await setPad({ axes: [0, -1, 0, 0] });
  await step(30);
  await setPad({ axes: [0, 0, 0, 0] });
  await step(10);
  b = await at();
  const padWalk = Math.hypot(b.x - a.x, b.z - a.z);
  log(`left stick forward 1 s: ${padWalk.toFixed(2)} m`);
  check(padWalk > 1.5, 'the left stick walks');
  await setPad({ axes: [0, 0, 1, 0] });
  await step(15);
  await setPad({ axes: [0, 0, 0, 0] });
  await step(2);
  const c = await at();
  const turn = ((c.yaw - b.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  log(`right stick right 0.5 s: yaw ${((turn * 180) / Math.PI).toFixed(1)} deg`);
  check(turn < -0.3, 'the right stick turns (right = clockwise)');
  const py = c.y;
  await setPad({ buttons: { 0: 1 } });
  let ptop = py;
  for (let i = 0; i < 12; i++) {
    await step(1);
    ptop = Math.max(ptop, await ev(() => window.CS.view.me.y));
  }
  await setPad({ buttons: { 0: 0 } });
  check(ptop - py > 0.3, 'A jumps');
  await step(20);
  await setPad({ buttons: { 9: 1 } });
  s = await step(3);
  await setPad({ buttons: { 9: 0 } });
  check(s.mode === 'pause', 'Menu pauses');
}
