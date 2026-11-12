# Brief: GAME
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: GAME (the client shell and integration). Files you own: src/main.ts, src/game/** except
src/game/view.ts (frozen contract), index.html, tools/play.mjs, tools/scenarios/**, dev/game.html if you want one.
You may make small fixes in other modules ONLY where two modules do not fit together (a wrong import, a
mismatched signature); list every such edit in your report.

Seven modules were just built in parallel against the contracts. Their engineers' reports:

Each module keeps a handoff note in docs/status/<MODULE>.md, and each builder appended its final report to the end of its note. Read all of them.

Read their code (do not rely only on the reports), then make the game run end to end:

1. Boot (src/main.ts, src/game/game.ts): read the URL (?seed= ?q=quality ?webgl=1 ?wire=ref|json ?lag=ms
   ?bots=n ?still=1 ?dev=1 ?touch=1 ?skipTitle=1), detect the device, show loading progress on the bus, build
   the World (createWorld; report progress), create the engine, the audio, the UI, a Sim + Host + ClientSession
   joined by the loopback transport (single-player IS a local host through the same path a remote host would use),
   settings persisted in localStorage, and the main loop: accumulate real time, tick the host at exactly 30 Hz
   (max 5 catch-up ticks), sample input into one InputCmd per tick, session.advance(dt), build the View, update
   camera, engine.frame, audio, ui. Pause stops the host in solo. Losing focus releases the pointer and pauses.
2. The View implementation (src/game/viewimpl.ts): everything in src/game/view.ts filled every frame from the
   ClientSession: ents with stable identity, per-kind lists, me (predicted), env, objective, ice, camera, rig
   (bob / stride / sway / breath / recoil values computed from the predicted player for the first-person feel),
   hud (heading, marks toward the current objective / fires / teammates, place from world.pois, focus, crosshair,
   frost from me.core, whiteout from env.visibility). Forward drained sim events on bus 'sim' and turn the right
   ones into bus 'toast' / 'place'.
3. Input (src/game/input.ts): keyboard + mouse with pointer lock (WASD, Shift sprint, Ctrl / C crouch, Space jump,
   E use (hold), left mouse primary, right mouse secondary, R reload, F flashlight, 1 to 5 tools (axe, flashlight,
   flare gun, rifle, radio), Q hands, G drop / release log, B build fire, Tab pack, M or Esc pause, V third-person
   view in dev), gamepad (standard mapping), and touch through a TouchSink implementation handed to the UI.
   All devices merge into the same InputCmd / Action stream; look sensitivity and invert from settings.
   Smooth mouse look with no added latency; yaw convention per DESIGN.md (0 faces north / -Z, counter-clockwise).
4. Camera (src/game/camera.ts): first person at eye height (constants from src/sim/move.ts), head bob tied to
   stride, landing dip, sway that grows with cold and exhaustion, lean into strong wind, optional shake
   (settings.shake), fov kick when sprinting, and a simple third-person chase view (camera.third) for dev,
   photo mode and the downed state, kept out of the terrain.
5. Focus picking (src/game/focus.ts): which entity is under the crosshair within reach (about 2.6 m), with the
   verb and name for hud.focus, sent as InputCmd.focus.
6. Save / continue (src/game/save.ts): the serialised SimState in localStorage (GameActions.hasSave /
   continueGame), written on 'checkpoint' events and when the page hides.
7. GameActions implemented; modes ('boot' -> 'title' -> 'play' ...) with the bus 'mode' message.
8. A stand-in visual world so the game can be walked and judged NOW (the real terrain, sky, weather and forest
   systems arrive in the next milestone and will replace these, so keep each stand-in in its own small file
   under src/game/standin/ and behind a clear seam): a terrain mesh from world.heightmap near the player with a
   simple snow / rock TSL material, a sun + ambient + fog from U / ATMOS following env.clock and env.storm, trees
   as instanced dark cones with white caps from world.trees near the player, rocks as instanced lumps, the props
   system from src/models/instances.ts for world.props, and coloured markers for entities (pickups, fires, wood,
   crates, devices, other players, wolves) so everything is visible. Keep it cheap.
9. The tool hook window.CS (always present with ?dev=1 or ?still=1): CS.ready (promise), CS.step(n = 1, dt = 1/30)
   advances host ticks and renders deterministically when ?still=1 (no real-time loop), CS.play() / CS.pause(),
   CS.go(x, z, yawDeg = 0, pitchDeg = 0) teleports the local player (through the debug action so it stays on the
   action path), CS.look(yawDeg, pitchDeg), CS.env({ storm, clock, lock }), CS.act(action), CS.input({ mx, mz, b })
   to hold an input for scripted walking, CS.view, CS.engine, CS.sim (host side, dev only), CS.stats() (fps,
   frame ms, draw calls, triangles, tick ms, entity counts, backend, quality), CS.shotReady() (resolves when the
   frame is on screen). window.DONE = true when the title or the game is first rendered; window.BACKEND set.
10. tools/play.mjs: node tools/play.mjs tools/scenarios/<name>.mjs [--q high] [--backend webgl] [--mobile 1]
    [--w 1600 --h 900] [--live 1] [--query "extra=params"]: starts tools/serve.mjs, launches tools/pw.mjs, opens
    the game with ?still=1&dev=1&skipTitle=1 (or live), waits for CS.ready, runs the scenario's default export
    with { page, ev, step, shot, log, args } (shot writes shots/<name>.jpg), prints CS.stats() and every page
    error / warning, exits non-zero on failure. Scenarios to write: first.mjs (spawn, look around, four shots),
    tour.mjs (teleport to every POI, shoot each from a flattering and an honest angle, in clear dusk and in
    storm), walk.mjs (hold forward for 20 s of sim time across snow, check the player moved the right distance,
    slowed in deep snow, did not fall through the world), net.mjs (run with --query "wire=json&lag=120": walk,
    check prediction error stays small, no errors), mobile.mjs (touch layout visible, drive the stick with
    synthetic touches, check movement), perf.mjs (--live 1: real frame times at several views; report fps, p95,
    draw calls, triangles).
11. Run: npm run check (must be clean for the whole project now: fix integration type errors), npm test (all
    green), then first, tour, walk, net on WebGPU; first and tour with --backend webgl; mobile with --mobile 1;
    perf --live 1 on medium. Read the screenshots. The stand-in visuals are allowed to be plain, but nothing
    may be broken: no black frames, no z-fighting sheets, no objects floating or buried, camera at the right
    height, the horizon level, POIs where the map says, UI readable, touch controls where thumbs are.
    Fix what is broken. Then npm run build must succeed, and the built page (vite preview or serving dist/) must
    start without errors.

Report: what runs, the CS API as built, the scenarios and their results (numbers), every edit you made outside
your own files, and a frank list of what is weak or missing for the next milestone.


STATE ON DISK (your handoff note: docs/status/GAME.md, create it first). Nothing of yours exists yet except the
contract src/game/view.ts and a placeholder src/main.ts. SIM+NET, ENGINE, KIT, AUDIO, MUSIC and UI are finished:
read their handoff notes in docs/status/ (the "## Final report" section at the end of each is the API summary)
before reading their code. WORLD is still being polished by its engineer while you work: createWorld(seed) in
src/world/index.ts already exists and works (tools/world-map.mjs uses it); its terrain may change under you, so do
not hard-code heights, and do not edit src/world.

Build in this order so an interruption costs little: (1) boot + main loop + View + input + camera with the
stand-in world, walkable and on screen; (2) the CS hook and tools/play.mjs with the first scenario; (3) focus,
save, the remaining scenarios; (4) the checks in item 11.

Notes from the module engineers that concern you:
- SIM: JUMP is level-triggered (send it as a one-tick pulse); sendInput sets seq itself; stop sending input while
  the solo host is paused; Host.tick() returns the tick's events.
- ENGINE: engine.add(sys) then await engine.warmup() then engine.frame({ dt, time, view }) per frame; call
  engine.compile(obj) before scene.add for anything created mid-game; post extension API in docs/status/ENGINE.md.
- KIT: import './models/props' registers the models; createPropsSystem({ scene, camera }, props) is a GfxSystem.
  The bench's hemisphere ground light (0.9) leaves faces turned from the sun nearly black over sunlit snow: in your
  stand-in sky use a ground/bounce ambient of about 2x that, to match snow's albedo.
- UI: emit bus 'mode', 'loading', 'place', 'toast'; release pointer lock while ui.wantsPointer(); headings and
  bearings in radians, 0 = north, clockwise; ignore game keys while wantsPointer() is true.
- AUDIO: createAudio() then unlock() from a user gesture; per frame setListener, setAmbience, update(dt);
  start loop('stove', { pos }) for a burning stove.
The user plays on phones too: the mobile scenario (touch controls, WebGL2 path) is a first-class check.
