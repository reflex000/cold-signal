# Brief: LOOK — put the real mountain into the game and make it look real (milestone M1, final step)
(Read docs/briefs/COMMON.md first. Ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and on reading narrowly.)

YOUR TASK: the game currently draws stand-in visuals. The real systems are finished and benchmarked alone:
TERRAIN (src/gfx/terrain), ATMOSPHERE (src/gfx/sky, src/gfx/weather), FOREST (src/gfx/forest), plus KIT's props
(src/models). Put them into the game, fix the problems their engineers found in each other's work, then make the
whole thing look like a photograph and run fast. Nobody else is editing the project while you work: you may edit
any file, but keep each module's design and the frozen contracts, and list every file you touched outside
src/game in your report.

Read first: docs/status/GAME.md (visuals.ts seam, DEFAULT_REAL, ?real=, scenarios, CS hook), TERRAIN.md,
ATMOS.md, FOREST.md, KIT.md, ENGINE.md (each ends with "## Final report"), docs/THREE_NOTES.md.

1. Switch the game to the real systems by default: terrain, sky (before weather), weather, forest, props. Keep a
   stand-in only as the fallback when a system throws at start, with a console warning. Feed weather.whiteout to
   hud.whiteout. Forest must be added before engine.warmup(). The blueprint structures stay as simple shapes until
   M4, but give them the prop material so they sit in the same light.
2. Fix the cross-module problems the engineers reported:
   a. ENGINE ambient occlusion (GTAO) puts dark dots along terrain ridgelines, a black line at the lake shore, and
      turns distant ground at grazing angles nearly black at dusk, at night and in storms; it is also drawn over the
      fog. Fade it out with view depth (gone by about 60-80 m) and with fog density / low visibility, so it only
      grounds nearby objects.
   b. The U uniforms in src/gfx/shared.ts live in three's per-object group, so some materials read stale values
      through scene.fogNode (ATMOS keeps render-group mirrors to work around it). Move them to the render group
      (.setGroup(renderGroup)) and remove the mirrors once nothing depends on them.
   c. three r187: an instanced mesh with vertexColors that receives shadows rendered white (GAME worked around it
      with colorNode = vertexColor()). Add that to docs/THREE_NOTES.md.
   d. Trees and props do not receive TERRAIN's baked ridge shadow: expose it (a texture node and its mapping) and
      apply it in the forest and prop materials, so a valley in a ridge's shadow is in shadow everywhere.
   e. From high up the far forest reads white (far trees cast no shadow): give far impostors and the snow under
      dense forest enough darkening that a forest reads as dark from 300 m.
   f. WebGL2 logs "query already active" when GPU timing is on with three cascades: do not request GPU timing on
      WebGL2 unless asked, or guard it.
   g. Phones ('mobile', no anti-aliasing) show the forest crossfade dither as a stipple: fix it there (narrower or
      no crossfade, or a cheap AA on 'mobile' if it fits the budget).
   h. WORLD's cliff band shows regular strata steps and snow-filled couloirs read as sharp white spikes: soften
      in the terrain material (or the world's cliff shaping, keeping places and the route intact; world tests stay
      green).
3. Look pass in the real game (node tools/play.mjs tools/scenarios/tour.mjs and your own views): all seven places,
   in clear dusk, noon, a clear night with aurora, moonlit night, storm 0.5 and a whiteout; on WebGPU, then WebGL2
   and --mobile 1 for a subset. Read every shot and judge it harshly against DESIGN.md section 2. Things to
   check: snow never flat white or grey; shadows grounded and soft; the horizon is mountains; fog continuous
   across terrain, forest, sky and props; no seams or popping at LOD borders; trees and props seated on slopes,
   neither floating nor sunk; night dark but readable; the storm reads as weather, not a grey filter. Fix what
   looks cheap, flat or broken, in whichever module the cause is.
4. Performance on this machine's Intel Arc iGPU, which is now idle (check no other Chrome is running a capture):
   node tools/play.mjs tools/scenarios/perf.mjs --live 1 at 'medium', 1920 x 1080, in the densest forest, at the
   wreck, on the lake and on the ridge. Target 60 fps at 'medium'. Profile by switching systems and passes off one
   at a time (terrain, forest, rocks, cover, sky, clouds, storm volume, particles, AO, bloom, shadows, render
   scale), then tune src/gfx/quality.ts and the per-system settings until 'medium' holds 60 fps (or say how close
   and what it costs to get there), 'low' is comfortably above, 'mobile' is light enough for a phone (measure it
   in the --mobile 1 emulation as a relative figure). Record a table in docs/status/LOOK.md.
5. npm run check, npm test and npm run build clean; every scenario in tools/scenarios still passes.

STATE ON DISK: nothing of yours exists. Create docs/status/LOOK.md first and keep it current.
