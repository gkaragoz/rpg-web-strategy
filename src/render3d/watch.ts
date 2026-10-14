import { PALETTES, makeTeamColor } from '../app/state';
import { GuestSession } from '../net/client';
import { PeerGuestTransport } from '../net/peerTransport';
import type { GameInit, LobbyState } from '../net/protocol';
import { RELAY_URL } from '../net/relay';
import type { TeamColors } from '../render/unitView';
import type { Transport } from '../net/transport';
import { NetError, WsGuestTransport, lanUrl } from '../net/wsTransport';

export type WatchVia = 'lan' | 'relay' | 'webrtc';

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
 * Joins a room as a spectator: the LAN server first (same address), then the internet relay, then WebRTC - the order the 2D online
 * screen uses. `status` receives a translation key of the step being tried.
 */
export async function watchRoom(code: string, name: string, status: (key: string) => void): Promise<{ session: GuestSession; via: WatchVia }> {
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
      tp = await WsGuestTransport.create(lanUrl(room, 'guest', RELAY_URL), 12000);
      via = 'relay';
    } catch (re) {
      if (re instanceof NetError && (re.code === 'full' || re.code === 'taken')) throw re;
      status('v3.st.webrtc');
      tp = await PeerGuestTransport.create(room);
      via = 'webrtc';
    }
  }
  const session = new GuestSession(tp, { name, color: 0, spectator: true });
  const err = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve('v3.err.noReply'), 8000);
    session.model.listeners.push((m) => {
      if (m.t === 'welcome') {
        clearTimeout(timer);
        resolve(null);
      } else if (m.t === 'reject') {
        clearTimeout(timer);
        resolve(m.reason === 'password' ? 'v3.err.password' : m.reason === 'version' ? 'v3.err.version' : 'v3.err.joinFail');
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
