# Brief: VIEWMODEL — first-person hands and the tools (milestone M3)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR MODULE: VIEWMODEL. Files you own: src/actors/fp/**, src/models/tools/**, dev/fp.html, dev/fp.ts, and one
registration line in src/game/visuals.ts (re-read it right before editing; others edit it at the same time).
Read first: docs/status/FIGURES.md (the third-person figures: match their mitts, sleeves and tool grips),
HUNT.md (tool timings and constants: swing, bolt, reload, flare, crank, beam, rifleSway), SURVIVAL.md (acts:
eat, bandage, ignite, feed, carry), FX.md (light pool for the flashlight beam, muzzle flash, sparks), GAME.md
(view.rig: bob, stride, sway, recoil, breath, shiver, landing; camera), KIT.md and the kit header.

1. Tool models with the KIT Builder, as photographed objects: a felling axe (hickory haft, worn head, a strip of
   tape), a heavy rubber flashlight, an orange flare pistol, a bolt-action hunting rifle with a scope and a sling,
   a hand-crank emergency radio (crank handle, antenna, a signal needle or LED bar, speaker grille). Register them
   (axe, flashlight, flaregun, rifle, radio) so they also serve as pickups in the world and in third-person hands
   (tell FIGURES' code where the grip anchors are, or use their anchor names if they exist).
2. First-person view: the local player's arms in parka sleeves with mitts, holding the held tool, drawn in a
   separate pass or with depth tricks so they never clip into walls, with their own small FOV, lit by the same
   light (fire glow, flashlight, moon) and fogged correctly.
3. Animation, procedural, driven by the predicted local player (view.me: held, act, actT, aim, loaded, flareLoaded,
   radioCharge, radioSig, beam, carry, life) and view.rig: equip / unequip, idle sway and breathing, walk and run
   bob, landing dip, shivering hands when cold, axe swing with the hit on the sim's hit frame, rifle aim down the
   scope (scope view with drift from tools rifleSway, steady when holding breath is not needed), recoil, bolt cycle,
   reload, dry click, flare pistol fire and break-open reload, flashlight held forward (a real beam through FX's
   light pool, flicker when the cell is low), radio held up with the crank turning and the needle following
   radioSig, match strike and cupped hands when igniting, eating and bandaging, both hands on a log when
   carrying, crawling hands when downed. Hide while the camera is third-person.
4. Bench dev/fp.html: ?tool= ?act= ?light= ?webgl=1, a contact sheet of each tool's poses. Then in the real game
   (tools/play.mjs: equip each tool with CS.equip, fire, aim, reload; HUNT's hunt.mjs scenario has a night with
   wolves). Read every shot; judge harshly: do the hands and tools look like a real photograph from behind the
   goggles? Fix clipping, scale, lighting.

STATE ON DISK: nothing of yours exists. Create docs/status/VIEWMODEL.md first and keep it current.
