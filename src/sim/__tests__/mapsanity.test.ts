import { describe, expect, it } from 'vitest';
import { teamZones } from '../../net/economy';
import { DEFAULT_MAP, LAYOUTS, PRESETS, RELIEFS, RIVERS, type MapSpec } from '../mapSpec';
import { Terrain } from '../terrain';

const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };

function specs(): Array<[string, MapSpec]> {
  const out: Array<[string, MapSpec]> = PRESETS.map((p) => [p.id, p.spec] as [string, MapSpec]);
  for (const l of LAYOUTS) out.push([`layout:${l}`, { ...DEFAULT_MAP, layout: l }]);
  for (const r of RELIEFS) out.push([`relief:${r}`, { ...DEFAULT_MAP, relief: r }]);
  for (const r of RIVERS) out.push([`river:${r}`, { ...DEFAULT_MAP, river: r }]);
  return out;
}

/** Every generated map must be playable: no ground that cannot be reached, fair (point-symmetric), roomy team zones. */
describe('map sanity', () => {
  it('has no unreachable walkable ground, stays point-symmetric and keeps team zones usable (all presets, layouts, reliefs, rivers)', () => {
    for (const [name, spec] of specs()) {
      for (const size of [56, 80]) {
        for (const seed of [1, 7, 23]) {
          const t = new Terrain(size, { seed, spec, ...opts });
          const n = size;
          let walkable = 0;
          let unreachable = 0;
          let asym = 0;
          for (let i = 0; i < n * n; i++) {
            if (t.flags[i] !== t.flags[n * n - 1 - i]) asym++;
            if (t.walkable((i % n) + 0.5, ((i / n) | 0) + 0.5)) {
              walkable++;
              if (!t.reachable((i % n) + 0.5, ((i / n) | 0) + 0.5)) unreachable++;
            }
          }
          const where = `${name} size ${size} seed ${seed}`;
          expect(unreachable, `${where}: unreachable walkable tiles`).toBe(0);
          expect(asym, `${where}: asymmetric tiles`).toBe(0);
          expect(t.fixInfo.sealed / (n * n), `${where}: too much ground had to be sealed`).toBeLessThan(spec.layout === 'valley' ? 0.15 : 0.04);
          expect(walkable, where).toBeGreaterThan(n * n * 0.3);
          for (const teams of [2, 4, 6]) expect(teamZones(size, teams, t).every((z) => z.area > 90), `${where}: ${teams} team zones`).toBe(true);
        }
      }
    }
  }, 240000);
});
