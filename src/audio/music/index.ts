// The score's conductor. `createMusic(ctx, out)` reads the written material in ./score.ts and
// plays it on the audio clock: one phrase at a time, the rests the score asks for in between,
// players entering by intensity, mood changes at phrase boundaries with a cross-fade.
//
//   const music = createMusic(ctx, musicBus);
//   music.setMood('stalked', { intensity: 0.7 });   // as often as you like; cheap when unchanged
//   music.update(dt);                               // every frame
//
// Timing: nothing here uses timers. `update` looks a short way ahead on `ctx.currentTime` and
// creates the notes that begin inside that window with exact start times, so the music does not
// drift or stutter with the frame rate. If `update` stops being called (a hidden tab) the music
// falls silent after the window and picks up at the right place when it is called again.
//
// It also runs on an OfflineAudioContext: suspend the context every 0.25 s or less, call
// `update` and resume (tools/music-check.mjs does this).
import type { MusicMood } from '../api';
import { INSTRUMENTS, makeKit } from './instruments';
import { makeMixer } from './mixer';
import type { MoodScore, Phrase, Player } from './score';
import { PLAYERS, SCORE, midiToHz } from './score';

export type { Player } from './score';

export interface MusicNote {
  player: Player;
  colour: string;
  midi: number;
  /** Audio-clock time of the onset. */
  t: number;
  /** Written length in seconds. */
  dur: number;
  /** Time at which the note has died away. */
  end: number;
  /** 0..1 dynamic after intensity scaling. */
  vel: number;
  mood: MusicMood;
}

export interface MusicState {
  /** The mood whose material is sounding (or was last). */
  mood: MusicMood;
  /** The mood asked for; differs from `mood` while waiting for a phrase to end. */
  target: MusicMood;
  intensity: number;
  /** Name of the phrase in progress, '' during a rest. */
  phrase: string;
  /** Seconds until the next phrase starts; 0 while one plays, Infinity when nothing is due. */
  nextIn: number;
  /** 0..1 per player: the loudest note of theirs sounding now. */
  players: Record<Player, number>;
  /** Notes started since creation. */
  notes: number;
}

export interface MusicOptions {
  /** Seed for the conductor's small choices (rest lengths, timing and dynamic nuance). */
  seed?: number;
  /** Called for every note as it is scheduled (bench page, tests). */
  onNote?: (n: MusicNote) => void;
}

export interface Music {
  /** Ask for a mood. Intensity 0..1 thins or fills the players and their dynamics; 0.5 if omitted. */
  setMood(mood: MusicMood, o?: { intensity?: number }): void;
  update(dt: number): void;
  dispose(): void;
  /** What is playing now, for meters and tests. */
  state(): MusicState;
}

/** Seconds of music created ahead of the audio clock. */
const LOOK = 0.45;
/** A note found this late (update was not called) is dropped rather than played out of time. */
const LATE = 0.15;

interface Ev {
  t: number;
  dur: number;
  midi: number;
  vel: number;
  player: Player;
  colour: string;
}

interface Playing {
  phrase: Phrase;
  events: Ev[];
  i: number;
  /** Audio-clock time the phrase's written length ends. */
  end: number;
}

/** One mood's stay: everything it plays goes through these faders, so it can be faded as a whole. */
interface Section {
  score: MoodScore;
  level: number;
  faders: Map<Player, GainNode>;
  /** Time its fade completes; 0 while alive. */
  gone: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createMusic(ctx: BaseAudioContext, out: AudioNode, opts: MusicOptions = {}): Music {
  const rnd = mulberry(opts.seed ?? 417);
  const kit = makeKit(ctx, rnd);
  const mixer = makeMixer(ctx, out);

  let target: MusicMood = 'none';
  let targetSince = 0;
  let mood: MusicMood = 'none';
  let intensity = 0.5;
  let section: Section | null = null;
  let playing: Playing | null = null;
  /** When the next phrase is due. Infinity: nothing more to play in this mood. */
  let nextAt = Infinity;
  /** End of the written length of the last phrase begun. */
  let lastEnd = -Infinity;
  let notes = 0;
  let disposed = false;
  const fading: Section[] = [];
  const sounding: MusicNote[] = [];
  /** Where each mood was in its order when it was left, so coming back soon does not start over. */
  const left = new Map<MusicMood, { pos: number; at: number }>();
  let pos = 0;

  function fader(sec: Section, p: Player): GainNode {
    let g = sec.faders.get(p);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = sec.level;
      g.connect(mixer.strip[p]);
      sec.faders.set(p, g);
    }
    return g;
  }

