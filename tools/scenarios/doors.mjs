// Doors open from the sim's door devices: USE on the cabin, hut and shed doors toggles the device
// (OBJECTIVE), STRUCTURES' driver swings the drawn door part to match; standing back, it stays open,
// USE again closes it. Checks the device on the client and the angle of the drawn part.
//   node tools/play.mjs tools/scenarios/doors.mjs [--backend webgl]
export default async function ({ ev, step, shot, log, check }) {
  // the structure driver eases a door by the time between DRAWN frames: draw every one
  const drawn = async (n) => {
    for (let i = 0; i < n; i += 2) await step(2, 1 / 60);
  };
  await step(10);
  await ev(() => window.CS.env({ storm: 0.1, clock: 12.5, lock: true }));
  const doors = await ev(() => window.CS.view.list('device').filter((d) => d.type === 'door').map((d) => ({ id: d.id, poi: d.poi, x: d.x, y: d.y, z: d.z, yaw: d.yaw })));
  check(doors.length >= 3, `three doors (${doors.map((d) => d.poi).join(', ')})`);
  const angle = (poi) => ev((poi) => {
    const props = window.CS.engine.get('props');
    const model = { cabin: 'cabin', hut: 'fishing_hut', tower: 'tower_shed' }[poi];
    if (!props || !model) return null;
    let best = null;
    for (const id of props.find(model)) {
      const part = props.part(id, 'door');
      if (part) best = 2 * Math.acos(Math.min(1, Math.abs(part.quaternion.w)));
    }
    return best;
  }, poi);
  for (const d of doors) {
    // stand 2 m out in front of the door, looking at it
    const f = [Math.sin(d.yaw), Math.cos(d.yaw)];
    await ev((a) => {
      const x = a.x + a.f[0] * 2.2, z = a.z + a.f[1] * 2.2;
      const yaw = (Math.atan2(a.f[0], a.f[1]) * 180) / Math.PI;
      window.CS.go(x, z, yaw, -6);
    }, { ...d, f });
    await step(30);
    const shut = await angle(d.poi);
    await ev(() => window.CS.input({ b: 32 }));
    await step(2);
    await ev(() => window.CS.input(null));
    await drawn(60);
    const dev = await ev((id) => window.CS.view.ents.get(id), d.id);
    const open = await angle(d.poi);
    log(`${d.poi}: device on ${dev.on}, progress ${dev.progress.toFixed(2)}; drawn door ${shut === null ? '-' : shut.toFixed(2)} -> ${open === null ? '-' : open.toFixed(2)} rad`);
    check(dev.on && dev.progress > 0.9, `${d.poi}: USE opens the door device (seen on the client)`);
    check(open !== null && open > 0.6 && open > (shut ?? 0) + 0.5, `${d.poi}: the drawn door swung open`);
    await shot(`doors_${d.poi}_open`);
    await ev(() => window.CS.input({ b: 32 }));
    await step(2);
    await ev(() => window.CS.input(null));
    await drawn(60);
    const closed = await angle(d.poi);
    check(closed !== null && closed < 0.2, `${d.poi}: USE again closes it (${closed?.toFixed(2)} rad)`);
  }
}
