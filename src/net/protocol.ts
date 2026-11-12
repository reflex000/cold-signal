// CONTRACT. Messages between a client and the host, and the transport they travel on.
// Everything is JSON-safe. Single-player is a Host and a Client in one page joined by the
// loopback transport, so there is exactly one code path. Adding real networking means writing
// one more Transport (WebRTC data channel, WebSocket relay); nothing else changes.
// Owner: MAIN.
import type { Action, Entity, Env, IceCell, InputCmd, NetId, Objective, SimEvent, SimState, Stats } from '../sim/types';

export const PROTOCOL = 1;

export type ClientMsg =
  | { t: 'hello'; proto: number; name: string }
  | { t: 'input'; cmds: InputCmd[] } // newest last; the host applies those with seq > player.seq
  | { t: 'act'; a: Action }
  | { t: 'bye' };

export interface Snapshot {
  t: 'snap';
  tick: number;
  /** Last input seq of the receiving player that the host has applied. */
  ack: number;
  env: Env;
  objective: Objective;
  /** Every dynamic entity, plus slow entities whose `rev` changed since the last snapshot sent to this client. */
  ents: Entity[];
  removed: NetId[];
  /** Ice cells that changed. */
  ice: IceCell[];
  events: SimEvent[];
  stats?: Stats;
}

export type HostMsg =
  | { t: 'welcome'; proto: number; you: NetId; seed: number; state: SimState }
  | Snapshot
  | { t: 'refuse'; why: string }
  | { t: 'bye' };

/** One end of a reliable, ordered, bidirectional message pipe. */
export interface Transport<Out, In> {
  send(msg: Out): void;
  /** Set by the receiver. Messages that arrive before it is set are queued. */
  onMessage: ((msg: In) => void) | null;
  onClose: (() => void) | null;
  close(): void;
  /** Deliver anything due (loopback with simulated lag needs a clock). */
  pump?(nowMs: number): void;
}

export type ClientTransport = Transport<ClientMsg, HostMsg>;
export type HostSideTransport = Transport<HostMsg, ClientMsg>;

export interface LoopbackOptions {
  /** 'ref' passes objects by reference (fast path); 'json' serialises every message, as a real wire would. */
  wire?: 'ref' | 'json';
  /** One-way latency in ms and jitter, for testing prediction. */
  lagMs?: number;
  jitterMs?: number;
}
