// The game shell: boot, modes, GameActions, the session (Sim + Host + ClientSession joined by the
// loopback transport: single-player IS a local host on the same path a remote one would use), and
// the main loop.
//
// Boot: URL params -> device -> settings -> UI (loading screen) -> engine -> audio -> World
// (createWorld, progress on bus 'loading') -> visual systems (src/game/visuals.ts) -> a new-game
// session behind the title -> warmup (the shaders) -> first frame -> 'title' (or straight to 'play').
// A person (no ?still, ?skipTitle or ?continue) gets the title as the warmup starts, over a veil
// until the world is first drawn: New game then starts the opening while the shaders compile.
//
// Each frame: real time accumulates; the host ticks at exactly 30 Hz (at most 5 catch-up ticks),
// each tick samples one InputCmd (input.ts) and sends it through the session; then the session
// advances, the View is filled, the camera placed, focus picked, the HUD model built, the engine
// renders, sound and UI update. ?still=1 runs no loop: the CS hook (cs.ts) steps it.
// Pause (and losing focus) stops the host in single-player; the pointer is released whenever a UI
// screen is up.
// Owner: GAME.
import { createAudio } from '../audio/index';
import type { AudioApi } from '../audio/api';
import { Bus } from '../core/bus';
import { clamp } from '../core/math';
import type { QualityName } from '../gfx/api';
import { detectDevice, detectDeviceSync, pickQuality } from '../gfx/detect';
import { createEngine, type CsEngine } from '../gfx/engine';
import { U } from '../gfx/shared';
import { ClientSession } from '../net/client';
import { Host } from '../net/host';
import { createLoopback, type Loopback } from '../net/loopback';
import { copyInput, neutralInput } from '../sim/entities';
import { Sim } from '../sim/sim';
import { DT, type Action, type InputCmd, type SimEvent, type ToolId } from '../sim/types';
import { TOOL_ORDER } from '../ui/text';
import { createUI } from '../ui/index';
import { OPENING_FADE, OPENING_SECONDS, OPENING_SKIP_AFTER } from '../ui/opening';
import type { UiApi, UiGame } from '../ui/api';
import { createWorldAsync, type WorldEx } from '../world/index';
import type { World } from '../world/types';
import { BotBrain, litFires, Mind, type BodyLink } from './bots';
import { ViewReader } from './botnav';
import { CameraRig } from './camera';
import { FocusPicker } from './focus';
import { HudModel } from './hudmodel';
import { itemIcon } from './icons';
import { Input } from './input';
import { MapMaker } from './map';
import { readParams, type Params } from './params';
import { SaveStore } from './save';
import { cleanSetting, loadSettings, storeSettings } from './settings';
import { SoundDirector } from './sound';
import type { GameActions, GameBus, Mode, Settings } from './view';
import { ViewImpl } from './viewimpl';
import { addVisualSystems, realSelection, type VisualReport } from './visuals';

const PLAYER_NAME = 'You';
const MAX_CATCHUP = 5;
/** Modes in which the host keeps ticking (single-player pauses in the others). */
const RUNNING: readonly Mode[] = ['play', 'inventory', 'dead', 'won'];
/** Modes that are a game in progress (what a page hide saves). */
const IN_GAME: readonly Mode[] = ['play', 'pause', 'inventory', 'photo', 'dead'];

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

export class Game {
  readonly params: Params;
  readonly bus = new Bus<GameBus>();
  readonly settings: Settings;
  readonly touch: boolean;
  readonly view: ViewImpl;
  readonly save: SaveStore;
  readonly canvas: HTMLCanvasElement;
  readonly input: Input;
  readonly actions: GameActions;
  engine!: CsEngine;
  audio!: AudioApi;
  ui!: UiApi;
  world!: WorldEx;
  visuals: VisualReport | null = null;
  mode: Mode = 'boot';

  // the session
  sim: Sim | null = null;
  host: Host | null = null;
  lb: Loopback | null = null;
  session: ClientSession | null = null;
  /** The session has run no tick yet (the new game waiting behind the title). */
  private fresh = true;
  private bots!: BotBrain;
  private cam!: CameraRig;
  private focus!: FocusPicker;
  private hud!: HudModel;
  private sound!: SoundDirector;
  private mapMaker!: MapMaker;
  private readonly cmd: InputCmd = neutralInput();
  private readonly gpu = { backend: 'webgpu' as 'webgpu' | 'webgl2', adapter: '' };

