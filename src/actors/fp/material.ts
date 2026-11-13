// Materials of the first-person view. The hands and tools are drawn in the MAIN scene pass as
// children of the camera, with KIT's prop material (same light, shadows, fog, FX light pool as the
// world). Only the clip-space position is replaced (material.vertexNode):
//   - xy are scaled by FP_U.fovK = tan(mainFov / 2) / tan(vmFov / 2): the viewmodel keeps its own
//     field of view whatever the player's FOV setting or the sprint kick does;
//   - the depth written is the main projection's depth of a COMPRESSED distance
//     near * 1.05 + z * FP_U.depthK, so everything within about 1.3 m lands closer than the nearest
//     wall the 0.32 m player capsule allows: the hands never clip into walls, trees or rock.
// positionView stays the true camera-space position, so lighting, shadow lookups and fog are exact.
// Reusing cameraProjectionMatrix makes the depth right for reversed or standard depth on both
// backends (and keeps TAA's jitter in xy).
import * as THREE from 'three/webgpu';
import { Fn, abs, cameraProjectionMatrix, diffuseColor, float, mix, positionView, renderGroup, sin, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import { createPropMaterial } from '../../models/material';
import { U } from '../../gfx/shared';

type N = any;
const u = (v: number): N => (uniform(v) as N).setGroup(renderGroup);

/** Per-frame values of the viewmodel projection (written by the viewmodel system). */
export const FP_U = {
  fovK: u(1),
  near: u(0.08),
  depthK: u(0.16),
  /**
   * Extra sky light on the hands, as a fraction of U.skyAmbient: the eye reads near things a little
   * brighter than the exposure for the snowfield makes them (it follows the sky, so night stays dark).
   */
  ambient: u(0.45),
  /** Light bounced onto the hands from snow lit by the flashlight beam or a match (linear RGB radiance). */
  fill: (uniform(new THREE.Color(0, 0, 0)) as N).setGroup(renderGroup),
};

/** The viewmodel clip position (see the header). */
export function fpClip(): N {
  return Fn(() => {
    const pv: N = positionView;
    const z: N = pv.z.negate().max(1e-4);
    const clip: N = cameraProjectionMatrix.mul(vec4(pv.xy.mul(FP_U.fovK), pv.z, 1));
    const zc: N = FP_U.near.mul(1.05).add(z.mul(FP_U.depthK));
    const dc: N = cameraProjectionMatrix.mul(vec4(0, 0, zc.negate(), 1));
    return vec4(clip.xy, dc.z.div(dc.w).mul(clip.w), clip.w);
  })();
}

/**
 * The viewmodel's prop material: KIT's material without snow cover or wind (held things are shaken
 * clean), with the viewmodel projection. `glow`: the emissive paint is multiplied by the object's
 * userData.glow (a lamp, a meter backlight, a match head), one material for all of them.
 */
export function createFpMaterial(o: { glow?: boolean } = {}): THREE.MeshStandardNodeMaterial {
  const m = createPropMaterial({ snow: false });
  m.name = o.glow ? 'fp-glow' : 'fp';
  m.positionNode = null;
  m.vertexNode = fpClip();
  let emis: N = m.emissiveNode;
  if (o.glow) {
    const glow: N = uniform(0).onObjectUpdate((frame: N) => (frame.object?.userData?.glow as number | undefined) ?? 0);
    emis = emis.mul(glow);
  }
  // the extra sky light and the bounce, on the material's own albedo (diffuseColor is set by colorNode)
  m.emissiveNode = emis.add(diffuseColor.rgb.mul(vec3(U.skyAmbient).mul(FP_U.ambient).add(FP_U.fill)));
  return m;
}

/**
 * A match flame on a small card that faces the camera (the system turns it): additive, a white-blue
 * root, a yellow body and an orange licking tip, flickering; strength from userData.glow (0..1).
 * Radiance up to about 40 (it blooms at night, a small hot thing by day).
 */
export function createFlameMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'fp-flame';
  m.transparent = true;
  m.depthWrite = false;
  m.blending = THREE.AdditiveBlending;
  m.side = THREE.DoubleSide;
  m.fog = false;
  m.vertexNode = fpClip();
  const k: N = uniform(0).onObjectUpdate((frame: N) => (frame.object?.userData?.glow as number | undefined) ?? 0);
  m.colorNode = Fn(() => {
    const p: N = uv();
    const t: N = U.time;
    const v: N = p.y;
    // the tongue sways more toward the tip
    const sway: N = sin(t.mul(17).add(v.mul(6))).mul(0.06).add(sin(t.mul(29).sub(v.mul(11))).mul(0.035)).mul(v);
    const x: N = abs(p.x.sub(0.5).sub(sway)).mul(2);
    // teardrop: widest a third of the way up, rounded at the root, pointed at the tip
    const w: N = sin(v.mul(Math.PI).pow(0.75)).mul(0.9).add(0.05).mul(float(1).sub(v.mul(0.35)));
    const body: N = smoothstep(0, w, x).oneMinus().mul(smoothstep(0, 0.08, v)).mul(smoothstep(0.55, 1.0, v.add(sin(t.mul(23)).mul(0.05))).oneMinus());
    const core: N = smoothstep(0, w.mul(0.45), x).oneMinus().mul(smoothstep(0.1, 0.65, v).oneMinus());
    const root: N = smoothstep(0.0, 0.18, v).oneMinus().mul(smoothstep(0, w, x).oneMinus());
    const col: N = mix(vec3(1.0, 0.38, 0.08), vec3(1.0, 0.82, 0.45), core).add(vec3(0.1, 0.25, 0.9).mul(root.mul(0.6)));
    return vec4(col.mul(body.add(root.mul(0.4))).mul(k).mul(38), 1);
  })();
  return m;
}
