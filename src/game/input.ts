// Input: keyboard + mouse (pointer lock), gamepad (standard mapping) and the on-screen touch
// controls (a TouchSink handed to the UI) all merge into one InputCmd per 30 Hz tick and one
// stream of discrete requests. Look is applied as events arrive (no smoothing, no added latency);
// the camera reads `yaw` / `pitch` every rendered frame, the command samples them every tick.
//
// Bindings (DESIGN / brief): WASD move, Shift sprint, Ctrl or C crouch, Space jump, E use (hold),
// left mouse primary, right mouse secondary, R reload, F flashlight, 1-5 tools, Q hands, G drop /
// release the log, B build a fire, Tab pack, M or Esc pause, V third person (dev), wheel cycles
// tools. Pad (ui/text.ts CONTROLS): left stick move (press: sprint), right stick look, A jump,
// B crouch, X use, Y reload, RT primary, LT secondary, LB/RB previous / next tool, D-pad up light,
// View pack, Menu pause.
// Owner: GAME.
import { clamp, wrapAngle } from '../core/math';
import { PITCH_LIMIT } from '../sim/move';
import { BTN, type Action, type InputCmd, type ToolId } from '../sim/types';
import type { Settings, TouchSink } from './view';

/** What the input layer asks of the game. */
export interface InputHost {
  readonly canvas: HTMLCanvasElement;
  readonly settings: Settings;
  /** Touch device: no pointer lock, the on-screen controls report through `sink`. */
  readonly touch: boolean;
  readonly dev: boolean;
  /** A UI screen owns keys, mouse and pad (title, pause, inventory, dead, won). */
  uiOwns(): boolean;
  /** 'play' or 'photo': look and game keys are live. */
  mode(): string;
  act(a: Action): void;
  equip(tool: ToolId): void;
  /** The tool to equip next / before the held one (only owned tools), or null. */
  cycleTool(dir: 1 | -1): ToolId | null;
  pause(): void;
  pack(): void;
  /** G: drop what is in hand, or put the heavy log down. */
  drop(): void;
  toggleThird(): void;
  exitPhoto(): void;
}

const TOOL_KEYS: Record<string, ToolId> = { Digit1: 'axe', Digit2: 'flashlight', Digit3: 'flaregun', Digit4: 'rifle', Digit5: 'radio', KeyQ: 'hands' };
/** Keys whose browser default (focus moves, scrolling, find) must not happen while playing. */
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight', 'KeyC', 'KeyE', 'KeyR', 'KeyF', 'KeyQ', 'KeyG', 'KeyB', 'KeyM', 'KeyV', 'Digit1', 'Digit2',
  'Digit3', 'Digit4', 'Digit5', 'Slash', 'Quote',
]);

/** Radians of turn per mouse count at sensitivity 1 (about 0.13 degrees). */
const MOUSE_RAD = 0.0022;
/** Radians per CSS pixel of a touch drag at sensitivity 1. */
const TOUCH_RAD = 0.0055;
/** Full right-stick deflection turns this fast, rad/s, at sensitivity 1. */
const PAD_YAW_RATE = 2.9;
const PAD_PITCH_RATE = 1.9;
const PAD_DEAD = 0.16;
/** Chrome sometimes reports a huge jump in movementX after the lock is taken: ignore those. */
const MOUSE_SPIKE = 400;

