# Brief: FX — fire, flares, light and the body's view of the cold (milestones M2 and M6)
(Read docs/briefs/COMMON.md first; ignore its "THIS IS A CONTINUATION" paragraph except the advice on handoff
notes and reading narrowly.)

YOUR MODULE: FX. Files you own: src/gfx/fx/**, dev/fx.html, dev/fx.ts, and ONE registration line in
src/game/visuals.ts (re-read it right before editing; others add their own line at the same time).
Read first: docs/status/ENGINE.md (post HDR stages and overlays), LOOK.md, ATMOS.md (lights, fog, U), KIT.md
(emitters on placed props), GAME.md (View, hud.frost / wetLens / hurt / lowHealth, sim events on the bus),
SURVIVAL.md (fire fields: lit, fuel, heat, size, embers, shelter), docs/THREE_NOTES.md.

Deliver `createFxSystem(engine, world): GfxSystem` ('fx'), driven by f.view (list('fire'), list('flare'),
players, events on view.bus 'sim', hud) and by KIT props' emitters.
1. Fire: campfires, the barrel and the stove: flames that look like burning wood, not sprites (layered TSL noise
   flame cards or a small volume, licking and leaning with the wind, height and brightness from heat and size),
   glowing coals and char, embers rising and swirling downwind, smoke that rises then shears off in the wind and
   fades into the fog, steam where snow melts at the rim, a fire that gutters in a gust. Ignition: a match flare,
   catching, growing; dying: shrinking to embers, a thin smoke.
2. Light: one pool of dynamic point and spot lights capped by quality.maxLights, assigned by importance and
   distance (fires, flares, the flashlight beams, muzzle flashes, the cabin lamp, tower lamps), with flicker for
   fire (several noise frequencies, not a sine), hot near / cool far colour, and a fire shadow for the nearest fire
   when quality.fireShadows. Expose it so FIGURES (flashlight) and others can request a light.
3. Flares: the burning red flare in flight (trail of sparks and smoke) and on the ground (fierce magenta-red light
   over the snow, sputtering, dense drifting smoke), dying at the end.
4. Breath: vapour puffs from every player in the cold (rate from exertion, bigger when colder, drifting with the
   wind, lit by fires), including the local player's own breath at the bottom of the view.
5. Screen overlays (engine.post.addOverlay): frost creeping in from the screen edges as hud.frost rises (crystal
   growth, not a vignette), melt drops on the goggles when warming by a fire or indoors (hud.wetLens), hurt flash
   and low-health desaturation, snow flakes hitting the lens in a storm facing the wind. Cheap on 'mobile'.
6. Small things: muzzle flash and a puff of smoke for the rifle, sparks when the axe hits, snow puffs at
   footsteps in deep snow and when something drops in the snow, a splash and ice shards when the ice breaks.
Budgets at 'medium': all FX under 1.5 ms GPU at a burning fire with a flare; 'mobile' a fraction of that.
Bench dev/fx.html: ?fire=0..3 (stage) &wind= &light=day|dusk|night|storm &flare=1 &frost=0..1 &breath=1 ?webgl=1.
Shoot on WebGPU, WebGL2, --mobile 1, then in the real game (the survive scenario lights fires: tools/scenarios/
survive.mjs). Read every shot; a fire should look like a fire in a photograph; iterate.

STATE ON DISK: nothing of yours exists. Create docs/status/FX.md first and keep it current.
