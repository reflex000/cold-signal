# GAME (client shell + integration) — handoff note

Owner files: src/main.ts, src/game/** (except src/game/view.ts, frozen), index.html, tools/play.mjs,
tools/scenarios/**, dev/game.html (optional, not made).

Status (session 1): COMPLETE. Every item of docs/briefs/GAME.md exists and runs. All scenarios pass with
a clean console: first (webgpu, webgl, --dist 1), tour (webgpu, webgl), walk, net (json + 120 ms), mobile
(--mobile 1), perf (--live 1 --q medium), title, save, bots, keys, focus, night, audio (--live 1),
release (--dist 1). npm run check clean, npm test green (101 tests), npm run build OK and the built page
starts clean. No edits outside my files, no contract changes.

## Files
- src/main.ts            boot entry: `boot()` from ./game/game
- src/game/params.ts     URL params (?seed ?q ?webgl ?wire ?lag ?jitter ?bots ?still ?dev ?touch ?skipTitle
                         ?continue ?nosave ?fresh ?real ?gpu)
- src/game/settings.ts   Settings defaults, localStorage 'cs.settings', cleanSetting()
- src/game/game.ts       Game: boot, modes, GameActions, session (Sim+Host+Loopback+ClientSession), stepFrame()
- src/game/viewimpl.ts   View implementation (ents, me, env, camera, rig, hud); events -> bus 'sim' + 'toast'
- src/game/hudmodel.ts   heading, marks, place (+ bus 'place' on entering), objective line, hints, frost / wetLens / whiteout
- src/game/input.ts      keyboard + mouse (pointer lock), gamepad, TouchSink; sample() -> one InputCmd per tick
- src/game/camera.ts     first person (eye, bob, landing dip, sway, wind lean, shake, fov kick), third person, title drift
- src/game/focus.ts      entity under the crosshair within 2.6 m -> hud.focus + InputCmd.focus
- src/game/save.ts       Sim.serialize() JSON in localStorage 'cs.save'
- src/game/sound.ts      sim events -> sfx / footsteps; listener, ambience, music mood; loops (fires, stove, flares ...)
- src/game/bots.ts       companion bot brain (follows the player) through Host.setBotInput
- src/game/map.ts        UiGame.map(): hillshade + contours + forest / rock / ice / trail (drawn in idle slices)
- src/game/cs.ts         window.CS tool hook
- src/game/visuals.ts    THE SEAM: addVisualSystems(engine, world, realSelection(?real))
- src/game/standin/      sky.ts, weather.ts (fog + snowfall + whiteout), terrain.ts (3 CPU rings + skirts),
                         forest.ts (trees + rocks), structures.ts (blueprint boxes + KIT props), markers.ts (entities, fire lights)
- tools/play.mjs (+ --dist 1, contact sheets, `bare` scenarios); tools/scenarios/*.mjs (+ census, prof diagnostics)

## Decisions / API facts
- Yaw 0 faces north (-Z), CCW positive (sim and camera rotation.y, order YXZ). HUD heading = -yaw; bearings atan2(dx, -dz).
- stepFrame(dt, render): input.update -> up to 5 ticks of DT (input.sample -> session.sendInput -> bots -> host.tick)
  -> lb.pump (lag only) -> session.advance -> events -> view.update -> camera -> focus -> HUD -> engine.frame -> sound -> ui.
  The host ticks in play / inventory / dead / won; not in pause / title / photo (solo). view.time stops in pause and photo.
- The camera renders from the LOCAL look yaw/pitch (mouse applied per event), not me.yaw (per tick).
- Title: the new-game session already exists behind it (host not ticking); New game reuses it while unplayed.
- world.props: registered kit models -> createPropsSystem (barrels drawn unlit: flames come from FireEnts); the rest
  (fuselage, cabin ...) -> boxes from placeBlueprint (walls you see = walls you hit); sign/fence posts, debris -> shapes.
- Real gfx: visuals.ts imports src/gfx/{sky,weather,terrain,forest}/index.ts lazily (import.meta.glob) when selected
  by ?real= or DEFAULT_REAL; a module that throws falls back to its stand-in with one warning. DEFAULT_REAL is empty:
  at my last try (?real=all) terrain threw (__SURFACE__ undefined, WIP) and sky + weather drew a dark fog (WIP).
- HUD whiteout reads engine.get('weather').whiteout when the weather system exports it.
- U.playerPos is written by the game each frame.
- r187 quirk: `vertexColors: true` on an instanced, shadow-receiving mesh rendered WHITE (trees brighter than snow at
  night). Fixed with an explicit `colorNode = vertexColor()` (instanceColor still multiplies in).
- Pointer lock is only requested inside a user gesture (navigator.userActivation.isActive); losing it while playing = pause.
- Tools run with ?nosave=1&fresh=1; save.mjs uses nosave=0 in the throwaway browser profile.

## Possible next steps (none required for this milestone)
1. Flip DEFAULT_REAL in visuals.ts as TERRAIN / ATMOS / FOREST finish; then delete the matching stand-ins.
2. When SIM adds items / fire / thermal / wolves / health / objective: run focus + night again, add scenarios for
   use / fire / downed / death / respawn / won (code paths exist, unexercised).
3. Item icons (UiGame.icon returns null; the UI draws its SVG icons).

## Test commands
- npm run check ; npm test ; npm run build
- node tools/play.mjs tools/scenarios/<first|tour|walk|net|title|save|bots|keys|focus|night>.mjs   (WebGPU, still)
- node tools/play.mjs tools/scenarios/first.mjs --backend webgl ; tour.mjs --backend webgl
- node tools/play.mjs tools/scenarios/mobile.mjs --mobile 1
- node tools/play.mjs tools/scenarios/perf.mjs --live 1 --q medium ; audio.mjs --live 1
- node tools/play.mjs tools/scenarios/release.mjs --dist 1   (after npm run build)
- add --query "real=all" (or real=terrain,sky) to try the real gfx systems

## Final report

**Runs:** the whole client. Boot (URL params, device, settings, UI loading screen, engine, audio, createWorld, visual systems, warmup), title over the live scene, single-player as a local Host + ClientSession on the loopback (ref / json / lag). The host ticks at 30 Hz (5 catch-up ticks at most). Also: View, input (keyboard, mouse with pointer lock, gamepad, TouchSink), camera (first-person feel, third person), focus, HUD model, sound, companion bots, map, save / continue, every GameAction and mode. The stand-in world is behind one seam, `src/game/visuals.ts`.

**CS API:** `ready`, `step(n=1, dt=1/30)`, `play()`, `pause()`, `go(x, z, yawDeg, pitchDeg)`, `look(yawDeg, pitchDeg)`, `env({storm, clock, lock})`, `act(a)`, `equip(t)`, `input({mx, mz, b}) | null`, `give(item, n)`, `mode(m)`, `view`, `engine`, `sim`, `session`, `world`, `game`, `stats()`, `shotReady()`.

**Scenarios** (all pass, console clean):
- first: feet on the ground, eye 1.66 m. Passes on WebGPU, WebGL and the build.
- walk: firm snow 2.36 m/s (2.43 expected); deep drift 1.17 m/s; client matches host.
- net (json, 120 ms lag): largest prediction error 0.0000 m over 125 commands.
- mobile: buttons at least 53 px, under the right thumb; the stick walks; a drag turns 28°; the jump button jumps.
- tour: 7 places x 2 angles x dusk / storm, on both backends.
- perf (live, medium): 5-13 fps, 38-62 draw calls, 0.3-0.7 M triangles. These numbers mean little: the GPU is shared, a near-empty scene took about 90 ms of GPU time, and ENGINE's bench now measures 25-69 ms against 5.5-6.7 ms in its notes.
- title, save, bots, keys (faked pad), focus, night, audio, release: pass.
- npm run check, npm test (101) and npm run build are all clean.

**Edits outside my files:** none. **Contract additions:** none.

**Weak or missing:**
- The stand-ins are plain: tiered cones for trees, boxes from the blueprints for structures.
- The real TERRAIN / ATMOS / FOREST were unfinished at my last try. With `?real=all`, terrain threw and sky + weather drew dark fog, so DEFAULT_REAL is empty. To use one, add its name in visuals.ts.
- SIM has only spawn / env / players. Use, fire, cold, wolves, death, objective and win are wired but never exercised.
- three r187: an instanced mesh with `vertexColors: true` that receives shadows rendered white. Worked around with an explicit `colorNode = vertexColor()`. ENGINE should add this to THREE_NOTES.
- `icon()` returns null, so the UI uses its SVG icons.
- The loading screen freezes during createWorld, because it is synchronous.
- Pointer lock and a real gamepad cannot be tested headless.
