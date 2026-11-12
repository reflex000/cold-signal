// The loopback transport: a Host and a ClientSession in one page, joined by a pipe that can
// behave like a real wire. 'ref' hands objects over as they are (single-player fast path);
// 'json' serialises every message; lagMs / jitterMs delay delivery, driven by pump(nowMs).
// With no lag, messages are delivered synchronously inside send().
// Owner: NET.
import { rngStep } from '../core/rng';
import type { ClientMsg, ClientTransport, HostMsg, HostSideTransport, LoopbackOptions, Transport } from './protocol';

export interface Loopback {
  client: ClientTransport;
  host: HostSideTransport;
  /** Deliver everything due in both directions. Needed only with lag or jitter. */
  pump(nowMs: number): void;
}

interface Timed<T> { due: number; msg: T }

/** One end of the pipe: what it sends lands in `peer`'s inbox. */
class End<Out, In> implements Transport<Out, In> {
  onClose: (() => void) | null = null;
  peer!: End<In, Out>;
  closed = false;
  private handler: ((msg: In) => void) | null = null;
  private readonly inbox: Timed<In>[] = [];
  private head = 0;
  private lastDue = 0;
  private delivering = false;

  constructor(private readonly link: Link) {}

  get onMessage(): ((msg: In) => void) | null {
    return this.handler;
  }
  set onMessage(fn: ((msg: In) => void) | null) {
    this.handler = fn;
    // Messages that arrived before anyone listened.
    if (fn) this.deliver();
  }

  send(msg: Out): void {
    if (this.closed) return;
    const link = this.link;
    const out = link.json ? (JSON.parse(JSON.stringify(msg)) as Out) : msg;
    this.peer.receive(out as unknown as In, link.now + link.delay());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    if (!peer.closed) {
      peer.closed = true;
      peer.onClose?.();
    }
    this.onClose?.();
  }

  pump(nowMs: number): void {
    if (nowMs > this.link.now) this.link.now = nowMs;
    this.deliver();
  }

  receive(msg: In, due: number): void {
    // Reliable and ordered: a message never overtakes the one sent before it.
    if (due < this.lastDue) due = this.lastDue;
    this.lastDue = due;
    this.inbox.push({ due, msg });
    this.deliver();
  }

  deliver(): void {
    // A handler may send, which may deliver more to this end: the outer loop picks those up.
    if (this.delivering) return;
    this.delivering = true;
    try {
      const q = this.inbox;
      while (this.handler && !this.closed && this.head < q.length && q[this.head].due <= this.link.now) {
        const m = q[this.head++].msg;
        this.handler(m);
      }
      if (this.head > 0 && (this.head === q.length || this.head > 256)) {
        q.splice(0, this.head);
        this.head = 0;
      }
    } finally {
      this.delivering = false;
    }
  }
}

class Link {
  now = 0;
  readonly json: boolean;
  private readonly lag: number;
  private readonly jitter: number;
  private rng = 0x2f6e2b1;

  constructor(o: LoopbackOptions) {
    this.json = o.wire === 'json';
    this.lag = Math.max(0, o.lagMs ?? 0);
    this.jitter = Math.max(0, o.jitterMs ?? 0);
  }

  /** One-way delay for the next message, ms. The jitter stream is seeded: every run is the same. */
  delay(): number {
    if (this.jitter <= 0) return this.lag;
    const r = rngStep(this.rng);
    this.rng = r[0];
    return this.lag + this.jitter * r[1];
  }
}

export function createLoopback(opts: LoopbackOptions = {}): Loopback {
  const link = new Link(opts);
  const client = new End<ClientMsg, HostMsg>(link);
  const host = new End<HostMsg, ClientMsg>(link);
  client.peer = host;
  host.peer = client;
  return {
    client,
    host,
    pump(nowMs: number): void {
      if (nowMs > link.now) link.now = nowMs;
      // Client to host first, so commands sent this frame reach the host before its tick.
      host.deliver();
      client.deliver();
    },
  };
}
