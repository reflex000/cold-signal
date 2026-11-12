# SURVIVAL status (milestone M2)

Owner files: src/sim/systems/thermal.ts, fire.ts, items.ts, wood.ts, vitals.ts (+ *.test.ts), their lines in
src/sim/systems/index.ts; may extend src/sim/entities.ts, src/sim/testworld.ts; optional members in
src/sim/types.ts / api.ts; small alignment edits in src/game/focus.ts, src/game/hud*.ts (listed below).

## Done
- (step 0) status file; read DESIGN, SIM/GAME/WORLD notes, contracts, sim core, focus, HUD, UI readers.
- (step 1) entities.ts (CARRY_LIMIT, isItemId, packRoom), items.ts, fire.ts, thermal.ts, wood.ts, vitals.ts,
  index.ts lines, testworld TEST_LEE (outdoor shelter volume at 40,-40). Whole project tsc clean; sim+net 67 pass.
- (step 2) thermal.test.ts (15, calibrated: storm walking 253 s / standing 222 s, soaked 95 s, fire 122 s),
  fire.test.ts (12). All pass.

- (step 3) items.test.ts (8), wood.test.ts (7), vitals.test.ts (10, incl. all-systems determinism + saves at
  4 points + JSON + leave cleanup). Full `npx vitest run`: 153 pass, 13 files. tsc clean.

## Remaining (priority order)
1. focus.ts / hudmodel.ts alignment edits.
2. tools/scenarios/survive.mjs, play the loop headless, fix.

## Design decisions (keep in sync with code)
- Tick order: spawn, env, players, wood (axe + heavy logs), items, fire, thermal, vitals.
- USE (BTN.USE + InputCmd.focus) is split by focus kind: pickup/crate -> items, fire -> fire, wood/log -> wood,
  player (downed) -> vitals, device -> objective (M4). Reach check: eye -> aim point <= 2.6 m + shape r + slack,
  and lineClear (helper `canReach` exported from items.ts).
- PlayerAct: each system owns its acts and advances actT itself: wood 'swing', items 'use' (crate hold) + 'eat',
  fire 'ignite', vitals 'revive'. A system starts an act only when act === 'none'.
- Per-player vars '<system>.<name>.<id>', deleted in leave hooks (sim.test checks this).
- Fire: nominal wood seconds in var 'fire.wood.<fireId>'; FireEnt.fuel = wood / burnRate (seconds at the current
  rate, as the contract says). size = visual stack (0 when no wood). Barrel is lit when the first player joins
  (var 'fire.kindled'; sim.test asserts every fire is unlit right after construction). Stove starts loaded, unlit.
- Starting kit stays in players.ts (flashlight + 6 matches, asserted by sim.test).
- Slow kinds (pickup, crate, wood) are touched only when they change (net.test checks snapshots).

## Edits outside owned files
- (none yet)

## Test commands
- npx vitest run src/sim
- npx tsc --noEmit -p .   (filter: | grep "src/sim\|src/game/focus\|src/game/hud")
