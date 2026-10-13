// Dependency-free WebSocket room router (LAN lobby): the game logic lives in the host client,
// the server only relays messages. Path: /ws?room=CODE&role=host|guest
// Frames (JSON text):
//   host -> server : {to: id | '*', except?: id, msg} | {disconnect: id}
//   server -> host : {ok:true} | {from: id, msg} | {join: id} | {leave: id}
//   guest -> server : {msg}
//   server -> guest: {ok:true, id} | {msg} | {close: reason}
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024 * 1024;
const MAX_ROOMS = 200;
const MAX_GUESTS = 16;
const PING_MS = 20000;
const IDLE_MS = 70000;

/** A single WebSocket connection: frame parsing and sending after the handshake. */
class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    this.closed = false;
    this.lastSeen = Date.now();
    this.onText = () => {};
    this.onClose = () => {};
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
    socket.setNoDelay(true);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* already closed */
    }
    this.onClose();
  }

  feed(d) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const hi = this.buf.readUInt32BE(2);
        const lo = this.buf.readUInt32BE(6);
        len = hi * 4294967296 + lo;
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const key = this.buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      } else payload = Buffer.from(payload);
      this.buf = this.buf.subarray(need);
      if (op === 8) return this.close(1000);
      if (op === 9) {
        this.write(10, payload);
        continue;
      }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        if (op !== 0) {
          this.frag = [];
          this.fragOp = op;
        }
        this.frag.push(payload);
        if (fin) {
          const full = Buffer.concat(this.frag);
          this.frag = [];
          if (this.fragOp === 1) this.onText(full.toString('utf8'));
        }
      }
    }
  }

  write(op, payload) {
    if (this.closed) return;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) {
      head = Buffer.alloc(4);
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(n, 2);
    } else {
      head = Buffer.alloc(10);
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeUInt32BE(Math.floor(n / 4294967296), 2);
      head.writeUInt32BE(n >>> 0, 6);
    }
    try {
      this.socket.write(Buffer.concat([head, payload]));
    } catch {
      this.end();
    }
  }

  send(obj) {
    this.write(1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close(code = 1000) {
    if (this.closed) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    this.write(8, b);
    this.end();
  }
}

/**
 * Adds the /ws upgrade to the HTTP server. Rooms are kept in memory; the room closes when the host leaves.
 * @returns {{ rooms: Map, close: () => void }}
 */
export function attachLan(server) {
  const rooms = new Map();

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== '/ws' || !key || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      // If another listener (Vite HMR) exists, leave it to them; otherwise close the connection.
      socket.on('error', () => {});
      if (server.listenerCount('upgrade') <= 1) socket.destroy();
      return;
    }
    socket.on('error', () => {});
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c = new Conn(socket);
    const room = String(url.searchParams.get('room') ?? '').toUpperCase().slice(0, 12);
    const role = url.searchParams.get('role');
    if (!room) return c.send({ err: 'noroom' }), c.close(1008);

    if (role === 'host') {
      if (rooms.has(room) || rooms.size >= MAX_ROOMS) return c.send({ err: 'taken' }), c.close(1008);
      const r = { host: c, guests: new Map(), next: 1 };
      rooms.set(room, r);
      c.send({ ok: true });
      c.onText = (t) => {
        let m;
        try {
          m = JSON.parse(t);
        } catch {
          return;
        }
        if (m.disconnect) {
          const g = r.guests.get(m.disconnect);
          if (g) {
            r.guests.delete(m.disconnect);
            g.send({ close: 'kicked' });
            g.close(1000);
          }
        } else if (m.to === '*') {
          for (const [id, g] of r.guests) if (id !== m.except) g.send({ msg: m.msg });
        } else if (typeof m.to === 'string') {
          const g = r.guests.get(m.to);
          if (g) g.send({ msg: m.msg });
        }
      };
      c.onClose = () => {
        rooms.delete(room);
        for (const g of r.guests.values()) {
          g.send({ close: 'closed' });
          g.close(1000);
        }
        r.guests.clear();
      };
      return;
    }

    const r = rooms.get(room);
    if (!r) return c.send({ err: 'noroom' }), c.close(1008);
    if (r.guests.size >= MAX_GUESTS) return c.send({ err: 'full' }), c.close(1008);
    const id = `g${r.next++}`;
    r.guests.set(id, c);
    c.send({ ok: true, id });
    r.host.send({ join: id });
    c.onText = (t) => {
      let m;
      try {
        m = JSON.parse(t);
      } catch {
        return;
      }
      if (m && m.msg !== undefined) r.host.send({ from: id, msg: m.msg });
    };
    c.onClose = () => {
      if (r.guests.delete(id)) r.host.send({ leave: id });
    };
  });

  // Drop idle connections + ping for liveness.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const r of rooms.values()) {
      for (const c of [r.host, ...r.guests.values()]) {
        if (now - c.lastSeen > IDLE_MS) c.end();
        else c.write(9, Buffer.alloc(0));
      }
    }
  }, PING_MS);
  timer.unref?.();

  return {
    rooms,
    close() {
      clearInterval(timer);
      for (const r of rooms.values()) {
        r.host.end();
        for (const g of r.guests.values()) g.end();
      }
      rooms.clear();
    },
  };
}
