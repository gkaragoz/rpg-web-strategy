import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { GuestSession, HostSession } from '../../net/client';
import { teamZones } from '../../net/economy';
import { HostLobby } from '../../net/host';
import { battleConfig } from '../../net/protocol';
import { LoopbackHub } from '../../net/transport';
import { Terrain } from '../terrain';
import { mulberry32 } from '../random';

/** Sets up a battle and steps it like the online flow does (random map, random placement inside the zone): setup must not throw. */
describe('online battle setup (random map + placement)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`seed ${seed}`, () => {
      const rnd = mulberry32(seed * 104729);
      const hub = new LoopbackHub();
      const clock = { t: 1000 };
      const host = new HostLobby(hub.host, 'Host', 0, { now: () => clock.t, rnd: mulberry32(seed) });
      const hs = new HostSession(host, false);
      const n = 2 + Math.floor(rnd() * 5); // 2..6 players
      const guests: GuestSession[] = [];
      for (let i = 1; i < n; i++) guests.push(new GuestSession(hub.connect(), { name: `G${i}`, color: i }));
      hs.send({ t: 'settings', settings: { mapMode: 'random', gold: 2000, level: 1 + Math.floor(rnd() * 10), comedyPhysics: rnd() < 0.3, openPlacement: rnd() < 0.5, placeSecs: 60, mapSize: [0, 0, 40, 56, 80][Math.floor(rnd() * 5)] } });
      for (const g of guests) g.send({ t: 'ready', ready: true });
      hs.send({ t: 'start' });
      const init = hs.model.state!.init!;
      expect(init).toBeTruthy();
      const t = new Terrain(init.size, { seed: init.seed, spec: init.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
      const zones = teamZones(init.size, init.teams, t);
      const all = [hs, ...guests];
      all.forEach((s, idx) => {
        const team = s.model.me!.team;
        const items = [];
        for (let k = 0; k < 400 && items.length < 150; k++) {
          const x = 1 + rnd() * (init.size - 2);
          const y = 1 + rnd() * (init.size - 2);
          if (zones[team].contains(x, y) && t.walkable(x, y) && t.reachable(x, y)) items.push({ cid: idx * 1000 + k, kind: Math.floor(rnd() * 5), x, y });
        }
        for (let i = 0; i < items.length; i += 50) s.send({ t: 'place', items: items.slice(i, i + 50) });
      });
      // Let the time run out (without anyone getting ready).
      clock.t += 61000;
      host.tick();
      hub.pump();
      expect(hs.model.state!.phase).toBe('battle');
      const start = hs.model.start!;
      expect(start.layout.length).toBeGreaterThan(0);
      for (const s of guests) expect(s.model.start).not.toBeNull();
      let sim: Battle | null = null;
      expect(() => {
        sim = new Battle(start.simSeed, battleConfig(start));
        for (let i = 0; i < 90; i++) sim.step(1 / 30);
      }).not.toThrow();
      expect(sim!.units.count).toBe(start.layout.length / 4);
    });
  }
});
