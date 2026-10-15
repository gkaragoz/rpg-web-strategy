import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { PROTOCOL, battleConfig, type ClientMsg, type LobbySettings, type ServerMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { SIEGE_CORE_KIND } from '../modes';
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

function lobby(settings: Partial<LobbySettings>): { r: Rig; a: GuestSession; b: GuestSession } {
  const r = rig();
  const a = new GuestSession(r.hub.connect(), { name: 'A', color: 1 });
  const b = new GuestSession(r.hub.connect(), { name: 'B', color: 2 });
  r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true, ...settings } });
  return { r, a, b };
}

function startPlacing(settings: Partial<LobbySettings>): { r: Rig; a: GuestSession; b: GuestSession } {
  const l = lobby(settings);
  for (const g of [l.a, l.b]) g.send({ t: 'ready', ready: true });
  l.r.hs.send({ t: 'start' });
  expect(l.r.hs.model.state!.phase).toBe('placing');
  return l;
}

function battleRig(settings: Partial<LobbySettings>): { r: Rig; a: GuestSession; b: GuestSession } {
  const l = startPlacing(settings);
  for (const [g, team] of [[l.a, l.a.model.me!.team], [l.b, l.b.model.me!.team], [null, 0]] as const) {
    const items = spots(l.r, team, 4).map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y }));
    if (g) g.send({ t: 'place', items });
    else l.r.hs.send({ t: 'place', items });
  }
  for (const g of [l.a, l.b]) g.send({ t: 'ready', ready: true });
  l.r.hs.send({ t: 'ready', ready: true });
  l.r.host.tick();
  expect(l.r.hs.model.state!.phase).toBe('battle');
  return l;
}

describe('siege mode: lobby settings', () => {
  it('the protocol version moved to 14 (or later) with the new setting and the structure kind', () => {
    expect(PROTOCOL).toBeGreaterThanOrEqual(14);
  });

  it('gameMode siege is accepted from the host only; siegeDefender defaults to team 0', () => {
    const { r, a } = lobby({});
    expect(r.hs.model.state!.settings.siegeDefender).toBe(0);
    a.send({ t: 'settings', settings: { gameMode: 'siege' } });
    expect(r.hs.model.state!.settings.gameMode).toBe('classic');
    r.hs.send({ t: 'settings', settings: { gameMode: 'siege', siegeDefender: 2 } });
    expect(r.hs.model.state!.settings.gameMode).toBe('siege');
    expect(r.hs.model.state!.settings.siegeDefender).toBe(2);
  });

  it('invalid siegeDefender values are ignored and the previous value is kept', () => {
    const { r } = lobby({});
    r.hs.send({ t: 'settings', settings: { siegeDefender: 1 } });
    for (const bad of [-1, 6, 99, 1.5, NaN, Infinity, '2', null, {}, [1], true]) {
      r.hs.send({ t: 'settings', settings: { siegeDefender: bad } } as unknown as ClientMsg);
      expect(r.hs.model.state!.settings.siegeDefender, String(bad)).toBe(1);
    }
    r.hs.send({ t: 'settings', settings: { siegeDefender: 5 } });
    expect(r.hs.model.state!.settings.siegeDefender).toBe(5);
  });

  it('is clamped into 0..teams-1 when the game starts, and 0 outside siege', () => {
    const big = startPlacing({ gameMode: 'siege', siegeDefender: 5 });
    expect(big.r.hs.model.state!.init!.siegeDefender).toBe(2); // 3 players
    const mid = startPlacing({ gameMode: 'siege', siegeDefender: 1 });
    expect(mid.r.hs.model.state!.init!.siegeDefender).toBe(1);
    const other = startPlacing({ gameMode: 'hill', siegeDefender: 2 });
    expect(other.r.hs.model.state!.init!.siegeDefender).toBe(0);
  });

  it('changing the defender clears the guests\' ready flags like any rule change', () => {
    const { r, a } = lobby({ gameMode: 'siege' });
    a.send({ t: 'ready', ready: true });
    expect(r.hs.model.state!.players[1].ready).toBe(true);
    r.hs.send({ t: 'settings', settings: { siegeDefender: 1 } });
    expect(r.hs.model.state!.players[1].ready).toBe(false);
  });
});

describe('siege mode: placement and the battle', () => {
  it('the structure kind cannot be placed (unbuyable) and the host reports a code', () => {
    const { r, a } = startPlacing({ gameMode: 'siege' });
    const sp = spots(r, a.model.me!.team, 2);
    const seen: ServerMsg[] = [];
    a.model.listeners.push((m) => seen.push(m));
    a.send({ t: 'place', items: [{ cid: 1, kind: SIEGE_CORE_KIND, x: sp[0].x, y: sp[0].y }] });
    const fail = seen.find((m) => m.t === 'placeFail') as { reason: string } | undefined;
    expect(fail?.reason).toBe('unbuyable');
    expect([...a.model.placed.values()].some((u) => u.kind === SIEGE_CORE_KIND)).toBe(false);
  });

  it('GameInit and the BattleConfig of every client carry the defender, and every sim has the same core', () => {
    const { r, a, b } = battleRig({ gameMode: 'siege', siegeDefender: 1 });
    const start = r.hs.model.start!;
    expect(start.init.siegeDefender).toBe(1);
    expect(a.model.start!.init.siegeDefender).toBe(1);
    const sims = [start, a.model.start!, b.model.start!].map((s) => new Battle(s.simSeed, battleConfig(s)));
    for (const s of sims) {
      expect(battleConfig(start).rules).toBe('siege');
      expect(battleConfig(start).siegeDefender).toBe(1);
      const h = s.modeHud();
      if (h.kind !== 'siege') throw new Error('not siege');
      expect(h.defender).toBe(1);
      expect(s.units.kind[h.coreUnit]).toBe(SIEGE_CORE_KIND);
    }
    expect(sims[1].hash()).toBe(sims[0].hash());
    expect(sims[2].hash()).toBe(sims[0].hash());
  });

  it('a lockstep battle stays in sync between host and guest', () => {
    const { r, a } = battleRig({ gameMode: 'siege', siegeDefender: 0 });
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(a.model.start!));
    const runners = [new LockstepRunner(hostSim, r.hs.model, { host: r.host }), new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m) })];
    for (let f = 0; f < 60 * 400 && (hostSim.winner < 0 || guestSim.winner < 0); f++) {
      for (const rn of runners) rn.advance(1 / 60);
      r.hub.pump();
    }
    expect(hostSim.winner).not.toBe(-1);
    // The guest may stop a few steps short when the result arrives: finish its last steps by hand.
    while (guestSim.stepCount < hostSim.stepCount) guestSim.step(guestSim.dt);
    expect(guestSim.winner).toBe(hostSim.winner);
    expect(guestSim.hash()).toBe(hostSim.hash());
  }, 120000);
});
