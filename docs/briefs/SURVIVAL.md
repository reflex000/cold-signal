# Brief: SURVIVAL — the simulation of staying alive (milestone M2)
(Read docs/briefs/COMMON.md first. Ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and on reading narrowly: your systems are new.)

YOUR MODULE: SURVIVAL. Files you own: src/sim/systems/thermal.ts, fire.ts, items.ts, wood.ts, vitals.ts and their
*.test.ts, plus the lines for them in src/sim/systems/index.ts. You may extend src/sim/entities.ts and src/sim/
testworld.ts (SIM+NET is finished; nobody else edits src/sim now). Contract files (src/sim/types.ts, api.ts):
add OPTIONAL members only, in the right section, JSON-safe. You may make small alignment edits in
src/game/focus.ts and src/game/hud*.ts so prompts match what the simulation accepts; list every such edit.
Graphics engineers are working in src/gfx at the same time: do not touch src/gfx, src/world, src/ui, src/audio.

Read first: docs/DESIGN.md section 1 (the rules and the numbers), docs/status/SIM.md (Sim, SimCtx, systems,
movement, tests), docs/status/GAME.md (how focus, actions and HUD use the simulation; what is wired but never
ran), docs/status/WORLD.md (shelterAt, groundAt, surfaceAt, iceAt, spawn defs, fall heights), src/sim/types.ts.

Everything here is pure, deterministic TypeScript: no three, no DOM, no Math.random, no Date. All randomness
through ctx.rand(). All state in SimState (JSON). Every change is caused by an InputCmd, an Action or the tick.

1. thermal.ts — body temperature for every player each tick. Air temperature at the player's height (env.airTemp
   at the crash altitude, minus 0.65 degrees per 100 m), wind chill from wind speed times (1 - shelter) using
   world.shelterAt and the gust, wet clothes (falling snow soaks slowly unless sheltered; water through the ice
   soaks at once; wet roughly triples heat loss and dries only by a fire or indoors), exertion (sprinting warms a
   little), fire warmth (lit fires within about 6 m, falling with distance, blown away downwind unless the fire is
   sheltered, blocked by walls), huddle (other players within 2.5 m share warmth), hunger (rises slowly; a hungry
   body warms slowly), thermos and ration effects. Fill p.feels, shelter, fireHeat, huddle, trend. Core stages:
   37 healthy, 35 cold, 33 freezing, 31 severe (health drains), 30 collapse (downed). Tune to the design pace and
   prove it with tests: exposed in a full storm, 37 to 33 in 4 to 5 minutes; wet in a whiteout, about 90 s; next to
   a good fire, 33 back to 37 in about 2 minutes; indoors with the stove lit you warm even at night.
2. fire.ts — buildFire (3 sticks; laid in front of the player on snow or ground, not on ice or water or inside a
   wall; its shelter from world.shelterAt), ignite (one match is always used; success chance from wind on an
   unsheltered fire, tinder makes it near certain, a wet player fumbles; igniteFail with the reason), feed (stick
   40 s, tinder 15 s, split log 3 min, a heavy log dropped at the fire 12 min), burn rate rising with wind, heat
   ramping up after lighting and sagging when starved or snowed on, a starved unsheltered fire killed by a strong
   gust or heavy snowfall, embers that relight without a match for a while, the fixed stove (cabin) and barrel
   (wreck) types from the spawn defs. Events per sim/types.ts.
3. items.ts — taking pickups and opening crates through BTN.USE on InputCmd.focus (validate reach about 2.6 m and
   line of sight; short hold for crates), carrying limits (decide sensible ones, e.g. 12 sticks, 4 split logs),
   consume (bandage heals and stops bleeding, ration resets hunger, thermos warms the core strongly), drop (spawns
   a pickup), give (to a player within 3 m), toasts for the local player, radio parts set objective.parts[part] =
   'held' and emit partFound (the rest of the objective is M4's). Starting kit per the design.
4. wood.ts — the axe: PRIMARY swings on a 'wood' entity in reach chop it (hp per type); at zero it yields sticks and
   split logs as pickups and emits chopped; standing snags fall. Heavy logs: the 'carry' action takes the nearer
   free end, 'release' drops it; one carrier drags (move.ts reads p.carry), two carry at walking pace (set
   p.carryPair); the log entity follows its carriers and keeps its length between them; dropped within 1.5 m of a
   fire it feeds it.
5. vitals.ts — health; fall damage on landing by impact speed (the south cliff is 15 to 40 m: a long fall is
   death); downed from cold collapse or health 0 (bleed timer 90 s, crawl); revive by another player holding USE
   for 5 s within 1.5 m (comes back with health 30 and a little warmth); solo self-revive once per checkpoint
   by consuming a bandage while downed; death when the timer runs out; checkpoints when a player rests warm at a
   lit fire (emit 'checkpoint'; store the spot in state.vars); the 'respawn' action puts a dead player back at the
   last checkpoint with low warmth and health (co-op: the others keep playing); isolation (how alone a player is,
   for the wolves).
6. Tests (vitest) for every rule above, including determinism and JSON safety with all systems on. npm test must
   stay green for the whole project.
7. Then run the real game in the headless browser (node tools/play.mjs, see docs/status/GAME.md) and write a
   scenario tools/scenarios/survive.mjs that plays the loop for real: walk into the storm and get cold, gather
   sticks, build and light a fire (with a failure in the wind), warm up, feed it, chop deadfall with the axe, carry
   a heavy log with a bot, go down from cold, get revived by the bot, open a crate, eat. Shots at each beat; check
   the HUD reflects it and the console is clean. Fix what does not work, on your side or (small fixes) in focus.

STATE ON DISK: nothing of yours exists yet. Create docs/status/SURVIVAL.md first and keep it current.
