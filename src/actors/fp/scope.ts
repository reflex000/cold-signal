// The rifle scope. When the rifle comes up to the eye the viewmodel goes away and the picture is
// seen through the scope: the camera's field of view narrows to the scope's (GAME's camera rig
// resets it every frame, so this only ever narrows the frame being drawn), the view turns to where
// the round will go (the sim's aim: the player's look plus rifleSway, deterministic, so the reticle
// is the truth; GAME's own cold wander is taken back out while scoped), and a post overlay draws the
// eyepiece: a black field with a soft edge, a little vignette and a duplex reticle.
import * as THREE from 'three/webgpu';
import { float, length, max, min, mix, smoothstep, abs, uniform, vec2, vec3 } from 'three/tsl';
import type { CsEngine } from '../../gfx/engine';
import { U } from '../../gfx/shared';
import type { View } from '../../game/view';
import { rifleSway } from '../../sim/systems/tools';

type N = any;

/** Magnification of the scope relative to the player's field of view. */
const POWER = 4.5;
/** Radius of the eyepiece circle, as a fraction of the picture height. */
const EYE_R = 0.46;

export class Scope {
  /** 0..1 how far the scope is up (written by the viewmodel each frame). */
  readonly k = uniform(0) as N;
  private added = false;
  private sway = { yaw: 0, pitch: 0 };

  constructor(private engine: CsEngine) {}

  /** Add the overlay to the post pipeline (once; it costs a few ALU per pixel while idle). */
  install(): void {
    if (this.added || !this.engine.post) return;
    this.added = true;
    const k = this.k;
    this.engine.post.addOverlay('scope', 150, (color: N, uv: N, input: N) => {
      const p: N = uv.sub(0.5).mul(vec2(input.aspect, 1));
      const r: N = length(p);
      const px: N = float(1).div(max(U.resolution.y, 1));
      // the eyepiece closes in from outside the picture as the rifle comes up
      const R: N = mix(float(1.2), float(EYE_R), smoothstep(0, 1, k));
      const soft: N = px.mul(5).add(0.006);
      const edge: N = smoothstep(R.sub(soft), R, r).oneMinus();
      // darker toward the rim of the eyepiece (exit pupil), a faint blue-green coating tint
      const vig: N = mix(float(1), float(0.45), smoothstep(R.mul(0.55), R, r));
      const tint: N = vec3(0.96, 1.0, 0.98);
      // duplex reticle: heavy posts from the rim, fine hairs through the centre
      const ax: N = abs(p.x), ay: N = abs(p.y);
      const fine: N = px.mul(0.9);
      const post: N = px.mul(2.6).add(0.002);
      const gap: N = float(0.12);
      const lineY = (w: N): N => smoothstep(w, w.add(px), ay).oneMinus();
      const lineX = (w: N): N => smoothstep(w, w.add(px), ax).oneMinus();
      const hairH: N = lineY(fine).mul(smoothstep(gap, gap.add(0.01), ax).oneMinus());
      const hairV: N = lineX(fine).mul(smoothstep(gap, gap.add(0.01), ay).oneMinus());
      const postH: N = lineY(post).mul(smoothstep(gap, gap.add(px.mul(2)), ax));
      const postV: N = lineX(post).mul(smoothstep(gap, gap.add(px.mul(2)), ay));
      const ret: N = min(float(1), hairH.add(hairV).add(postH).add(postV)).mul(edge);
      const inside: N = color.mul(vig).mul(tint).mul(ret.oneMinus());
      const scoped: N = inside.mul(edge);
      return mix(color, scoped, smoothstep(0, 0.04, k));
    });
  }

  /**
   * Narrow the camera and turn it to the sim's aim. `s` 0..1 is the scope amount. Call after GAME's
   * camera rig placed the camera this frame, before the scene is drawn.
   */
  apply(view: View, s: number): void {
    const cam = this.engine.camera;
    this.k.value = s;
    if (s <= 0) return;
    const me = view.me;
    const zk = THREE.MathUtils.smoothstep(s, 0.35, 0.9);
    if (zk <= 0 || !me) return;
    const base = view.camera.fov;
    const scopeFov = (2 * Math.atan(Math.tan((base * Math.PI) / 360) / POWER) * 180) / Math.PI;
    cam.fov = base + (scopeFov - base) * zk;
    cam.updateProjectionMatrix();
    // the sim's aim: look + rifleSway at the presented tick; GAME's cold wander and shiver removed
    rifleSway(me, view.env, view.env.t * 30, this.sway);
    const t = view.time, rig = view.rig;
    const sw = rig.sway;
    const wanderYaw = sw * (0.012 * Math.sin(t * 0.71) + 0.007 * Math.sin(t * 1.93 + 1.3));
    const wanderPitch = sw * (0.009 * Math.sin(t * 0.93 + 0.4) + 0.005 * Math.sin(t * 2.41));
    const tremor = rig.shiver * 0.0025;
    const shivYaw = tremor * Math.sin(t * 37.1) * Math.sin(t * 3.1);
    const shivPitch = tremor * Math.sin(t * 41.7 + 2) * Math.sin(t * 2.3 + 1);
    const c = view.camera;
    cam.rotation.set(c.pitch + (this.sway.pitch - wanderPitch - shivPitch) * zk, c.yaw + (this.sway.yaw - wanderYaw - shivYaw) * zk, c.roll * (1 - zk), 'YXZ');
    cam.updateMatrixWorld();
  }

  dispose(): void {
    if (this.added) this.engine.post.remove('scope');
    this.added = false;
  }
}