  // time
  private acc = 0;
  private last = 0;
  /** Milliseconds for the loopback clock: real time when live, stepped time when still. */
  private netClock = 0;
  private looping = false;
  private rafId = 0;
  private lookSet = false;
  private thirdDev = false;
  /** Rendered frames left during which the sky jumps straight to the light (after a debug env change). */
  private skySnaps = 0;
  private tickMs = 0;
  private ticks = 0;
  private framesRendered = 0;
  /**
   * The world has been drawn once (warmup done, a first frame rendered). Until then frames draw nothing:
   * a person may already be on the title or in the opening, with the UI's veil over the scene.
   */
  private drawn = false;
  private bootT0 = 0;
  /** Milliseconds from boot to the first frame on screen. */
  loadMs = 0;
  /** Milliseconds from boot to the title on screen (0 while it has not been up). */
  titleMs = 0;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;
  private bootError: unknown = null;

  constructor(params: Params) {
    this.params = params;
    this.ready = new Promise((r) => (this.readyResolve = r));
    const dev = detectDeviceSync();
    this.touch = params.touch ?? dev.touch;
    this.settings = loadSettings(!params.fresh);
    if (params.quality) this.settings.quality = params.quality;
    if (params.bots !== null) this.settings.bots = params.bots;
    this.save = new SaveStore(!params.noSave);
    let canvas = document.getElementById('game') as HTMLCanvasElement | null;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'game';
      document.body.prepend(canvas);
    }
    this.canvas = canvas;
    this.view = new ViewImpl(null as unknown as World, this.bus, this.settings, this.touch);
    this.actions = this.makeActions();
    this.input = new Input({
      canvas,
      settings: this.settings,
      touch: this.touch,
      dev: params.dev,
      uiOwns: () => (this.ui ? this.ui.wantsPointer() : true),
      // the opening of a new game holds every control (no look, no keys, no buttons) until it is done
      mode: () => (this.opening > 0 ? 'opening' : this.mode),
      act: (a) => this.actions.act(a),
      equip: (t) => this.actions.equip(t),
      cycleTool: (d) => this.cycleTool(d),
      pause: () => this.actions.pause(),
      pack: () => this.actions.openInventory(),
      drop: () => this.drop(),
      toggleThird: () => (this.thirdDev = !this.thirdDev),
      exitPhoto: () => this.actions.photo(false),
    });
  }

  // ======================================================================================== boot

  async start(): Promise<void> {
    try {
      await this.boot();
    } catch (e) {
      this.bootError = e;
      console.error('[game] boot failed', e);
      this.bus.emit('loading', { progress: -1, label: 'The game could not start on this device.' });
      (window as unknown as Record<string, unknown>).DONE = true;
      throw e;
    }
  }

  private loading(progress: number, label: string): void {
    this.bus.emit('loading', { progress, label });
    // the longest stretch the loading line stood still (the browser could not draw), for the tools
    const now = performance.now();
    if (this.loadLast > 0 && now - this.loadLast > this.loadGap.ms) this.loadGap = { ms: now - this.loadLast, before: label };
    if (this.loadLast > 0 && now - this.loadLast > 250) this.loadStalls.push(`${Math.round(now - this.loadLast)} ms before '${label}'`);
    this.loadLast = now;
  }
  private loadLast = 0;
  /** Every stretch over 250 ms without a loading-line update (tools). */
  readonly loadStalls: string[] = [];
  /** The longest gap between two loading-line updates during boot, and the step that ended it. */
  loadGap = { ms: 0, before: '' };

  private async boot(): Promise<void> {
    const p = this.params;
    const bootT0 = (this.bootT0 = performance.now());
    const uiGame: UiGame = {
      view: this.view,
      actions: this.actions,
      touch: this.input.sink,
      icon: (item) => itemIcon(item), // canvas still lifes (icons.ts); the HUD keeps the UI's line icons
      map: () => (this.mapMaker ? this.mapMaker.get() : null),
      gpu: this.gpu,
      sfx: (name) => this.audio?.sfx(name),
    };
    this.ui = createUI(uiGame);
    this.setMode('boot');
    this.loading(0.02, 'Waking the graphics card');
    await nextFrame();

    // --- engine
    const device = await detectDevice();
    const quality = this.qualityName(this.settings.quality, device);
    this.engine = await createEngine(this.canvas, { quality, forceWebGL: p.webgl, dynamicResolution: !p.still && !p.dev, autoQuality: !p.still && !p.dev && this.settings.quality === 'auto', gpuTiming: p.gpu, gpuTimingWebGL: p.gpuGL });
    const engine = this.engine;
    engine.userScale = this.settings.renderScale;
    engine.post.userGrain = this.settings.grain;
    engine.onDeviceLost = () => {
      this.bus.emit('toast', { kind: 'warn', text: 'The graphics device was lost. Reload the page to go on.' });
      this.pauseIfPlaying();
    };
    this.gpu.backend = engine.backend;
    this.gpu.adapter = engine.device.adapter || (engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL2');
    (window as unknown as Record<string, unknown>).BACKEND = engine.backend;

    // --- audio (unlocked by the first gesture)
    this.audio = createAudio();
    this.audio.setVolumes({ master: this.settings.master, music: this.settings.music, sfx: this.settings.sfx });
    const unlock = (): void => {
      this.audio.unlock().catch(() => {});
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(ev, unlock, { capture: true, passive: true });

    // --- the world
    this.loading(0.08, 'Raising the mountain');
    await nextFrame();
    await nextFrame();
    const t0 = performance.now();
    // phase by phase, a frame between phases: the loading line keeps moving (about 1.5 s of work)
    this.world = await createWorldAsync(p.seed, (f, label) => this.loading(0.08 + f * 0.6, label), nextFrame);
    const world = this.world;
    (this.view as unknown as { world: World }).world = world;
    if (p.dev) console.info(`[game] world ${p.seed} built in ${Math.round(performance.now() - t0)} ms`);

    this.bots = new BotBrain(world);
    this.cam = new CameraRig(world);
    this.focus = new FocusPicker(world);
    this.hud = new HudModel(world, this.bus);
    this.sound = new SoundDirector(this.audio, world);
    this.mapMaker = new MapMaker(world);

    // --- what you see
    this.loading(0.72, 'Laying the snow');
    await nextFrame();
    this.visuals = await addVisualSystems(engine, world, realSelection(p.real), (f, label) => this.loading(0.72 + f * 0.13, label), nextFrame);

    // --- a new game waits behind the title
    this.openSession(null);
    this.placeCamera(0);

    // --- the shaders: engine.warmup compiles every pipeline the scene needs (the longest stretch of the
    // load; three spreads it over frames). A person gets the title as it starts, over the UI's veil (the
    // world is not drawn until it is done): New game starts the opening at once, its black, the wind and
    // the two lines, and the compile ends under it; on the title the scene comes up behind the menu when
    // drawn. The tools (?still), ?skipTitle and ?continue keep the loading screen up to the first frame.
    this.loading(0.86, 'Preparing the shaders');
    await nextFrame();
    const warm = engine.warmup();
    const early = !p.still && !p.skipTitle && !(p.cont && this.save.has());
    if (early) {
      this.view.drawn = false;
      this.installListeners();
      this.setMode('title');
      this.startLoop(); // frames run (title, opening, wind) and draw nothing until the shaders are in
    }
    await warm;
    this.loading(1, '');

    if (!early) {
      this.installListeners();
      this.last = performance.now();
      this.netClock = this.last;
      if (p.cont && this.save.has()) this.continueGame(false);
      else if (p.skipTitle) this.newGame(undefined, false);
      else this.setMode('title');
    }

    // the first frame on screen, then tell the tools
    this.drawn = true;
    this.view.drawn = true;
    this.stepFrame(0, true);
    await nextFrame();
    await nextFrame();
    (window as unknown as Record<string, unknown>).DONE = true;
    this.loadMs = performance.now() - bootT0;
    if (p.dev) console.info(`[game] first frame ${Math.round(this.loadMs)} ms after boot`);
    this.mapMaker.start();
    if (!p.still) this.startLoop();
    this.readyResolve?.();
  }

  private qualityName(q: Settings['quality'], device = detectDeviceSync()): QualityName {
    return q === 'auto' ? pickQuality(device) : q;
  }

  private installListeners(): void {
    const still = this.params.still;
    const lost = (): void => {
      if (still) return;
      this.input.release();
      this.pauseIfPlaying();
    };
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.saveNow();
        lost();
      }
    });
    window.addEventListener('pagehide', () => this.saveNow());
    // the opening of a new game: any key, click or tap skips to the fade
    const skip = (): void => {
      if (this.opening > 0 && this.mode === 'play') this.skipOpening();
    };
    for (const ev of ['keydown', 'pointerdown'] as const) window.addEventListener(ev, skip, { capture: true, passive: true });
    document.addEventListener('pointerlockchange', () => {
      // Esc in pointer lock is eaten by the browser: losing the lock while playing is the pause key
      if (!this.input.locked && this.mode === 'play' && !this.touch && !still && this.lockedOnce) this.actions.pause();
      if (this.input.locked) this.lockedOnce = true;
    });
  }
  private lockedOnce = false;

  // ======================================================================================== session

  /** Start a session: a new game (state null) or a loaded one. Replaces the current session. */
  private openSession(state: string | null): void {
    this.closeSession();
    const p = this.params;
    const world = this.world;
    const sim = state
      ? Sim.fromState(world, state, { seed: p.seed, debug: p.dev })
      : new Sim(world, { seed: p.seed, debug: p.dev, players: 1 + this.settings.bots });
    const host = new Host(sim);
    const lb = createLoopback({ wire: p.wire, lagMs: p.lagMs, jitterMs: p.jitterMs });
    host.connect(lb.host);
    const session = new ClientSession(lb.client, { name: PLAYER_NAME });
    session.setWorld(world);
    this.sim = sim;
    this.host = host;
    this.lb = lb;
    this.session = session;
    this.fresh = state === null;
    this.acc = 0;
    this.lookSet = false;
    this.view.attach(session);
    this.hud.reset();
    this.cam.reset();
    this.bots.attach(host, 0);
    this.pump();
  }

  private closeSession(): void {
    this.sound?.stopAll();
    if (this.session) this.session.close();
    if (this.host) this.host.close();
    this.sim = null;
    this.host = null;
    this.lb = null;
    this.session = null;
    this.view.attach(null);
  }

  private get lagged(): boolean {
    return this.params.lagMs > 0 || this.params.jitterMs > 0;
  }

  private pump(): void {
    if (this.lb && this.lagged) this.lb.pump(this.netClock);
  }

  /** Once the welcome is in: take the body's look direction, attach bots. */
  private onJoined(): void {
    const me = this.session?.me;
    if (!me) return;
    this.input.setLook(me.yaw, me.pitch);
    this.lookSet = true;
    this.bots.setLeader(me.id);
    if (this.mode !== 'title' && this.mode !== 'boot') this.bots.set(this.settings.bots);
  }

  // ======================================================================================== modes

  setMode(m: Mode): void {
    if (m === this.mode && this.view.mode === m) return;
    const from = this.mode;
    this.mode = m;
    this.view.mode = m;
    if (m === 'title' && this.titleMs === 0) this.titleMs = performance.now() - this.bootT0;
    if (m !== 'play' && m !== 'photo') {
      this.input.release();
      this.input.exitLock();
    }
    this.bus.emit('mode', { from, to: m });
  }

  private pauseIfPlaying(): void {
    if (this.mode === 'play' || this.mode === 'inventory' || this.mode === 'photo') this.setMode('pause');
  }

  private makeActions(): GameActions {
    return {
      newGame: (seed?: number) => this.newGame(seed, true),
      continueGame: () => this.continueGame(true),
      hasSave: () => this.save.has(),
      resume: () => {
        if (this.mode !== 'pause' && this.mode !== 'inventory' && this.mode !== 'photo') return;
        this.setMode('play');
        this.input.requestLock();
      },
      pause: () => this.pauseIfPlaying(),
      quitToTitle: () => {
        if (IN_GAME.includes(this.mode) && !this.fresh) this.saveNow();
        this.bots.set(0);
        this.opening = 0;
        this.view.opening = 0;
        this.setMode('title');
        this.cam.reset();
      },
      openInventory: () => {
        if (this.mode === 'play') this.setMode('inventory');
      },
      closeInventory: () => {
        if (this.mode !== 'inventory') return;
        this.setMode('play');
        this.input.requestLock();
      },
      setSetting: (key, value) => this.setSetting(key, value),
      act: (a: Action) => {
        if (this.session && this.session.ready) this.session.sendAction(a);
      },
      equip: (tool: ToolId) => {
        if (this.session && this.session.ready) this.session.sendAction({ t: 'equip', tool });
      },
      respawn: () => {
        // a lost game has no respawn (the host refuses it too)
        if (this.mode !== 'dead' || this.view.objective.stage === 'lost') return;
        this.session?.sendAction({ t: 'respawn' });
      },
      photo: (on: boolean) => {
        if (on && this.mode === 'play') this.setMode('photo');
        else if (!on && this.mode === 'photo') {
          this.setMode('play');
          this.input.requestLock();
        }
      },
    };
  }

  /**
   * `opening`: play the opening of a new game first (black, the lines, the fade). On by default when a
   * person starts the game (a gesture); the tools' ?still runs ask for it explicitly.
   */
  newGame(seed: number | undefined, gesture: boolean, opening = gesture && !this.params.still): void {
    if (seed !== undefined && Number.isFinite(seed) && seed !== this.params.seed) {
      // a different mountain needs a new world: reload with the seed (keeps one code path)
      const u = new URL(location.href);
      u.searchParams.set('seed', String(Math.floor(seed)));
      u.searchParams.set('skipTitle', '1');
      location.href = u.toString();
      return;
    }
    // The session behind the title was laid out for 1 + bots players (loot and packs scale with the
    // group): a bots setting changed on the title since then wants a new layout.
    const expected = 1 + this.settings.bots;
    if (!this.fresh || !this.session || !this.sim || this.sim.state.vars['sim.players'] !== expected) this.openSession(null);
    this.save.clear();
    this.cam.reset();
    this.hud.reset();
    // From the title, a new game opens on black: the wind, two lines about the flight, then the fade into
    // the fuselage (ui/opening.ts). The world waits. Tools (?skipTitle, ?still) go straight in unless asked.
    this.opening = opening ? OPENING_SECONDS : 0;
    this.view.opening = this.opening;
    this.setMode('play');
    if (this.session?.me) this.onJoined();
    if (gesture) this.input.requestLock();
  }

  /** Seconds left of the opening of a new game (0 when none). */
  private opening = 0;

  /** A key, click, tap or pad button during the opening: straight to the fade. */
  private skipOpening(): void {
    if (this.opening > OPENING_FADE && OPENING_SECONDS - this.opening >= OPENING_SKIP_AFTER) {
      this.opening = OPENING_FADE;
      this.view.opening = this.opening;
    }
  }

  /** Any pad button pressed since the last frame (the opening's skip). */
  private padPressed(): boolean {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return false;
    let any = false;
    try {
      for (const p of navigator.getGamepads()) if (p && p.connected && p.buttons.some((b) => b.pressed)) any = true;
    } catch {
      return false;
    }
    const edge = any && !this.padHeld;
    this.padHeld = any;
    return edge;
  }
  private padHeld = true;

  continueGame(gesture: boolean): void {
    const raw = this.save.read();
    if (!raw) {
      this.bus.emit('toast', { kind: 'warn', text: 'There is no saved game.' });
      return;
    }
    try {
      this.openSession(raw);
    } catch (e) {
      console.warn('[game] the save could not be loaded', e);
      this.save.clear();
      this.bus.emit('toast', { kind: 'warn', text: 'The saved game could not be loaded. A new one begins.' });
      this.openSession(null);
    }
    this.fresh = false;
    this.cam.reset();
    this.opening = 0;
    this.view.opening = 0;
    this.setMode('play');
    if (this.session?.me) this.onJoined();
    if (gesture) this.input.requestLock();
  }

  saveNow(): boolean {
    if (!this.sim || this.fresh || !IN_GAME.includes(this.mode)) return false;
    // a finished run (won, or lost in co-op) leaves no save behind
    const stage = this.sim.state.objective.stage;
    if (stage === 'won' || stage === 'lost') return false;
    const ok = this.save.write(this.sim.serialize());
    if (ok) this.bus.emit('save', {});
    return ok;
  }

  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const v = cleanSetting(key, value);
    this.settings[key] = v;
    storeSettings(this.settings, !this.params.fresh);
    const e = this.engine;
    switch (key) {
      case 'quality':
        if (e) {
          e.setQuality(this.qualityName(v as Settings['quality']));
          // 'auto' may step a tier down when even the lowest resolution misses the frame target
          e.autoQuality = v === 'auto' && !this.params.still && !this.params.dev;
        }
        break;
      case 'renderScale':
        if (e) e.userScale = v as number;
        break;
      case 'grain':
        if (e) e.post.userGrain = v as boolean;
        break;
      case 'master':
      case 'music':
      case 'sfx':
        this.audio?.setVolumes({ master: this.settings.master, music: this.settings.music, sfx: this.settings.sfx });
        break;
      case 'bots':
        if (this.mode !== 'title' && this.mode !== 'boot') this.bots.set(v as number);
        break;
    }
    this.bus.emit('settings', { key, value: v });
  }

  private cycleTool(dir: 1 | -1): ToolId | null {
    const me = this.view.me;
    if (!me) return null;
    const ring: ToolId[] = ['hands', ...TOOL_ORDER];
    const owned = ring.filter((t) => t === 'hands' || (me.inv[t] ?? 0) > 0);
    if (owned.length < 2) return null;
    const i = Math.max(0, owned.indexOf(me.held));
    return owned[(i + dir + owned.length) % owned.length];
  }

  private drop(): void {
    const me = this.view.me;
    if (!me) return;
    if (me.carry) this.actions.act({ t: 'release' });
    else if (me.held !== 'hands') this.actions.act({ t: 'drop', item: me.held, n: 1 });
  }

  // ======================================================================================== loop

  startLoop(): void {
    if (this.looping) return;
    this.looping = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.looping) return;
      this.rafId = requestAnimationFrame(loop);
      const dt = clamp((now - this.last) / 1000, 0, 0.25);
      this.last = now;
      this.netClock = performance.now();
      this.stepFrame(dt, true);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stopLoop(): void {
    this.looping = false;
    cancelAnimationFrame(this.rafId);
  }

  get live(): boolean {
    return this.looping;
  }

  /** One host tick: sample the input (or let the autopilot play), send it, run the bots, step the host. */
  private tick(): void {
    const s = this.session!;
    if (this.auto && this.view.me) this.autoTick();
    else {
      this.input.sample(this.cmd);
      this.cmd.focus = this.focus.id;
    }
    s.sendInput(this.cmd);
    this.pump();
    this.bots.tick(DT);
    const t0 = performance.now();
    this.host!.tick();
    const ms = performance.now() - t0;
    this.tickMs += (ms - this.tickMs) * 0.05;
    this.ticks++;
    this.fresh = false;
  }

  /** Advance everything by dt seconds of real time; render when asked. */
  stepFrame(dt: number, render: boolean): void {
    const session = this.session;
    const mode = this.mode;
    this.input.update(dt);
    if (this.params.still) this.netClock += dt * 1000;
    this.pump();

    // the opening runs in play mode but holds the world: it counts down only while nothing else is up,
    // and stays black, short of its fade, until the world has been drawn (the shaders may still compile)
    if (this.opening > 0 && mode === 'play') {
      if (this.padPressed()) this.skipOpening();
      this.opening = Math.max(this.drawn ? 0 : OPENING_FADE, this.opening - dt);
      this.view.opening = this.opening;
      if (this.opening === 0) this.padHeld = true;
    }
    // (nor does the world move on before it has been drawn: Continue chosen on the title during the warmup)
    if (session && session.ready && RUNNING.includes(mode) && this.opening <= 0 && this.drawn) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= DT - 1e-7 && n < MAX_CATCHUP) {
        this.tick();
        this.acc -= DT;
        n++;
      }
      if (n === MAX_CATCHUP && this.acc > DT) this.acc = 0; // too far behind: drop the backlog
    } else this.acc = 0;
    this.pump();

    if (session) {
      session.advance(dt);
      if (!this.lookSet && session.me) this.onJoined();
      const evs = session.drainEvents();
      for (let i = 0; i < evs.length; i++) this.onSimEvent(evs[i]);
    }
    // the render clock stands still in the pause menu and in photo mode (a frozen moment)
    if (this.mode !== 'pause' && this.mode !== 'photo') this.view.time += dt;
    this.view.update(dt);
    this.checkMode();

    const title = this.mode === 'title' || this.mode === 'boot';
    if (this.opening > 0 && this.session?.me) this.input.setLook(this.session.me.yaw, this.session.me.pitch);
    this.placeCamera(dt, title);
    const playing = this.mode === 'play';
    const keyLabel = this.touch ? '' : 'E';
    this.view.hud.focus = this.focus.update(this.view, this.view.camera, keyLabel, playing);
    const weather = this.engine.get<{ name: string; update(): void; whiteout?: number }>('weather');
    const wo = weather && typeof weather.whiteout === 'number' ? weather.whiteout : null;
    this.hud.update(this.view, dt, !title, playing, wo);

    if (this.ui && this.ui.wantsPointer() && this.input.locked) this.input.exitLock();
    // (nothing is drawn before the warmup is done: a frame would compile what is left, all at once)
    if (render && this.drawn) {
      if (this.skySnaps > 0) {
        this.skySnaps--;
        this.engine.get<{ name: string; update(): void; snap?: () => void }>('sky')?.snap?.();
      }
      this.engine.frame({ dt, time: this.view.time, view: this.view });
      this.framesRendered++;
    }
    this.sound.update(dt, this.view, this.mode);
    this.ui.update(dt);
  }

  private placeCamera(dt: number, title = this.mode === 'title' || this.mode === 'boot'): void {
    // the shared player position (snow trails, effects that follow the player); camPos is the engine's
    const me = this.view.me;
    if (me) U.playerPos.value.set(me.x, me.y, me.z);
    this.cam.update(dt, this.view, {
      yaw: this.input.yaw,
      pitch: this.input.pitch,
      time: this.view.time,
      third: this.thirdDev,
      photo: this.mode === 'photo',
      title,
    }, this.engine.camera);
  }

  private onSimEvent(ev: SimEvent): void {
    this.hud.onEvent(ev, this.view);
    this.sound.onEvent(ev, this.view);
    this.view.onEvent(ev);
    if (ev.t === 'checkpoint') this.saveNow();
  }

  private checkMode(): void {
    const me = this.view.me;
    const m = this.mode;
    if (m === 'title' || m === 'boot') return;
    const stage = this.view.objective.stage;
    if (stage === 'won' || stage === 'lost') {
      // The run is over either way: nothing to continue (saveNow refuses a finished game from here on).
      if (this.save.has()) this.save.clear();
      if (stage === 'won' && m !== 'won') this.setMode('won');
      // Mode has no 'lost': the end card is the death screen's, which reads the stage (no Respawn).
      else if (stage === 'lost' && m !== 'dead') this.setMode('dead');
      return;
    }
    if (me && me.life === 'dead' && m !== 'dead' && m !== 'won') this.setMode('dead');
    else if (me && me.life !== 'dead' && m === 'dead') this.setMode('play');
  }

  // ======================================================================================== autopilot

  /**
   * The release scenario's player: a bot mind in the 'lead' role plays the LOCAL player through the
   * same path as the devices (one InputCmd per tick into the client session, Actions through
   * GameActions), reading only the client's View. Off by default; CS.auto(true) turns it on.
   */
  private auto: { mind: Mind; reader: ViewReader } | null = null;
  private readonly autoLink: BodyLink = {
    send: (cmd) => {
      copyInput(this.cmd, cmd);
      // the camera looks where the autopilot looks
      this.input.setLook(cmd.yaw, cmd.pitch);
    },
    act: (a) => this.actions.act(a),
  };

  setAuto(on: boolean): void {
    if (!on) {
      this.auto = null;
      return;
    }
    const id = this.view.myId;
    if (!id || !this.world) return;
    this.auto = { mind: new Mind(id, 'lead', 1), reader: new ViewReader(this.world, this.view) };
  }

  /** What the autopilot and each companion are doing (tools). */
  botsDoing(): Record<string, string> {
    const out = this.bots ? this.bots.doing() : {};
    if (this.auto) out.auto = this.auto.mind.doing;
    return out;
  }

  private autoTick(): void {
    const a = this.auto!;
    if (a.mind.id !== this.view.myId) this.setAuto(true); // a new session: a new body
    const pl = this.bots.planner;
    pl.fires = litFires(a.reader, pl.fires);
    this.auto!.mind.tick(a.reader, pl, DT, this.autoLink);
  }

  // ======================================================================================== tools

  /** Hold controls for scripted walking (CS.input), or null to give them back to the devices. */
  holdInput(i: { mx?: number; mz?: number; b?: number } | null): void {
    this.input.scripted = i ? { mx: i.mx ?? 0, mz: i.mz ?? 0, b: i.b ?? 0 } : null;
  }

  /** Teleport the local player through the debug action (dev). */
  teleport(x: number, z: number, yawDeg = 0, pitchDeg = 0): void {
    this.actions.act({ t: 'debug', cmd: 'tp', args: [x, z] });
    // companions come along, a few metres behind (the same debug action, through the bot path)
    const host = this.host;
    if (host) {
      const yaw = (yawDeg * Math.PI) / 180;
      this.bots.ids().forEach((id, i) => {
        const side = i % 2 ? 1 : -1;
        const bx = x + Math.sin(yaw) * (3 + i) + Math.cos(yaw) * side * 1.8;
        const bz = z + Math.cos(yaw) * (3 + i) - Math.sin(yaw) * side * 1.8;
        host.botAct(id, { t: 'debug', cmd: 'tp', args: [bx, bz] });
      });
    }
    this.input.setLook((yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180);
    this.cam.reset();
  }

  look(yawDeg: number, pitchDeg: number): void {
    this.input.setLook((yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180);
  }

  env(o: { storm?: number; clock?: number; lock?: boolean }): void {
    const act = this.actions.act;
    if (o.lock !== undefined) {
      act({ t: 'debug', cmd: 'lockWeather', args: [o.lock ? 1 : 0] });
      act({ t: 'debug', cmd: 'lockClock', args: [o.lock ? 1 : 0] });
    }
    if (o.storm !== undefined) act({ t: 'debug', cmd: 'storm', args: [o.storm] });
    if (o.clock !== undefined) act({ t: 'debug', cmd: 'clock', args: [o.clock] });
    // A tool jumping the weather or the hour wants the new light at once, not after the sky has
    // eased its tables, environment and exposure over many frames (tools render few frames).
    this.skySnaps = 8;
  }

  stats(): Record<string, unknown> {
    const e = this.engine;
    const counts: Record<string, number> = {};
    for (const v of this.view.ents.values()) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
    const me = this.view.me;
    return {
      fps: Math.round(e.stats.fps * 10) / 10,
      frameMs: Math.round(e.stats.frameMs * 100) / 100,
      gpuMs: Math.round(e.stats.gpuMs * 100) / 100,
      calls: e.stats.calls,
      tris: e.stats.tris,
      tickMs: Math.round(this.tickMs * 1000) / 1000,
      ticks: this.ticks,
      frames: this.framesRendered,
      loadMs: Math.round(this.loadMs),
      titleMs: Math.round(this.titleMs),
      loadGap: { ms: Math.round(this.loadGap.ms), before: this.loadGap.before },
      loadStalls: this.loadStalls,
      ents: counts,
      backend: e.backend,
      quality: e.quality.name,
      width: e.width,
      height: e.height,
      mode: this.mode,
      visuals: this.visuals?.used,
      me: me ? { x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2), surface: me.surface, onGround: me.onGround } : null,
      error: this.bootError ? String(this.bootError) : undefined,
    };
  }
}

export async function boot(): Promise<Game> {
  const game = new Game(readParams());
  const p = game.params;
  if (p.dev || p.still) {
    const { installCS } = await import('./cs');
    installCS(game);
  }
  await game.start();
  return game;
}
