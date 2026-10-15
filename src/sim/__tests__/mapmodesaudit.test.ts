import { describe, expect, it } from 'vitest';
import { mapSizeForPlayers, placeBlock, teamZones } from '../../net/economy';
import { Battle } from '../battle';
import { hillControlPoints, hillRadius, ctfRadius } from '../modes';
import { NEW_LAYOUTS, battleOn, detour, listedSpecs, newPresets, opts, zoneRows } from '../testing/mapAudit';
import { Terrain } from '../terrain';

describe('mode audits: the required points of every listed map are walkable and reachable', () => {
  const SEEDS = [1, 5];

  it('hill: three control points, reachable from every team, 2-6 teams', () => {
    for (const [name, spec] of listedSpecs('hill')) {
      for (const size of [40, mapSizeForPlayers(4), 100]) {
        for (const seed of SEEDS) {
          const t = new Terrain(size, { seed, spec, ...opts });
          for (const teams of [2, 3, 6]) {
            const where = `${name} ${size} seed ${seed} ${teams} teams`;
            const zones = teamZones(size, teams, t);
            const pts = hillControlPoints(t, size, zones.map((z) => ({ x: z.cx, y: z.cy })));
            expect(pts.length, where).toBe(3);
            for (const q of pts) {
              expect(t.walkable(q.x, q.y) && t.reachable(q.x, q.y), `${where} point`).toBe(true);
            }
            for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y), `${where} apart`).toBeGreaterThan(hillRadius(size));
            for (const z of zones) {
              const a = t.nearestWalkable(z.cx, z.cy, 12, true)!;
              for (const q of pts) {
                const d = detour(t, a, q);
                expect(d, `${where} team ${z.team} route`).not.toBeNull();
                expect(d!, `${where} team ${z.team} detour`).toBeLessThan(4);
              }
            }
          }
        }
      }
    }
  }, 120000);

  it('ctf: every base is walkable and reachable, bases are connected and apart (2-6 teams)', () => {
    for (const [name, spec] of listedSpecs('ctf')) {
      for (const teams of [2, 3, 6]) {
        for (const size of [mapSizeForPlayers(teams), 120]) {
          const seed = size === 120 ? 5 : 1;
          const { b, t } = battleOn(spec, 'ctf', size, teams, seed);
          const h = b.modeHud();
          if (h.kind !== 'ctf') throw new Error('not ctf');
          const where = `${name} ${teams} teams ${size}`;
          expect(h.flags.length, where).toBe(teams);
          for (const f of h.flags) expect(t.walkable(f.x, f.y) && t.reachable(f.x, f.y), `${where} base ${f.team}`).toBe(true);
          for (let i = 0; i < h.flags.length; i++) {
            for (let j = i + 1; j < h.flags.length; j++) {
              const d = detour(t, h.flags[i], h.flags[j]);
              expect(d, `${where} bases ${i}-${j}`).not.toBeNull();
              expect(d!, `${where} bases ${i}-${j} detour`).toBeLessThan(3.5);
              expect(Math.hypot(h.flags[i].x - h.flags[j].x, h.flags[i].y - h.flags[j].y), `${where} bases ${i}-${j} apart`).toBeGreaterThan(ctfRadius(size) * 2);
            }
          }
        }
      }
    }
  }, 180000);

  it('siege: the core is walkable and reachable, and every attacker has a route to it', () => {
    for (const [name, spec] of listedSpecs('siege')) {
      for (const teams of [2, 3, 6]) {
        for (const size of [mapSizeForPlayers(teams), 120]) {
          for (const defender of [0, teams - 1]) {
            const { b, t, anchors } = battleOn(spec, 'siege', size, teams, size === 120 ? 5 : 1, { siegeDefender: defender });
            const h = b.modeHud();
            if (h.kind !== 'siege') throw new Error('not siege');
            const where = `${name} ${teams} teams ${size} defender ${defender}`;
            expect(h.coreUnit, where).toBeGreaterThanOrEqual(0);
            expect(t.walkable(h.x, h.y) && t.reachable(h.x, h.y), `${where} core`).toBe(true);
            anchors.forEach((a, team) => {
              if (team === defender) return;
              const d = detour(t, a, h);
              expect(d, `${where} attacker ${team}`).not.toBeNull();
              expect(d!, `${where} attacker ${team} detour`).toBeLessThan(3.5);
            });
          }
        }
      }
    }
  }, 180000);

  it('horde: gates are walkable and reachable from the humans, 1-5 human teams', () => {
    for (const [name, spec] of listedSpecs('horde')) {
      for (const teams of [1, 2, 5]) {
        for (const size of [40, mapSizeForPlayers(teams), 120]) {
          const t0 = new Terrain(size, { seed: 3, spec, ...opts });
          const { rows, anchors } = zoneRows(t0, size, Math.max(2, teams));
          const keep = rows.filter((r) => r[0] < teams);
          const b = new Battle(5, { mode: 'custom', perTeam: 0, teamCount: teams, mapSize: size, env: true, kite: true, terrainSeed: 3, map: spec, rules: 'horde', layout: new Float32Array(keep.flat()) });
          const state = b.mode.serialize();
          const gates = state[2];
          const where = `${name} ${size} ${teams}`;
          expect(gates, where).toBeGreaterThanOrEqual(1);
          for (let g = 0; g < gates; g++) {
            const gx = state[3 + g * 2];
            const gy = state[4 + g * 2];
            expect(b.terrain!.walkable(gx, gy) && b.terrain!.reachable(gx, gy), `${where} gate ${g}`).toBe(true);
            for (let a = 0; a < teams; a++) {
              const d = detour(b.terrain!, anchors[a], { x: gx, y: gy });
              expect(d, `${where} gate ${g} from team ${a}`).not.toBeNull();
            }
          }
        }
      }
    }
  }, 180000);

  it('vip: every listed map has usable team zones that are connected', () => {
    for (const [name, spec] of listedSpecs('vip')) {
      for (const size of [56, 100]) {
        const t = new Terrain(size, { seed: 2, spec, ...opts });
        for (const teams of [2, 4, 6]) {
          const zones = teamZones(size, teams, t);
          const anchors = zones.map((z) => t.nearestWalkable(z.cx, z.cy, 12, true)!);
          zones.forEach((z, i) => {
            expect(z.area, `${name} ${size} ${teams} zone ${i}`).toBeGreaterThan(90);
            expect(anchors[i]).toBeTruthy();
          });
          for (let i = 1; i < teams; i++) expect(detour(t, anchors[0], anchors[i]), `${name} ${size} ${teams} route 0-${i}`).not.toBeNull();
        }
      }
    }
  }, 120000);
});

