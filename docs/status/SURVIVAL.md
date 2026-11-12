# SURVIVAL status (milestone M2)

Owner files: src/sim/systems/thermal.ts, fire.ts, items.ts, wood.ts, vitals.ts (+ *.test.ts), their lines in
src/sim/systems/index.ts; may extend src/sim/entities.ts, src/sim/testworld.ts; optional members in
src/sim/types.ts / api.ts; small alignment edits in src/game/focus.ts, src/game/hud*.ts (listed below).

## Status: complete (session 1, 2026-11-12)
Everything in docs/briefs/SURVIVAL.md exists, is tested and plays in the real game.
- `npx vitest run`: 153 pass (13 files); mine: thermal 15, fire 12, items 8, wood 7, vitals 10. tsc: 0 errors.
- `node tools/play.mjs tools/scenarios/survive.mjs` PASS on WebGPU and `--backend webgl`, console clean.
  focus.mjs and bots.mjs still pass.

## Remaining / ideas (none required)
1. GAME's bot brain (src/game/bots.ts) does not revive downed players or take the other end of a log; the
   scenario drives a host bot by hand. Suggested for GAME: USE + focus on a downed teammate within 1.5 m.
2. src/ui/inventory.ts GIVE_RANGE is 4 m; the sim hands over within 3 m (+0.25) and toasts "X is too far away."
3. The axe only hits dead wood and the ground; wolf hits belong to whoever writes wolves/tools (M3): extend
   wood.ts resolveSwing or call vitals `hurt()` / damage wolves there.
4. Lake ice (falling in) is not mine: thermal reads p.swim (wet = 1 at once, -3.5 C/min immersion).

## Design decisions / API facts
- Tick order: spawn, env, players, wood (axe + heavy logs), items, fire, thermal, vitals.
- USE (BTN.USE + InputCmd.focus) is split by focus kind: pickup (press) / crate (hold 0.6 s) -> items; fire
  (press: lit or bare -> feed a stick, else a split log; unlit with wood -> light) -> fire; wood (USE takes the
  axe out of the pack, then chops) / log (lift / put down) -> wood; downed player (hold 5 s) -> vitals;
  device -> objective (M4). Reach: items.ts `canReach(ctx, p, e, extra?)` = eye -> aim point <= 2.6 m + shape r
  + 0.5 slack, and world.lineClear stopping short of the thing. `focusOf(ctx, p, kind)`.
- PlayerAct: each system owns its acts and advances actT itself: wood 'swing' (0.8 s, lands at 0.32 s), items
  'use' (crate hold; only reset when its own var items.crate.<id> is set) and 'eat' (1.6 s), fire 'ignite'
  (1.2 s), vitals 'revive'. A system starts an act only when act === 'none'.
- Per-player vars '<system>.<name>.<id>' are deleted in leave hooks. Global: fire.kindled, fire.wood.<fireId>
  (seconds of calm burn stacked; FireEnt.fuel = wood / burnRate), vitals.cpX/cpY/cpZ/cpFire/cpT (checkpoint).
- Barrel lit when the first player joins (sim.test asserts every fire unlit right after construction); stove
  laid with 6 min of wood, unlit. Starting kit stays in players.ts (flashlight + 6 matches).
- Slow kinds (pickup, crate, wood) are touched only when they change (net.test checks snapshots).
- Thermal model (deg C / min): loss = (0.022 (Tn - T) + 0.030 wind (1 + max(0, -10 - T)/40)) * (1 + 2 wet) *
  (1 + 0.2 hunger) * (1 - 0.6 fire) * (1 - 0.35 huddle); gain = (4.5 fire + 0.35 huddle + thermos 3 + ration 0.6)
  * (1 - 0.4 hunger). T = env.airTemp - 0.65/100 m above the wreck (+10 indoors), wind = speed (1 + 0.5 gust)
  (1 - shelter), Tn = BALANCE (still -4.8, walk -10.8, sprint -22.8, chopping -16.8, downed -2.8). Snow soaks
  0.0005/s * snowfall * (1 - shelter); dries 1/100 s at full fire, 1/400 s indoors. feels = wind chill index +
  38 fire + 5 huddle. Measured: full storm walking 253 s / standing 222 s (37 -> 33); soaked 95 s; good fire
  across a 10 m/s wind 33 -> 37 in 122 s (upwind 163, downwind 97); real game whiteout 37 -> 34.4 in 243 s.
