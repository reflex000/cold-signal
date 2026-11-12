// Shared rendering state: the TSL uniforms every material may read, and a plain JS mirror of
// the atmosphere. See docs/DESIGN.md section 5. Systems write, materials read.
// Owner: ENGINE keeps this file; anyone may add a uniform here (append, never rename).
import * as THREE from 'three/webgpu';
import { texture, uniform } from 'three/tsl';

// A 1x1 black texture so texture uniforms are valid before their owner has made the real one.
const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blank.needsUpdate = true;

export const U = {
  time: uniform(0),
  // wind
  windDir: uniform(new THREE.Vector2(1, 0)), // world XZ unit vector the air moves toward
  windSpeed: uniform(4), // m/s, mean plus gust
  gust: uniform(0),
  // weather
  storm: uniform(0),
  snowfall: uniform(0),
  snowCover: uniform(0.8), // fresh snow lying on props and branches
  visibility: uniform(4000), // metres
  // light
  sunDir: uniform(new THREE.Vector3(0.3, 0.5, 0.8).normalize()),
  sunColor: uniform(new THREE.Color(1, 0.95, 0.88)),
  moonDir: uniform(new THREE.Vector3(-0.3, 0.6, -0.5).normalize()),
  moonColor: uniform(new THREE.Color(0.05, 0.07, 0.1)),
  skyAmbient: uniform(new THREE.Color(0.35, 0.45, 0.6)),
  groundAmbient: uniform(new THREE.Color(0.25, 0.27, 0.3)),
  night: uniform(0), // 0 day .. 1 night
  // fog
  fogColor: uniform(new THREE.Color(0.7, 0.76, 0.82)),
  fogDensity: uniform(0.0006), // 1/m at camera height
  fogHeight: uniform(0.004), // falloff with height above the camera, 1/m
  // view
  camPos: uniform(new THREE.Vector3()),
  playerPos: uniform(new THREE.Vector3()),
  exposure: uniform(1),
  // snow deformation map around the player: R = how far the snow is pressed down, 0..1
  trailTex: texture(blank),
  trailOrigin: uniform(new THREE.Vector2()), // world XZ of the map centre
  trailSize: uniform(64), // metres across
  trailOn: uniform(0), // 0 when the map is not available
};

/** Plain JS mirror for code that is not a shader (particles, audio, exposure, UI). */
export const ATMOS = {
  sunDir: new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
  sunColor: new THREE.Color(1, 0.95, 0.88),
  sunIntensity: 1,
  moonDir: new THREE.Vector3(-0.3, 0.6, -0.5).normalize(),
  moonColor: new THREE.Color(0.05, 0.07, 0.1),
  skyAmbient: new THREE.Color(0.35, 0.45, 0.6),
  groundAmbient: new THREE.Color(0.25, 0.27, 0.3),
  fogColor: new THREE.Color(0.7, 0.76, 0.82),
  night: 0,
  /** Scene-referred brightness the eye should adapt to, for auto exposure. */
  luminance: 1,
};
