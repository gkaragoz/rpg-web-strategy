import { describe, expect, it } from 'vitest';
import { MAX_COST, MIN_COST, buyable, costTable, mapSizeForPlayers, spent, teamZones, unitGold } from '../../net/economy';
import { PRESETS } from '../mapSpec';
import { Terrain } from '../terrain';
import { KIND_COUNT, STATS, Kind, setUnitLevel } from '../units';

describe('gold cost', () => {
  it('the basic unit costs 10 gold; all costs are in range and multiples of 5', () => {
    for (const lv of [1, 5, 10]) {
      const c = costTable(lv);
      expect(c[Kind.Warrior]).toBe(10);
      for (let k = 0; k < KIND_COUNT; k++) {
        expect(c[k], `${STATS[k].name} L${lv}`).toBeGreaterThanOrEqual(MIN_COST);
        expect(c[k]).toBeLessThanOrEqual(MAX_COST);
        expect(c[k] % 5).toBe(0);
      }
    }
    setUnitLevel(5);
  });

  it('cost of roster units never decreases as the level rises; tanks are expensive', () => {
    const lo = costTable(1);
    const hi = costTable(10);
    for (let k = 5; k < KIND_COUNT; k++) expect(hi[k], STATS[k].name).toBeGreaterThanOrEqual(lo[k]);
    expect(hi[Kind.Shield]).toBeGreaterThan(hi[Kind.Warrior] * 2);
    setUnitLevel(5);
  });

  it('budget calculation and buyability', () => {
    const c = costTable(5);
    expect(spent([{ kind: 0 }, { kind: 0 }, { kind: 3 }], c)).toBe(c[0] * 2 + c[3]);
    expect(buyable(0)).toBe(true);
    expect(unitGold(0)).toBe(10);
    expect(mapSizeForPlayers(2)).toBeLessThan(mapSizeForPlayers(6));
  });
});

describe('team zones', () => {
  it('zones do not overlap and every team has enough walkable area', () => {
    for (const p of PRESETS) {
      for (const teams of [2, 3, 4, 6]) {
        const size = mapSizeForPlayers(teams);
        const t = new Terrain(size, { seed: 3, spec: p.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
        const zones = teamZones(size, teams, t);
        for (const z of zones) expect(z.area, `${p.id} ${teams} team ${z.team}`).toBeGreaterThan(60);
        for (let y = 0; y < size; y += 2) for (let x = 0; x < size; x += 2) {
          let n = 0;
          for (const z of zones) if (z.contains(x + 0.5, y + 0.5)) n++;
          expect(n).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('with 2 teams the zone areas are equal (point-symmetric map)', () => {
    const spec = { ...PRESETS[0].spec, relief: 'flat' as const, layout: 'classic' as const };
    const size = 56;
    const t = new Terrain(size, { seed: 2, spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
    const [a, b] = teamZones(size, 2, t);
    expect(Math.abs(a.area - b.area) / Math.max(a.area, b.area)).toBeLessThan(0.03);
  });
});
