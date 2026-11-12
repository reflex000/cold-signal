// Smoke test for the toolchain: three r187 WebGPURenderer, a TSL material, shared uniforms,
// on whichever backend the browser gives us. `?webgl=1` forces the WebGL2 backend.
import * as THREE from 'three/webgpu';
import { color, mix, normalWorld, positionWorld, sin, vec3 } from 'three/tsl';
import { U } from '../src/gfx/shared';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const forceWebGL = new URLSearchParams(location.search).has('webgl');
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
await renderer.init();
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0.55, 0.62, 0.7);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
camera.position.set(3, 2, 5);
camera.lookAt(0, 0.5, 0);

const mat = new THREE.MeshStandardNodeMaterial();
const up: any = normalWorld.y.smoothstep(0.3, 0.7);
mat.colorNode = mix(color(0x2a2c30), vec3(0.9, 0.93, 1.0), up).mul(sin(positionWorld.x.mul(8).add(U.time)).mul(0.05).add(0.95));
mat.roughnessNode = mix(0.6 as any, 0.9 as any, up);
const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.35, 200, 32), mat);
knot.position.y = 1;
scene.add(knot);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color: 0xdfe6ee, roughness: 0.9 }));
scene.add(ground);
const sun = new THREE.DirectionalLight(0xfff0dd, 3);
sun.position.set(4, 6, 3);
scene.add(sun, new THREE.HemisphereLight(0x9fb8d8, 0x40444a, 1));

const backend = (renderer.backend as any).isWebGPUBackend ? 'webgpu' : 'webgl2';
document.getElementById('info')!.textContent = `three r${THREE.REVISION} · ${backend} · ${innerWidth}x${innerHeight} @${devicePixelRatio}`;
(window as any).BACKEND = backend;

let frames = 0;
renderer.setAnimationLoop(() => {
  U.time.value = performance.now() / 1000;
  knot.rotation.y += 0.01;
  renderer.render(scene, camera);
  if (++frames === 3) (window as any).DONE = true;
});
