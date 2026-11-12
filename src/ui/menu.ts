// The overlay over a dimmed scene: pause (with a short status page), settings, the controls
// reference, how to play and the credits. A column of words on the left, the page on the right.
// Two navigation scopes: the column, and the rows of the open page (Enter / right goes in,
// Esc / B comes back out), so left and right can change a value on a settings row.
import type { Settings } from '../game/view';
import { type Ctx, clamp, cls, fmtHour, fmtSpan, fmtTemp, h, on, sty, txt } from './dom';
import type { Nav, NavItem, Scope } from './nav';
import { CONTROLS, CREDITS, HOWTO, ITEM, PART_ORDER } from './text';

export type MenuFrom = 'pause' | 'title';
export type PageId = 'status' | 'settings' | 'controls' | 'how' | 'credits';

export interface MenuApi {
  el: HTMLElement;
  open(from: MenuFrom, page?: PageId): void;
  close(): void;
  isOpen(): boolean;
  /** Called when the overlay that was opened from the title is closed (title shows again). */
  onClose?: () => void;
  update(dt: number): void;
}

type RowDef =
  | { k: keyof Settings; label: string; kind: 'opt'; opts: [Settings[keyof Settings], string][] }
  | { k: keyof Settings; label: string; kind: 'bool' }
  | { k: keyof Settings; label: string; kind: 'slider'; min: number; max: number; step: number; fmt: (v: number) => string };

