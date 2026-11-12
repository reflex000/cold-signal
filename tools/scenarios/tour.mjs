// Tour: every place on the mountain from a flattering angle (in front of it, looking at it) and an
// honest one (on the trail 35 m before arriving, eye level), in a clear dusk and in a storm.
// Writes shots/tour_<place>_<angle>_<light>.jpg and contact sheets shots/tour_dusk.png, tour_storm.png.
//   node tools/play.mjs tools/scenarios/tour.mjs [--backend webgl]
export default async function ({ ev, step, shot, sheet, log, check, args }) {
  const tag = args.backend === 'webgl' ? '_gl' : args.mobile === '1' ? '_mobile' : '';
  const views = await ev(() => {
    const w = window.CS.world;
    const out = [];
    const yawTo = (x, z, tx, tz) => (Math.atan2(-(tx - x), -(tz - z)) * 180) / Math.PI;
    const pitchTo = (x, z, tx, ty, tz) => {
      const eye = w.heightAt(x, z) + 1.66;
      return (Math.atan2(ty - eye, Math.hypot(tx - x, tz - z)) * 180) / Math.PI;
    };
    for (const p of w.pois) {
      if (p.id === 'hut') continue; // the hut is shot as part of the lake
      // flattering: in front of the main structure, a little to one side, looking at it
      let fl = null;
      for (const d of p.id === 'lake' ? [30, 45] : [21, 15, 28, 11]) {
        for (const a of [0.45, -0.45, 0, 0.9, -0.9, 1.4, -1.4, 2.2, -2.2, Math.PI]) {
          const ang = p.yaw + a;
          const x = p.x + Math.sin(ang) * d, z = p.z + Math.cos(ang) * d;
          if (!w.walkable(x, z) || w.slopeAt(x, z) > 0.33) continue;
          // the place must be in sight from eye height
          if (!w.lineClear(x, w.heightAt(x, z) + 1.66, z, p.x, p.y + 2.5, p.z)) continue;
          fl = { x, z, yaw: yawTo(x, z, p.x, p.z), pitch: pitchTo(x, z, p.x, p.y + 2, p.z) };
          break;
        }
        if (fl) break;
      }
      // honest: on the route, about 35 m before the place, looking where the trail goes
      const r = w.route;
      let k = -1, best = Infinity;
      for (let i = 0; i < r.length; i++) {
        const dd = Math.hypot(r[i].x - p.x, r[i].z - p.z);
        if (dd < best) {
          best = dd;
          k = i;
        }
      }
      let j = k, acc = 0;
      while (j > 0 && acc < 35) {
        acc += Math.hypot(r[j].x - r[j - 1].x, r[j].z - r[j - 1].z);
        j--;
      }
      const hx = r[j].x, hz = r[j].z;
      const ho = { x: hx, z: hz, yaw: yawTo(hx, hz, p.x, p.z), pitch: 0 };
      out.push({ id: p.id, name: p.name, x: p.x, z: p.z, flattering: fl, honest: ho });
    }
    return out;
  });
  const lights = [
    ['dusk', { storm: 0.04, clock: 16.45, lock: true }],
    // a hard storm, short of a whiteout (about 140 m of sight)
    ['storm', { storm: 0.62, clock: 14.5, lock: true }],
  ];
  for (const [light, env] of lights) {
    await ev((e) => window.CS.env(e), env);
    await step(8);
    for (const v of views) {
      for (const angle of ['flattering', 'honest']) {
        const c = v[angle];
        if (!c) {
          check(false, `${v.id}: no ${angle} viewpoint found`);
          continue;
        }
        await ev((c) => window.CS.go(c.x, c.z, c.yaw, c.pitch), c);
        const s = await step(6);
        const me = s.me;
        check(me && Math.abs(me.x - c.x) < 1.5 && Math.abs(me.z - c.z) < 1.5, `${v.id} ${angle} ${light}: standing where sent (${me ? me.x.toFixed(1) + ', ' + me.z.toFixed(1) : 'none'})`);
        await shot(`tour_${v.id}_${angle}_${light}${tag}`, { sheet: `tour_${light}${tag}` });
      }
    }
    sheet(`tour_${light}${tag}`, 4);
  }
  log('places', views.map((v) => v.id).join(' '));
}
