// The rescue helicopter: a medium twin-engine search-and-rescue machine built with KIT (registered
// as 'rescue_heli'), and the GfxSystem that flies it where the sim's HeliEnt is. It is added to the
// props system while the entity exists and moved every frame (interpolated by the client session),
// the main rotor and the tail rotor turning. The searchlight and the beacons are emissive lenses on
// the model (no light of its own: point lights are FX's pool).
// Model space: +Z is the nose (KIT convention), so the entity's yaw (0 faces north, -Z) is turned
// half a circle when it is placed. Origin under the skids; the entity's y is the bottom of the body.
// Owner: TOGETHER.
import * as THREE from 'three/webgpu';
import type { Frame, GfxSystem } from '../gfx/api';
import { Builder, MAT, PAL, hex, type V3 } from '../models/kit';
import type { PropsSystem } from '../models/instances';
import { register } from '../models/registry';
import type { HeliEnt } from '../sim/types';
import type { ViewEnt } from './view';

const BODY = hex(0xc9ccc8); // weathered white
const STRIPE = hex(0x7d2a22); // a dull rescue red, the one colour on it
const DARK = hex(0x2b2e31);
const GLASS = PAL.glass;

register(
  'rescue_heli',
  (seed) => {
    const b = new Builder(seed);
    const snow = 0; // it has been flying: no snow on it
    // ---- the fuselage: a lathe along the length, nose at +Z ----
    b.ink({ color: BODY, mat: MAT.PAINT, wear: 0.25, snow, vary: 0.03 });
    const prof: [number, number][] = [
      [0.0, -6.2], [0.32, -6.1], [0.55, -5.4], [0.7, -4.4], [1.05, -3.2], [1.38, -1.8], [1.52, -0.2], [1.5, 1.6],
      [1.4, 2.8], [1.15, 3.7], [0.8, 4.3], [0.35, 4.75], [0.0, 4.85],
    ];
    const hull = b.lathe(prof, { sides: 18, smooth: true });
    hull.rotX(Math.PI / 2).scale(1, 0.95, 1).move(0, 1.85, 0);
    // a red band along the side and the belly
    b.ink({ color: STRIPE, mat: MAT.PAINT, wear: 0.3, snow });
    for (const s of [-1, 1]) b.box(0.04, 0.32, 6.2, { bevel: 0.01 }).move(s * 1.48, 1.55, 0.2);
    // ---- the cabin glass: windscreen and side windows ----
    b.ink({ color: GLASS, mat: MAT.GLASS, wear: 0.1, snow });
    b.sphere([1.05, 0.8, 1.2], { sides: 16, rings: 8 }).move(0, 2.25, 3.55);
    for (const s of [-1, 1]) {
      b.box(0.05, 0.62, 1.1, { bevel: 0.02 }).move(s * 1.47, 2.3, 1.9);
      b.box(0.05, 0.62, 1.0, { bevel: 0.02 }).move(s * 1.5, 2.3, 0.4);
    }
    // ---- engine cowling and the mast ----
    b.ink({ color: BODY, mat: MAT.PAINT, wear: 0.3, snow });
    b.pillow(1.5, 0.75, 3.6, { round: 0.25, bulge: 0.05 }).move(0, 3.2, -0.6);
    b.ink({ color: DARK, mat: MAT.METAL, wear: 0.4, snow });
    b.cyl(0.18, 0.75, { sides: 12 }).move(0, 3.85, 0.1);
    // exhausts
    for (const s of [-1, 1]) b.cyl(0.16, 0.5, { sides: 10, r2: 0.13 }).rotX(-1.2).move(s * 0.62, 3.25, -2.1);
    // ---- the tail boom, fin and stabiliser ----
    b.ink({ color: BODY, mat: MAT.PAINT, wear: 0.3, snow });
    b.cyl(0.42, 6.6, { sides: 14, r2: 0.2 }).rotX(-Math.PI / 2).move(0, 2.55, -8.9);
    b.ink({ color: STRIPE, mat: MAT.PAINT, wear: 0.3, snow });
    b.box(0.12, 1.9, 1.15, { bevel: 0.03 }).rotX(-0.35).move(0, 3.25, -12.1); // fin
    b.ink({ color: BODY, mat: MAT.PAINT, wear: 0.3, snow });
    b.box(2.6, 0.08, 0.6, { bevel: 0.02 }).move(0, 2.6, -11.0); // stabiliser
    // ---- skids ----
    b.ink({ color: DARK, mat: MAT.METAL, wear: 0.5, snow });
    for (const s of [-1, 1]) {
      b.cyl(0.07, 3.8, { sides: 8 }).rotX(Math.PI / 2).move(s * 1.25, 0.08, 0.3);
      for (const z of [-0.9, 1.4]) b.cyl(0.06, 1.3, { sides: 8 }).rotZ(s * 0.5).move(s * 1.0, 0.65, z);
    }
    // ---- the rescue winch over the right door, the searchlight under the nose ----
    b.box(0.9, 0.12, 0.12, { bevel: 0.02 }).move(1.75, 3.0, 1.2);
    b.cyl(0.14, 0.32, { sides: 10 }).move(2.15, 2.85, 1.2);
    b.ink({ color: DARK, mat: MAT.METAL, wear: 0.4, snow });
    b.sphere(0.2, { sides: 10, rings: 6 }).move(0, 0.95, 3.6);
    b.ink({ color: hex(0xfff3dc), mat: MAT.EMISSIVE, emissive: 6, snow });
    b.cyl(0.14, 0.04, { sides: 12 }).rotX(-0.7).move(0, 0.85, 3.72);
    // beacons: red on top of the boom and the belly, white strobe on the fin
    b.ink({ color: hex(0xff2a1a), mat: MAT.EMISSIVE, emissive: 14, snow });
    b.sphere(0.08, { sides: 8, rings: 4 }).move(0, 3.65, -3.0);
    b.sphere(0.08, { sides: 8, rings: 4 }).move(0, 0.42, -0.5);
    b.ink({ color: hex(0xf0f4ff), mat: MAT.EMISSIVE, emissive: 10, snow });
    b.sphere(0.07, { sides: 8, rings: 4 }).move(0, 4.2, -12.4);

    // ---- the rotors: named parts the system turns ----
    const mast: V3 = [0, 4.3, 0.1];
    b.part('rotor', () => {
      b.ink({ color: DARK, mat: MAT.PAINT, wear: 0.35, snow });
      b.cyl(0.32, 0.22, { sides: 12 }).move(mast[0], mast[1], mast[2]);
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        b.box(6.7, 0.07, 0.48, { bevel: 0.02 }).move(3.45, 0, 0).rotY(a).move(mast[0], mast[1] + 0.06, mast[2]);
      }
    }, mast, { axis: [0, 1, 0] });
    const tail: V3 = [0.3, 3.1, -12.2];
    b.part('tailrotor', () => {
      b.ink({ color: DARK, mat: MAT.PAINT, wear: 0.35, snow });
      b.cyl(0.1, 0.18, { sides: 8 }).rotZ(Math.PI / 2).move(tail[0], tail[1], tail[2]);
      for (let k = 0; k < 2; k++) b.box(0.05, 2.5, 0.22, { bevel: 0.01 }).rotX(k * Math.PI).move(tail[0] + 0.05, tail[1], tail[2]);
    }, tail, { axis: [1, 0, 0] });
    b.anchor('winch', [2.15, 2.6, 1.2]);
    return b.build({ ground: false });
  },
  { variants: 1, size: 'structure', desc: 'search-and-rescue helicopter (the ending)' },
);

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** The FX light pool's handle (src/gfx/fx/lights.ts), the fields used here. */
interface PoolLight {
  on: boolean;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  range: number;
  angle: number;
  penumbra: number;
  fadeIn: number;
  release(): void;
}

