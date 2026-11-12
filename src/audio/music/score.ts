// The score. Every note the game plays is written here as text and parsed once at load.
//
// NOTATION
//   mood <name>            starts a mood. Then, one per line:
//     tempo <bpm>          one beat = 60 / bpm seconds; every duration below is in beats
//     fade <s>             how long this mood takes to fade when another one replaces it
//     wait <s>             how long a new mood waits for this one's phrase to end before fading it
//     level <dB>           trim for the whole mood
//     enter now [s]        this mood interrupts whatever is playing (old material is cut in s seconds)
//     leave now            when this mood is replaced it stops at once (no waiting for the phrase)
//     order a b | c d      the phrases in playing order; what follows `|` repeats; `end` = play once
//   phrase <name> [len <beats>] [rest <a>..<b>] [when <a>..<b>]
//     len    phrase length (default: its longest line). rest: silence after it, in beats, picked in
//     the range and shortened as intensity rises. when: only played while intensity is in the range.
//   <player>[.colour] [@min[..max]] tokens...
//     one line of music. Players: cello piano glass drum ice brass. Colour `pont` = sul ponticello.
//     @0.5 = this player only enters when intensity >= 0.5.
//     tokens:  D3:4        a note and its length in beats (length may be omitted: same as before)
//              D3+A3:8     notes sounding together
//              -:2         a rest
//              pp p mp mf f ff (and ppp)   the dynamic from here on
//              [ ... ]*4   repeat
//              |           a bar line, for the reader only
//   # starts a comment.
//
// THE MATERIAL
//   One key family, D. D minor (D E F G A Bb C) is the mountain; the major inflection (F#, B, and
//   C# once) is warmth and rescue; Eb is the cold pulling the tonic down.
//   The motif, "the signal":   D . . A . . | Bb A . . F . | E . . . . .
//   a rising fifth, the semitone above it leaning back, a fall to the third, and it stops on the
//   second degree, unanswered. Every mood is cut from it. Only `rescue` lets it reach D.
import type { MusicMood } from '../api';

export type Player = 'cello' | 'piano' | 'glass' | 'drum' | 'ice' | 'brass';
export const PLAYERS: readonly Player[] = ['cello', 'piano', 'glass', 'drum', 'ice', 'brass'];

