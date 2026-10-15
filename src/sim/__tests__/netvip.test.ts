import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { PROTOCOL, battleConfig, layoutOf, type ClientMsg, type LobbySettings, type ServerMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { mulberry32 } from '../random';
import { Terrain } from '../terrain';

interface Rig {
  hub: LoopbackHub;
  host: HostLobby;
  hs: HostSession;
  clock: { t: number };
}

function rig(seed = 5): Rig {
  const hub = new LoopbackHub();
  const clock = { t: 1000 };
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
  return { hub, host, hs: new HostSession(host, false), clock };
}

function join(r: Rig, name: string, token?: string): GuestSession {
  return new GuestSession(r.hub.connect(), { name, color: 1, token });
}

function spots(r: Rig, team: number, n: number): { x: number; y: number }[] {
  const init = r.hs.model.state!.init!;
  const t = new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
  const z = teamZones(init.size, init.teams, t)[team];
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < init.size && out.length < n; y++) {
    for (let x = 0; x < init.size && out.length < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (z.contains(px, py) && t.walkable(px, py) && t.reachable(px, py) && out.every((o) => Math.hypot(o.x - px, o.y - py) >= 1.2)) out.push({ x: px, y: py });
    }
  }
  return out;
}

/** Host + guests A and B in the placement phase (nobody ready, nothing placed). */
function placing(settings: Partial<LobbySettings> = { gameMode: 'vip' }): { r: Rig; a: GuestSession; b: GuestSession } {
  const r = rig();
  const a = join(r, 'A');
  const b = join(r, 'B');
  r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true, ...settings } });
  for (const g of [a, b]) g.send({ t: 'ready', ready: true });
  r.hs.send({ t: 'start' });
  expect(r.hs.model.state!.phase).toBe('placing');
  return { r, a, b };
}

function place(r: Rig, g: GuestSession | null, n: number): number[] {
  const team = g ? g.model.me!.team : 0;
  const sp = spots(r, team, n);
  const items = sp.map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y }));
  if (g) g.send({ t: 'place', items });
  else r.hs.send({ t: 'place', items });
  const model = g ? g.model : r.hs.model;
  return [...model.placed.values()].filter((u) => u.team === team).map((u) => u.id);
}

