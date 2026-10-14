import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { battleConfig } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { Terrain } from '../terrain';
import { mulberry32 } from '../random';

function rig(seed = 5) {
  const hub = new LoopbackHub();
  const clock = { t: 1000 };
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
  return { hub, host, hs: new HostSession(host, false), clock };
}
type Rig = ReturnType<typeof rig>;

function spots(r: Rig, team: number, n: number): { x: number; y: number }[] {
  const init = r.hs.model.state!.init!;
  const t = new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
  const z = teamZones(init.size, init.teams, t)[team];
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < init.size && out.length < n; y++)
    for (let x = 0; x < init.size && out.length < n; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (z.contains(px, py) && t.walkable(px, py) && t.reachable(px, py) && out.every((o) => Math.hypot(o.x - px, o.y - py) >= 1.2)) out.push({ x: px, y: py });
    }
  return out;
}

/** Host + guest A in a battle (small armies so it ends fast). */
function battle() {
  const r = rig();
  const a = new GuestSession(r.hub.connect(), { name: 'A', color: 1 });
  r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true } });
  a.send({ t: 'ready', ready: true });
  r.hs.send({ t: 'start' });
  const sp = spots(r, a.model.me!.team, 12);
  a.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y })) });
  a.send({ t: 'ready', ready: true });
  const hp = spots(r, 0, 12);
  r.hs.send({ t: 'place', items: hp.map((p, i) => ({ cid: i, kind: i % 3, x: p.x, y: p.y })) });
  r.hs.send({ t: 'ready', ready: true });
  r.host.tick();
  expect(r.hs.model.state!.phase).toBe('battle');
  const start = r.hs.model.start!;
  const hostSim = new Battle(start.simSeed, battleConfig(start));
  const hostRunner = new LockstepRunner(hostSim, r.hs.model, { host: r.host });
  return { r, a, hostSim, hostRunner, start };
}

function lateRunner(g: GuestSession) {
  const start = g.model.start!;
  const sim = new Battle(start.simSeed, battleConfig(start));
  return { sim, runner: new LockstepRunner(sim, g.model, { send: (m) => g.send(m) }) };
}

describe('late joiners', () => {
  it('a spectator joining in the result phase gets the result and a snapshot that already carries the winner', () => {
    const { r, hostSim, hostRunner } = battle();
    for (let f = 0; f < 60 * 600 && hostSim.winner === -1; f++) hostRunner.advance(1 / 60);
    expect(hostSim.winner).not.toBe(-1);
    expect(r.hs.model.state!.phase).toBe('result');

    const s = new GuestSession(r.hub.connect(), { name: 'S', color: 2, spectator: true });
    expect(s.model.rejected).toBeNull();
    expect(s.model.me?.role).toBe('spectator');
    expect(s.model.result?.winner).toBe(hostSim.winner);
    expect(s.model.start).not.toBeNull();
    expect(s.model.pendingResync).not.toBeNull();
    const { sim, runner } = lateRunner(s);
    runner.advance(1 / 60);
    expect(runner.resyncs).toBe(1);
    expect(sim.winner).toBe(hostSim.winner);
    expect(sim.stepCount).toBe(hostSim.stepCount);
  }, 120000);

  it('a player who rejoins with the token in the result phase also gets the result', () => {
    const { r, a, hostSim, hostRunner } = battle();
    const token = a.model.token;
    for (let f = 0; f < 60 * 600 && hostSim.winner === -1; f++) hostRunner.advance(1 / 60);
    a.leave(true); // drops the connection but keeps the place
    const back = new GuestSession(r.hub.connect(), { name: 'A', color: 1, token });
    expect(back.model.result?.winner).toBe(hostSim.winner);
    expect(back.model.pendingResync).not.toBeNull();
  }, 120000);

  it('a spectator joining mid-battle gets a snapshot; a new placement phase forgets the old result', () => {
    const { r, hostSim, hostRunner } = battle();
    for (let f = 0; f < 120; f++) hostRunner.advance(1 / 60);
    const s = new GuestSession(r.hub.connect(), { name: 'S', color: 2, spectator: true });
    expect(s.model.pendingResync).not.toBeNull();
    expect(s.model.result).toBeNull();
    for (let f = 0; f < 60 * 600 && hostSim.winner === -1; f++) hostRunner.advance(1 / 60);
    r.hs.send({ t: 'rematch' });
    expect(r.hs.model.state!.phase).toBe('placing');
    const s2 = new GuestSession(r.hub.connect(), { name: 'S2', color: 3, spectator: true });
    expect(s2.model.result).toBeNull();
    expect(s2.model.pendingResync).toBeNull();
  }, 120000);
});

describe('delayed delivery', () => {
  it('placement, ready and battle start converge under latency', () => {
    const r = rig(9);
    r.hub.latency = 3;
    const a = new GuestSession(r.hub.connect(), { name: 'A', color: 1 });
    const b = new GuestSession(r.hub.connect(), { name: 'B', color: 2 });
    r.hub.pump(10);
    expect(r.hs.model.state!.players.length).toBe(3);
    for (const g of [a, b]) g.send({ t: 'ready', ready: true });
    r.hub.pump(10);
    r.hs.send({ t: 'start' });
    r.hub.pump(10);
    expect(a.model.state!.phase).toBe('placing');
    const sp = spots(r, a.model.me!.team, 6);
    a.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: 0, x: p.x, y: p.y })) });
    b.send({ t: 'ready', ready: true });
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.hub.pump(10);
    r.host.tick();
    r.hub.pump(10);
    expect(r.hs.model.state!.phase).toBe('battle');
    expect(a.model.state!.phase).toBe('battle');
    expect(b.model.start).not.toBeNull();
    expect(a.model.start!.simSeed).toBe(r.hs.model.start!.simSeed);
    expect(a.model.start!.layout).toEqual(r.hs.model.start!.layout);
  });
});
