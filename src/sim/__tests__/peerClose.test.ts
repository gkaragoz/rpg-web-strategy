import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (...a: unknown[]) => void;

/** Stand-in for PeerJS' Peer with its real destroy() order: 'disconnected' is emitted while `destroyed` is still false. */
class FakePeer {
  static instances: FakePeer[] = [];
  destroyed = false;
  reconnects = 0;
  openSockets = 1;
  private readonly handlers = new Map<string, Handler[]>();
  constructor() {
    FakePeer.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }
  on(ev: string, fn: Handler): this {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  private emit(ev: string): void {
    for (const f of this.handlers.get(ev) ?? []) f();
  }
  reconnect(): void {
    this.reconnects++;
    this.openSockets++; // a reconnect opens a brand-new signaling socket
  }
  destroy(): void {
    if (this.destroyed) return;
    this.openSockets = 0;
    this.emit('disconnected'); // PeerJS: disconnect() runs first ...
    this.destroyed = true; // ... the flag is only set afterwards
    this.emit('close');
  }
}

vi.mock('peerjs', () => ({ default: FakePeer }));

describe('WebRTC host transport shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakePeer.instances.length = 0;
  });

  it('does not reconnect the signaling socket while it is being closed (that left one orphan websocket open per lobby)', async () => {
    const { PeerHostTransport } = await import('../../net/peerTransport');
    const tp = await PeerHostTransport.create('ABCD');
    const peer = FakePeer.instances[0];
    vi.useFakeTimers();
    tp.close();
    vi.advanceTimersByTime(1000);
    expect(peer.destroyed).toBe(true);
    expect(peer.reconnects).toBe(0);
    expect(peer.openSockets).toBe(0);
  });
});
