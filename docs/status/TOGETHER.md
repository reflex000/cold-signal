# TOGETHER — status / handoff note (milestone M5)

Owner scope: src/game/**, src/sim/** (optional contract additions only), src/ui/**, small fixes elsewhere.
Do NOT touch: src/actors (FIGURES), src/actors/fp + src/models/tools (VIEWMODEL), src/gfx/snow + src/gfx/terrain (SNOW).

## Done
- Lost screen: ui/end.ts kind 'lost' (LOST text in ui/text.ts), ui/index.ts endKind(); game.ts checkMode clears the save
  on 'won'/'lost' and shows mode 'dead' for 'lost' (Mode has no 'lost'); saveNow refuses a finished run; respawn refused.
- Markers (standin/markers.ts): no point lights; skips door/panel/generator/bed/beacon devices and locker/cupboard
  crates (STRUCTURES draws them). update() stays an assignable property (FX + FIGURES wrap it).
- Loot scaling: sim/systems/spawn.ts scales consumable stacks by 1 + 0.5 (n-1) (n = state.vars['sim.players']);
  game.ts newGame reopens the title session if 1 + bots changed. Wolves already scale (wolves.ts packSize).
- Tests robust under the parallel suite: src/sim/timing.ts (best-of rounds + slowdown vs. a reference workload,
  REF_IDLE_MS 2.0); applied in sim.test, net.test, wolves.test, world.test, gfx/sky/atmosphere.test; LONG_TEST_MS on
  the storm trace and thermal pace; vite.config.ts testTimeout 30 s / hookTimeout 120 s. 217/217 pass in parallel.

## Remaining (priority order)
1. Companion bots through the action path (src/game/bots.ts) + autopilot for the scenario
2. Network proof (?wire=json&lag=120&jitter=30), snapshot size at 4 players + 16 wolves, docs/NETWORK.md
3. Ice holes / skin drawing (+ host sends IceCell.skin), splash FX check
4. Loading yields (createWorld phases, structures, visuals), load time to first frame
5. Item icons (game.icon)
6. Interior lighting + exposure adaptation indoors
7. Heli model (markers still draw a box); FX smoke/light/beacon from props check; door part moves check
8. tools/scenarios/playthrough.mjs (WebGPU + WebGL2, clean console); co-op scaling check 1/2/4

## Files touched outside src/game
- src/ui/end.ts, src/ui/index.ts, src/ui/text.ts (lost screen)
- src/sim/systems/spawn.ts (loot scaling), src/sim/timing.ts (new, test helper)
- tests: src/sim/sim.test.ts, src/net/net.test.ts, src/sim/systems/wolves.test.ts, src/sim/systems/thermal.test.ts,
  src/world/world.test.ts, src/gfx/sky/atmosphere.test.ts; vite.config.ts (test timeouts)

## Test commands
- npx tsc --noEmit -p . ; npx vitest run
