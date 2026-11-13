// The few beats that make the hour. Spare and grave: a line now and then, never a speech.
//   notes      one at each place (device 'note', data = index): the captain at the wreck and the tail,
//              the ranger at the cabin and the hut, the survey crew at the cave, the camp and the tower.
//              Each points to the next place. USE reads it (a 'lore' toast to the reader).
//   first howl at dusk on the first day, from far up the mountain, before any pack is awake.
//   whiteouts  a warning WARN_LEAD seconds before each scripted whiteout (env.ts whiteoutWindow).
//   the radio  the first time anyone's hand-crank radio clears into a tone.
//   generator  its first cough under the crank.
// Vars: story.howl, story.wo (next whiteout to warn of), story.tone, story.cough.
// Owner: OBJECTIVE.
import type { SimCtx, System } from '../api';
import { BTN, type DeviceEnt, type PlayerEnt } from '../types';
import { whiteoutWindow } from './env';
import { focusOf, toast } from './items';
import { deviceReach } from './objective';

/** What the notes say, by DeviceEnt.data. */
export const NOTES: readonly string[] = [
  // 0 the wreck: the captain, before you woke
  'Flight 417. The tail tore away as we came down and went over the edge to the east, into the ravine. The battery for the radio went with it. I am going down for it. Keep the barrel burning. Hale, captain.',
  // 1 the tail section
  'The battery is here under the cargo net. I cannot carry it back up with this leg. Before we hit I saw a cabin roof to the west, in the forest. I will try for that. Hale.',
  // 2 the ranger cabin
  'Ranger station log. Supply flight cancelled again. Spares are in the fishing hut on the lake. The ice is good along the poles. Off them, by the inlet and the dark patches, it will not hold a man.',
  // 3 the hut on the ice
  'Took the spare valves up to the survey cache in the cave under the cliffs, north-west of here. The wolves have the cave again this winter. Go in daylight, and take a light.',
  // 4 the cave
  'Cache three. Valve for the tower set left here. The antenna coil is still with the tents on the east shoulder. The wind took the camp apart. We are going up to the tower to sit it out. Varga, survey.',
  // 5 the survey camp
  'Coil packed in the blue case. The set on the ridge will not key until all five parts are back in: battery, handset, valve, coil, fuse. The generator is a hand crank. Two on the handles charge it fast. Varga.',
  // 6 the signal tower
  'If you are reading this the set is yours. Fit the parts, crank it full and keep it turning while the call goes out. Then hold the deck. In weather like this they will not come down without a flare to land on.',
];

/** Seconds of warning before a whiteout reaches its worst (env.ts ramps it in over the last 70). */
export const WARN_LEAD = 100;
/** Hour of the first howl on day one (dusk is 17:30 to 19:30). */
export const HOWL_CLOCK = 18.2;
/** Radio signal (PlayerEnt.radioSig) that counts as a clear tone, and generator charge that coughs. */
export const TONE_SIG = 0.8;
export const COUGH_CHARGE = 0.12;

const WHITEOUT_LINES = [
  'The wind has backed round and the light has gone flat. A whiteout is coming. Get to shelter or a fire.',
  'Snow is lifting off the ridges and the far trees are gone. Another whiteout, minutes away.',
  'The cloud is coming down the mountain. Whiteout soon. Stay on the trail or stay by a fire.',
];

const V = { howl: 'story.howl', wo: 'story.wo', tone: 'story.tone', cough: 'story.cough' } as const;

/** Past the call, the story is the objective's. */
function quiet(ctx: SimCtx): boolean {
  const s = ctx.state.objective.stage;
  return s === 'holdout' || s === 'rescue' || s === 'won' || s === 'lost';
}

function readNote(ctx: SimCtx, p: PlayerEnt): void {
  if (p.life !== 'alive' || p.swim || !ctx.pressed(p.id, BTN.USE)) return;
  const d = focusOf(ctx, p, 'device') as DeviceEnt | undefined;
  if (!d || d.type !== 'note' || !deviceReach(ctx, p, d)) return;
  const text = NOTES[d.data] ?? NOTES[0];
  toast(ctx, p, 'lore', text);
}

function firstHowl(ctx: SimCtx): void {
  const env = ctx.state.env;
  if (ctx.v(V.howl) || env.day !== 0 || env.clock < HOWL_CLOCK || quiet(ctx)) return;
  ctx.setV(V.howl, 1);
  const w = ctx.world;
  const pk = w.spawn.packs[0];
  const at = pk ? { x: pk.x, z: pk.z } : { x: w.poi('cave').x, z: w.poi('cave').z };
  ctx.emit({ t: 'howl', id: 0, x: at.x, y: w.heightAt(at.x, at.z) + 1, z: at.z, pack: -1 });
  ctx.emit({ t: 'toast', to: 0, kind: 'info', text: 'Wolves, far off up the mountain.' });
}

function whiteouts(ctx: SimCtx): void {
  const st = ctx.state, t = st.env.t;
  let k = ctx.v(V.wo);
  // a few at most per tick: windows already behind us (a loaded game) are skipped silently
  for (let guard = 0; guard < 8; guard++) {
    const win = whiteoutWindow(st.seed, k);
    if (t < win.t0 - WARN_LEAD) break;
    if (t < win.t1 && !quiet(ctx)) ctx.emit({ t: 'toast', to: 0, kind: 'warn', text: WHITEOUT_LINES[k % WHITEOUT_LINES.length] });
    k++;
    ctx.setV(V.wo, k);
  }
}

function radioTone(ctx: SimCtx, p: PlayerEnt): void {
  if (p.bot || p.life !== 'alive' || p.held !== 'radio' || !(p.radioCharge > 0.02) || !(p.radioSig >= TONE_SIG)) return;
  ctx.setV(V.tone, 1);
  toast(ctx, p, 'info', 'Under the static, a clear tone. Something out there is still answering.');
}

function cough(ctx: SimCtx): void {
  if (ctx.v(V.cough) || ctx.state.objective.generator < COUGH_CHARGE) return;
  ctx.setV(V.cough, 1);
  ctx.emit({ t: 'toast', to: 0, kind: 'info', text: 'The generator coughs and stutters. Keep cranking.' });
}

export const story: System = {
  name: 'story',

  step(ctx) {
    const players = ctx.players();
    if (players.length === 0) return; // nobody on the mountain, no story
    const toneDone = !!ctx.v(V.tone);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      readNote(ctx, p);
      if (!toneDone && !ctx.v(V.tone)) radioTone(ctx, p);
    }
    // the clock-driven beats need no finer grain than a quarter second
    if (ctx.tick % 8 === 0) {
      firstHowl(ctx);
      whiteouts(ctx);
    }
    cough(ctx);
  },
};
