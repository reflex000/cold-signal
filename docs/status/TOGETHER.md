# TOGETHER — status / handoff note (milestone M5)

Owner scope: src/game/**, src/sim/** (optional contract additions only), src/ui/**, small fixes elsewhere.
Do NOT touch: src/actors (FIGURES), src/actors/fp + src/models/tools (VIEWMODEL), src/gfx/snow + src/gfx/terrain,
weather, sky, forest (SNOW; src/gfx/snow has WIP type errors that are not ours).

## Done
- Lost screen: ui/end.ts kind 'lost' (LOST text in ui/text.ts), ui/index.ts endKind(); game.ts checkMode clears the save
  on 'won'/'lost' and shows mode 'dead' for 'lost' (Mode has no 'lost'); saveNow refuses a finished run; respawn refused.
- Markers (standin/markers.ts): no point lights; skips door/panel/generator/bed/beacon devices and locker/cupboard
  crates (STRUCTURES draws them). update() stays an assignable property (FX + FIGURES wrap it).
- Loot scaling: sim/systems/spawn.ts scales consumable stacks by 1 + 0.5 (n-1) (n = state.vars['sim.players']);
  game.ts newGame reopens the title session if 1 + bots changed. Wolves already scale (wolves.ts packSize).
- Tests robust under the parallel suite: src/sim/timing.ts (best-of rounds + slowdown vs. a reference workload,
  REF_IDLE_MS 2.0); applied in sim.test, net.test, wolves.test, world.test, gfx/sky/atmosphere.test; LONG_TEST_MS on
  the storm trace and thermal pace; vite.config.ts testTimeout 30 s / hookTimeout 120 s.
- Bots: src/game/bots.ts (Mind: follow / lead roles, priority rules; BotBrain: companions via Host.setBotInput /
  botAct) + src/game/botnav.ts (Reader: SimReader / ViewReader; Planner: 0.5 m walk cache with wall clearance,
  door corridors, A*, trail following with out-and-back pass choice, rejoin plans, breadcrumb retreat; iceRisk).
  game.ts: autopilot (setAuto, autoTick through the input path), botsDoing(); cs.ts: CS.auto(on), CS.doing().
  Companions hand radio parts to the leader; whoever holds a part takes it to the panel once all are found.
- tools/scenarios/playthrough.mjs: PASS on WebGPU and WebGL2 (won after 53 min 47 s game time, 0 deaths, whiteout
  sat out by a fire, lake hut and back, clean console, ~60 s real). With ?wire=json&lag=120&jitter=30 it has won
  (53-63 min) but the whiteout-at-fire share and deaths vary run to run (autopilot resource use under lag).
- Ice: host.ts sends IceCell.skin (mm), client.ts keeps it; src/game/icevis.ts draws black water (film greys it),
  dark crazed new ice and floating slabs. tools/scenarios/ice.mjs PASS WebGPU + WebGL2.
- Snapshots: host.ts wire() rounds fractional numbers to 1e-3 (own player full precision) and skips dynamic entities
  whose wire JSON is unchanged for that client (Conn.dynSent): 11.7 -> 7.0 KB avg at 4 players + 16 wolves.
  net.test: 3 precision asserts at the wire precision, new size test. docs/NETWORK.md written.
- tools/scenarios/netproof.mjs PASS (json + 120 ms + 30 ms jitter, 3 bots): walking (pred. error 0.0000 m),
  16 wolves (6.97 KB avg snapshot), attack, revive, chop, fire, ice break, install, all checked on the client.
- Loading: world/terrain.ts buildTerrainSteps + world/index.ts createWorldSteps/createWorldAsync (generators, a frame
  between phases); standin/structures.ts pre-builds models with pauses (registry cache = per-session cache);
  visuals.ts progress labels + pauses; game.stats().loadMs (boot to first frame).
- Item icons: src/game/icons.ts itemIcon(item) canvas still lifes; game.ts UiGame.icon.
- Interiors: src/game/interior.ts ('interior'): FX-pool fill + doorway daylight lights per indoor room, exposure
  +1.6 stops indoors by day (sky.exposureBias, own share only). places.mjs PASS; cabin/hut/shed now lit.

- Heli: src/game/heli.ts registers KIT model 'rescue_heli' and flies it (createHeliVisual, 'heli'); markers no longer
  draw it. tools/scenarios/heli.mjs PASS. Doors: tools/scenarios/doors.mjs PASS (device on the client + drawn part
  swings; note STRUCTURES' driver eases by drawn-frame dt). FX already reads smoke/light/beacon emitters.
- Co-op 1/2/4 (real world): matches 20/29/49, ammo 14/21/35, tools unchanged; first pack 3/4/5 wolves; isolation
  1 solo, 0 together. src/sim/systems/spawn.test.ts (4 tests); wolves.ts exports packSize.
- tools/scenarios/pack.mjs PASS (20 cells, 20 pictures). Load to first frame ~8.3-8.9 s here; stats().loadStalls.

## Remaining
- Nothing required. Optional: autopilot robustness under lag (the lagged full run wins about half the time);
  window light patches indoors; split ENGINE's shader warmup (~1.9 s, the longest loading stall).

## Files touched outside src/game
- src/ui/end.ts, src/ui/index.ts, src/ui/text.ts (lost screen)
- src/sim/systems/spawn.ts (loot scaling), src/sim/timing.ts (new, test helper)
- src/net/host.ts (skin on the wire, wire rounding, unchanged-dynamic skip), src/net/client.ts (skin)
- src/world/terrain.ts, src/world/index.ts (step generators, createWorldAsync)
- tests: src/sim/sim.test.ts, src/net/net.test.ts, src/sim/systems/wolves.test.ts, src/sim/systems/thermal.test.ts,
  src/world/world.test.ts, src/gfx/sky/atmosphere.test.ts; vite.config.ts (test timeouts)
- src/sim/systems/wolves.ts (export packSize), src/sim/systems/spawn.test.ts (new)
- docs/NETWORK.md (new); tools/scenarios/playthrough.mjs, netproof.mjs, ice.mjs, doors.mjs, heli.mjs, pack.mjs (new)

## Test commands
- npx tsc --noEmit -p . ; npx vitest run
- node tools/play.mjs tools/scenarios/playthrough.mjs [--backend webgl] [--query "wire=json&lag=120&jitter=30"]
- node tools/play.mjs tools/scenarios/netproof.mjs ; ice.mjs ; places.mjs

## Final report

**Bots** (`src/game/bots.ts`, `botnav.ts`): one `Mind` drives a body only through InputCmds and Actions. Companions (`BotBrain`, via `Host.setBotInput`/`botAct`) follow (closer in bad weather), build and feed fires when the group stops, gather and chop, hand over parts and supplies, revive, take the free end of a heavy log, defend (rifle, axe, flare), install parts, crank, hold out in the shed, board the winch. A 0.5 m walk-clearance A* with door corridors, trail following and breadcrumb retreat keeps them off thin ice and cliffs. The same Mind in the 'lead' role is the autopilot (`CS.auto(true)`): it plays the local player through the client session and sees only the View.

**Release test** `tools/scenarios/playthrough.mjs` passes on WebGPU and WebGL2 with a clean console. The autopilot and one bot win after **65 min 17 s of game time** (about 65 s real). No CS.give. They sit out a 176 s whiteout by a fire, cross to the hut and back, and nobody dies.

**Network**: `netproof.mjs` runs over `?wire=json&lag=120&jitter=30` with 4 players. Walking, 16 wolves, an attack, a revive, chopping, a fire, the ice breaking and fitting a part all check out on the client. Prediction error 0.0000 m. Snapshots fell from 11.7 to **6.97 KB** average: `host.ts` rounds numbers to 1e-3 (your own player stays exact) and skips dynamic entities that have not changed. `docs/NETWORK.md` is written. Over lag the whole autopilot run wins only about half the time. Other modules' scenarios assume a wire with no lag.

**Loose ends**:
- The lost screen exists and the save clears on won and lost.
- Markers have no lights and skip what STRUCTURES draws.
- The helicopter is a new model (`heli.ts`).
- Ice holes and refrozen ice are drawn (`icevis.ts`, with skin sent on the wire).
- Loading yields between phases: `createWorldAsync`, structures build with pauses and are cached per session. First frame comes about 8.5 s after boot. The longest stall left is ENGINE's shader warmup (about 1.9 s).
- Pack icons come from `icons.ts`.
- Interiors get daylight lights from the FX pool, and exposure rises 1.6 stops indoors (`interior.ts`).
- Doors were checked.
- Loot and wolves scale with 1, 2 or 4 players.
- 222 tests pass in parallel.

**API**: `BotBrain`, `Mind`, `Game.setAuto`/`botsDoing`, `CS.auto`/`doing`, `createWorldSteps`/`createWorldAsync`, `buildTerrainSteps`, `itemIcon`, `scaledCount`, exported `packSize`, `sim/timing.ts` `cost`/`slowdown`.

**Contracts**: none changed. `IceCell.skin` now goes over the wire. Unchanged dynamic entities are no longer resent.

**Files outside src/game**:
- `src/ui/end.ts`, `src/ui/index.ts`, `src/ui/text.ts`
- `src/sim/systems/spawn.ts`, `src/sim/systems/wolves.ts`, `src/sim/timing.ts`, `src/sim/systems/spawn.test.ts`
- `src/net/host.ts`, `src/net/client.ts`
- `src/world/terrain.ts`, `src/world/index.ts`
- tests in sim, net, wolves, thermal, world and `gfx/sky/atmosphere`
- `vite.config.ts`
- `docs/NETWORK.md`
- scenarios: playthrough, netproof, ice, doors, heli, pack
