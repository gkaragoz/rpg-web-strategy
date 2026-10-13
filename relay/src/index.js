// Internet rolesi: NAT/TURN gerektirmeyen WebSocket oda yonlendiricisi (Cloudflare Worker + Durable Object).
// Protokol scripts/lan.mjs ile aynidir; oyun mantigi host istemcisindedir, burasi yalniz mesaj iletir.
//   Yol: /ws?room=KOD&role=host|guest
//   host -> srv : {to: id | '*', except?: id, msg} | {disconnect: id}
//   srv -> host : {ok:true} | {from: id, msg} | {join: id} | {leave: id}
//   misafir -> srv : {msg}      srv -> misafir: {ok:true, id} | {msg} | {close: neden}
const MAX_GUESTS = 16;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname !== '/ws' || request.headers.get('Upgrade') !== 'websocket') return new Response('rpg-web relay', { status: 200 });
    const room = (url.searchParams.get('room') ?? '').toUpperCase().slice(0, 12);
    if (!room) return new Response('room?', { status: 400 });
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
  },
};

export class Room {
  constructor() {
    this.host = null;
    this.guests = new Map();
    this.next = 1;
  }

  fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();
    const fail = (err) => {
      ws.send(JSON.stringify({ err }));
      ws.close(1008, err);
    };
    if (role === 'host') {
      if (this.host) fail('taken');
      else this.attachHost(ws);
    } else if (!this.host) fail('noroom');
    else if (this.guests.size >= MAX_GUESTS) fail('full');
    else this.attachGuest(ws);
    return new Response(null, { status: 101, webSocket: client });
  }

  attachHost(ws) {
    this.host = ws;
    ws.send(JSON.stringify({ ok: true }));
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.disconnect) {
        const g = this.guests.get(m.disconnect);
        if (g) {
          this.guests.delete(m.disconnect);
          g.send(JSON.stringify({ close: 'kicked' }));
          g.close(1000, 'kicked');
        }
      } else if (m.to === '*') {
        const s = JSON.stringify({ msg: m.msg });
        for (const [id, g] of this.guests) if (id !== m.except) g.send(s);
      } else if (typeof m.to === 'string') {
        this.guests.get(m.to)?.send(JSON.stringify({ msg: m.msg }));
      }
    });
    const gone = () => {
      if (this.host !== ws) return;
      this.host = null;
      for (const g of this.guests.values()) {
        try {
          g.send(JSON.stringify({ close: 'closed' }));
          g.close(1000, 'closed');
        } catch {
          /* zaten kapali */
        }
      }
      this.guests.clear();
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  attachGuest(ws) {
    const id = `g${this.next++}`;
    this.guests.set(id, ws);
    ws.send(JSON.stringify({ ok: true, id }));
    this.host.send(JSON.stringify({ join: id }));
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m && m.msg !== undefined) this.host?.send(JSON.stringify({ from: id, msg: m.msg }));
    });
    const gone = () => {
      if (this.guests.delete(id)) this.host?.send(JSON.stringify({ leave: id }));
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }
}
