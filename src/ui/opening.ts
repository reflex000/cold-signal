// The opening of a new game: black, the wind, two lines about Flight 417, then the fade into the
// player's view inside the broken fuselage at dusk. The game keeps the controls and the world still for
// OPENING_SECONDS (view.opening counts the seconds left); any key, click, tap or pad button skips to the
// fade. This draws it: an opaque layer over everything but the loading screen, the lines one after the
// other, and the black thinning away at the end.
// Owner: RELEASE.
import { type Ctx, cls, h, sty } from './dom';

export const OPENING_LINES: readonly string[] = [
  'Flight 417 went down on the south face of the mountain, an hour before dark.',
  'The radio is dead. No one knows where you are.',
];
/** Seconds of the whole opening, and of the fade from black that ends it. */
export const OPENING_SECONDS = 12.5;
export const OPENING_FADE = 3.2;
/** Seconds after the start before a key or a tap skips (the click that started the game must not). */
export const OPENING_SKIP_AFTER = 0.8;
/** When each line is up, seconds from the start: [in, out]. */
const LINE_AT: readonly (readonly [number, number])[] = [
  [1.0, 5.3],
  [5.9, 10.1],
];
const LINE_FADE = 1.2;

export interface OpeningApi {
  el: HTMLElement;
  /** True while the opening covers the screen (the HUD and touch controls stay away). */
  active(): boolean;
  update(): void;
}

const ease = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function createOpening(ctx: Ctx): OpeningApi {
  const el = h('div', 'opn', ctx.root);
  const lines = OPENING_LINES.map((t) => h('p', 'opn-l', el, t));
  let on = false;
  let lastBlack = '', lastLine = ['', ''];
  return {
    el,
    active: () => on,
    update() {
      const left = ctx.view.opening ?? 0;
      const want = left > 0 && ctx.view.mode !== 'title' && ctx.view.mode !== 'boot';
      if (want !== on) {
        on = want;
        cls(el, 'on', on);
        lastBlack = '';
        lastLine = ['', ''];
      }
      if (!on) return;
      const t = OPENING_SECONDS - left;
      // fully black until the fade; the fade eases so the fuselage comes up out of the dark slowly
      const black = left >= OPENING_FADE ? 1 : ease(left / OPENING_FADE);
      const b = black.toFixed(3);
      if (b !== lastBlack) sty(el, 'opacity', (lastBlack = b));
      lines.forEach((l, i) => {
        const [a, z] = LINE_AT[i];
        const k = Math.min(ease((t - a) / LINE_FADE), 1 - ease((t - (z - LINE_FADE)) / LINE_FADE));
        const o = Math.max(0, k).toFixed(3);
        if (o !== lastLine[i]) sty(l, 'opacity', (lastLine[i] = o));
      });
    },
  };
}
