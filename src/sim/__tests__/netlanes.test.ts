import { describe, expect, it } from 'vitest';
import { Battle, mapSizeFor } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { PROTOCOL, battleConfig, type LobbySettings, type ServerMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { LANES_MIN_SIZE } from '../terrainLanes';
import { DEFAULT_MAP, PRESETS } from '../mapSpec';
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

function terrainOfInit(r: Rig): Terrain {
  const init = r.hs.model.state!.init!;
  return new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
}

function spots(r: Rig, team: number, n: number): { x: number; y: number }[] {
  const init = r.hs.model.state!.init!;
  const t = terrainOfInit(r);
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

function battleRig(settings: Partial<LobbySettings> = {}): { r: Rig; gs: GuestSession[] } {
  const l = lobby(1, { gameMode: 'lanes', ...settings });
  l.r.hs.send({ t: 'start' });
  expect(l.r.hs.model.state!.phase).toBe('placing');
  const all: Array<[GuestSession | null, number]> = [[null, 0], [l.gs[0], l.gs[0].model.me!.team]];
  for (const [g, team] of all) {
    const items = spots(l.r, team, 6).map((p, i) => ({ cid: i, kind: i % 2, x: p.x, y: p.y }));
    if (g) g.send({ t: 'place', items });
    else l.r.hs.send({ t: 'place', items });
  }
  l.gs[0].send({ t: 'ready', ready: true });
  l.r.hs.send({ t: 'ready', ready: true });
  l.r.host.tick();
  expect(l.r.hs.model.state!.phase).toBe('battle');
  return l;
}

describe('lanes mode: lobby', () => {
  it('the protocol version moved to 16 (or later)', () => {
    expect(PROTOCOL).toBeGreaterThanOrEqual(16);
  });

  it('gameMode lanes is accepted from the host only', () => {
    const { r, gs } = lobby(1, {});
    gs[0].send({ t: 'settings', settings: { gameMode: 'lanes' } });
    expect(r.hs.model.state!.settings.gameMode).toBe('classic');
    r.hs.send({ t: 'settings', settings: { gameMode: 'lanes' } });
    expect(r.hs.model.state!.settings.gameMode).toBe('lanes');
  });

  it('only exactly two players can start a lanes room: canStart is false and the host gets lanesNeedTwoTeams', () => {
    for (const guests of [2, 3, 5]) {
      const { r } = lobby(guests, { gameMode: 'lanes' });
      expect(r.hs.model.state!.players.filter((p) => p.role === 'player').length).toBe(guests + 1);
      expect(r.host.canStart(), `${guests + 1} players`).toBe(false);
      const seen: ServerMsg[] = [];
      r.hs.model.listeners.push((m) => seen.push(m));
      r.hs.send({ t: 'start' });
      expect(r.hs.model.state!.phase).toBe('lobby');
      expect(seen.filter((m) => m.t === 'startFail'), `${guests + 1} players`).toEqual([{ t: 'startFail', reason: 'lanesNeedTwoTeams' }]);
      expect(r.hs.model.startFailed).toBe('lanesNeedTwoTeams');
    }
  });

  it('two players start a lanes room; other modes are not affected by the rule', () => {
    const two = lobby(1, { gameMode: 'lanes' });
    expect(two.r.host.canStart()).toBe(true);
    two.r.hs.send({ t: 'start' });
    expect(two.r.hs.model.state!.phase).toBe('placing');
    expect(two.r.hs.model.state!.init!.teams).toBe(2);
    expect(two.r.hs.model.state!.init!.gameMode).toBe('lanes');
    expect(two.r.hs.model.startFailed).toBeNull();
    const three = lobby(2, { gameMode: 'classic' });
    three.r.hs.send({ t: 'start' });
    expect(three.r.hs.model.state!.phase).toBe('placing');
    expect(three.r.hs.model.state!.init!.teams).toBe(3);
  });

  it('the map is the lanes layout whatever the configured recipe, at least LANES_MIN_SIZE tiles, with the biome kept', () => {
    const cases: Array<[Partial<LobbySettings>, number]> = [
      [{ mapSize: 0 }, LANES_MIN_SIZE],
      [{ mapSize: 40 }, LANES_MIN_SIZE],
      [{ mapSize: 56 }, LANES_MIN_SIZE],
      [{ mapSize: 100 }, 100],
      [{ mapSize: 160 }, 160],
    ];
    for (const [settings, want] of cases) {
      const { r } = lobby(1, { gameMode: 'lanes', mapMode: 'fixed', map: PRESETS[3].spec, ...settings });
      r.hs.send({ t: 'start' });
      const init = r.hs.model.state!.init!;
      expect(init.size, JSON.stringify(settings)).toBe(want);
      expect(init.spec.layout).toBe('lanes');
      expect(init.spec.biome).toBe(PRESETS[3].spec.biome);
      expect(init.spec.river).toBe('none');
      const cfg = battleConfig({ init, simSeed: 1, layout: '', vips: [-1, -1] });
      expect(mapSizeFor(cfg)).toBe(want);
    }
    // another mode keeps its map recipe and its size
    const c = lobby(1, { gameMode: 'classic', mapMode: 'fixed', map: PRESETS[3].spec, mapSize: 56 });
    c.r.hs.send({ t: 'start' });
    expect(c.r.hs.model.state!.init!.size).toBe(56);
    expect(c.r.hs.model.state!.init!.spec).toEqual(PRESETS[3].spec);
  });

  it('a random map still gives a lanes map (varied seed)', () => {
    const seeds = new Set<number>();
    for (const rs of [1, 2, 3]) {
      const hub = new LoopbackHub();
      const host = new HostLobby(hub.host, 'Host', 0, { now: () => 1000, rnd: mulberry32(rs) });
      const hs = new HostSession(host, false);
      const g = new GuestSession(hub.connect(), { name: 'G', color: 1 });
      hs.send({ t: 'settings', settings: { gameMode: 'lanes', mapMode: 'random' } });
      g.send({ t: 'ready', ready: true });
      hs.send({ t: 'start' });
      const init = hs.model.state!.init!;
      expect(init.spec.layout).toBe('lanes');
      expect(init.size).toBeGreaterThanOrEqual(LANES_MIN_SIZE);
      seeds.add(init.seed);
    }
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('zones are the two halves of the lanes map: placement works in the own half and fails in the other (zone)', () => {
    const { r, gs } = lobby(1, { gameMode: 'lanes' });
    r.hs.send({ t: 'start' });
    const init = r.hs.model.state!.init!;
    const zones = r.host.zoneList;
    expect(zones.length).toBe(2);
    const t = terrainOfInit(r);
    for (const z of zones) expect(z.area).toBeGreaterThan(300);
    expect(zones[0].contains(init.size / 2 + 5, init.size / 2)).toBe(false);
    const mine = spots(r, 0, 4);
    const theirs = spots(r, 1, 4);
    const seen: ServerMsg[] = [];
    r.hs.model.listeners.push((m) => seen.push(m));
    r.hs.send({ t: 'place', items: mine.map((p, i) => ({ cid: i, kind: 0, x: p.x, y: p.y })) });
    expect(seen.filter((m) => m.t === 'placed').length).toBeGreaterThan(0);
    expect(seen.filter((m) => m.t === 'placeFail').length).toBe(0);
    // the host is team 0: the other half is out of bounds for it
    r.hs.send({ t: 'place', items: theirs.map((p, i) => ({ cid: 10 + i, kind: 0, x: p.x, y: p.y })) });
    const fails = seen.filter((m) => m.t === 'placeFail') as Array<Extract<ServerMsg, { t: 'placeFail' }>>;
    expect(fails.length).toBe(1);
    expect(fails[0].reason).toBe('zone');
    // a spot on a wall tile is refused too
    r.hs.send({ t: 'place', items: [{ cid: 99, kind: 0, x: init.size / 2 - 8, y: init.size * 0.35 }] });
    expect(t.walkable(init.size / 2 - 8, init.size * 0.35)).toBe(false);
    expect((seen.filter((m) => m.t === 'placeFail') as Array<Extract<ServerMsg, { t: 'placeFail' }>>).length).toBe(2);
    void gs;
  });
});

describe('lanes mode: the battle', () => {
  it('every client builds the same lanes battle (castles, towers, pool) and stays in sync', () => {
    const { r, gs } = battleRig();
    const start = r.hs.model.start!;
    const cfg = battleConfig(start);
    expect(cfg.rules).toBe('lanes');
    expect(cfg.teamCount).toBe(2);
    expect(cfg.map?.layout).toBe('lanes');
    expect(mapSizeFor(cfg)).toBe(start.init.size);
    const sims = [start, gs[0].model.start!].map((s) => new Battle(s.simSeed, battleConfig(s)));
    for (const s of sims) {
      expect(s.alivePerTeam.slice(0, 2)).toEqual([6, 6]);
      expect(s.terrain!.layout).toBe('lanes');
      for (let i = 0; i < 700; i++) s.step(s.dt);
      expect(s.modeHud().kind).toBe('lanes');
      expect(s.alivePerTeam[0]).toBeGreaterThan(6); // wave 1 came
    }
    expect(sims[1].hash()).toBe(sims[0].hash());
  });

  it('a lockstep battle stays in sync between host and guest', () => {
    const { r, gs } = battleRig();
    const a = gs[0];
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(a.model.start!));
    const runners = [new LockstepRunner(hostSim, r.hs.model, { host: r.host }), new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m) })];
    for (let f = 0; f < 2400; f++) {
      for (const rn of runners) rn.advance(1 / 60);
      r.hub.pump();
    }
    expect(hostSim.stepCount).toBeGreaterThan(600);
    while (guestSim.stepCount < hostSim.stepCount) guestSim.step(guestSim.dt);
    while (hostSim.stepCount < guestSim.stepCount) hostSim.step(hostSim.dt);
    expect(guestSim.hash()).toBe(hostSim.hash());
    expect(hostSim.modeHud().kind).toBe('lanes');
    void DEFAULT_MAP;
  }, 120000);
});
