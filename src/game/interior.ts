// Daylight indoors. The sun's shadow map and the baked occlusion make every room (the cabin, the
// ice-fishing hut, the tower shed, the fuselage) black by day: in life the light comes in through
// the door and the windows, bounces off the floor and the walls and fills the room. Two requests to
// FX's light pool stand in for that while the camera is in or at a room:
//   - a doorway light just inside the door: the cool daylight pouring in;
//   - a bounce light up under the ceiling: softer, warmed by the timber, filling the corners.
// Both follow the daylight (sky and sun from ATMOS) and go to nothing at night, when the stove, the
// lantern and the flashlight do the lighting (FX lights those from their fires and props).
// And the eye adapts: stepping in, the exposure rises by up to about 1.6 stops over a second or two
// (sky.exposureBias, the sky system's documented knob; only this system's share is ever taken back,
// the way FX adds its firelight adaptation), and falls again on the way out.
// Owner: TOGETHER.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem } from '../gfx/api';
import type { CsEngine } from '../gfx/engine';
import { ATMOS } from '../gfx/shared';
import type { WorldEx } from '../world/index';

/** The FX pool's handle (src/gfx/fx/lights.ts), the fields this file uses. */
interface Handle {
  on: boolean;
  position: THREE.Vector3;
  color: THREE.Color;
  colorFar: THREE.Color | null;
  intensity: number;
  range: number;
  decay: number;
  priority: number;
  fadeIn: number;
  release(): void;
}
interface Pool {
  acquire(kind: 'point' | 'spot', priority?: number): Handle;
}

interface Room {
  x: number; y: number; z: number; // centre, world
  hx: number; hy: number; hz: number;
  cs: number; sn: number; // yaw
  door: { x: number; y: number; z: number; nx: number; nz: number } | null;
}

const ADAPT_STOPS = 1.6; // how far the eye opens up indoors by day
const ADAPT_RATE = 0.8; // 1/s

export function createInteriorLight(engine: CsEngine, world: WorldEx): GfxSystem {
  const rooms: Room[] = [];
  const doors = Object.entries(world.anchors).filter(([k]) => /\.door$/.test(k)).map(([, a]) => a);
  for (const s of world.shelters) {
    if (!s.indoor) continue;
    const cs = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    // the door of this room: the nearest door anchor within reach of its walls
    let door: Room['door'] = null, bd = Math.max(s.hx, s.hz) + 2.5;
    for (const a of doors) {
      const d = Math.hypot(a.x - s.x, a.z - s.z);
      if (d < bd) {
        bd = d;
        door = { x: a.x, y: a.y, z: a.z, nx: Math.sin(a.yaw), nz: Math.cos(a.yaw) };
      }
    }
    rooms.push({ x: s.x, y: s.y, z: s.z, hx: s.hx, hy: s.hy, hz: s.hz, cs, sn, door });
  }

  let pool: Pool | null = null;
  let fill: Handle | null = null;
  let doorway: Handle | null = null;
  let adapt = 0, written = 0;
  const cam = new THREE.Vector3();
  const sky = new THREE.Color();
  const warm = new THREE.Color(1.0, 0.86, 0.7);

  /** How far inside room r a point is: > 0 inside (metres to the nearest wall), < 0 outside. */
  const inside = (r: Room, x: number, y: number, z: number): number => {
    const dx = x - r.x, dz = z - r.z;
    const lx = dx * r.cs - dz * r.sn, lz = dx * r.sn + dz * r.cs;
    return Math.min(r.hx - Math.abs(lx), r.hz - Math.abs(lz), r.hy + 0.6 - Math.abs(y - r.y));
  };

  function hands(): boolean {
    if (fill && doorway) return true;
    const fx = engine.get('fx') as unknown as { lights?: Pool } | undefined;
    if (!fx || !fx.lights) return false;
    pool = fx.lights;
    fill = pool.acquire('point', 1.3);
    doorway = pool.acquire('point', 1.3);
    for (const h of [fill, doorway]) {
      h.decay = 2;
      h.fadeIn = 0.5;
      h.on = false;
    }
    return true;
  }

  return {
    name: 'interior',
    update(f: Frame): void {
      const dt = Math.min(0.1, Math.max(0, f.dt));
      engine.camera.getWorldPosition(cam);
      // the room the eye is in (or at the door of), and how deep in
      let room: Room | null = null, depth = -Infinity;
      for (const r of rooms) {
        const d = inside(r, cam.x, cam.y, cam.z);
        if (d > depth) {
          depth = d;
          room = r;
        }
      }
      const inRoom = room !== null && depth > -0.2;
      // daylight: what flat snow outside returns, 0 at night .. 1 in good daylight
      const day = Math.min(1, Math.max(0, (ATMOS.luminance - 0.03) / 0.9));

      // --- the eye adapts ---------------------------------------------------------------------
      const target = inRoom ? ADAPT_STOPS * Math.min(1, day * 1.4) * Math.min(1, (depth + 0.2) / 0.8) : 0;
      adapt += (target - adapt) * (1 - Math.exp(-dt * ADAPT_RATE * (target > adapt ? 1.6 : 1)));
      const sk = engine.get<GfxSystem & { exposureBias?: number }>('sky');
      if (sk && typeof sk.exposureBias === 'number') {
        sk.exposureBias = sk.exposureBias - written + adapt;
        written = adapt;
      }

      // --- daylight in the room -----------------------------------------------------------------
      if (!hands() || !fill || !doorway) return;
      const near = room !== null && depth > -6;
      if (!near || day < 0.02 || !room) {
        fill.on = false;
        doorway.on = false;
        return;
      }
      // the colour of the light coming in: the sky's, a touch of the low sun
      sky.copy(ATMOS.skyAmbient).add(warm.clone().multiplyScalar(ATMOS.sunIntensity * Math.max(0, ATMOS.sunDir.y) * 0.25));
      const l = Math.max(1e-4, (sky.r + sky.g + sky.b) / 3);
      sky.multiplyScalar(1 / l);
      const size = Math.max(room.hx, room.hz);
      fill.on = true;
      fill.position.set(room.x, room.y + room.hy * 0.55, room.z);
      fill.color.copy(sky).lerp(warm, 0.7); // off the timber and the floor: warmer than the sky
      fill.colorFar = null;
      fill.range = size * 2.4 + 1.5;
      fill.intensity = 7 * day * Math.min(1.6, size / 2.2);
      if (room.door) {
        const d = room.door;
        doorway.on = true;
        doorway.position.set(d.x - d.nx * 0.9, d.y + 1.5, d.z - d.nz * 0.9);
        doorway.color.copy(sky).lerp(warm, 0.2);
        doorway.colorFar = null;
        doorway.range = size * 1.8 + 2;
        doorway.intensity = 9 * day;
      } else doorway.on = false;
    },
    dispose(): void {
      fill?.release();
      doorway?.release();
      const sk = engine.get<GfxSystem & { exposureBias?: number }>('sky');
      if (sk && typeof sk.exposureBias === 'number') sk.exposureBias -= written;
    },
  };
}