const TEXT = `
# ---------------------------------------------------------------------------------------------
# title: the full motif, slow, exposed. A cello alone, a piano that answers and is left hanging
# on the fifth, the first two notes again as harmonics, then both together.
mood title
tempo 44
fade 5
level -2
order call answer echo full

phrase call rest 5..7
  cello  mp D3:3 A3:3 | Bb3:1 A3:3 F3:2 | E3:6

phrase answer rest 7..10
  piano  p  D4:3 A4:3 | C5:1.5 Bb4:1.5 A4:2 G4:1 | A4:6
  glass  pp -:6 D3+A3:12

phrase echo rest 8..12
  ice    pp D6:3 A6:5
  cello  pp -:5 D2:9

phrase full rest 12..16
  cello  mp D3:3 A3:3 | Bb3:1 A3:3 F3:2 | E3:6
  piano  pp D2:6      | Bb2:6           | A2:6
  glass  pp -:12 A3+E4:8

# ---------------------------------------------------------------------------------------------
# calm: the rising fifth opened out into wide intervals. Long rests: mostly silence.
mood calm
tempo 40
fade 5
level 1.5
order a b c d e

phrase a rest 22..30
  piano  p  D3:2 A3:2 E4:6

phrase b rest 24..32
  glass  pp D3+A3:10
  piano  pp -:4 A4:2 D5:6

phrase c rest 24..32
  piano  p  A2:2 E4:3 D5:7
  ice    @0.6 pp -:6 A6:6

phrase d rest 22..30
  cello  pp D2:10
  piano  p  -:3 F4:2 E4:2 A4:5

phrase e rest 26..34
  piano  pp D5:3 A3:7

# ---------------------------------------------------------------------------------------------
# cold: the motif breaks into pieces. What is left is the semitone pulling down: Bb to A,
# F to E, and at last Eb to D.
mood cold
tempo 42
fade 5
level -1
order frag1 pull1 frag2 pull2 pull3

phrase frag1 rest 8..11
  cello  mp D3:3 A3:5

phrase pull1 rest 9..13
  cello  p  Bb3:2 A3:6
  piano  pp -:4 Bb4:1 A4:5

phrase frag2 rest 10..14
  piano  p  D4:2 A4:2 -:2 Bb4:1 A4:5
  glass  @0.4 pp -:4 D3:10

phrase pull2 rest 9..13
  cello  p  F3:2 E3:6
  glass  pp -:2 A3+E4:8

phrase pull3 rest 12..17
  cello  mp Eb3:3 D3:7
  piano  pp -:5 Eb5:1 D5:5

# ---------------------------------------------------------------------------------------------
# night: clear sky. High harmonics, almost nothing; the fifth and the semitone, far up.
mood night
tempo 36
fade 6
level 6
order a b c d e

phrase a rest 22..30
  ice    pp A6:4 D7:6

phrase b rest 24..32
  ice    pp D6:8

phrase c rest 26..34
  ice    pp E7:2 D7:2 A6:6
  glass  @0.5 ppp -:4 D4:8

phrase d rest 24..32
  ice    pp A6:3 -:3 Bb6:1 A6:5

phrase e rest 28..36
  ice    pp D7:8
  piano  @0.7 pp -:3 D5:5

# ---------------------------------------------------------------------------------------------
# stalked: a low pulse enters, like a heart heard through a hood. The strings hold thin
# sul ponticello tones around the motif's semitone. No melody.
mood stalked
tempo 60
fade 3
wait 5
level -2
order in p1 | p2 p1 p3 p1 p4 p1

phrase in len 8
  drum   -:2 ppp D2:.32 D2:.68 | pp D2:.32 ppp D2:.68 | [ p D2:.32 pp D2:.68 ]*4

phrase p1 len 8
  drum   [ mp D2:.32 p D2:.68 ]*8

phrase p2 len 8
  drum   [ mp D2:.32 p D2:.68 ]*8
  cello.pont p  -:1 A3:6

phrase p3 len 8
  drum   [ mp D2:.32 p D2:.68 ]*8
  cello.pont p  -:1 A3+Bb3:6
  cello  @0.6 pp D2:8

phrase p4 len 8
  drum   [ mp D2:.32 p D2:.68 ]*8
  cello.pont p  E4+F4:6
  cello.pont @0.5 pp -:2 A4:5

# ---------------------------------------------------------------------------------------------
# attack: the pulse doubles. Clusters of the two semitones (D Eb, A Bb), short and loud.
# Then it cuts out; if the fight goes on, only the pulse comes back. The grinding seconds are
# kept in the middle of the range; underneath them the bass is a bare fifth, so the low end hits
# instead of turning to mud.
mood attack
tempo 120
enter now 0.3
leave now
fade 0.35
level -10
order hit drive hit2 drive cut | drive cut

phrase hit len 16
  drum   [ f D2:1 mp D2:1 mf D2:1 mp D2:1 ]*4
  cello.pont ff D3+Eb3+A3+Bb3:3 -:5 f D4+Eb4:3
  piano  mp D2+A2+D4+Eb4:1 -:7 p D2+A3+Bb3:1
  brass  f  D3+A3+Bb3:4

phrase drive len 16
  drum   [ f D2:1 mp D2:1 ]*8
  cello.pont mf -:4 A3+Bb3:4 -:4 E4+F4:4

phrase hit2 len 16
  drum   [ ff D2:1 mp D2:.5 mp D2:.5 mf D2:1 mp D2:1 ]*4
  brass  f  D3+A3+Eb4:3 -:5 f A2+E3+Bb3:4
  piano  mf D2+Bb2+Eb4:1 -:7 mp D2+A2+Bb3:1
  cello.pont f -:8 D4+Eb4+A4:4

phrase cut len 24

# ---------------------------------------------------------------------------------------------
# whiteout: a wall. Three voices in close position move one at a time by step, very slowly;
# something always holds while something else gives way. It never rests. The cello holds a
# pedal on its lowest string: D, then the motif's semitone (Bb falling to A) an octave up.
mood whiteout
tempo 40
fade 7
wait 6
level -7
order w1 w2 w3 w2

phrase w1 len 24
  glass  p  A3:8 Bb3:8 A3:8
  glass  p  -:3 F3:8 E3:8 F3:5
  glass  p  -:5 D3:11 C3:8
  glass  @0.5 pp -:8 A4:8 G4:8
  cello  pp D2:12 A2:12
  brass  @0.7 ppp -:8 D3+A3:10

phrase w2 len 24
  glass  p  G3:8 A3:8 Bb3:8
  glass  p  E3:5 F3:8 G3:8 F3:3
  glass  p  D3:13 D3:8 E3:3
  glass  @0.5 pp -:4 G4:8 A4:8
  cello  pp Bb2:12 A2:12
  brass  @0.7 ppp -:10 Bb2+F3:10

phrase w3 len 24
  glass  p  A3:8 G3:8 A3:8
  glass  p  F3:3 E3:8 F3:8 E3:5
  glass  p  D3:5 D3:8 C3:8 D3:3
  glass  @0.5 pp -:6 D4:10 E4:8
  cello  pp D2:12 F2:12
  brass  @0.7 ppp -:6 D3+A3:10

# ---------------------------------------------------------------------------------------------
# shelter: warmth. The motif with its major inflection (B for Bb, F# for F), piano alone.
mood shelter
tempo 50
fade 5
level 2
order a b c d

phrase a rest 10..14
  piano  p  D4:3 A4:3 | B4:1 A4:3 F#4:2 | E4:6
  piano  pp D3:6      | G2:6            | A2:6

phrase b rest 12..16
  piano  pp F#4:2 A4:2 D5:6
  piano  pp D3:10

phrase c rest 10..14
  piano  p  D4:3 A4:3 | B4:1 A4:2 F#4:1 E4:2 | F#4:6
  piano  pp D3:6      | G2:4 A2:2            | D3+A3:6

phrase d rest 14..18
  piano  pp A3:2 D4:2 F#4:2 E4:6
  piano  pp -:6 A2:6

# ---------------------------------------------------------------------------------------------
# tower: the motif rising. Its head climbs D, F, A, then the octave, and the last time it goes
# up instead of falling. Muted brass swells underneath.
mood tower
tempo 48
fade 5
level -6
order t1 t2 t3 t4

phrase t1 rest 5..8
  cello  mp D3:3 A3:3 | Bb3:1 A3:5
  brass  @0.3 pp D3+A3:11

phrase t2 rest 5..8
  cello  mp F3:3 C4:3 | D4:1 C4:5
  brass  p  F2+C3:11
  piano  @0.5 pp -:7 D5:1 C5:4

phrase t3 rest 6..9
  cello  mf A3:3 E4:3 | F4:1 E4:5
  piano  p  A4:3 E5:3 | F5:1 E5:5
  brass  mp A2+E3:11

phrase t4 rest 12..18
  cello  mf D4:3 A4:3 | Bb4:1 A4:3 | D5:8
  piano  mp D4:3 A4:3 | Bb4:1 A4:3 | D5:8
  brass  mp D3+A3:10 D3+A3+D4:8
  glass  pp -:10 D4+A4:8
  ice    @0.6 p  -:12 D7:6

# ---------------------------------------------------------------------------------------------
# holdout: the pulse and the brass, built in four steps by intensity. Each step adds a player
# and a level; the motif arrives at the third and is pushed up at the fourth.
mood holdout
tempo 60
fade 3
wait 5
level -10.5
order s1a s1b s2a s2b s3a s3b s4a s4b

phrase s1a len 16 when 0..0.25
  drum   [ p D2:.32 pp D2:1.68 ]*8
  cello  pp D2:14

phrase s1b len 16 when 0..0.25
  drum   [ p D2:.32 pp D2:1.68 ]*8
  cello  pp A2:14

phrase s2a len 16 when 0.25..0.5
  drum   [ mp D2:.32 p D2:1.68 ]*8
  brass  p  D3+A3:10
  cello  p  D2:14

phrase s2b len 16 when 0.25..0.5
  drum   [ mp D2:.32 p D2:1.68 ]*8
  brass  p  -:2 F3+C4:10
  cello  p  Bb2:8 A2:7

phrase s3a len 16 when 0.5..0.75
  drum   [ mf D2:.32 mp D2:.68 ]*16
  brass  mp D3+A3:8 F3+C4:8
  cello  mp D3:3 A3:3 | Bb3:1 A3:5

phrase s3b len 16 when 0.5..0.75
  drum   [ mf D2:.32 mp D2:.68 ]*16
  brass  mp G3+D4:8 A3+E4:8
  cello  mp F3:3 C4:3 | D4:1 C4:5

# At the top step every player has a register of its own: the drum below, the brass and the
# cello in the middle, the glass above them, and the piano striking bells over everything.
phrase s4a len 16 when 0.75..1.01
  drum   [ mf D2:.5 p D2:.5 ]*16
  brass  mf D3+A3+D4:8 F3+C4+F4:8
  cello  mf D3:3 A3:3 | Bb3:1 A3:3 F3:2 | E3:4
  piano  mf D5+A5:8 F5+C6:8
  glass  p  A4:16

phrase s4b len 16 when 0.75..1.01
  drum   [ mf D2:.5 p D2:.5 ]*16
  brass  mf G3+D4+G4:8 A3+E4+A4:8
  cello  mf A3:3 E4:3 | F4:1 E4:3 D4:2 | E4:4
  piano  mf G5+D6:8 A5+E6:8
  glass  p  D5:16

# ---------------------------------------------------------------------------------------------
# rescue: the motif resolved, everyone playing. E falls to D at last, in the major.
mood rescue
tempo 52
fade 6
level -8.5
order r1 r2 | r3 r2

phrase r1 rest 4..6
  cello  mf D3:3 A3:3 | B3:1 A3:3 F#3:2 | E3:4 | D3:8
  piano  mp D4:3 A4:3 | B4:1 A4:3 F#4:2 | E4:4 | D4+F#4+A4:8
  piano  p  D2:6      | G2:6            | A2:4 | D2+A2:8
  brass  mp -:6       | G2+D3+B3:6      | A2+E3+C#4:4 | D3+A3+F#4:8
  glass  p  D4+A4:16 F#4+A4+D5:8
  ice    @0.4 p -:16 A6:4 D7:4

phrase r2 rest 10..14
  piano  p  F#4:2 A4:2 D5:8
  glass  pp D3+A3+F#4:12
  ice    p  -:4 A6:4 D7:6

phrase r3 rest 12..18
  piano  p  D5:3 A5:3 | B5:1 A5:3 F#5:2 | E5:4 | D5:8
  cello  pp -:16 D2:10

# ---------------------------------------------------------------------------------------------
# death: three falling notes, then nothing.
mood death
tempo 40
enter now 1.2
fade 4
order fall end

phrase fall
  piano  mp A3:3 F3:3 D2+D3:10
`;

