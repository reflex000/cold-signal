# SNOW — status / handoff

Owner files: src/gfx/snow/** ; may edit src/gfx/terrain/**, weather/**, sky/**, forest/** for look fixes;
one registration line in src/game/visuals.ts. Appended uniforms to src/gfx/shared.ts (allowed: append only).

## Design (decided, being built)
- Persistent CPU store of stamp RECORDS (stamps.ts): boot / paw / body / capsule (drag, crawl, log) / kick /
  melt, each with its depth, rim, and the fill clock F at stamp time. Spatial hash (8 m cells), ring capacity.
- GPU painter (painter.ts): ONE RGBA8 render target, a 2:1 atlas [near | far] (one sampled texture in the
  terrain shader: the terrain is near the 16-texture limit). near = high-res window around the camera
  (snowDeform texels over 20..32 m), far = low-res window (<=1024 texels over 256..384 m). Mobile: near only.
  Stamps = instanced quads, clip-space vertexNode, procedural SDF shapes, MAX blending (union).
  Window re-centres snap to whole texels; a re-centred half is re-rendered from records (clear quad + one
  instanced draw); new stamps between re-renders are drawn incrementally (no clear). One render pass per frame
  at most, usually none.
- Encoding (near): R floor depth 0..1 (x DEPTH_MAX m, dilated past the edge), G edge SDF (0.5 = edge, >0.5
  inside, +-SDF_RANGE m), B raised snow (rims, berms, kicked clumps; x RIM_MAX m), A freshness (compacted look).
  Far: R area-weighted depth, G presence (dilated), B 0, A freshness.
- Fill-in for free: records store F at stamp time; F integrates d(env.snowAccum) + wind drift. At re-render
  each record is drawn with its remaining depth/rim/freshness and softened walls; between re-renders the terrain
  shader subtracts U.trailFill (per-channel decrement since that half's last re-render). Re-render when the
  decrement grows past a threshold (seconds in a storm, never in calm).
- Terrain (sample.ts helpers called from terrain/material.ts): crisp walls from the SDF (width = max(1.2 cm,
  pixel)), analytic gradient, rims, compacted darker/smoother/bluer floor, deep holes bluer, shadow march toward
  the key light inside prints (desktop tiers), low-passed vertex dents (4 taps), far trails as soft grooves.
- U.trailOn: 0 off, 1 legacy (R only, as the TERRAIN bench painter writes), 2 = SNOW encoding.

## Done
- (in progress) design; nothing coded yet.

## Remaining (priority order)
1. stamps.ts, painter.ts, sample.ts, index.ts; register in visuals.ts; terrain material hook-up.
2. Bench page dev/snow.html for shots; then the game (tools/play.mjs survive / hunt).
3. Look fixes: blizzard streaks, olive rock, snowy trees from above, cliff smear, horizon band.
4. Shots on WebGPU / WebGL2 / mobile.

## Decisions / API facts
- RT clip mapping (three r187, both backends, from QuadMesh): sampling uv (u, v) <-> clip (2u-1, 1-2v).
- MaxEquation blending works on WebGPU (factors One/One) and WebGL2 (gl.MAX); CustomBlending applies without
  transparent = true.
- Step events carry the body position: the foot is offset +-0.1 m sideways from the travel direction (taken
  from the previous step of the same id, else the entity velocity / yaw). forward(yaw) = (-sin yaw, -cos yaw).
- Downed figure (actors/player_anim.ts lying()): face down, head toward the facing, pelvis 0.36 m behind the
  entity position, legs further behind.
- Dragged log: only one carrier -> the far end drags (a carries -> end b at x - sin(yaw) * len/2).
- env.snowAccum grows snowfall * (0.0004 + 0.0004 storm) m/s (sim/systems/env.ts): ~5 cm/min in a whiteout.

## Test commands
(none yet)
