import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { PROTOCOL, battleConfig, type ClientMsg } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { Terrain } from '../terrain';
import { mulberry32 } from '../random';

function rig(seed = 1): { hub: LoopbackHub; host: HostLobby; hs: HostSession; clock: { t: number } } {
  const hub = new LoopbackHub();
  const clock = { t: 1000 };
  const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
  return { hub, host, hs: new HostSession(host, false), clock };
}
type Rig = ReturnType<typeof rig>;
const join = (r: Rig, name: string, extra: Partial<ConstructorParameters<typeof GuestSession>[1]> = {}): GuestSession => new GuestSession(r.hub.connect(), { name, color: 1, ...extra });

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

function three(): { r: Rig; a: GuestSession; b: GuestSession } {
  const r = rig(11);
  const a = join(r, 'A');
  const b = join(r, 'B');
  for (const g of [a, b]) g.send({ t: 'ready', ready: true });
  r.hs.send({ t: 'start' });
  expect(r.hs.model.state!.phase).toBe('placing');
  return { r, a, b };
}

describe('leaving mid-game', () => {
  it('when a player leaves during placement, team numbers do not shift; the rest can still place', () => {
    const { r, a, b } = three();
    const teamB = b.model.me!.team;
    expect(teamB).toBe(2);
    a.leave();
    const st = r.hs.model.state!;
    expect(st.players.find((p) => p.name === 'B')!.team).toBe(teamB);
    expect(st.players.filter((p) => p.role === 'player').length).toBe(3); // the departed player stays as a ghost
    expect(st.players.some((p) => !p.connected)).toBe(true);
    const sp = spots(r, teamB, 3);
    b.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: 0, x: p.x, y: p.y })) });
    expect(b.model.placed.size).toBe(3);
    expect([...b.model.placed.values()].every((u) => u.team === teamB)).toBe(true);
    b.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    expect(r.hs.model.start!.init.teamPlayers.length).toBe(3);
  });

  it('a kick does not shift teams during placement either; the ghost is cleaned up on return to the lobby', () => {
    const { r, a, b } = three();
    const teamB = b.model.me!.team;
    r.hs.send({ t: 'kick', id: a.model.you });
    expect(r.hs.model.state!.players.find((p) => p.name === 'B')!.team).toBe(teamB);
    b.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    r.hs.send({ t: 'rematch' });
    const st = r.hs.model.state!;
    expect(st.phase).toBe('lobby');
    expect(st.players.map((p) => p.name).sort()).toEqual(['B', 'Host']);
    expect(st.players.find((p) => p.name === 'B')!.team).toBe(1);
  });

  it('when a spectator leaves, player teams are unaffected', () => {
    const { r, b } = three();
    const s = join(r, 'S', { spectator: true });
    const team = b.model.me!.team;
    s.leave();
    expect(r.hs.model.state!.players.find((p) => p.name === 'B')!.team).toBe(team);
    expect(r.hs.model.state!.players.some((p) => p.name === 'S')).toBe(false);
  });
});

describe('connection edge cases', () => {
  it('a second join from the same connection is ignored (no duplicate player)', () => {
    const r = rig();
    const ep = r.hub.connect();
    const g = new GuestSession(ep, { name: 'A', color: 1 });
    ep.send('host', { t: 'join', name: 'A', color: 1, version: PROTOCOL } as ClientMsg);
    expect(r.hs.model.state!.players.length).toBe(2);
    expect(g.model.me).not.toBeNull();
  });

  it('a new connection with the token replaces a half-open old connection', () => {
    const { r, b } = three();
    const token = b.model.token;
    const team = b.model.me!.team;
    const back = join(r, 'B', { token });
    expect(back.model.rejected).toBeNull();
    expect(back.model.me!.team).toBe(team);
    expect(r.hs.model.state!.players.filter((p) => p.role === 'player').length).toBe(3);
    expect(r.hs.model.state!.players.find((p) => p.team === team)!.connected).toBe(true);
    expect(back.model.me!.ready).toBe(false);
  });

  it('malformed messages do not take the host down', () => {
    const { r, a } = three();
    const ep = r.hub.connect();
    const g = new GuestSession(ep, { name: 'X', color: 2, spectator: true });
    const junk: unknown[] = [
      { t: 'place', items: 5 },
      { t: 'place', items: [null, 1, { cid: 'x' }] },
      { t: 'unplace', ids: 'abc' },
      { t: 'unplace', ids: [null, {}] },
      { t: 'check', step: NaN, hash: 'x' },
      { t: 'presence', x: 'a', y: null },
      { t: 'chat', text: 12345 },
      { t: 'nope' },
      null,
      42,
    ];
    for (const m of junk) expect(() => ep.send('host', m as ClientMsg)).not.toThrow();
    for (const m of junk) expect(() => a.send(m as ClientMsg)).not.toThrow();
    expect(r.hs.model.state!.phase).toBe('placing');
    expect(g.model.me).not.toBeNull();
  });

  it('a message flood hits the rate limit but normal flow is unaffected', () => {
    const { r, a } = three();
    const sp = spots(r, a.model.me!.team, 1)[0];
    for (let i = 0; i < 2000; i++) a.send({ t: 'place', items: [{ cid: i, kind: 0, x: sp.x, y: sp.y }] });
    expect(r.hs.model.state!.phase).toBe('placing');
    expect([...a.model.placed.values()].length).toBe(1);
    r.clock.t += 5000; // the token bucket refills
    a.send({ t: 'chat', text: 'selam' });
    expect(a.model.chat.length).toBeGreaterThan(0);
  });

  it('an old-version client (PROTOCOL - 1) is rejected', () => {
    const r = rig();
    const ep = r.hub.connect();
    let rej = '';
    ep.onMessage = (_f, m) => {
      if ((m as { t: string }).t === 'reject') rej = (m as { reason: string }).reason;
    };
    ep.send('host', { t: 'join', name: 'v1', color: 1, version: PROTOCOL - 1 } as ClientMsg);
    expect(rej).toBe('version');
  });
});

