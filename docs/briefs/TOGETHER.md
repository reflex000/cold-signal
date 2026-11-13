# Brief: TOGETHER — companions, co-op and every loose end between modules (milestone M5)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR TASK: make the co-op design work with companion bots through the same action path, prove the network path,
and close the gaps the module engineers left between each other. You may edit src/game/**, src/sim/** (keep the
contracts: optional additions only), src/ui/**, and small fixes elsewhere; two other engineers work at the same
time (VIEWMODEL in src/actors/fp and src/models/tools; SNOW in src/gfx/snow and src/gfx/terrain), so do not touch
their folders. List every file you touch outside src/game in your report.
Read first: docs/status/*.md "## Final report" sections (all of them: GAME, SIM, SURVIVAL, HUNT, OBJECTIVE,
FIGURES, STRUCTURES, FX, UI, AUDIO, LOOK), DESIGN.md section 1 (co-op).

1. Companion bots (settings.bots 0..3, GAME's bot brain): they follow at a sensible distance, stay close in bad
   weather, gather sticks and wood, build and feed a fire when the group stops, share warmth, revive a downed
   player, take the other end of a heavy log when the player lifts one, hand over items, defend (axe, flare, rifle
   when they carry one), install parts and crank the generator at the tower, keep out of thin ice, and never walk
   off cliffs. They send InputCmds and Actions exactly as a remote client would. Simple, robust, readable.
2. Co-op scaling: wolves and loot by player count as designed; isolation pressure works; check with 1, 2 and 4
   players (bots count as players for scaling).
3. Network proof: play with ?wire=json&lag=120&jitter=30: walking, chopping, lighting a fire, a wolf attack, a
   revive, the ice breaking, installing a part, all correct on the client; measure snapshot size per tick at 4
   players with 16 wolves (target under about 8 KB average; delta-compress or quantise if over) and the
   prediction error. Write a short docs/NETWORK.md: how to drop in a real transport (WebRTC data channel or a
   WebSocket relay): the exact interface, join flow, host migration notes, and what is already handled.
4. Loose ends to close (verify each, fix, test):
   - Stage 'lost' has no screen and Respawn is refused: add the lost screen; clear the save on 'lost' and 'won'.
   - GAME's markers still draw boxes for door, panel, generator, bed devices and locker / cupboard crates that
     STRUCTURES now draws itself: skip those types.
   - Players, wolves and the heli: make sure FIGURES' actors replaced the markers; flares and fires use FX.
   - FX should get the chimney smoke ('smoke' emitters with source 'stove'), lamps ('light') and tower beacons
     ('beacon') from STRUCTURES' placed props; doors open from the sim's door devices (OBJECTIVE says it handles
     doors: check the door part moves).
   - Ice holes and refrozen cells (view.ice) are not drawn: draw open water and fresh skin ice (a small system in
     src/game or src/gfx/fx), with splash FX on 'iceBreak' / 'splash'.
   - The loading screen freezes while the world (about 1.5 s), the structures (4-5 s) and the forest build: yield to
     the browser between phases (and inside long builds) so the loading line moves; consider caching built
     geometry per session; report the load time to first frame.
   - game.icon(item) returns null: draw item icons (canvas, from the models or simple drawings) so the pack shows
     them.
   - npm test under the parallel suite: other modules' timing tests and sim.test's long storm trace time out under
     load; make them robust (longer timeouts for long tests, relative not absolute timing, or a separate slow
     suite), never by weakening what they check.
   - Interiors are pitch black by day (shots/places_cabin_in.jpg): light the cabin, hut, shed and fuselage
     interiors believably (light through windows and the door, bounce, the stove's glow), and let exposure adapt
     when the player goes inside.
5. A full scripted play-through scenario (tools/scenarios/playthrough.mjs) that walks the real route with a bot,
   finds every part where it lies (no CS.give), survives a whiteout at a fire, crosses the lake, reaches the tower
   and wins, at accelerated time if needed. It is the release test: make it pass on WebGPU and WebGL2 with a clean
   console. Report the in-game time it took.

STATE ON DISK: nothing of yours exists. Create docs/status/TOGETHER.md first and keep it current.

Late additions from the FX engineer: GAME's stand-in markers still create three idle point lights that cost every
pixel: remove them (FX and FIGURES now wrap the markers' update for fires, flares, players and wolves; keep those
wrappers working). The FIGURES engineer may still be finishing src/actors when you start: do not edit src/actors.
