// Release page: open the game as a player would (no tool parameters), check the title is up
// with its menu, that no tool hook leaked into the page, and let it run for a few seconds.
//   npm run build && node tools/play.mjs tools/scenarios/release.mjs --dist 1
export const bare = true;

export default async function ({ page, ev, shot, log, check, sleep }) {
  await sleep(2500);
  const st = await ev(() => ({
    cs: typeof window.CS,
    title: !!document.querySelector('.tt.on'),
    menu: [...document.querySelectorAll('.tt .mi')].filter((b) => !b.hidden).map((b) => b.textContent),
    backend: window.BACKEND,
    canvas: (() => {
      const c = document.getElementById('game');
      return c ? `${c.width}x${c.height}` : 'none';
    })(),
  }));
  log(st);
  check(st.cs === 'undefined', 'no tool hook on the release page');
  check(st.title, 'the title screen is up');
  check(st.menu.includes('New game'), 'the title menu offers a new game');
  await shot('release_title');
}
