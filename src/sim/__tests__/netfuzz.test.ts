import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { spent, teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { LockstepRunner } from '../../net/lockstep';
import { PROTOCOL, battleConfig, MAX_PLAYERS, type ClientMsg } from '../../net/protocol';
import { LoopbackHub, type LoopbackEndpoint } from '../../net/transport';
import { Terrain } from '../terrain';
import { mulberry32 } from '../random';

interface Client {
  s: GuestSession;
  ep: LoopbackEndpoint;
  token: string;
  name: string;
  alive: boolean;
}

function zoneSpot(host: HostLobby, init: NonNullable<ReturnType<HostLobby['state']>['init']>, team: number, rnd: () => number): { x: number; y: number } | null {
  const t = new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
  const z = teamZones(init.size, init.teams, t)[team];
  void host;
  for (let k = 0; k < 60; k++) {
    const x = 1 + rnd() * (init.size - 2);
    const y = 1 + rnd() * (init.size - 2);
    if (z.contains(x, y) && t.walkable(x, y) && t.reachable(x, y)) return { x, y };
  }
  return null;
}

function checkInvariants(host: HostLobby, hs: HostSession): void {
  const st = host.state();
  const players = st.players.filter((p) => p.role === 'player');
  // ids are unique
  expect(new Set(st.players.map((p) => p.id)).size).toBe(st.players.length);
  // player teams are unique and spectators are -1
  const teams = players.map((p) => p.team);
  expect(new Set(teams).size).toBe(teams.length);
  for (const p of st.players) if (p.role === 'spectator') expect(p.team).toBe(-1);
  expect(players.length).toBeLessThanOrEqual(MAX_PLAYERS);
  expect(st.players.filter((p) => p.id === st.hostId).length).toBe(1);
  if (st.phase === 'lobby') {
    // no disconnected/ghost players remain in the lobby and teams are 0..n-1
    expect(players.every((p) => p.connected)).toBe(true);
    expect([...teams].sort((a, b) => a - b)).toEqual(players.map((_, i) => i));
  } else if (st.init) {
    // during a game, team indices are consistent with init
    for (const p of players) expect(p.team).toBeLessThan(st.init.teams);
    expect(st.init.teamPlayers.length).toBe(st.init.teams);
    const costs = st.init.costs;
    for (const p of players) {
      const mine = [...hs.model.placed.values()].filter((u) => u.team === p.team);
      void mine;
      expect(p.gold).toBeGreaterThanOrEqual(0);
      expect(p.gold).toBeLessThanOrEqual(st.init.gold);
    }
    void spent;
    void costs;
  }
}

describe('online random operation sequences (fuzz)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`invariants hold, the host survives, the battle stays in sync (seed ${seed})`, () => {
      const rnd = mulberry32(seed * 7919);
      const hub = new LoopbackHub();
      const clock = { t: 1000 };
      const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
      const hs = new HostSession(host, false);
      const clients: Client[] = [];
      let n = 0;
      const connect = (token?: string, spectator = false, name?: string): Client => {
        const ep = hub.connect();
        const nm = name ?? `P${n++}`;
        const s = new GuestSession(ep, { name: nm, color: Math.floor(rnd() * 6), token, spectator });
        const c: Client = { s, ep, token: '', name: nm, alive: true };
        clients.push(c);
        return c;
      };
      const live = (): Client[] => clients.filter((c) => c.alive && c.s.model.me !== null && !c.s.model.closedReason);
      const pick = <T>(a: T[]): T | undefined => a[Math.floor(rnd() * a.length)];

      for (let step = 0; step < 220; step++) {
        clock.t += 200 + Math.floor(rnd() * 800);
        const st = host.state();
        const op = Math.floor(rnd() * 14);
        const c = pick(live());
        try {
          switch (op) {
            case 0:
              if (clients.length < 12) connect(undefined, rnd() < 0.2);
              break;
            case 1:
              c?.s.send({ t: 'ready', ready: rnd() < 0.7 });
              break;
            case 2:
              if (c) {
                const init = st.init;
                if (init && st.phase === 'placing') {
                  const me = c.s.model.me!;
                  if (me.role === 'player') {
                    const items = [];
                    for (let i = 0; i < 1 + Math.floor(rnd() * 6); i++) {
                      const sp = zoneSpot(host, init, rnd() < 0.15 ? Math.floor(rnd() * init.teams) : me.team, rnd);
                      if (sp) items.push({ cid: step * 10 + i, kind: Math.floor(rnd() * 5), x: sp.x, y: sp.y });
                    }
                    c.s.send({ t: 'place', items });
                  }
                }
              }
              break;
            case 3:
              if (c && st.phase === 'placing') {
                const ids = [...c.s.model.placed.keys()].filter(() => rnd() < 0.5);
                if (ids.length) c.s.send({ t: 'unplace', ids });
              }
              break;
            case 4:
              if (c && rnd() < 0.5) {
                c.alive = false;
                c.token = c.s.model.token;
                c.ep.close(); // the connection drops
              }
              break;
            case 5: {
              // reconnect
              const dead = clients.filter((x) => !x.alive && x.token);
              const d = pick(dead);
              if (d) {
                d.alive = false;
                d.token = '';
                connect(d.token || undefined, false, d.name);
              }
              break;
            }
            case 6:
              c?.s.send({ t: 'leave' });
              if (c) c.alive = false;
              break;
            case 7: {
              const victim = pick(live());
              if (victim) hs.send({ t: 'kick', id: victim.s.model.you });
              break;
            }
            case 8:
              hs.send({ t: 'start' });
              break;
            case 9:
              hs.send({ t: 'rematch' });
              break;
            case 10:
              hs.send({ t: 'settings', settings: { gold: 300 + Math.floor(rnd() * 1000), openPlacement: rnd() < 0.5, placeSecs: rnd() < 0.5 ? 0 : 60, mapMode: 'random' } });
              break;
            case 11:
              c?.s.send({ t: 'chat', text: 'x'.repeat(Math.floor(rnd() * 300)) });
              break;
            case 12:
              hs.send({ t: 'ready', ready: true });
              break;
            case 13:
              c?.ep.send('host', { t: 'join', name: 'dup', color: 1, version: PROTOCOL } as ClientMsg);
              break;
          }
          host.tick();
          hub.pump();
        } catch (e) {
          throw new Error(`seed ${seed} step ${step} op ${op}: ${(e as Error).message}\n${(e as Error).stack}`);
        }
        checkInvariants(host, hs);
      }

      // If there is a battle, all connected clients must finish with the same hash.
      if (host.state().phase === 'battle' && hs.model.start) {
        const start = hs.model.start;
        const guests = live().filter((x) => x.s.model.start);
        const mk = (): Battle => new Battle(start.simSeed, battleConfig(start));
        const hostSim = mk();
        const sims = [hostSim, ...guests.map(() => mk())];
        const runners = [new LockstepRunner(hostSim, hs.model, { host }), ...guests.map((g, i) => new LockstepRunner(sims[i + 1], g.s.model, { send: (m) => g.s.send(m) }))];
        for (let f = 0; f < 60 * 120 && !sims.every((s) => s.winner !== -1); f++) {
          for (const r of runners) r.advance(1 / 60);
          hub.pump();
        }
        const winners = new Set(sims.map((s) => s.winner));
        expect(winners.size).toBe(1);
        expect(new Set(sims.map((s) => s.hash())).size).toBe(1);
      }
    });
  }
});
