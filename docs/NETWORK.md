# Cold Signal networking: dropping in a real transport

Single-player already runs the multiplayer path: a `Host` (authoritative `Sim`) and a `ClientSession`
in one page, joined by the loopback transport (`src/net/loopback.ts`). Real networking means writing
one more `Transport` and wiring it where the loopback is wired today. Nothing in the simulation, the
view or presentation changes.

## The interface (src/net/protocol.ts, frozen)

```ts
interface Transport<Out, In> {
  send(msg: Out): void;                      // one JSON-safe message
  onMessage: ((msg: In) => void) | null;     // set by the receiver; queue what arrives before it is set
  onClose: (() => void) | null;              // the peer went away (or close() was called)
  close(): void;
  pump?(nowMs: number): void;                // only for transports that deliver on a clock (the loopback's lag)
}
type ClientTransport    = Transport<ClientMsg, HostMsg>;   // what a client holds
type HostSideTransport  = Transport<HostMsg, ClientMsg>;   // what the host holds, one per client
```

Requirements: **reliable and ordered** (the host trusts that commands and actions arrive in order and
none is lost; snapshots carry deltas against what was sent before). Messages are plain JSON: send
`JSON.stringify(msg)`, deliver `JSON.parse(text)`. A message must never be delivered twice.

### WebRTC data channel (peer to peer, the host is one of the players)

```ts
function channelTransport<Out, In>(ch: RTCDataChannel): Transport<Out, In> {
  const early: In[] = [];
  const t: Transport<Out, In> = {
    onMessage: null, onClose: null,
    send: (m) => { if (ch.readyState === 'open') ch.send(JSON.stringify(m)); },
    close: () => ch.close(),
  };
  ch.onmessage = (e) => {
    const m = JSON.parse(e.data as string) as In;
    if (t.onMessage) t.onMessage(m); else early.push(m);
  };
  ch.onclose = () => t.onClose?.();
  // deliver what arrived before the receiver listened (ClientSession sets onMessage in its constructor)
  queueMicrotask(function drain() { if (!t.onMessage) return queueMicrotask(drain); for (const m of early.splice(0)) t.onMessage(m); });
  return t;
}
// both ends: pc.createDataChannel('cs', { ordered: true })   // reliable by default (no maxRetransmits)
```

Signalling (offer / answer / ICE) is outside the game: a room code exchanged through any small relay
or copied by hand. Data channels cap a message at about 256 KB in practice; the welcome (the full
state, about 110 KB of JSON for a fresh game, 32 KB gzipped) fits, but chunk it if saves grow.

### WebSocket relay (a tiny server forwards bytes; the host is still a player's page)

The relay keeps rooms: the host page connects as `host`, each client as `client`, and the relay
forwards every client frame to the host tagged with the client's id and every host frame to the
client it names. On the host page, one `HostSideTransport` per relay client id (created when the relay
announces a join; `onClose` fired when it announces a leave); on a client page, one `ClientTransport`
over the socket. The relay never parses game messages.

## Wiring (src/game/game.ts `openSession`)

