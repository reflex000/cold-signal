# AUDIO — handoff note

Owner files: src/audio/** except src/audio/api.ts (frozen) and src/audio/music/** (score, other engineer);
dev/audio.html, dev/audio.ts, tools/audio-check.mjs.

## State (session 2 start)
- On disk from session 1: src/audio/dsp.ts, engine.ts, sfx.ts, loops.ts, ambience.ts, index.ts. Never run.
- Missing: dev/audio.html, dev/audio.ts, tools/audio-check.mjs, measuring and iterating.
- Contract addition already made: optional `Ambience.cave?: number` in src/audio/api.ts.

## Findings (session 2)
- All six files read: complete and coherent. `npx tsc --noEmit -p .` shows no errors in src/audio.
- sfx.ts uses `satisfies Record<SfxName | `_${string}`, SoundDef>`: the compiler proves every SfxName exists.
  loops.ts is `Record<LoopName, LoopDef>`: same for loops. createAudio's return is typed AudioApi.
- index.ts mentions check.ts (offline renderer) which did not exist: written this session.

## Done this session
- src/audio/scenes.ts: SCENES (dusk, ridge, cabin, stalked, ice, cave) + SceneRunner (shared by bench and check).
- src/audio/check.ts: offline render through buildAudio on a 4-channel OfflineAudioContext (0-1 master,
  2-3 raw bus), metrics, spectrogram PNGs, contact sheets. checkList() = 102 checks.
- tools/audio-check.mjs (works: full run ~155 s). dev/audio.html + dev/audio.ts bench page (hosts AUDIO_CHECK).
- engine.ts: play() returns the built duration; master HPF 25 Hz; compressor -12 dB 4:1 knee 6;
  reverb returns room .45 cave .6 mountain .5 through a `wet` gain; setWet(k) for dry checks.
- dsp.ts: mountain IR diffuse wash tau 1.25 -> 0.5 s (was cathedral-long; echoes now carry the tail).

## First full measurement (before fixes)
- Raw bus peaks up to +14 dBFS (howl_far, thunder), +10 on fire loop pops: reverb returns and some
  sources far too hot, so the old master compressor (-15 dB, 6:1) was squashing ~15 dB.
- DC flags from subsonic thumps / shaped pulse wave (fixed by master HPF).
- Cabin scene 62 Hz centroid at -17 dBFS RMS: stove draw + flue hum too loud.

## Round 2 (done)
- src/audio/mix.ts: MIX table, dB per sound name ('step_<surface>' for steps, loop names for loops),
  applied by Engine.start (Voice.trim) and loop set({gain}). Trims came from the --dry run.
- Check pre-roll PRE = 0.4 s: DynamicsCompressorNode needs ~0.3 s to settle after a context starts
  (one-shots at 0.05 s measured 5 dB low: artefact, not a real loss). measureCompGain now 0.75 s.
- Fire loop pops/hiss -12/-10 dB inside; stove rebalanced (less draw/flue, a mid roar); match crackle 3 -> 0.9;
  rifle synthetic roll down, far send carries echoes; howl: drifting hold, purer (LP 2.5k), sends down.
- ambience.ts: BED_LEVEL gain for the whole bed (0.7); draft 1.6 -> 0.28 (was a -14 dBFS 65 Hz rumble);
  moan 5/3.2 -> 1.6/1.4; storm roar 1.5/1.1 -> 0.95/0.8.
- Live path verified: shot.mjs "dev/audio.html?auto=1": ready, 8 voices, clean console.

## Round 3 (done)
- Wind index I re-scaled (strong mean ~0.6, gusts carry it to 1): storms swell again instead of one flat
  roar; whistles sing in gusts only; storm roar lower with long waves; hiss (white >5 kHz) -9 dB, edge -6 dB.
- Heartbeat: soft 250 Hz knock added so phones/laptops (no bass) still carry the beat.
- Scenes now (RMS dBFS): dusk -33, ridge -19, cabin -27.5, stalked -25, ice -27, cave -28.

## State at end of session 2
- Complete. Full run: 102 checks, 0 failed, 3 HOT warnings (rifle, ridge scene, stress: pre-dynamics
  headroom, by design). Phone profile (--lite 1): 0 failed. Bench ?auto=1 desktop + --mobile 1: clean console.
- Possible next polish (not required): listen to WAVs (--wav 1) and tune by ear; howl variety across seeds
  (--seed N); dusk bed is a little quiet (-33 vs -30 target) if the game wants more wind in calm weather.

## API facts for other modules
- createAudio(options?: { lite?: boolean }): AudioApi (src/audio/index.ts). unlock() from a gesture;
  each frame setListener(...), setAmbience({...}) (cheap, partial ok), update(dt).
- The ambience does not play the cabin stove: the game starts loop('stove', { pos }) when it burns.
- sfx 'howl' picks its far character by distance itself; 'howl_far' is a distant pack chorus.
- buildAudio(ctx, CoreOptions) builds the same synth on any (offline) context; check.ts uses it.

Level targets (raw peak, dBFS): UI -24..-18; breath -36..-28; footsteps -22..-14; body hurt -18,
downed/death -14; tools -16..-8; rifle -2 (loudest); howl near -8; ice crack -6; loops RMS: fire -28,
stove -30, generator -22, heli(1) peak -8.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "src/audio|dev/audio"
- node tools/audio-check.mjs [--only sfx,loop,step,scene,stress] [--names a,b] [--dry 1] [--lite 1] [--wav 1]
  pictures: shots/audio*/<id>.png, sheets shots/audio_sheet_<n>*.png (Read them)