function deadzone(x: number, y: number, dz: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

export class Input {
  /** Look direction, radians. Yaw 0 looks north (-Z), positive turns left; pitch positive looks up. */
  yaw = 0;
  pitch = 0;
  /** Scripted hold (CS.input): overrides the devices while set. */
  scripted: { mx: number; mz: number; b: number } | null = null;
  readonly sink: TouchSink;

  private readonly host: InputHost;
  private readonly keys = new Set<string>();
  private mouseBits = 0;
  private touchBits = 0;
  private padBits = 0;
  /** Buttons that went down since the last sample (a tap shorter than a tick still counts). */
  private pressed = 0;
  private touchMx = 0;
  private touchMz = 0;
  private padMx = 0;
  private padMz = 0;
  private padSprint = false;
  private padIdle = 0;
  private padPrev: boolean[] = [];
  private padIndex = -1;
  private lockSwallow = false;
  private wheelAt = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(host: InputHost) {
    this.host = host;
    const self = this;
    this.sink = {
      move(x: number, z: number) {
        self.touchMx = clamp(Number.isFinite(x) ? x : 0, -1, 1);
        self.touchMz = clamp(Number.isFinite(z) ? z : 0, -1, 1);
      },
      look(dx: number, dy: number) {
        if (!self.lookLive() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        const k = TOUCH_RAD * self.host.settings.sensitivity;
        self.turn(-dx * k, -dy * k);
      },
      button(btn: number, down: boolean) {
        if (down) {
          if (!(self.touchBits & btn)) self.pressed |= btn;
          self.touchBits |= btn;
        } else self.touchBits &= ~btn;
      },
    };
    this.listen(window, 'keydown', (e) => this.keyDown(e as KeyboardEvent));
    this.listen(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).code));
    this.listen(host.canvas, 'mousedown', (e) => this.mouseDown(e as MouseEvent));
    this.listen(window, 'mouseup', (e) => this.mouseUp(e as MouseEvent));
    this.listen(window, 'mousemove', (e) => this.mouseMove(e as MouseEvent));
    this.listen(host.canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(host.canvas, 'wheel', (e) => this.wheel(e as WheelEvent), { passive: true });
    this.listen(window, 'blur', () => this.release());
    this.listen(document, 'visibilitychange', () => document.hidden && this.release());
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.cleanup.push(() => t.removeEventListener(type, fn, opts));
  }

  dispose(): void {
    for (const f of this.cleanup.splice(0)) f();
  }

  // ---------------------------------------------------------------- state

  get locked(): boolean {
    return typeof document !== 'undefined' && document.pointerLockElement === this.host.canvas;
  }

  private lookLive(): boolean {
    const m = this.host.mode();
    return (m === 'play' || m === 'photo') && !this.host.uiOwns();
  }

  private gameLive(): boolean {
    return this.host.mode() === 'play' && !this.host.uiOwns();
  }

  /** Set the look direction (spawn, teleport, CS.look, a loaded game). */
  setLook(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  private turn(dyaw: number, dpitch: number): void {
    this.yaw = wrapAngle(this.yaw + dyaw);
    const inv = this.host.settings.invertY ? -1 : 1;
    this.pitch = clamp(this.pitch + dpitch * inv, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Let go of everything held (focus lost, screen change). Look direction stays. */
  release(): void {
    this.keys.clear();
    this.mouseBits = 0;
    this.padBits = 0;
    this.pressed = 0;
    this.padMx = this.padMz = 0;
    this.padSprint = false;
    // touch bits are told again by the UI's touch layer (latches) when it comes back
  }

  // ---------------------------------------------------------------- pointer lock

  /** Ask for pointer lock. Only works inside a user gesture; harmless otherwise. */
  requestLock(): void {
    const c = this.host.canvas as HTMLCanvasElement & { requestPointerLock(o?: unknown): Promise<void> | void };
    if (this.host.touch || this.locked || typeof c.requestPointerLock !== 'function') return;
    if (!navigator.userActivation?.isActive) return; // would be refused (and logged) without a gesture
    this.lockSwallow = true;
    try {
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          // raw input not supported here: the plain lock
          try {
            const q = c.requestPointerLock();
            if (q && typeof (q as Promise<void>).catch === 'function') (q as Promise<void>).catch(() => {});
          } catch {
            /* refused */
          }
        });
      }
    } catch {
      /* refused */
    }
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock?.();
  }

  // ---------------------------------------------------------------- keyboard and mouse

  private keyDown(e: KeyboardEvent): void {
    if (this.host.uiOwns()) return;
    const mode = this.host.mode();
    const code = e.code;
    if (mode === 'photo') {
      if (code === 'Escape' || code === 'KeyM' || code === 'KeyP') {
        e.preventDefault();
        this.host.exitPhoto();
      }
      return;
    }
    if (mode !== 'play') return;
    if (e.ctrlKey && code !== 'ControlLeft' && code !== 'ControlRight' && code !== 'KeyC') return; // browser shortcuts
    if (GAME_KEYS.has(code) || code === 'Escape') e.preventDefault();
    if (e.repeat) return;
    this.keys.add(code);
    switch (code) {
      case 'Escape':
      case 'KeyM':
        this.host.pause();
        return;
      case 'Tab':
        this.host.pack();
        return;
      case 'KeyR':
        this.host.act({ t: 'reload' });
        return;
      case 'KeyF':
        this.host.act({ t: 'toggleLight' });
        return;
      case 'KeyG':
        this.host.drop();
        return;
      case 'KeyB':
        this.host.act({ t: 'buildFire' });
        return;
      case 'KeyV':
        if (this.host.dev) this.host.toggleThird();
        return;
      case 'Space':
        this.pressed |= BTN.JUMP;
        return;
      case 'KeyE':
        this.pressed |= BTN.USE;
        return;
    }
    const tool = TOOL_KEYS[code];
    if (tool) this.host.equip(tool);
  }

  private mouseDown(e: MouseEvent): void {
    if (this.host.touch || this.host.uiOwns()) return;
    const mode = this.host.mode();
    if (mode !== 'play' && mode !== 'photo') return;
    if (!this.locked) {
      // the click that takes the lock does nothing else
      this.requestLock();
      return;
    }
    if (mode !== 'play') return;
    const bit = e.button === 0 ? BTN.PRIMARY : e.button === 2 ? BTN.SECONDARY : 0;
    if (bit) {
      this.mouseBits |= bit;
      this.pressed |= bit;
    }
  }

  private mouseUp(e: MouseEvent): void {
    const bit = e.button === 0 ? BTN.PRIMARY : e.button === 2 ? BTN.SECONDARY : 0;
    this.mouseBits &= ~bit;
  }

  private mouseMove(e: MouseEvent): void {
    if (!this.locked || !this.lookLive()) return;
    let dx = e.movementX || 0, dy = e.movementY || 0;
    if (this.lockSwallow) {
      // the first event after taking the lock carries the jump from the old cursor position
      this.lockSwallow = false;
      return;
    }
    if (Math.abs(dx) > MOUSE_SPIKE || Math.abs(dy) > MOUSE_SPIKE) return;
    const k = MOUSE_RAD * this.host.settings.sensitivity;
    this.turn(-dx * k, -dy * k);
  }

  private wheel(e: WheelEvent): void {
    if (!this.gameLive() || !this.locked) return;
    const now = performance.now();
    if (now - this.wheelAt < 140 || Math.abs(e.deltaY) < 1) return;
    this.wheelAt = now;
    const t = this.host.cycleTool(e.deltaY > 0 ? 1 : -1);
    if (t) this.host.equip(t);
  }

  private keyBits(): number {
    const k = this.keys;
    let b = 0;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) b |= BTN.SPRINT;
    if (k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC')) b |= BTN.CROUCH;
    if (k.has('Space')) b |= BTN.JUMP;
    if (k.has('KeyE')) b |= BTN.USE;
    return b;
  }

  // ---------------------------------------------------------------- gamepad

  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return null;
    }
    if (this.padIndex >= 0) {
      const p = pads[this.padIndex];
      if (p && p.connected) return p;
      this.padIndex = -1;
    }
    for (const p of pads) {
      if (p && p.connected && (p.mapping === 'standard' || p.buttons.length >= 16)) {
        this.padIndex = p.index;
        return p;
      }
    }
    return null;
  }

  /** Once per rendered frame: poll the pad, turn with the right stick. */
  update(dt: number): void {
    const p = this.pad();
    if (!p) {
      this.padBits = 0;
      this.padMx = this.padMz = 0;
      return;
    }
    const btn = (i: number, th = 0.5) => {
      const b = p.buttons[i];
      return !!b && (b.pressed || b.value > th);
    };
    const now: boolean[] = [];
    for (let i = 0; i < 17; i++) now[i] = btn(i, i === 6 || i === 7 ? 0.35 : 0.5);
    const edge = (i: number) => now[i] && !this.padPrev[i];
    const live = !this.host.uiOwns();
    const mode = this.host.mode();
    if (live && mode === 'play') {
      const [lx, ly] = deadzone(p.axes[0] ?? 0, p.axes[1] ?? 0, PAD_DEAD);
      this.padMx = lx;
      this.padMz = -ly;
      if (edge(10)) this.padSprint = !this.padSprint;
      if (Math.hypot(lx, ly) < 0.2) {
        this.padIdle += dt;
        if (this.padIdle > 0.35) this.padSprint = false;
      } else this.padIdle = 0;
      let b = 0;
      if (now[0]) b |= BTN.JUMP;
      if (now[1]) b |= BTN.CROUCH;
      if (now[2]) b |= BTN.USE;
      if (now[7]) b |= BTN.PRIMARY;
      if (now[6]) b |= BTN.SECONDARY;
      if (this.padSprint) b |= BTN.SPRINT;
      this.pressed |= b & ~this.padBits;
      this.padBits = b;
      if (edge(3)) this.host.act({ t: 'reload' });
      if (edge(12)) this.host.act({ t: 'toggleLight' });
      if (edge(4) || edge(5)) {
        const t = this.host.cycleTool(edge(5) ? 1 : -1);
        if (t) this.host.equip(t);
      }
      if (edge(8)) this.host.pack();
      if (edge(9)) this.host.pause();
    } else {
      this.padBits = 0;
      this.padMx = this.padMz = 0;
      if (live && mode === 'photo' && (edge(9) || edge(1))) this.host.exitPhoto();
    }
    if (live && (mode === 'play' || mode === 'photo')) {
      const [rx, ry] = deadzone(p.axes[2] ?? 0, p.axes[3] ?? 0, PAD_DEAD);
      if (rx || ry) {
        // a curve: fine aim near the centre, fast turns at the rim
        const cx = rx * Math.abs(rx), cy = ry * Math.abs(ry);
        const s = this.host.settings.sensitivity;
        this.turn(-cx * PAD_YAW_RATE * s * dt, -cy * PAD_PITCH_RATE * s * dt);
      }
    }
    this.padPrev = now;
  }

  // ---------------------------------------------------------------- the command

  /** Fill `out` with this tick's command (seq is set by the session, focus by the game). */
  sample(out: InputCmd): InputCmd {
    out.yaw = this.yaw;
    out.pitch = this.pitch;
    const s = this.scripted;
    if (s) {
      out.mx = clamp(s.mx, -1, 1);
      out.mz = clamp(s.mz, -1, 1);
      out.b = s.b | 0;
      this.pressed = 0;
      return out;
    }
    if (!this.gameLive()) {
      out.mx = out.mz = 0;
      out.b = 0;
      this.pressed = 0;
      return out;
    }
    const k = this.keys;
    let kx = 0, kz = 0;
    if (k.has('KeyD') || k.has('ArrowRight')) kx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) kx -= 1;
    if (k.has('KeyW') || k.has('ArrowUp')) kz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) kz -= 1;
    let mx = kx + this.padMx + this.touchMx;
    let mz = kz + this.padMz + this.touchMz;
    const m = Math.hypot(mx, mz);
    if (m > 1) {
      mx /= m;
      mz /= m;
    }
    out.mx = mx;
    out.mz = mz;
    const held = this.keyBits() | this.mouseBits | this.padBits | this.touchBits;
    // JUMP is level-triggered in the sim: send it only on the tick after a press
    out.b = (held & ~BTN.JUMP) | this.pressed;
    this.pressed = 0;
    return out;
  }
}
