// Sustained sounds. Each builds a graph that runs until stopped and returns a `param` function
// that maps the loop's 0..1 parameter (heat, life, charge, signal, closeness) onto it.
import type { LoopName } from './api';
import { type Scope, clamp, lerp, smooth, tanhCurve, xlerp } from './dsp';
import type { LoopDef } from './engine';

const SAT = tanhCurve(3);
const SOFT = tanhCurve(1.5);
const INF = Infinity;

/** noise -> filter -> gain(0) -> to. The caller sets the gain. */
function layer(s: Scope, kind: Parameters<Scope['noise']>[0], type: BiquadFilterType, f: number, q: number, to: AudioNode = s.out, rate = 1): { f: BiquadFilterNode; g: GainNode } {
  const src = s.noise(kind, s.t, INF, rate);
  const flt = s.filt(type, f, q);
  const g = s.gain(0);
  s.chain(src, flt, g).connect(to);
  return { f: flt, g };
}
const glide = (p: AudioParam, v: number, at: number, tc = 0.15): void => {
  p.setTargetAtTime(v, at, tc);
};

/** A sine LFO as a control source. */
function lfoOsc(s: Scope, hz: number): OscillatorNode {
  const o = s.ctx.createOscillator();
  o.frequency.value = hz;
  o.start(s.t);
  s.ctl.push(o);
  return o;
}
/**
 * A gain opened by an LFO: the part of the sine above the level that leaves `duty` of the period
 * open (sharp = how square the edges are). invert opens on the other half of the cycle.
 */
function gate(s: Scope, lfo: AudioNode, duty: number, sharp = 40, invert = false): GainNode {
  const n = 512;
  const c = new Float32Array(n);
  const th = Math.cos(Math.PI * duty);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * (invert ? -1 : 1);
    c[i] = clamp((x - th) * sharp);
  }
  const g = s.gain(0);
  s.chain(lfo, s.shaper(c)).connect(g.gain);
  return g;
}

