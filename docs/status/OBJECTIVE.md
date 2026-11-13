# OBJECTIVE — status / handoff

Module: lake ice, objective stages crash -> won/lost, story beats (milestone M4).
Files owned: src/sim/systems/ice.ts, objective.ts, story.ts (+ *.test.ts), tools/scenarios/endgame.mjs,
the ice/objective/story lines in src/sim/systems/index.ts; may extend src/sim/entities.ts, testworld.ts,
OPTIONAL members in src/sim/types.ts; small alignment edits in src/game/focus.ts, hudmodel.ts.

## Done
- ice.ts, objective.ts, story.ts; registered in index.ts (ice after players; objective after wolves and BEFORE
  vitals, so a lost game can refuse 'respawn'; story last). tsc clean for my files.
- types.ts: OPTIONAL IceCell.skin (new ice over a broken cell). HUNT's wolves already avoid holes and skin ice.
- testworld.ts: TEST_THIN patch (14,130) r 6, TEST_SAFE line, TEST_PAD deck anchor (world.anchors
  'tower:mast.deck'), TEST_BEACON / TEST_BED / TEST_DOOR positions. The devices are NOT in the spawn table
  (fire.test's gust check runs on (tick + fire id) % 30: extra spawn defs shift ids and break it).
- Tests: ice 15, objective 17, story 5 (all pass). `npx vitest run src/sim` all green.
- focus.ts: per-device aim shapes (DEVICE_AIM), 'Pull out' a swimming teammate (hold ring = puller's actT /
  PULL_TIME), panel 'Install' with hold ring / 'Check' n of 5, generator hold = charge, bunk 'Rest' hold,
  beacon not focusable (it lights by itself).
- hudmodel.ts: objective line per stage (power: parts in / crank / sending / dropped out; hold-out; rescue);
  hints 'swim' (pre-empts other hints, clears once out) and 'ice' (first time on the lake ice).
- objective calls HUNT's wolves.ts rallyWolves(ctx, pad) when the hold-out starts and when the rotors come
  (var objective.rally 1 / 2, so a loaded game does not repeat it).
- tools/scenarios/endgame.mjs PASSES on WebGPU and --backend webgl, console clean (shots/endgame_01..16):
  parts by CS.give -> creaks + warning -> through the ice -> climb out -> panel (5 installs) -> bot + player crank
  (17 s) -> fire by the deck -> call (transmit) -> hold-out in storm 1 (19 wolves rallied, 0 bites past the
  fire) -> flare on the deck (signalled) -> hover -> winch (player, then bot) -> won -> 'Rescued' card.
- A refused respawn in a lost game says why (toast). Per-player device work is skipped when nothing is held.
- My test files set a 30 s per-test timeout (60 s for the two whole-game tests): under the parallel suite and
  other agents' load, long simulations exceed vitest's 5 s default (alone: all 37 run in ~6 s).

## Remaining / for others
1. Nobody draws IceCell holes or refrozen cells (view.ice): a TERRAIN/FX job. Snapshots carry i / stress / hole
   only (net/host.ts iceCode), so `skin` stays host-side; a refrozen hole keeps stress >= SCAR 0.3 so a client
   can still show it as fractured ice.
2. GAME/UI: stage 'lost' (co-op, every human dead) has no screen of its own: the death screen's Respawn is
   refused by the sim. Show an ending for 'lost' and clear the save as for 'won'.
3. sim.test.ts storm trace (270k ticks, no players) is near vitest's 5 s timeout under parallel load (HUNT's wolves
   are most of the cost; my systems return early with no players).

## Design (decided)
### ice.ts (tick slot after players)
- Loads: players on the ice (alive/downed, on the ground, not swimming): bodyLoad = 1 x (1 + 0.1 speed),
  +0.8 dragging a heavy log alone, +0.45 one end of a pair, x0.6 lying downed; wolves 0.45 x (1 + 0.06 speed).
