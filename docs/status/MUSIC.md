# MUSIC — handoff note

Owner files: src/audio/music/** (score.ts, instruments.ts, mixer.ts, index.ts), dev/music.html, dev/music.ts,
tools/music-check.mjs. Do not touch the rest of src/audio (AUDIO engineer).

## State
- Session 2 started (2026-11-12). Files from session 1 exist on disk; no earlier handoff note was found.
- All files exist and type-check clean. src/audio/index.ts (AUDIO) already calls createMusic(ctx, engine.bus.music),
  setMood, update(dt), dispose().
- Conductor (index.ts): added clash avoidance. A new mood's first phrase is held back (<= MAX_CLEAR 6 s) until no
  note of the mood being left that is a semitone away from one of its notes is still sounding (old note counts until
  its end or its section's fade is 16 dB down = `quiet`). `sounding` now stores { n: MusicNote, sec: Section }.
  Playing has `start`; state() reports a rest while held back.
- First check run (before fixes): loud moods (attack, holdout, rescue) hit the ceiling at -10.5 dBFS (pre-ceiling
  ~-7); whiteout/tower ~-11; night only -33 peak; calm silence 54%, night 62%. Spectrograms showed: glass full-depth
  mono beating; drum a continuous 50-100 Hz wall at 120 bpm; cello written below C2 (A1/Bb1) in whiteout/holdout;
  piano bass notes ringing over each other (pedal always down); low semitone clusters in attack; holdout full = mud.
- Fixes made: glass pair 0.66/0.34; drum decay = clamp(0.3*dur, 0.075, 0.13+0.1*vel); cello pedals moved into
  range; score parser computes ScoreNote.damp (pedal(): damper falls when the line moves by step / repeats, or on
  any next note below C3) -> conductor passes NoteOn.hold = damp*beat + PEDAL(0.1 s) to the piano; attack clusters
  revoiced (seconds in the middle, bare fifth in the bass); holdout s4 piano moved up to bell strikes; calm and
  night rests +4 / +2 beats. MusicOptions.mute (players left out) added for level analysis.
- dev/music.ts render(): options { mute, image:false }, returns bands (energy share by band) and poly; drum strokes
  drawn as ticks in the analysis lanes and live roll.
- Scratch tool (not in project): per-player solo levels per mood, used to set trims. Findings: every player of
  attack/holdout/rescue exceeded -14 alone; stalked's pont sat 13 dB (peak) / 23 dB (rms) under the drum; bands:
  nothing harsh (>2.5 kHz < 0.5 %), energy mostly 60-250 Hz.
- Levels set: per-mood `level` in the score: title -2, calm +1.5, cold -1, night +6, stalked -2, attack -6,
  whiteout -4.5, shelter +2, tower -2.5, holdout -6, rescue -5, death 0. Stalked pont written p/mp (was pp/p) and
  the instrument's pont factor 0.62 -> 0.8; ice strip 0.3 -> 0.4. Targets: loud moods ~-14 dBFS peak at full
  intensity, middle moods -15/-16, quiet -18/-20, night ~-25. Kit draws from its own rnd stream (seed ^ 0x2545f491);
  muted lines still draw conductor rnd so solo renders keep the full mix's timing.
- music-check.mjs now prints low/body/bright energy shares and poly; fails on peak > -12.5, peak < -32 (lost
  under the wind), calm/night silence < 60 %.
- Bench page: chord names in one label per player; wider margin right of the now line.

## Remaining (priority order)
1. Type-check own files (npx tsc --noEmit -p . | grep audio/music|dev/music).
2. Run node tools/music-check.mjs, read numbers + spectrograms in shots/music_*.png.
3. Iterate on moods that are indistinct, harsh, muddy or busy; confirm peaks ~-14 dBFS, no clipping, silence fractions.
4. Bench page dev/music.html: buttons per mood, intensity slider, active-player visual; console clean.

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "audio/music|dev/music"
- node tools/music-check.mjs   (renders 60 s per mood offline in headless Chrome; writes shots/music_*.png)
