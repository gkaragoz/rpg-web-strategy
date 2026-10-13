import { describe, expect, it } from 'vitest';
import { ONLINE_MAP_SIZES, teamZones } from '../../net/economy';
import { Terrain } from '../terrain';

const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };

describe('big maps', () => {
  it('the largest online sizes generate quickly and leave every team a usable zone', () => {
    for (const size of ONLINE_MAP_SIZES.filter((s) => s >= 160)) {
      for (const seed of [3, 41]) {
        const t0 = performance.now();
        const t = new Terrain(size, { seed, ...opts });
        const ms = performance.now() - t0;
        expect(ms, `size ${size} seed ${seed} generation ms`).toBeLessThan(3000);
        for (const teams of [2, 6]) {
          const zones = teamZones(size, teams, t);
          expect(zones.every((z) => z.area > 90), `size ${size} teams ${teams}`).toBe(true);
        }
      }
    }
  });
});
