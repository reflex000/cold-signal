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
import { Fn, cameraProjectionMatrix, positionView, renderGroup, uniform, vec4 } from 'three/tsl';
import { createPropMaterial } from '../../models/material';

type N = any;
const u = (v: number): N => (uniform(v) as N).setGroup(renderGroup);

/** Per-frame values of the viewmodel projection (written by the viewmodel system). */
export const FP_U = {
  fovK: u(1),
  near: u(0.08),
  depthK: u(0.16),
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
  if (o.glow) {
    const glow: N = uniform(0).onObjectUpdate((frame: N) => (frame.object?.userData?.glow as number | undefined) ?? 0);
    m.emissiveNode = (m.emissiveNode as N).mul(glow);
  }
  return m;
}