  function fade(sec: Section, at: number, seconds: number): void {
    for (const g of sec.faders.values()) {
      g.gain.setValueAtTime(sec.level, at);
      g.gain.linearRampToValueAtTime(0, at + seconds);
    }
    sec.gone = at + seconds + 0.1;
    fading.push(sec);
  }

  /** The next phrase of the current mood that the present intensity allows, or null. */
  function nextPhrase(score: MoodScore): Phrase | null {
    const n = score.order.length;
    for (let tries = 0; tries < n; tries++) {
      if (pos >= n) {
        if (score.loopFrom < 0) return null;
        pos = score.loopFrom;
      }
      const p = score.order[pos++];
      if (intensity >= p.whenMin && intensity < p.whenMax) return p;
    }
    return null;
  }

  function begin(at: number): void {
    const sec = section;
    if (!sec) {
      nextAt = Infinity;
      return;
    }
    const score = sec.score;
    const phrase = nextPhrase(score);
    if (!phrase) {
      playing = null;
      // Played once and finished, or no step of the score fits this intensity yet: look again later.
      nextAt = score.loopFrom < 0 && pos >= score.order.length ? Infinity : at + 1;
      return;
    }
    const beat = 60 / score.tempo;
    const louder = 0.78 + 0.3 * intensity;
    const events: Ev[] = [];
    for (const line of phrase.lines) {
      if (intensity < line.min || intensity >= line.max) continue;
      // A drum keeps strict time; everyone else breathes by a few milliseconds.
      const loose = line.player === 'drum' ? 0 : 0.012;
      for (const n of line.notes) {
        const roll = line.player === 'piano' ? n.chord * 0.022 : 0;
        events.push({
          t: at + n.beat * beat + roll + (n.beat > 0 ? (rnd() - 0.5) * 2 * loose : 0),
          dur: n.dur * beat,
          midi: n.midi,
          vel: clamp01(n.vel * louder * (1 + (rnd() - 0.5) * 0.1)),
          player: line.player,
          colour: line.colour,
        });
      }
    }
    events.sort((a, b) => a.t - b.t);
    const end = at + phrase.len * beat;
    // Rests shorten as intensity rises, but a rest is never dropped.
    const rest = (phrase.restMin + (phrase.restMax - phrase.restMin) * rnd()) * (1.25 - 0.5 * intensity);
    playing = { phrase, events, i: 0, end };
    lastEnd = end;
    nextAt = end + rest * beat;
  }

  function schedule(now: number): void {
    const p = playing;
    const sec = section;
    if (!p || !sec) return;
    const horizon = now + LOOK;
    while (p.i < p.events.length && p.events[p.i].t < horizon) {
      const e = p.events[p.i++];
      if (e.t < now - LATE) continue;
      const t = Math.max(e.t, now + 0.005);
      const end = INSTRUMENTS[e.player](kit, { t, dur: e.dur, freq: midiToHz(e.midi), midi: e.midi, vel: e.vel, colour: e.colour }, fader(sec, e.player));
      const note: MusicNote = { player: e.player, colour: e.colour, midi: e.midi, t, dur: e.dur, end, vel: e.vel, mood: sec.score.mood };
      sounding.push(note);
      notes++;
      if (opts.onNote) opts.onNote(note);
    }
  }