- node tools/shot.mjs "dev/audio.html?auto=1" --out audio_bench

## Final report

Files (AUDIO): src/audio/index.ts (createAudio, buildAudio, detectLite), engine.ts, dsp.ts, sfx.ts, loops.ts, ambience.ts; new this session: mix.ts (one dB level per sound), scenes.ts (six listening scenes + SceneRunner), check.ts (offline render, metrics, spectrograms; not imported by the game); dev/audio.html + dev/audio.ts (bench: every sfx, loop and surface, ambience sliders, placement, scenes row, moods, mix, meter; `?auto=1` drives the live path); tools/audio-check.mjs.

Public API: `createAudio(options?: { lite?: boolean }): AudioApi`, exactly src/audio/api.ts (every member, every SfxName and LoopName; the compiler checks completeness). Call `unlock()` from a gesture; each frame `setListener(...)`, `setAmbience(partial)`, `update(dt)`. Loop handles survive the voice cap and respawn. The ambience never plays the cabin stove: start `loop('stove', { pos })` while it burns. `'howl'` picks its far character by distance itself; `'howl_far'` is a distant pack. `buildAudio(ctx, CoreOptions)` builds the same synth on any context.

Contract: no additions this session (optional `Ambience.cave` from session 1 stands).

Fixed this session: reverb returns and a cathedral-length mountain tail (raw peaks were +14 dBFS, the compressor squashing 15 dB); master is now 25 Hz high-pass, compressor -12 dB 4:1, soft limiter; per-sound mix table; storm gusts were flat (wind index saturated); harsh hiss, cabin sub-rumble, fire and stove balance, howl contour and timbre, heartbeat inaudible on small speakers.

Measured (`node tools/audio-check.mjs`, 102 checks, 0 failed; master peaks, dBFS): UI -25..-16, footsteps -17..-15, body -25..-11, tools -24..-8, howl -7, rifle -5 (loudest), ice crack -7; loop RMS fire -28, stove -30, generator -24; scene RMS dusk -33, ridge -19, cabin -27.5, stalked -25, ice -27, cave -28; stress (38 voices over a storm) peak -4.7, no clipping. Only warnings: HOT pre-dynamics headroom on rifle, whiteout scene, stress (by design). Phone profile (`--lite 1`): 0 failed, scenes within 4 dB of desktop. Bench live path, desktop and phone viewport: clean console.

Unsure: judged by meters and spectrograms, not by ear (`--wav 1` writes WAVs to listen to); the master compressor settles about 0.3 s after unlock.
