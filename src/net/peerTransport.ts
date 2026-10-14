import Peer, { type DataConnection } from 'peerjs';
import type { Msg } from './protocol';
import { noop, type Transport } from './transport';
import { NetError } from './wsTransport';

/** Prefix of the lobby code on the public PeerJS cloud (prevents id collisions with other apps). */
const PREFIX = 'rpgweb-strategy-';
/** Time allowed to reach the signaling server. */
const OPEN_TIMEOUT_MS = 15000;
/** Time allowed to establish a direct connection with the host (via STUN/TURN): kept long for mobile networks + relays. */
const CONNECT_TIMEOUT_MS = 35000;

/** STUN only: the primary internet path is the WebSocket relay (relay/); WebRTC is the fallback. */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

export const peerId = (code: string): string => PREFIX + code.toUpperCase();

const peerOpts = ():{ config: RTCConfiguration } => ({ config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 2 } });

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const p = id ? new Peer(id, peerOpts()) : new Peer(peerOpts());
    const timer = setTimeout(() => {
      p.destroy();
      reject(new NetError('failed', 'signal-unreachable'));
    }, OPEN_TIMEOUT_MS);
    p.on('open', () => {
      clearTimeout(timer);
      resolve(p);
    });
    p.on('error', (e: { type?: string }) => {
      clearTimeout(timer);
      p.destroy();
      reject(new NetError(e.type === 'unavailable-id' ? 'taken' : 'failed', e.type));
    });
  });
}

/** Internet host endpoint (WebRTC): lobby code = PeerJS id; guests connect to the host directly. */
export class PeerHostTransport implements Transport {
  readonly id = 'host';
  readonly isHost = true;
  onMessage: (from: string, msg: Msg) => void = noop;
  onPeerJoin: (peer: string) => void = noop;
  onPeerLeave: (peer: string) => void = noop;
  onClose: (reason: string) => void = noop;
  private readonly conns = new Map<string, DataConnection>();
  /** close() was called: `Peer.destroy()` emits 'disconnected' before it marks itself destroyed, so a reconnect must not be attempted then. */
  private closing = false;

  private constructor(private readonly peer: Peer) {
    peer.on('connection', (conn) => {
      const id = conn.peer;
      conn.on('open', () => {
        this.conns.get(id)?.close();
        this.conns.set(id, conn);
        this.onPeerJoin(id);
      });
      conn.on('data', (d) => {
        if (this.conns.get(id) === conn) this.onMessage(id, d as Msg);
      });
      const gone = (): void => {
        if (this.conns.get(id) === conn) {
          this.conns.delete(id);
          this.onPeerLeave(id);
        }
      };
      conn.on('close', gone);
      conn.on('error', gone);
    });
    peer.on('disconnected', () => {
      // Signaling connection dropped: current players are unaffected; reconnect for new arrivals.
      if (!peer.destroyed && !this.closing) peer.reconnect();
    });
    peer.on('close', () => this.onClose('serverLost'));
  }

  static async create(code: string): Promise<PeerHostTransport> {
    return new PeerHostTransport(await openPeer(peerId(code)));
  }

  send(to: string, msg: Msg): void {
    const c = this.conns.get(to);
    if (c?.open) c.send(msg);
  }
  broadcast(msg: Msg, except?: string): void {
    for (const [id, c] of this.conns) if (id !== except && c.open) c.send(msg);
  }
  disconnect(peer: string): void {
    const c = this.conns.get(peer);
    this.conns.delete(peer);
    // Give the message a chance to go out, then close.
    if (c) setTimeout(() => c.close(), 150);
  }
  close(): void {
    this.closing = true;
    for (const c of this.conns.values()) setTimeout(() => c.close(), 150);
    setTimeout(() => this.peer.destroy(), 300);
  }
}

/** Internet guest endpoint: connects to the host by code. */
export class PeerGuestTransport implements Transport {
  readonly isHost = false;
  onMessage: (from: string, msg: Msg) => void = noop;
  onPeerJoin: (peer: string) => void = noop;
  onPeerLeave: (peer: string) => void = noop;
  onClose: (reason: string) => void = noop;

  private constructor(
    private readonly peer: Peer,
    private readonly conn: DataConnection,
    readonly id: string,
  ) {
    conn.on('data', (d) => this.onMessage('host', d as Msg));
    conn.on('close', () => this.onClose('lost'));
    conn.on('error', () => this.onClose('lost'));
  }

  static async create(code: string): Promise<PeerGuestTransport> {
    const peer = await openPeer();
    return new Promise((resolve, reject) => {
      const conn = peer.connect(peerId(code), { reliable: true });
      const timer = setTimeout(() => {
        peer.destroy();
        reject(new NetError('failed', 'ice-timeout'));
      }, CONNECT_TIMEOUT_MS);
      conn.on('iceStateChanged', (st) => {
        console.info('[peer] ICE', st);
        if (st === 'failed') {
          clearTimeout(timer);
          peer.destroy();
          reject(new NetError('failed', 'ice-failed'));
        }
      });
      peer.on('error', (e: { type?: string }) => {
        clearTimeout(timer);
        peer.destroy();
        reject(new NetError(e.type === 'peer-unavailable' ? 'noroom' : 'failed', e.type));
      });
      conn.on('open', () => {
        clearTimeout(timer);
        resolve(new PeerGuestTransport(peer, conn, peer.id));
      });
    });
  }

  send(_to: string, msg: Msg): void {
    if (this.conn.open) this.conn.send(msg);
  }
  broadcast(): void {
    /* host only */
  }
  disconnect(): void {
    /* host only */
  }
  close(): void {
    setTimeout(() => {
      this.conn.close();
      this.peer.destroy();
    }, 150);
  }
}
