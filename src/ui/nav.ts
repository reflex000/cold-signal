// Menu navigation shared by every screen: one selected item per scope, moved with the arrow
// keys / WASD, the d-pad or left stick, the mouse, or a tap. Movement is spatial (nearest item
// in the pressed direction), so a screen only has to list what can be selected.
import type { Ctx } from './dom';

export interface NavItem {
  el: HTMLElement;
  /** Enter / A / click. */
  act?: () => void;
  /** Enter / A only (a click or tap just selects). Wins over `act` for the keyboard and the pad. */
  actKey?: () => void;
  /** The mouse passing over does not select it (grids, where hovering on the way past must not change what is shown). */
  noHover?: boolean;
  /** Up / down scroll this element while it can still scroll that way, before the selection moves on. */
  scroll?: HTMLElement;
  /** Left / right on a value row. When present, left and right change the value instead of moving. */
  adjust?: (dir: -1 | 1) => void;
  onSel?: () => void;
  id?: string;
}

export interface Scope {
  items: NavItem[];
  sel: NavItem | null;
  /** Esc / B. */
  back?: () => void;
  /** Extra keys of a screen. Return true when the key was used. */
  key?: (e: KeyboardEvent) => boolean;
  /** Extra gamepad buttons of a screen. */
  pad?: (b: 'lb' | 'rb' | 'x' | 'y') => void;
}

export interface Nav {
  scope: Scope | null;
  open(scope: Scope | null, select?: NavItem | null): void;
  bind(scope: Scope, item: NavItem): NavItem;
  select(item: NavItem | null, quiet?: boolean): void;
  key(e: KeyboardEvent): boolean;
  update(dt: number): void;
}

const usable = (it: NavItem) => it.el.isConnected && it.el.offsetParent !== null && !it.el.classList.contains('no');

