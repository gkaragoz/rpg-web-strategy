import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachLan } from '../../../scripts/lan.mjs';
import { GuestSession, HostSession } from '../../net/client';
import { HostLobby } from '../../net/host';
import { NetError, WsGuestTransport, WsHostTransport, lanUrl } from '../../net/wsTransport';

let server: Server;
let base = '';
let lan: { close(): void; rooms: Map<string, unknown> };

beforeAll(async () => {
  server = createServer();
  lan = attachLan(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  lan.close();
  server.close();
});

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('LAN WebSocket server', () => {
  it('create a room, join, lobby flow, presence, kick, and shutdown when the host closes', async () => {
    const code = 'TEST01';
    const htp = await WsHostTransport.create(lanUrl(code, 'host', base));
    const host = new HostLobby(htp, 'Host', 0, { code });
    const hs = new HostSession(host);
    expect(lan.rooms.has(code)).toBe(true);

    const gtp = await WsGuestTransport.create(lanUrl(code, 'guest', base));
    const g = new GuestSession(gtp, { name: 'Can', color: 2 });
    await until(() => g.model.state !== null);
    expect(g.model.state!.code).toBe(code);
    expect(hs.model.state!.players.length).toBe(2);

    const gtp2 = await WsGuestTransport.create(lanUrl(code, 'guest', base));
    const g2 = new GuestSession(gtp2, { name: 'Ece', color: 3 });
    await until(() => g2.model.state !== null && hs.model.state!.players.length === 3);

    // Settings broadcast and ready.
    hs.send({ t: 'settings', settings: { gold: 4000, placeSecs: 30 } });
    await until(() => g.model.state!.settings.gold === 4000);
    g.send({ t: 'ready', ready: true });
    await until(() => hs.model.state!.players[1].ready);

    // Presence: g -> g2 and host.
    g.send({ t: 'presence', x: 5, y: 6, ctx: 'page', act: 'lobbySettings' });
    await until(() => g2.model.presence.has(g.model.you) && hs.model.presence.has(g.model.you));
    expect(g2.model.presence.get(g.model.you)!.act).toBe('lobbySettings');

    // Chat.
    g2.send({ t: 'chat', text: 'selam' });
    await until(() => g.model.chat.length === 1);
    expect(g.model.chat[0]).toMatchObject({ name: 'Ece', text: 'selam' });

    // Kick.
    hs.send({ t: 'kick', id: g2.model.you });
    await until(() => g2.model.closedReason !== null);
    await until(() => hs.model.state!.players.length === 2);

    // A nonexistent room, and the same code a second time.
    await expect(WsGuestTransport.create(lanUrl('YOKYOK', 'guest', base))).rejects.toBeInstanceOf(NetError);
    await expect(WsHostTransport.create(lanUrl(code, 'host', base))).rejects.toMatchObject({ code: 'taken' });

    // When the host closes, the guest is notified and the room is deleted.
    hs.leave();
    await until(() => g.model.closedReason !== null);
    await until(() => !lan.rooms.has(code));
  }, 20000);

  it('a large message (multi-chunk frame) is delivered intact', async () => {
    const code = 'BIG001';
    const htp = await WsHostTransport.create(lanUrl(code, 'host', base));
    const host = new HostLobby(htp, 'Host', 0, { code });
    const hs = new HostSession(host);
    const gtp = await WsGuestTransport.create(lanUrl(code, 'guest', base));
    const g = new GuestSession(gtp, { name: 'G', color: 1 });
    await until(() => g.model.state !== null);
    // A ~300 KB resync message (host -> guest).
    const data = 'A'.repeat(300000);
    htp.send(g.model.you, { t: 'resync', step: 7, data });
    await until(() => g.model.pendingResync !== null);
    expect(g.model.pendingResync!.data.length).toBe(300000);
    // Guest -> host: a long chat text is truncated (CHAT_MAX) and the connection stays healthy.
    g.send({ t: 'chat', text: 'x'.repeat(5000) });
    await until(() => hs.model.chat.length === 1);
    expect(hs.model.chat[0].text.length).toBe(200);
    hs.leave();
  }, 20000);
});