- A load bears on every cell within ICE_SPREAD 2.5 m (weight 1 - d/2.5, d to the cell's square): two people
  close add up and the ice ahead feels you coming. r = pressure (ICE_REF 0.12 / h)^2; stress rate
  0.075 (r - 0.6)(1 + 0.25 max(0, r - 1)); a player stepping on into overloaded ice carries 75 % of the last
  cell's stress. Unloaded cells relax 1/90 per s and drop out.
- Only the cell a load stands on breaks (one hole, under the feet); wolves alone are capped below 1.
- Creaks: each player hears the most strained cell within reach when it reaches a creak level (0.005, then
  +0.12) they have not heard (var ice.heard.<id>); the first one toasts a warning (ice.warned.<id>).
- Measured (2 m test grid): standing on 5 cm ice breaks in 1.2 s (9 creaks); walking in from sound ice, first
  creak ~1.8 s before the break, before the core; turning back at it holds; four huddled on 15 cm break in 5 s;
  the 0.56+ m safe line never takes stress. Real game: first creak at (186.8,-72.1), ~7 creaks, through.
- Water: swimmers kept inside open hole cells (ice.in.<id>); hold USE within CLIMB_REACH 0.8 m of a solid edge
  for climbTime(core) = 2 s (4 s at 30 C); a teammate within PULL_RANGE 2 m holding USE (focus = swimmer, or
  none) for PULL_TIME 1.5 s hauls them out (puller act 'use', ice.pull.<id>). Holes refreeze 1 cm/min x cold
  while nobody swims in them; at 2.5 cm hole -> false (thin new ice, stress floor 0.3), up to 7 cm.
### objective.ts
- crash -> search (radio or a part in a pack, 150 m from the wreck, or 240 s); search <-> tower (all five held or
  installed, read from every pack each tick; partFound emitted for parts that appear in a pack by other means);
  tower -> power (a living player within the tower radius). Install: hold USE at the panel, 2.5 s per part.
  Crank (all five in): USE, or PRIMARY with bare hands, at the generator; 1/30 per s, two on the handles 1.8x,
  idle -1/120 per s. Full charge keys the set (var objective.txOn, beacon on); transmit 1/60 per s while
  charge >= 0.3, drawing 1/50 per s -> 'transmit', holdout, eta 180.
- holdout: eta down; heli spawns 60 s out to the south (inbound, 26 m/s); eta 0 -> rescue. A landed burning flare
  within 14 m of the deck while the heli is up -> signalled. Heli phases inbound -> search (orbit 110 m; after
  100 s it finds the tower lights) -> hover (18 m up, 5 m off the deck away from the mast) -> winch (hook 4 s
  down, 6 s up; humans first, the downed first; life 'rescued'; aboard players ride at the heli) -> away ->
  won after 6 s.
- won: every living human aboard and no unrescued living bot in the winch circle. lost: co-op (2+ humans) every
  human dead at once; refuses 'respawn'. SOLO KEEPS RESPAWNING (vitals: last checkpoint, else the wreck).
- Devices: door toggles (progress animates), bunk (hold 2 s, core >= 34, once a minute) = the shared checkpoint
  (vitals CP keys, 'checkpoint' event), beacon on with the call.
- Debug actions (sim.debug): obj.stage [index into STAGES], obj.eta [s], obj.gen [charge].
### story.ts
- NOTES[0..6] (wreck, tail: the captain; cabin, hut: the ranger; cave, camp, tower: the survey crew), each
  pointing to the next place; read with USE (lore toast to the reader). First howl at 18:12 on day one (howl
  event id 0 from pack 0's range + a line); whiteout warning WARN_LEAD 100 s before each window (env
  whiteoutWindow); the radio's first clear tone (radioSig >= 0.8, radio held); the generator's first cough
  (charge >= 0.12). Quiet after the call.

## Test commands
- npx vitest run src/sim/systems/ice.test.ts src/sim/systems/objective.test.ts src/sim/systems/story.test.ts
- npx vitest run src/sim ; npx tsc --noEmit -p .
- node tools/play.mjs tools/scenarios/endgame.mjs [--backend webgl]   (shots/endgame_*.jpg)

## Final report

OBJECTIVE is complete: the lake ice, the stages from the crash to the ending, the helicopter, the story beats. My 37 tests pass (ice 15, objective 17, story 5). The whole project type-checks. `tools/scenarios/endgame.mjs` PASSES on WebGPU and WebGL2 with a clean console.

**Files:** src/sim/systems/ice.ts, objective.ts, story.ts and their tests; tools/scenarios/endgame.mjs; in index.ts, ice comes after players, objective before vitals (so a lost game can refuse 'respawn'), story last.

**API:**
- ice.ts: `iceDanger(ctx, x, z)` 0..1, `onOpenWater(ctx, x, z)`, `bodyLoad(p)`, `stressRate(r)`, `climbTime(core)`, `PULL_RANGE`, `PULL_TIME`.
- objective.ts: `padOf(world)`, `deviceOf(ctx, type)`, `deviceReach(ctx, p, d)`, `DEVICE_AIM`, `partsIn(ctx)`, `PARTS`, `PART_ITEM`, `STAGES`, `INSTALL_TIME`, `BED_TIME`; debug `obj.stage | obj.eta | obj.gen`.
- story.ts: `NOTES`.

**Contract addition:** optional `IceCell.skin` (new ice over a broken cell; host-side, since snapshots carry i, stress, hole). HUNT's wolves already avoid it.

**Edits outside my files:**
- focus.ts: per-device aim shapes; 'Pull out' for a teammate in the water; hold rings for install and the bunk; 'Check' on the panel; the beacon cannot be focused.
- hudmodel.ts: the objective line per stage; 'swim' and 'ice' hints.
- testworld.ts: a thin patch, a safe line, the deck anchor.

**Decisions:**
- Solo keeps respawning (at the last checkpoint, else the wreck).
- 'lost' happens only in co-op, when every human is dead at once.
- The hold-out calls HUNT's `rallyWolves` twice: when the call goes out, and when the rotors come.
- The doors, the bunk (a checkpoint) and the beacon are handled here too.

**Gaps:**
1. Nothing draws ice holes or refrozen cells (view.ice).
2. Stage 'lost' has no screen: the death screen's Respawn is refused. GAME should also clear the save on 'lost'.
3. Under the parallel suite, other modules' timing tests (and sim.test's 270k-tick storm trace) can time out; each passes on its own.
4. The scenario resets the body after the lake, because the walk to the tower is skipped.
