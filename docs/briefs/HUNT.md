# Brief: HUNT — wolves and tools in the simulation (milestone M3)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR MODULE: HUNT. Files you own: src/sim/systems/wolves.ts, tools.ts, their *.test.ts, tools/scenarios/hunt.mjs,
and the lines for them in src/sim/systems/index.ts (another engineer adds ice / objective lines at the same time:
re-read the file right before each edit). You may extend src/sim/entities.ts and testworld.ts, and add OPTIONAL
members to src/sim/types.ts. Small alignment edits in src/game/focus.ts, hudmodel.ts, input.ts are allowed;
list them. Do not touch src/gfx, src/actors, src/models, src/ui, src/audio.
Read first: docs/DESIGN.md section 1, docs/status/SIM.md, SURVIVAL.md (hurt(), vitals, fire, items helpers),
GAME.md (input, focus, bots, CS hook, scenarios), WORLD.md (packs, walkable, lineClear, raycast).
Pure deterministic TypeScript: ctx.rand() only, all state JSON in SimState, no three, no DOM.

1. tools.ts — the held tool acts on BTN.PRIMARY / SECONDARY and actions (equip, reload, toggleLight):
   axe (swing timing and reach; on a wolf: damage and a stagger; chopping wood stays in wood.ts, so share the swing
   timing with it rather than double-handling), flashlight (toggle, cell drains over about 12 minutes, 'cell' items
   recharge it; dims when low), flare gun (one cartridge loaded; fire a 'flare' entity on a ballistic arc with drag
   and wind, it lands, burns 40 s, emits flareShot / flareLand / flareOut), rifle (bolt action, 5 in the magazine,
   reload from 'ammo', aim raises with SECONDARY, sway grows with cold, exhaustion and wind, hitscan through
   world.raycast plus wolf hit volumes, a hit hurts or kills, dry click, every shot is loud: wolves hear it),
   hand-crank radio (PRIMARY held cranks and charges; while charged and held up, p.radioSig / p.radioDist give the
   strength of the nearest missing radio part in the facing direction, later the tower: a tone that rises as you
   face it and as you get closer). Ammunition is scarce: never invent rounds.
2. wolves.ts — packs from world.spawn.packs, waking at their wakeAt times, more wolves for more players. Moods per
   sim/types WolfMood: rest, roam, stalk (keep to the edge of the target's sight, use cover and the storm), circle
   (orbit at 15-30 m), feint (one wolf darts in and away), charge, bite (damage via vitals hurt(), knock-down
   chance), drag (a downed player), flee, cower, howl (before a hunt and to gather the pack; howl events with
   positions so others answer from afar), feed, dead. Target choice weighs isolation, low health, downed,
   darkness, whiteout and a dying fire. Fear: a strong fire's light radius is a wall they will not enter; a burning
   flare holds them off and breaks a circle; a gunshot scatters the pack for a while, a kill for longer; the
   flashlight beam in the face makes a wolf hesitate. Boldness grows with hunger, night, whiteout, and with the
   pack's size versus the players'. Movement on walkable ground, avoiding steep slopes, the lake's thin ice and
   walls (world.walkable, slopeAt, collidersNear), smooth turning and speeds per gait (walk 1.5, trot 4, gallop 11
   m/s). Wolves die (wolfDie), and dead wolves stay a while. Keep it cheap: 16 wolves must cost well under 0.2 ms
   per tick.
3. Tests: tool timings and ammunition, flare ballistics and burn, rifle hit and miss, radio direction, wolves
   waking, stalking at range, refusing to enter firelight, scattering at a shot, picking the isolated player of
   two, attacking a downed player, determinism and JSON safety with every system on. npm test green.
4. tools/scenarios/hunt.mjs in the real game (see GAME.md): night, a pack wakes and howls, stalks, circles the
   players; one player stands by a fire and is left alone; the isolated one is charged; a flare breaks the circle;
   a rifle shot scatters them; an axe hit makes one yelp. Shots at each beat; clean console. Wolves are drawn as
   markers until the FIGURES engineer's actors land (being built in parallel); judge behaviour, not looks.

STATE ON DISK: nothing of yours exists. Create docs/status/HUNT.md first and keep it current.
