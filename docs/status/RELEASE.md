# RELEASE — status (milestone M7)

Owner files: src/sim/** tuning (constants and rules), src/ui/** text and flow, src/game/hudmodel.ts and hints,
README.md, LICENSE, docs/**, media/**. Stay out of src/gfx, src/models, src/actors, src/game/visuals.ts (POLISH,
VIEWMODEL, SNOW).

## Done
- (starting) status note created.

## Remaining (priority order)
1. Read final reports of docs/status/*.md (TOGETHER: playthrough scenario + numbers), DESIGN 1, NETWORK.
2. Balance: run playthrough (autopilot + bot, several seeds; solo), log legs/downs/cold/wolves/consumables.
   Tune constants; before/after table here.
3. First ten minutes: title -> grave opening (black, wind, Flight 417 text, fade into fuselage at dusk) ->
   contextual hints (move, look, take, barrel fire, pack, sticks, build+light fire, radio). Touch parity.
4. README.md, LICENSE (MIT), THIRD-PARTY note for three.js in dist/.
5. Curate 6-8 screenshots into media/ after POLISH "## Final report" lands.
6. npm run check, npm test, npm run build clean; playthrough passes on WebGPU and WebGL2.

## Decisions / facts for a successor
(none yet)

## Test commands
- npm run check ; npm test ; npm run build