describe('vip message (placement)', () => {
  it('a player marks one of their own units; the host confirms with vipSet and nobody else learns it', () => {
    const { r, a, b } = placing();
    const ids = place(r, a, 6);
    const seen: ServerMsg[] = [];
    a.model.listeners.push((m) => seen.push(m));
    a.send({ t: 'vip', id: ids[2] });
    expect(a.model.vip).toBe(ids[2]);
    expect(seen.filter((m) => m.t === 'vipSet')).toEqual([{ t: 'vipSet', id: ids[2] }]);
    expect(b.model.vip).toBe(-1);
    expect(r.hs.model.vip).toBe(-1);
    a.send({ t: 'vip', id: ids[4] }); // replaces
    expect(a.model.vip).toBe(ids[4]);
    a.send({ t: 'vip', id: -1 }); // clears
    expect(a.model.vip).toBe(-1);
  });

  it('the host player can pick too', () => {
    const { r } = placing();
    const ids = place(r, null, 3);
    r.hs.send({ t: 'vip', id: ids[1] });
    expect(r.hs.model.vip).toBe(ids[1]);
  });

  it('is refused for a unit of another team, an unknown unit, bad shapes, or in a room that is not a vip room', () => {
    const { r, a, b } = placing();
    const mine = place(r, a, 4);
    const theirs = place(r, b, 4);
    expect(theirs.length).toBeGreaterThan(0);
    a.send({ t: 'vip', id: mine[0] });
    expect(a.model.vip).toBe(mine[0]);
    for (const bad of [theirs[0], 99999, 0, -2, 1.5, NaN, Infinity, '3', null, undefined, {}, [mine[1]], true]) {
      a.send({ t: 'vip', id: bad } as unknown as ClientMsg);
      expect(a.model.vip, String(bad)).toBe(mine[0]); // unchanged, and the answer re-states the real choice
    }
    a.send({ t: 'vip' } as unknown as ClientMsg);
    expect(a.model.vip).toBe(mine[0]);
    expect(b.model.vip).toBe(-1);

    const c = placing({ gameMode: 'classic' });
    const ids = place(c.r, c.a, 3);
    c.a.send({ t: 'vip', id: ids[0] });
    expect(c.a.model.vip).toBe(-1);
  });

  it('is refused before placement and after the player is ready', () => {
    const r = rig();
    const a = join(r, 'A');
    r.hs.send({ t: 'settings', settings: { gameMode: 'vip' } });
    a.send({ t: 'vip', id: 1 });
    expect(a.model.vip).toBe(-1);
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'start' });
    const ids = place(r, a, 3);
    a.send({ t: 'vip', id: ids[0] });
    expect(a.model.vip).toBe(ids[0]);
    a.send({ t: 'ready', ready: true });
    a.send({ t: 'vip', id: ids[1] });
    expect(a.model.vip).toBe(ids[0]);
    a.send({ t: 'vip', id: -1 });
    expect(a.model.vip).toBe(ids[0]);
  });

  it('a spectator cannot pick and does not receive vipSet', () => {
    const { r, a } = placing();
    const ids = place(r, a, 2);
    const sp = new GuestSession(r.hub.connect(), { name: 'S', color: 2, spectator: true });
    const seen: ServerMsg[] = [];
    sp.model.listeners.push((m) => seen.push(m));
    sp.send({ t: 'vip', id: ids[0] });
    expect(seen.some((m) => m.t === 'vipSet')).toBe(false);
    expect(a.model.vip).toBe(-1);
  });

  it('spam is rate limited without breaking the state', () => {
    const { r, a } = placing();
    const ids = place(r, a, 6);
    for (let i = 0; i < 400; i++) a.send({ t: 'vip', id: ids[i % ids.length] });
    expect([...ids, -1]).toContain(a.model.vip);
    r.clock.t += 5000; // the bucket refills
    a.send({ t: 'vip', id: ids[0] });
    expect(a.model.vip).toBe(ids[0]);
    a.send({ t: 'vip', id: -1 });
    expect(a.model.vip).toBe(-1);
  });

  it('is cleared when the VIP unit is removed (single unplace or clearing everything), kept for other removals', () => {
    const { r, a } = placing();
    const ids = place(r, a, 6);
    a.send({ t: 'vip', id: ids[3] });
    a.send({ t: 'unplace', ids: [ids[0], ids[1]] });
    expect(a.model.vip).toBe(ids[3]);
    a.send({ t: 'unplace', ids: [ids[3]] });
    expect(a.model.vip).toBe(-1);
    a.send({ t: 'vip', id: ids[4] });
    expect(a.model.vip).toBe(ids[4]);
    a.send({ t: 'unplace', ids });
    expect(a.model.vip).toBe(-1);
    // A removed unit cannot be picked again.
    a.send({ t: 'vip', id: ids[4] });
    expect(a.model.vip).toBe(-1);
  });

  it('survives a reconnect: the welcome of a rejoining player is followed by their own vipSet', () => {
    const { r, a } = placing();
    const ids = place(r, a, 4);
    a.send({ t: 'vip', id: ids[2] });
    const token = a.model.token;
    a.leave(true);
    const back = join(r, 'A', token);
    expect(back.model.you).not.toBe('');
    expect(back.model.vip).toBe(ids[2]);
    expect(back.model.placed.size).toBeGreaterThan(0);
  });

  it('a kicked player keeps their (ghost) units, so the VIP choice stays valid for the battle', () => {
    const { r, a, b } = placing();
    const ids = place(r, a, 4);
    place(r, b, 2);
    const team = a.model.me!.team;
    a.send({ t: 'vip', id: ids[1] });
    r.hs.send({ t: 'kick', id: a.model.you });
    b.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    const start = r.hs.model.start!;
    expect(start).toBeTruthy();
    const unitsOfTeam = start.vips[team];
    expect(unitsOfTeam).toBeGreaterThanOrEqual(0);
    expect(layoutOf(start)[unitsOfTeam * 4]).toBe(team);
  });
});

