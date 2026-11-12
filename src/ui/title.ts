// Loading and title. The loading screen is opaque (the scene is still being built behind it);
// the title is set over the live scene, which the game keeps rendering.
import { type Ctx, cls, h, sty, txt } from './dom';
import type { MenuApi } from './menu';
import type { Nav, NavItem, Scope } from './nav';
import { CREDIT_LINE } from './text';

export interface LoadingApi {
  el: HTMLElement;
  show(on: boolean): void;
  set(progress: number, label: string): void;
}

export function createLoading(ctx: Ctx): LoadingApi {
  const el = h('div', 'scr ld on', ctx.root);
  h('div', 'ld-n', el, 'Cold Signal');
  const bar = h('div', 'ld-b idle', el);
  const fill = h('i', '', bar);
  const label = h('div', 'ld-l', el);
  let shown = true;
  return {
    el,
    show(on) {
      if (on === shown) return;
      shown = on;
      cls(el, 'on', on);
    },
    set(progress, text) {
      const known = Number.isFinite(progress) && progress >= 0;
      cls(bar, 'idle', !known);
      sty(fill, 'transform', known ? `scaleX(${Math.min(1, progress).toFixed(3)})` : '');
      txt(label, text || '');
    },
  };
}

export interface TitleApi {
  el: HTMLElement;
  show(on: boolean): void;
  /** True while the overlay (settings, how to play) is open over the title. */
  sub(on: boolean): void;
  update(dt: number): void;
  scope: Scope;
}

export function createTitle(ctx: Ctx, nav: Nav, menu: MenuApi): TitleApi {
  const { game } = ctx;
  const el = h('div', 'scr tt', ctx.root);
  h('div', 'tt-shade', el);
  const head = h('div', 'tt-head', el);
  h('div', 'tt-pre', head, 'Flight 417');
  h('h1', 'tt-name', head, 'Cold Signal');
  h('div', 'tt-rule', head);
  h('p', 'tt-sub', head, 'The radio is dead. Its parts are on the mountain.');
  const menuEl = h('div', 'tt-menu', el);
  h('div', 'tt-foot', el, CREDIT_LINE);

  const scope: Scope = { items: [], sel: null };
  let confirmNew = false;
  const item = (label: string, id: string, act: () => void): NavItem => {
    const b = h('button', 'mi', menuEl, label);
    b.dataset.id = id;
    return nav.bind(scope, { el: b, act, id, onSel: () => resetAsk() });
  };
  const newItem = item('New game', 'new', () => {
    if (game.actions.hasSave() && !confirmNew) {
      confirmNew = true;
      txt(newItem.el, ctx.device === 'touch' ? 'Tap again to start over' : 'Start over. The save is lost');
      cls(newItem.el, 'ask', true);
      return;
    }
    resetAsk();
    game.actions.newGame();
  });
  const contItem = item('Continue', 'continue', () => game.actions.continueGame());
  const openSub = (p: 'settings' | 'how') => {
    api.sub(true);
    menu.open('title', p);
  };
  item('Settings', 'settings', () => openSub('settings'));
  item('How to play', 'how', () => openSub('how'));

  function resetAsk(): void {
    if (!confirmNew) return;
    confirmNew = false;
    txt(newItem.el, 'New game');
    cls(newItem.el, 'ask', false);
  }

  let shown = false;
  let subOn = false;
  let saveAt = -1;
  let t = 0;

  function refreshSave(): void {
    const has = game.actions.hasSave();
    if (contItem.el.hidden === has) contItem.el.hidden = !has;
  }

  const api: TitleApi = {
    el,
    scope,
    show(on) {
      if (on === shown) return;
      shown = on;
      cls(el, 'on', on);
      if (on) {
        resetAsk();
        refreshSave();
        if (!subOn) nav.open(scope, game.actions.hasSave() ? contItem : newItem);
      }
    },
    sub(on) {
      subOn = on;
      cls(el, 'sub', on);
      if (!on && shown) nav.open(scope);
    },
    update(dt) {
      t += dt;
      if (!shown) return;
      // a save can appear while the title is up (another tab, a late load): check now and then
      if (t - saveAt > 2) {
        saveAt = t;
        refreshSave();
      }
    },
  };
  return api;
}
