# Brief: OBJECTIVE — the lake ice and the way off the mountain (milestone M4)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR MODULE: OBJECTIVE. Files you own: src/sim/systems/ice.ts, objective.ts, story.ts, their *.test.ts,
tools/scenarios/endgame.mjs, and the lines for them in src/sim/systems/index.ts (the HUNT engineer adds wolves /
tools lines at the same time: re-read the file right before each edit). You may extend src/sim/entities.ts and
testworld.ts and add OPTIONAL members to src/sim/types.ts. Small alignment edits in src/game/focus.ts,
hudmodel.ts are allowed (objective line, hints, focus verbs for the panel and generator); list them. Do not touch
src/gfx, src/actors, src/models, src/ui, src/audio.
Read first: DESIGN.md section 1 (story, places, ending), docs/status/SIM.md, SURVIVAL.md (items, parts already
set 'held', vitals, thermal: wet and swim), GAME.md, WORLD.md (lake grid, thickness, safe line, thin ice,
blueprints and anchors for the tower panel, generator, pad; parts and their places).
Pure deterministic TypeScript: ctx.rand() only, all state JSON, no three, no DOM.

1. ice.ts — lake ice that can crack: stress per cell from players (and wolves) standing and moving on it,
   higher on thin ice, for heavier loads (carrying a log, two players close) and for running; it relaxes slowly.
   iceCreak events with growing stress, a loud crack (iceBreak) at the limit opening a hole (IceCell.hole) under
   the player: they fall in (p.swim, soaked at once, core drops fast), can swim slowly, climb out at an edge with a
   hold of USE (or be pulled out by a teammate within 2 m), the hole stays and refreezes thinly over minutes.
   The pole-marked safe line holds. Wolves avoid thin ice. Hints: the first creak warns.
2. objective.ts — the stages crash, search, tower, power, holdout, rescue, won, lost. Parts held by anyone count;
   at the tower panel a player installs each held part (hold USE at the panel, partInstalled); with all five the
   generator must be charged by cranking (hold PRIMARY or USE at the crank: co-op makes it faster; charge decays
   if nobody cranks), then transmit (progress over about 60 s while the generator holds charge); then the
   helicopter is called: eta about 3 minutes, env storm forced to its worst (the env system already reads stage
   'holdout'), the last packs wake and come; a flare fired near the pad marks it (signalled); the 'heli' entity
   flies in (inbound, search, hover, winch, away) with its own simple path; players in the winch circle are
   rescued one by one; won when every living player is rescued; lost when every player is dead (solo: when the
   player dies with no checkpoint to respawn at, or keep respawning if you think that plays better; say which).
   HUD objective text per stage; toasts; stage events.
3. story.ts — the beats that make the hour: notes at the places (device 'note' entities: short plain lines from
   the pilot and the ranger and the surveyors, one per place, pointing to the next), the first howl at dusk on day
   one, a whiteout warning before each scripted whiteout, the radio's first clear tone, the generator's first
   cough. Keep it spare and grave.
4. Tests: ice stress and breaking, the safe line, falling in, climbing out, being pulled out, every stage
   transition, installing parts, co-op cranking speed, transmit, eta, signalled, winch, won and lost, saving and
   loading in every stage, determinism and JSON safety with every system on. npm test green.
5. tools/scenarios/endgame.mjs in the real game: a scripted run that gives the parts (CS.give), walks onto the
   lake and through the ice and out, installs the parts at the tower, cranks the generator with a bot, transmits,
   survives the hold-out, fires a flare at the pad, is winched, and reaches the ending screen. Shots at each beat;
   clean console. The tower and heli are drawn as stand-ins until the STRUCTURES and FX engineers' work lands.

STATE ON DISK: nothing of yours exists. Create docs/status/OBJECTIVE.md first and keep it current.