describe('new layouts: shared map audits', () => {
  it('no unreachable ground, nothing sealed, point-symmetric, roomy zones, connected zones (all presets, several sizes and seeds)', () => {
    for (const p of newPresets()) {
      for (const size of [40, 56, 80, 120]) {
        for (const seed of [1, 2, 7]) {
          const t = new Terrain(size, { seed, spec: p.spec, ...opts });
          const n = size;
          let walkable = 0;
          let asym = 0;
          let heightAsym = 0;
          for (let i = 0; i < n * n; i++) {
            if (t.flags[i] !== t.flags[n * n - 1 - i]) asym++;
            if (t.height[i] !== t.height[n * n - 1 - i]) heightAsym++;
            if (t.walkable((i % n) + 0.5, ((i / n) | 0) + 0.5)) {
              walkable++;
              expect(t.reachable((i % n) + 0.5, ((i / n) | 0) + 0.5), `${p.id} ${size} seed ${seed} tile ${i}`).toBe(true);
            }
          }
          const where = `${p.id} ${size} seed ${seed}`;
          expect(asym, `${where} flags`).toBe(0);
          expect(heightAsym, `${where} heights`).toBe(0);
          expect(t.fixInfo.sealed, `${where} sealed`).toBe(0);
          expect(t.fixInfo.ramps, `${where} ramps`).toBe(0);
          expect(walkable, where).toBeGreaterThan(n * n * 0.4);
          for (const teams of [2, 4, 6]) {
            const zones = teamZones(size, teams, t);
            if (size >= 56) for (const z of zones) expect(z.area, `${where} ${teams} teams zone ${z.team}`).toBeGreaterThan(90);
            else for (const z of zones) expect(z.area, `${where} ${teams} teams zone ${z.team}`).toBeGreaterThanOrEqual(50);
            const anchors = zones.map((z) => t.nearestWalkable(z.cx, z.cy, 10, true));
            for (let a = 0; a < teams; a++) {
              expect(anchors[a], `${where} anchor ${a}`).not.toBeNull();
              for (let c = a + 1; c < teams; c++) {
                const d = detour(t, anchors[a]!, anchors[c]!);
                expect(d, `${where} ${teams} teams route ${a}-${c}`).not.toBeNull();
                expect(d!, `${where} ${teams} teams route ${a}-${c} detour`).toBeLessThan(2.2);
              }
            }
          }
          // Mirror fairness: with two teams the zones hold the same area.
          const [z0, z1] = teamZones(size, 2, t);
          expect(Math.abs(z0.area - z1.area) / Math.max(z0.area, z1.area), `${where} zone balance`).toBeLessThan(0.02);
        }
      }
    }
  }, 240000);

  it('everything a player can place is placeable: placeBlock accepts the walkable tiles of both zones and the demo spawn area is respected', () => {
    for (const p of newPresets()) {
      const size = 56;
      const t = new Terrain(size, { seed: 4, spec: p.spec, ...opts });
      for (const z of teamZones(size, 2, t)) {
        let ok = 0;
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (placeBlock(t, z, x + 0.5, y + 0.5) === null) ok++;
        expect(ok, `${p.id} zone ${z.team}`).toBeGreaterThan(200);
      }
      // The classic demo/bench layouts reserve a spawn area: the layouts still build, stay reachable and symmetric around it.
      const demo = new Terrain(size, { seed: 4, spec: p.spec, spawnD0: 8, spawnD1: 14.5, spawnHalfS: 7 });
      const a = demo.nearestWalkable(size * 0.25, size * 0.75, 12, true);
      const b = demo.nearestWalkable(size * 0.75, size * 0.25, 12, true);
      expect(demo.findPath(a!.x, a!.y, b!.x, b!.y), `${p.id} demo spawn`).not.toBeNull();
      for (let i = 0; i < size * size; i++) expect(demo.flags[i], `${p.id} demo symmetry`).toBe(demo.flags[size * size - 1 - i]);
    }
  });

  it('is deterministic (same seed, same terrain), varies with the seed, and builds fast at 120 and 256 tiles', () => {
    const hash = (t: Terrain): string => {
      let h = 2166136261;
      const mix = (v: number): void => {
        h = Math.imul(h ^ (v | 0), 16777619) >>> 0;
      };
      for (let i = 0; i < t.flags.length; i++) {
        mix(t.flags[i]);
        mix(t.height[i]);
      }
      for (const d of t.decor) {
        mix(d.kind.length * 31 + d.variant);
        mix(Math.round(d.x * 100));
        mix(Math.round(d.y * 100));
      }
      return h.toString(16);
    };
    for (const p of newPresets()) {
      const a = hash(new Terrain(80, { seed: 11, spec: p.spec, ...opts }));
      expect(hash(new Terrain(80, { seed: 11, spec: p.spec, ...opts })), `${p.id} determinism`).toBe(a);
      expect(hash(new Terrain(80, { seed: 12, spec: p.spec, ...opts })), `${p.id} seed varies`).not.toBe(a);
    }
    for (const size of [120, 256]) {
      for (const layout of NEW_LAYOUTS) {
        const spec = newPresets().find((p) => p.spec.layout === layout)!.spec;
        new Terrain(size, { seed: 1, spec, ...opts }); // warm up
        const t0 = performance.now();
        for (let k = 0; k < 3; k++) new Terrain(size, { seed: 2 + k, spec, ...opts });
        const ms = (performance.now() - t0) / 3;
        expect(ms, `${layout} ${size}`).toBeLessThan(size === 120 ? 400 : 1500);
      }
    }
  }, 60000);
});

