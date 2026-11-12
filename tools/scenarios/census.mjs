// Where the triangles and draw calls go: every mesh in the scene with its instance count and
// triangle total, at the spawn and at a forest spot. Diagnostic, no shots.
//   node tools/play.mjs tools/scenarios/census.mjs
export default async function ({ ev, step, log }) {
  const census = () =>
    ev(() => {
      const out = [];
      window.CS.engine.scene.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        const g = o.geometry;
        const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        const n = o.isInstancedMesh ? o.count : 1;
        const range = g.drawRange && Number.isFinite(g.drawRange.count) ? Math.min(g.drawRange.count / 3, tri) : tri;
        out.push({ name: o.name || o.type, n, tri: Math.round(range), total: Math.round(range * n), shadow: o.castShadow });
      });
      out.sort((a, b) => b.total - a.total);
      return out.slice(0, 14);
    });
  await step(10);
  for (const r of await census()) log(r);
  const s = await step(2);
  log('calls', s.calls, 'tris', s.tris);
  await ev(() => window.CS.go(-430, 160, 0, 0));
  await step(10);
  log('--- forest near the cabin');
  for (const r of await census()) log(r);
  const s2 = await step(2);
  log('calls', s2.calls, 'tris', s2.tris);
}
