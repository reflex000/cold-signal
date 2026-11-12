// Net: the same game over a wire that serialises every message and delays it 120 ms each way.
// Walk a square, turn, sprint, jump; compare every predicted position with the host's position
// after the same command (they run the same stepPlayerMove), and watch the drawn player's
// correction offset. Then stand still and check client and host agree.
//   node tools/play.mjs tools/scenarios/net.mjs --query "wire=json&lag=120"
export const query = 'wire=json&lag=120';

export default async function ({ ev, step, shot, log, check }) {
  // record the prediction after every command, keyed by its seq
  const ok = await ev(() => {
    const s = window.CS.session;
    if (!s) return false;
    const pred = new Map();
    window.__pred = pred;
    window.__err = { max: 0, sum: 0, n: 0, shown: 0 };
    const orig = s.sendInput.bind(s);
    s.sendInput = (cmd) => {
      orig(cmd);
      const p = s.predicted;
      if (p) pred.set(s.seq, { x: p.x, y: p.y, z: p.z });
      if (pred.size > 400) pred.delete(pred.keys().next().value);
    };
    return true;
  });
  check(ok, 'session hooked');
  await step(20);
  const ready = await ev(() => !!window.CS.view.me);
  check(ready, 'joined through the lagged json wire');

  const measure = () =>
    ev(() => {
      const me = window.CS.view.me, sim = window.CS.sim;
      const h = sim.ctx.get(me.id);
      const e = window.__err;
      const p = window.__pred.get(h.seq);
      if (p) {
        const d = Math.hypot(h.x - p.x, h.y - p.y, h.z - p.z);
        e.max = Math.max(e.max, d);
        e.sum += d;
        e.n++;
      }
      const s = window.CS.session;
      if (s.predicted) e.shown = Math.max(e.shown, Math.hypot(me.x - s.predicted.x, me.z - s.predicted.z));
      return { seq: h.seq, unacked: s.unacked };
    });

  const legs = [
    { yaw: 0, b: 0, frames: 90 },
    { yaw: 90, b: 1, frames: 90 }, // sprint
    { yaw: 180, b: 0, frames: 60 },
    { yaw: 270, b: 4, frames: 6 }, // a jump
    { yaw: 270, b: 0, frames: 84 },
  ];
  let last = null;
  for (const leg of legs) {
    await ev((l) => {
      window.CS.look(l.yaw, -5);
      window.CS.input({ mz: 1, b: l.b });
    }, leg);
    for (let f = 0; f < leg.frames; f += 3) {
      await step(3);
      last = await measure();
    }
  }
  log('in flight at the end of the walk:', last.unacked, 'commands (about 240 ms round trip = 7 ticks)');
  await ev(() => window.CS.input(null));
  for (let f = 0; f < 45; f += 3) {
    await step(3);
    await measure();
  }
  const e = await ev(() => window.__err);
  log(`prediction error over ${e.n} samples: max ${e.max.toFixed(4)} m, mean ${(e.sum / Math.max(1, e.n)).toFixed(4)} m; drawn offset max ${e.shown.toFixed(3)} m`);
  check(e.n > 50, 'compared enough commands');
  check(e.max < 0.05, 'predicted positions match the host');
  check(e.shown < 0.6, 'the drawn player never jumps');
  const final = await ev(() => {
    const me = window.CS.view.me, h = window.CS.sim.ctx.get(me.id);
    return Math.hypot(me.x - h.x, me.z - h.z);
  });
  log('client vs host at rest', final.toFixed(4), 'm');
  check(final < 0.05, 'client and host agree at rest');
  await shot('net_end');
}
