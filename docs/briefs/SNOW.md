# Brief: SNOW — deformable snow, and the last look problems (milestone M6)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR MODULE: SNOW. Files you own: src/gfx/snow/**, and you may edit src/gfx/terrain/**, src/gfx/weather/**,
src/gfx/sky/**, src/gfx/forest/** for the look fixes below, plus one registration line in src/game/visuals.ts
(re-read it right before editing; others edit it too). Two other engineers work at the same time (VIEWMODEL in
src/actors/fp and src/models/tools; TOGETHER in src/game, src/sim, src/ui): stay out of their files.
Read first: docs/status/TERRAIN.md (the footprint hook: U.trailTex / trailOrigin / trailSize / trailOn, R = press
depth), LOOK.md, ATMOS.md, FOREST.md, GAME.md (sim events on the bus: 'step' with surface and position, 'land',
'downed'), SURVIVAL.md (log carry), HUNT.md (wolves move), env.snowAccum and snowfall in src/sim/types.ts.

1. The trail painter: a GPU (or CPU-to-texture) system that presses the snow where bodies go: footprints from
   every player's step events (left and right, boot-shaped, deeper in deep snow, scuffed when running), wolf paw
   tracks, the long drag of a carried log, a body-shaped hollow where a player went down, kicked snow at a jump's
   landing. Near the camera a high-resolution window (U.trailTex around U.trailOrigin, moving with the player
   without smearing: scroll by whole texels); far away a persistent low-resolution map of the whole route so trails
   stay visible behind you; both fill in with fresh snowfall over minutes (from env.snowfall and snowAccum) and
   blow over in wind. Works on WebGL2 (no compute required: render-to-texture with small quads or a CPU canvas
   upload) and is cheap on 'mobile' (smaller window, no far map).
2. Make the terrain material use it convincingly: pressed snow is a depression with a crisp rim and a darker,
   smoother, compacted floor; it catches shadow at low sun; fresh snow softens it.
3. Look fixes left open by LOOK and ATMOS (shots in their notes): the storm reads as fog in still frames — make the
   blizzard visibly snow: streaks at several depths, gust fronts, snow sheets moving across the slope, flakes
   catching firelight, and lit by the flashlight beam in the dark; rock in low sun turns olive — correct it (warm sun
   on near-black rock should read warm grey, check the grade and the albedo); trees heavy with snow seen from above
   read as white blobs — keep the dark needles showing; streaks of snow on the cliff above the cave look smeared;
   the bench's dark band at the horizon (if it shows in the game, fix it there).
4. Shots: footprints and trails at noon and dusk, in deep snow and on the packed trail, a log drag, a downed
   hollow, trails filling during a storm (before / after 3 minutes), the blizzard at night with a fire and with the
   flashlight, low-sun rock, forest from above. On WebGPU, WebGL2 and --mobile 1, in the real game (tools/play.mjs;
   the survive and hunt scenarios make tracks). Read every shot; judge harshly; iterate. Budget for the trail system
   under 0.5 ms at 'medium'.

STATE ON DISK: nothing of yours exists. Create docs/status/SNOW.md first and keep it current.