const pct = (v: number) => String(Math.round(v * 100));
const GROUPS: { h: string; rows: RowDef[] }[] = [
  {
    h: 'Picture',
    rows: [
      { k: 'quality', label: 'Quality', kind: 'opt', opts: [['auto', 'Auto'], ['mobile', 'Mobile'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']] },
      { k: 'renderScale', label: 'Render scale', kind: 'slider', min: 0.5, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + '%' },
      { k: 'fov', label: 'Field of view', kind: 'slider', min: 60, max: 100, step: 1, fmt: (v) => Math.round(v) + '°' },
      { k: 'grain', label: 'Film grain', kind: 'bool' },
      { k: 'shake', label: 'Camera shake', kind: 'bool' },
      { k: 'showFps', label: 'Show FPS', kind: 'bool' },
    ],
  },
  {
    h: 'Controls',
    rows: [
      { k: 'sensitivity', label: 'Look speed', kind: 'slider', min: 0.2, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) },
      { k: 'invertY', label: 'Invert look', kind: 'bool' },
    ],
  },
  {
    h: 'Sound',
    rows: [
      { k: 'master', label: 'Master', kind: 'slider', min: 0, max: 1, step: 0.05, fmt: pct },
      { k: 'music', label: 'Music', kind: 'slider', min: 0, max: 1, step: 0.05, fmt: pct },
      { k: 'sfx', label: 'Effects', kind: 'slider', min: 0, max: 1, step: 0.05, fmt: pct },
    ],
  },
  {
    h: 'Game',
    rows: [
      { k: 'hints', label: 'Hints', kind: 'bool' },
      { k: 'bots', label: 'Companions', kind: 'opt', opts: [[0, 'None'], [1, 'One'], [2, 'Two'], [3, 'Three']] },
    ],
  },
];

interface Row {
  def: RowDef;
  item: NavItem;
  ops: HTMLElement[];
  slider?: HTMLElement;
  val?: HTMLElement;
  last: unknown;
}

export function createMenu(ctx: Ctx, nav: Nav): MenuApi {
  const { game, view } = ctx;
  const el = h('div', 'scr ov', ctx.root);
  h('div', 'ov-shade', el);
  const side = h('div', 'ov-nav', el);
  const ttl = h('h2', 'ov-ttl', side);
  h('div', 'ov-rule', side);
  const pageBox = h('div', 'ov-page', el);

  const navScope: Scope = { items: [], sel: null, back: () => backOut() };
  const pageScope: Scope = { items: [], sel: null, back: () => nav.open(navScope) };
  let from: MenuFrom = 'pause';
  let open = false;
  let page: PageId = 'status';
  let quitAsk = false;

  // ---------------------------------------------------------------- the column
  const ni = (label: string, id: string, act: () => void, pageId?: PageId, gap = false): NavItem => {
    const b = h('button', 'ni' + (gap ? ' gap' : ''), side, label);
    b.dataset.id = id;
    return nav.bind(navScope, { el: b, id, act, onSel: () => { resetQuit(); if (pageId) show(pageId); else if (from === 'pause') show('status'); } });
  };
  const resumeItem = ni('Resume', 'resume', () => game.actions.resume());
  const settingsItem = ni('Settings', 'settings', () => enter('settings'), 'settings');
  const controlsItem = ni('Controls', 'controls', () => enter('controls'), 'controls');
  const howItem = ni('How to play', 'how', () => enter('how'), 'how');
  const creditsItem = ni('Credits', 'credits', () => enter('credits'), 'credits');
  const quitItem = ni('Quit to title', 'quit', () => {
    if (!quitAsk) {
      quitAsk = true;
      txt(quitItem.el, ctx.device === 'touch' ? 'Tap again to quit' : 'Press again to quit');
      cls(quitItem.el, 'ask', true);
      return;
    }
    resetQuit();
    game.actions.quitToTitle();
  }, undefined, true);
  const backItem = ni('Back', 'back', () => backOut(), undefined, true);
  const itemOf: Record<PageId, NavItem | null> = { status: resumeItem, settings: settingsItem, controls: controlsItem, how: howItem, credits: creditsItem };

  function resetQuit(): void {
    if (!quitAsk) return;
    quitAsk = false;
    txt(quitItem.el, 'Quit to title');
    cls(quitItem.el, 'ask', false);
  }

  function backOut(): void {
    if (from === 'pause') game.actions.resume();
    else close();
  }

  // ---------------------------------------------------------------- pages
  const pages = {} as Record<PageId, HTMLElement>;
  for (const id of ['status', 'settings', 'controls', 'how', 'credits'] as PageId[]) pages[id] = h('div', 'pg', pageBox);

  // status (pause only): where the run stands
  const st = pages.status;
  h('div', 'sg', st, 'Now');
  const stObj = h('p', 'pg-big', st);
  h('div', 'sg', st, 'Radio parts');
  const stParts = h('div', 'pg-parts', st);
  const partRows = PART_ORDER.map((p) => {
    const r = h('div', 'pp', stParts);
    h('span', '', r, ITEM[`part_${p}`].name);
    return { r, s: h('b', '', r) };
  });
  h('div', 'sg', st, 'On the mountain');
  const stTime = h('p', 'pg-line', st);
  const stWeather = h('p', 'pg-line', st);

  // settings
  const rows: Row[] = [];
  const sp = pages.settings;
  for (const g of GROUPS) {
    h('div', 'sg', sp, g.h);
    for (const def of g.rows) rows.push(buildRow(sp, def));
  }
  const gpu = h('div', 'gp', sp);
  txt(gpu, (game.gpu.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2') + '   ' + (game.gpu.adapter || 'unknown adapter'));

  function buildRow(parent: HTMLElement, def: RowDef): Row {
    const r = h('div', 'sr', parent);
    r.dataset.id = def.k;
    h('div', 'sr-l', r, def.label);
    const c = h('div', 'sr-c', r);
    const row: Row = { def, item: null as unknown as NavItem, ops: [], last: undefined };
    const set = (v: unknown) => game.actions.setSetting(def.k, v as never);
    if (def.kind === 'opt' || def.kind === 'bool') {
      const opts: [unknown, string][] = def.kind === 'bool' ? [[false, 'Off'], [true, 'On']] : def.opts;
      for (const [v, label] of opts) {
        const o = h('button', 'op', c, label);
        o.addEventListener('click', (e) => {
          if (nav.scope !== pageScope) nav.open(pageScope, row.item);
          e.stopPropagation();
          nav.select(row.item, true);
          if (view.settings[def.k] !== v) {
            ctx.sfx('ui_click');
            set(v);
          }
        });
        row.ops.push(o);
      }
      const step = (dir: -1 | 1, wrap: boolean) => {
        const cur = opts.findIndex(([v]) => v === view.settings[def.k]);
        let i = cur + dir;
        if (wrap) i = (i + opts.length) % opts.length;
        i = clamp(i, 0, opts.length - 1);
        if (i !== cur) {
          ctx.sfx('ui_hover');
          set(opts[i][0]);
        }
      };
      row.item = nav.bind(pageScope, { el: r, id: def.k, adjust: (d) => step(d, false), actKey: () => step(1, true) });
    } else {
      const sl = h('div', 'sl', c);
      h('div', 'sl-f', sl);
      h('div', 'sl-h', sl);
      row.slider = sl;
      row.val = h('div', 'sr-v', c);
      const snap = (v: number) => clamp(Math.round((v - def.min) / def.step) * def.step + def.min, def.min, def.max);
      const fromX = (x: number) => {
        const b = sl.getBoundingClientRect();
        return snap(def.min + ((x - b.left) / Math.max(1, b.width)) * (def.max - def.min));
      };
      let dragId = -1;
      sl.addEventListener('pointerdown', (e) => {
        if (nav.scope !== pageScope) nav.open(pageScope, row.item);
        nav.select(row.item, true);
        dragId = e.pointerId;
        sl.setPointerCapture(e.pointerId);
        const v = fromX(e.clientX);
        if (v !== view.settings[def.k]) set(v);
        e.preventDefault();
      });
      sl.addEventListener('pointermove', (e) => {
        if (e.pointerId !== dragId) return;
        const v = fromX(e.clientX);
        if (v !== view.settings[def.k]) set(v);
      });
      const end = (e: PointerEvent) => {
        if (e.pointerId === dragId) {
          dragId = -1;
          ctx.sfx('ui_click');
        }
      };
      sl.addEventListener('pointerup', end);
      sl.addEventListener('pointercancel', end);
      row.item = nav.bind(pageScope, {
        el: r,
        id: def.k,
        adjust: (d) => {
          const big = def.step < (def.max - def.min) / 30 ? (def.max - def.min) / 20 : def.step;
          const v = snap((view.settings[def.k] as number) + d * big);
          if (v !== view.settings[def.k]) {
            ctx.sfx('ui_hover');
            set(v);
          }
        },
      });
    }
    return row;
  }

  function syncRows(): void {
    const s = view.settings;
    for (const row of rows) {
      const v = s[row.def.k];
      if (v === row.last) continue;
      row.last = v;
      const d = row.def;
      if (d.kind === 'opt') row.ops.forEach((o, i) => cls(o, 'on', d.opts[i][0] === v));
      else if (d.kind === 'bool') row.ops.forEach((o, i) => cls(o, 'on', (i === 1) === !!v));
      else if (row.slider && row.val) {
        const p = ((Number(v) - d.min) / (d.max - d.min)) * 100;
        sty(row.slider, '--p', clamp(p, 0, 100).toFixed(1) + '%');
        txt(row.val, d.fmt(Number(v)));
      }
    }
  }

  // controls: the current device's column first
  const cp = pages.controls;
  const cols = h('div', 'cols', cp);
  const colEls: Record<'kbm' | 'pad' | 'touch', HTMLElement> = { kbm: h('div', 'col'), pad: h('div', 'col'), touch: h('div', 'col') };
  const colName = { kbm: 'Keyboard and mouse', pad: 'Gamepad', touch: 'Touch' };
  for (const k of ['kbm', 'pad', 'touch'] as const) {
    const c = colEls[k];
    h('h2', '', c, colName[k]);
    for (const line of CONTROLS[k]) {
      const r = h('div', 'kr', c);
      h('b', '', r, line.k);
      h('span', '', r, line.a);
    }
  }
  let colOrder = '';
  function orderCols(): void {
    const order = ctx.device === 'touch' ? ['touch', 'kbm', 'pad'] : ctx.device === 'pad' ? ['pad', 'kbm', 'touch'] : ['kbm', 'pad', 'touch'];
    const key = order.join();
    if (key === colOrder) return;
    colOrder = key;
    for (const k of order) cols.appendChild(colEls[k as 'kbm']);
  }

  // how to play, credits
  const how = h('div', 'how', pages.how);
  for (const s of HOWTO) {
    const sec = h('section', '', how);
    h('h2', '', sec, s.h);
    h('p', '', sec, s.p);
  }
  const cr = h('div', 'how', pages.credits);
  for (const s of CREDITS) {
    const sec = h('section', '', cr);
    h('h2', '', sec, s.h);
    h('p', '', sec, s.p);
  }

  // text pages are one scrollable item, so up / down scroll them with keys and the pad
  const textItem: Record<string, NavItem> = {};
  for (const id of ['status', 'controls', 'how', 'credits'] as PageId[]) {
    textItem[id] = nav.bind(pageScope, { el: pages[id], id: 'page-' + id, scroll: pageBox });
  }

  // the mouse moving over a side picks the scope it belongs to (the rows' own hover then selects)
  on(ctx, pageBox, 'pointerenter', (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && open && nav.scope === navScope && page === 'settings') nav.open(pageScope, pageScope.sel ?? rows[0].item);
  });
  on(ctx, pageBox, 'pointerdown', () => {
    if (open && nav.scope === navScope && page === 'settings') nav.open(pageScope, pageScope.sel ?? rows[0].item);
  });
  on(ctx, side, 'pointerenter', (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && open && nav.scope === pageScope) nav.open(navScope, navScope.sel);
  });

  function show(id: PageId): void {
    if (page === id && pages[id].classList.contains('on')) return;
    page = id;
    for (const k in pages) cls(pages[k as PageId], 'on', k === id);
    pageBox.scrollTop = 0;
    if (id === 'controls') orderCols();
    for (const k in itemOf) {
      const it = itemOf[k as PageId];
      if (it) cls(it.el, 'cur', k === id && k !== 'status');
    }
    syncPage();
  }

  function enter(id: PageId): void {
    show(id);
    if (id === 'settings') nav.open(pageScope, pageScope.sel && rows.some((r) => r.item === pageScope.sel) ? pageScope.sel : rows[0].item);
    else nav.open(pageScope, textItem[id]);
  }

  function syncPage(): void {
    if (page === 'settings') syncRows();
    else if (page === 'status') syncStatus();
  }

  let statusAt = -1;
  function syncStatus(): void {
    const o = view.objective;
    txt(stObj, view.hud.objective || 'Stay warm.');
    PART_ORDER.forEach((p, i) => {
      const s = o.parts[p];
      txt(partRows[i].s, s === 'installed' ? 'Installed' : s === 'held' ? 'Carried' : 'Not found');
      cls(partRows[i].r, 'held', s === 'held');
      cls(partRows[i].r, 'inst', s === 'installed');
    });
    const env = view.env;
    txt(stTime, `Day ${env.day + 1}, ${fmtHour(env.clock)}.   ${fmtSpan(env.t)} since the crash.`);
    const sky = env.storm > 0.82 ? 'Whiteout' : env.storm > 0.55 ? 'Storm' : env.storm > 0.3 || env.snowfall > 0.35 ? 'Snowing' : env.cloud > 0.6 ? 'Overcast' : 'Clear';
    const wind = Math.hypot(env.windX, env.windZ);
    txt(stWeather, `${sky}, wind ${Math.round(wind * 3.6)} km/h, air ${fmtTemp(env.airTemp, 0)}°.`);
  }

  function open_(f: MenuFrom, p?: PageId): void {
    from = f;
    open = true;
    resetQuit();
    cls(el, 'on', true);
    cls(el, 'from-title', f === 'title');
    txt(ttl, f === 'pause' ? 'Paused' : 'Cold Signal');
    resumeItem.el.style.display = f === 'pause' ? '' : 'none';
    quitItem.el.style.display = f === 'pause' ? '' : 'none';
    backItem.el.style.display = f === 'title' ? '' : 'none';
    creditsItem.el.style.display = f === 'title' ? '' : 'none';
    const want = p ?? (f === 'pause' ? 'status' : 'settings');
    show(want);
    for (const r of rows) r.last = undefined;
    syncPage();
    nav.open(navScope, itemOf[want] ?? resumeItem);
    // from the title, a page asked for by name opens ready to use
    if (f === 'title' && p) enter(p);
    ctx.sfx('ui_open');
  }

  function close(): void {
    if (!open) return;
    open = false;
    cls(el, 'on', false);
    if (nav.scope === navScope || nav.scope === pageScope) nav.open(null);
    api.onClose?.();
  }

  const api: MenuApi = {
    el,
    open: open_,
    close,
    isOpen: () => open,
    update(dt) {
      if (!open) return;
      if (page === 'settings') syncRows();
      else if (page === 'status') {
        statusAt -= dt;
        if (statusAt <= 0) {
          statusAt = 1;
          syncStatus();
        }
      } else if (page === 'controls') orderCols();
    },
  };
  return api;
}
