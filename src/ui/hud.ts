// The HUD: everything on screen while playing. Built once; update() reads the view every frame
// and writes to the DOM only through the caching setters in dom.ts, so a calm frame costs a few
// comparisons. In a clear, calm moment almost nothing is visible: the compass and a faint
// temperature reading. Everything else appears when it matters and fades when it stops.
import type { GameBus, Hud as HudView, ViewEnt } from '../game/view';
import type { PlayerEnt, SimEvent } from '../sim/types';
import { type Ctx, attr, clamp01, cls, fmtClock, fmtDist, fmtHour, fmtTemp, h, on, svgEl, sty, txt, SVG_NS } from './dom';
import { type IconName, icon, partIcon, setIcon } from './icons';
import { type ColdStage, STAGE_NAME, bearingTo, coldStage, coreFrac, hasTool, project, toolReadout, trendClass, windFelt, wrapPi } from './model';
import { ITEM, PART_ORDER, TOOL_NAME, TOOL_ORDER } from './text';

export interface HudApi {
  el: HTMLElement;
  show(on: boolean): void;
  update(dt: number): void;
  toast(m: GameBus['toast']): void;
  place(m: GameBus['place']): void;
  sim(e: SimEvent): void;
}

const DEG = 180 / Math.PI;
/** Compass strip scale, em per degree. */
const K = 0.25;
/** Seconds a downed player has before bleeding out (DESIGN.md: 90 s). */
const BLEED = 90;

// Temperature arc geometry, in tenths of an em (the svg is 17em x 4.25em, viewBox 170 x 42.5).
const AX = 85, AY = 62, AR = 52;
const A0 = (-56 * Math.PI) / 180, A1 = (56 * Math.PI) / 180;
const apt = (a: number, r = AR) => [AX + r * Math.sin(a), AY - r * Math.cos(a)];
const f2 = (v: number) => v.toFixed(2);
function arcD(a0: number, a1: number, r = AR): string {
  const [x0, y0] = apt(a0, r), [x1, y1] = apt(a1, r);
  return `M${f2(x0)} ${f2(y0)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f2(x1)} ${f2(y1)}`;
}
const angOf = (core: number) => A0 + (A1 - A0) * coreFrac(core);
function tickD(core: number, r0: number, r1: number): string {
  const a = angOf(core);
  const [x0, y0] = apt(a, r0), [x1, y1] = apt(a, r1);
  return `M${f2(x0)} ${f2(y0)}L${f2(x1)} ${f2(y1)}`;
}

interface Mark { el: HTMLElement; span: HTMLElement; kind: string; seen: boolean; x: number; pri: number; want: boolean; text: string }
interface Toast { el: HTMLElement; text: HTMLElement; key: string; base: string; n: number; t: number; life: number; state: 0 | 1 | 2 }
interface Mate { el: HTMLElement; name: HTMLElement; s: HTMLElement; c: HTMLElement; d: HTMLElement; seen: boolean }
interface Marker { el: HTMLElement; name: HTMLElement; dist: HTMLElement; seen: boolean }

