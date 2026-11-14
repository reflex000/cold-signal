// The interface: createUI(game) builds every screen once under #ui and keeps them in step with
// view.mode. All input the UI owns (menus: keyboard, mouse, pad, touch; the on-screen touch
// controls in play) goes out through game.actions and game.touch, never into game state.
import type { Mode } from '../game/view';
import type { HurtCause } from '../sim/types';
import type { UiApi, UiGame } from './api';
import { CSS } from './css';
import { type Ctx, cls, h, on } from './dom';
import { createEnd, type EndKind } from './end';
import { createHud } from './hud';
import { icon } from './icons';
import { createInventory } from './inventory';
import { createMenu } from './menu';
import { createNav } from './nav';
import { createOpening } from './opening';
import { createLoading, createTitle } from './title';
import { createTouch } from './touch';

export type { UiApi, UiGame } from './api';

/** Modes in which a UI screen is up and owns the pointer, the menu keys and the pad. */
const UI_MODES: readonly Mode[] = ['title', 'pause', 'inventory', 'dead', 'won'];

export function createUI(game: UiGame): UiApi {
  const view = game.view;
  let host = document.getElementById('ui');
  if (!host) {
    host = document.createElement('div');
    host.id = 'ui';
    document.body.appendChild(host);
  }
  const style = document.createElement('style');
  style.dataset.owner = 'cold-signal-ui';
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = h('div', 'cs' + (view.touch ? ' touch' : ''), host);
  const ctx: Ctx = {
    game,
    view,
    root,
    touch: view.touch,
    device: view.touch ? 'touch' : 'kbm',
    sfx: (name) => game.sfx?.(name),
    disposers: [],
  };
  const nav = createNav(ctx);
  const hud = createHud(ctx);
  const touch = view.touch ? createTouch(ctx) : null;
  const menu = createMenu(ctx, nav);
  const title = createTitle(ctx, nav, menu);
  menu.onClose = () => title.sub(false);
  const inv = createInventory(ctx, nav);
  const end = createEnd(ctx, nav);
  const loading = createLoading(ctx);
  const opening = createOpening(ctx);
  // the world not drawn yet (the shaders still compiling behind the title at boot): a dark veil over
  // the scene and the HUD, under the title and the opening, that thins away once it is drawn
  const veil = h('div', 'veil', root);
  let veiled = false;
  const syncVeil = (): void => {
    const v = view.drawn === false;
    if (v !== veiled) cls(veil, 'on', (veiled = v));
  };
  const rot = h('div', 'rot', root);
  icon('rotate', '', rot);
  h('b', '', rot, 'Rotate your phone');
  h('span', '', rot, 'Cold Signal is played in landscape.');
  // paint order, bottom to top
  for (const e of [hud.el, touch?.el, veil, title.el, opening.el, menu.el, inv.el, end.el, loading.el, rot]) if (e) root.appendChild(e);

  // ---------------------------------------------------------------- modes
  let mode: Mode | '' = '';
  let modeAt = 0;
  let lastCause: HurtCause | null = null;

  function causeOfDeath(): HurtCause | 'unknown' {
    const me = view.me;
    if (lastCause) return lastCause;
    if (me?.swim) return 'water';
    if (me && me.core <= 31) return 'cold';
    return 'unknown';
  }

  /** The end card for a mode: a co-op game that is lost shows in mode 'dead' (Mode has no 'lost'). */
  function endKind(m: Mode | ''): EndKind | null {
    if (m === 'dead') return view.objective.stage === 'lost' ? 'lost' : 'dead';
    return m === 'won' ? 'won' : null;
  }

  function applyMode(m: Mode): void {
    if (m === mode) return;
    const prev = mode;
    mode = m;
    modeAt = performance.now();
    syncVeil(); // (before the loading screen starts to go)
    if (m === 'play' || m === 'boot' || m === 'photo') nav.open(null);
    loading.show(m === 'boot');
    hud.show(m === 'play' && !opening.active());
    touch?.show(m === 'play' && !opening.active());
    inv.show(m === 'inventory');
    end.show(endKind(m), causeOfDeath());
    title.show(m === 'title');
    if (m === 'pause') menu.open('pause');
    else if (menu.isOpen() && (prev === 'pause' || m !== 'title')) menu.close();
    if (m === 'play' || m === 'title') lastCause = null;
    root.classList.toggle('photo', m === 'photo');
  }

  // ---------------------------------------------------------------- bus
  const bus = view.bus;
  ctx.disposers.push(
    bus.on('mode', (e) => applyMode(e.to)),
    bus.on('loading', (e) => loading.set(e.progress, e.label)),
    bus.on('toast', (e) => hud.toast(e)),
    bus.on('place', (e) => hud.place(e)),
    bus.on('sim', (e) => {
      if (e.t === 'hurt' && e.id === view.myId) lastCause = e.cause;
      hud.sim(e);
    }),
  );

  // ---------------------------------------------------------------- keyboard and device
  const owns = () => UI_MODES.includes(mode as Mode);
  on(
    ctx,
    window,
    'keydown',
    (e: KeyboardEvent) => {
      if (!owns() || !nav.scope) return;
      // the key that opened this screen (handled by the game first) must not also act in it
      if (e.timeStamp < modeAt) return;
      if (nav.key(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  on(
    ctx,
    window,
    'keyup',
    (e: KeyboardEvent) => {
      if (owns() && (e.code === 'Space' || e.code === 'Enter' || e.code === 'Tab')) e.preventDefault();
    },
    true,
  );
  on(ctx, window, 'pointerdown', (e: PointerEvent) => {
    ctx.device = e.pointerType === 'touch' ? 'touch' : e.pointerType === 'mouse' && !view.touch ? 'kbm' : ctx.device;
  }, true);
  // clicks never leave focus on a button (Enter would fire it a second time)
  on(ctx, root, 'mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest?.('button')) e.preventDefault();
  });

  applyMode(view.mode);

  return {
    update(dt) {
      if (view.mode !== mode) applyMode(view.mode);
      syncVeil();
      // the opening of a new game covers the screen; the HUD and the touch controls come up after it
      const wasOpening = opening.active();
      opening.update();
      if (wasOpening !== opening.active() && mode === 'play') {
        hud.show(!opening.active());
        touch?.show(!opening.active());
      }
      // the game can be lost while the death card is up (the last teammate dies): swap the card
      if (mode === 'dead') end.show(endKind(mode), causeOfDeath());
      nav.update(dt);
      hud.update(dt);
      touch?.update(dt);
      title.update(dt);
      menu.update(dt);
      inv.update(dt);
    },
    wantsPointer() {
      return owns();
    },
    dispose() {
      nav.open(null);
      touch?.release();
      for (const d of ctx.disposers.splice(0)) d();
      root.remove();
      style.remove();
    },
  };
}
