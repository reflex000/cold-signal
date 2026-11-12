// Walk: hold forward for 20 s of sim time on firm, level snow and check the distance against the
// walking speed; then wade into a deep drift and check the player slowed; all the way, check the
// feet stay on the ground (never through the world) and the camera at eye height.
//   node tools/play.mjs tools/scenarios/walk.mjs
export default async function ({ ev, step, shot, log, check }) {
  // find a straight, level, walkable 60 m line with shallow snow, and a deep drift
  const spots = await ev(() => {
    const w = window.CS.world;
    const lineOk = (x, z, dx, dz, len, test) => {
      for (let s = 0; s <= len; s += 2) if (!test(x + dx * s, z + dz * s)) return false;
      return true;
    };
    const firm = (x, z) => w.walkable(x, z) && w.slopeAt(x, z) < 0.09 && w.snowDepthAt(x, z) < 0.28 && w.iceAt(x, z) <= 0 && w.surfaceAt(x, z) !== 'rock';
    const deep = (x, z) => w.walkable(x, z) && w.slopeAt(x, z) < 0.08 && w.snowDepthAt(x, z) > 0.42 && w.iceAt(x, z) <= 0;
    let a = null, b = null;
    for (let r = 0; r < 700 && (!a || !b); r += 9) {
      for (let k = 0; k < 24 && (!a || !b); k++) {
        const ang = (k / 24) * Math.PI * 2 + r * 0.013;
        const x = -120 + Math.sin(ang) * r, z = 300 + Math.cos(ang) * r * 0.9;
        for (let d = 0; d < 8; d++) {
          const da = (d / 8) * Math.PI * 2;
          const dx = -Math.sin(da), dz = -Math.cos(da);
          if (!a && lineOk(x, z, dx, dz, 62, firm)) {
            // what move.ts should make of this snow: mean speed factor along the first 52 m
            let f = 0, n = 0;
            for (let s = 0; s <= 52; s += 1) {
              const dep = w.snowDepthAt(x + dx * s, z + dz * s);
              f += dep <= 0.1 ? 1 : Math.max(0.45, 1 - (dep - 0.1));
              n++;
            }
            a = { x, z, yaw: (da * 180) / Math.PI, factor: f / n };
          }
          if (!b && lineOk(x, z, dx, dz, 16, deep)) b = { x, z, yaw: (da * 180) / Math.PI, depth: w.snowDepthAt(x + dx * 8, z + dz * 8) };
        }
      }
    }
    return { firm: a, deep: b };
  });
  log('firm line', spots.firm, 'deep drift', spots.deep);
  check(!!spots.firm, 'found a firm level line');
  check(!!spots.deep, 'found a deep drift');

  const walk = async (spot, seconds, label) => {
    await ev((s) => window.CS.go(s.x, s.z, s.yaw, -8), spot);
    await step(15);
    const start = await ev(() => ({ x: window.CS.view.me.x, z: window.CS.view.me.z }));
    await ev(() => window.CS.input({ mz: 1 }));
    let worst = 0, worstEye = 0, minEye = 9;
    const n = Math.round(seconds * 30);
    for (let t = 0; t < n; t += 30) {
      await step(30);
      const g = await ev(() => {
        const me = window.CS.view.me, w = window.CS.world, c = window.CS.view.camera;
        const gy = w.groundAt(me.x, me.z, me.y + 0.6).y;
        return { dy: me.y - gy, eye: c.y - me.y, onGround: me.onGround };
      });
      worst = Math.max(worst, Math.abs(g.dy));
      worstEye = Math.max(worstEye, g.eye);
      minEye = Math.min(minEye, g.eye);
    }
    await ev(() => window.CS.input(null));
    const end = await step(20);
    const d = Math.hypot(end.me.x - start.x, end.me.z - start.z);
    log(`${label}: ${d.toFixed(1)} m in ${seconds} s (${(d / seconds).toFixed(2)} m/s), feet off the ground at most ${worst.toFixed(2)} m, eye ${minEye.toFixed(2)}..${worstEye.toFixed(2)} m`);
    check(worst < 0.25, `${label}: feet stayed on the ground`);
    check(minEye > 1.45 && worstEye < 1.8, `${label}: camera at eye height`);
    return d / seconds;
  };

  let firmSpeed = 0;
  if (spots.firm) {
    firmSpeed = await walk(spots.firm, 20, 'firm snow');
    // walking pace is 2.6 m/s, slowed by loose snow (sim/move snowSpeedFactor) and a gentle slope
    const want = 2.6 * spots.firm.factor;
    check(firmSpeed > want * 0.85 && firmSpeed < want * 1.05, `firm snow: walking pace (${firmSpeed.toFixed(2)} m/s, expected about ${want.toFixed(2)})`);
    await shot('walk_firm');
  }
  if (spots.deep) {
    const deepSpeed = await walk(spots.deep, 5, 'deep drift');
    check(deepSpeed < firmSpeed * 0.8, `deep drift: slowed (${deepSpeed.toFixed(2)} vs ${firmSpeed.toFixed(2)} m/s, depth ${spots.deep.depth.toFixed(2)} m)`);
    await shot('walk_deep');
  }
  // prediction and the host agree after the walk
  const err = await ev(() => {
    const me = window.CS.view.me, h = window.CS.sim.ctx.get(me.id);
    return Math.hypot(me.x - h.x, me.z - h.z);
  });
  log('client vs host after the walk', err.toFixed(3), 'm');
  check(err < 0.2, 'prediction agrees with the host');
}
