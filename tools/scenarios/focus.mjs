// Focus: stand beside things and look at them; the HUD names what E would do, the command carries
// the entity id to the host, and looking away (or standing too far) clears it.
//   node tools/play.mjs tools/scenarios/focus.mjs
export default async function ({ ev, step, shot, log, check }) {
  await step(10);
  // the nearest pickup, crate and fire to the spawn that stand on open ground
  const targets = await ev(() => {
    const v = window.CS.view, w = window.CS.world, me = v.me;
    const pick = (kind, filter = () => true) => {
      let best = null, bd = Infinity;
      for (const e of v.list(kind)) {
        if (!filter(e)) continue;
        const d = Math.hypot(e.x - me.x, e.z - me.z);
        // somewhere to stand 1.6 m away, on the open side
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const sx = e.x + Math.sin(a) * 1.6, sz = e.z + Math.cos(a) * 1.6;
          if (d < bd && w.walkable(sx, sz) && Math.abs(w.groundAt(sx, sz, e.y + 1).y - e.y) < 0.6) {
            bd = d;
            best = { id: e.id, kind, x: e.x, y: e.y, z: e.z, sx, sz };
            break;
          }
        }
      }
      return best;
    };
    return [pick('pickup', (e) => e.lie !== 'shelf'), pick('crate', (e) => !e.open), pick('fire')].filter(Boolean);
  });
  log('targets', targets.map((t) => `${t.kind} ${t.id}`).join(', '));
  check(targets.length >= 2, 'found things to look at');
  for (const t of targets) {
    // stand there and aim at the thing (low ones need the eye to look down)
    const yaw = (Math.atan2(-(t.x - t.sx), -(t.z - t.sz)) * 180) / Math.PI;
    await ev((o) => window.CS.go(o.sx, o.sz, o.yaw, 0), { ...t, yaw });
    await step(5);
    const aim = await ev((t) => {
      const c = window.CS.view.camera;
      const h = { pickup: 0.1, crate: 0.35, fire: 0.3 }[t.kind] ?? 0.3;
      return (Math.atan2(t.y + h - c.y, Math.hypot(t.x - c.x, t.z - c.z)) * 180) / Math.PI;
    }, t);
    await ev(([y, p]) => window.CS.look(y, p), [yaw, aim]);
    await step(4);
    const f = await ev(() => {
      const f = window.CS.view.hud.focus;
      const me = window.CS.view.me;
      return { focus: f ? { id: f.id, verb: f.verb, name: f.name, note: f.note } : null, sent: window.CS.sim.ctx.input(me.id).focus };
    });
    log(t.kind, t.id, '->', f.focus, 'sent', f.sent);
    check(f.focus && f.focus.id === t.id, `${t.kind}: in focus (${f.focus ? f.focus.verb + ' ' + f.focus.name : 'nothing'})`);
    check(f.sent === t.id, `${t.kind}: the command carries the focus to the host`);
    await shot(`focus_${t.kind}`);
    // look away
    await ev(([y]) => window.CS.look(y + 120, 0), [yaw]);
    await step(3);
    const away = await ev(() => window.CS.view.hud.focus);
    check(!away || away.id !== t.id, `${t.kind}: looking away clears it`);
  }
}
