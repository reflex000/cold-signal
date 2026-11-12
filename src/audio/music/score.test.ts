// The written score, checked as data (no audio here: tools/music-check.mjs renders and listens).
import { describe, expect, it } from 'vitest';
import type { MusicMood } from '../api';
import type { Player } from './score';
import { SCORE, midiName, midiOf, parseScore } from './score';

const MOODS: MusicMood[] = ['title', 'calm', 'cold', 'night', 'stalked', 'attack', 'whiteout', 'shelter', 'tower', 'holdout', 'rescue', 'death'];

/** D minor with the cold's Eb; shelter and rescue are the major inflection, D major. */
const MINOR = new Set(['D', 'Eb', 'E', 'F', 'G', 'A', 'Bb', 'C']);
const MAJOR = new Set(['D', 'E', 'F#', 'G', 'A', 'B', 'C#']);
const IN_MAJOR: MusicMood[] = ['shelter', 'rescue'];

/** Where each player can really play (MIDI): a cello stops at its open C string. */
const RANGE: Record<Player, [number, number]> = {
  cello: [midiOf('C2'), midiOf('C6')],
  piano: [midiOf('A0'), midiOf('C8')],
  glass: [midiOf('C3'), midiOf('C7')],
  drum: [midiOf('C2'), midiOf('C3')],
  ice: [midiOf('C6'), midiOf('C8')],
  brass: [midiOf('E2'), midiOf('C6')],
};

const pitchClass = (midi: number): string => midiName(midi).replace(/-?\d+$/, '');

describe('score', () => {
  it('has material for every mood', () => {
    for (const m of MOODS) {
      const s = SCORE.get(m);
      expect(s, m).toBeDefined();
      expect(s!.order.length, m).toBeGreaterThan(0);
      expect(s!.order.some((p) => p.lines.some((l) => l.notes.length > 0)), m).toBe(true);
    }
    expect(SCORE.has('none')).toBe(false);
  });

  it('stays in one key family', () => {
    for (const [mood, s] of SCORE) {
      const key = IN_MAJOR.includes(mood) ? MAJOR : MINOR;
      for (const p of s.phrases.values()) {
        for (const l of p.lines) {
          for (const n of l.notes) expect(key.has(pitchClass(n.midi)), `${mood}/${p.name}/${l.player}: ${midiName(n.midi)}`).toBe(true);
        }
      }
    }
  });

  it('writes every player inside its range and every line inside its phrase', () => {
    for (const [mood, s] of SCORE) {
      for (const p of s.phrases.values()) {
        for (const l of p.lines) {
          const [lo, hi] = RANGE[l.player];
          for (const n of l.notes) {
            const where = `${mood}/${p.name}/${l.player}: ${midiName(n.midi)}`;
            expect(n.midi, where).toBeGreaterThanOrEqual(lo);
            expect(n.midi, where).toBeLessThanOrEqual(hi);
            expect(n.beat + n.dur, where).toBeLessThanOrEqual(p.len + 1e-6);
          }
        }
      }
    }
  });

  it('keeps calm and night mostly silent, and whiteout, stalked and holdout without rests', () => {
    // Share of rest in one pass through the order at intensity 0.5 (rests are written as ranges).
    const restShare = (m: MusicMood): number => {
      const s = SCORE.get(m)!;
      let sound = 0;
      let rest = 0;
      for (const p of s.order) {
        sound += p.len;
        rest += (p.restMin + p.restMax) / 2;
      }
      return rest / (sound + rest);
    };
    expect(restShare('calm')).toBeGreaterThan(0.65);
    expect(restShare('night')).toBeGreaterThan(0.65);
    for (const m of ['whiteout', 'stalked', 'holdout'] as MusicMood[]) expect(restShare(m), m).toBe(0);
  });

  it('leaves the motif hanging on E and resolves it in rescue', () => {
    // The motif stops on the second degree, unanswered; in rescue the cello falls on to D.
    const r1 = SCORE.get('rescue')!.phrases.get('r1')!;
    const cello = r1.lines.find((l) => l.player === 'cello')!;
    expect(midiName(cello.notes[cello.notes.length - 1].midi)).toBe('D3');
    const call = SCORE.get('title')!.phrases.get('call')!;
    const tail = call.lines[0].notes[call.lines[0].notes.length - 1];
    expect(midiName(tail.midi)).toBe('E3');
  });
});

describe('notation', () => {
  const one = (body: string) => parseScore(`mood calm\norder a\nphrase a\n${body}\n`).get('calm')!.order[0];

  it('reads notes, chords, rests, dynamics, repeats and thresholds', () => {
    const p = one('  piano @0.5..0.9 pp D3:2 -:1 mf F#4+A4 [ C5:.5 ]*2 | E5');
    const l = p.lines[0];
    expect(l.min).toBe(0.5);
    expect(l.max).toBe(0.9);
    expect(l.notes.map((n) => midiName(n.midi))).toEqual(['D3', 'F#4', 'A4', 'C5', 'C5', 'E5']);
    expect(l.notes.map((n) => n.beat)).toEqual([0, 3, 3, 4, 4.5, 5]);
    expect(l.notes[1].dur).toBe(1);
    expect(l.notes[0].vel).toBeLessThan(l.notes[1].vel);
    expect(l.notes[2].chord).toBe(1);
    expect(p.len).toBe(5.5);
  });

  it('pedals like a pianist: steps and the bass are damped, leaps ring', () => {
    const l = one('  piano D4:3 A4:3 B4:1 A4:3 F#4:2 E4:6').lines[0];
    expect(l.notes.map((n) => n.damp)).toEqual([Infinity, 3, 1, Infinity, 2, Infinity]);
    const bass = one('  piano D3:6 G2:6 A2:6 D2+A2:8').lines[0];
    expect(bass.notes.map((n) => n.damp)).toEqual([Infinity, 6, 6, Infinity, Infinity]);
  });

  it('refuses what it cannot read', () => {
    expect(() => one('  oboe D4:1')).toThrow(/unknown player/);
    expect(() => one('  piano H4:1')).toThrow(/bad note/);
    expect(() => one('  piano [ D4:1 ]')).toThrow(/bad repeat/);
    expect(() => parseScore('mood calm\norder a b\nphrase a\n  piano D4:1\n')).toThrow(/unknown phrase/);
    expect(() => parseScore('mood calm\norder a\nphrase a len 2\n  piano D4:3\n')).toThrow(/line is 3 beats/);
  });
});
