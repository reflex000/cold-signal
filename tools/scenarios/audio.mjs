// Audio: unlock the synth (the test browser needs no gesture), walk, and check the game feeds it:
// voices are playing (wind bed, footsteps), the meter moves, nothing throws.
//   node tools/play.mjs tools/scenarios/audio.mjs --live 1
export const live = true;

export default async function ({ ev, log, check, sleep }) {
  await ev(() => window.CS.game.audio.unlock());
  await sleep(800);
  const ready = await ev(() => window.CS.game.audio.ready);
  check(ready, 'the audio engine is up');
  await ev(() => {
    window.CS.go(-60, 470, 45, 0);
    window.CS.input({ mz: 1, b: 1 });
  });
  let peak = 0, voices = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const m = await ev(() => window.CS.game.audio.meter());
    peak = Math.max(peak, m.peak);
    voices = Math.max(voices, m.voices);
  }
  await ev(() => window.CS.input(null));
  log(`meter: peak ${peak.toFixed(3)}, voices up to ${voices}`);
  check(voices > 0, 'voices are playing');
  check(peak > 0.001, 'the master bus carries sound');
  check(peak < 1, 'and does not clip');
}
