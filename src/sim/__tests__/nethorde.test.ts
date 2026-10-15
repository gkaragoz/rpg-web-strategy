import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { PROTOCOL, battleConfig, type LobbySettings, type ServerMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { HORDE_MAX_HUMANS } from '../modes';
import { mulberry32 } from '../random';
import { Terrain } from '../terrain';

interface Rig {
  hub: LoopbackHub;
  host: HostLobby;
  hs: HostSession;
}

function rig(seed = 5): Rig {
  const hub = new LoopbackHub();
  const clock = { t: 1000 };
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
  return { hub, host, hs: new HostSession(host, false) };
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

/** A room with the host and `guests` guests, all ready, with the given settings. */
function lobby(guests: number, settings: Partial<LobbySettings>): { r: Rig; gs: GuestSession[] } {
  const r = rig();
  const gs = Array.from({ length: guests }, (_, i) => new GuestSession(r.hub.connect(), { name: `G${i}`, color: i + 1 }));
  r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true, ...settings } });
  for (const g of gs) g.send({ t: 'ready', ready: true });
  return { r, gs };
}

function battleRig(guests: number): { r: Rig; gs: GuestSession[] } {
  const l = lobby(guests, { gameMode: 'horde' });
  l.r.hs.send({ t: 'start' });
  expect(l.r.hs.model.state!.phase).toBe('placing');
  const all: Array<[GuestSession | null, number]> = [[null, 0], ...l.gs.map((g): [GuestSession, number] => [g, g.model.me!.team])];
  for (const [g, team] of all) {
    const items = spots(l.r, team, 4).map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y }));
    if (g) g.send({ t: 'place', items });
    else l.r.hs.send({ t: 'place', items });
  }
  for (const g of l.gs) g.send({ t: 'ready', ready: true });
  l.r.hs.send({ t: 'ready', ready: true });
  l.r.host.tick();
  expect(l.r.hs.model.state!.phase).toBe('battle');
  return l;
}

describe('horde mode: lobby', () => {
  it('the protocol version moved to 15 (or later)', () => {
    expect(PROTOCOL).toBeGreaterThanOrEqual(15);
  });

  it('gameMode horde is accepted from the host only', () => {
    const { r, gs } = lobby(1, {});
    gs[0].send({ t: 'settings', settings: { gameMode: 'horde' } });
    expect(r.hs.model.state!.settings.gameMode).toBe('classic');
    r.hs.send({ t: 'settings', settings: { gameMode: 'horde' } });
    expect(r.hs.model.state!.settings.gameMode).toBe('horde');
  });

  it('six players cannot start a horde room: canStart is false and the host gets the code hordeTooManyTeams', () => {
    expect(HORDE_MAX_HUMANS).toBe(5);
    const { r } = lobby(5, { gameMode: 'horde' });
    expect(r.hs.model.state!.players.filter((p) => p.role === 'player').length).toBe(6);
    expect(r.host.canStart()).toBe(false);
    const seen: ServerMsg[] = [];
    r.hs.model.listeners.push((m) => seen.push(m));
    r.hs.send({ t: 'start' });
    expect(r.hs.model.state!.phase).toBe('lobby');
    expect(seen.filter((m) => m.t === 'startFail')).toEqual([{ t: 'startFail', reason: 'hordeTooManyTeams' }]);
    expect(r.hs.model.startFailed).toBe('hordeTooManyTeams');
  });

  it('six players start every other mode, five start a horde room', () => {
    const six = lobby(5, { gameMode: 'classic' });
    six.r.hs.send({ t: 'start' });
    expect(six.r.hs.model.state!.phase).toBe('placing');
    expect(six.r.hs.model.state!.init!.teams).toBe(6);
    expect(six.r.hs.model.startFailed).toBeNull();
    const five = lobby(4, { gameMode: 'horde' });
    expect(five.r.host.canStart()).toBe(true);
    five.r.hs.send({ t: 'start' });
    expect(five.r.hs.model.state!.phase).toBe('placing');
    expect(five.r.hs.model.state!.init!.teams).toBe(5);
    expect(five.r.hs.model.state!.init!.gameMode).toBe('horde');
    expect(five.r.hs.model.startFailed).toBeNull();
  });
});

describe('horde mode: the battle', () => {
  it('GameInit.teams stays the human count; every client builds the same horde battle', () => {
    const { r, gs } = battleRig(2);
    const start = r.hs.model.start!;
    expect(start.init.teams).toBe(3);
    const cfg = battleConfig(start);
    expect(cfg.rules).toBe('horde');
    expect(cfg.teamCount).toBe(3);
    const sims = [start, ...gs.map((g) => g.model.start!)].map((s) => new Battle(s.simSeed, battleConfig(s)));
    for (const s of sims) {
      expect(s.hordeTeam).toBe(3);
      expect(s.alivePerTeam.slice(0, 4)).toEqual([4, 4, 4, 0]);
      for (let i = 0; i < 700; i++) s.step(s.dt);
      expect(s.modeHud().kind).toBe('horde');
    }
    expect(sims[1].hash()).toBe(sims[0].hash());
    expect(sims[2].hash()).toBe(sims[0].hash());
  });

  it('a lockstep battle stays in sync between host and guest and reports the waves as scores', () => {
    const { r, gs } = battleRig(1);
    const a = gs[0];
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(a.model.start!));
    const runners = [new LockstepRunner(hostSim, r.hs.model, { host: r.host }), new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m) })];
    for (let f = 0; f < 60 * 1000 && (hostSim.winner < 0 || guestSim.winner < 0); f++) {
      for (const rn of runners) rn.advance(1 / 60);
      r.hub.pump();
    }
    expect(hostSim.winner).not.toBe(-1);
    while (guestSim.stepCount < hostSim.stepCount) guestSim.step(guestSim.dt);
    expect(guestSim.winner).toBe(hostSim.winner);
    expect(guestSim.hash()).toBe(hostSim.hash());
    // 4 starter units per team lose to the horde: the horde team index (2) is the winner, scores = waves reached.
    expect(hostSim.winner).toBe(2);
    const res = r.hs.model.result;
    expect(res?.winner).toBe(2);
    expect(res?.scores?.length).toBe(3);
    expect(res?.scores?.[2]).toBe(0);
    expect(res?.scores?.[0]).toBe(res?.scores?.[1]);
    expect(res?.scores?.[0]).toBeGreaterThanOrEqual(1);
  }, 240000);
});