/**
 * Flies the 'rescue_heli' prop where the HeliEnt is (the props system places it by position and yaw).
 * With `engine`, the searchlight under the nose is a real spot from FX's light pool (POLISH): it lights
 * the deck it hovers over and, in the storm's air, draws its beam (weather/volume.ts localAirlight),
 * so the rescue reads even in the whiteout of the last minutes.
 */
export function createHeliVisual(props: PropsSystem, engine?: { get(name: string): unknown }): GfxSystem {
  let id = -1;
  let entId = 0;
  let spin = 0, tailSpin = 0;
  let lamp: PoolLight | null = null;
  const _d = new THREE.Vector3();
  const lampOff = (): void => {
    if (lamp) lamp.on = false;
  };
  return {
    name: 'heli',
    update(f: Frame): void {
      const list = f.view.list('heli') as ViewEnt<HeliEnt>[];
      const h = list.length > 0 ? list[0] : null;
      if (!h) {
        if (id >= 0) {
          props.remove(id);
          id = -1;
        }
        lampOff();
        return;
      }
      const yaw = h.yaw + Math.PI;
      if (id < 0 || entId !== h.id) {
        if (id >= 0) props.remove(id);
        id = props.add({ model: 'rescue_heli', seed: 0, x: h.x, y: h.y - 0.3, z: h.z, yaw, scale: 1 });
        entId = h.id;
      }
      props.move(id, h.x, h.y - 0.3, h.z, yaw);
      // rotors: a believable turn on screen (the real five turns a second would strobe at a few frames per second)
      const dt = Math.max(0, f.dt);
      spin = (spin + dt * 9.5) % (Math.PI * 2);
      tailSpin = (tailSpin + dt * 23) % (Math.PI * 2);
      props.part(id, 'rotor')?.quaternion.setFromAxisAngle(UP, spin);
      props.part(id, 'tailrotor')?.quaternion.setFromAxisAngle(SIDE, tailSpin);
      // the searchlight: the lens under the nose (model (0, 0.85, 3.72)), aimed forward and down
      if (engine) {
        if (!lamp) {
          const fx = engine.get('fx') as { lights?: { acquire(kind: 'point' | 'spot', priority?: number): PoolLight } } | undefined;
          if (fx?.lights) {
            lamp = fx.lights.acquire('spot', 7);
            lamp.fadeIn = 0.6;
          }
        }
        if (lamp) {
          const s = Math.sin(yaw), c = Math.cos(yaw);
          lamp.on = true;
          lamp.position.set(h.x + s * 3.8, h.y - 0.3 + 0.8, h.z + c * 3.8);
          _d.set(s * 0.5, -0.86, c * 0.5).normalize();
          lamp.direction.copy(_d);
          lamp.color.setRGB(1, 0.95, 0.86);
          lamp.intensity = 320;
          lamp.range = 70;
          lamp.angle = 0.3;
          lamp.penumbra = 0.6;
        }
      }
    },
    dispose(): void {
      if (id >= 0) props.remove(id);
      id = -1;
      lamp?.release();
      lamp = null;
    },
  };
}
