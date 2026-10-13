import type { Msg } from './protocol';

/**
 * Yildiz topoloji tasima: misafirler yalniz host ile konusur. Host `send(peer)` / `broadcast` kullanir,
 * misafir `send('host')`. Gercekleme: Loopback (test), WebSocket (LAN), PeerJS (internet).
 */
export interface Transport {
  /** Bu uc noktanin kimligi (host icin 'host' disinda herhangi bir sabit olabilir). */
  readonly id: string;
  readonly isHost: boolean;
  send(to: string, msg: Msg): void;
  /** Yalniz host: tum bagli misafirlere (except haric). */
  broadcast(msg: Msg, except?: string): void;
  /** Yalniz host: misafirin baglantisini keser. */
  disconnect(peer: string): void;
  close(): void;
  /** Alinan mesaj: from = gonderen uc nokta kimligi (misafirde 'host'). */
  onMessage: (from: string, msg: Msg) => void;
  /** Yalniz host: yeni baglanti / kopan baglanti. */
  onPeerJoin: (peer: string) => void;
  onPeerLeave: (peer: string) => void;
  /** Misafir: host baglantisi koptu. */
  onClose: (reason: string) => void;
}

export function noop(): void {
  /* bos */
}

/** Bellek ici baglanti merkezi (testler ve tek-pencere denemeleri). Mesajlar structured-clone ile kopyalanir. */
export class LoopbackHub {
  readonly host: LoopbackEndpoint;
  private readonly guests = new Map<string, LoopbackEndpoint>();
  private nextId = 1;
  /** Test icin: mesajlar bu kadar adim sonra teslim edilir (0: aninda). */
  latency = 0;
  private readonly queue: Array<{ due: number; fn: () => void }> = [];
  private clock = 0;

  constructor() {
    this.host = new LoopbackEndpoint(this, 'host', true);
  }

  /** Yeni misafir ucu olusturur ve host'a baglar. */
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

  /** Gecikmeli teslimleri bir birim ilerletir (latency > 0 iken). */
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
