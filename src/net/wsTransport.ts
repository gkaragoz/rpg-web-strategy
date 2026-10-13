import { Reassembler, splitMsg } from './chunk';
import type { Msg } from './protocol';
import { noop, type Transport } from './transport';

/** WebSocket odasina baglanma hatasi. */
export class NetError extends Error {
  constructor(
    readonly code: 'noroom' | 'taken' | 'full' | 'failed',
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** LAN sunucusu yanit vermezse (ornegin Pages) hemen internete gecilsin. */
const WS_TIMEOUT_MS = 4000;

interface Ack {
  ok?: boolean;
  id?: string;
  err?: string;
}

/** Sayfanin geldigi sunucunun /ws adresi (LAN: host'un sunucusu). */
export function lanUrl(room: string, role: 'host' | 'guest', base?: string): string {
  const loc = typeof location !== 'undefined' ? location : { protocol: 'http:', host: 'localhost:5174' };
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const b = base ?? `${proto}//${loc.host}`;
  return `${b}/ws?room=${encodeURIComponent(room)}&role=${role}`;
}

function open(url: string, timeoutMs = WS_TIMEOUT_MS): Promise<{ ws: WebSocket; ack: Ack }> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(new NetError('failed', String(e)));
      return;
    }
    let done = false;
    const timer = setTimeout(() => fail(new NetError('failed', 'Baglanti zaman asimi')), timeoutMs);
    const fail = (err: NetError): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* kapali */
      }
      reject(err);
    };
    ws.onerror = () => fail(new NetError('failed', 'Baglanti kurulamadi'));
    ws.onclose = () => fail(new NetError('failed', 'Baglanti kapandi'));
    ws.onmessage = (ev) => {
      if (done) return;
      let a: Ack;
      try {
        a = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (a.err) return fail(new NetError(a.err as NetError['code']));
      if (a.ok) {
        done = true;
        clearTimeout(timer);
        resolve({ ws, ack: a });
      }
    };
  });
}

/** Host ucu: odayi olusturur; misafir mesajlari sunucu uzerinden gelir. */
export class WsHostTransport implements Transport {
  readonly id = 'host';
  readonly isHost = true;
  onMessage: (from: string, msg: Msg) => void = noop;
  onPeerJoin: (peer: string) => void = noop;
  onPeerLeave: (peer: string) => void = noop;
  onClose: (reason: string) => void = noop;

  private readonly asm = new Map<string, Reassembler>();
  private chunkId = 1;

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev) => {
      let m: { from?: string; msg?: Msg; join?: string; leave?: string };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.join) this.onPeerJoin(m.join);
      else if (m.leave) {
        this.asm.delete(m.leave);
        this.onPeerLeave(m.leave);
      } else if (m.from && m.msg) {
        let r = this.asm.get(m.from);
        if (!r) this.asm.set(m.from, (r = new Reassembler()));
        const full = r.push(m.msg);
        if (full) this.onMessage(m.from, full);
      }
    };
    ws.onclose = () => this.onClose('Sunucu baglantisi koptu');
  }

  static async create(url: string, timeoutMs?: number): Promise<WsHostTransport> {
    const { ws } = await open(url, timeoutMs);
    return new WsHostTransport(ws);
  }

  send(to: string, msg: Msg): void {
    for (const p of splitMsg(msg, this.chunkId++)) this.ws.send(JSON.stringify({ to, msg: p }));
  }
  broadcast(msg: Msg, except?: string): void {
    for (const p of splitMsg(msg, this.chunkId++)) this.ws.send(JSON.stringify({ to: '*', except, msg: p }));
  }
  disconnect(peer: string): void {
    this.ws.send(JSON.stringify({ disconnect: peer }));
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* kapali */
    }
  }
}

/** Misafir ucu: odaya katilir; yalniz host ile konusur. */
export class WsGuestTransport implements Transport {
  readonly isHost = false;
  onMessage: (from: string, msg: Msg) => void = noop;
  onPeerJoin: (peer: string) => void = noop;
  onPeerLeave: (peer: string) => void = noop;
  onClose: (reason: string) => void = noop;

  private readonly asm = new Reassembler();
  private chunkId = 1;

  private constructor(
    private readonly ws: WebSocket,
    readonly id: string,
  ) {
    ws.onmessage = (ev) => {
      let m: { msg?: Msg; close?: string };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.close) this.onClose(m.close);
      else if (m.msg) {
        const full = this.asm.push(m.msg);
        if (full) this.onMessage('host', full);
      }
    };
    ws.onclose = () => this.onClose('Baglanti koptu');
  }

  static async create(url: string, timeoutMs?: number): Promise<WsGuestTransport> {
    const { ws, ack } = await open(url, timeoutMs);
    return new WsGuestTransport(ws, ack.id ?? 'g?');
  }

  send(_to: string, msg: Msg): void {
    for (const p of splitMsg(msg, this.chunkId++)) this.ws.send(JSON.stringify({ msg: p }));
  }
  broadcast(): void {
    /* yalniz host */
  }
  disconnect(): void {
    /* yalniz host */
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* kapali */
    }
  }
}
