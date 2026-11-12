# Brief: KIT
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: KIT (the model toolkit) and the first models. Files you own: src/models/kit.ts,
src/models/registry.ts, src/models/material.ts, src/models/instances.ts, src/models/props/** (first models),
dev/models.html, dev/models.ts, tools/shot-models.mjs.

Every static thing in the game (wreckage, cabin, crates, tools on the ground, the tower) will be built by other
engineers with YOUR toolkit and drawn with YOUR material, so the kit decides how real the whole game looks.
Read DESIGN.md section 6 and section 2 again before designing it.

1. src/models/kit.ts — a Builder that makes it fast to write convincing hard-surface and organic props in code:
   primitives with bevelled / chamfered edges (rounded box, tube, cone, capsule, lathe profile, extruded
   polygon, swept profile along a curve, bent and tapered variants, planks, pipes, cables as catenary
   sweeps, cloth sheets with sag and tears, rock lumps from displaced subdivided shapes, dents and noise
   displacement), transforms, mirroring, arrays, and paint(part, { color, mat, rough?, metal?, emissive?, wear?,
   snow? }) which writes per-vertex attributes: colour (linear), a material id (MAT.SNOW, ROCK, BARK, WOOD,
   METAL, PAINT (painted metal), CLOTH, PLASTIC, GLASS, ICE, RUBBER, FUR, EMISSIVE), roughness / metalness /
   emissive, a wear amount, a snow-exposure weight (1 open to the sky, 0 under cover), a wind-sway weight, and
   detail coordinates (the vertex position in the part's own space at paint time so procedural grain sticks to
   the part; wood grain runs along local Y). A shared palette PAL (aircraft aluminium, painted and scorched
   metal, seat fabric, orange survival gear, weathered timber, tar paper, rust, rope, canvas ...). Vertex ambient
   occlusion baked cheaply at build time (per-part contact darkening) helps a lot: do it.
   b.build() returns a ModelDef: { geometry (one merged BufferGeometry; a second one for glass / transparent
   parts if any), parts (named sub-meshes the game moves or lights on its own), anchors, emitters ({ type:
   'fire' | 'smoke' | 'steam' | 'spark' | 'light' | 'beacon', position, ...extra }), lights, bounds, tris }.
   Same seed -> same model; different seeds give visibly different variants where it makes sense.
2. src/models/registry.ts — register(name, build, meta) / getModel(name, seed?, opts?) with caching,
   listModels(). Unknown names warn once and return a visible placeholder box so missing models are obvious.
3. src/models/material.ts — createPropMaterial(): ONE TSL MeshStandardNodeMaterial (plus a glass variant) for
   all models: per material id it adds procedural surface detail from the detail coordinates (wood grain and
   end grain, brushed and scratched aluminium, chipped paint showing primer and metal by wear, rust bleeding
   from edges, woven cloth, rubber, rock speckle), roughness and normal perturbation to match, wetness darkening,
   wind sway for vertices with sway weight (cloth, loose straps) driven by U.windDir / U.windSpeed / U.gust,
   and SNOW COVER: blend to the snow material on up-facing surfaces by U.snowCover * snow-exposure weight with a
   noisy edge, and push those vertices outward a few centimetres so caps of snow have thickness; snow gets
   soft sparkle and a blue subsurface tint in shade. fog = true. Emissive ids glow (fire-lit windows, beacon
   lamps, instrument lights) and survive bloom. It must compile and look the same on WebGPU and on the WebGL2
   backend (?webgl=1), and stay cheap: it will cover a large part of the screen. Document how instancing works.
4. src/models/instances.ts — createPropsSystem(engine-ish scene access, props: PropInst[]): a GfxSystem named
   'props' that draws a list of PropInst (src/world/types.ts) with as few draw calls as possible: one
   InstancedMesh per (model, seed) batch, frustum / distance culling by chunk for large lists, shadows on,
   and access to a placed instance's world-space anchors / emitters / parts (the fire and light systems will
   need emitter positions). Another engineer is writing src/gfx/engine.ts in parallel; do not depend on it at
   module load: take what you need (scene, camera) as arguments.
5. The first models, as the style reference for everyone else, in src/models/props/: 'crate' (wooden supply
   crate, variants), 'barrel' (steel drum cut open as a fire barrel, soot and rust, with a 'fire' emitter),
   'luggage' (suitcases and duffels, variants), 'campfire' (opts.stage 0..3: laid sticks, burning stack, charred,
   with fire / smoke emitters), 'stick_bundle', 'log_heavy' (a 2.4 m log), 'trail_marker' (a tall pole with a torn
   orange flag that sways), 'jerrycan', 'toolbox'. These must look like photographed objects: correct
   proportions, chamfered edges, wear where hands and weather reach, no primitive-looking boxes.
6. dev/models.html + dev/models.ts — a model viewer page: ?m=name1,name2 ?seed=1-4 ?light=day|dusk|night|storm
   ?views=az,el;az,el ?snow=0..1 ?debug=1 (anchors, emitters, bounds) ?webgl=1; lays the requested models out on a
   snowy ground plane with a sun, ambient and fog from src/gfx/shared.ts U (write suitable values for each light
   yourself; the engine and sky systems do not exist yet, so make the page self-contained on
   THREE.WebGPURenderer with tone mapping), frames them, sets window.DONE. tools/shot-models.mjs --m <names>
   --seed 1-4 --light dusk --views "30,20;200,35" --snow 0.8 --out <name> [--backend webgl] writes
   shots/<name>.jpg (one image with all views tiled is ideal). Use it on every model in day and dusk, with and
   without snow, on both backends; Read the images; iterate until they are convincing.

Report the Builder API in a compact reference (the other model engineers will read kit.ts, but tell me the
shape), the attribute layout, and how a system reads emitters of a placed prop.


STATE ON DISK (handoff note: docs/status/KIT.md): src/models/kit.ts (83 KB), material.ts (25 KB), registry.ts,
instances.ts (16 KB), dev/models.html. MISSING: dev/models.ts (the viewer), tools/shot-models.mjs, and all nine
first models in src/models/props/ (crate, barrel, luggage, campfire, stick_bundle, log_heavy, trail_marker,
jerrycan, toolbox). Nothing has been rendered yet: get the viewer and one model on screen first, on both
backends, then the rest. The kit and the material have never run, so expect to fix them.
ALSO append a section "Materials, vertex attributes and instancing" to docs/THREE_NOTES.md (create the file if
it does not exist yet; another engineer writes the renderer sections) with the verified r187 facts you needed.

UPDATE: a later engineer started this module again and kept docs/status/KIT.md and wrote dev/models.ts; the handoff note is the most current state. Continue from it.