- Fire: ignite chance = (tinder ? 0.995 : 0.93) - 0.8 wind (x0.12 with tinder) - 0.4 wet, wind = sat((V - 3)/11)
  (1 - shelter); one match always, tinder used with it. Burn rate 1 + 1.3 sat((V - 2)/18)(1 - shelter). Heat
  target (0.2 + 0.8 (wood/150)^0.6) * cap * (1 - 0.3 snow) * (1 - 0.25 wind), up tau 22 s, down 7 s. Starved
  (< 30 s left) open (shelter < 0.5) fire: once a second gust/snow kill chance. Embers 180 s (75 s after a
  kill) relight free. Radius campfire 6, stove 7, barrel 5.5; warmth blown downwind off open fires.
- Vitals: fall damage 100 ((v - cushion - 7.5)/11.5)^1.6 (cushion deep 1.5, snow 0.7), >= 100 kills outright;
  cold drain 1.2 hp/s * (31 - core) below 31; down at core 30 or health 0; bleed 90 s (paused while revived);
  revive 5 s within 1.5 m -> health 30, core max(core + 1.2, 32); alone (no other living human: bots do not
  count) a bandage gets you up once per checkpoint, otherwise it resets the bleed timer; checkpoint after 6 s
  resting (speed < 0.8, core >= 36) within 3.5 m of a lit fire, again at the same fire only after 180 s;
  respawn at the checkpoint (else the spawn slot) with health 35, core 33.5; isolation smoothstep(8, 60, nearest
  living teammate), 1 alone.
- Carry limits (entities.ts CARRY_LIMIT): sticks 12, split logs 4, tinder 6, matches 30, flares 6, rounds 20,
  cells 4, bandages 6, rations 6, thermos 2, tools and parts 1.

## Edits outside owned files
- src/game/focus.ts: fire 'Add wood' when nothing is on it, 'needs wood' counts sticks/logs only (E never feeds
  tinder); crate hold ring from me.act === 'use' / CRATE_HOLD; revive note 'move closer' beyond REVIVE_RANGE;
  no 'Lift' while already carrying a log.
- src/game/hudmodel.ts: cold hint names the B key (touch: "from the pack").
- src/sim/entities.ts: CARRY_LIMIT, isItemId, packRoom. src/sim/testworld.ts: TEST_LEE outdoor shelter volume.
- No contract changes (types.ts / api.ts untouched).

## Test commands
- npx vitest run src/sim            (all: npx vitest run)
- npx tsc --noEmit -p .
- node tools/play.mjs tools/scenarios/survive.mjs [--backend webgl]   (shots/survive_*.jpg)

## Final report
SURVIVAL is complete. All 153 project tests pass (52 of them mine) and tsc reports 0 errors. The new scenario `tools/scenarios/survive.mjs` plays the whole loop in the real game and passes on WebGPU and WebGL with a clean console.

**Files:** src/sim/systems/{thermal,fire,items,wood,vitals}.ts plus a test file for each; the SYSTEMS lines in index.ts (order: wood, items, fire, thermal, vitals after players); helpers added to entities.ts; an outdoor shelter volume added to testworld.ts.

**Public API:**
- items.ts: `canReach(ctx, p, e, extra?)`, `focusOf(ctx, p, kind)`, `takeItem(ctx, p, item, n): number`, `removeItem(ctx, p, item, n)`, `spawnPickup(ctx, item, n, x, z, y0, yaw)`, `toast(ctx, p, kind, text, item?)`, `CRATE_HOLD`, `REACH`.
- vitals.ts: `hurt(ctx, p, amount, cause)` (for wolves), `fallDamage(impact, surface)`, `REVIVE_RANGE`, `BLEED_TIME`, `CP` var keys.
- fire.ts: `feedFire(ctx, f, seconds, by, item)`, `woodOf`, `burnRate`, `WARM_RADIUS`, `BURN`.
- thermal.ts: `coreRate(exposure)`, `windChill`, `airAt`, `warmthFrom`.
- wood.ts: `logEnds(l)`.
- entities.ts: `CARRY_LIMIT`, `isItemId`, `packRoom`.

**Pace, measured:** full storm 37 to 33 in 253 s walking (222 s standing). Soaked in a whiteout, 95 s. A good fire takes you from 33 to 37 in 122 s. A lit stove warms you at night.

**Contract additions:** none.

**Edits outside my files:** focus.ts gets 'Add wood', a crate hold ring, a 'move closer' note for revive, and no Lift while carrying. The cold hint in hudmodel.ts now names the B key.

**For others:**
- GAME's bot brain does not revive or carry logs, so the scenario drives a host bot by hand.
- The UI's GIVE_RANGE is 4 m, but the sim hands over within 3 m.
- Axe hits on wolves and the lake ice (setting `p.swim`) are M3/M4 work.
- Frost on screen: `hud.frost` reaches 0.85 in the model, but the stand-in post shows no frost.
