// The README's pictures: scenes of the real game at 1600 x 900, written straight into media/ as small
// JPEGs (and as full-quality copies in shots/media_*.jpg to judge): the wreck, the trail to the cabin
// (with the HUD as a player sees it), a campfire at night, the storm, the fishing hut on the lake, the
// cabin, the tower, two survivors at their fire with a wolf circling, the aurora. The README uses eight.
//   node tools/play.mjs tools/scenarios/media.mjs --q high [--only fire,aurora]
import path from 'node:path';
import fs from 'node:fs';

export const query = 'bots=1';

const MEDIA_QUALITY = 74;

export default async function ({ page, ev, step, shot, log, check, args }) {
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const want = (name) => !only || only.has(name);
  const media = path.resolve('media');
  fs.mkdirSync(media, { recursive: true });

  const ui = (on) => ev((v) => {
    const el = document.getElementById('ui');
    if (el) el.style.display = v ? '' : 'none';
  }, on);
  const save = async (name, withUi = false) => {
    await ui(withUi);
    await ev(() => window.CS.shotReady());
    await shot('media_' + name);
    await page.screenshot({ path: path.join(media, name + '.jpg'), type: 'jpeg', quality: MEDIA_QUALITY, timeout: 180000 });
    const kb = Math.round(fs.statSync(path.join(media, name + '.jpg')).size / 1024);
    log(`media/${name}.jpg ${kb} KB`);
    await ui(true);
  };
  const env = async (e, settle = 10) => {
    await ev((x) => window.CS.env(x), { lock: true, ...e });
    await step(settle);
  };
  const go = async (c, settle = 8) => {
    await ev((c) => window.CS.go(c.x, c.z, c.yaw, c.pitch), c);
    await step(settle);
  };
  // the companion out of the picture: a few metres behind the camera (she walks back in a while later)
  const mateBehind = (back = 7) =>
    ev((back) => {
      const CS = window.CS, me = CS.view.me, yaw = CS.view.camera.yaw;
      for (const id of Object.keys(CS.game.botsDoing()).filter((k) => k !== 'auto').map(Number)) {
        CS.game.host.botAct(id, { t: 'debug', cmd: 'tp', args: [me.x + Math.sin(yaw) * back, me.z + Math.cos(yaw) * back] });
      }
    }, back);
  // a viewpoint in front of a place, looking at it (as tour.mjs finds them)
  const viewOf = (id, dists = [21, 15, 28, 11], lift = 2) =>
    ev(([id, dists, lift]) => {
      const w = window.CS.world;
      const p = w.poi(id);
      const yawTo = (x, z, tx, tz) => (Math.atan2(-(tx - x), -(tz - z)) * 180) / Math.PI;
      for (const d of dists) {
        for (const a of [0.45, -0.45, 0, 0.9, -0.9, 1.4, -1.4, 2.2, -2.2, Math.PI]) {
          const ang = p.yaw + a;
          const x = p.x + Math.sin(ang) * d, z = p.z + Math.cos(ang) * d;
          if (!w.walkable(x, z) || w.slopeAt(x, z) > 0.33) continue;
          if (!w.lineClear(x, w.heightAt(x, z) + 1.66, z, p.x, p.y + 2.5, p.z)) continue;
          const eye = w.heightAt(x, z) + 1.66;
          return { x, z, yaw: yawTo(x, z, p.x, p.z), pitch: (Math.atan2(p.y + lift - eye, d) * 180) / Math.PI };
        }
      }
      return null;
    }, [id, dists, lift]);

  // ---------------------------------------------------------------- the wreck at dusk: the torn end, the barrel fire
  if (want('wreck')) {
    await env({ storm: 0.22, clock: 17.25 });
    const c = await ev(() => {
      const f = window.CS.world.props.find((p) => p.model === 'fuselage');
      const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
      const at = (lx, lz) => ({ x: f.x + lx * c + lz * s, z: f.z - lx * s + lz * c });
      const eye = at(-2.6, -16), tgt = at(1.2, -8); // out along the scar, looking back into the break
      return { x: eye.x, z: eye.z, yaw: (Math.atan2(-(tgt.x - eye.x), -(tgt.z - eye.z)) * 180) / Math.PI, pitch: -2 };
    });
    await go(c, 40);
    await step(150, 1 / 15); // the barrel fire's light settles, the companion wanders in
    await go(c, 10);
    await save('wreck');
  }

  // ---------------------------------------------------------------- the trail through the forest, HUD up
  if (want('forest')) {
    await env({ storm: 0.15, clock: 16.5 });
    const c = await ev(() => {
      const w = window.CS.world, r = w.route, cabin = w.poi('cabin');
      // on the trail about 50 m before the cabin, the trees opening on it in the low sun
      let k = 0, best = Infinity;
      for (let i = 0; i < r.length; i++) {
        const d = Math.hypot(r[i].x - cabin.x, r[i].z - cabin.z);
        if (d < best) { best = d; k = i; }
      }
      let j = k, acc = 0;
      while (j > 1 && acc < 50) { acc += Math.hypot(r[j].x - r[j - 1].x, r[j].z - r[j - 1].z); j--; }
      const a = r[j];
      const eye = w.heightAt(a.x, a.z) + 1.66, d = Math.hypot(cabin.x - a.x, cabin.z - a.z);
      return { x: a.x, z: a.z, yaw: (Math.atan2(-(cabin.x - a.x), -(cabin.z - a.z)) * 180) / Math.PI, pitch: (Math.atan2(cabin.y + 2 - eye, d) * 180) / Math.PI };
    });
    await go(c, 40);
    await step(240, 1 / 15); // the place card that greets the start fades
    await go(c, 10);
    await save('forest', true);
  }

  // ---------------------------------------------------------------- a campfire at night, the companion by it
  let fireSpot = null;
  if (want('fire') || want('whiteout')) {
    await env({ storm: 0.22, clock: 21.2 }, 4);
    fireSpot = await ev(() => {
      const w = window.CS.world, r = w.route, lake = w.poi('lake'), cabin = w.poi('cabin');
      // open ground in the forest between the cabin and the lake, off the trail a little
      for (let t = 0.35; t < 0.8; t += 0.05) {
        const x = cabin.x + (lake.x - cabin.x) * t + 9, z = cabin.z + (lake.z - cabin.z) * t;
        if (w.walkable(x, z) && w.slopeAt(x, z) < 0.15 && w.forestAt(x, z) > 0.25) return { x, z };
      }
      const m = r[Math.floor(r.length * 0.4)];
      return { x: m.x + 8, z: m.z };
    });
    await go({ ...fireSpot, yaw: 0, pitch: -35 }, 4);
    await ev(() => {
      window.CS.give('stick', 6);
      window.CS.give('matches', 3);
      window.CS.give('tinder', 2);
      window.CS.act({ t: 'buildFire' });
    });
    await step(10);
    const id = await ev(() => {
      const me = window.CS.view.me;
      let best = null, bd = 1e9;
      for (const f of window.CS.view.list('fire')) {
        const d = Math.hypot(f.x - me.x, f.z - me.z);
        if (f.type === 'campfire' && d < bd) { bd = d; best = f; }
      }
      return best ? best.id : 0;
    });
    check(id > 0, 'a campfire was laid for the pictures');
    for (let tries = 0; tries < 4; tries++) {
      await ev((id) => window.CS.act({ t: 'ignite', fire: id }), id);
      await step(60);
      const lit = await ev((id) => window.CS.view.ents.get(id)?.lit, id);
      if (lit) break;
    }
    await ev((id) => { window.CS.act({ t: 'feed', fire: id, item: 'stick' }); window.CS.act({ t: 'feed', fire: id, item: 'stick' }); }, id);
    await step(600, 1 / 15); // the fire catches; the companion comes to it
    fireSpot.id = id;
  }
  const fireView = async (back, height, side) => {
    const c = await ev(([id, back, side]) => {
      const f = window.CS.view.ents.get(id);
      const me = window.CS.view.me;
      // stand back from the fire on the side the companion is not, looking at it
      const mate = window.CS.view.list('player').find((p) => p.id !== window.CS.view.myId);
      const ax = mate ? f.x - mate.x : 1, az = mate ? f.z - mate.z : 0;
      const l = Math.hypot(ax, az) || 1;
      const ux = ax / l, uz = az / l;
      const x = f.x + ux * back - uz * side, z = f.z + uz * back + ux * side;
      return { x, z, yaw: (Math.atan2(-(f.x - x), -(f.z - z)) * 180) / Math.PI, fx: f.x, fy: f.y, fz: f.z, me: me.y };
    }, [fireSpot.id, back, side]);
    await go({ x: c.x, z: c.z, yaw: c.yaw, pitch: height }, 30);
  };
  if (want('fire') && fireSpot) {
    await fireView(4.2, -14, 1.2);
    await save('fire');
  }

  // ---------------------------------------------------------------- the storm closing in on that fire
  if (want('whiteout') && fireSpot) {
    await env({ storm: 0.8, clock: 15.2 }, 30);
    await fireView(5.5, -8, -1.5);
    await step(60);
    await save('whiteout');
  }

  // ---------------------------------------------------------------- the hut on the lake: close, its chimney
  // smoking, the cliff behind, on a clear afternoon (a low sun leaves the clear ice in front a dark smear)
  if (want('lake')) {
    await env({ storm: 0.05, clock: 14.5 });
    const c = await ev(() => {
      const w = window.CS.world, p = w.poi('hut');
      for (const [a, d] of [[-0.9, 18], [-0.9, 22], [0.45, 18], [-0.45, 18]]) {
        const x = p.x + Math.sin(p.yaw + a) * d, z = p.z + Math.cos(p.yaw + a) * d;
        if (!w.walkable(x, z) || !w.lineClear(x, w.heightAt(x, z) + 1.66, z, p.x, p.y + 2.5, p.z)) continue;
        const eye = w.heightAt(x, z) + 1.66;
        return { x, z, yaw: (Math.atan2(-(p.x - x), -(p.z - z)) * 180) / Math.PI, pitch: (Math.atan2(p.y + 1 - eye, d) * 180) / Math.PI };
      }
      return null;
    });
    if (c) {
      await go(c, 40);
      await mateBehind();
      await step(2);
      await save('lake');
    } else check(false, 'no viewpoint on the lake');
  }

  // ---------------------------------------------------------------- the cabin in the deep forest (on request:
  // --only cabin; the README does not use it)
  if (only && only.has('cabin')) {
    await env({ storm: 0.12, clock: 16.2 });
    const c = await viewOf('cabin', [17, 13, 22]);
    if (c) {
      await go(c, 40);
      await save('cabin');
    } else check(false, 'no viewpoint on the cabin');
  }

  // ---------------------------------------------------------------- the tower on the ridge
  if (want('tower')) {
    await env({ storm: 0.1, clock: 16.6 });
    const c = await viewOf('tower', [30, 24, 38], 14);
    if (c) {
      await go(c, 40);
      await save('tower');
    } else check(false, 'no viewpoint on the tower');
  }

  // ---------------------------------------------------------------- two survivors at night, a pack closing in
  // (photo mode's chase view from behind the player; while the pack finds them the companion lays a fire,
  // and a wolf circles out past her)
  if (want('together')) {
    await env({ storm: 0.15, clock: 22.3 }, 10);
    const spot = await ev(() => {
      const w = window.CS.world, cabin = w.poi('cabin'), lake = w.poi('lake');
      // open, level snow between the cabin and the lake, room for a pack to circle
      for (let t = 0.3; t < 0.85; t += 0.05) {
        const x = cabin.x + (lake.x - cabin.x) * t - 14, z = cabin.z + (lake.z - cabin.z) * t + 6;
        if (w.walkable(x, z) && w.slopeAt(x, z) < 0.12 && w.forestAt(x, z) < 0.35) return { x, z };
      }
      return { x: cabin.x + 60, z: cabin.z - 30 };
    });
    await go({ ...spot, yaw: 0, pitch: -4 }, 6);
    await ev(() => {
      window.CS.give('flashlight', 1);
      window.CS.equip('flashlight');
    });
    await step(6);
    await ev(() => {
      if (!window.CS.view.me.lightOn) window.CS.act({ t: 'toggleLight' });
    });
    await ev((s) => window.CS.act({ t: 'debug', cmd: 'wolves', args: [s.x + 45, s.z - 20, 4] }), spot);
    // let them find the player, stalk and close in; the picture wants the nearest wolf out in the open,
    // in range of the light and not behind the companion (`apart`: degrees between them seen from here)
    const nearWolf = () =>
      ev(() => {
        const CS = window.CS, me = CS.view.me;
        const mate = CS.view.list('player').find((p) => p.id !== CS.view.myId);
        let best = null, bd = 1e9;
        for (const w of CS.view.list('wolf')) {
          const d = Math.hypot(w.x - me.x, w.z - me.z);
          if (w.mood !== 'dead' && d < bd) { bd = d; best = { x: w.x, y: w.y, z: w.z, d, mood: w.mood, apart: 180 }; }
        }
        if (best && mate) {
          let da = Math.abs(Math.atan2(best.x - me.x, best.z - me.z) - Math.atan2(mate.x - me.x, mate.z - me.z));
          if (da > Math.PI) da = 2 * Math.PI - da;
          best.apart = (da * 180) / Math.PI;
        }
        return best;
      });
    const framed = (n) => !!n && n.d > 4 && n.d < 14 && n.apart > 24 && n.mood !== 'flee' && n.mood !== 'cower';
    let near = null;
    for (let i = 0; i < 40; i++) {
      await step(90, 1 / 15);
      near = await nearWolf();
      if (!framed(near)) continue;
      await ev((n) => {
        const me = window.CS.view.me;
        const yaw = (Math.atan2(-(n.x - me.x), -(n.z - me.z)) * 180) / Math.PI;
        const pitch = (Math.atan2(n.y + 0.5 - (me.y + 1.66), n.d) * 180) / Math.PI;
        window.CS.look(yaw, pitch);
      }, near);
      await ev(() => window.CS.input({ mx: 0, mz: 0, b: 16 })); // raise the light: the beam finds the eyes
      await step(20);
      near = await nearWolf();
      if (framed(near)) break;
      await ev(() => window.CS.input(null));
      near = null;
    }
    if (near) {
      log(`wolves: nearest ${near.d.toFixed(1)} m, ${near.mood}, ${near.apart.toFixed(0)} degrees from the companion`);
      await ev(() => {
        const CS = window.CS, me = CS.view.me;
        let best = null, bd = 1e9;
        for (const w of CS.view.list('wolf')) {
          const d = Math.hypot(w.x - me.x, w.z - me.z);
          if (w.mood !== 'dead' && d < bd) { bd = d; best = w; }
        }
        if (!best) return;
        // the chase view sits behind the player, who covers the middle of the picture: look between the
        // wolf and the companion, so they stand either side of the player
        const mate = CS.view.list('player').find((p) => p.id !== CS.view.myId);
        const yw = Math.atan2(-(best.x - me.x), -(best.z - me.z));
        let yaw = yw;
        if (mate) {
          const ym = Math.atan2(-(mate.x - me.x), -(mate.z - me.z));
          let dy = ym - yw;
          while (dy > Math.PI) dy -= 2 * Math.PI;
          while (dy < -Math.PI) dy += 2 * Math.PI;
          yaw = Math.abs(dy) < Math.PI / 3 ? yw + dy / 2 : yw + Math.sign(dy) * 0.3;
        }
        CS.look((yaw * 180) / Math.PI, 1);
      });
      await step(3);
      // from behind the survivor (photo mode's chase view): the parka, the beam, the eyes
      await ev(() => window.CS.game.actions.photo(true));
      await step(40);
      await save('together');
      await ev(() => window.CS.game.actions.photo(false));
      await ev(() => window.CS.input(null));
    } else check(false, 'no wolf came close enough for the picture');
  }

  // ---------------------------------------------------------------- a clear night, the aurora
  if (want('aurora')) {
    // the flashlight from the night with the pack goes away: its head and the mitt filled the lower frame
    await ev(() => {
      if (window.CS.view.me.lightOn) window.CS.act({ t: 'toggleLight' });
      window.CS.equip('hands');
    });
    await env({ storm: 0, clock: 23.4 }, 30);
    const c = await ev(() => {
      const w = window.CS.world, lake = w.poi('lake');
      // out on the ice south of the hut, looking north past it to the ridge, the sky up to the curtains
      for (const d of [70, 55, 85, 40]) {
        const x = lake.x - 12, z = lake.z + d;
        if (w.walkable(x, z) && w.iceAt(x, z) > 0) return { x, z, yaw: 4, pitch: 16 };
      }
      return { x: lake.x - 12, z: lake.z + 40, yaw: 4, pitch: 16 };
    });
    await go(c, 60);
    await mateBehind(8);
    await step(2);
    const a = await ev(() => window.CS.view.env.aurora);
    log(`aurora ${a.toFixed(2)}`);
    await save('aurora');
  }
}
