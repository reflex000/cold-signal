// Look matrix: every place from a good viewpoint, plus free-camera views (the forest from 300 m up,
// the long view along the ridge), in the lights that matter: clear dusk, noon, a clear night with
// the aurora, a moonlit night, storm 0.5 and a whiteout. The HUD is hidden so the picture can be
// judged. Writes shots/look_<view>_<light><tag>.jpg and one contact sheet per light.
//   node tools/play.mjs tools/scenarios/look.mjs [--backend webgl] [--mobile 1]
//        [--query "lights=dusk,noon&views=wreck,cabin,aerial"]   (subsets; the defaults run everything)
export const query = '';

export const LIGHTS = {
  dusk: { storm: 0.04, clock: 16.45, lock: true },
  noon: { storm: 0.05, clock: 12.2, lock: true },
  aurora: { storm: 0.0, clock: 22.5, lock: true },
  moon: { storm: 0.16, clock: 1.0, lock: true },
  storm: { storm: 0.5, clock: 14.0, lock: true },
  whiteout: { storm: 1.0, clock: 14.5, lock: true },
};

export default async function ({ page, ev, step, shot, sheet, log, check, args }) {
  const tag = args.backend === 'webgl' ? '_gl' : args.mobile === '1' ? '_mobile' : '';
  const url = new URL(page.url());
  const pick = (k, all) => (url.searchParams.get(k) ? url.searchParams.get(k).split(',').filter((s) => all.includes(s)) : all);
  const lights = pick('lights', Object.keys(LIGHTS));

  await ev(() => {
    const st = document.createElement('style');
    st.textContent = '#ui { display: none !important; }';
    document.head.appendChild(st);
  });

  const views = await ev(() => {
    const w = window.CS.world;
    const out = [];
    const yawTo = (x, z, tx, tz) => (Math.atan2(-(tx - x), -(tz - z)) * 180) / Math.PI;
    for (const p of w.pois) {
      if (p.id === 'hut') continue;
      let fl = null;
      for (const d of p.id === 'lake' ? [30, 45] : [21, 15, 28, 11]) {
        for (const a of [0.45, -0.45, 0, 0.9, -0.9, 1.4, -1.4, 2.2, -2.2, Math.PI]) {
          const ang = p.yaw + a;
          const x = p.x + Math.sin(ang) * d, z = p.z + Math.cos(ang) * d;
          if (!w.walkable(x, z) || w.slopeAt(x, z) > 0.33) continue;
          if (!w.lineClear(x, w.heightAt(x, z) + 1.66, z, p.x, p.y + 2.5, p.z)) continue;
          const eye = w.heightAt(x, z) + 1.66;
          const pitch = (Math.atan2(p.y + 2 - eye, Math.hypot(p.x - x, p.z - z)) * 180) / Math.PI;
          fl = { x, z, yaw: yawTo(x, z, p.x, p.z), pitch };
          break;
        }
        if (fl) break;
      }
      if (fl) out.push({ id: p.id, ...fl });
    }
    // free cameras: [x, y above ground, z, yawDeg, pitchDeg]
    const cab = w.pois.find((p) => p.id === 'cabin');
    const tow = w.pois.find((p) => p.id === 'tower');
    const free = (id, x, up, z, yaw, pitch) => out.push({ id, free: true, x, y: w.heightAt(x, z) + up, z, yaw, pitch });
    free('aerial', cab.x + 260, 300, cab.z + 140, 60, -32); // the deep forest by the cabin from 300 m up
    free('ridge', tow.x + 30, 2.2, tow.z + 40, 160, -6); // along the ridge, down over the mountain
    free('valley', -120, 60, 700, 0, -10); // the south flank from above the wreck, looking north
    return out;
  });
  const wanted = pick('views', views.map((v) => v.id));

  for (const light of lights) {
    await ev((e) => window.CS.env(e), LIGHTS[light]);
    await step(10);
    for (const v of views) {
      if (!wanted.includes(v.id)) continue;
      if (v.free) {
        // stand near, then take the camera over for a few rendered frames (the rig would put it back)
        await ev((c) => window.CS.go(c.x, c.z, c.yaw, 0), v);
        await step(4);
        await ev((c) => {
          const cs = window.CS, cam = cs.engine.camera;
          for (let i = 0; i < 4; i++) {
            cam.position.set(c.x, c.y, c.z);
            cam.rotation.set((c.pitch * Math.PI) / 180, (c.yaw * Math.PI) / 180, 0, 'YXZ');
            cam.updateMatrixWorld();
            cs.engine.frame({ dt: 1 / 30, time: cs.view.time, view: cs.view });
          }
        }, v);
      } else {
        await ev((c) => window.CS.go(c.x, c.z, c.yaw, c.pitch), v);
        await step(6);
      }
      await shot(`look_${v.id}_${light}${tag}`, { sheet: `look_${light}${tag}` });
    }
    sheet(`look_${light}${tag}`, 4);
  }
  check(views.length >= 9, `found ${views.length} views`);
  log('views', views.map((v) => v.id).join(' '), 'lights', lights.join(' '));
}
