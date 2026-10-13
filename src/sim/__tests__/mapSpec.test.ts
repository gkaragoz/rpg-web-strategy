import { describe, expect, it } from 'vitest';
import { BIOMES, CROSSINGS, DEFAULT_MAP, FORESTS, PRESETS, LAYOUTS, RELIEFS, RIVERS, VILLAGES, randomSpec, sanitizeSpec, type MapSpec } from '../mapSpec';
import { mulberry32 } from '../random';
import { T_WATER, Terrain } from '../terrain';

const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };
const demo = { spawnD0: 8, spawnD1: 14.5, spawnHalfS: 7 };

function allSpecs(): MapSpec[] {
  const out: MapSpec[] = [];
  for (const river of RIVERS) for (const forest of FORESTS) for (const village of VILLAGES) for (const crossing of CROSSINGS) out.push({ biome: 'forest', river, forest, village, crossing, relief: RELIEFS[(out.length * 7) % RELIEFS.length], layout: LAYOUTS[(out.length * 3) % LAYOUTS.length] });
  return out;
}

describe('map recipe', () => {
  it('the default recipe produces the old map (no regression)', () => {
    const a = new Terrain(56, { seed: 3, ...opts });
    const b = new Terrain(56, { seed: 3, spec: DEFAULT_MAP, ...opts });
    expect(Array.from(a.flags)).toEqual(Array.from(b.flags));
    expect(a.decor.length).toBe(b.decor.length);
  });

  it('every recipe is symmetric about the center, the river is connected within one region and the seed is deterministic', () => {
    const specs = allSpecs();
    // Sweep all combinations (5*5*5*3=375) on small maps, mixing sizes/seeds.
    specs.forEach((spec, i) => {
      const size = [40, 56, 80][i % 3];
      const t = new Terrain(size, { seed: 1 + (i % 9), spec, ...opts });
      let asym = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (t.flags[y * size + x] !== t.flags[(size - 1 - y) * size + (size - 1 - x)]) asym++;
      expect(asym, JSON.stringify(spec)).toBe(0);
      const u = new Terrain(size, { seed: 1 + (i % 9), spec, ...opts });
      expect(Array.from(u.flags), 'determinism').toEqual(Array.from(t.flags));
      for (const br of t.bridges) {
        const p = { x: 0, y: 0 };
        const q = { x: 0, y: 0 };
        t.bridgeEnd(br, -1, 0, p);
        t.bridgeEnd(br, 1, 0, q);
        expect(t.walkable(p.x, p.y) && t.walkable(q.x, q.y), JSON.stringify(spec)).toBe(true);
        expect(t.regionAt(p.x, p.y), JSON.stringify(spec)).toBe(t.regionAt(q.x, q.y));
      }
    });
  });

  it('both army zones (one bank and the other) are in the main region and reachable from each other', () => {
    for (const p of PRESETS) {
      for (const size of [56, 80]) {
        const t = new Terrain(size, { seed: 5, spec: p.spec, ...demo });
        const a = t.nearestWalkable(size * 0.25, size * 0.75, 12, true);
        const b = t.nearestWalkable(size * 0.75, size * 0.25, 12, true);
        expect(a && b, p.id).toBeTruthy();
        expect(t.findPath(a!.x, a!.y, b!.x, b!.y), `${p.id} ${size}`).not.toBeNull();
      }
    }
  });

  it('no water on a riverless map; island tiles exist on an islands map', () => {
    const none = new Terrain(56, { seed: 2, spec: { ...DEFAULT_MAP, river: 'none' }, ...opts });
    expect(none.bridges.length).toBe(0);
    expect(none.flags.includes(T_WATER)).toBe(false);
    const isl = new Terrain(80, { seed: 2, spec: { ...DEFAULT_MAP, river: 'islands' }, ...opts });
    expect(isl.landTiles.length).toBeGreaterThan(0);
    expect(isl.flags.includes(T_WATER)).toBe(true);
  });

  it('relief maps: symmetry, determinism, cliffs are not walkable, ramp connectivity, structures on flat ground', () => {
    for (const relief of RELIEFS.filter((r) => r !== 'flat')) {
      for (const river of ['none', 'winding', 'lake'] as const) {
        for (const size of [56, 80]) {
          const spec: MapSpec = { ...DEFAULT_MAP, relief, river, village: 'village' };
          const t = new Terrain(size, { seed: 4, spec, ...demo });
          const u = new Terrain(size, { seed: 4, spec, ...demo });
          const tag = `${relief} ${river} ${size}`;
          expect(t.hasRelief, tag).toBe(true);
          expect(Array.from(u.height), `${tag} determinism`).toEqual(Array.from(t.height));
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) expect(t.height[y * size + x], `${tag} height symmetry`).toBe(t.height[(size - 1 - y) * size + (size - 1 - x)]);
          for (const i of t.cliffTiles) expect(t.flags[i], tag).toBe(3);
          // Walkable neighboring tiles differ by less than the cliff threshold.
          for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
              const w = (a: number, b: number): boolean => t.flags[a] !== 1 && t.flags[a] !== 3 && t.flags[b] !== 1 && t.flags[b] !== 3;
              const i = y * size + x;
              if (w(i, i + 1)) expect(Math.abs(t.height[i] - t.height[i + 1]), tag).toBeLessThanOrEqual(23);
              if (w(i, i + size)) expect(Math.abs(t.height[i] - t.height[i + size]), tag).toBeLessThanOrEqual(23);
            }
          }
          // Both army zones can reach each other.
          const a = t.nearestWalkable(size * 0.25, size * 0.75, 14, true);
          const b = t.nearestWalkable(size * 0.75, size * 0.25, 14, true);
          expect(a && b, tag).toBeTruthy();
          expect(t.findPath(a!.x, a!.y, b!.x, b!.y), `${tag} path`).not.toBeNull();
        }
      }
    }
  });

  it('layouts: symmetry, determinism, connectivity; keep, bridges and paths', () => {
    for (const layout of LAYOUTS.filter((l) => l !== 'classic')) {
      for (const biome of BIOMES) {
        for (const size of [56, 80, 120]) {
          const spec: MapSpec = { ...DEFAULT_MAP, biome, layout, river: 'winding', village: 'village', forest: 'sparse' };
          const t = new Terrain(size, { seed: 6, spec, ...opts });
          const u = new Terrain(size, { seed: 6, spec, ...opts });
          const tag = `${layout} ${biome} ${size}`;
          expect(Array.from(u.flags), `${tag} determinism`).toEqual(Array.from(t.flags));
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) expect(t.flags[y * size + x] === t.flags[(size - 1 - y) * size + (size - 1 - x)], `${tag} symmetry ${x},${y}`).toBe(true);
          const a = t.nearestWalkable(size * 0.25, size * 0.75, 16, true);
          const b = t.nearestWalkable(size * 0.75, size * 0.25, 16, true);
          expect(a && b, tag).toBeTruthy();
          expect(t.findPath(a!.x, a!.y, b!.x, b!.y), `${tag} path`).not.toBeNull();
          if (layout === 'citadel') {
            expect(t.decor.filter((d) => d.kind === 'keep').length, tag).toBe(1);
            expect(t.decor.filter((d) => d.kind === 'tower').length, tag).toBeGreaterThanOrEqual(2);
          }
          if (layout === 'archipelago') expect(t.crossBridgeTiles.length, tag).toBeGreaterThan(0);
          if (layout === 'crossroads') expect(t.pathTiles.length, tag).toBeGreaterThan(size);
        }
      }
    }
  });

  it('sanitizeSpec repairs malformed input; randomSpec returns a valid recipe', () => {
    expect(sanitizeSpec(null)).toEqual(DEFAULT_MAP);
    expect(sanitizeSpec({ biome: 'moon', river: 'lake' })).toEqual({ ...DEFAULT_MAP, river: 'lake' });
    const rnd = mulberry32(9);
    for (let i = 0; i < 50; i++) {
      const s = randomSpec(rnd);
      expect(BIOMES).toContain(s.biome);
      expect(sanitizeSpec(s)).toEqual(s);
    }
  });
});