export function createNav(ctx: Ctx): Nav {
  // gamepad edge detection and key repeat for the directions
  const held = { u: false, d: false, l: false, r: false, a: false, b: false, lb: false, rb: false, x: false, y: false };
  type PadKey = keyof typeof held;
  const repeat: Record<string, number> = { u: 0, d: 0, l: 0, r: 0 };
  let swallow = true; // ignore buttons already down when a screen opens

  const nav: Nav = {
    scope: null,

    open(scope, select) {
      if (nav.scope === scope && !select) return;
      // only the scope in use shows its selection; the other keeps it for when focus returns
      if (nav.scope && nav.scope !== scope && nav.scope.sel) nav.scope.sel.el.classList.remove('sel');
      nav.scope = scope;
      swallow = true;
      if (!scope) return;
      const want = select ?? (scope.sel && usable(scope.sel) ? scope.sel : scope.items.find(usable)) ?? null;
      nav.select(want, true);
    },

    bind(scope, item) {
      scope.items.push(item);
      // Selection is ours, not the browser's: a focused button would also fire on Enter / Space.
      item.el.tabIndex = -1;
      item.el.addEventListener('pointerenter', (e) => {
        if ((e as PointerEvent).pointerType !== 'mouse' || nav.scope !== scope || item.noHover) return;
        ctx.device = 'kbm';
        if (scope.sel !== item && usable(item)) nav.select(item);
      });
      item.el.addEventListener('click', (e) => {
        if (nav.scope !== scope || !usable(item)) return;
        e.stopPropagation();
        if (scope.sel !== item) nav.select(item, true);
        if (item.act) {
          ctx.sfx('ui_click');
          item.act();
        }
      });
      return item;
    },

    select(item, quiet) {
      const scope = nav.scope;
      if (!scope) return;
      if (scope.sel === item) {
        if (item) item.el.classList.add('sel');
        return;
      }
      if (scope.sel) scope.sel.el.classList.remove('sel');
      scope.sel = item;
      if (!item) return;
      item.el.classList.add('sel');
      if (!quiet) ctx.sfx('ui_hover');
      item.onSel?.();
      if (typeof item.el.scrollIntoView === 'function') item.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    },

    key(e) {
      const scope = nav.scope;
      if (!scope || e.altKey || e.ctrlKey || e.metaKey) return false;
      ctx.device = 'kbm';
      if (scope.key && scope.key(e)) return true;
      switch (e.code) {
        case 'ArrowUp': case 'KeyW': move(0, -1); return true;
        case 'ArrowDown': case 'KeyS': move(0, 1); return true;
        case 'ArrowLeft': case 'KeyA': move(-1, 0); return true;
        case 'ArrowRight': case 'KeyD': move(1, 0); return true;
        case 'Enter': case 'NumpadEnter': case 'Space':
          if (!e.repeat) activate();
          return true;
        case 'Escape': case 'Backspace':
          if (!e.repeat) back();
          return true;
      }
      return false;
    },

    update(dt) {
      const scope = nav.scope;
      if (!scope || typeof navigator.getGamepads !== 'function') return;
      let u = false, d = false, l = false, r = false, a = false, b = false, lb = false, rb = false, x = false, y = false;
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (!p || !p.connected) continue;
        const B = p.buttons;
        const on = (n: number) => !!B[n] && B[n].pressed;
        const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
        u = u || on(12) || ay < -0.6;
        d = d || on(13) || ay > 0.6;
        l = l || on(14) || ax < -0.6;
        r = r || on(15) || ax > 0.6;
        a = a || on(0); b = b || on(1); x = x || on(2); y = y || on(3);
        lb = lb || on(4); rb = rb || on(5);
      }
      const now = { u, d, l, r, a, b, lb, rb, x, y };
      if (swallow) {
        // Wait until everything is released, so the press that opened this screen does nothing.
        let any = false;
        for (const k in now) {
          held[k as PadKey] = now[k as PadKey];
          any = any || now[k as PadKey];
        }
        if (!any) swallow = false;
        return;
      }
      const edge = (k: PadKey) => {
        const was = held[k];
        held[k] = now[k];
        return now[k] && !was;
      };
      const dir = (k: 'u' | 'd' | 'l' | 'r') => {
        if (!now[k]) {
          held[k] = false;
          repeat[k] = 0;
          return false;
        }
        if (!held[k]) {
          held[k] = true;
          repeat[k] = 0.38;
          return true;
        }
        repeat[k] -= dt;
        if (repeat[k] <= 0) {
          repeat[k] = 0.11;
          return true;
        }
        return false;
      };
      const mu = dir('u'), md = dir('d'), ml = dir('l'), mr = dir('r');
      const pa = edge('a'), pb = edge('b'), plb = edge('lb'), prb = edge('rb'), px = edge('x'), py = edge('y');
      if (mu || md || ml || mr || pa || pb || plb || prb || px || py) ctx.device = 'pad';
      if (mu) move(0, -1);
      else if (md) move(0, 1);
      else if (ml) move(-1, 0);
      else if (mr) move(1, 0);
      if (pa) activate();
      else if (pb) back();
      else if (scope.pad) {
        if (plb) scope.pad('lb');
        else if (prb) scope.pad('rb');
        else if (px) scope.pad('x');
        else if (py) scope.pad('y');
      }
    },
  };

  function activate(): void {
    const it = nav.scope?.sel;
    if (!it || !usable(it)) return;
    const fn = it.actKey ?? it.act;
    if (!fn) return;
    ctx.sfx('ui_click');
    fn();
  }

  function back(): void {
    const scope = nav.scope;
    if (!scope || !scope.back) return;
    ctx.sfx('ui_close');
    scope.back();
  }

  function move(dx: number, dy: number): void {
    const scope = nav.scope;
    if (!scope) return;
    const cur = scope.sel && usable(scope.sel) ? scope.sel : null;
    if (!cur) {
      nav.select(scope.items.find(usable) ?? null);
      return;
    }
    if (dx !== 0 && cur.adjust) {
      cur.adjust(dx as -1 | 1);
      return;
    }
    if (dy !== 0 && cur.scroll) {
      const sc = cur.scroll;
      const room = dy > 0 ? sc.scrollHeight - sc.clientHeight - sc.scrollTop : sc.scrollTop;
      if (room > 1) {
        sc.scrollTop += dy * Math.max(40, sc.clientHeight * 0.22);
        return;
      }
    }
    const c = cur.el.getBoundingClientRect();
    let best: NavItem | null = null;
    let bestScore = Infinity;
    for (const it of scope.items) {
      if (it === cur || !usable(it)) continue;
      const r = it.el.getBoundingClientRect();
      let primary: number, gap: number, across: number;
      if (dx !== 0) {
        primary = dx > 0 ? r.left - c.right : c.left - r.right;
        if ((dx > 0 ? r.left + r.width / 2 - (c.left + c.width / 2) : c.left + c.width / 2 - (r.left + r.width / 2)) < 2) continue;
        gap = Math.max(0, r.top - c.bottom, c.top - r.bottom);
        across = Math.abs(r.top + r.height / 2 - (c.top + c.height / 2));
      } else {
        primary = dy > 0 ? r.top - c.bottom : c.top - r.bottom;
        if ((dy > 0 ? r.top + r.height / 2 - (c.top + c.height / 2) : c.top + c.height / 2 - (r.top + r.height / 2)) < 2) continue;
        gap = Math.max(0, r.left - c.right, c.left - r.right);
        across = Math.abs(r.left + r.width / 2 - (c.left + c.width / 2));
      }
      // Items that overlap on the cross axis win; among those, the nearest.
      const score = Math.max(0, primary) + gap * 4 + across * 0.05 + (gap > 0 ? 400 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    if (best) nav.select(best);
  }

  return nav;
}