- **Host page** (today's single-player): `const host = new Host(sim)`; for every remote peer,
  `host.connect(peerTransport)`. Keep the local player on the loopback exactly as now. Bots stay
  host-side (`Host.addBot`, `setBotInput`, `botAct`) and are driven by `BotBrain` in `src/game/bots.ts`.
- **Client page**: no `Sim`, no `Host`. `const session = new ClientSession(transport, { name })`.
  Each frame call `session.advance(dt)`; each 30 Hz tick `session.sendInput(cmd)`. When
  `session.ready` turns true, build the world from `session.seed` (`createWorld(seed)`, the same
  pure function every peer runs; yield to the browser while it builds) and call
  `session.setWorld(world)` to start prediction; then `view.attach(session)` as today.
  `transport.pump` is not needed for real transports.

## Join flow

1. Client -> `hello { proto, name }`.
2. Host checks the protocol version (`refuse { why }` on a mismatch, or when four players are in),
   takes back an unclaimed body of the same name from a loaded save (so a player who drops can come
   back into their own body, pack and all), or adds a new player (systems' `join` hooks give the
   starting kit), and replies `welcome { proto, you, seed, state }`: the whole `SimState` as JSON.
3. From the next tick the client gets a `snap` every tick: `ack` (last input seq applied), env,
   objective, entities, removed ids, changed ice cells, events, stats (every 10 ticks when changed).
4. Client sends `input { cmds }` every tick (the newest command and the two before it), `act { a }`
   for discrete actions, `bye` on leaving. A dropped client's player is removed: the systems' `leave`
   hooks set down everything they carried where they stood.

## What is already handled

- **Prediction and reconciliation**: the local player runs the same `stepPlayerMove` as the host;
  on every `ack` the session replays the unacknowledged commands on top of the authoritative state;
  small corrections fade out (~80 ms), larger than 1.5 m snap (teleport, respawn). Measured over
  `?wire=json&lag=120&jitter=30` with four players and sixteen wolves: mean error 0.00015 m, worst
  0.08 m (a bump against a companion), over 3 600 commands.
- **Interpolation**: everything else is drawn 100 ms in the past between snapshots; the clock drifts
  at most 15 % to hold that delay and jumps when more than 0.5 s behind (a stall, a hidden tab).
  Events are released at their presentation time; the local player's own events at once.
- **Lag bursts**: the host keeps at most 5 queued commands per client (older ones are merged, their
  button presses kept); a client silent for 15 ticks lets go of the controls.
- **Bandwidth**: dynamic entities (players, wolves, flares, heavy logs, the helicopter, fires) go out
  when their wire form changed since that client last got them; slow ones (pickups, crates, wood,
  devices) when their `rev` changed; ice cells when stress moved by 0.01, a hole opened, healed or its
  new skin grew a millimetre. Fractional numbers travel rounded to a thousandth (a millimetre, a
  milliradian); the receiving client's own player goes at full precision. Measured (real world,
  4 players, 16 wolves hunting, json wire): **7.05 KB per snapshot on average** (p95 7.2 KB, max 7.5 KB;
  it was 11.7 KB before rounding and skipping), about 210 KB/s per client at 30 Hz. A binary encoding
  or 15 Hz snapshots for far wolves would halve it again if a relay's bandwidth matters.
- **Proof**: `node tools/play.mjs tools/scenarios/netproof.mjs` plays walking, sixteen wolves on four
  players, a revive, chopping, a fire, the ice breaking and fitting a part over the lagged json wire
  and checks each on the client; `tools/scenarios/playthrough.mjs --query "wire=json&lag=120&jitter=30"`
  plays the whole run to the rescue with the autopilot reading only the client's view.

## Host migration (not implemented; what it needs)

The host is the only holder of the full `SimState` (clients see entities, env, objective, ice and
events, but not `state.vars`, where systems keep timers and per-player progress, nor the rng). To let a
client take over when the host leaves:

1. Have the host send a checkpoint every 10 to 30 s: `sim.serialize()` (about 110 KB JSON, 32 KB
   gzipped) as a new message type, e.g. `{ t: 'state', state }` (an optional addition to `HostMsg`),
   to every client, or to one chosen successor.
2. On `onClose` of the host transport, the successor builds `Sim.fromState(world, lastCheckpoint)`,
   wraps it in a `Host`, connects its own loopback client and announces itself through signalling;
   the others reconnect with `hello` (same names: they get their own bodies back).
3. Up to one checkpoint interval of play is lost (the same rule as a save). Commands the old host had
   not applied are dropped; clients' predictions snap to the new authoritative state on the welcome.

Saving and joining already use the same JSON, so a checkpoint is exactly a save sent over the wire.
