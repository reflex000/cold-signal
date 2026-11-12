# Brief: MUSIC
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: MUSIC (the score). Files you own: src/audio/music/**, dev/music.html, dev/music.ts,
tools/music-check.mjs. (The rest of src/audio is being written by another engineer right now; do not touch it.)

Build src/audio/music/index.ts exporting createMusic(ctx: AudioContext, out: AudioNode): { setMood(mood:
MusicMood, o?: { intensity?: number }): void; update(dt: number): void; dispose(): void } (MusicMood from
src/audio/api.ts: none, title, calm, cold, night, stalked, attack, whiteout, shelter, tower, holdout, rescue,
death). It must also construct against an OfflineAudioContext so it can be rendered and analysed in tests.

A sparse, written ambient score for a mountain in a storm, fully synthesised. Not a drone and not a loop of
random notes: composed material with a recognisable motif that returns in different registers and
instruments, lots of silence, and players that enter and leave with what is happening.
- Instruments built from oscillators, noise and filters in code: a bowed string / cello-like voice (slow
  attack, vibrato that opens late, body resonances), a felt piano (inharmonic partials, soft hammer noise, long
  release), a bowed-glass or singing-bowl pad, a low frame drum / heartbeat for tension, high harmonics
  ("ice") for clear nights, a muted brass swell for the tower and rescue. A shared reverb send with a long,
  cold tail (impulse response generated in code) inside this module.
- Material per mood, written as data (notes, durations, dynamics, which players may enter) in a plain,
  readable text notation in src/audio/music/score.ts, in one key family so moods cross-fade musically:
  title (the full motif, slow, exposed); calm (wide intervals, long rests); cold (the motif fragmenting, a
  semitone pulling down); night (high harmonics, almost nothing); stalked (a low pulse enters, the strings play
  sul ponticello colour, no melody); attack (the pulse doubles, clusters, short and loud, then cuts out);
  whiteout (a wall of very slow moving close harmony under the wind); shelter (warmth: the motif in a major
  inflection, piano alone); tower (the motif rising); holdout (the pulse, the brass, building in steps tied to
  intensity); rescue (the motif resolved, full); death (three falling notes, then nothing).
- A conductor that schedules ahead on the audio clock (no timers drifting), changes mood at phrase boundaries
  with cross-fades, scales the number of active players and their dynamics by intensity, never plays two
  phrases that clash, and leaves long gaps: in 'calm' and 'night' most of the time is silence.
- Level: the score sits under the wind; peaks around -14 dBFS before the game's master bus. No clipping.
- dev/music.html: buttons for each mood, an intensity slider, a visual of which players are active.
  tools/music-check.mjs: render 60 s of each mood offline in headless Chrome, print peak / RMS / fraction of
  silence / note count, write spectrogram images to shots/ and Read them: you should SEE distinct notes with
  harmonics and decay, the pulse in 'stalked', dense sustained bands in 'whiteout', and silence between phrases.
  Iterate until every mood is distinct and none is harsh, muddy or busy.


STATE ON DISK (handoff note: docs/status/MUSIC.md): src/audio/music/score.ts, instruments.ts, mixer.ts, index.ts,
dev/music.html, dev/music.ts, tools/music-check.mjs, and spectrograms in shots/music_*.png from an earlier run.
REMAINING: run the check, read the measurements and the spectrograms critically, iterate on moods that are
indistinct, harsh, muddy or busy, confirm the levels and the silence fractions, and finish.
