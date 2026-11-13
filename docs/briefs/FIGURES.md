# Brief: FIGURES — the people and the wolves, fully animated (milestone M3)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR MODULE: FIGURES. Files you own: src/actors/** (except src/actors/fp/**, which another engineer may create
later), dev/actors.html, dev/actors.ts, and ONE registration line in src/game/visuals.ts (re-read it right before
editing; others add their own line at the same time).
Read first: docs/DESIGN.md sections 1-2, docs/status/GAME.md (View, ents, visuals.ts seam, markers),
ENGINE.md, KIT.md (the model toolkit and prop material, reuse what fits), docs/THREE_NOTES.md (sections on
instancing, vertex colours, skinning if present), src/sim/types.ts (PlayerEnt, WolfEnt, their fields and moods).

Deliver `createActorsSystem(engine, world): GfxSystem` ('actors') that draws every player except the local one in
first person (the local one too when view.camera.third > 0) and every wolf from view.list('player') /
list('wolf'), replacing GAME's markers for those kinds. Everything is generated in code.

1. The player figure: an adult bundled for a mountain storm, believable proportions, no visible face: insulated
   parka with a deep hood and fur ruff, goggles over a scarf or balaclava, insulated trousers, boots, mitts, a
   backpack with a rolled mat. Parka colour by slot (muted red, ochre, slate blue, olive), everything else dark and
   worn; snow clinging to shoulders, hood and boots; cloth shading from the KIT material (CLOTH, FUR, RUBBER).
   Built as a skinned mesh on a procedural skeleton (or rigid parts with careful joints if skinning in r187 TSL is a
   problem: verify on both backends first and say which you chose and why).
2. Player animation, procedural and blended, driven by the entity fields (speed, onGround, crouch, sprint, act /
   actT, held, aim, carry, life, core): idle breathing and shivering when cold, walk and run with foot placement on
   the slope, wading slower in deep snow, crouch, jump and land, crawl when downed, kneel to revive, carry one end of
   a log, swing the axe, raise and fire the rifle with recoil and bolt, aim the flare gun, crank the radio, hold the
   flashlight (a real spotlight from the hand, through the engine's light pool if one exists, else a capped
   SpotLight), eat, dead. Head and torso turn toward the look direction (pitch, yaw).
3. The wolf: a large grey timber wolf in winter coat (fur via shells or layered cards, darker saddle, pale belly,
   frost on the coat), skinned or articulated; procedural gaits walk, trot, gallop with correct footfall order,
   stalking crouch, circling, howl pose, snarl, lunge and bite, yelp and flinch, cower, lying at rest, death.
   Eyes that shine green-gold when a light (flashlight, flare, fire) faces them. Variation from WolfEnt.variant.
4. Cheap enough for 4 players and 16 wolves on screen at 'medium' (instancing or shared skeleton textures where
   possible), with distance LOD; shadows; correct in fog.
5. Bench dev/actors.html: ?show=player|wolf|pack|all, ?anim=<name>, ?slot=0..3, ?light=day|dusk|night|storm,
   ?webgl=1, ?mobile; a contact sheet image of every animation at a few phases. Shoot on WebGPU, WebGL2 and
   --mobile 1. Read every shot and judge harshly against a real winter photograph: proportions, silhouettes,
   cloth, fur, motion. No mannequins, no toy look. Then check them in the real game (tools/play.mjs; GAME.md
   shows how to spawn bots and give them inputs; the HUNT engineer is writing wolf behaviour in parallel, CS.act /
   debug actions can spawn wolves if available, otherwise spawn them in your bench) and fix grounding and scale.

STATE ON DISK: nothing of yours exists. Create docs/status/FIGURES.md first and keep it current.
