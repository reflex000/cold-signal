// Death and the ending. Both are set like the last card of a film: a small line above, a title,
// one rule, one sentence, a few numbers, two choices. The ending adds the credits.
import type { HurtCause } from '../sim/types';
import { type Ctx, cls, fmtHour, fmtSpan, fmtTemp, h, txt } from './dom';
import type { Nav, NavItem, Scope } from './nav';
import { CREDITS, DEATH } from './text';

export interface EndApi {
  el: HTMLElement;
  show(kind: 'dead' | 'won' | null, cause?: HurtCause | 'unknown'): void;
}

export function createEnd(ctx: Ctx, nav: Nav): EndApi {
  const { game, view } = ctx;
  const el = h('div', 'scr', ctx.root);
  h('div', 'end-shade', el);
  const box = h('div', 'end', el);
  const scope: Scope = { items: [], sel: null };
  let kind: 'dead' | 'won' | null = null;

  function stat(parent: HTMLElement, value: string, label: string): void {
    const d = h('div', '', parent);
    h('b', 'num', d, value);
    h('span', '', d, label);
  }

  function build(k: 'dead' | 'won', cause: HurtCause | 'unknown'): void {
    box.textContent = '';
    scope.items.length = 0;
    scope.sel = null;
    const env = view.env, s = view.stats;
    const km = s.distance >= 1000 ? (s.distance / 1000).toFixed(1) + ' km' : Math.round(s.distance) + ' m';
    const coldest = Number.isFinite(s.coldest) && s.coldest > 0 ? fmtTemp(s.coldest) + '°' : '—';
    if (k === 'dead') {
      const d = DEATH[cause] ?? DEATH.unknown;
      h('div', 'end-pre', box, `Day ${env.day + 1}   ${fmtHour(env.clock)}`);
      h('h1', 'end-t', box, d.title);
      h('div', 'end-rule', box);
      h('p', 'end-l', box, d.line);
      const st = h('div', 'end-s', box);
      stat(st, fmtSpan(env.t), 'Survived');
      stat(st, km, 'Walked');
      stat(st, String(s.firesLit), 'Fires lit');
      stat(st, coldest, 'Coldest');
    } else {
      h('div', 'end-pre', box, 'Flight 417');
      h('h1', 'end-t', box, 'Rescued');
      h('div', 'end-rule', box);
      h('p', 'end-l', box, 'The winch took you up into the noise and the light. Below, the fire you left was still burning.');
      const st = h('div', 'end-s', box);
      stat(st, fmtSpan(env.t), 'On the mountain');
      stat(st, km, 'Walked');
      stat(st, String(s.firesLit), 'Fires lit');
      stat(st, String(s.wolvesKilled), 'Wolves');
      stat(st, String(s.revives), 'Revives');
      stat(st, coldest, 'Coldest');
      const c = h('div', 'end-c', box);
      for (const cr of CREDITS) {
        const sec = h('section', '', c);
        h('h2', '', sec, cr.h);
        h('p', '', sec, cr.p);
      }
    }
    const m = h('div', 'end-m', box);
    const item = (label: string, id: string, act: () => void): NavItem => {
      const b = h('button', 'mi', m, label);
      b.dataset.id = id;
      return nav.bind(scope, { el: b, id, act });
    };
    if (k === 'dead') {
      item('Respawn', 'respawn', () => game.actions.respawn());
      item('Quit to title', 'quit', () => game.actions.quitToTitle());
    } else {
      item('New game', 'new', () => game.actions.newGame());
      item('Quit to title', 'quit', () => game.actions.quitToTitle());
    }
  }

  return {
    el,
    show(k, cause = 'unknown') {
      if (k === kind) return;
      kind = k;
      if (k) {
        build(k, cause);
        cls(el, 'dd', k === 'dead');
        cls(el, 'wn', k === 'won');
        cls(el, 'on', true);
        nav.open(scope, scope.items[0]);
      } else {
        cls(el, 'on', false);
        if (nav.scope === scope) nav.open(null);
      }
    },
  };
}
