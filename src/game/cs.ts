// window.CS: the tool hook (present with ?dev=1 or ?still=1). tools/play.mjs scenarios drive the
// real game through it.
//   CS.ready                       promise: boot finished, first frame on screen
//   CS.step(n = 1, dt = 1/30)      advance n frames of dt seconds (host ticks at 30 Hz inside),
//                                  rendering the last one; deterministic under ?still=1
//   CS.play() / CS.pause()         real-time loop on / off (under ?still=1), or the game's own pause
//   CS.go(x, z, yawDeg, pitchDeg)  teleport the local player (debug action 'tp': stays on the action path)
//   CS.look(yawDeg, pitchDeg)      set the look direction
//   CS.env({ storm, clock, lock }) weather / hour overrides (debug actions)
//   CS.act(action)                 send an Action;  CS.equip(tool)
//   CS.input({ mx, mz, b }) | null hold controls for scripted walking
//   CS.give(item, n)               put items in the local player's pack (host side, dev only)
//   CS.view, CS.engine, CS.sim (host side), CS.session, CS.world, CS.game
//   CS.stats()                     fps, frame ms, draw calls, triangles, tick ms, entity counts, backend, quality
//   CS.shotReady()                 resolves when the last rendered frame is on screen
//   CS.mode(m)                     'title' | 'play' | 'pause' | 'inventory' | 'photo' (through GameActions)
// Owner: GAME.
import type { Action, ItemId, PlayerEnt, ToolId } from '../sim/types';
import type { Game } from './game';

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

export function installCS(game: Game): void {
  const cs = {
    ready: game.ready,
    game,
    get view() {
      return game.view;
    },
    get engine() {
      return game.engine;
    },
    get sim() {
      return game.sim;
    },
    get session() {
      return game.session;
    },
    get world() {
      return game.world;
    },
    step(n = 1, dt = 1 / 30): Record<string, unknown> {
      n = Math.max(1, Math.floor(n));
      for (let i = 0; i < n; i++) game.stepFrame(dt, i === n - 1);
      return game.stats();
    },
    play(): void {
      if (game.params.still) {
        // hand the clock to the real-time loop
        game.startLoop();
      }
      if (game.mode === 'pause' || game.mode === 'title') game.actions.resume();
    },
    pause(): void {
      if (game.live && game.params.still) game.stopLoop();
      else game.actions.pause();
    },
    go(x: number, z: number, yawDeg = 0, pitchDeg = 0): void {
      game.teleport(x, z, yawDeg, pitchDeg);
      // apply at once: the action reaches the host now, the snapshot on the next tick
      game.stepFrame(1 / 30, false);
      game.stepFrame(1 / 30, false);
    },
    look(yawDeg: number, pitchDeg = 0): void {
      game.look(yawDeg, pitchDeg);
    },
    env(o: { storm?: number; clock?: number; lock?: boolean }): void {
      game.env(o);
    },
    act(a: Action): void {
      game.actions.act(a);
    },
    equip(tool: ToolId): void {
      game.actions.equip(tool);
    },
    input(i: { mx?: number; mz?: number; b?: number } | null): void {
      game.holdInput(i);
    },
    give(item: ItemId, n = 1): boolean {
      const sim = game.sim;
      const id = game.view.myId;
      if (!sim || !id) return false;
      const p = sim.ctx.get<PlayerEnt>(id);
      if (!p) return false;
      p.inv[item] = (p.inv[item] ?? 0) + n;
      return true;
    },
    mode(m: string): void {
      const a = game.actions;
      if (m === 'play') {
        if (game.mode === 'title') a.newGame();
        else if (game.mode === 'inventory') a.closeInventory();
        else if (game.mode === 'photo') a.photo(false);
        else a.resume();
      } else if (m === 'pause') a.pause();
      else if (m === 'inventory') a.openInventory();
      else if (m === 'photo') a.photo(true);
      else if (m === 'title') a.quitToTitle();
    },
    stats(): Record<string, unknown> {
      return game.stats();
    },
    async shotReady(): Promise<void> {
      await frame();
      await frame();
    },
  };
  (window as unknown as Record<string, unknown>).CS = cs;
}
