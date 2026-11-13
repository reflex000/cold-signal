// Places: walk the player into every wall and furniture face of every structure, and through every
// door, and check that the wall you see is the wall you hit.
//   node tools/play.mjs tools/scenarios/places.mjs [--query "only=cabin"] [--backend webgl]
// For each collider face near a site (walls, hull, rock, furniture spanning the body): start 1 m
// out, face it, hold forward, read where the simulation stopped the player, then cast rays from
// the player at knee, waist and eye height along the walk against the drawn geometry of the placed
// models (every triangle of every prop near by, glass included). gap = visible surface minus
// collider face along the walk: > 0 the visible surface is behind the face (an invisible wall),
// < 0 it stands out in front of it (the body would sink into it). Flags |gap| over the limits.
// Doors: start 1.5 m out, walk in for 2.4 s, require 0.7 m inside, and no drawn geometry in the
// doorway at body heights (the door leaves are parts the driver swings: not tested).
// Writes shots/places_<place>_door.jpg and places_<place>_in.jpg; exits non-zero on failures.
export default async function ({ ev, step, shot, log, check, args }) {
  const only = (args.query ?? '').match(/only=(\w+)/)?.[1];
  // ---- page-side helpers: a brute-force ray against the props' triangles ----
  await ev(() => {
    const CS = window.CS;
    const props = CS.engine.get('props');
    const tri = (o, d, a, b, c) => {
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
      const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) return Infinity;
      const inv = 1 / det;
      const tx = o[0] - a[0], ty = o[1] - a[1], tz = o[2] - a[2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) return Infinity;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) return Infinity;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      return t > 1e-4 ? t : Infinity;
    };
    const hitGeo = (geo, o, d, maxD) => {
      if (!geo) return Infinity;
      const bb = geo.boundingBox;
      if (bb) {
        // slab test first
        let t0 = 0, t1 = maxD;
        for (let k = 0; k < 3; k++) {
          const lo = [bb.min.x, bb.min.y, bb.min.z][k], hi = [bb.max.x, bb.max.y, bb.max.z][k];
          if (Math.abs(d[k]) < 1e-9) { if (o[k] < lo || o[k] > hi) return Infinity; continue; }
          let a = (lo - o[k]) / d[k], b = (hi - o[k]) / d[k];
          if (a > b) [a, b] = [b, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, b);
          if (t0 > t1) return Infinity;
        }
      }
      const pos = geo.attributes.position.array, idx = geo.index.array;
      // snow drifts are walk-through geometry (MAT.SNOW = 0 in aDetail.w): not a wall
      const mat = geo.attributes.aDetail ? geo.attributes.aDetail.array : null;
      let best = Infinity;
      const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
      for (let i = 0; i < idx.length; i += 3) {
        if (mat && mat[idx[i] * 4 + 3] < 0.5) continue;
        const ia = idx[i] * 3, ib = idx[i + 1] * 3, ic = idx[i + 2] * 3;
        A[0] = pos[ia]; A[1] = pos[ia + 1]; A[2] = pos[ia + 2];
        B[0] = pos[ib]; B[1] = pos[ib + 1]; B[2] = pos[ib + 2];
        C[0] = pos[ic]; C[1] = pos[ic + 1]; C[2] = pos[ic + 2];
        const t = tri(o, d, A, B, C);
        if (t < best) best = t;
      }
      return best;
    };
    window.__pl = {
      /** Nearest drawn surface of any prop along the ray (world), or Infinity. */
      ray(ox, oy, oz, dx, dy, dz, maxD) {
        let best = Infinity;
        for (const id of props.near(ox, oz, 16)) {
          const inst = props.inst(id), def = props.model(id);
          if (!inst || !def) continue;
          const s = inst.scale || 1, c = Math.cos(inst.yaw), sn = Math.sin(inst.yaw);
          // world -> model: undo the translation, Ry(yaw) and the scale
          const wx = ox - inst.x, wy = oy - inst.y, wz = oz - inst.z;
          const o = [(wx * c - wz * sn) / s, wy / s, (wx * sn + wz * c) / s];
          const d = [dx * c - dz * sn, dy, dx * sn + dz * c];
          for (const g of [def.geometry, def.glass]) {
            const t = hitGeo(g, o, d, maxD / s) * s;
            if (t < best) best = t;
          }
          // named parts at rest (cupboard and locker doors shut, slots empty); not the door
          // leaves (the driver swings them open as you come) nor lights
          for (const name in def.parts) {
            if (name === 'door' || name.startsWith('glow') || name.startsWith('slot_') || name === 'lamps' || name === 'beacon' || name === 'panel_lights') continue;
            const pt = def.parts[name];
            const po = [o[0] - pt.pivot.x, o[1] - pt.pivot.y, o[2] - pt.pivot.z];
            for (const g of [pt.geometry, pt.glass]) {
              const t = hitGeo(g, po, d, maxD / s) * s;
              if (t < best) best = t;
            }
          }
        }
        return best;
      },
    };
  });

  // ---- the tests, built from the world's own colliders near each site ----
  const plan = await ev((only) => {
    const CS = window.CS, w = CS.world;
    const R = 0.32;
    const sites = ['wreck', 'tail', 'cabin', 'hut', 'cave', 'camp', 'tower'].filter((p) => !only || p === only);
    const out = [];
    const inBox = (c, x, z, pad) => {
      if (c.s === 'c') return Math.hypot(x - c.x, z - c.z) < c.r + pad;
      const dx = x - c.x, dz = z - c.z, co = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      const lx = dx * co - dz * sn, lz = dx * sn + dz * co;
      return Math.abs(lx) < c.hx + pad && Math.abs(lz) < c.hz + pad;
    };
    for (const id of sites) {
      const p = w.poi(id);
      const near = w.collidersNear(p.x, p.z, 17).filter((c) => c.s === 'b' && c.y1 - c.y0 > 0.4 && !(c.hx < 0.5 && c.hz < 0.5 && c.y1 - c.y0 > 5));
      for (const c of near) {
        const co = Math.cos(c.yaw), sn = Math.sin(c.yaw);
        const ax = [co, -sn], az = [sn, co]; // box local X and Z in world (three.js rotation.y)
        const faces = [];
        if (c.hx > 0.12) faces.push([az, c.hz, ax, c.hx], [[-az[0], -az[1]], c.hz, ax, c.hx]);
        if (c.hz > 0.12 && c.hx < 2.5) faces.push([ax, c.hx, az, c.hz], [[-ax[0], -ax[1]], c.hx, az, c.hz]);
        for (const [n, h, t, ht] of faces) {
          const offs = ht > 2.2 ? [-0.6 * ht, 0, 0.6 * ht] : [0];
          for (const off of offs) {
            const fx = c.x + n[0] * h + t[0] * off, fz = c.z + n[1] * h + t[1] * off;
            const sx = fx + n[0] * 1.0, sz = fz + n[1] * 1.0;
            // the start must be free, the walk to the face clear of other colliders
            const others = w.collidersNear(sx, sz, 3).filter((q) => q !== c && !(q.s === c.s && q.x === c.x && q.z === c.z && q.yaw === c.yaw));
            let ok = true;
            for (let k = 0; k <= 6 && ok; k++) {
              const qx = sx - n[0] * (k / 6) * (1.0 - R), qz = sz - n[1] * (k / 6) * (1.0 - R);
              for (const q of others) if (inBox(q, qx, qz, R + 0.02)) { ok = false; break; }
            }
            if (!ok) continue;
            const g = w.groundAt(sx, sz, c.y0 + 2.5).y;
            if (g + 1.6 < c.y0 || g + 0.4 > c.y1) continue; // the face does not span the body
            if (Math.abs(w.groundAt(fx - n[0] * 0.05, fz - n[1] * 0.05, g + 0.6).y - g) > 0.6) continue;
            // site-local position and facing, and the box, for the report
            const pc = Math.cos(p.yaw), ps = Math.sin(p.yaw);
            const lx = (fx - p.x) * pc - (fz - p.z) * ps, lz = (fx - p.x) * ps + (fz - p.z) * pc;
            const lnx = n[0] * pc - n[1] * ps, lnz = n[0] * ps + n[1] * pc;
            out.push({ site: id, sx, sz, fx, fz, nx: n[0], nz: n[1], yaw: (Math.atan2(n[0], n[1]) * 180) / Math.PI, y0: c.y0, y1: c.y1, lx, lz, lnx, lnz, box: `${(2 * c.hx).toFixed(2)}x${(2 * c.hz).toFixed(2)}x${(c.y1 - c.y0).toFixed(2)}`, tall: c.y1 - c.y0 >= 2.0 });
          }
        }
      }
    }
    return out;
  }, only);
  log(`faces to walk into: ${plan.length}`);

  const bad = [];
  let n = 0;
  for (const t of plan) {
    await ev((t) => window.CS.go(t.sx, t.sz, t.yaw, 0), t);
    await ev(() => window.CS.input({ mz: 1 }));
    await step(36);
    await ev(() => window.CS.input(null));
    const res = await ev((t) => {
      const CS = window.CS, me = CS.view.me;
      const dist = (me.x - t.fx) * t.nx + (me.z - t.fz) * t.nz;
      const gaps = [];
      // knee, waist, eye, and for low furniture its top edge
      const hs = [0.35, 1.0, 1.6];
      if (t.y1 - me.y < 1.65) hs.push(t.y1 - me.y - 0.05);
      for (const hgt of hs) {
        const y = me.y + hgt;
        if (y < t.y0 + 0.05 || y > t.y1 - 0.04) { gaps.push(null); continue; }
        const d = window.__pl.ray(me.x, y, me.z, -t.nx, 0, -t.nz, 2.5);
        gaps.push(d === Infinity ? 9 : d - dist);
      }
      return { dist, gaps, x: me.x, z: me.z };
    }, t);
    n++;
    const g = res.gaps.filter((v) => v !== null);
    const lateral = Math.hypot(res.x - (t.fx + t.nx * res.dist), res.z - (t.fz + t.nz * res.dist));
    if (res.dist > 0.7 || lateral > 0.5) continue; // stopped by something else on the way (or slid off): not this face
    const sinks = g.some((v) => v < -0.14);
    // open furniture (tables, bunks, seats, shelves) reads as a solid box only to the walk: an
    // invisible wall counts for wall-height boxes, or when even the top edge shows nothing
    const invisible = g.length > 0 && g.every((v) => v > 0.16) && (t.tall || g[g.length - 1] > 0.3);
    if (sinks || invisible) bad.push({ ...t, ...res, why: sinks ? 'sinks into the drawn surface' : 'invisible wall' });
  }
  log(`walked into ${n} faces; ${bad.length} mismatched`);
  for (const b of bad) log(`  ${b.site} local (${b.lx.toFixed(2)}, ${b.lz.toFixed(2)}) walking (${(-b.lnx).toFixed(2)}, ${(-b.lnz).toFixed(2)}) box ${b.box}: stopped ${b.dist.toFixed(2)} m; gaps knee/waist/eye/top ${b.gaps.map((v) => (v === null ? '-' : v.toFixed(2))).join(' / ')}: ${b.why}`);
  check(bad.length === 0, `every wall drawn where it collides (${bad.length} mismatches)`);

  // ---- doors: walk in through each, nothing drawn in the way ----
  const doors = await ev((only) => {
    const CS = window.CS;
    return CS.view.list('device').filter((d) => d.type === 'door' && (!only || d.poi === only || (only === 'hut' && d.poi === 'hut'))).map((d) => ({ poi: d.poi, x: d.x, z: d.z, yaw: d.yaw }));
  }, only);
  for (const d of doors) {
    const f = [Math.sin(d.yaw), Math.cos(d.yaw)];
    const s = { x: d.x + f[0] * 1.5, z: d.z + f[1] * 1.5 };
    const yawDeg = (Math.atan2(f[0], f[1]) * 180) / Math.PI;
    await ev((a) => window.CS.go(a.x, a.z, a.yaw, -8), { ...s, yaw: yawDeg });
    await step(4);
    const blocked = await ev((a) => {
      const CS = window.CS, me = CS.view.me;
      const hits = [];
      for (const hgt of [0.45, 1.0, 1.6]) {
        for (const side of [-0.18, 0, 0.18]) {
          const ox = a.x + a.f[1] * side, oz = a.z - a.f[0] * side;
          const t = window.__pl.ray(ox, me.y + hgt, oz, -a.f[0], 0, -a.f[1], 2.3);
          if (t < 2.3) hits.push(`${hgt}/${side}: ${t.toFixed(2)}`);
        }
      }
      return hits;
    }, { x: s.x, z: s.z, f });
    await shot(`places_${d.poi}_door`);
    await ev(() => window.CS.input({ mz: 1 }));
    await step(72);
    await ev(() => window.CS.input(null));
    const inside = await ev((a) => {
      const me = window.CS.view.me;
      return -((me.x - a.x) * a.f[0] + (me.z - a.z) * a.f[1]);
    }, { x: d.x, z: d.z, f });
    log(`door ${d.poi}: ${inside.toFixed(2)} m inside after walking in${blocked.length ? '; drawn in the doorway: ' + blocked.join(', ') : ''}`);
    check(inside > 0.7, `${d.poi}: walked in through the door (${inside.toFixed(2)} m)`);
    check(blocked.length === 0, `${d.poi}: doorway clear (${blocked.join(', ')})`);
    await step(10);
    await shot(`places_${d.poi}_in`);
  }
}
