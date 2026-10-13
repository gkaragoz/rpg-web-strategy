import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP, LAYOUTS, RELIEFS, type MapSpec } from '../mapSpec';
import { Terrain } from '../terrain';

const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };
const LOG = process.env.RELIEF_LOG === '1';

function terrainFor(size: number, seed: number, spec: MapSpec): Terrain {
  return new Terrain(size, { seed, spec, ...opts });
}

describe('tall relief', () => {
  it('every non-flat relief produces real heights, flat stays flat', () => {
    const want: Record<string, [number, number]> = { flat: [0, 0], hills: [2.5, 8], ridge: [5, 8], plateau: [4, 8], peak: [6, 8] };
    for (const relief of RELIEFS) {
      for (const size of [56, 80]) {
        for (let seed = 1; seed <= 6; seed++) {
          const t = terrainFor(size, seed, { ...DEFAULT_MAP, relief, river: 'none' });
          const [lo, hi] = want[relief];
          if (LOG) console.log(relief, size, seed, 'maxH', t.maxH.toFixed(2));
          expect(t.maxH, `${relief} ${size} seed ${seed}`).toBeGreaterThanOrEqual(lo);
          expect(t.maxH).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('slopes stay climbable and the map stays connected for every relief and layout', () => {
    for (const relief of RELIEFS) {
      for (const layout of LAYOUTS) {
        for (const size of [56, 80]) {
          for (let seed = 1; seed <= 4; seed++) {
            const t = terrainFor(size, seed, { ...DEFAULT_MAP, relief, layout });
            let walkable = 0;
            let main = 0;
            for (let i = 0; i < t.region.length; i++) {
              if (t.region[i] >= 0) walkable++;
              if (t.region[i] === t.mainRegion) main++;
            }
            const frac = main / Math.max(1, walkable);
            if (LOG) console.log(relief, layout, size, seed, 'maxH', t.maxH.toFixed(1), 'main', frac.toFixed(3));
            expect(frac, `${relief}/${layout} ${size} seed ${seed}`).toBeGreaterThan(0.8);
            // The two army corners can reach each other.
            const a = t.nearestWalkable(size * 0.2, size * 0.8, 12, true);
            const b = t.nearestWalkable(size * 0.8, size * 0.2, 12, true);
            expect(a && b, `${relief}/${layout} ${size} seed ${seed}: corners`).toBeTruthy();
            expect(t.findPath(a!.x, a!.y, b!.x, b!.y), `${relief}/${layout} ${size} seed ${seed}: path`).not.toBeNull();
          }
        }
      }
    }
  });

  it('cover: a ridge blocks direct fire, flat ground and low ground do not', () => {
    const t = terrainFor(56, 3, { ...DEFAULT_MAP, relief: 'ridge', river: 'none', layout: 'classic' });
    expect(t.maxH).toBeGreaterThan(4);
    // Find a tall tile and shoot across it from low ground on both sides.
    let tx = -1;
    let ty = -1;
    for (let y = 0; y < 56 && tx < 0; y++) for (let x = 0; x < 56; x++) if (t.heightAt(x + 0.5, y + 0.5) >= t.maxH - 0.3) { tx = x; ty = y; break; }
    expect(tx).toBeGreaterThanOrEqual(0);
    const flat = terrainFor(56, 3, { ...DEFAULT_MAP, relief: 'flat', river: 'none' });
    expect(flat.blocksFire(2, 2, 40, 40)).toBe(false);
    // Along a line through the tall tile with both ends on low ground the shot is blocked.
    let blocked = false;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const x0 = tx + 0.5 - dx * 9;
      const y0 = ty + 0.5 - dy * 9;
      const x1 = tx + 0.5 + dx * 9;
      const y1 = ty + 0.5 + dy * 9;
      if (x0 < 0 || y0 < 0 || x1 > 55 || y1 > 55 || x1 < 0 || y1 < 0) continue;
      if (t.heightAt(x0, y0) + 1.5 < t.maxH && t.heightAt(x1, y1) + 1.5 < t.maxH && t.blocksFire(x0, y0, x1, y1)) blocked = true;
    }
    expect(blocked).toBe(true);
  });
});
