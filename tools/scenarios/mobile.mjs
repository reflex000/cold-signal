// Mobile: a phone in landscape (844 x 390 CSS px, touch, WebGL2). The touch controls must be on
// screen where thumbs are; a synthetic thumb on the left drives the stick and the player walks;
// a drag on the right turns the view; a tap on the jump button jumps.
//   node tools/play.mjs tools/scenarios/mobile.mjs --mobile 1
export default async function ({ page, ev, step, shot, log, check, mobile }) {
  if (!mobile) log('(run with --mobile 1 for the phone viewport)');
  const touch = await ev(() => window.CS.view.touch);
  check(touch, 'the game detected a touch device');
  // with an axe in hand the primary button shows (it hides while the hands are empty)
  await ev(() => {
    window.CS.give('axe', 1);
    window.CS.step(2);
    window.CS.equip('axe');
  });
  await step(10);
  const layout = await ev(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { x: b.x, y: b.y, w: b.width, h: b.height, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && b.width > 0 };
    };
    return {
      vw: innerWidth, vh: innerHeight,
      tc: r('.tc'), zone: r('.tz'),
      pri: r('.tb-pri'), jmp: r('.tb-jmp'), cro: r('.tb-cro'), spr: r('.tb-spr'), whl: r('.tb-whl'), pau: r('.tb-pau'), pck: r('.tb-pck'), use: r('.tb-use'),
    };
  });
  log('viewport', layout.vw, 'x', layout.vh);
  check(layout.tc && layout.tc.visible, 'touch controls are shown');
  for (const k of ['pri', 'jmp', 'cro', 'spr', 'whl', 'pau', 'pck']) {
    const b = layout[k];
    const inside = b && b.visible && b.x >= 0 && b.y >= 0 && b.x + b.w <= layout.vw + 0.5 && b.y + b.h <= layout.vh + 0.5;
    check(inside, `button ${k} on screen${b ? ` at ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}` : ''}`);
    if (b && b.visible) check(Math.min(b.w, b.h) >= 40, `button ${k} is a thumb-sized target (${Math.round(Math.min(b.w, b.h))} px)`);
  }
  for (const k of ['pri', 'jmp', 'cro', 'spr']) {
    const b = layout[k];
    if (b && b.visible) check(b.x + b.w / 2 > layout.vw * 0.55, `button ${k} sits under the right thumb`);
  }
  await shot('mobile_layout');

  const cdp = await page.context().newCDPSession(page);
  const touchEv = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 })) });
  const pos = () => ev(() => ({ x: window.CS.view.me.x, z: window.CS.view.me.z, yaw: window.CS.game.input.yaw }));

  // left thumb: press, push up (forward), hold for two seconds of game time
  const sx = Math.round(layout.vw * 0.18), sy = Math.round(layout.vh * 0.7);
  const a = await pos();
  await touchEv('touchStart', [{ x: sx, y: sy, id: 1 }]);
  await touchEv('touchMove', [{ x: sx, y: sy - 30, id: 1 }]);
  await touchEv('touchMove', [{ x: sx, y: sy - 70, id: 1 }]);
  await step(60);
  await shot('mobile_walking');
  const b = await pos();
  const walked = Math.hypot(b.x - a.x, b.z - a.z);
  log(`stick held 2 s: moved ${walked.toFixed(2)} m`);
  check(walked > 2.5, 'the stick walks the player');
  // forward means where the camera looks
  const dirYaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
  const off = Math.abs(((dirYaw - a.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  check(off < 0.35, `pushed up walks forward (${((off * 180) / Math.PI).toFixed(1)} deg off the view)`);
  await touchEv('touchEnd', []);
  await step(30);
  const c = await pos();
  await step(15);
  const d = await pos();
  check(Math.hypot(d.x - c.x, d.z - c.z) < 0.05, 'releasing the stick stops the player');

  // right thumb: drag left, the view turns left (yaw grows)
  const lx = Math.round(layout.vw * 0.62), ly = Math.round(layout.vh * 0.35);
  await touchEv('touchStart', [{ x: lx, y: ly, id: 2 }]);
  for (let i = 1; i <= 6; i++) await touchEv('touchMove', [{ x: lx - i * 15, y: ly, id: 2 }]);
  await touchEv('touchEnd', []);
  await step(3);
  const e = await pos();
  const turned = ((e.yaw - d.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  log(`drag 90 px left: yaw ${((turned * 180) / Math.PI).toFixed(1)} deg`);
  check(turned > 0.1, 'dragging on the right turns the view');

  // both thumbs at once: walk while turning
  await touchEv('touchStart', [{ x: sx, y: sy, id: 3 }]);
  await touchEv('touchMove', [{ x: sx, y: sy - 70, id: 3 }]);
  await touchEv('touchStart', [{ x: sx, y: sy - 70, id: 3 }, { x: lx, y: ly, id: 4 }]);
  for (let i = 1; i <= 4; i++) await touchEv('touchMove', [{ x: sx, y: sy - 70, id: 3 }, { x: lx + i * 12, y: ly, id: 4 }]);
  await step(30);
  const f = await pos();
  await touchEv('touchEnd', []);
  check(Math.hypot(f.x - e.x, f.z - e.z) > 1 && Math.abs(f.yaw - e.yaw) > 0.05, 'walking and looking at the same time');

  // jump: tap the button
  const j = layout.jmp;
  if (j) {
    await step(20);
    const y0 = await ev(() => window.CS.view.me.y);
    await touchEv('touchStart', [{ x: Math.round(j.x + j.w / 2), y: Math.round(j.y + j.h / 2), id: 5 }]);
    await step(4);
    await touchEv('touchEnd', []);
    let top = y0;
    for (let i = 0; i < 6; i++) {
      await step(2);
      top = Math.max(top, await ev(() => window.CS.view.me.y));
    }
    log(`jump: rose ${(top - y0).toFixed(2)} m`);
    check(top - y0 > 0.3, 'the jump button jumps');
  }
  await step(30);
  await shot('mobile_end');
}
