import type { Msg } from './protocol';

/**
 * Star-topology transport: guests only talk to the host. The host uses `send(peer)` / `broadcast`,
 * a guest uses `send('host')`. Implementations: Loopback (tests), WebSocket (LAN), PeerJS (internet).
 */
export interface Transport {
  /** Id of this endpoint (for the host it may be any constant other than 'host'). */
  readonly id: string;
  readonly isHost: boolean;
  send(to: string, msg: Msg): void;
  /** Host only: to all connected guests (except `except`). */
  broadcast(msg: Msg, except?: string): void;
  /** Host only: drops the guest's connection. */
  disconnect(peer: string): void;
  close(): void;
  /** Received message: from = sender endpoint id ('host' on a guest). */
  onMessage: (from: string, msg: Msg) => void;
  /** Host only: new connection / dropped connection. */
  onPeerJoin: (peer: string) => void;
  onPeerLeave: (peer: string) => void;
  /** Guest: the connection to the host dropped. The reason is a code: 'closed' | 'kicked' | anything else means lost. */
  onClose: (reason: string) => void;
}

export function noop(): void {
  /* empty */
}

/** In-memory hub (tests and single-window trials). Messages are copied with structured clone. */
export class LoopbackHub {
  readonly host: LoopbackEndpoint;
  private readonly guests = new Map<string, LoopbackEndpoint>();
  private nextId = 1;
  /** For tests: messages are delivered after this many steps (0: immediately). */
  latency = 0;
  private readonly queue: Array<{ due: number; fn: () => void }> = [];
  private clock = 0;

  constructor() {
    this.host = new LoopbackEndpoint(this, 'host', true);
  }

  /** Creates a new guest endpoint and connects it to the host. */
  connect(): LoopbackEndpoint {
    const id = `g${this.nextId++}`;
    const g = new LoopbackEndpoint(this, id, false);
    this.guests.set(id, g);
    this.deliver(() => this.host.onPeerJoin(id));
    return g;
  }

  /** @internal */
  route(from: LoopbackEndpoint, to: string, msg: Msg): void {
    const copy = structuredClone(msg);
    if (from.isHost) {
      const g = this.guests.get(to);
      if (g && !g.closed) this.deliver(() => g.onMessage('host', copy));
    } else if (to === 'host') {
      this.deliver(() => this.host.onMessage(from.id, copy));
    }
  }

  /** @internal */
  broadcastFromHost(msg: Msg, except?: string): void {
    for (const [id, g] of this.guests) if (id !== except && !g.closed) this.route(this.host, id, msg);
  }

  /** @internal */
  dropGuest(id: string, reason: string, notifyGuest: boolean): void {
    const g = this.guests.get(id);
    if (!g) return;
    this.guests.delete(id);
    g.closed = true;
    if (notifyGuest) this.deliver(() => g.onClose(reason));
    this.deliver(() => this.host.onPeerLeave(id));
  }

  private deliver(fn: () => void): void {
    if (this.latency <= 0) fn();
    else this.queue.push({ due: this.clock + this.latency, fn });
  }

  /** Advances delayed deliveries by one unit (while latency > 0). */
  pump(steps = 1): void {
    for (let s = 0; s < steps; s++) {
      this.clock++;
      const due = this.queue.filter((q) => q.due <= this.clock);
      for (const q of due) {
        this.queue.splice(this.queue.indexOf(q), 1);
        q.fn();
      }
    }
  }

  closeAll(): void {
    for (const id of [...this.guests.keys()]) this.dropGuest(id, 'closed', true);
  }
}

export class LoopbackEndpoint implements Transport {
  closed = false;
  onMessage: (from: string, msg: Msg) => void = noop;
  onPeerJoin: (peer: string) => void = noop;
  onPeerLeave: (peer: string) => void = noop;
  onClose: (reason: string) => void = noop;

  constructor(
    private readonly hub: LoopbackHub,
    readonly id: string,
    readonly isHost: boolean,
  ) {}

  send(to: string, msg: Msg): void {
    if (!this.closed) this.hub.route(this, to, msg);
  }

  broadcast(msg: Msg, except?: string): void {
    if (this.isHost) this.hub.broadcastFromHost(msg, except);
  }

  disconnect(peer: string): void {
    if (this.isHost) this.hub.dropGuest(peer, 'kicked', true);
  }

  close(): void {
    if (this.isHost) this.hub.closeAll();
    else this.hub.dropGuest(this.id, 'left', false);
    this.closed = true;
  }
}
