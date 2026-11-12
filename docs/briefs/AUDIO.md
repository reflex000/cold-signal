# Brief: AUDIO
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: AUDIO (everything except the music score). Files you own: src/audio/** except src/audio/api.ts
(frozen contract) and src/audio/music/** (another engineer is writing the score there right now),
dev/audio.html, dev/audio.ts, tools/audio-check.mjs.

Build export function createAudio(): AudioApi in src/audio/index.ts implementing src/audio/api.ts completely.
Everything is synthesised with the Web Audio API at run time. No files, no fetch.

- A small DSP toolkit (src/audio/dsp.ts): noise sources (white, pink, brown; pre-rendered buffers), envelopes,
  filters, waveshaping, a convolution reverb whose impulse responses are generated in code (a small dead room for
  the cabin, a cave, and a huge open mountain tail with distinct late echoes for gunshots and howls), a
  limiter / compressor on the master bus with headroom so twenty voices never clip, buses: ambience, sfx, music,
  ui. Voice pooling and a hard cap. Spatial sounds use PannerNode (HRTF where affordable, equalpower on phones)
  plus distance low-pass (air absorbs highs) and a storm factor: wind masks distant sounds.
- Ambience (setAmbience): the wind is the heart of the game's sound. Layered filtered noise with slow random
  modulation: a low body, mid rush, high hiss, and narrow resonant whistles that appear with strong wind; gusts
  swell and pass (gust), direction pans with windDir relative to the listener; storm adds weight and a distant
  roar; shelter and indoor muffle it (indoors: a low moan through the walls, creaks, the stove); forest adds
  the hush of pines and occasional creaking trunks and snow sliding off branches; height thins it and adds a
  hard edge; on the lake, rare deep ice booms and eerie pinging sweeps far away; night is quieter and closer.
  Cold drives the body: breath gets ragged, teeth chatter, heartbeat rises, the mix narrows and dulls.
- Footsteps (footstep): snow is a squeaky compressive crunch (a burst of filtered noise with a granular
  crackle and a low thump), deeper and softer in deep snow ('deep', depth), a hard tick and scrape on rock, a
  glassy knock with a faint resonant sing on ice, hollow thuds on wood, a ring on metal. Vary every step.
- Every SfxName and LoopName in api.ts, designed, not beeped: fire loop (crackle as random pops through
  resonators over a breathing roar; param = heat), match strike, wolf howls (a harmonic voice with formants,
  slow pitch rise, hold, fall, breaks; 'howl_far' is the same call filtered and echoed by the mountain; several
  wolves answer with different pitches), growl, bark, yelp, the rifle (a sharp crack, body thump, then the
  mountain answers: a long rolling echo), bolt action, dry click, flare gun pop and the fierce hiss of the
  burning flare, radio static whose noise parts to a clear two-tone signal as param rises, the hand crank, ice
  creaks, the gunshot-like crack and the long sci-fi "pew" sweep that real lake ice makes, the break and splash,
  the generator sputtering to life, the helicopter (rotor thump with Doppler-ish modulation by closeness),
  axe on wood, wood splitting, body sounds (hurt, gasp, shiver, cough, heartbeat), UI ticks that are quiet
  and dry. Unknown names warn once and do nothing.
- setMusic delegates to createMusic(ctx: AudioContext, out: AudioNode): { setMood(mood: MusicMood, o?: {
  intensity?: number }): void; update(dt: number): void; } exported from src/audio/music/index.ts (being
  written in parallel: import it; if it is not there when you test, test with a local stub but leave the real
  import in the final code).
- Phones: start only from a gesture (unlock), survive suspend / resume and tab switches, fewer voices, cheaper
  panning and a shorter reverb on phones (detect coarse pointer / memory).
- dev/audio.html: a bench page with a button for every sound, sliders for the ambience fields, and a "scenes"
  row (calm dusk, whiteout on the ridge, by the fire in the cabin, stalked at night, on the ice).
- tools/audio-check.mjs: in headless Chrome render every sfx and loop and several ambience scenes offline
  (OfflineAudioContext with the same graph builders) and print for each: duration, peak, RMS, spectral
  centroid, silence / clipping / DC flags; fail on silence or clipping; write spectrogram images to shots/ so you
  can SEE each sound (Read them): a howl should show rising harmonics, a footstep a short broadband burst, wind
  slow-moving bands. Iterate on the sounds that look or measure wrong. Report the measured table briefly.


STATE ON DISK (handoff note: docs/status/AUDIO.md): src/audio/dsp.ts (26 KB), engine.ts (22 KB), sfx.ts (47 KB),
loops.ts (13 KB), ambience.ts (16 KB), index.ts (16 KB). An optional Ambience.cave was added to api.ts.
src/audio/music/ exists (index.ts exports createMusic). MISSING: dev/audio.html, dev/audio.ts,
tools/audio-check.mjs, and the measuring and iterating. Check that createAudio implements every member of
AudioApi and every SfxName and LoopName; nothing has been run yet.