describe('chat ordering', () => {
  it('after more than 200 messages the sequence number keeps increasing', () => {
    const r = rig();
    const g = join(r, 'A');
    for (let i = 0; i < 260; i++) {
      r.clock.t += 3000; // stay under the spam limit
      g.send({ t: 'chat', text: `m${i}` });
    }
    const chat = g.model.chat;
    expect(chat.length).toBe(200);
    expect(chat[chat.length - 1].n).toBe(260);
    expect(chat[0].n).toBe(61);
    expect(chat.every((c, i) => i === 0 || c.n === chat[i - 1].n + 1)).toBe(true);
  });
});

describe('lockstep edge cases', () => {
  function startBattle(): { r: Rig; a: GuestSession } {
    const r = rig(5);
    const a = join(r, 'A');
    r.hs.send({ t: 'settings', settings: { gold: 600, openPlacement: true } });
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'start' });
    for (const [g, team] of [
      [a, 1],
      [r.hs, 0],
    ] as const) {
      const sp = spots(r, team, 10);
      g.send({ t: 'place', items: sp.map((p, i) => ({ cid: i, kind: 0, x: p.x, y: p.y })) });
      g.send({ t: 'ready', ready: true });
    }
    r.host.tick();
    expect(r.hs.model.state!.phase).toBe('battle');
    return { r, a };
  }

  it('when the host pauses, the pause is broadcast; a guest does not run ahead on estimates', () => {
    const { r, a } = startBattle();
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(start));
    let t = 0;
    const hr = new LockstepRunner(hostSim, r.hs.model, { host: r.host, now: () => t });
    const gr = new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m), now: () => t });
    for (let i = 0; i < 120; i++) {
      t += 16;
      hr.advance(1 / 60);
      gr.advance(1 / 60);
      r.hub.pump();
    }
    hr.paused = true; // e.g. the tab went to the background
    const frozen = hostSim.stepCount;
    for (let i = 0; i < 600; i++) {
      t += 16;
      hr.advance(1 / 60);
      gr.advance(1 / 60);
      r.hub.pump();
    }
    expect(hostSim.stepCount).toBe(frozen);
    expect(a.model.paused).toBe(true);
    expect(guestSim.stepCount).toBeLessThanOrEqual(frozen + 3);
  });

  it('if the host goes silent, the guest estimate stays capped at 1.5 s', () => {
    const { r, a } = startBattle();
    const start = r.hs.model.start!;
    const hostSim = new Battle(start.simSeed, battleConfig(start));
    const guestSim = new Battle(start.simSeed, battleConfig(start));
    let t = 0;
    const hr = new LockstepRunner(hostSim, r.hs.model, { host: r.host, now: () => t });
    const gr = new LockstepRunner(guestSim, a.model, { send: (m) => a.send(m), now: () => t });
    for (let i = 0; i < 60; i++) {
      t += 16;
      hr.advance(1 / 60);
      gr.advance(1 / 60);
      r.hub.pump();
    }
    const hs = a.model.hostStep;
    for (let i = 0; i < 1800; i++) {
      t += 16;
      gr.advance(1 / 60); // the host is frozen: no tick
      r.hub.pump();
    }
    expect(guestSim.stepCount).toBeLessThanOrEqual(hs + 30 * 1.5 + 12);
  });

  it('if no unit is placed, the battle ends without hanging', () => {
    const r = rig(3);
    const a = join(r, 'A');
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'start' });
    a.send({ t: 'ready', ready: true });
    r.hs.send({ t: 'ready', ready: true });
    r.host.tick();
    const start = r.hs.model.start!;
    const sim = new Battle(start.simSeed, battleConfig(start));
    for (let i = 0; i < 30 * 60 && sim.winner === -1; i++) sim.step(1 / 30);
    expect(sim.winner).not.toBe(-1);
  });
});