describe('BattleStart.vips', () => {
  function started(pick: boolean): { r: Rig; a: GuestSession; b: GuestSession; ids: { a: number[]; b: number[]; h: number[] } } {
    const { r, a, b } = placing();
    const ids = { a: place(r, a, 5), b: place(r, b, 5), h: place(r, null, 5) };
    if (pick) {
      a.send({ t: 'vip', id: ids.a[3] });
      r.hs.send({ t: 'vip', id: ids.h[1] });
    }
    for (const g of [a, b]) g.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    return { r, a, b, ids };
  }

  it('carries every team\'s pick as a layout index (-1 for no pick) to host and guests alike', () => {
    const { r, a, b, ids } = started(true);
    const start = r.hs.model.start!;
    expect(start.vips.length).toBe(3);
    const lay = layoutOf(start);
    const ta = a.model.me!.team;
    const tb = b.model.me!.team;
    expect(start.vips[tb]).toBe(-1);
    // The picked layout entry belongs to the right team (and is the chosen unit: units are sorted by id).
    const sortedIds = [...ids.a, ...ids.b, ...ids.h].sort((x, y) => x - y);
    expect(sortedIds[start.vips[ta]]).toBe(ids.a[3]);
    expect(sortedIds[start.vips[0]]).toBe(ids.h[1]);
    for (const t of [ta, 0]) expect(lay[start.vips[t] * 4]).toBe(t);
    expect(a.model.start).toEqual(start);
    expect(b.model.start).toEqual(start);
  });

  it('every client builds the identical BattleConfig, and the sims pick the chosen units', () => {
    const { r, a, b } = started(true);
    const start = r.hs.model.start!;
    const cfgs = [battleConfig(start), battleConfig(a.model.start!), battleConfig(b.model.start!)];
    for (const c of cfgs) {
      expect(c.rules).toBe('vip');
      expect(c.vips).toEqual(start.vips);
      expect(Array.from(c.layout!)).toEqual(Array.from(cfgs[0].layout!));
    }
    const sims = cfgs.map((c) => new Battle(start.simSeed, c));
    const v = sims[0].vipUnits();
    for (const s of sims) expect(Array.from(s.vipUnits())).toEqual(Array.from(v));
    const hostTeam = 0;
    expect(v[hostTeam]).toBe(sims[0].layoutUnits[start.vips[hostTeam]]);
    expect(sims[0].hash()).toBe(sims[1].hash());
  });

  it('is all -1 without picks (the sim auto-picks) and in other modes', () => {
    expect(started(false).r.hs.model.start!.vips).toEqual([-1, -1, -1]);
    const c = placing({ gameMode: 'hill' });
    place(c.r, c.a, 3);
    place(c.r, c.b, 3);
    for (const g of [c.a, c.b]) g.send({ t: 'ready', ready: true });
    c.r.hs.send({ t: 'ready', ready: true });
    c.r.host.tick();
    expect(c.r.hs.model.start!.vips).toEqual([-1, -1, -1]);
  });

  it('a late joiner (spectator) gets the same start with vips, and a lockstep battle runs in sync', () => {
    const { r, a, b } = started(true);
    const late = new GuestSession(r.hub.connect(), { name: 'L', color: 3, spectator: true });
    expect(late.model.start).toEqual(r.hs.model.start);
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(a.model.start!));
    const runners = [new LockstepRunner(hostSim, r.hs.model, { host: r.host }), new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m) })];
    for (let f = 0; f < 60 * 20; f++) {
      for (const rn of runners) rn.advance(1 / 60);
      r.hub.pump();
    }
    expect(guestSim.hash()).toBe(hostSim.hash());
    expect(['battle', 'result']).toContain(b.model.state!.phase);
  }, 120000);

  it('the vip choice is kept for a rematch and reset when going back to the lobby', () => {
    const { r, a, b, ids } = started(true);
    r.hs.send({ t: 'rematch' });
    expect(r.hs.model.state!.phase).toBe('placing');
    expect(a.model.vip).toBe(ids.a[3]);
    expect(r.hs.model.vip).toBe(ids.h[1]);
    a.send({ t: 'vip', id: ids.a[0] });
    expect(a.model.vip).toBe(ids.a[0]);
    for (const g of [a, b]) g.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    expect(r.hs.model.start!.vips[a.model.me!.team]).toBeGreaterThanOrEqual(0);
    r.hs.send({ t: 'lobby' });
    expect(r.hs.model.state!.phase).toBe('lobby');
    expect(a.model.vip).toBe(-1);
  });
});

describe('protocol version', () => {
  it('moved to 13 and an older client is still rejected', () => {
    expect(PROTOCOL).toBe(13);
    const r = rig();
    let reason = '';
    const ep = r.hub.connect();
    ep.onMessage = (_f, m) => {
      if ((m as ServerMsg).t === 'reject') reason = (m as { reason: string }).reason;
    };
    ep.send('host', { t: 'join', name: 'old', color: 1, version: PROTOCOL - 1 } as ClientMsg);
    expect(reason).toBe('version');
  });
});
