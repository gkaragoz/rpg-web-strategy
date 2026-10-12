import { describe, expect, it } from 'vitest';
import { BIOMES, CROSSINGS, DEFAULT_MAP, FORESTS, PRESETS, RELIEFS, RIVERS, VILLAGES, randomSpec, sanitizeSpec, type MapSpec } from '../mapSpec';
import { mulberry32 } from '../random';
import { T_WATER, Terrain } from '../terrain';

const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };
const demo = { spawnD0: 8, spawnD1: 14.5, spawnHalfS: 7 };

function allSpecs(): MapSpec[] {
  const out: MapSpec[] = [];
  for (const river of RIVERS) for (const forest of FORESTS) for (const village of VILLAGES) for (const crossing of CROSSINGS) out.push({ biome: 'forest', river, forest, village, crossing, relief: RELIEFS[(out.length * 7) % RELIEFS.length] });
  return out;
}

describe('harita tarifi', () => {
  it('varsayilan tarif eski haritayi uretir (bozulmaz)', () => {
    const a = new Terrain(56, { seed: 3, ...opts });
    const b = new Terrain(56, { seed: 3, spec: DEFAULT_MAP, ...opts });
    expect(Array.from(a.flags)).toEqual(Array.from(b.flags));
    expect(a.decor.length).toBe(b.decor.length);
  });

  it('her tarif merkeze gore simetrik, nehir ayni bolgede bagli ve tohum determinist', () => {
    const specs = allSpecs();
    // Tum kombinasyonlari (5*5*5*3=375) kucuk haritada, boyut/tohum karisik tara.
    specs.forEach((spec, i) => {
      const size = [40, 56, 80][i % 3];
      const t = new Terrain(size, { seed: 1 + (i % 9), spec, ...opts });
      let asym = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (t.flags[y * size + x] !== t.flags[(size - 1 - y) * size + (size - 1 - x)]) asym++;
      expect(asym, JSON.stringify(spec)).toBe(0);
      const u = new Terrain(size, { seed: 1 + (i % 9), spec, ...opts });
      expect(Array.from(u.flags), 'determinizm').toEqual(Array.from(t.flags));
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

  it('iki ordu bolgesi (bir yaka ve oteki) ana bolgede ve birbirine ulasilabilir', () => {
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

  it('nehirsiz haritada su yok; adali haritada ada karolari var', () => {
    const none = new Terrain(56, { seed: 2, spec: { ...DEFAULT_MAP, river: 'none' }, ...opts });
    expect(none.bridges.length).toBe(0);
    expect(none.flags.includes(T_WATER)).toBe(false);
    const isl = new Terrain(80, { seed: 2, spec: { ...DEFAULT_MAP, river: 'islands' }, ...opts });
    expect(isl.landTiles.length).toBeGreaterThan(0);
    expect(isl.flags.includes(T_WATER)).toBe(true);
  });

  it('kabartmali haritalar: simetri, determinizm, ucurum yurunemez, rampa baglantisi, duz zeminde yapi', () => {
    for (const relief of RELIEFS.filter((r) => r !== 'flat')) {
      for (const river of ['none', 'winding', 'lake'] as const) {
        for (const size of [56, 80]) {
          const spec: MapSpec = { ...DEFAULT_MAP, relief, river, village: 'village' };
          const t = new Terrain(size, { seed: 4, spec, ...demo });
          const u = new Terrain(size, { seed: 4, spec, ...demo });
          const tag = `${relief} ${river} ${size}`;
          expect(t.hasRelief, tag).toBe(true);
          expect(Array.from(u.height), `${tag} determinizm`).toEqual(Array.from(t.height));
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) expect(t.height[y * size + x], `${tag} yukselti simetrisi`).toBe(t.height[(size - 1 - y) * size + (size - 1 - x)]);
          for (const i of t.cliffTiles) expect(t.flags[i], tag).toBe(3);
          // Yurunebilir komsu karolar arasinda ucurum esiginin altinda fark.
          for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
              const w = (a: number, b: number): boolean => t.flags[a] !== 1 && t.flags[a] !== 3 && t.flags[b] !== 1 && t.flags[b] !== 3;
              const i = y * size + x;
              if (w(i, i + 1)) expect(Math.abs(t.height[i] - t.height[i + 1]), tag).toBeLessThanOrEqual(23);
              if (w(i, i + size)) expect(Math.abs(t.height[i] - t.height[i + size]), tag).toBeLessThanOrEqual(23);
            }
          }
          // Iki ordu bolgesi birbirine ulasabilir.
          const a = t.nearestWalkable(size * 0.25, size * 0.75, 14, true);
          const b = t.nearestWalkable(size * 0.75, size * 0.25, 14, true);
          expect(a && b, tag).toBeTruthy();
          expect(t.findPath(a!.x, a!.y, b!.x, b!.y), `${tag} yol`).not.toBeNull();
        }
      }
    }
  });

  it('sanitizeSpec bozuk girdiyi duzeltir; randomSpec gecerli tarif verir', () => {
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
