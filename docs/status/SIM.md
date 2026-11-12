# SIM + NET handoff note

Owner files: src/sim/** (except types.ts, api.ts), src/net/** (except protocol.ts).

## Status: complete (session 2, 2026-11-12)
Everything in docs/briefs/SIM.md exists, type-checks (whole project: 0 errors) and is tested.
67 tests in my files pass (move 23, sim 22, net 22); `npx vitest run` (all modules) passes.

Files: src/sim/sim.ts, entities.ts, move.ts, testworld.ts, testkit.ts (test helpers), systems/index.ts,
systems/env.ts, systems/players.ts, systems/spawn.ts; src/net/loopback.ts, host.ts, client.ts;
tests: src/sim/move.test.ts, src/sim/sim.test.ts, src/net/net.test.ts.

Session 2 changes: fixed loopback type error; Sim clears a spent `removed` list at the start of step()
(host resent stale ids); optional System.leave hook (api.ts) called by Sim.removePlayer, players.ts deletes
its per-player vars there; copyInput / ENTITY_KINDS moved to entities.ts (re-exported by sim.ts); spawn runs
FIRST so later init hooks see spawned entities; life 'rescued' freezes movement; host snapshot loop survives a
client leaving mid-loop and clones with spread (3x faster); wrote ClientSession and all tests.

Measured: Sim.step() 4 players + 12 wolves + 600 statics ~0.015-0.03 ms; host tick + 2 client frames ~0.1 ms.

## How to wire it (GAME)
    const sim = new Sim(world, { seed, debug: dev, players: 1 + bots });   // or Sim.fromState(world, json, { seed })
    const host = new Host(sim);
    const lb = createLoopback({ wire, lagMs });       // 'ref' default; 'json' serialises every message
    host.connect(lb.host);
    const session = new ClientSession(lb.client, { name });  // ready at once without lag
    session.setWorld(world);                          // turns on prediction
    per frame: lb.pump(now) (only needed with lag); for each 30 Hz tick { session.sendInput(cmd); host.tick(); }
               session.advance(dt); for (const ev of session.drainEvents()) bus.emit('sim', ev);
    bots:      const b = host.addBot(name); host.setBotInput(b.id, cmd); host.botAct(b.id, action); host.removeBot(id)
    save:      sim.serialize()  (SimState JSON)
    debug:     session.sendAction({ t: 'debug', cmd: 'storm'|'clock'|'lockWeather'|'lockClock'|'tp', args }) needs debug: true

## API facts
- Sim: constructor(world, opts, systems = SYSTEMS, state?); static fromState(world, state|json, opts, systems?);
  addPlayer(name, { bot }), removePlayer(id) (runs leave hooks), setInput(id, cmd) (copied, stays in force until
  replaced), act(id, a): boolean, step(): SimEvent[], serialize(), state, ctx, removed (ids removed since the last
  step returned). MAX_PLAYERS = 4. Per-player vars convention: '<system>.<name>.<id>', delete them in leave.
- move.ts: stepPlayerMove(p, cmd, world, dt) pure; movePlayer(...) = stepPlayerMove + step/jump/land events with a
  Gait. Constants: PLAYER_RADIUS 0.32, PLAYER_HEIGHT, CROUCH_HEIGHT, EYE_STAND 1.66, EYE_CROUCH 1.02, EYE_DOWNED,
  EYE_SWIM, STEP_HEIGHT 0.4, WALK/SPRINT/CROUCH/CRAWL/DRAG/SWIM_SPEED, JUMP_SPEED, GRAVITY, PITCH_LIMIT.
  JUMP is level-triggered (the function cannot see the previous command): send it as a one-tick pulse or holding
  it hops again on landing.
- env.ts exports stormAt(seed, t), whiteoutWindow, visibilityFor, nightAt, DAY_SECONDS, WHITEOUT, VIS_*, WIND_*.
- Host: connect(t), tick(): SimEvent[] (the tick's events), addBot, removeBot, setBotInput, botAct, close(),
  clients. Inputs: one queued command per player per tick (backlog > 5 skips to 2, buttons OR-ed); 15 silent ticks
  release movement. Disconnect removes the player. A client joining a loaded game takes back a free body (same name
  first). Full game -> 'refuse'.
- ClientSession: seed, myId, ready, closed, refused, ents (Map, stable ViewEnt per id), me, env, objective, ice,
  stats, version (bumps when the entity set changes), list(kind) (one live array per kind), tick, time, ack,
  predicted (raw), unacked; sendInput(cmd) (copies it, ASSIGNS seq, predicts, sends the last <= 3 unacked),
  sendAction(a), setWorld(w), advance(dt), drainEvents() (frozen empty array when none), close().
  Remote ents are shown INTERP_DELAY = 0.1 s in the past; they appear and vanish at their presentation tick.
  Events about the local player (id / by / toast to == myId) are released on arrival; its step/jump/land come from
  the prediction and the host's copies are dropped. me's position is smoothed across the tick (prev -> predicted by
  time since the last command) plus a fading correction (snap > 1.5 m). Prediction stops 45 commands (1.5 s) ahead
  of a host that stops acking: stop calling sendInput while the solo host is paused.

## Test commands
- npx tsc --noEmit -p .   (filter: | grep -E "src/(sim|net)/")
- npx vitest run src/sim src/net

## Final report
SIM + NET is complete. The whole project type-checks (0 errors). 67 tests in my files pass (`npx vitest run src/sim src/net`), and the full `npx vitest run` passes.

Files: src/sim/sim.ts, entities.ts, move.ts, testworld.ts, testkit.ts, systems/{index,env,players,spawn}.ts; src/net/loopback.ts, host.ts, client.ts; tests in move.test.ts, sim.test.ts, net.test.ts. Notes: docs/status/SIM.md.

API:
- `new Sim(world, opts, systems = SYSTEMS)`, `Sim.fromState(world, stateOrJson, opts, systems?)`; `addPlayer(name, { bot? }): PlayerEnt`, `removePlayer(id)`, `setInput(id, cmd)` (stays in force until replaced), `act(id, a): boolean`, `step(): SimEvent[]`, `serialize()`, `state`, `ctx`.
- `stepPlayerMove(p, cmd, world, dt)`; `movePlayer(p, cmd, world, dt, gait, emit)` (adds step/jump/land events). Exports EYE_STAND, EYE_CROUCH, EYE_DOWNED, EYE_SWIM, PLAYER_RADIUS, PLAYER_HEIGHT, STEP_HEIGHT and the speeds.
- `createLoopback({ wire, lagMs, jitterMs })` returns `{ client, host, pump(nowMs) }`. With no lag, delivery is synchronous.
- `new Host(sim)`: `connect(t)`, `tick(): SimEvent[]` (the brief said void; it returns the tick's events), `addBot(name)`, `setBotInput(id, cmd)`, `botAct(id, a)`, `removeBot(id)`, `close()`.
- `new ClientSession(t, { name })`: `seed`, `myId`, `ready`, `closed`, `refused`, `ents`, `me`, `env`, `objective`, `ice`, `stats`, `version`, `list(kind)`, `predicted`, `sendInput(cmd)`, `sendAction(a)`, `setWorld(world)`, `advance(dt)`, `drainEvents()`, `close()`.
- Loop: each tick `session.sendInput(cmd); host.tick();`. Each frame `lb.pump(now)` (only with lag), then `session.advance(dt)`, then `drainEvents()`.

Contract addition: optional `System.leave?(ctx, player)` in src/sim/api.ts. `removePlayer` runs it before the entity is removed. Session 1 added `PlayerEnt.carryPair`.

Notes for GAME:
- `sendInput` copies the command and sets its seq itself.
- JUMP is level-triggered: send it as a one-tick pulse, or holding it hops again on landing.
- The local player's own events arrive at once; its step/jump/land come from the prediction. `me` is smoothed across the tick; `predicted` is the raw state.
- Stop calling `sendInput` while the solo host is paused (prediction stops 1.5 s ahead anyway).
- When a client disconnects, its player is removed. Nothing drops their items yet.

Fixed: the loopback type error; the host resending stale removed ids every tick; spawn now runs first so later init hooks see entities; 'rescued' players no longer move.

Performance: `step()` with 4 players, 12 wolves and 600 statics takes about 0.02 ms; a host tick plus client frames about 0.1 ms. In the real world, movement cost depends on WORLD's `collidersNear` and `groundAt`.
