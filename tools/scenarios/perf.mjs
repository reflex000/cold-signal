// Perf: real frame times with the real-time loop (run with --live 1), at several views: the
// wreck, deep forest by the cabin, the lake, the long view from the ridge, and a storm. Reports
// mean fps, median and 95th percentile frame time, draw calls and triangles per view.
// The GPU is shared with other work on this machine: compare views, do not chase absolutes.
//   node tools/play.mjs tools/scenarios/perf.mjs --live 1 --q medium
export const live = true;
export const query = 'gpu=1';

export default async function ({ ev, log, check, sleep, live: isLive }) {
  check(isLive, 'running the real-time loop');
  const views = [
    { name: 'wreck', x: -112, z: 516, yaw: 20, pitch: -4, env: { storm: 0.45, clock: 16.5, lock: true } },
    { name: 'forest', x: -405, z: 150, yaw: 75, pitch: 0, env: { storm: 0.2, clock: 13, lock: true } },
    { name: 'lake', x: 150, z: -15, yaw: 75, pitch: -2, env: { storm: 0.1, clock: 15.5, lock: true } },
    { name: 'ridge', x: 40, z: -590, yaw: 180, pitch: -8, env: { storm: 0.02, clock: 15, lock: true } },
    { name: 'storm', x: 470, z: -320, yaw: 300, pitch: 0, env: { storm: 0.95, clock: 14, lock: true } },
  ];
  // CPU time of the game's own frame (input, ticks, view, camera, systems, render submit)
  await ev(() => {
    const g = window.CS.game;
    const orig = g.stepFrame.bind(g);
    window.__cpu = [];
    g.stepFrame = (dt, render) => {
      const t0 = performance.now();
      orig(dt, render);
      window.__cpu.push(performance.now() - t0);
      if (window.__cpu.length > 400) window.__cpu.shift();
    };
  });
  const rows = [];
  for (const v of views) {
    await ev((v) => {
      window.CS.env(v.env);
      window.CS.go(v.x, v.z, v.yaw, v.pitch);
    }, v);
    await sleep(1500); // settle: rebuilt instance sets, compiled pipelines
    const t = await ev(
      () =>
        new Promise((res) => {
          const out = [];
          let last = performance.now();
          const f = (now) => {
            out.push(now - last);
            last = now;
            if (out.length < 150) requestAnimationFrame(f);
            else res(out);
          };
          requestAnimationFrame(f);
        }),
    );
    const s = await ev(() => window.CS.stats());
    const cpu = await ev(() => {
      const c = window.__cpu.slice(-200).sort((a, b) => a - b);
      return { p50: c[Math.floor(c.length * 0.5)] || 0, p95: c[Math.floor(c.length * 0.95)] || 0 };
    });
    const sorted = [...t].sort((a, b) => a - b);
    const mean = t.reduce((a, b) => a + b, 0) / t.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const row = {
      view: v.name, fps: +(1000 / mean).toFixed(1), p50: +p50.toFixed(1), p95: +p95.toFixed(1), cpu50: +cpu.p50.toFixed(2), cpu95: +cpu.p95.toFixed(2),
      gpu: s.gpuMs, calls: s.calls, tris: s.tris, res: `${s.width}x${s.height}`, q: s.quality,
    };
    rows.push(row);
    log(row);
    check(s.calls < 400, `${v.name}: draw calls under 400 (${s.calls})`);
  }
  const all = rows.map((r) => r.fps);
  log(`fps over the views: min ${Math.min(...all)}, max ${Math.max(...all)}`);
}
