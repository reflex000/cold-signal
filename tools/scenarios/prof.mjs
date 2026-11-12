// Profile: CPU milliseconds per frame in each part of the game's frame and in each GfxSystem's
// update, with the real-time loop. Diagnostic, no shots.
//   node tools/play.mjs tools/scenarios/prof.mjs --live 1
export const live = true;

export default async function ({ ev, log, sleep }) {
  await ev(() => {
    const g = window.CS.game;
    const acc = (window.__prof = {});
    const wrap = (obj, key, label) => {
      const f = obj[key].bind(obj);
      obj[key] = (...a) => {
        const t0 = performance.now();
        const r = f(...a);
        const e = acc[label] || (acc[label] = { t: 0, n: 0 });
        e.t += performance.now() - t0;
        e.n++;
        return r;
      };
    };
    wrap(g, 'stepFrame', 'frame (all)');
    wrap(g.engine, 'frame', 'engine.frame');
    wrap(g.engine.post, 'render', 'post.render');
    wrap(g.ui, 'update', 'ui.update');
    wrap(g.view, 'update', 'view.update');
    wrap(g.sound, 'update', 'sound.update');
    wrap(g.hud, 'update', 'hud.update');
    wrap(g.focus, 'update', 'focus.update');
    wrap(g.input, 'update', 'input.update');
    if (g.session) wrap(g.session, 'advance', 'session.advance');
    for (const s of g.engine.systems) wrap(s, 'update', 'sys:' + s.name);
  });
  await ev(() => window.CS.go(-112, 516, 20, -4));
  await sleep(1500);
  await ev(() => {
    for (const k in window.__prof) window.__prof[k] = { t: 0, n: 0 };
  });
  await sleep(4000);
  const p = await ev(() => window.__prof);
  const rows = Object.entries(p)
    .map(([k, v]) => ({ part: k, ms: +(v.t / Math.max(1, v.n)).toFixed(3), calls: v.n }))
    .sort((a, b) => b.ms - a.ms);
  for (const r of rows) log(r);
}
