// On-screen controls for phones and tablets. A thumb stick that appears where the left thumb
// lands, look by dragging on the right, buttons placed for the right thumb, a tool wheel. Every
// finger is tracked by its pointer id and owned by the element it first touched, so moving,
// looking and pressing a button at the same time all work. Everything reports to game.touch
// (move, look, BTN bits) or game.actions, exactly like the keyboard and the pad do.
import { BTN, type ToolId } from '../sim/types';
import { type Ctx, attr, clamp, cls, h, on, svgEl, sty, txt } from './dom';
import { type IconName, icon, setIcon } from './icons';
import { contextAction, hasTool, toolReadout } from './model';
import { TOOL_NAME, TOOL_ORDER } from './text';

export interface TouchApi {
  el: HTMLElement;
  show(on: boolean): void;
  update(dt: number): void;
  /** Let go of everything (screen change, focus lost). */
  release(): void;
}

const WHEEL: readonly ToolId[] = [...TOOL_ORDER, 'hands'];
const TAP_S = 0.28; // a press shorter than this (and nearly still) is a tap
const SPRINT_UNLATCH_S = 1.0; // sprint lock lets go after the stick has been idle this long

export function createTouch(ctx: Ctx): TouchApi {
  const { game, view } = ctx;
  const sink = game.touch;
  const el = h('div', 'tc', ctx.root);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  const zone = h('div', 'tz', el);
  const stk = h('div', 'stk', el);
  const knob = h('i', '', stk);

  let t = 0;
  let shown = false;
  // buttons: bits held by fingers, bits latched by taps, and what the sink was last told
  let holdBits = 0, latchBits = 0, sent = 0;
  let stickRun = false;
  let aimLatched = false;

  function sync(): void {
    const want = holdBits | latchBits | (stickRun ? BTN.SPRINT : 0) | (aimLatched ? BTN.SECONDARY : 0);
    const diff = want ^ sent;
    if (!diff) return;
    for (const k in BTN) {
      const b = BTN[k as keyof typeof BTN];
      if (diff & b) sink.button(b, (want & b) !== 0);
    }
    sent = want;
  }

  interface Btn { el: HTMLElement; ic: SVGSVGElement; pid: number; downAt: number; x: number; y: number; moved: number }
  const btn = (c: string, ic: IconName): Btn => {
    const e = h('div', 'tb ' + c, el);
    e.dataset.id = c.replace('tb-', '');
    return { el: e, ic: icon(ic, '', e, true), pid: -1, downAt: 0, x: 0, y: 0, moved: 0 };
  };

  /** Wire a button's own pointers. `look` keeps a drag on the button turning the view. */
  function wire(b: Btn, down: () => void, up: (tap: boolean) => void, look = false): void {
    b.el.addEventListener('pointerdown', (e) => {
      if (b.pid !== -1) return;
      e.preventDefault();
      e.stopPropagation();
      b.pid = e.pointerId;
      b.downAt = t;
      b.x = e.clientX;
      b.y = e.clientY;
      b.moved = 0;
      try {
        b.el.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer may already be gone */
      }
      ctx.device = 'touch';
      cls(b.el, 'dn', true);
      down();
      sync();
    });
    b.el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== b.pid) return;
      const dx = e.clientX - b.x, dy = e.clientY - b.y;
      b.x = e.clientX;
      b.y = e.clientY;
      b.moved += Math.abs(dx) + Math.abs(dy);
      if (look && (dx || dy)) sink.look(dx, dy);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== b.pid) return;
      b.pid = -1;
      cls(b.el, 'dn', false);
      up(e.type === 'pointerup' && t - b.downAt < TAP_S && b.moved < 14);
      sync();
    };
    b.el.addEventListener('pointerup', end);
    b.el.addEventListener('pointercancel', end);
    b.el.addEventListener('lostpointercapture', end);
  }
  const hold = (b: Btn, bit: number, look = false) =>
    wire(b, () => (holdBits |= bit), () => (holdBits &= ~bit), look);
  // a latch toggles on the press itself, which feels quicker than waiting for the release
  const latch = (b: Btn, bit: number) =>
    wire(b, () => {
      latchBits ^= bit;
      if (bit === BTN.SPRINT) idleSince = t;
    }, () => {});
  const tap = (b: Btn, fn: () => void) => wire(b, () => {}, (isTap) => isTap && fn());

  // right thumb cluster
  const pri = btn('tb-pri', 'axe');
  hold(pri, BTN.PRIMARY, true);
  const aim = btn('tb-aim', 'aim');
  let aimWas = false;
  wire(
    aim,
    () => {
      aimWas = aimLatched;
      holdBits |= BTN.SECONDARY;
    },
    (isTap) => {
      holdBits &= ~BTN.SECONDARY;
      // a tap toggles the sight; a long press is a momentary aim
      aimLatched = isTap ? !aimWas : false;
      cls(aim.el, 'lk', aimLatched);
    },
    true,
  );
  const jmp = btn('tb-jmp', 'jump');
  hold(jmp, BTN.JUMP);
  const cro = btn('tb-cro', 'crouch');
  latch(cro, BTN.CROUCH);
  const spr = btn('tb-spr', 'sprint');
  latch(spr, BTN.SPRINT);
  const use = btn('tb-use', 'hands');
  const useRing = svgEl('<circle cx="50" cy="50" r="49" pathLength="100" stroke-dasharray="0 100"/>', 'rg', '0 0 100 100', use.el).firstElementChild as SVGElement;
  const useLb = h('span', 'lb', use.el);
  hold(use, BTN.USE);
  const ctxB = btn('tb-ctx', 'reload');
  tap(ctxB, () => {
    const me = view.me;
    const a = me ? contextAction(me) : null;
    if (a === 'reload') game.actions.act({ t: 'reload' });
    else if (a === 'light') game.actions.act({ t: 'toggleLight' });
  });
  const whl = btn('tb-whl', 'hands');
  const whlLb = h('span', 'lb num', whl.el);
  const pau = btn('tb-pau quiet', 'pause');
  tap(pau, () => game.actions.pause());
  const pck = btn('tb-pck quiet', 'pack');
  tap(pck, () => game.actions.openInventory());

  // ---------------------------------------------------------------- tool wheel
  const tw = h('div', 'tw', el);
  const twc = h('div', 'tw-c', tw);
  h('div', 'tw-r', twc);
  const slots = WHEEL.map((tool, i) => {
    const a = (i / WHEEL.length) * Math.PI * 2;
    const s = h('div', 'tw-s', twc);
    s.dataset.id = tool;
    s.style.transform = `translate(calc(var(--tb) * ${(Math.sin(a) * 1.64).toFixed(3)}), calc(var(--tb) * ${(-Math.cos(a) * 1.64).toFixed(3)}))`;
    icon(tool, '', s, true);
    return s;
  });
  const twN = h('div', 'tw-n', twc);
  const twName = h('b', '', twN);
  const twVal = h('span', 'num', twN);
  let wheelOpen = false, wheelTap = false, hot = -1;
  let wx = 0, wy = 0, wpid = -1;

  function slotAt(dx: number, dy: number, minDist: number): number {
    if (Math.hypot(dx, dy) < minDist) return -1;
    let a = Math.atan2(dx, -dy);
    if (a < 0) a += Math.PI * 2;
    return Math.round(a / ((Math.PI * 2) / WHEEL.length)) % WHEEL.length;
  }
  function openWheel(tapMode: boolean): void {
    wheelOpen = true;
    wheelTap = tapMode;
    cls(tw, 'on', true);
    cls(ctx.root, 'wheel', true); // the HUD centre steps back while the wheel is up
    ctx.sfx('ui_open');
  }
  function closeWheel(choose: boolean): void {
    if (choose && hot >= 0) {
      const tool = WHEEL[hot];
      const me = view.me;
      if (me && hasTool(me, tool) && me.held !== tool) {
        game.actions.equip(tool);
        ctx.sfx('ui_click');
      }
    }
    wheelOpen = false;
    wheelTap = false;
    hot = -1;
    cls(tw, 'on', false);
    cls(ctx.root, 'wheel', false);
  }
  const tbPx = () => whl.el.getBoundingClientRect().width || 56;
  whl.el.addEventListener('pointerdown', (e) => {
    if (wpid !== -1) return;
    e.preventDefault();
    e.stopPropagation();
    if (wheelOpen) {
      closeWheel(false);
      return;
    }
    wpid = e.pointerId;
    wx = e.clientX;
    wy = e.clientY;
    whl.downAt = t;
    try {
      whl.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    cls(whl.el, 'dn', true);
    openWheel(false);
  });
  whl.el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== wpid || wheelTap) return;
    hot = slotAt(e.clientX - wx, e.clientY - wy, tbPx() * 0.45);
  });
  const whlEnd = (e: PointerEvent) => {
    if (e.pointerId !== wpid) return;
    wpid = -1;
    cls(whl.el, 'dn', false);
    if (hot >= 0) closeWheel(true);
    else if (e.type === 'pointerup' && t - whl.downAt < 0.45) wheelTap = true; // stays open: tap a tool
    else closeWheel(false);
  };
  whl.el.addEventListener('pointerup', whlEnd);
  whl.el.addEventListener('pointercancel', whlEnd);
  whl.el.addEventListener('lostpointercapture', whlEnd);
  slots.forEach((s, i) => {
    s.addEventListener('pointerdown', (e) => {
      if (!wheelTap) return;
      e.stopPropagation();
      hot = i;
    });
    s.addEventListener('pointerup', (e) => {
      if (!wheelTap) return;
      e.stopPropagation();
      hot = i;
      closeWheel(true);
    });
  });
  tw.addEventListener('pointerdown', (e) => {
    if (wheelTap && e.target === tw) closeWheel(false);
  });

  // ---------------------------------------------------------------- stick and look
  let sid = -1, scx = 0, scy = 0, sR = 60;
  let lid = -1, lx = 0, ly = 0;
  let mvx = 0, mvz = 0, idleSince = 0;
  let restX = 0, restY = 0;

  function placeRest(): void {
    const tb = tbPx();
    const cs = getComputedStyle(el);
    const sl = parseFloat(cs.getPropertyValue('--sl')) || 0;
    const sb = parseFloat(cs.getPropertyValue('--sb')) || 0;
    restX = sl + tb * 1.9;
    restY = innerHeight - sb - tb * 1.75;
    if (sid === -1) sty(stk, 'transform', `translate(${restX.toFixed(1)}px,${restY.toFixed(1)}px)`);
  }
  on(ctx, window, 'resize', () => shown && placeRest());

  function setMove(x: number, z: number): void {
    if (Math.abs(x - mvx) < 0.01 && Math.abs(z - mvz) < 0.01 && !(x === 0 && z === 0 && (mvx !== 0 || mvz !== 0))) return;
    mvx = x;
    mvz = z;
    sink.move(x, z);
  }

  function stickTo(px: number, py: number): void {
    const dx = px - scx, dy = py - scy;
    const d = Math.hypot(dx, dy);
    const k = d > sR ? sR / d : 1;
    sty(knob, 'transform', `translate(${(dx * k).toFixed(1)}px,${(dy * k).toFixed(1)}px)`);
    let x = dx / sR, z = -dy / sR;
    const m = Math.hypot(x, z);
    if (m > 1) {
      x /= m;
      z /= m;
    }
    // small dead zone, then a smooth start
    const mm = Math.min(1, m);
    const g = mm < 0.12 ? 0 : (mm - 0.12) / 0.88;
    const s = mm > 0 ? g / mm : 0;
    setMove(x * s, z * s);
    const forward = z > 0.7 * Math.min(1, m);
    if (!stickRun && d > sR * 1.3 && forward) stickRun = true;
    else if (stickRun && (d < sR * 1.05 || z < 0.5 * Math.min(1, m))) stickRun = false;
    cls(stk, 'run', stickRun || (latchBits & BTN.SPRINT) !== 0);
    sync();
  }

  function releaseStick(): void {
    sid = -1;
    cls(stk, 'on', false);
    sty(knob, 'transform', 'translate(0px,0px)');
    sty(stk, 'transform', `translate(${restX.toFixed(1)}px,${restY.toFixed(1)}px)`);
    setMove(0, 0);
    stickRun = false;
    idleSince = t;
    sync();
  }

  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ctx.device = 'touch';
    if (wheelOpen) closeWheel(false);
    const leftSide = e.clientX < innerWidth * 0.42;
    if (leftSide && sid === -1) {
      sid = e.pointerId;
      const tb = tbPx();
      sR = tb * 1.0;
      const m = tb * 1.2;
      scx = clamp(e.clientX, m, innerWidth - m);
      scy = clamp(e.clientY, m, innerHeight - m);
      sty(stk, 'transform', `translate(${scx.toFixed(1)}px,${scy.toFixed(1)}px)`);
      cls(stk, 'on', true);
      stickTo(e.clientX, e.clientY);
    } else if (!leftSide && lid === -1) {
      lid = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
    } else return;
    try {
      zone.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId === sid) stickTo(e.clientX, e.clientY);
    else if (e.pointerId === lid) {
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      if (dx || dy) sink.look(dx, dy);
    }
  });
  const zoneEnd = (e: PointerEvent) => {
    if (e.pointerId === sid) releaseStick();
    else if (e.pointerId === lid) lid = -1;
  };
  zone.addEventListener('pointerup', zoneEnd);
  zone.addEventListener('pointercancel', zoneEnd);
  zone.addEventListener('lostpointercapture', zoneEnd);

  function release(): void {
    if (sid !== -1) releaseStick();
    lid = -1;
    for (const b of [pri, aim, jmp, cro, spr, use, ctxB, pau, pck]) {
      b.pid = -1;
      cls(b.el, 'dn', false);
    }
    wpid = -1;
    if (wheelOpen) closeWheel(false);
    holdBits = 0;
    stickRun = false;
    setMove(0, 0);
    // Every bit goes up now. Latches (crouch, sprint lock, sight) are a state of the player, not
    // of a finger: they stay set here and are told again by sync() when the controls come back.
    for (const k in BTN) {
      const b = BTN[k as keyof typeof BTN];
      if (sent & b) sink.button(b, false);
    }
    sent = 0;
  }
  on(ctx, document, 'visibilitychange', () => document.hidden && release());
  on(ctx, window, 'blur', () => release());

  // ---------------------------------------------------------------- per frame
  let holdQ = -1;
  return {
    el,
    release,
    show(onScreen) {
      if (onScreen === shown) return;
      shown = onScreen;
      cls(el, 'on', onScreen);
      if (onScreen) {
        placeRest();
        sync(); // tell the latches again
      } else release();
    },
    update(dt) {
      t += dt;
      if (!shown) return;
      sync(); // after a release (focus lost) the latched bits are told again
      const me = view.me;
      if (!me) return;
      const down = me.life === 'downed';
      const held = me.held;
      // sprint lock lets go once the player has stopped moving for a while
      if (sid === -1 && latchBits & BTN.SPRINT && t - idleSince > SPRINT_UNLATCH_S) {
        latchBits &= ~BTN.SPRINT;
        sync();
      }
      cls(spr.el, 'lk', (latchBits & BTN.SPRINT) !== 0);
      cls(cro.el, 'lk', (latchBits & BTN.CROUCH) !== 0);
      cls(aim.el, 'lk', aimLatched);
      // the primary button shows what it does with the tool in hand
      const priOn = !down && held !== 'hands' && held !== 'flashlight';
      cls(pri.el, 'off', !priOn);
      if (priOn) setIcon(pri.ic, held === 'rifle' ? 'aim' : held, true);
      const aimOn = !down && (held === 'rifle' || held === 'flashlight' || held === 'flaregun' || held === 'radio');
      cls(aim.el, 'off', !aimOn);
      if (!aimOn && aimLatched) {
        aimLatched = false;
        sync();
      }
      if (aimOn) setIcon(aim.ic, held === 'flashlight' ? 'light' : 'aim', true);
      cls(jmp.el, 'off', down);
      cls(cro.el, 'off', down);
      cls(spr.el, 'off', down);
      cls(whl.el, 'off', down);
      // use: only while there is something to use (or a finger still holds it)
      const f = down ? null : view.hud.focus;
      cls(use.el, 'off', !f && use.pid === -1);
      if (f) {
        txt(useLb, f.verb);
        setIcon(use.ic, f.verb === 'Revive' ? 'revive' : 'hands', true);
        const hq = f.hold === null ? 0 : Math.round(clamp(f.hold, 0, 1) * 100);
        if (hq !== holdQ) {
          holdQ = hq;
          attr(useRing, 'stroke-dasharray', `${hq} 100`);
        }
      }
      // context: reload or the light
      const ca = down ? null : contextAction(me);
      cls(ctxB.el, 'off', !ca);
      if (ca) setIcon(ctxB.ic, ca === 'reload' ? 'reload' : 'light', true);
      cls(ctxB.el, 'lk', ca === 'light' && me.lightOn);
      // wheel button: the tool in hand and its rounds or charge
      setIcon(whl.ic, held === 'hands' ? 'wheel' : held, true);
      const r = toolReadout(me);
      let lb = '';
      if (r) lb = r.big !== '' ? `${r.big}<small>${r.small}</small>` : r.bar >= 0 ? Math.round(r.bar * 100) + '<small>%</small>' : '';
      if ((whlLb as unknown as { _l?: string })._l !== lb) {
        (whlLb as unknown as { _l?: string })._l = lb;
        whlLb.innerHTML = lb;
      }
      cls(whlLb, 'empty', !!r && (r.empty || r.low));
      if (wheelOpen) {
        for (let i = 0; i < WHEEL.length; i++) {
          cls(slots[i], 'no', !hasTool(me, WHEEL[i]));
          cls(slots[i], 'cur', WHEEL[i] === held);
          cls(slots[i], 'hot', i === hot);
        }
        const show = hot >= 0 ? WHEEL[hot] : held;
        txt(twName, TOOL_NAME[show]);
        const rr = toolReadout(me, show);
        txt(twVal, !hasTool(me, show) ? 'Not found' : rr ? (rr.big !== '' ? `${rr.big} ${rr.small}` : rr.bar >= 0 ? Math.round(rr.bar * 100) + '%' : '') : '');
      }
    },
  };
}
