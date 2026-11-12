# Brief: SIM
(Read docs/briefs/COMMON.md first.)

YOUR MODULE: SIM + NET (owner tags SIM and NET in DESIGN.md).
Files you own: src/sim/** except types.ts and api.ts (those are frozen contracts); src/net/** except protocol.ts.

Build:
1. src/sim/sim.ts — class Sim: constructor(world: World, opts: SimOptions, systems?: System[]) creates a fresh
   SimState and runs each system's init; static Sim.fromState(world, state, opts, systems?) resumes a saved one.
   Methods: addPlayer(name, o?: { bot?: boolean }): PlayerEnt (uses world.spawn.players[slot]); removePlayer(id);
   setInput(id, cmd: InputCmd); act(id, a: Action); step(): SimEvent[] (exactly one 1/30 s tick: systems in order,
   then returns and clears the tick's events); serialize(): string; readonly state; readonly ctx: SimCtx.
   Implement SimCtx fully (entity table with an id->index map kept outside the JSON state and rebuilt on load,
   per-kind cached lists, pressed/held edge detection from previous tick's buttons, rand() on state.rng via
   core/rng rngStep, v/setV, touch -> rev++). The state must survive JSON.parse(JSON.stringify(state)) exactly:
   test that a run continued from a serialised copy produces identical states to the uninterrupted run.
2. src/sim/entities.ts — factories with sane defaults for every entity kind (makePlayer, makeWolf, makeFire, ...)
   so systems spawn complete, well-formed objects.
3. src/sim/move.ts — export function stepPlayerMove(p: PlayerEnt, cmd: InputCmd, world: World, dt: number): void.
   A PURE function of its arguments (it mutates only p's movement fields: x y z vx vy vz yaw pitch onGround crouch
   sprint surface swim stamina). The host and the predicting client both call it, so it may read only p, cmd and
   world. Feel: walking 2.6 m/s, sprint 4.6 (drains stamina about 12 s full to empty, regenerates when not
   sprinting, slower when p.core is low), crouch 1.3, jump 4.3 m/s with gravity about 14, acceleration that feels
   weighty not floaty, deep snow slows (world.snowDepthAt 0.5 m -> about 60 % speed), ice is slippery (low
   friction), slopes steeper than about 42 degrees cannot be climbed and slide the player down, step height 0.4 m,
   player radius 0.32 m, collide and slide against world.collidersNear, stand on world.groundAt floors, soft clamp at
   the world edge. Speed modifiers that come from p itself: life 'downed' crawls at 0.5 m/s; carrying a heavy log
   (p.carry) 1.2 m/s alone; core below 33 slows up to 25 %; swim (through the ice) 0.8 m/s and no jump. Eye height
   is presentation, not here. Export the constants presentation needs (EYE_STAND, EYE_CROUCH, PLAYER_RADIUS ...).
4. src/sim/systems/index.ts — export const SYSTEMS: System[] in tick order, each system its own file in
   src/sim/systems/. Other engineers will add systems later (thermal, fire, wolves, tools, ice, objective ...), each
   as one file plus one line here: keep the file tidy and commented with the intended order.
   Write these now:
   - env.ts: the clock and the weather. A day is 1440 s; the game starts at clock 16.5. Storm is a seeded
     smooth curve over time with scripted beats: moderate at the start (about 0.45), a clear spell around minutes
     6 to 12, at least two whiteouts (storm > 0.9, lasting 2 to 4 minutes) in the first 50 minutes, and forced to
     full storm while objective.stage is 'holdout'. Derive wind (direction drifts slowly, speed 2 to 22 m/s with
     storm), gust (bursts, emit 'gust' events), snowfall, visibility (4000 m clear down to about 6 m in a
     whiteout), airTemp (about -8 C in the day down to -24 C at night, colder in storms), cloud, aurora (clear
     nights only), snowAccum. Support debug overrides through Action { t:'debug' } when sim.debug:
     cmd 'storm' [v], 'clock' [hours], 'lockWeather' [0|1], 'tp' [x, z], 'give' is handled elsewhere later.
   - players.ts: apply each player's InputCmd through stepPlayerMove, set p.seq, emit 'step' events with the right
     surface on a stride cadence that follows speed, 'jump' and 'land', handle the 'equip' action (only tools the
     player has; 'hands' always), track stats.distance. New players start with flashlight, matches x6, and hands.
   - spawn.ts: on init turn world.spawn.defs into entities.
5. src/sim/testworld.ts — a small deterministic stub that implements the whole World interface (gentle slope,
   a few colliders, one floor, one shelter, a lake patch, spawn tables) so sim and net tests do not need the real
   world generator (another engineer is writing src/world right now; createWorld(seed) will exist at
   src/world/index.ts when you are done, do not depend on it in tests).
6. src/net/loopback.ts — createLoopback(opts: LoopbackOptions): { client: ClientTransport; host: HostSideTransport;
   pump(nowMs) } per protocol.ts: 'ref' or 'json' wire, optional lag and jitter (deterministic jitter, seeded).
7. src/net/host.ts — class Host: constructor(sim); connect(t: HostSideTransport): void (handles hello -> welcome
   with the full state, input, act, bye); tick(): void steps the sim once and sends each client a Snapshot
   (DYNAMIC_KINDS every tick, other entities only when their rev changed since last sent to that client, removed
   ids, changed ice cells, the tick's events, ack = that player's seq). Snapshot entities must be copies (the sim
   keeps mutating its own objects). addBot(name) adds a player with no transport; setBotInput(id, cmd).
8. src/net/client.ts — class ClientSession: constructor(t: ClientTransport, o: { name: string }). After 'welcome'
   it exposes seed, myId, ready. sendInput(cmd) keeps the command for prediction and sends it (batch the last few
   for loss tolerance); sendAction(a). setWorld(world) enables prediction. advance(dtSeconds) moves the
   presentation clock: remote entities are interpolated about 100 ms in the past between snapshots (position, yaw
   with angle wrap; other fields from the newer snapshot), the local player is predicted (authoritative state from
   the newest snapshot, then every un-acked command re-applied with stepPlayerMove; smooth small corrections, snap
   large ones). Expose: ents: Map<NetId, ViewEnt> (stable object identity per id across frames), me, env
   (interpolated), objective, ice: Map<number, IceCell>, stats, and drainEvents(): SimEvent[] (events whose
   presentation time has arrived; events about the local player's own predicted movement such as 'step' are
   delivered immediately). Must work identically with wire 'ref', wire 'json', and 150 ms lag.
9. Tests (vitest, *.test.ts next to the code, run with npx vitest run): determinism (same seed and inputs ->
   identical serialised state), save/continue equivalence, movement (walks at the right speed on flat snow,
   cannot climb a cliff, slides on ice, collides with a cylinder, stamina), JSON-safety of state and every
   message, host/client over loopback with json wire and lag (client's predicted position converges to the
   host's, remote entity interpolates, events arrive once), snapshot deltas (static entity not resent when
   unchanged). All tests must pass.

Performance: step() with 4 players, 12 wolves and 600 static entities must take well under 1 ms. No per-tick
allocation in hot loops beyond the snapshot copies.


STATE ON DISK (handoff note: docs/status/SIM.md): src/sim/entities.ts, move.ts (16 KB), sim.ts (11 KB),
testworld.ts (13 KB), systems/env.ts (10 KB), systems/players.ts (2.5 KB, looks thin), systems/spawn.ts (0.5 KB,
a stub), systems/index.ts; src/net/loopback.ts (has one type error), src/net/host.ts (12 KB).
MISSING: src/net/client.ts (ClientSession) and every test file. An optional field PlayerEnt.carryPair was added to
src/sim/types.ts for move.ts. Review players.ts and spawn.ts against the brief; they are probably unfinished.