const defs: Record<LoopName, LoopDef> = {
  /** A wood fire: a breathing roar, pops ringing through the logs, the hiss of resin. param = heat. */
  fire: { pri: 2, ref: 3.5, local: 0.15, build(s) {
    const roar = layer(s, 'brown', 'lowpass', 300, 0.6);
    const breathe = s.gain(0);
    s.lfo(0.5, s.t, INF).connect(breathe);
    breathe.connect(roar.g.gain);
    const flame = layer(s, 'pink', 'bandpass', 620, 0.5);
    const flut = s.gain(0);
    s.lfo(7, s.t, INF).connect(flut);
    flut.connect(flame.g.gain);
    // pops: two crackle textures at unrelated rates (so the pattern never repeats) through the wood's resonances
    const pops = s.gain(0);
    pops.connect(s.out);
    const res = s.gain(1);
    for (const [f, q, lv] of [[1650, 3, 1], [2900, 4, 0.8], [4700, 3, 0.5], [820, 2, 0.5]] as const) s.chain(res, s.filt('bandpass', f * s.vary(1, 0.08), q), s.gain(lv)).connect(pops);
    const c1 = s.noise('crackle', s.t, INF, 0.83);
    const c2 = s.noise('crackle', s.t, INF, 1.31);
    c1.connect(res);
    c2.connect(res);
    s.chain(c1, s.gain(0.15)).connect(pops);
    const hiss = layer(s, 'dust', 'highpass', 3400, 0.7);
    return {
      param(h, at) {
        glide(roar.g.gain, 0.05 + 0.75 * h, at, 0.4);
        glide(breathe.gain, 0.03 + 0.3 * h, at, 0.4);
        glide(roar.f.frequency, 180 + 480 * h, at, 0.4);
        glide(flame.g.gain, 0.02 + 0.3 * h, at, 0.4);
        glide(flut.gain, 0.15 * h, at, 0.4);
        glide(flame.f.frequency, 480 + 500 * h, at, 0.4);
        // embers tick quietly; a good fire spits. The crackle texture peaks at full scale with
        // a 26 dB crest, so these stay small: pops about 12 dB over the roar's RMS
        glide(pops.gain, 0.35 + 1.4 * Math.sqrt(h), at, 0.4);
        glide(c2.playbackRate, 0.7 + 0.9 * h, at, 0.4);
        glide(hiss.g.gain, 0.12 + 0.7 * h, at, 0.4);
      },
    };
  } },

  /** A hand flare: a fierce jet of burning metal. param = life (1 fresh, 0 guttering). */
  flare: { pri: 2, ref: 5, local: 0.1, build(s) {
    const main = s.gain(0);
    main.connect(s.out);
    const jet = layer(s, 'white', 'highpass', 2400, 0.8, main);
    jet.g.gain.value = 0.55;
    s.mod(jet.g.gain, 38, 0.2);
    const edge = layer(s, 'white', 'bandpass', 5600, 2.2, main);
    edge.g.gain.value = 0.7;
    s.mod(edge.f.frequency, 9, 900);
    const body = s.noise('pink', s.t, INF);
    const bg = s.gain(0.9);
    s.chain(body, s.filt('bandpass', 950, 1.1), s.shaper(SAT), bg).connect(main);
    s.mod(bg.gain, 23, 0.35);
    // the buzz of the burn itself
    const o = s.osc('sawtooth', s.rr(165, 185), s.t, INF);
    s.mod(o.frequency, 19, 14);
    s.chain(o, s.filt('bandpass', 1250, 2.5), s.gain(0.09)).connect(main);
    // guttering: slow deep swings as it dies
    const gut = s.gain(0);
    s.lfo(5, s.t, INF).connect(gut);
    gut.connect(main.gain);
    return {
      param(life, at) {
        const k = smooth(0, 0.22, life);
        glide(main.gain, 0.12 + 0.3 * k, at, 0.2);
        glide(gut.gain, 0.1 * (1 - k) + 0.03, at, 0.2);
        glide(jet.f.frequency, lerp(1500, 2400, k), at, 0.2);
      },
    };
  } },

  /** The tower's petrol generator. param = charge: it steadies and the dynamo sings higher as the cells fill. */
  generator: { pri: 2, ref: 8, local: 0.2, far: 0.15, build(s) {
    const lp = s.filt('lowpass', 520, 0.9);
    s.chain(lp, s.shaper(SAT), s.gain(0.22)).connect(s.out);
    const o = s.osc(s.W.pulse, 44, s.t, INF);
    o.connect(lp);
    const sub = s.osc('sine', 44, s.t, INF);
    s.chain(sub, s.gain(0.1)).connect(s.out);
    // idle hunts up and down until it is under load
    const hunt = s.gain(0);
    s.lfo(2.2, s.t, INF).connect(hunt);
    hunt.connect(o.frequency);
    hunt.connect(sub.frequency);
    // each stroke shakes the housing
    const rattle = layer(s, 'pink', 'bandpass', 1500, 0.7);
    rattle.g.gain.value = 0.15;
    s.chain(o, s.gain(0.35)).connect(rattle.g.gain);
    const tin = layer(s, 'crunch', 'bandpass', 3100, 2);
    tin.g.gain.value = 0.2;
    const w1 = s.osc('sine', 600, s.t, INF);
    const w2 = s.osc('triangle', 1203, s.t, INF);
    const wg = s.gain(0);
    w1.connect(wg);
    s.chain(w2, s.gain(0.3)).connect(wg);
    wg.connect(s.out);
    return {
      param(c, at) {
        const f = 43 + 9 * c;
        glide(o.frequency, f, at, 0.5);
        glide(sub.frequency, f, at, 0.5);
        glide(hunt.gain, 2.4 * (1 - c) + 0.3, at, 0.5);
        glide(w1.frequency, 560 + 900 * c, at, 0.5);
        glide(w2.frequency, 2 * (560 + 900 * c) + 3, at, 0.5);
        glide(wg.gain, 0.008 + 0.03 * c, at, 0.5);
      },
    };
  } },

  /** The hand-crank radio held up: static that parts, as param rises, to a clear two-tone signal. */
  radio_static: { pri: 2, ref: 2.5, build(s) {
    const hp = s.filt('highpass', 450, 0.8);
    s.chain(hp, s.filt('peaking', 1500, 0.9, 7), s.shaper(SOFT), s.filt('lowpass', 3400, 0.7), s.gain(0.3)).connect(s.out);
    const hiss = layer(s, 'white', 'bandpass', 1900, 0.5, hp);
    const swell = s.gain(0);
    s.lfo(1.1, s.t, INF).connect(swell);
    swell.connect(hiss.g.gain);
    const crack = layer(s, 'dust', 'highpass', 900, 0.7, hp);
    const pops = layer(s, 'crackle', 'highpass', 600, 0.7, hp, 0.7);
    // the signal: one oscillator keyed between two tones (1040 and 1310 Hz)
    const sig = s.gain(0);
    sig.connect(hp);
    const tone = s.osc('sine', 1175, s.t, INF);
    const key = lfoOsc(s, 2.4);
    key.type = 'square';
    s.chain(key, s.gain(135)).connect(tone.frequency);
    tone.connect(sig);
    // off-tune: a heterodyne whistle that wanders in and settles onto the signal as it clears
    const het = s.osc('sine', 1040, s.t, INF);
    const hetG = s.gain(0);
    het.connect(hetG).connect(hp);
    const wand = s.gain(0);
    s.lfo(0.6, s.t, INF).connect(wand);
    wand.connect(het.frequency);
    // fading: a weak signal comes and goes
    const fade = s.gain(0);
    s.lfo(1.7, s.t, INF).connect(fade);
    fade.connect(sig.gain);
    return {
      param(p, at) {
        const n = Math.pow(1 - p, 1.4);
        glide(hiss.g.gain, 0.06 + 1.5 * n, at);
        glide(swell.gain, 0.5 * n, at);
        glide(hiss.f.frequency, lerp(2400, 1500, n), at);
        glide(crack.g.gain, 4 * n, at);
        glide(pops.g.gain, 5 * n, at);
        glide(sig.gain, 0.3 * Math.pow(p, 1.7), at);
        glide(fade.gain, 0.22 * p * (1 - p), at);
        glide(hetG.gain, 0.5 * p * (1 - p) * (1 - p), at);
        glide(wand.gain, 700 * (1 - p), at);
      },
    };
  } },

  /** The rescue helicopter. param = closeness: a far thudding in the wind becomes the whole sky. */
  heli: { pri: 3, ref: 60, far: 0.5, air: 0.5, build(s) {
    const main = s.gain(0);
    main.connect(s.out);
    const bpf = 17.5; // blade passes per second
    const lp = s.filt('lowpass', 150, 0.8);
    const th = s.gain(0.9);
    s.chain(lp, s.shaper(SAT), th).connect(main);
    const o = s.osc(s.W.pulse, bpf, s.t, INF);
    o.connect(lp);
    const sub = s.osc('sine', bpf * 2, s.t, INF);
    s.chain(sub, s.gain(0.25)).connect(main);
    // blade slap: air torn at each pass
    const slap = layer(s, 'pink', 'bandpass', 520, 0.6, main);
    const slapDepth = s.gain(0);
    o.connect(slapDepth).connect(slap.g.gain);
    const wash = layer(s, 'pink', 'lowpass', 900, 0.5, main);
    // the turbine, and the tail rotor's buzz
    const whine = layer(s, 'white', 'bandpass', 3900, 7, main);
    const t1 = s.osc('sine', 5150, s.t, INF);
    const tg = s.gain(0);
    t1.connect(tg).connect(main);
    const tail = s.osc('sawtooth', 96, s.t, INF);
    const tailG = s.gain(0);
    s.chain(tail, s.filt('bandpass', 480, 1.5), tailG).connect(main);
    // far away the wind carries it in and out
    const waft = s.gain(0);
    s.lfo(0.45, s.t, INF).connect(waft);
    waft.connect(main.gain);
    let last = -1;
    let lastAt = 0;
    let dop = 0;
    return {
      param(c, at) {
        // Doppler-ish: coming in raises everything a little, going away lowers it
        if (last >= 0 && at > lastAt) {
          const v = clamp(((c - last) / (at - lastAt)) * 5, -1, 1);
          dop = lerp(dop, v, 0.3);
        }
        last = c;
        lastAt = at;
        const cents = dop * 90 + 40 * c;
        for (const src of [o, sub, t1, tail]) glide(src.detune, cents, at, 0.3);
        const k = c * c;
        glide(main.gain, 0.1 + 0.9 * k, at, 0.25);
        glide(waft.gain, 0.06 * (1 - c), at, 0.25);
        glide(lp.frequency, xlerp(110, 420, c), at, 0.25);
        glide(slap.g.gain, 0.5 * c, at, 0.25);
        glide(slapDepth.gain, 0.9 * c, at, 0.25);
        glide(slap.f.frequency, xlerp(300, 900, c), at, 0.25);
        glide(wash.g.gain, 1.6 * k, at, 0.25);
        glide(whine.g.gain, 2.2 * k, at, 0.25);
        glide(tg.gain, 0.02 * k, at, 0.25);
        glide(tailG.gain, 0.12 * c, at, 0.25);
      },
    };
  } },

  /** The cabin stove with its door shut: a muffled draw, soft crackle, the iron ticking as it heats. */
  stove: { pri: 2, ref: 3, local: 0.5, build(s) {
    // a soft draw, not a rumble: the iron box keeps the roar in and lets the crackle through dulled
    const draw = layer(s, 'brown', 'lowpass', 260, 0.7);
    draw.g.gain.value = 0.16;
    s.mod(draw.g.gain, 0.35, 0.06);
    const roar = layer(s, 'pink', 'bandpass', 420, 0.8);
    roar.g.gain.value = 0.09;
    s.mod(roar.g.gain, 0.5, 0.04);
    // the flue is a pipe: it hums
    const flue = layer(s, 'pink', 'bandpass', 104, 9);
    flue.g.gain.value = 0.28;
    s.mod(flue.f.frequency, 0.3, 5);
    const crack = s.noise('crackle', s.t, INF, 0.62);
    s.chain(crack, s.filt('lowpass', 1800, 0.7), s.gain(1.1)).connect(s.out);
    const tick = s.noise('crackle', s.t, INF, 0.29);
    const tk = s.gain(0.8);
    for (const f of [2300, 3650]) s.chain(tick, s.filt('bandpass', f, 12), tk);
    tk.connect(s.out);
    return {};
  } },

  /** The locator beacon: a double pip through a small speaker, every second and a half. */
  beacon: { pri: 2, ref: 6, local: 0.1, build(s) {
    const pip = gate(s, lfoOsc(s, 0.65), 0.05, 60);
    const o = s.osc('sine', 2730, s.t, INF);
    const o2 = s.osc('triangle', 1365, s.t, INF);
    o.connect(pip);
    s.chain(o2, s.gain(0.35)).connect(pip);
    const bp = s.filt('bandpass', 2600, 1.5);
    s.chain(bp, s.gain(0.09)).connect(s.out);
    pip.connect(bp);
    // the second pip is the first, a moment later
    s.chain(pip, s.delay(0.17), s.gain(0.8)).connect(bp);
    return {};
  } },

  /** A wolf close by: panting, with the growl coming up under it as it nears. param = closeness. */
  wolf_breath: { pri: 1, ref: 3, build(s) {
    const pant = s.gain(0);
    pant.connect(s.out);
    // in and out: two bands that alternate
    const rate = s.rr(2.6, 3.3);
    const n = s.noise('pink', s.t, INF);
    const cyc = lfoOsc(s, rate);
    s.chain(n, s.filt('bandpass', 1900, 1.2), gate(s, cyc, 0.42, 4)).connect(pant);
    s.chain(n, s.filt('bandpass', 1050, 1.0), gate(s, cyc, 0.42, 4, true), s.gain(1.3)).connect(pant);
    const o = s.osc(s.W.rasp, s.rr(78, 92), s.t, INF);
    s.mod(o.frequency, 5, 5);
    const gr = s.gain(0);
    const src = s.gain(0.5);
    o.connect(src);
    s.mod(src.gain, s.rr(24, 32), 0.45);
    for (const [f, q, lv] of [[380, 2, 1], [820, 3, 0.7], [1900, 4, 0.3]] as const) s.chain(src, s.filt('bandpass', f, q), s.gain(lv)).connect(gr);
    gr.connect(s.out);
    return {
      param(c, at) {
        glide(pant.gain, 0.35 + 0.5 * c, at);
        glide(gr.gain, 0.5 * smooth(0.35, 1, c), at);
      },
    };
  } },
};

export const LOOPS: Readonly<Record<string, LoopDef>> = defs;
export const LOOP_NAMES = Object.keys(defs) as LoopName[];