// ---------------------------------------------------------------------------------------------

export interface ScoreNote {
  /** Start, in beats from the start of the phrase. */
  beat: number;
  /** Length in beats. */
  dur: number;
  midi: number;
  /** 0..1 written dynamic. */
  vel: number;
  /** Index inside a chord (0 for the lowest); a piano rolls its chords slightly. */
  chord: number;
  /**
   * Beats after its onset at which a piano's damper falls on it (Infinity: it rings on with the
   * pedal). See `pedal` below.
   */
  damp: number;
}

export interface ScoreLine {
  player: Player;
  colour: string;
  /** The line plays only while min <= intensity < max. */
  min: number;
  max: number;
  notes: ScoreNote[];
}

export interface Phrase {
  name: string;
  /** Beats. */
  len: number;
  restMin: number;
  restMax: number;
  whenMin: number;
  whenMax: number;
  lines: ScoreLine[];
}

export interface MoodScore {
  mood: MusicMood;
  tempo: number;
  fade: number;
  wait: number;
  /** dB. */
  level: number;
  enterNow: boolean;
  /** Seconds the interrupted material takes to go when this mood enters `now`. */
  cut: number;
  leaveNow: boolean;
  order: Phrase[];
  /** Index in `order` to return to after the last phrase; -1 = play once. */
  loopFrom: number;
  phrases: Map<string, Phrase>;
}

