// Where the players sit: one channel strip per player (the instrument's body, its level, its
// place left to right, how much of it goes to the room), one shared reverb with a long cold tail
// whose impulse response is computed here, and a ceiling so the score can never clip.
import type { Ctx } from './instruments';
import type { Player } from './score';
import { PLAYERS } from './score';

type Band = [type: BiquadFilterType, freq: number, q: number, gainDb: number];

interface StripSpec {
  /** Linear level of the player in the mix. */
  level: number;
  /** -1 left .. 1 right. Glass and ice place each voice themselves and stay centred here. */
  pan: number;
  /** How much of the player goes to the reverb. */
  send: number;
  /** Fixed resonances: the instrument's body or mute. */
  body: Band[];
}

const STRIPS: Record<Player, StripSpec> = {
  cello: {
    level: 0.8,
    pan: -0.22,
    send: 0.4,
    // Air and wood resonances of a cello body, and the bridge hill that gives it its edge.
    body: [
      ['peaking', 96, 2.5, 3],
      ['peaking', 186, 3.5, 5],
      ['peaking', 285, 4, 4],
      ['peaking', 510, 3, 3],
      ['peaking', 2300, 1.6, 4],
      ['lowpass', 6000, 0.7, 0],
    ],
  },
  piano: {
    level: 1,
    pan: 0.14,
    send: 0.45,
    body: [
      ['peaking', 240, 1.2, 2.5],
      ['highshelf', 3500, 0.7, -4],
    ],
  },
  glass: { level: 0.55, pan: 0, send: 0.7, body: [] },
  drum: { level: 1, pan: 0, send: 0.14, body: [['lowpass', 900, 0.7, 0]] },
  ice: { level: 0.4, pan: 0, send: 0.8, body: [] },
  brass: {
    level: 0.42,
    pan: 0.28,
    send: 0.55,
    // The mute: lows thinned, a nasal peak, the top closed.
    body: [
      ['highpass', 200, 0.7, 0],
      ['peaking', 1150, 2.2, 7],
      ['peaking', 2700, 1.2, -5],
      ['lowpass', 4200, 0.7, 0],
    ],
  },
};

/** Music level before the ceiling; set so the loudest moods peak near -14 dBFS. */
const MASTER = 0.5;
/** The ceiling: linear up to KNEE, then bends so nothing passes LIMIT. */
const KNEE = 0.2;
const LIMIT = 0.3;

const REVERB_SECONDS = 5.5;
const REVERB_LEVEL = 0.9;

function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A large, cold space: open rock and hard snow rather than a hall. Three bands of noise with
 * their own decay times (the middle rings longest, the top goes first, the bottom is kept thin
 * so the tail never turns to mud), a soft onset instead of a slap, a few early reflections.
 * Each channel has unit energy, so a held tone comes back about as loud as it went in.
 */
export function makeImpulse(ctx: Ctx, seconds = REVERB_SECONDS, seed = 4170): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, len, sr);
  const aLo = 1 - Math.exp((-2 * Math.PI * 280) / sr);
  const aHi = 1 - Math.exp((-2 * Math.PI * 2600) / sr);
  // Decay constants from RT60: amplitude falls 60 dB in the given time.
  const kLo = 6.91 / 3.4;
  const kMid = 6.91 / 5.6;
  const kHi = 6.91 / 2.3;
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry(seed + ch * 7919);
    const d = buf.getChannelData(ch);
    let lo = 0;
    let lp = 0;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const w = rnd() * 2 - 1;
      lo += aLo * (w - lo);
      lp += aHi * (w - lp);
      const mid = lp - lo;
      const hi = w - lp;
      const onset = 1 - Math.exp(-t / 0.035);
      const tailOff = Math.min(1, (seconds - t) / 0.4);
      const v = (lo * 1.6 * Math.exp(-kLo * t) + mid * 1.4 * Math.exp(-kMid * t) + hi * 0.55 * Math.exp(-kHi * t)) * onset * tailOff;
      d[i] = v;
      energy += v * v;
    }
    // Early reflections: a handful of single taps, different on each side.
    for (let r = 0; r < 7; r++) {
      const at = Math.floor((0.012 + rnd() * 0.085) * sr);
      const v = (rnd() < 0.5 ? -1 : 1) * (0.5 - r * 0.05) * Math.sqrt(energy) * 0.12;
      energy += 2 * d[at] * v + v * v;
      d[at] += v;
    }
    const norm = 1 / Math.sqrt(energy);
    for (let i = 0; i < len; i++) d[i] *= norm;
  }
  return buf;
}

function ceiling(ctx: Ctx): WaveShaperNode {
  const n = 8193;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= KNEE ? a : KNEE + (LIMIT - KNEE) * Math.tanh((a - KNEE) / (LIMIT - KNEE));
    curve[i] = Math.sign(x) * y;
  }
  const ws = ctx.createWaveShaper();
  ws.curve = curve;
  return ws;
}

export interface Mixer {
  /** What a player's voices connect to. */
  strip: Record<Player, AudioNode>;
  dispose(): void;
}

/** `raw`: leave the ceiling out, so level analysis sees the true peaks it would have bent. */
export function makeMixer(ctx: Ctx, out: AudioNode, o: { raw?: boolean } = {}): Mixer {
  const nodes: AudioNode[] = [];
  const keep = <T extends AudioNode>(n: T): T => {
    nodes.push(n);
    return n;
  };
  const gainNode = (v: number): GainNode => {
    const g = keep(ctx.createGain());
    g.gain.value = v;
    return g;
  };

  const sum = gainNode(MASTER);
  if (o.raw) sum.connect(out);
  else sum.connect(keep(ceiling(ctx))).connect(out);

  const room = gainNode(1);
  const pre = keep(ctx.createDelay(0.1));
  pre.delayTime.value = 0.028;
  const conv = keep(ctx.createConvolver());
  conv.normalize = false;
  conv.buffer = makeImpulse(ctx);
  const thin = keep(ctx.createBiquadFilter());
  thin.type = 'highpass';
  thin.frequency.value = 160;
  thin.Q.value = 0.5;
  room.connect(pre).connect(conv).connect(thin).connect(gainNode(REVERB_LEVEL)).connect(sum);

  const strip = {} as Record<Player, AudioNode>;
  for (const p of PLAYERS) {
    const spec = STRIPS[p];
    const input = gainNode(1);
    let node: AudioNode = input;
    for (const [type, freq, q, db] of spec.body) {
      const f = keep(ctx.createBiquadFilter());
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      f.gain.value = db;
      node = node.connect(f);
    }
    const pan = keep(ctx.createStereoPanner());
    pan.pan.value = spec.pan;
    node.connect(gainNode(spec.level)).connect(pan);
    pan.connect(sum);
    pan.connect(gainNode(spec.send)).connect(room);
    strip[p] = input;
  }

  return {
    strip,
    dispose() {
      for (const n of nodes) n.disconnect();
      nodes.length = 0;
    },
  };
}
