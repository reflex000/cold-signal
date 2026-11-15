// Branches: firewood a person can find. By the wreck lie 8 to 12 sticks (within 40 m of the fuselage),
// enough for the first fire. Then the dead lower branches of standing pines and firs snap off by hand,
// on every device: up close to a trunk with nothing else in focus the prompt offers "Snap dead branches";
// holding use (the real E key, a faked gamepad's X, or on a phone the hand button through touch events)
// for a second fills the ring and gives two sticks; the host marks the tree stripped and it is never
// offered again, and holding use at it again gives nothing.
//   node tools/play.mjs tools/scenarios/branches.mjs [--mobile 1] [--backend webgl] [--query "wire=json&lag=120&jitter=30"]
export default async function ({ page, ev, step, shot, log, check, mobile }) {
  await step(10);

  // ---------------------------------------------------------------- the wreck's own sticks
  const wreck = await ev(() => {
    const CS = window.CS, f = CS.world.props.find((p) => p.model === 'fuselage');
    let n = 0, k = 0, ground = 0;
    for (const e of CS.view.list('pickup')) {
      if (e.item !== 'stick' || Math.hypot(e.x - f.x, e.z - f.z) > 40) continue;
      n += e.n;
      k++;
      if (e.lie === 'ground') ground++;
    }
    return { n, k, ground };
  });
  log('sticks within 40 m of the fuselage', wreck);
  check(wreck.n >= 8 && wreck.n <= 12, `8 to 12 sticks lie by the wreck (${wreck.n} in ${wreck.k} bundles)`);

  // ---------------------------------------------------------------- page-side helpers
  await ev(() => {
    const CS = window.CS;
    const B = (window.BR = {});
    B.events = [];
    CS.view.bus.on('sim', (e) => B.events.push(e));
    B.me = () => CS.sim.ctx.get(CS.view.myId);
    /** Stand 1.1 m from the bark of the nearest unstripped pine or fir with open level ground and no entity near, facing it. */
    B.atTree = () => {
      const w = CS.world, gone = CS.view.gathered, from = B.me();
      const idx = w.treesIn(from.x - 80, from.z - 80, from.x + 80, from.z + 80, []);
      idx.sort((a, b) => Math.hypot(w.trees[a].x - from.x, w.trees[a].z - from.z) - Math.hypot(w.trees[b].x - from.x, w.trees[b].z - from.z));
      const busy = (x, z) => {
        for (const k of ['pickup', 'crate', 'wood', 'log', 'fire', 'device']) for (const e of CS.view.list(k)) if (Math.hypot(e.x - x, e.z - z) < 3) return true;
        return false;
      };
      for (const i of idx) {
        const t = w.trees[i];
        if ((t.kind !== 'pine' && t.kind !== 'fir') || gone.has(i) || busy(t.x, t.z)) continue;
        const r = (t.r || 0.3) + 1.1;
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          const sx = t.x + Math.sin(a) * r, sz = t.z + Math.cos(a) * r;
          if (!w.walkable(sx, sz)) continue;
          const gy = w.groundAt(sx, sz, t.y + 1).y;
          if (Math.abs(gy - t.y) > 0.4 || !w.lineClear(sx, gy + 1.6, sz, t.x, t.y + 1.2, t.z)) continue;
          let hidden = false;
          for (const j of idx) {
            const o = w.trees[j];
            if (j === i || Math.hypot(o.x - t.x, o.z - t.z) > 4) continue;
            const ux = t.x - sx, uz = t.z - sz, l = Math.hypot(ux, uz);
            const along = ((o.x - sx) * ux + (o.z - sz) * uz) / l;
            if (along > 0 && along < l && Math.abs((o.x - sx) * uz - (o.z - sz) * ux) / l < (o.r || 0.3) + 0.25) hidden = true;
          }
          if (hidden) continue;
          const yaw = (Math.atan2(-(t.x - sx), -(t.z - sz)) * 180) / Math.PI;
          CS.go(sx, sz, yaw, 0);
          const me = B.me();
          CS.look(yaw, (Math.atan2(t.y + 1.2 - (me.y + 1.66), Math.hypot(t.x - me.x, t.z - me.z)) * 180) / Math.PI);
          return { i, kind: t.kind };
        }
      }
      return null;
    };
    B.focus = () => {
      const f = CS.view.hud.focus;
      const fc = document.querySelector('.fc');
      const use = document.querySelector('.tb-use');
      return {
        text: f ? `${f.verb} ${f.name}${f.note ? ' (' + f.note + ')' : ''}` : '', kind: f ? f.kind : '', tree: f ? f.tree : undefined, hold: f ? f.hold : null,
        shown: !!fc && fc.classList.contains('on'),
        useBtn: use ? { on: !use.classList.contains('off'), label: use.querySelector('.lb')?.textContent ?? '' } : null,
      };
    };
  });

  // each device holds use its own way; all of them are the same USE bit in the command
  let cdp = null;
  const hold = {
    kbm: { down: () => page.keyboard.down('KeyE'), up: () => page.keyboard.up('KeyE') },
    pad: {
      down: () => ev(() => (window.__pad.buttons[2] = { pressed: true, touched: true, value: 1 })),
      up: () => ev(() => (window.__pad.buttons[2] = { pressed: false, touched: false, value: 0 })),
    },
    touch: {
      down: async () => {
        const b = await ev(() => {
          const r = document.querySelector('.tb-use').getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        });
        cdp ??= await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y, id: 7, radiusX: 8, radiusY: 8, force: 1 }] });
      },
      up: async () => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      },
    },
  };
  const devices = mobile ? ['touch'] : ['kbm', 'pad'];
  for (const dev of devices) {
    if (dev === 'pad') {
      await ev(() => {
        const pad = { id: 'fake pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
        window.__pad = pad;
        navigator.getGamepads = () => [pad, null, null, null];
      });
      await step(2);
    }
    const tree = await ev(() => window.BR.atTree());
    check(!!tree, `${dev}: found a pine or fir to strip`);
    if (!tree) continue;
    await step(12); // (time for the teleport to come back over a lagged wire too: ?wire=json&lag=120)
    const f0 = await ev(() => window.BR.focus());
    log(`${dev}: at ${tree.kind} ${tree.i}:`, f0);
    check(f0.kind === 'tree' && f0.tree === tree.i && f0.text.startsWith('Snap dead branches'), `${dev}: the focus offers "${f0.text}"`);
    check(f0.shown, `${dev}: the prompt is on screen`);
    if (dev === 'touch') check(!!f0.useBtn && f0.useBtn.on && f0.useBtn.label === 'Snap dead branches', `touch: the hand button carries the verb (${JSON.stringify(f0.useBtn)})`);
    const n0 = await ev(() => window.BR.me().inv.stick ?? 0);
    const e0 = await ev(() => window.BR.events.length);
    await hold[dev].down();
    await step(15);
    const ring = await ev(() => window.BR.focus().hold);
    // (the ring is the host's progress: over a lagged wire it starts a round trip late)
    check(ring !== null && ring > 0.1 && ring < 0.85, `${dev}: the ring fills while use is held (${ring})`);
    await shot(`branches_${dev}`);
    await step(24);
    await hold[dev].up();
    await step(6);
    const n1 = await ev(() => window.BR.me().inv.stick ?? 0);
    const got = await ev((e0) => window.BR.events.slice(e0).filter((e) => e.t === 'gathered' || e.t === 'pickup').map((e) => (e.t === 'pickup' ? `pickup ${e.item} ${e.n}` : `gathered ${e.tree}`)), e0);
    log(`${dev}: +${n1 - n0} sticks; events`, got);
    check(n1 - n0 === 2, `${dev}: two sticks from a living ${tree.kind} (+${n1 - n0})`);
    check(got.includes(`gathered ${tree.i}`) && got.includes('pickup stick 2'), `${dev}: the tree is stripped and the sticks are in the pack`);
    const f1 = await ev(() => window.BR.focus());
    const gone = await ev((i) => ({ client: window.CS.view.gathered.has(i), host: (window.CS.sim.state.gathered || []).includes(i) }), tree.i);
    check(gone.client && gone.host && f1.tree !== tree.i, `${dev}: the stripped tree is not offered again (focus "${f1.text}")`);
    await hold[dev].down();
    await step(40);
    await hold[dev].up();
    await step(3);
    check((await ev(() => window.BR.me().inv.stick ?? 0)) === n1, `${dev}: use held at it again gives nothing`);
  }
}
