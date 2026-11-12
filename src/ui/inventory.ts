// The pack: tools, supplies and radio parts laid out as a grid of drawn icons, what the selected
// thing is and what can be done with it (use, load, drop, give to a teammate close by), what a
// fire needs right now, and a second page with the map.
import type { ViewEnt } from '../game/view';
import type { ItemId, PlayerEnt, ToolId } from '../sim/types';
import { type Ctx, attr, cls, fmtHour, fmtTemp, h, sty, txt } from './dom';
import { type IconName, icon } from './icons';
import { hasTool, windFelt } from './model';
import type { Nav, NavItem, Scope } from './nav';
import { ITEM, LOADS, PART_ORDER, SUPPLY_ORDER, TOOL_ORDER } from './text';

export interface InventoryApi {
  el: HTMLElement;
  show(on: boolean): void;
  update(dt: number): void;
}

const TOOLS = TOOL_ORDER as readonly ItemId[];
const PARTS = PART_ORDER.map((p) => `part_${p}` as ItemId);
const GIVE_RANGE = 4; // metres

interface Cell { id: ItemId; el: HTMLElement; n: HTMLElement; item: NavItem; cv: boolean }
interface Act { label: string; run: () => void; ok: boolean }

export function createInventory(ctx: Ctx, nav: Nav): InventoryApi {
  const { game, view } = ctx;
  const A = game.actions;
  const el = h('div', 'scr inv', ctx.root);
  h('div', 'inv-shade', el);
  const scope: Scope = {
    items: [],
    sel: null,
    back: () => A.closeInventory(),
    key: (e) => {
      if (e.code === 'Tab' || e.code === 'KeyI') {
        if (!e.repeat) {
          ctx.sfx('ui_close');
          A.closeInventory();
        }
        return true;
      }
      if (e.code === 'KeyQ' || e.code === 'KeyE') {
        tab(e.code === 'KeyQ' ? 'pack' : 'map');
        return true;
      }
      if (tabOn === 'pack' && e.code === 'KeyX') {
        quick('drop');
        return true;
      }
      if (tabOn === 'pack' && e.code === 'KeyG') {
        quick('give');
        return true;
      }
      return false;
    },
    pad: (b) => {
      if (b === 'lb') tab('pack');
      else if (b === 'rb') tab('map');
      else if (b === 'x' && tabOn === 'pack') quick('drop');
      else if (b === 'y' && tabOn === 'pack') quick('give');
    },
  };

  // ---------------------------------------------------------------- top bar
  const top = h('div', 'inv-top', el);
  const tabPack = h('button', 'mi cur', top, 'Pack');
  tabPack.dataset.id = 'pack';
  const tabMap = h('button', 'mi', top, 'Map');
  tabMap.dataset.id = 'map';
  nav.bind(scope, { el: tabPack, id: 'pack', act: () => tab('pack') });
  nav.bind(scope, { el: tabMap, id: 'map', act: () => tab('map') });
  const stats = h('div', 'inv-st', top);
  const stat = (label: string) => {
    const s = h('span', '', stats);
    const b = h('b', '', s, label);
    return { s, b, v: h('span', 'num', s) };
  };
  const stCore = stat('Core');
  const stWet = stat('Wet');
  const stDay = stat('Day');
  const close = h('button', 'inv-x', top);
  close.dataset.id = 'close';
  close.setAttribute('aria-label', 'Close');
  icon('close', '', close);
  nav.bind(scope, { el: close, id: 'close', act: () => A.closeInventory() });

  // ---------------------------------------------------------------- pack page
  const body = h('div', 'inv-body on', el);
  const left = h('div', 'inv-l', body);
  const cells = new Map<ItemId, Cell>();
  const grid = (title: string, ids: readonly ItemId[], keys: boolean) => {
    h('div', 'inv-h', left, title);
    const g = h('div', 'grid', left);
    ids.forEach((id, i) => {
      const c = h('div', 'cell none', g);
      c.dataset.id = id;
      icon(id as IconName, '', c);
      if (keys) h('span', 'k', c, String(i + 1));
      const n = h('span', 'n num', c);
      const cell: Cell = { id, el: c, n, cv: false, item: null as unknown as NavItem };
      cell.item = nav.bind(scope, { el: c, id, noHover: true, act: () => {}, actKey: () => primary(), onSel: () => pick(id) });
      cells.set(id, cell);
    });
  };
  grid('Tools', TOOLS, true);
  grid('Supplies', SUPPLY_ORDER, false);
  grid('Radio parts', PARTS, false);

  const right = h('div', 'inv-r', body);
  const det = h('div', 'inv-d', right);
  const dName = h('div', 'inv-dn', det);
  const dCount = h('div', 'inv-dc num', det);
  const dDesc = h('div', 'inv-dd', det);
  const dActs = h('div', 'inv-a', det);
  let actItems: NavItem[] = [];
  let acts: Act[] = [];
  let actKey = '';
  let sel: ItemId = 'axe';

  const fire = h('div', 'inv-f', right);
  h('h2', '', fire, 'Fire');
  const frow = (ic: IconName, label: string) => {
    const r = h('div', 'fr', fire);
    icon(ic, '', r);
    h('span', '', r, label);
    return { r, b: h('b', 'num', r) };
  };
  const fSticks = frow('stick', 'Sticks');
  const fMatch = frow('matches', 'Matches');
  const fTinder = frow('tinder', 'Tinder');
  const fShelter = frow('shelter', 'Shelter');
  const fNote = h('p', 'fnote', fire);
  const fBuild = h('button', 'ni', fire, 'Lay a campfire here');
  fBuild.dataset.id = 'build';
  nav.bind(scope, {
    el: fBuild,
    id: 'build',
    act: () => {
      const me = view.me;
      if (!me || (me.inv.stick ?? 0) < 3) return;
      A.act({ t: 'buildFire' });
      A.closeInventory();
    },
  });

  // ---------------------------------------------------------------- map page
  const mapBody = h('div', 'inv-body', el);
  const mapBox = h('div', 'map', mapBody);
  const mapSide = h('div', 'map-side', mapBody);
  h('h2', '', mapSide, 'Here');
  const mHere = h('p', '', mapSide);
  h('h2', '', mapSide, 'Next');
  const mNext = h('p', '', mapSide);
  h('h2', '', mapSide, 'Radio parts');
  const mParts = h('p', '', mapSide);
  let map: ReturnType<typeof game.map> = null;
  let mapNone: HTMLElement | null = null;
  const mapMarks = new Map<string, { el: HTMLElement; span: HTMLElement; seen: boolean; ic?: SVGSVGElement }>();
  const objAt: string[] = [];

  const leg = h('div', 'inv-leg', el);
  let legDev = '';

  let shown = false;
  let tabOn: 'pack' | 'map' = 'pack';

  // ======================================================================================
  function tab(t: 'pack' | 'map'): void {
    if (t === tabOn) return;
    tabOn = t;
    ctx.sfx('ui_hover');
    cls(tabPack, 'cur', t === 'pack');
    cls(tabMap, 'cur', t === 'map');
    cls(body, 'on', t === 'pack');
    cls(mapBody, 'on', t === 'map');
    if (t === 'map') ensureMap();
    nav.select(t === 'pack' ? cells.get(sel)!.item : scope.items.find((i) => i.el === tabMap) ?? null, true);
  }

  function ensureMap(): void {
    if (map) return;
    map = game.map();
    if (map) {
      mapNone?.remove();
      mapNone = null;
      mapBox.insertBefore(map.canvas, mapBox.firstChild);
    } else if (!mapNone) mapNone = h('div', 'map-none', mapBox, 'The map is still being drawn.');
  }

  function count(me: PlayerEnt, id: ItemId): number {
    return me.inv[id] ?? 0;
  }

  function partState(id: ItemId): 'lost' | 'held' | 'installed' {
    const p = id.slice(5) as keyof typeof view.objective.parts;
    return view.objective.parts[p] ?? 'lost';
  }

  function nearMate(me: PlayerEnt): ViewEnt<PlayerEnt> | null {
    let best: ViewEnt<PlayerEnt> | null = null;
    let bd = GIVE_RANGE;
    for (const p of view.list('player')) {
      if (p.id === view.myId || p.life !== 'alive') continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  function pick(id: ItemId): void {
    sel = id;
    actKey = '';
    renderDetail();
  }

  function actionsFor(me: PlayerEnt, id: ItemId, mate: ViewEnt<PlayerEnt> | null): Act[] {
    const n = count(me, id);
    const out: Act[] = [];
    if (n <= 0) return out;
    const give = (k: number, label: string) => {
      if (mate) out.push({ label, ok: true, run: () => A.act({ t: 'give', to: mate.id, item: id, n: k }) });
    };
    if ((TOOLS as readonly string[]).includes(id)) {
      const tool = id as ToolId;
      if (me.held === tool) out.push({ label: 'Put away', ok: true, run: () => A.equip('hands') });
      else out.push({ label: 'Take in hand', ok: true, run: () => { A.equip(tool); A.closeInventory(); } });
      const ammo = tool === 'rifle' ? 'ammo' : tool === 'flaregun' ? 'flare' : tool === 'flashlight' ? 'cell' : null;
      if (ammo && canLoad(me, tool) && count(me, ammo) > 0) out.push({ label: 'Load', ok: true, run: () => load(tool) });
      out.push({ label: 'Drop', ok: true, run: () => A.act({ t: 'drop', item: id, n: 1 }) });
      give(1, 'Give to ' + (mate?.name ?? ''));
      return out;
    }
    const tool = LOADS[id];
    if (tool) {
      const owns = hasTool(me, tool);
      out.push({ label: ITEM[id].use ?? 'Load', ok: owns && canLoad(me, tool), run: () => load(tool) });
    }
    if (id === 'bandage' || id === 'ration' || id === 'thermos') {
      const item = id;
      out.push({ label: ITEM[id].use ?? 'Use', ok: true, run: () => A.act({ t: 'consume', item }) });
    }
    const part = id.startsWith('part_');
    out.push({ label: part || n === 1 ? 'Drop' : 'Drop one', ok: true, run: () => A.act({ t: 'drop', item: id, n: 1 }) });
    if (!part && n > 1) out.push({ label: `Drop all ${n}`, ok: true, run: () => A.act({ t: 'drop', item: id, n }) });
    give(1, part || n === 1 ? 'Give to ' + (mate?.name ?? '') : 'Give one to ' + (mate?.name ?? ''));
    return out;
  }

  function canLoad(me: PlayerEnt, tool: ToolId): boolean {
    if (tool === 'rifle') return me.loaded < 5;
    if (tool === 'flaregun') return me.flareLoaded < 1;
    if (tool === 'flashlight') return me.cellCharge < 0.98;
    return false;
  }

  function load(tool: ToolId): void {
    if (view.me && view.me.held !== tool) A.equip(tool);
    A.act({ t: 'reload' });
  }

  function primary(): void {
    const a = acts.find((x) => x.ok);
    if (a) {
      ctx.sfx('ui_click');
      a.run();
    }
  }

  function quick(kind: 'drop' | 'give'): void {
    const a = acts.find((x) => x.ok && (kind === 'drop' ? x.label.startsWith('Drop') : x.label.startsWith('Give')));
    if (a) {
      ctx.sfx('ui_click');
      a.run();
    }
  }

  function countLine(me: PlayerEnt, id: ItemId, n: number): string {
    if (id.startsWith('part_')) {
      const s = partState(id);
      return s === 'installed' ? 'Installed at the tower' : n > 0 || s === 'held' ? (n > 0 ? 'In your pack' : 'Carried by a teammate') : 'Not found yet';
    }
    if (n <= 0) return 'None';
    switch (id) {
      case 'rifle': return `Loaded ${me.loaded} of 5, ${count(me, 'ammo')} ${count(me, 'ammo') === 1 ? 'round' : 'rounds'} in the pack`;
      case 'flaregun': return `${me.flareLoaded ? 'Loaded' : 'Empty'}, ${count(me, 'flare')} ${count(me, 'flare') === 1 ? 'cartridge' : 'cartridges'} in the pack`;
      case 'flashlight': return `Cell ${Math.round(me.cellCharge * 100)}%, ${me.lightOn ? 'on' : 'off'}`;
      case 'radio': return `Charge ${Math.round(me.radioCharge * 100)}%`;
      case 'axe': return me.held === 'axe' ? 'In hand' : 'Carried';
      default: return String(n);
    }
  }

  function renderDetail(): void {
    const me = view.me;
    if (!me) return;
    const n = count(me, sel);
    const mate = nearMate(me);
    acts = actionsFor(me, sel, mate);
    const key = sel + '|' + acts.map((a) => a.label + (a.ok ? '' : '-')).join('|');
    txt(dName, ITEM[sel].name);
    txt(dCount, countLine(me, sel, n));
    txt(dDesc, ITEM[sel].desc);
    if (key === actKey) return;
    actKey = key;
    // rebuild the action rows; keep the selection on the same row index when possible
    const wasIdx = actItems.findIndex((it) => it === scope.sel);
    for (const it of actItems) {
      it.el.remove();
      const i = scope.items.indexOf(it);
      if (i >= 0) scope.items.splice(i, 1);
    }
    actItems = acts.map((a, i) => {
      const b = h('button', 'ni' + (a.ok ? '' : ' no'), dActs, a.label);
      b.dataset.id = 'act' + i;
      return nav.bind(scope, { el: b, id: 'act' + i, act: () => { if (a.ok) a.run(); } });
    });
    if (wasIdx >= 0) nav.select(actItems[Math.min(wasIdx, actItems.length - 1)] ?? cells.get(sel)!.item, true);
  }

  function updateCells(me: PlayerEnt): void {
    for (const c of cells.values()) {
      const n = count(me, c.id);
      const part = c.id.startsWith('part_');
      const ps = part ? partState(c.id) : 'lost';
      const has = n > 0 || ps === 'installed';
      cls(c.el, 'none', !has);
      cls(c.el, 'held', me.held === c.id);
      cls(c.el, 'inst', ps === 'installed');
      txt(c.n, !part && !TOOLS.includes(c.id) && n > 0 ? String(n) : '');
      if (!c.cv) {
        const src = game.icon(c.id);
        if (src) {
          const cv = document.createElement('canvas');
          cv.width = src.width;
          cv.height = src.height;
          cv.getContext('2d')?.drawImage(src, 0, 0);
          c.el.appendChild(cv);
          c.el.classList.add('cv');
          c.cv = true;
        }
      }
    }
  }

  function updateFire(me: PlayerEnt): void {
    const sticks = count(me, 'stick'), matches = count(me, 'matches'), tinder = count(me, 'tinder');
    txt(fSticks.b, `${sticks} / 3`);
    cls(fSticks.r, 'short', sticks < 3);
    cls(fSticks.r, 'ok', sticks >= 3);
    txt(fMatch.b, String(matches));
    cls(fMatch.r, 'short', matches <= 0);
    cls(fMatch.r, 'ok', matches > 0);
    txt(fTinder.b, String(tinder));
    cls(fTinder.r, 'ok', tinder > 0);
    const sh = me.shelter;
    const wind = windFelt(view.env, me);
    txt(fShelter.b, sh >= 0.6 ? 'Good' : sh >= 0.3 ? 'Some' : 'None');
    cls(fShelter.r, 'ok', sh >= 0.6);
    cls(fShelter.r, 'short', sh < 0.3 && wind > 4);
    let note: string;
    if (sticks < 3) note = count(me, 'axe') > 0 ? 'Sticks lie under the trees, and the axe makes more from dead wood. Three lay a fire.' : 'Sticks lie under the trees. Three lay a fire.';
    else if (matches <= 0) note = 'No matches. A fire that still has embers relights without one.';
    else if (sh < 0.3 && wind > 4) note = 'The wind will likely take the match. Lay it in the lee of a rock, a wall or the trees.';
    else if (tinder > 0) note = 'Lay it, then strike a match. With tinder it will almost surely catch.';
    else note = 'Lay it, then strike a match. Tinder would make it near certain.';
    txt(fNote, note);
    cls(fBuild, 'no', sticks < 3);
  }

  function updateMap(me: ViewEnt<PlayerEnt>): void {
    ensureMap();
    const here = view.hud.place;
    txt(mHere, here ? here : 'Open ground.');
    txt(mNext, view.hud.objective || 'Stay warm.');
    let found = 0, inst = 0;
    for (const p of PART_ORDER) {
      const s = view.objective.parts[p];
      if (s !== 'lost') found++;
      if (s === 'installed') inst++;
    }
    txt(mParts, inst ? `${found} of 5 found, ${inst} installed at the tower.` : `${found} of 5 found.`);
    if (!map) return;
    const m = map;
    for (const v of mapMarks.values()) v.seen = false;
    const put = (key: string, cl: string, x: number, z: number, label: string) => {
      let mk = mapMarks.get(key);
      if (!mk) {
        const e = h('div', 'map-m ' + cl, mapBox);
        let ic: SVGSVGElement | undefined;
        if (cl.includes('me')) ic = icon('me', '', e);
        else h('i', '', e);
        mk = { el: e, span: h('span', '', e), seen: true, ic };
        mapMarks.set(key, mk);
      }
      mk.seen = true;
      const [u, v] = m.toUV(x, z);
      // near the east edge the name goes on the left of its mark, inside the map
      attr(mk.el, 'class', 'map-m ' + cl + (u > 0.72 ? ' l' : ''));
      sty(mk.el, 'left', (u * 100).toFixed(2) + '%');
      sty(mk.el, 'top', (v * 100).toFixed(2) + '%');
      txt(mk.span, label);
      return mk;
    };
    // an objective that sits on a named place lights that place instead of adding a label
    objAt.length = 0;
    for (const mk of view.hud.marks) {
      if (mk.kind !== 'objective') continue;
      const ox = me.x + Math.sin(mk.bearing) * mk.dist, oz = me.z - Math.cos(mk.bearing) * mk.dist;
      const poi = view.world.pois.find((p) => p.id !== 'hut' && Math.hypot(p.x - ox, p.z - oz) < Math.max(45, p.radius));
      if (poi) objAt.push(poi.id);
      else put('obj:' + mk.id, 'obj', ox, oz, mk.label ?? '');
    }
    for (const p of view.world.pois) if (p.id !== 'hut') put('poi:' + p.id, objAt.includes(p.id) ? 'poi obj' : 'poi', p.x, p.z, p.name);
    for (const f of view.list('fire')) if (f.lit) put('fire:' + f.id, 'fire', f.x, f.z, '');
    for (const p of view.list('player')) {
      if (p.id === view.myId || p.life === 'dead') continue;
      // close by, a name would sit on top of your own marker
      const near = Math.hypot(p.x - me.x, p.z - me.z) < 70;
      put('pl:' + p.id, p.life === 'downed' ? 'mate down' : 'mate', p.x, p.z, near && p.life !== 'downed' ? '' : p.name);
    }
    const meMk = put('me', 'me', me.x, me.z, '');
    if (meMk.ic) sty(meMk.ic, 'transform', `rotate(${((view.hud.heading * 180) / Math.PI).toFixed(1)}deg)`);
    for (const [k, v] of mapMarks) {
      if (!v.seen) {
        v.el.remove();
        mapMarks.delete(k);
      }
    }
  }

  function updateLegend(): void {
    const key = ctx.device + tabOn;
    if (key === legDev) return;
    legDev = key;
    leg.textContent = '';
    const pad = ctx.device === 'pad';
    const parts: [string, string][] = [];
    if (tabOn === 'pack') parts.push(...((pad ? [['A', 'Use'], ['X', 'Drop'], ['Y', 'Give']] : [['Enter', 'Use'], ['X', 'Drop'], ['G', 'Give']]) as [string, string][]));
    parts.push(pad ? ['LB RB', 'Pack and map'] : ['Q E', 'Pack and map'], pad ? ['B', 'Close'] : ['Tab', 'Close']);
    for (const [k, a] of parts) {
      const s = h('span', '', leg);
      h('b', '', s, k);
      s.appendChild(document.createTextNode(a));
    }
  }

  return {
    el,
    show(on) {
      if (on === shown) return;
      shown = on;
      cls(el, 'on', on);
      if (on) {
        ctx.sfx('ui_open');
        actKey = '';
        const me = view.me;
        // open on what is in hand, or the first thing carried
        if (me) {
          const first = me.held !== 'hands' ? (me.held as ItemId) : ([...TOOLS, ...SUPPLY_ORDER, ...PARTS].find((id) => count(me, id) > 0) ?? 'axe');
          sel = first;
          updateCells(me);
        }
        nav.open(scope, tabOn === 'pack' ? cells.get(sel)!.item : null);
        renderDetail();
      } else if (nav.scope === scope) nav.open(null);
    },
    update() {
      if (!shown) return;
      updateLegend();
      const me = view.me;
      if (!me) return;
      txt(stCore.v, fmtTemp(me.core) + '°');
      txt(stWet.v, Math.round(me.wet * 100) + '%');
      cls(stWet.s, 'w', me.wet > 0.3);
      txt(stDay.b, 'Day ' + (view.env.day + 1));
      txt(stDay.v, fmtHour(view.env.clock));
      if (tabOn === 'pack') {
        updateCells(me);
        renderDetail();
        updateFire(me);
      } else updateMap(me);
    },
  };
}
