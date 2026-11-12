# Cold Signal — plan

A first-person co-op survival game on a mountain in a blizzard. Browser, GPU, fully procedural.
The design and the module contracts are in `docs/DESIGN.md`. This file is the order of work.

Every milestone ends the same way: type-check, simulation tests, run the game in a headless
browser on the real GPU (WebGPU and the WebGL2 fallback, desktop and phone viewport), take
screenshots, judge them harshly against the art direction, fix what looks cheap or broken, check
the console is clean, commit.

## M0 — Spine
- [ ] Toolchain: Vite, TypeScript, three r187, headless Chrome on the real GPU with WebGPU
- [ ] Contracts: sim state / actions / events, world, protocol, view, gfx, audio, ui
- [ ] Sim core: fixed 30 Hz tick, entity table with net ids, systems, serialise / load
- [ ] Net: host, client session with prediction and interpolation, loopback (ref / json / lag)
- [ ] Engine: WebGPURenderer with WebGL2 fallback, quality presets, shared uniforms, post skeleton
- [ ] Tools: `play.mjs` scenarios, `CS` hook, bench pages, model shots
- [ ] World: seeded heightmap, places, trees, rocks, colliders, shelter, spawn tables
- [ ] Model kit: builder, registry, the shared prop material with snow cover

## M1 — The mountain
- [ ] Terrain mesh with level of detail, snow / rock / ice material
- [ ] Sky: sun, moon, stars, clouds, day and night, aurora
- [ ] Weather: storm fog, volumetric blizzard, wind-driven snow, whiteout
- [ ] Forest: pines with snow load and wind sway, impostors, rocks, ground cover
- [ ] Walk the mountain in first person (keyboard / mouse and touch)

## M2 — Staying alive
- [ ] Body temperature, wetness, shelter, stamina, health
- [ ] Fire: build, light, feed, wind and snow; flame, embers, smoke, flicker light
- [ ] Wood: sticks, deadfall, the axe; inventory and items; crates
- [ ] HUD, menus, settings, touch controls
- [ ] Audio: wind, footsteps, fire, breath; the score

## M3 — What hunts you
- [ ] Wolves: packs, stalking, circling, fear of fire and flares, attacks on the isolated
- [ ] Tools: axe, flashlight, flare gun, rifle, hand-crank radio; first-person hands
- [ ] Figures: the parka player in third person, the wolf, both fully animated
- [ ] Downed and revive; death and checkpoints

## M4 — The places and the way out
- [ ] Wreck, tail section, ranger cabin, frozen lake and hut, cave, survey camp, tower
- [ ] Lake ice that creaks, cracks and breaks
- [ ] Radio parts, the tower panel, the generator, the hold-out, the helicopter, the ending
- [ ] Story beats, hints, notes; save and continue

## M5 — Together
- [ ] Companion bots through the same action path; shared warmth, revive, two-person log carry
- [ ] Wolves and loot scale with player count; isolation pressure
- [ ] `?wire=json&lag=120` play test; snapshot size check; full scripted play-through to rescue

## M6 — Make it look real, make it run
- [ ] Deformable snow: footprints, trails, drag marks that fill in
- [ ] Post: tone mapping, bloom, ambient occlusion, anti-aliasing, frost and wet lens, grain
- [ ] Breath vapour, snow on the lens, flare light, eye shine, heat haze
- [ ] Quality presets (`mobile` to `ultra`), auto-detect, dynamic resolution; 60 fps on `medium`
- [ ] Phone pass: touch layout, safe areas, WebGL2 path, memory
- [ ] Harsh visual review of every place in every weather; fix list worked to empty

## M7 — Release
- [ ] Balance pass on a full hour's run; first-ten-minutes tutorial
- [ ] README with controls and how to run; screenshots
- [ ] Production build; deploy to GitHub Pages; check the live page on WebGPU, WebGL2 and phone
