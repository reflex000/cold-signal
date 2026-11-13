// GPU split: per frame, the render passes before the scene pass (shadow cascades, storm volume), the
// scene pass and the rest (post), median over many frames from the renderer's timestamp queries, with
// one system or pass switched off at a time. Diagnostic, no shots. WebGPU only (needs ?gpu=1).
//   node tools/play.mjs tools/scenarios/gpusplit.mjs --live 1 --q medium --w 1920 --h 1080 [--query "at=forest&only=noAO,noCover"]
// at = wreck | forest | lake | ridge; only = names from the list below (base always runs).
export const live = true;
export const query = 'gpu=1';
const VIEWS = {
  wreck: { x: -112, z: 516, yaw: 20, pitch: -4, env: { storm: 0.45, clock: 16.5, lock: true } },
  forest: { x: -405, z: 150, yaw: 75, pitch: 0, env: { storm: 0.2, clock: 13, lock: true } },
  lake: { x: 150, z: -15, yaw: 75, pitch: -2, env: { storm: 0.1, clock: 15.5, lock: true } },
  ridge: { x: 40, z: -590, yaw: 180, pitch: -8, env: { storm: 0.02, clock: 15, lock: true } },
};
export default async function ({ page, ev, log, sleep }) {
  const u = new URL(page.url());
  const v = VIEWS[u.searchParams.get('at') || 'wreck'];
  const only = (u.searchParams.get('only') || '').split(',').filter(Boolean);
  const extra = u.searchParams.get('extra') || '';
  await ev((v) => {
    window.CS.env(v.env); window.CS.go(v.x, v.z, v.yaw, v.pitch);
    const R = window.CS.engine.renderer;
    const orig = R.resolveTimestampsAsync.bind(R);
    window.__frames = new Map();
    R.resolveTimestampsAsync = async (t) => {
      const val = await orig(t);
      const p = R.backend.timestampQueryPool && R.backend.timestampQueryPool.render;
      if (p && p.timestamps) for (const [uid, d] of p.timestamps) {
        const m = uid.match(/^r:(\d+):(\d+):f(\d+)$/); if (!m) continue;
        const f = +m[3]; if (!window.__frames.has(f)) window.__frames.set(f, []);
        window.__frames.get(f).push([+m[1], +m[2], d]);
      }
      return val;
    };
  }, v);
  if (extra) await ev(extra);
  await sleep(3000);
  const measure = async () => {
    await ev(() => { window.__frames.clear(); });
    await sleep(5000);
    return ev(() => {
      const fr = [...window.__frames.values()].filter((a) => a.length > 3);
      const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
      // the scene pass is the longest pass of the frame; shadows are the calls before it
      const tot = [], sh = [], sc = [], rest = [];
      for (const a of fr) {
        a.sort((x, y) => x[0] - y[0]);
        let si = 0; for (let i = 1; i < a.length; i++) if (a[i][2] > a[si][2]) si = i;
        const t = a.reduce((s, x) => s + x[2], 0), s1 = a.slice(0, si).reduce((s, x) => s + x[2], 0);
        tot.push(t); sh.push(s1); sc.push(a[si][2]); rest.push(t - s1 - a[si][2]);
      }
      const E = window.CS.engine;
      return { n: fr.length, tot: med(tot), sh: med(sh), sc: med(sc), rest: med(rest), passes: fr.length ? fr[fr.length - 1].length : 0, calls: E.stats.calls, tris: E.stats.tris, w: E.width, h: E.height };
    });
  };
  const fx = (code) => `(() => { const E = window.CS.engine; const F = E.get('forest'); ${code} })()`;
  const vis = (re, on) => `E.scene.traverse((o) => { if (${re}.test(o.name)) o.visible = ${on}; });`;
  const T = [
    ['base', '', ''],
    ['noShadows', "E.renderer.shadowMap.enabled = false;", "E.renderer.shadowMap.enabled = true;"],
    ['noTerrain', "E.get('terrain').object.visible = false;", "E.get('terrain').object.visible = true;"],
    ['noForest', "F.group.visible = false;", "F.group.visible = true;"],
    ['noImpostor', vis('/impostor/', false), vis('/impostor/', true)],
    ['noTrees3D', vis('/forest-(spruce|fir|snag)-(full|mid)/', false), vis('/forest-(spruce|fir|snag)-(full|mid)/', true)],
    ['noRocks', vis('/forest-rocks/', false), vis('/forest-rocks/', true)],
    ['noCover', vis('/forest-cover/', false), vis('/forest-cover/', true)],
    ['noProps', "E.get('props').root.visible = false;", "E.get('props').root.visible = true;"],
    ['noSky', vis('/^sky\.dome$/', false), vis('/^sky\.dome$/', true)],
    ['noSnow', vis('/^snow\.|spindrift/', false), vis('/^snow\.|spindrift/', true)],
    ['noAO', "E.post.setQuality({ ...E.quality, ao: false });", "E.post.setQuality(E.quality);"],
    ['noBloom', "E.post.setQuality({ ...E.quality, bloom: false });", "E.post.setQuality(E.quality);"],
    ['noStorm', "E.post.setEnabled('storm', false);", "E.post.setEnabled('storm', true);"],
    ['scale50', "E.userScale = 0.5;", "E.userScale = 1;"],
  ];
  for (const [name, off, on] of T) {
    if (only.length && !only.includes(name) && name !== 'base') continue;
    if (off) await ev(fx(off));
    await sleep(1200);
    const r = await measure();
    log(`${name.padEnd(11)} total ${r.tot.toFixed(1).padStart(6)}  shadow ${r.sh.toFixed(1).padStart(5)}  scene ${r.sc.toFixed(1).padStart(6)}  rest ${r.rest.toFixed(1).padStart(5)} ms  (frames ${r.n}, passes ${r.passes}, calls ${r.calls}, ${(r.tris / 1e6).toFixed(2)}M tris, ${r.w}x${r.h})`);
    if (on) await ev(fx(on));
    await sleep(600);
  }
}
