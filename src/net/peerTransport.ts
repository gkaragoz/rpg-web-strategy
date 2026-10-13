import Peer, { type DataConnection } from 'peerjs';
import type { Msg } from './protocol';
import { noop, type Transport } from './transport';
import { NetError } from './wsTransport';

/** Genel PeerJS bulutunda lobi kodunun on eki (baska uygulamalarla kimlik carpismasini onler). */
const PREFIX = 'rpgweb-strategy-';
/** Sinyal sunucusuna baglanma suresi. */
const OPEN_TIMEOUT_MS = 15000;
/** Host ile dogrudan (STUN/TURN uzerinden) baglanti kurma suresi: mobil ag + role icin uzun tutulur. */
const CONNECT_TIMEOUT_MS = 35000;

/** Yalniz STUN: internet icin birincil yol WebSocket roleisidir (relay/); WebRTC yedek yoldur. */
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
      reject(new NetError('failed', 'Sinyal sunucusuna ulasilamadi'));
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

/** Internet host ucu (WebRTC): lobi kodu = PeerJS kimligi; misafirler dogrudan host'a baglanir. */
export class PeerHostTransport implements Transport {
  readonly id = 'host';
  readonly isHost = true;
  onMessage: (from: string, msg: Msg) => void = noop;
  onPeerJoin: (peer: string) => void = noop;
  onPeerLeave: (peer: string) => void = noop;
  onClose: (reason: string) => void = noop;
  private readonly conns = new Map<string, DataConnection>();

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
      // Sinyal baglantisi koptu: mevcut oyuncular etkilenmez, yeni girisler icin yeniden baglan.
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on('close', () => this.onClose('Baglanti kapandi'));
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
    // Mesajin gitmesine firsat ver, sonra kapat.
    if (c) setTimeout(() => c.close(), 150);
  }
  close(): void {
    for (const c of this.conns.values()) setTimeout(() => c.close(), 150);
    setTimeout(() => this.peer.destroy(), 300);
  }
}

/** Internet misafir ucu: kodla host'a baglanir. */
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
    conn.on('close', () => this.onClose('Baglanti koptu'));
    conn.on('error', () => this.onClose('Baglanti koptu'));
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
    /* yalniz host */
  }
  disconnect(): void {
    /* yalniz host */
  }
  close(): void {
    setTimeout(() => {
      this.conn.close();
      this.peer.destroy();
    }, 150);
  }
}
