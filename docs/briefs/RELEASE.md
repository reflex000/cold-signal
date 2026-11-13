# Brief: RELEASE — balance, the first ten minutes, the README (milestone M7)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR TASK: make the hour play well from the first second to the rescue, and write what a player and a developer
need. You may edit src/sim/** tuning (constants and rules; keep the contracts and keep every test green, changing a
test only when the design value it checks changes on purpose), src/ui/** text and flow, src/game/hudmodel.ts and
hints, README.md, docs/**, media/** (new). One other engineer (POLISH) works at the same time in src/gfx,
src/models, src/actors and src/game/visuals.ts: stay out of those. List every file you touch in your report.
Read first: the "## Final report" of every docs/status/*.md (especially TOGETHER: the playthrough scenario and its
numbers), DESIGN.md section 1, docs/NETWORK.md.

1. Balance, measured not guessed: run the playthrough (autopilot + bot) several times with different seeds and
   solo (no bot), and log time per leg, downs and their causes, closest calls with the cold, wolves encountered,
   matches / ammunition / flares used and left over. Targets: about an hour for a first-time player (the autopilot
   is faster than a human: aim for 45-60 minutes of game time for it); the cold is the main threat; wolves are
   frightening but rarely fatal for a careful group; matches and rounds feel scarce but never soft-lock a run; solo is
   possible. Tune constants until the numbers land; record a before / after table in docs/status/RELEASE.md.
2. The first ten minutes: the title, then a short, grave opening (black, wind, a line or two of text about Flight 417,
   fading into the player's view inside the broken fuselage at dusk), then the tutorial through play: hints that
   appear only when relevant and disappear once done (move, look, take, the barrel fire, the pack, sticks, building
   and lighting a fire, the radio), never a wall of text. Check it works the same with touch controls.
3. README.md for the repository front page: what the game is (two short paragraphs, plain and grave), a
   screenshot table (curate 6 to 8 of the best shots from shots/ after the POLISH work lands, re-shoot at 1600 x 900
   if needed, save small JPEGs in media/ and reference them), the controls (keyboard and mouse, gamepad, touch;
   verify against src/game/input.ts and src/ui), how to run (npm install, npm run dev, npm run build, npm test, the
   play tool), URL options (src/game/params.ts), how it is made (rendering, world, simulation and the multiplayer-ready
   architecture with a pointer to docs/NETWORK.md, sound and music, everything generated in code), the layout of
   the code, credits (three.js under MIT) and a licence (MIT, the author is the repository owner). Keep it accurate:
   every command and key you list must exist.
4. A LICENSE file (MIT) and a THIRD-PARTY note for three.js in the build output (vite can keep the licence
   comments; check dist/).
5. npm run check, npm test and npm run build clean; the playthrough passes on WebGPU and WebGL2.

STATE ON DISK: nothing of yours exists. Create docs/status/RELEASE.md first and keep it current.
