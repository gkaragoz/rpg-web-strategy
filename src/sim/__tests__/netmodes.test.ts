import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner, type SimLike } from '../../net/lockstep';
import { PROTOCOL, battleConfig, type LobbySettings } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
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

function join(r: Rig, name: string): GuestSession {
  return new GuestSession(r.hub.connect(), { name, color: 1 });
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

/** Host + two guests, all units placed and ready, battle running. */
function battleRig(settings: Partial<LobbySettings>): { r: Rig; a: GuestSession; b: GuestSession } {
  const r = rig();
  const a = join(r, 'A');
  const b = join(r, 'B');
  r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true, ...settings } });
  for (const g of [a, b]) g.send({ t: 'ready', ready: true });
  r.hs.send({ t: 'start' });
  for (const [g, team] of [[a, a.model.me!.team], [b, b.model.me!.team]] as const) {
    const sp = spots(r, team, 16);
    g.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y })) });
    g.send({ t: 'ready', ready: true });
  }
  const hp = spots(r, 0, 16);
  r.hs.send({ t: 'place', items: hp.map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y })) });
  r.hs.send({ t: 'ready', ready: true });
  r.host.tick();
  expect(r.hs.model.state!.phase).toBe('battle');
  return { r, a, b };
}

function runToResult(r: Rig, guests: GuestSession[]): Battle {
  const start = r.hs.model.start!;
  const hostSim = new Battle(start.simSeed, battleConfig(start));
  const sims = [hostSim, ...guests.map(() => new Battle(start.simSeed, battleConfig(start)))];
  const runners = [new LockstepRunner(hostSim, r.hs.model, { host: r.host }), ...guests.map((g, i) => new LockstepRunner(sims[i + 1], g.model, { send: (m) => g.send(m) }))];
  for (let f = 0; f < 60 * 700 && hostSim.winner === -1; f++) {
    for (const rn of runners) rn.advance(1 / 60);
    r.hub.pump();
  }
  for (let f = 0; f < 5; f++) {
    for (const rn of runners) rn.advance(1 / 60);
    r.hub.pump();
  }
  return hostSim;
}

describe('game mode lobby setting', () => {
  it('defaults to classic, accepts the known ids and ignores invalid values', () => {
    const r = rig();
    const g = join(r, 'A');
    expect(r.hs.model.state!.settings.gameMode).toBe('classic');
    r.hs.send({ t: 'settings', settings: { gameMode: 'hill' } });
    expect(g.model.state!.settings.gameMode).toBe('hill');
    for (const bad of ['bogus', '', 5, null, {}, ['hill'], 'HILL']) {
      r.hs.send({ t: 'settings', settings: { gameMode: bad } as unknown as Partial<LobbySettings> });
      expect(r.hs.model.state!.settings.gameMode, String(bad)).toBe('hill');
    }
    for (const id of ['vip', 'ctf', 'classic'] as const) {
      r.hs.send({ t: 'settings', settings: { gameMode: id } });
      expect(r.hs.model.state!.settings.gameMode).toBe(id);
    }
  });

  it('only the host changes it; a real change drops the ready flags like any other setting', () => {
    const r = rig();
    const g = join(r, 'A');
    g.send({ t: 'ready', ready: true });
    g.send({ t: 'settings', settings: { gameMode: 'hill' } });
    expect(r.hs.model.state!.settings.gameMode).toBe('classic');
    expect(r.hs.model.state!.players[1].ready).toBe(true);
    r.hs.send({ t: 'settings', settings: { gameMode: 'hill' } });
    expect(r.hs.model.state!.players[1].ready).toBe(false);
  });

  it('is copied into GameInit and the battle config of every client', () => {
    const { r, a } = battleRig({ gameMode: 'hill' });
    const init = r.hs.model.start!.init;
    expect(init.gameMode).toBe('hill');
    expect(a.model.start!.init.gameMode).toBe('hill');
    expect(battleConfig(a.model.start!).rules).toBe('hill');
    const c = battleRig({});
    expect(c.r.hs.model.start!.init.gameMode).toBe('classic');
    expect(battleConfig(c.r.hs.model.start!).rules).toBe('classic');
  });

  it('the protocol version moved with the wire change', () => {
    expect(PROTOCOL).toBeGreaterThanOrEqual(12);
  });
});

describe('result scores', () => {
  it('a hill battle ends with scores in the result for host and guests', () => {
    const { r, a, b } = battleRig({ gameMode: 'hill' });
    const sim = runToResult(r, [a, b]);
    expect(sim.winner).not.toBe(-1);
    expect(r.hs.model.state!.phase).toBe('result');
    const scores = sim.modeScores()!;
    expect(scores.length).toBe(3);
    for (const m of [r.hs.model, a.model, b.model]) {
      expect(m.result, 'result').not.toBeNull();
      expect(m.result!.winner).toBe(sim.winner);
      expect(m.result!.scores).toEqual(scores);
    }
  }, 180000);

  it('a classic battle sends no scores', () => {
    const { r, a, b } = battleRig({});
    runToResult(r, [a, b]);
    expect(r.hs.model.result).not.toBeNull();
    expect(r.hs.model.result!.scores).toBeUndefined();
    expect(a.model.result!.scores).toBeUndefined();
  }, 180000);

  it('a player who joins in the result phase receives the scores too', () => {
    const { r, a, b } = battleRig({ gameMode: 'hill' });
    const sim = runToResult(r, [a, b]);
    const late = new GuestSession(r.hub.connect(), { name: 'Late', color: 2, spectator: true });
    expect(late.model.result?.scores).toEqual(sim.modeScores());
  }, 180000);

  it('the lockstep runner hands the sim scores to the host (worker sims expose them the same way)', () => {
    let steps = 0;
    const finished: Array<{ winner: number; alive: number[]; scores?: number[] }> = [];
    const sim: SimLike = {
      dt: 1 / 30,
      step: () => {
        steps++;
      },
      get stepCount() {
        return steps;
      },
      hash: () => 0,
      serialize: () => {
        throw new Error('unused');
      },
      restore: () => {},
      winner: 1,
      alivePerTeam: [0, 4, 0, 0, 0, 0, 0],
      scores: [20, 100, 5, 0, 0, 0, 0],
    };
    const host = {
      simProvider: null,
      recordHash: () => {},
      broadcastTick: () => {},
      finish: (winner: number, alive: number[], scores?: number[]) => finished.push({ winner, alive, scores }),
    } as unknown as HostLobby;
    const model = { pendingResync: null, speed: 1, paused: false, hostStep: -1, hostStepAt: 0 } as never;
    new LockstepRunner(sim, model, { host }).advance(0.05);
    expect(finished).toEqual([{ winner: 1, alive: [0, 4, 0, 0, 0, 0], scores: [20, 100, 5, 0, 0, 0] }]);
  });
});