export const DYNAMICS: Readonly<Record<string, number>> = { ppp: 0.1, pp: 0.2, p: 0.32, mp: 0.46, mf: 0.6, f: 0.8, ff: 1 };

const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function midiOf(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return NaN;
  return 12 * (Number(m[3]) + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const midiName = (midi: number): string => NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

function range(s: string | undefined, where: string): [number, number] {
  if (s === undefined) throw new Error(`score: missing range ${where}`);
  const parts = s.split('..');
  const a = Number(parts[0]);
  const b = parts.length > 1 ? Number(parts[1]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) throw new Error(`score: bad range "${s}" ${where}`);
  return [a, b];
}

/** Expands `[ ... ]*n` groups. */
function expand(tokens: string[], where: string): string[] {
  const out: string[] = [];
  const stack: string[][] = [];
  let cur = out;
  for (const tk of tokens) {
    if (tk === '[') {
      stack.push(cur);
      cur = [];
    } else if (tk.startsWith(']')) {
      const m = /^\]\*(\d+)$/.exec(tk);
      const parent = stack.pop();
      if (!m || !parent) throw new Error(`score: bad repeat "${tk}" ${where}`);
      for (let i = 0; i < Number(m[1]); i++) parent.push(...cur);
      cur = parent;
    } else cur.push(tk);
  }
  if (stack.length) throw new Error(`score: unclosed [ ${where}`);
  return out;
}

function parseLine(words: string[], where: string): { line: ScoreLine; len: number } {
  const [who, colour = ''] = words[0].split('.');
  if (!PLAYERS.includes(who as Player)) throw new Error(`score: unknown player "${who}" ${where}`);
  let i = 1;
  let min = 0;
  let max = Infinity;
  if (words[i] && words[i].startsWith('@')) {
    const parts = words[i].slice(1).split('..');
    min = Number(parts[0]);
    if (parts.length > 1) max = Number(parts[1]);
    if (!Number.isFinite(min) || Number.isNaN(max)) throw new Error(`score: bad threshold "${words[i]}" ${where}`);
    i++;
  }
  const notes: ScoreNote[] = [];
  let beat = 0;
  let dur = 1;
  let vel = DYNAMICS.mp;
  for (const tk of expand(words.slice(i), where)) {
    if (tk === '|') continue;
    if (tk in DYNAMICS) {
      vel = DYNAMICS[tk];
      continue;
    }
    const [head, d] = tk.split(':');
    if (d !== undefined) {
      dur = Number(d);
      if (!(dur > 0)) throw new Error(`score: bad length in "${tk}" ${where}`);
    }
    if (head !== '-') {
      const pitches = head.split('+').map((n) => {
        const midi = midiOf(n);
        if (Number.isNaN(midi)) throw new Error(`score: bad note "${n}" in "${tk}" ${where}`);
        return midi;
      });
      pitches.sort((a, b) => a - b);
      pitches.forEach((midi, chord) => notes.push({ beat, dur, midi, vel, chord, damp: Infinity }));
    }
    beat += dur;
  }
  pedal(notes);
  return { line: { player: who as Player, colour, min, max, notes }, len: beat };
}

/** Below this (C3) overlapping notes turn to mud: the pedal is changed at every new note. */
const BASS = 48;

/**
 * How a pianist pedals a line: notes ring on into each other (the felt piano's wash) until the
 * line moves by step from one, or repeats it, or anything at all follows a note in the bass;
 * then the damper falls on it as the next note is struck. Leaps and chords may overlap; a step
 * or a bass line held under the pedal would smear into a cluster.
 */
function pedal(notes: ScoreNote[]): void {
  for (let i = 0; i < notes.length; ) {
    let j = i;
    while (j < notes.length && notes[j].beat === notes[i].beat) j++;
    if (j === notes.length) break;
    let k = j;
    while (k < notes.length && notes[k].beat === notes[j].beat) k++;
    for (let a = i; a < j; a++) {
      for (let b = j; b < k; b++) {
        if (notes[a].midi < BASS || Math.abs(notes[a].midi - notes[b].midi) <= 2) {
          notes[a].damp = notes[j].beat - notes[a].beat;
          break;
        }
      }
    }
    i = j;
  }
}

export function parseScore(text: string): Map<MusicMood, MoodScore> {
  const moods = new Map<MusicMood, MoodScore>();
  const orders = new Map<MoodScore, string[]>();
  let mood: MoodScore | null = null;
  let phrase: Phrase | null = null;
  let explicitLen = false;
  const lines = text.split('\n');
  for (let n = 0; n < lines.length; n++) {
    // A comment starts at a `#` that begins a word; the `#` inside a note name (F#4) does not.
    const raw = lines[n].replace(/(^|\s)#.*$/, '');
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const where = `(score line ${n + 1}: "${lines[n].trim()}")`;
    const key = words[0];
    if (key === 'mood') {
      mood = {
        mood: words[1] as MusicMood,
        tempo: 48,
        fade: 4,
        wait: 8,
        level: 0,
        enterNow: false,
        cut: 0.5,
        leaveNow: false,
        order: [],
        loopFrom: 0,
        phrases: new Map(),
      };
      moods.set(mood.mood, mood);
      phrase = null;
      continue;
    }
    if (!mood) throw new Error(`score: text before the first mood ${where}`);
    if (key === 'tempo' || key === 'fade' || key === 'wait' || key === 'level') {
      const v = Number(words[1]);
      if (!Number.isFinite(v)) throw new Error(`score: bad number ${where}`);
      mood[key] = v;
    } else if (key === 'enter') {
      mood.enterNow = words[1] === 'now';
      if (words[2] !== undefined) mood.cut = Number(words[2]);
    } else if (key === 'leave') {
      mood.leaveNow = words[1] === 'now';
    } else if (key === 'order') {
      orders.set(mood, words.slice(1));
    } else if (key === 'phrase') {
      phrase = { name: words[1], len: 0, restMin: 0, restMax: 0, whenMin: 0, whenMax: Infinity, lines: [] };
      explicitLen = false;
      for (let i = 2; i < words.length; i += 2) {
        if (words[i] === 'len') {
          phrase.len = Number(words[i + 1]);
          explicitLen = true;
        } else if (words[i] === 'rest') [phrase.restMin, phrase.restMax] = range(words[i + 1], where);
        else if (words[i] === 'when') [phrase.whenMin, phrase.whenMax] = range(words[i + 1], where);
        else throw new Error(`score: unknown phrase option "${words[i]}" ${where}`);
      }
      if (mood.phrases.has(phrase.name)) throw new Error(`score: phrase defined twice ${where}`);
      mood.phrases.set(phrase.name, phrase);
    } else {
      if (!phrase) throw new Error(`score: a line of music outside a phrase ${where}`);
      const { line, len } = parseLine(words, where);
      phrase.lines.push(line);
      if (explicitLen) {
        if (len > phrase.len + 1e-6) throw new Error(`score: line is ${len} beats, phrase is ${phrase.len} ${where}`);
      } else phrase.len = Math.max(phrase.len, len);
    }
  }
  for (const [m, names] of orders) {
    for (const name of names) {
      if (name === '|') m.loopFrom = m.order.length;
      else if (name === 'end') m.loopFrom = -1;
      else {
        const p = m.phrases.get(name);
        if (!p) throw new Error(`score: mood ${m.mood} orders unknown phrase "${name}"`);
        m.order.push(p);
      }
    }
  }
  for (const m of moods.values()) if (!m.order.length) throw new Error(`score: mood ${m.mood} has no order`);
  return moods;
}

/** The notation as written, for tools and the bench page. */
export const SCORE_TEXT = TEXT;

export const SCORE: ReadonlyMap<MusicMood, MoodScore> = parseScore(TEXT);
