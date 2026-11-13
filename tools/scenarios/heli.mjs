// The rescue helicopter drawn: the hold-out is jumped to its last seconds by the debug actions, the
// helicopter comes in over the ridge and hovers over the deck; shots from the deck as it arrives and
// overhead, rotors turning. Checks the model is placed where the entity is.
//   node tools/play.mjs tools/scenarios/heli.mjs [--backend webgl]
export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  await ev(() => window.CS.env({ storm: 0.15, clock: 13, lock: true }));
  const pad = await ev(() => {
    const a = window.CS.world.anchors['tower:mast.deck'];
    return a ? { x: a.x, y: a.y, z: a.z } : null;
  });
  check(!!pad, 'the deck anchor');
  await ev((p) => window.CS.go(p.x + 22, p.z + 18, 0, 8), pad);
  await ev(() => {
    const CS = window.CS;
    CS.act({ t: 'debug', cmd: 'obj.stage', args: [4] }); // the hold-out
    CS.act({ t: 'debug', cmd: 'obj.eta', args: [40] }); // ... nearly over: the helicopter is inbound
  });
  const seen = async () => ev(() => {
    const h = window.CS.view.list('heli')[0];
    const props = window.CS.engine.get('props');
    const ids = props ? props.find('rescue_heli') : [];
    if (!h || !ids.length) return null;
    const m = props.matrix(ids[0]);
    return { hx: h.x, hy: h.y, hz: h.z, phase: h.phase, mx: m.elements[12], my: m.elements[13], mz: m.elements[14] };
  });
  let s = null;
  for (let k = 0; k < 40 && !s; k++) {
    await step(30);
    s = await seen();
  }
  check(!!s, 'the helicopter is drawn (the rescue_heli prop exists)');
  if (!s) return;
  check(Math.hypot(s.hx - s.mx, s.hz - s.mz) < 0.5 && Math.abs(s.hy - 0.3 - s.my) < 0.5, 'drawn where the entity is');
  const lookAtHeli = () => ev(() => {
    const CS = window.CS, h = CS.view.list('heli')[0], me = CS.view.me;
    if (!h) return;
    const yaw = (Math.atan2(-(h.x - me.x), -(h.z - me.z)) * 180) / Math.PI;
    const pitch = (Math.atan2(h.y + 2 - (me.y + 1.66), Math.hypot(h.x - me.x, h.z - me.z)) * 180) / Math.PI;
    CS.look(yaw, pitch);
  });
  // inbound, then over the deck
  for (let k = 0; k < 6; k++) {
    await step(20);
    await lookAtHeli();
  }
  await step(2);
  log('inbound', JSON.stringify(await seen()));
  await shot('heli_01_inbound');
  for (let k = 0; k < 60; k++) {
    await step(30);
    const st = await ev(() => window.CS.view.list('heli')[0]?.phase);
    if (st === 'hover' || st === 'winch') break;
  }
  await lookAtHeli();
  await step(4);
  log('over the deck', JSON.stringify(await seen()));
  await shot('heli_02_hover');
  // close: stand under its track, about twenty metres off, and look up at it
  await ev(() => {
    const CS = window.CS, h = CS.view.list('heli')[0];
    if (h) CS.go(h.x + 14, h.z + 14, 0, 0);
  });
  await step(2);
  await lookAtHeli();
  await step(2);
  await shot('heli_03_close');
}
