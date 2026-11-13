# Brief: POLISH — the harsh final review of how the game looks and runs (milestone M6)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR TASK: every module is now in the game. Play it like a critic with a camera and fix what looks cheap or broken,
then make sure it runs well on every tier and on phones. You may edit anything under src/gfx, src/models,
src/actors, src/game/visuals.ts and the presentation files in src/game; one other engineer (RELEASE) works at the
same time on balance, the opening, the README and screenshots (src/sim tuning, src/ui text, docs, media): stay out
of those. List every file you touch in your report.
Read first: the "## Final report" of every docs/status/*.md, DESIGN.md section 2, LOOK.md (method and perf table).

1. Review. Use the tour, playthrough, survive, hunt, endgame and places scenarios plus your own views. Cover all
   seven places, outside and inside, at noon, golden hour, dusk, moonlit night, aurora night, storm 0.5 and a
   whiteout; a fire at night; a wolf attack at night with the flashlight and a flare; the first-person tools; the
   companions in third person; the ice breaking; the tower at the end with the helicopter. Read every shot. Write the
   fix list in docs/status/POLISH.md, ranked by how much each item hurts the "this looks real" impression, and work
   it from the top until nothing major is left. Typical suspects: anything floating, sinking or z-fighting;
   seams and popping; flat lighting or crushed blacks; over-bright snow or bloom; plastic-looking materials;
   repetitive placement; UI over-busy; the storm not reading as weather; interiors too dark or too flat.
2. Performance. The machine runs Windows in "Best power efficiency" mode, so absolute numbers are pessimistic;
   use relative costs and the per-pass split tool (tools/scenarios/gpusplit.mjs). Make sure the 'auto' quality
   and dynamic resolution settle quickly and sensibly; 'medium' keeps its look; 'mobile' is light. Measure load time
   to the first frame and cut it if you can (shader warmup is the longest stall).
3. Phones. With --mobile 1 (and at 390x844 portrait and 740x360 small landscape): start a game from the title by
   touch, walk with the stick, look, use, open the pack, pause, resume; the frame rate in the emulator relative to
   desktop; no WebGL2 errors; memory sane; text legible; nothing under the notch. Fix what is broken.
4. npm run check, npm test and npm run build clean; every scenario passes.

STATE ON DISK: nothing of yours exists. Create docs/status/POLISH.md first and keep it current.

Known items from the last engineers to include in the fix list:
- VIEWMODEL: a mitt cuff comes close to the eye during the hip bolt cycle and the flare reload; the HUD's small aim
  cross shows inside the rifle scope (hide it while scoped: hud.crosshair 'none'); FIGURES' src/actors/items.ts
  could draw tools with toolItem(tool, lod) from src/models/tools so first and third person match.
- SNOW: read its "## Final report" in docs/status/SNOW.md for anything it left open.
- STRUCTURES: the fuselage break still reads as a round tube end-on from 20 m.
- FIGURES: the wolf coat reads tan / coyote-like in warm light; timber wolves are grey with a darker saddle.
