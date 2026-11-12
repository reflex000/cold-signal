# MUSIC — handoff note

Owner files: src/audio/music/** (index.ts, score.ts, instruments.ts, mixer.ts, score.test.ts), dev/music.html,
dev/music.ts, tools/music-check.mjs. Do not touch the rest of src/audio (AUDIO engineer).

## State (session 2, 2026-11-12): complete
- Everything type-checks; score tests pass; `node tools/music-check.mjs` exits 0 with a clean page console.
- src/audio/index.ts (AUDIO) already calls createMusic(ctx, engine.bus.music), setMood, update(dt), dispose().
- Spectrograms read and judged: shots/music_<mood>.png, music_<mood>_full.png, music_journey*.png.

## Remaining (optional polish only)
1. Listen in the full game against the real wind bed (all judging so far is numbers + spectrograms, headless, muted).
2. If the game sets intensities in a narrow band, retune per-mood `level` trims in score.ts.

## Decisions and API facts
- createMusic(ctx: BaseAudioContext, out, opts?) -> { setMood, update, dispose, state }. MusicOptions: seed, onNote,
  mute (players left out), raw (no ceiling: true peaks for analysis). The game passes no options.
- Conductor schedules LOOK = 0.45 s ahead on ctx.currentTime; notes later than LATE = 0.15 s are dropped (hidden tab).
  Mood changes: at phrase boundaries (moods without rests continue on the next downbeat), forced after the old
  mood's `wait`, `enter now` interrupts (attack, death), `leave now` cuts out (attack) then 2.5 s breath.
- Clash guard: a new mood's first phrase is held back (<= MAX_CLEAR 6 s) until no note of an outgoing section a
  semitone (mod 12) away from one of its notes is still sounding (old note counts until its end or its section's
  fade is 16 dB down, `quiet`). `sounding` holds { n: MusicNote, sec: Section }; Playing.start for state().
- Piano pedalling: score parser computes ScoreNote.damp (pedal(): damper falls when the line moves by step or
  repeats, or on any next note below C3); conductor passes NoteOn.hold = damp*beat + PEDAL (0.1 s).
- Conductor rnd = mulberry(seed); players draw from mulberry(seed ^ 0x2545f491); muted lines still draw conductor
  rnd, so solo renders keep the full mix's timing.
- Levels: per-mood `level` in the score: title -2, calm +1.5, cold -1, night +6, stalked -2, attack -10,
  whiteout -7, shelter +2, tower -6, holdout -10.5, rescue -8.5, death 0. Strips: brass 0.42, ice 0.4. MASTER 0.5,
  ceiling linear to -14 dBFS, soft to -10.5.
- Instrument changes this session: glass pair 0.66/0.34 (mono beating dips ~10 dB, not to zero); drum decay
  clamp(0.3*dur, 0.075, 0.13+0.1*vel), slap band-passed 190+380*vel Hz; piano knock 0.55*amp; cello onset scoop
  and slow pitch wander; brass lip-up; pont factor 0.7.
- Score changes: cello pedals in range (no A1/Bb1); attack clusters revoiced (seconds mid-range, fifth in the bass),
  attack piano ~6 dB lower, drum accents; holdout s4 piano as high bells, drum mf/p, brass mf; calm/night rests
  longer; stalked pont p; cold pull2 glass up an octave; tower/rescue ice p; whiteout brass ppp.

## Measurements (final run, 60 s offline, seed 417)
At intensity 0.5, peak dBFS / silence: title -15.5 / 16 %, calm -18.1 / 67 %, cold -15.7 / 51 %, night -23.0 / 67 %,
stalked -15.3 / 15 %, attack -15.2 / 32 %, whiteout -16.8 / 1 %, shelter -18.1 / 49 %, tower -16.9 / 21 %,
holdout -18.8 / 0 %, rescue -16.2 / 21 %, death -16.0 / 64 %. Full intensity: attack -14.3, holdout -13.7,
rescue -14.6, tower -14.9, whiteout -13.2, stalked -14.2. Energy above 2.5 kHz < 1 % everywhere (nothing harsh).

## Test commands
- npx tsc --noEmit -p . 2>&1 | grep -E "audio/music|dev/music"
- npx vitest run src/audio/music/score.test.ts
- node tools/music-check.mjs [--moods a,b] [--secs 60] [--intensity 0.5] [--wav 1]   (~10 min for everything)
- node tools/shot.mjs "dev/music.html?auto=1&mood=stalked&intensity=0.7" --out music_bench --wait 20000

## Final report

**Files.** src/audio/music/index.ts (conductor), score.ts (the written score in plain text notation, and its
parser), instruments.ts (cello, felt piano, bowed glass, frame drum, ice harmonics, muted brass: oscillators,
noise and filters only), mixer.ts (channel strips, generated 5.5 s cold reverb, soft ceiling), score.test.ts
(8 vitest checks: key family, player ranges, rests, pedalling, notation errors); dev/music.html + dev/music.ts
(bench page, offline renderer); tools/music-check.mjs.

**Public API** (src/audio/music/index.ts):
- `createMusic(ctx: BaseAudioContext, out: AudioNode, opts?: MusicOptions): Music` (AudioContext or OfflineAudioContext).
- `Music.setMood(mood: MusicMood, o?: { intensity?: number }): void` (cheap every frame), `update(dt: number): void`
  (every frame; schedules 0.45 s ahead on the audio clock), `dispose(): void`, `state(): MusicState`.
- `MusicOptions { seed?, onNote?, mute?, raw? }`, all optional and for tools; the game passes none.
  src/audio/index.ts already calls `createMusic(ctx, engine.bus.music)`, setMood, update, dispose.

**This session.** Conductor: a new mood's first phrase waits (up to 6 s) until no outgoing note a semitone away is
still sounding; the piano pedals from the line; separate random streams. Score: cello parts back in range,
attack clusters revoiced, holdout's top step given separate registers, longer rests in calm and night,
per-mood level trims. Instruments: glass beating no longer cancels in mono, drum damps at fast tempi, softer
piano knock, cello pitch scoop and wander, brass lip-up.

**Measured** (60 s offline): at intensity 0.5 peaks run from -15.2 to -23 dBFS (night); at full intensity
the loud moods peak at -13.2 to -14.9 dBFS; nothing clips (the ceiling bends above -14 and stops at -10.5).
Silence: calm 67 %, night 67 %; whiteout, stalked and holdout are continuous. music-check exits 0; console clean.

**Contract additions:** none.

**Unsure:** everything was judged from spectrograms and numbers (headless, muted), not by ear. The level against
the real wind bed should be checked in the full game mix.
