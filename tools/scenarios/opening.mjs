// The first minutes: the title, the opening of a new game (black, the lines about Flight 417, the fade
// into the fuselage at dusk), then the tutorial lines as they come: move and look, take, the barrel fire,
// the pack, the radio. Checks that the world waits and the controls are held while the opening runs,
// that a key skips to the fade, that each line goes once it is done, and that the lines name the keys of
// the device in use (run it with --mobile 1 for the touch controls).
//   node tools/play.mjs tools/scenarios/opening.mjs [--mobile 1] [--backend webgl]
export const query = 'skipTitle=0';

export default async function ({ ev, step, shot, log, check, mobile }) {
  let s = await step(20);
  check(s.mode === 'title', `the game opens on the title (${s.mode})`);
  await shot('opening_00_title');
  const hint = () => ev(() => ({ hint: window.CS.view.hud.hint, opening: window.CS.view.opening, mode: window.CS.game.mode, op: !!document.querySelector('.opn.on') }));
  const lines = [];
  const seen = async (label) => {
    const h = await hint();
    if (h.hint && lines[lines.length - 1] !== h.hint) {
      lines.push(h.hint);
      log(`hint (${label}): ${h.hint}`);
    }
    return h;
  };

  // ---------------------------------------------------------------- the opening
  await ev(() => window.CS.game.newGame(undefined, false, true));
  s = await step(15); // 0.5 s
  let h = await hint();
  check(h.mode === 'play' && h.opening > 11 && h.op, `the opening is up (${JSON.stringify(h)})`);
  const t0 = s.ticks;
  await shot('opening_01_black');
  await step(60); // 2.5 s
  await shot('opening_02_line1');
  await step(150); // 7.5 s
  await shot('opening_03_line2');
  const me0 = await ev(() => ({ x: window.CS.view.me.x, z: window.CS.view.me.z, t: window.CS.view.env.t }));
  await ev(() => window.CS.input({ mx: 0, mz: 1, b: 0 })); // a scripted hold would move a body that had control
  await step(75); // 10 s: the fade
  await ev(() => window.CS.input(null));
  await shot('opening_04_fade');
  s = await step(1);
  const me1 = await ev(() => ({ x: window.CS.view.me.x, z: window.CS.view.me.z, t: window.CS.view.env.t }));
  check(s.ticks === t0, `the world waits during the opening (${s.ticks - t0} ticks)`);
  check(Math.hypot(me1.x - me0.x, me1.z - me0.z) < 0.01 && me1.t === me0.t, 'nobody moves during the opening');
  s = await step(100); // 13.4 s: in the fuselage
  h = await hint();
  check(!h.op && h.opening === 0 && s.ticks > t0, `the opening ends and the world goes on (${JSON.stringify(h)})`);
  const inside = await ev(() => {
    const me = window.CS.view.me;
    const f = window.CS.world.props.find((p) => p.model === 'fuselage');
    return { d: Math.hypot(me.x - f.x, me.z - f.z), surface: me.surface, shelter: me.shelter };
  });
  check(inside.d < 7 && inside.shelter > 0.5, `the new game opens inside the fuselage (${JSON.stringify(inside)})`);
  await shot('opening_05_fuselage');
  await step(60);
  await seen('start');
  await shot('opening_06_first_hint');
  check(lines.length === 1 && /move|look|thumb|stick/.test(lines[0]), 'the first line is move and look');
  if (mobile) check(/thumb|Drag/.test(lines[0]), 'touch: the line names the thumbs');
  else check(/W A S D|mouse/.test(lines[0]), 'keyboard: the line names W A S D and the mouse');

  // ---------------------------------------------------------------- move and look: the line goes
  await ev(() => window.CS.input({ mx: 0, mz: 1, b: 0 }));
  for (let i = 0; i < 6; i++) {
    await ev((k) => window.CS.look(180 + k * 25, 0), i);
    await step(15);
  }
  await ev(() => window.CS.input(null));
  await step(60);
  h = await seen('after moving');
  check(!/W A S D|thumb|Left stick/.test(h.hint), `the move line is gone once done (now: '${h.hint}')`);

  // ---------------------------------------------------------------- take: look at the radio on the floor
  const target = await ev(() => {
    const p = window.CS.view.list('pickup').find((e) => e.item === 'radio');
    return p ? { x: p.x, y: p.y, z: p.z, id: p.id } : null;
  });
  check(!!target, 'the radio lies in the fuselage');
  if (target) {
    // walk to it with the scripted hold, turning to face it each frame
    for (let i = 0; i < 90; i++) {
      const r = await ev((tg) => {
        const me = window.CS.view.me;
        const dx = tg.x - me.x, dz = tg.z - me.z, d = Math.hypot(dx, dz);
        const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
        const pitch = (Math.atan2(tg.y - (me.y + 1.6), Math.max(0.3, d)) * 180) / Math.PI;
        window.CS.look(yaw, pitch);
        window.CS.input(d > 1.3 ? { mx: 0, mz: 1, b: 0 } : null);
        return { d, focus: window.CS.view.hud.focus ? window.CS.view.hud.focus.name : '' };
      }, target);
      await step(3);
      if (r.d <= 1.3 && r.focus) break;
    }
    await step(60);
    h = await seen('looking at the radio');
    await shot('opening_07_take');
    check(/take what you look at/.test(h.hint), `looking at a thing to take: the take line (${h.hint})`);
    if (mobile) check(/hand/.test(h.hint), 'touch: the take line names the hand');
    else check(/Press E/.test(h.hint), 'keyboard: the take line names E');
    await ev((id) => window.CS.input({ mx: 0, mz: 0, b: 32 }), target.id);
    await step(4);
    await ev(() => window.CS.input(null));
    await step(70);
    const got = await ev(() => window.CS.view.me.inv.radio ?? 0);
    check(got > 0, 'the radio is taken');
    h = await seen('after taking');
    check(!/take what you look at/.test(h.hint), `the take line is gone once something is taken (now: '${h.hint}')`);
  }

  // ---------------------------------------------------------------- the radio, then the crank
  // (taking the radio is what makes the radio line relevant: it comes next, or soon)
  if (!/radio/i.test(h.hint)) {
    for (let i = 0; i < 20; i++) {
      await step(30);
      h = await seen('waiting');
      if (/radio/i.test(h.hint)) break;
    }
  }
  check(/radio/i.test(h.hint), `with the radio in the pack, the radio line comes (${h.hint})`);
  if (mobile) check(/tool ring/.test(h.hint), 'touch: the radio line names the tool ring');
  else check(/Press 5/.test(h.hint), 'keyboard: the radio line names 5');
  await shot('opening_08_radio_hint');
  await ev(() => window.CS.equip('radio'));
  await step(60);
  h = await seen('radio out');
  check(/crank/.test(h.hint), `the radio out: the crank line (${h.hint})`);
  await shot('opening_09_crank_hint');

  // ---------------------------------------------------------------- the pack: opened before its line, it never comes
  await ev(() => window.CS.game.actions.openInventory());
  await step(10);
  await shot('opening_10_pack');
  await ev(() => window.CS.game.actions.closeInventory());
  let packLine = false;
  for (let i = 0; i < 12; i++) {
    await step(30);
    h = await seen('after the pack');
    if (/opens the pack|opens your pack/.test(h.hint)) packLine = true;
  }
  check(!packLine, 'the pack line never comes once the pack has been opened');
  log('lines seen: ' + lines.length + ' | ' + lines.join(' / '));

  // ---------------------------------------------------------------- skip: a key during a fresh opening
  await ev(() => window.CS.game.actions.quitToTitle());
  await step(20);
  await ev(() => window.CS.game.newGame(undefined, false, true));
  await step(36); // 1.2 s
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' })));
  await step(2);
  h = await hint();
  check(h.opening > 0 && h.opening <= 3.3, `a key skips to the fade (${h.opening.toFixed(2)} s left)`);
  await step(110);
  h = await hint();
  check(h.opening === 0 && !h.op, 'after the skip the game is on');
}