  /**
   * Leave the current mood and take up `target`.
   *   boundary   the old phrase is over (or is ending this instant): the musical place to change
   *   forced     the old phrase would not end in time: stop feeding it and cross-fade
   *   interrupt  the new mood does not wait (attack, death)
   *   cutout     the old mood stops dead when it is left (attack), then a breath
   */
  function change(now: number, how: 'boundary' | 'forced' | 'interrupt' | 'cutout'): void {
    const old = section;
    const next = target === 'none' ? undefined : SCORE.get(target);
    let start: number;
    if (how === 'interrupt') {
      start = now + 0.06;
      if (old) fade(old, now, next ? next.cut : 0.5);
    } else if (how === 'cutout') {
      start = now + 2.5;
      if (old) fade(old, now, old.score.fade);
    } else if (how === 'forced' && old) {
      start = now + old.score.fade * 0.6;
      fade(old, now, old.score.fade);
    } else {
      const gap = nextAt - lastEnd;
      if (old && gap < 0.01) {
        // The old mood runs without rests: carry on in time, on its next downbeat.
        start = Math.max(now + 0.02, lastEnd);
      } else {
        // Keep some of the rest that was coming; never crowd the phrase that just ended.
        const breath = Math.min(Math.max(gap * 0.5, 2), 6);
        start = Math.max(now + 0.25, Math.min(nextAt, lastEnd + breath));
      }
      if (old) fade(old, now, old.score.fade);
    }
    if (old) left.set(mood, { pos, at: now });
    playing = null;
    mood = target;
    if (!next) {
      section = null;
      nextAt = Infinity;
      return;
    }
    section = { score: next, level: Math.pow(10, next.level / 20), faders: new Map(), gone: 0 };
    const was = left.get(mood);
    // Coming back soon to a mood that simply cycles: go on from where it was. Moods with an
    // opening (`a | b c`) and moods played once always start from the top.
    pos = was && next.loopFrom === 0 && now - was.at < 120 ? was.pos : 0;
    nextAt = start;
  }

  function update(_dt: number): void {
    if (disposed) return;
    const now = ctx.currentTime;

    for (let i = fading.length - 1; i >= 0; i--) {
      if (now > fading[i].gone) {
        for (const g of fading[i].faders.values()) g.disconnect();
        fading.splice(i, 1);
      }
    }
    for (let i = sounding.length - 1; i >= 0; i--) if (sounding[i].end < now) sounding.splice(i, 1);

    schedule(now);

    if (target !== mood) {
      const next = target === 'none' ? undefined : SCORE.get(target);
      const midPhrase = playing !== null && now + LOOK < playing.end;
      if (!section) change(now, 'boundary');
      else if (next && next.enterNow) change(now, 'interrupt');
      else if (section.score.leaveNow) change(now, 'cutout');
      else if (!midPhrase) change(now, 'boundary');
      else if (now - targetSince > section.score.wait) change(now, 'forced');
    }

    if (section && (!playing || playing.i >= playing.events.length) && now + LOOK >= nextAt) {
      begin(Math.max(nextAt, now + 0.02));
      schedule(now);
    }
  }

  function setMood(m: MusicMood, o?: { intensity?: number }): void {
    if (disposed) return;
    const want: MusicMood = m === 'none' || SCORE.has(m) ? m : 'none';
    intensity = clamp01(o && o.intensity !== undefined ? o.intensity : 0.5);
    if (want !== target) {
      target = want;
      targetSince = ctx.currentTime;
    }
  }

  function state(): MusicState {
    const now = ctx.currentTime;
    const players = {} as Record<Player, number>;
    for (const p of PLAYERS) players[p] = 0;
    for (const n of sounding) {
      if (n.t > now || n.end < now) continue;
      // Full while the note is held, falling over its die-away.
      const tail = n.end - (n.t + n.dur);
      const level = now <= n.t + n.dur || tail <= 0 ? 1 : 1 - (now - n.t - n.dur) / tail;
      players[n.player] = Math.max(players[n.player], n.vel * level);
    }
    const inPhrase = playing !== null && now < playing.end;
    return {
      mood,
      target,
      intensity,
      phrase: inPhrase && playing ? playing.phrase.name : '',
      nextIn: inPhrase ? 0 : Math.max(0, nextAt - now),
      players,
      notes,
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Voices already scheduled stop by themselves within seconds; cut their way out now.
    if (section) for (const g of section.faders.values()) g.disconnect();
    for (const s of fading) for (const g of s.faders.values()) g.disconnect();
    fading.length = 0;
    sounding.length = 0;
    section = null;
    playing = null;
    mixer.dispose();
  }

  return { setMood, update, dispose, state };
}
