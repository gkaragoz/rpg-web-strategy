import { PALETTES, makeTeamColor } from '../app/state';
import { GuestSession, HostSession, type Session } from '../net/client';
import { HostLobby } from '../net/host';
import { PeerGuestTransport } from '../net/peerTransport';
import { makeCode, type GameInit, type LobbyState } from '../net/protocol';
import { RELAY_URL } from '../net/relay';
import type { TeamColors } from '../render/unitView';
import type { Transport } from '../net/transport';
import { NetError, WsGuestTransport, WsHostTransport, lanUrl } from '../net/wsTransport';
import { PeerHostTransport } from '../net/peerTransport';

export type WatchVia = 'lan' | 'relay' | 'webrtc';

/** `?relay=off` skips the internet relay (to exercise the direct WebRTC route). */
const relayOff = (): boolean => new URLSearchParams(location.search).get('relay') === 'off';

/** Color of a player's palette index (same table the 2D online screens use). */
export function paletteColor(index: number): number {
  const cols = PALETTES[0].colors;
  return cols[((index % cols.length) + cols.length) % cols.length];
}

/** Team colors by team index, taken from the players of the lobby (a player id can turn into a ghost id mid-game). */
export function teamColorsOf(init: GameInit, st: LobbyState): TeamColors[] {
  return init.teamPlayers.map((_, i) => makeTeamColor(paletteColor(st.players.find((p) => p.role === 'player' && p.team === i)?.color ?? i)));
}

/**
 * Opens a room and hosts it: the internet relay (WebRTC if the relay is unreachable) or the LAN server. The host is a player too, so
 * the 3D page can place armies and start the game like the 2D screen does.
 */
export async function hostRoom(kind: 'lan' | 'net', name: string, status: (key: string) => void): Promise<{ session: Session; via: WatchVia; code: string }> {
  let tp: Transport | null = null;
  let code = '';
  let via: WatchVia = 'lan';
  status(kind === 'net' ? 'v3.st.signal' : 'v3.st.lanHost');
  for (let i = 0; i < 6 && !tp; i++) {
    code = makeCode();
    try {
      if (kind === 'net') {
        try {
          if (relayOff()) throw new NetError('failed', 'relay disabled');
          tp = await WsHostTransport.create(lanUrl(code, 'host', RELAY_URL), 12000);
          via = 'relay';
        } catch (re) {
          if (re instanceof NetError && re.code === 'taken') throw re;
          tp = await PeerHostTransport.create(code);
          via = 'webrtc';
        }
      } else {
        tp = await WsHostTransport.create(lanUrl(code, 'host'));
        via = 'lan';
      }
    } catch (e) {
      if (!(e instanceof NetError) || e.code !== 'taken') throw e;
    }
  }
  if (!tp) throw new Error('v3.err.host');
  const lobby = new HostLobby(tp, name, Math.floor(Math.random() * 6), { code });
  const session = new HostSession(lobby);
  tp.onClose = () => {
    session.model.closedReason = 'serverLost';
    session.model.apply({ t: 'closed' });
  };
  return { session, via, code };
}

/**
 * Joins a room as a spectator: the LAN server first (same address), then the internet relay, then WebRTC - the order the 2D online
 * screen uses. `status` receives a translation key of the step being tried.
 */
export async function watchRoom(code: string, name: string, status: (key: string) => void, play = false): Promise<{ session: GuestSession; via: WatchVia }> {
  const room = code.trim().toUpperCase();
  let tp: Transport;
  let via: WatchVia = 'lan';
  status('v3.st.lan');
  try {
    tp = await WsGuestTransport.create(lanUrl(room, 'guest'));
  } catch (e) {
    if (e instanceof NetError && (e.code === 'full' || e.code === 'taken')) throw e;
    status('v3.st.relay');
    try {
      if (relayOff()) throw new NetError('failed', 'relay disabled');
      tp = await WsGuestTransport.create(lanUrl(room, 'guest', RELAY_URL), 12000);
      via = 'relay';
    } catch (re) {
      if (re instanceof NetError && (re.code === 'full' || re.code === 'taken')) throw re;
      status('v3.st.webrtc');
      tp = await PeerGuestTransport.create(room);
      via = 'webrtc';
    }
  }
  const session = new GuestSession(tp, { name, color: play ? Math.floor(Math.random() * 6) : 0, spectator: !play });
  const err = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve('v3.err.noReply'), 8000);
    session.model.listeners.push((m) => {
      if (m.t === 'welcome') {
        clearTimeout(timer);
        resolve(null);
      } else if (m.t === 'reject') {
        clearTimeout(timer);
        resolve(m.reason === 'password' ? 'v3.err.password' : m.reason === 'version' ? 'v3.err.version' : m.reason === 'started' ? 'v3.err.started' : m.reason === 'full' ? 'v3.err.full' : m.reason === 'name' ? 'v3.err.name' : 'v3.err.joinFail');
      } else if (m.t === 'closed') {
        clearTimeout(timer);
        resolve('v3.err.dropped');
      }
    });
  });
  if (err) {
    session.leave();
    throw new Error(err);
  }
  return { session, via };
}
