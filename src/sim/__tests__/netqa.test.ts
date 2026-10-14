import { describe, expect, it } from 'vitest';
import { GuestSession, HostSession } from '../../net/client';
import { HostLobby } from '../../net/host';
import { PROTOCOL, type ClientMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { mulberry32 } from '../random';

function rig(seed = 1): { hub: LoopbackHub; host: HostLobby; hs: HostSession } {
  const hub = new LoopbackHub();
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => 1000, rnd: mulberry32(seed) });
  return { hub, host, hs: new HostSession(host, false) };
}

describe('password rooms', () => {
  it('a guest that reconnects with its token does not need the password again (reload of a locked room)', () => {
    const r = rig();
    r.hs.send({ t: 'settings', settings: {}, password: 'sesame' });
    const a = new GuestSession(r.hub.connect(), { name: 'A', color: 1, pass: 'sesame' });
    expect(a.model.me).not.toBeNull();
    const token = a.model.token;
    // Wrong or missing password: still refused, with or without somebody else's token.
    const bad = new GuestSession(r.hub.connect(), { name: 'B', color: 2, pass: 'nope' });
    expect(bad.model.rejected).toBe('password');
    const none = new GuestSession(r.hub.connect(), { name: 'B', color: 2, token: 'not-a-token' });
    expect(none.model.rejected).toBe('password');
    // The reloaded page has no password, only the token of its slot.
    const back = new GuestSession(r.hub.connect(), { name: 'A', color: 1, token });
    expect(back.model.rejected).toBeNull();
    expect(back.model.me?.name).toBe('A');
    expect(r.hs.model.state!.players.filter((p) => p.role === 'player').length).toBe(2);
  });

  it('a guest that dropped out of a locked lobby (removed from the list) can come back with its token, but not after a password change', () => {
    const r = rig();
    r.hs.send({ t: 'settings', settings: {}, password: 'sesame' });
    const a = new GuestSession(r.hub.connect(), { name: 'A', color: 1, pass: 'sesame' });
    const c = new GuestSession(r.hub.connect(), { name: 'C', color: 3, pass: 'sesame' });
    const tokenA = a.model.token;
    const tokenC = c.model.token;
    a.leave(); // the lobby forgets the player (reload without a clean leave looks the same)
    c.leave();
    expect(r.hs.model.state!.players.length).toBe(1);
    const back = new GuestSession(r.hub.connect(), { name: 'A', color: 1, token: tokenA });
    expect(back.model.rejected).toBeNull();
    expect(back.model.me?.name).toBe('A');
    r.hs.send({ t: 'settings', settings: {}, password: 'other' });
    const late = new GuestSession(r.hub.connect(), { name: 'C', color: 3, token: tokenC });
    expect(late.model.rejected).toBe('password');
  });
});

describe('malformed profile and chat input', () => {
  it('a join without a usable name still gets a reply, and non-string chat is dropped instead of printed', () => {
    const r = rig();
    const ep = r.hub.connect();
    let welcomed = false;
    ep.onMessage = (_f, m) => {
      if ((m as { t: string }).t === 'welcome') welcomed = true;
    };
    ep.send('host', { t: 'join', name: 42, color: 1, version: PROTOCOL } as unknown as ClientMsg);
    expect(welcomed).toBe(true);
    ep.send('host', { t: 'chat', text: 12345 } as unknown as ClientMsg);
    ep.send('host', { t: 'chat' } as unknown as ClientMsg);
    expect(r.hs.model.chat.length).toBe(0);
  });
});

describe('leaving with and without a kept place', () => {
  function placing(): { r: ReturnType<typeof rig>; a: GuestSession; b: GuestSession } {
    const r = rig(3);
    const a = new GuestSession(r.hub.connect(), { name: 'A', color: 1 });
    const b = new GuestSession(r.hub.connect(), { name: 'B', color: 2 });
    for (const g of [a, b]) g.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'start' });
    expect(r.hs.model.state!.phase).toBe('placing');
    return { r, a, b };
  }

  it('leave(true) only drops the connection: the token takes the place back (language switch, view switch)', () => {
    const { r, a } = placing();
    const token = a.model.token;
    const team = a.model.me!.team;
    a.leave(true);
    expect(r.hs.model.state!.players.find((p) => p.team === team)!.connected).toBe(false);
    const back = new GuestSession(r.hub.connect(), { name: 'A', color: 1, token });
    expect(back.model.rejected).toBeNull();
    expect(back.model.me!.team).toBe(team);
    expect(back.model.me!.connected).toBe(true);
  });

  it('a normal leave gives the place up for good', () => {
    const { r, a } = placing();
    const token = a.model.token;
    a.leave();
    const back = new GuestSession(r.hub.connect(), { name: 'A', color: 1, token });
    expect(back.model.rejected).toBe('started');
  });
});