export function createHud(ctx: Ctx): HudApi {
  const { view } = ctx;
  const el = h('div', 'hud', ctx.root);

  // ---------------------------------------------------------------- compass
  const cp = h('div', 'cp', el);
  const cpWin = h('div', 'cp-win', cp);
  const strip = h('div', 'cp-strip', cpWin);
  const LETTERS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  for (let d = -180; d <= 540; d += 15) {
    const a = ((d % 360) + 360) % 360;
    const major = a % 45 === 0;
    const tick = h('i', major ? 'cp-t m' : 'cp-t', strip);
    tick.style.left = d * K + 'em';
    // labels are smaller type: a zero-width holder keeps their position in the strip's em
    const label = major ? LETTERS[a / 45] : a % 30 === 0 ? String(a) : '';
    if (label) {
      const at = h('span', 'cp-p', strip);
      at.style.left = d * K + 'em';
      h('span', major ? (a % 90 === 0 ? 'cp-l c' : 'cp-l') : 'cp-l d', at, label);
    }
  }
  h('i', 'cp-c', cp);
  const marks = new Map<string, Mark>();
  const labelOrder: Mark[] = [];
  let halfDeg = 60;
  const measure = () => {
    const fs = parseFloat(getComputedStyle(cp).fontSize) || 16;
    const w = cp.getBoundingClientRect().width;
    if (w > 0) halfDeg = (w / fs / 2 / K) * 0.84;
  };
  on(ctx, window, 'resize', () => (needMeasure = true));
  let needMeasure = true;
  let lastHd = NaN, anchorHd = 0, turnedAt = -10;

  // ---------------------------------------------------------------- top centre: hint (+ toasts on touch)
  const tcn = h('div', 'tcn', el);
  const hn = h('div', 'hn', tcn);
  let hintShown = '', hintWant = '', hintSwapAt = 0;

  // ---------------------------------------------------------------- objective and the five parts
  const ob = h('div', 'ob', el);
  const obL = h('div', 'ob-l', ob);
  h('i', '', obL);
  const obT = h('span', '', obL);
  const obS = h('div', 'ob-s num', ob);
  const pt = h('div', 'pt', ob);
  const partEls = PART_ORDER.map((p) => {
    const s = icon(partIcon(p), '', pt, true);
    const ttl = document.createElementNS(SVG_NS, 'title');
    ttl.textContent = ITEM[`part_${p}`].name;
    s.appendChild(ttl);
    return s;
  });
  let obText = '', obChangedAt = -100, partsPulseUntil = 0, teamAtt = false;

  // ---------------------------------------------------------------- teammates
  // on a phone the teammates follow the objective down the left side; on a desktop, top right
  const tm = h('div', 'tm', ctx.touch ? ob : el);
  const mates = new Map<number, Mate>();
  const markers = new Map<number, Marker>();
  const dmBox = h('div', 'dms', el);
  const proj = [0, 0, 0];

  // ---------------------------------------------------------------- body temperature
  const tp = h('div', 'tp', el);
  const arc = svgEl('', 'arc', '0 0 170 42.5', tp);
  const path = (c: string, d = '') => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('class', c);
    if (d) p.setAttribute('d', d);
    arc.appendChild(p);
    return p;
  };
  path('u', arcD(A0, A1));
  path('b', arcD(A0, A1));
  let ticks = '';
  for (let c = 31; c <= 37; c++) if (c !== 31 && c !== 33 && c !== 35) ticks += tickD(c, AR + 1.6, AR + 3.6);
  path('t', ticks);
  path('th', tickD(35, AR - 2.6, AR + 4.4) + tickD(33, AR - 2.6, AR + 4.4) + tickD(31, AR - 2.6, AR + 4.4));
  const arcF = path('f');
  const needle = path('n');
  // trend: a chevron riding just outside the arc, a little ahead of the needle in the direction
  // the core is moving; two chevrons when it moves fast. Drawn at the top, then rotated.
  const trG = document.createElementNS(SVG_NS, 'g');
  trG.setAttribute('class', 'tr');
  arc.appendChild(trG);
  const trH = document.createElementNS(SVG_NS, 'path');
  trH.setAttribute('class', 'h');
  const trV = document.createElementNS(SVG_NS, 'path');
  trV.setAttribute('class', 'v');
  trG.append(trH, trV);
  const cy = AY - AR - 6.5;
  const chev = (x: number, dir: number) => `M${f2(x + 2.3 * dir)} ${f2(cy - 2.5)}L${f2(x)} ${f2(cy)}L${f2(x + 2.3 * dir)} ${f2(cy + 2.5)}`;
  const TR_D: Record<string, string> = {
    dn: chev(AX - 1, 1),
    'dn fast': chev(AX - 1, 1) + chev(AX + 2.6, 1),
    up: chev(AX + 1, -1),
    'up fast': chev(AX + 1, -1) + chev(AX - 2.6, -1),
  };
  let trQ = '';
  const tpRead = h('div', 'tp-read', tp);
  const tpNum = h('div', 'tp-num num', tpRead);
  const tpV = h('span', '', tpNum, '37.0');
  h('sup', '', tpNum, '°');
  const tpLow = h('div', 'tp-low', tp);
  const tpSt = h('div', 'tp-st', tpLow);
  const tpFx = h('div', 'tp-fx', tpLow);
  const fx = (ic: IconName, extra = '') => {
    const e = h('div', 'fx' + (extra ? ' ' + extra : ''), tpFx);
    icon(ic, '', e, true);
    return { el: e, v: h('span', '', e) };
  };
  const fxShelter = fx('shelter');
  const fxFire = fx('fire', 'w');
  const fxHuddle = fx('huddle', 'w');
  const fxWet = fx('wet');
  const fxWind = fx('wind');
  const vtH = h('div', 'vt h full', tp);
  const vtHi = h('i', '', vtH);
  icon('health', '', vtH, true);
  const vtS = h('div', 'vt s full', tp);
  const vtSi = h('i', '', vtS);
  icon('stamina', '', vtS, true);
  let stage: ColdStage = 0, calmSince = 0, coreQ = NaN, arcQ = NaN;

  // ---------------------------------------------------------------- held tool and belt
  const tl = h('div', 'tl', el);
  const tlM = h('div', 'tl-m hide', tl);
  const tlH = h('div', 'tl-h', tlM);
  const tlN = h('div', 'tl-n', tlH);
  const tlIc = icon('hands', '', tlH, true);
  const tlA = h('div', 'tl-a num', tlM);
  const tlX = h('div', 'tl-x hide', tlM);
  const ln = h('div', 'ln', tlX);
  const lnI = h('i', '', ln);
  const tlNote = h('span', '', tlX);
  const sig = h('div', 'sig hide', tlX);
  const sigI: HTMLElement[] = [];
  for (let i = 0; i < 5; i++) sigI.push(h('i', '', sig));
  const bl = h('div', 'bl', tl);
  const belt = TOOL_ORDER.map((tool, i) => {
    const s = h('div', 'bl-s', bl);
    icon(tool, '', s, true);
    h('b', 'num', s, String(i + 1));
    return s;
  });
  let tlKey = '', tlChangedAt = -100, heldWas = '', beltUntil = 0, ammoKey = '';

  // ---------------------------------------------------------------- crosshair and focus prompt
  const xh = h('div', 'xh', el);
  h('i', 'dot', xh);
  h('i', 'ring', xh);
  h('i', 'aim', xh);
  const ring = (parent: HTMLElement) => {
    const k = h('div', 'fc-k', parent);
    const s = svgEl('<circle class="bg" cx="12" cy="12" r="11"/><circle class="pr" cx="12" cy="12" r="11" pathLength="100" stroke-dasharray="0 100"/>', '', '0 0 24 24', k);
    return { k, pr: s.lastElementChild as SVGElement, b: h('b', '', k) };
  };
  const fc = h('div', 'fc', el);
  const fcR = h('div', 'fc-r', fc);
  const fcRing = ring(fcR);
  const fcV = h('div', 'fc-v', fcR);
  const fcVerb = document.createTextNode('');
  fcV.appendChild(fcVerb);
  const fcName = h('span', '', fcV);
  const fcO = h('div', 'fc-o', fc);
  let holdQ = -1;

  // ---------------------------------------------------------------- toasts, lore, place
  const ts = h('div', 'ts', ctx.touch ? tcn : el);
  const toasts: Toast[] = [];
  const lo = h('div', 'lo', el);
  let loreUntil = 0;
  const pl = h('div', 'pl', el);
  const plN = h('div', 'pl-n', pl);
  h('div', 'pl-r', pl);
  const plS = h('div', 'pl-s', pl);
  let placeUntil = 0;

  // ---------------------------------------------------------------- downed
  const dn = h('div', 'dw', el);
  h('div', 'dw-t', dn, 'Down');
  const dnB = h('div', 'dw-b', dn);
  const dnBi = h('i', '', dnB);
  const dnC = h('div', 'dw-c num', dn);
  const dnH = h('div', 'dw-h', dn);
  const dnH1 = h('span', '', dnH);
  const dnH2 = h('span', '', dnH);
  const rv = h('div', 'rv', dn);
  const rvRing = ring(rv);
  const rvT = h('span', '', rv);

  const fps = h('div', 'fps num', el);
  let fpsAcc = 0, fpsN = 0, fpsAt = 0;

  let t = 0;
  let visible = false;

  // ======================================================================================
  function updateCompass(hud: HudView, me: ViewEnt<PlayerEnt> | null): void {
    if (needMeasure) {
      needMeasure = false;
      measure();
    }
    const hd = ((((hud.heading * DEG) % 360) + 360) % 360);
    if (!(Math.abs(hd - lastHd) < 0.02)) {
      lastHd = hd;
      sty(strip, 'transform', `translateX(${(-hd * K).toFixed(3)}em)`);
    }
    let d = Math.abs(hd - anchorHd);
    if (d > 180) d = 360 - d;
    if (d > 2) {
      anchorHd = hd;
      turnedAt = t;
    }
    for (const m of marks.values()) m.seen = false;
    let near = false;
    const lim = halfDeg;
    const place = (id: string, kind: string, bearing: number, dist: number, label: string | undefined, sticky: boolean) => {
      let rel = wrapPi(bearing - hud.heading) * DEG;
      const edge = Math.abs(rel) > lim;
      if (edge && !sticky) return;
      if (edge) rel = rel < 0 ? -lim : lim;
      let m = marks.get(id);
      if (!m || m.kind !== kind) {
        if (m) m.el.remove();
        const e = h('div', 'cp-m k-' + kind, cp);
        h('i', '', e);
        m = { el: e, span: h('span', '', e), kind, seen: true, x: 0, pri: 0, want: false, text: '' };
        marks.set(id, m);
      }
      m.seen = true;
      sty(m.el, 'transform', `translateX(${(rel * K).toFixed(2)}em)`);
      cls(m.el, 'edge', edge);
      cls(m.el, 'e-l', edge && rel < 0);
      cls(m.el, 'e-r', edge && rel > 0);
      const a = Math.abs(rel);
      const pri = kind === 'down' ? 5 : kind === 'objective' ? 4 : kind === 'ping' ? 2 : kind === 'player' ? 1 : 0;
      m.x = rel * K;
      m.pri = pri;
      m.want = !edge && (a < 9 || (pri >= 2 && a < 28));
      if (m.want) m.text = label ? label + '  ' + fmtDist(dist) : fmtDist(dist);
      if (!edge && a < 30) near = true;
    };
    // downed teammates get their own red mark; a plain player mark on the same bearing is dropped
    const downs: number[] = [];
    if (me) {
      for (const p of view.list('player')) {
        if (p.id === view.myId || p.life !== 'downed') continue;
        const b = bearingTo(me.x, me.z, p.x, p.z);
        downs.push(b);
        place('down' + p.id, 'down', b, Math.hypot(p.x - me.x, p.z - me.z), p.name, true);
      }
    }
    for (const mk of hud.marks) {
      if (mk.kind === 'player' && downs.some((b) => Math.abs(wrapPi(b - mk.bearing)) < 0.04)) continue;
      place(mk.id, mk.kind, mk.bearing, mk.dist, mk.label, mk.kind === 'objective' || mk.kind === 'ping');
    }
    for (const [id, m] of marks) {
      if (!m.seen) {
        m.el.remove();
        marks.delete(id);
      }
    }
    // labels: the most important first; one that would overlap a label already placed waits
    labelOrder.length = 0;
    for (const m of marks.values()) {
      if (m.want) labelOrder.push(m);
      else cls(m.el, 'lab', false);
    }
    labelOrder.sort((p, q) => q.pri - p.pri || Math.abs(p.x) - Math.abs(q.x));
    for (let i = 0; i < labelOrder.length; i++) {
      const m = labelOrder[i];
      const hw = m.text.length * 0.2 + 0.4; // half width in em at the label size
      let free = true;
      for (let j = 0; j < i && free; j++) {
        const o = labelOrder[j];
        if (o.want && Math.abs(o.x - m.x) < hw + o.text.length * 0.2 + 0.4) free = false;
      }
      if (!free) m.want = false;
      cls(m.el, 'lab', free);
      if (free) txt(m.span, m.text);
    }
    cls(cp, 'idle', !near && t - turnedAt > 3.5);
  }

  function updateObjective(): void {
    const o = view.objective;
    const text = view.hud.objective;
    if (text !== obText) {
      obText = text;
      obChangedAt = t;
    }
    txt(obT, text);
    cls(ob, 'hide', !text);
    let sub = '';
    if ((o.stage === 'holdout' || o.stage === 'rescue') && o.eta >= 0) sub = fmtClock(o.eta);
    else if (o.stage === 'power' && o.transmit > 0) sub = Math.floor(o.transmit * 100) + '%';
    else if (o.stage === 'power' && o.generator > 0) sub = Math.floor(o.generator * 100) + '%';
    txt(obS, sub);
    const showParts = o.stage === 'search' || o.stage === 'tower' || o.stage === 'power' || t < partsPulseUntil;
    cls(pt, 'hide', !showParts);
    for (let i = 0; i < PART_ORDER.length; i++) {
      const s = o.parts[PART_ORDER[i]];
      cls(partEls[i], 'held', s === 'held');
      cls(partEls[i], 'inst', s === 'installed');
    }
    cls(ob, 'dim', t - obChangedAt > 14 && t >= partsPulseUntil && !sub && !(ctx.touch && teamAtt));
  }

  function updateTeam(me: ViewEnt<PlayerEnt>): void {
    for (const m of mates.values()) m.seen = false;
    for (const mk of markers.values()) mk.seen = false;
    const W = innerWidth, H = innerHeight;
    let att = false;
    for (const p of view.list('player')) {
      if (p.id === view.myId) continue;
      let m = mates.get(p.id);
      if (!m) {
        const e = h('div', 'mate', tm);
        m = { el: e, name: h('b', '', e), s: h('span', 's', e), c: h('span', 'c num', e), d: h('span', 'd num', e), seen: true };
        mates.set(p.id, m);
      }
      m.seen = true;
      const dist = Math.hypot(p.x - me.x, p.z - me.z);
      const down = p.life === 'downed', gone = p.life === 'dead', safe = p.life === 'rescued';
      const frz = !down && !gone && p.core <= 33, cold = !down && !gone && p.core <= 35;
      txt(m.name, p.name);
      txt(m.s, down ? 'down ' + fmtClock(p.bleed) : gone ? 'lost' : safe ? 'safe' : frz ? 'freezing' : cold ? 'cold' : dist > 150 ? 'far' : '');
      txt(m.c, gone || safe ? '' : fmtTemp(p.core) + '°');
      txt(m.d, gone ? '' : fmtDist(dist));
      cls(m.el, 'down', down);
      cls(m.el, 'gone', gone);
      cls(m.el, 'frz', frz);
      cls(m.el, 'cold', cold && !frz);
      cls(m.el, 'att', down || frz || dist > 150);
      if (down || frz) att = true;
      // a marker over a downed teammate, where the eye can find them
      if (down) {
        let mk = markers.get(p.id);
        if (!mk) {
          const e = h('div', 'dm', dmBox);
          h('i', '', e);
          const lab = h('span', '', e);
          mk = { el: e, name: h('em', '', lab), dist: h('b', 'num', lab), seen: true };
          markers.set(p.id, mk);
        }
        mk.seen = true;
        const vis = project(view.camera, p.x, p.y + 0.5, p.z, W, H, proj) && proj[0] > -20 && proj[0] < W + 20 && proj[1] > -20 && proj[1] < H + 20;
        cls(mk.el, 'on', vis);
        if (vis) sty(mk.el, 'transform', `translate(${proj[0].toFixed(1)}px,${proj[1].toFixed(1)}px)`);
        txt(mk.name, p.name);
        txt(mk.dist, fmtDist(dist));
      }
    }
    for (const [id, m] of mates) {
      if (!m.seen) {
        m.el.remove();
        mates.delete(id);
      }
    }
    for (const [id, mk] of markers) {
      if (!mk.seen) {
        mk.el.remove();
        markers.delete(id);
      }
    }
    teamAtt = att;
  }

  function updateTemp(me: ViewEnt<PlayerEnt>): void {
    const env = view.env;
    stage = coldStage(me.core, stage);
    const q = Math.round(me.core * 10);
    if (q !== coreQ) {
      coreQ = q;
      txt(tpV, fmtTemp(q / 10));
    }
    const tr = trendClass(me.trend);
    const aq = Math.round(coreFrac(me.core) * 600);
    if (aq !== arcQ || tr !== trQ) {
      const a = angOf(me.core);
      if (aq !== arcQ) {
        attr(arcF, 'd', a > A0 + 0.002 ? arcD(A0, a) : '');
        attr(needle, 'd', tickD(me.core, AR - 3.2, AR + 3.2));
      }
      arcQ = aq;
      trQ = tr;
      if (tr) {
        // lead the needle by a few degrees, but stay on the scale
        const lead = (tr.startsWith('dn') ? -5 : 5) * (Math.PI / 180);
        const at = Math.min(A1, Math.max(A0, a + lead));
        attr(trV, 'd', TR_D[tr]);
        attr(trH, 'd', TR_D[tr]);
        attr(trG, 'transform', `rotate(${f2((at * 180) / Math.PI)} ${AX} ${AY})`);
      }
    }
    cls(trG, 'on', !!tr);
    for (let s = 1; s <= 3; s++) cls(tp, 's' + s, stage === s);
    txt(tpSt, STAGE_NAME[stage]);

    // what the body feels: shown only when it matters
    const wind = windFelt(env, me);
    const exposed = env.storm > 0.25 || Math.hypot(env.windX, env.windZ) > 6 || me.feels < -12;
    const shelterOn = me.shelter >= 0.6 && exposed;
    const fireOn = me.fireHeat > 0.04;
    const huddleOn = me.huddle > 0.04;
    const wetOn = me.wet > 0.08;
    const windOn = !shelterOn && wind > 5 && me.feels < env.airTemp - 3;
    cls(fxShelter.el, 'on', shelterOn);
    cls(fxFire.el, 'on', fireOn);
    cls(fxHuddle.el, 'on', huddleOn);
    cls(fxWet.el, 'on', wetOn);
    if (wetOn) txt(fxWet.v, Math.round(me.wet * 100) + '%');
    cls(fxWet.el, 'w', me.wet > 0.5);
    cls(fxWind.el, 'on', windOn);
    if (windOn) txt(fxWind.v, fmtTemp(me.feels, 0) + '°');

    const hp = clamp01(me.health / 100), st = clamp01(me.stamina);
    sty(vtHi, 'transform', `scaleX(${hp.toFixed(3)})`);
    sty(vtSi, 'transform', `scaleX(${st.toFixed(3)})`);
    cls(vtH, 'full', hp >= 0.995);
    cls(vtS, 'full', st >= 0.995);
    cls(vtH, 'low', hp < 0.35);
    cls(vtS, 'low', st < 0.25);

    const quiet = stage === 0 && !tr.startsWith('dn') && !fireOn && !wetOn && !windOn && !huddleOn && !shelterOn && hp >= 0.995 && st >= 0.995;
    if (!quiet) calmSince = t;
    cls(tp, 'calm', t - calmSince > 2.5);
  }

  function updateTool(me: ViewEnt<PlayerEnt>): void {
    const held = me.held;
    if (held !== heldWas) {
      heldWas = held;
      beltUntil = t + 2.8;
    }
    const r = toolReadout(me);
    const key = held + (r ? `|${r.big}|${r.small}|${r.empty}|${Math.round(r.bar * 20)}|${r.sig}|${r.note}` : '');
    if (key !== tlKey) {
      tlKey = key;
      tlChangedAt = t;
    }
    const none = held === 'hands';
    cls(tlM, 'hide', none);
    if (!none) {
      setIcon(tlIc, held, true);
      txt(tlN, TOOL_NAME[held]);
    }
    const ak = r && r.big !== '' ? r.big + '|' + r.small : '';
    if (ak !== ammoKey) {
      ammoKey = ak;
      if (!r || r.big === '') tlA.textContent = '';
      else {
        tlA.textContent = r.big;
        h('small', '', tlA, r.small);
      }
    }
    cls(tlA, 'empty', !!r && r.empty && r.big !== '');
    const line = !!r && r.bar >= 0;
    cls(tlX, 'hide', !line && !(r && r.small && r.big === ''));
    cls(ln, 'hide', !line);
    if (line && r) {
      sty(lnI, 'transform', `scaleX(${r.bar.toFixed(3)})`);
      cls(ln, 'low', r.low);
      txt(tlNote, r.note || (r.big === '' ? r.small : ''));
    } else txt(tlNote, r && r.big === '' ? r.small : '');
    const sv = r ? r.sig : -1;
    cls(sig, 'hide', sv < 0);
    for (let i = 0; i < 5; i++) cls(sigI[i], 'on', i < sv);
    cls(tlM, 'dim', t - tlChangedAt > 5 && !(r && (r.empty || r.low)));
    // belt: shown for a moment when the tool changes
    cls(bl, 'on', t < beltUntil);
    if (t < beltUntil) {
      for (let i = 0; i < TOOL_ORDER.length; i++) {
        const tool = TOOL_ORDER[i];
        cls(belt[i], 'own', hasTool(me, tool));
        cls(belt[i], 'cur', tool === held);
      }
    }
  }

  function updateFocus(hud: HudView, down: boolean): void {
    const f = down ? null : hud.focus;
    cls(fc, 'on', !!f);
    if (f) {
      // on a phone the use button carries the verb; the prompt names the thing
      const verb = ctx.touch ? '' : f.verb;
      if (fcVerb.data !== verb) fcVerb.data = verb;
      txt(fcName, f.name);
      txt(fcRing.b, f.key);
      txt(fcO, f.note ?? '');
      const hq = f.hold === null ? -1 : Math.round(clamp01(f.hold) * 100);
      if (hq !== holdQ) {
        holdQ = hq;
        attr(fcRing.pr, 'stroke-dasharray', `${Math.max(0, hq)} 100`);
      }
    }
    attr(xh, 'class', 'xh' + (down || hud.crosshair === 'none' ? '' : ' k-' + hud.crosshair));
  }

  function updateDowned(me: ViewEnt<PlayerEnt>): boolean {
    const down = me.life === 'downed';
    cls(dn, 'on', down);
    cls(el, 'down', down);
    if (!down) return false;
    sty(dnBi, 'transform', `scaleX(${clamp01(me.bleed / BLEED).toFixed(3)})`);
    txt(dnC, fmtClock(me.bleed));
    const crawl = ctx.device === 'touch' ? 'You can still crawl. Use the stick.' : ctx.device === 'pad' ? 'You can still crawl. Use the left stick.' : 'You can still crawl.';
    txt(dnH1, crawl);
    let help = false;
    for (const p of view.list('player')) if (p.id !== view.myId && p.life === 'alive') help = true;
    txt(dnH2, help ? 'A teammate can revive you.' : (me.inv.bandage ?? 0) > 0 ? 'Use a bandage from your pack to get up.' : 'Alone, you will wake at the last fire you rested at.');
    const being = me.revive > 0.001;
    cls(rv, 'on', being);
    if (being) {
      attr(rvRing.pr, 'stroke-dasharray', `${Math.round(clamp01(me.revive) * 100)} 100`);
      const by = view.ents.get(me.reviver) as ViewEnt<PlayerEnt> | undefined;
      txt(rvT, by && by.kind === 'player' ? by.name + ' is reviving you' : 'Being revived');
    }
    return true;
  }

  function updateHint(): void {
    const want = view.settings.hints ? view.hud.hint : '';
    if (want !== hintWant) {
      hintWant = want;
      if (hintShown) {
        cls(hn, 'on', false);
        hintSwapAt = t + 0.45;
      } else hintSwapAt = t;
    }
    if (hintShown !== hintWant && t >= hintSwapAt) {
      hintShown = hintWant;
      txt(hn, hintShown);
    }
    cls(hn, 'on', !!hintShown && hintShown === hintWant && t >= hintSwapAt + 0.02);
  }

  function ageToasts(dt: number): void {
    for (let i = toasts.length - 1; i >= 0; i--) {
      const q = toasts[i];
      if (q.state === 0) {
        q.state = 1;
        q.el.classList.add('on');
        continue;
      }
      q.life -= dt;
      if (q.state === 1 && q.life <= 0) {
        q.state = 2;
        q.el.classList.add('out');
        q.life = 0.8;
      } else if (q.state === 2 && q.life <= 0) {
        q.el.remove();
        toasts.splice(i, 1);
      }
    }
    // on a phone toasts and the place card share the top of the screen: the toasts win
    if (ctx.touch) {
      let live = false;
      for (let i = 0; i < toasts.length; i++) if (toasts[i].state === 1) live = true;
      cls(el, 'tsv', live);
    }
    if (loreUntil && t > loreUntil) {
      loreUntil = 0;
      cls(lo, 'on', false);
    }
    if (placeUntil && t > placeUntil) {
      placeUntil = 0;
      cls(pl, 'on', false);
    }
  }

  function updateFps(dt: number): void {
    if (!view.settings.showFps) {
      txt(fps, '');
      return;
    }
    fpsAcc += dt;
    fpsN++;
    if (t - fpsAt >= 0.5 && fpsAcc > 0) {
      txt(fps, Math.round(fpsN / fpsAcc) + ' fps');
      fpsAt = t;
      fpsAcc = 0;
      fpsN = 0;
    }
  }

  // ======================================================================================
  return {
    el,
    show(onScreen) {
      if (onScreen === visible) return;
      visible = onScreen;
      cls(el, 'on', onScreen);
      if (onScreen) {
        needMeasure = true;
        beltUntil = t + 2.8;
        obChangedAt = t;
        turnedAt = t;
      }
    },

    update(dt) {
      t += dt;
      ageToasts(dt);
      if (!visible) return;
      const me = view.me;
      const hud = view.hud;
      updateCompass(hud, me);
      updateObjective();
      updateHint();
      updateFps(dt);
      cls(el, 'wo', hud.whiteout > 0.5);
      cls(el, 'nome', !me);
      if (!me) {
        cls(fc, 'on', false);
        attr(xh, 'class', 'xh');
        return;
      }
      const down = updateDowned(me);
      updateTemp(me);
      updateTool(me);
      updateFocus(hud, down);
      updateTeam(me);
    },

    toast(m) {
      if (m.kind === 'lore') {
        txt(lo, m.text);
        cls(lo, 'on', true);
        loreUntil = t + Math.max(6, m.text.split(' ').length * 0.42);
        return;
      }
      const key = m.kind + '|' + m.text;
      const same = toasts.find((q) => q.key === key && q.state !== 2);
      if (same) {
        same.n++;
        txt(same.text, same.base + '  ×' + same.n);
        same.life = lifeOf(m.kind);
        return;
      }
      const e = h('div', 'to k-' + m.kind, ts);
      let ic: IconName = 'info';
      if (m.item) ic = m.item;
      else if (m.kind === 'warn') ic = 'warn';
      else if (m.kind === 'objective' || m.kind === 'part') ic = 'diamond';
      else if (m.kind === 'pickup') ic = 'check';
      icon(ic, '', e, true);
      const span = h('span', '', e, m.text);
      toasts.push({ el: e, text: span, key, base: m.text, n: 1, t: 0, life: lifeOf(m.kind), state: 0 });
      // keep the stack short: the oldest leaves first
      let live = 0;
      for (let i = toasts.length - 1; i >= 0; i--) {
        if (toasts[i].state === 2) continue;
        if (++live > 4) {
          toasts[i].state = 2;
          toasts[i].el.classList.add('out');
          toasts[i].life = 0.8;
        }
      }
      if (m.kind === 'part') partsPulseUntil = t + 6;
    },

    place(m) {
      if (!m.name) return;
      txt(plN, m.name);
      txt(plS, 'Day ' + (view.env.day + 1) + '   ' + fmtHour(view.env.clock));
      cls(pl, 'on', true);
      placeUntil = t + 5;
    },

    sim(e) {
      if (e.t === 'partFound' || e.t === 'partInstalled') partsPulseUntil = t + 6;
      else if (e.t === 'equip' && e.id === view.myId) beltUntil = t + 2.8;
    },
  };
}

function lifeOf(kind: string): number {
  return kind === 'part' || kind === 'objective' ? 6.5 : kind === 'warn' ? 4.8 : 3.8;
}
