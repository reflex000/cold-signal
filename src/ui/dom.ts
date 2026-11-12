// Small DOM helpers. Every setter here remembers the last value it wrote on the element, so the
// per-frame update can call them freely: the DOM is touched only when a value changed.
import type { View } from '../game/view';
import type { UiGame } from './api';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export type UiSound = 'ui_hover' | 'ui_click' | 'ui_open' | 'ui_close';

/** What every part of the interface is handed. */
export interface Ctx {
  game: UiGame;
  view: View;
  root: HTMLElement;
  touch: boolean;
  /** What the player used last; decides which key legends are shown. */
  device: 'kbm' | 'pad' | 'touch';
  /** Interface sound, if the shell wired one (UiGame.sfx is optional). */
  sfx(name: UiSound): void;
  /** Window-level listeners and subscriptions to undo on dispose. */
  disposers: (() => void)[];
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: Node | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function svgEl(inner: string, cls = '', viewBox = '0 0 24 24', parent?: Node | null): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  s.innerHTML = inner;
  if (parent) parent.appendChild(s);
  return s;
}

type Cache = Record<string, string | boolean>;
function cache(e: Element): Cache {
  const a = e as unknown as { _c?: Cache };
  return a._c ?? (a._c = {});
}

export function txt(e: Element, v: string): void {
  const c = cache(e);
  if (c.t !== v) {
    c.t = v;
    e.textContent = v;
  }
}

export function cls(e: Element, name: string, on: boolean): void {
  const c = cache(e);
  const k = '.' + name;
  if (c[k] !== on) {
    c[k] = on;
    e.classList.toggle(name, on);
  }
}

export function sty(e: HTMLElement | SVGElement, prop: string, v: string): void {
  const c = cache(e);
  const k = ':' + prop;
  if (c[k] !== v) {
    c[k] = v;
    e.style.setProperty(prop, v);
  }
}

export function attr(e: Element, name: string, v: string): void {
  const c = cache(e);
  const k = '@' + name;
  if (c[k] !== v) {
    c[k] = v;
    e.setAttribute(name, v);
  }
}

/** addEventListener that is removed on dispose (for window / document / media queries). */
export function on<T extends EventTarget>(ctx: Ctx, target: T, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions | boolean): void {
  target.addEventListener(type, fn as EventListener, opts);
  ctx.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** "240 m", "1.2 km". */
export function fmtDist(m: number): string {
  if (m >= 995) return (m / 1000).toFixed(1) + ' km';
  if (m >= 100) return Math.round(m / 10) * 10 + ' m';
  return Math.max(0, Math.round(m)) + ' m';
}

/** "48 s", "12 min", "1 h 12 min". */
export function fmtSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min';
}

/** "0:42". */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Hour of day as "17:42". */
export function fmtHour(clock: number): string {
  const c = ((clock % 24) + 24) % 24;
  const hh = Math.floor(c);
  const mm = Math.floor((c - hh) * 60);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** A true minus sign: "−24", "36.4". */
export function fmtTemp(v: number, decimals = 1): string {
  const s = Math.abs(v).toFixed(decimals);
  return (v < 0 && Number(s) !== 0 ? '−' : '') + s;
}
