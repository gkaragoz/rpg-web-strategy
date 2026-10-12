import { describe, expect, it } from 'vitest';
import { Terrain } from '../terrain';

const SIZES = [40, 56, 80, 120];
const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };

describe('arazi uretimi ve yol bulma', () => {
  it('kopru uclari her iki yakada yurunebilir ve ayni bolgede (kopru gercekten bagliyor)', () => {
    const p = { x: 0, y: 0 };
    const q = { x: 0, y: 0 };
    for (const size of SIZES) {
      for (let seed = 1; seed <= 25; seed++) {
        const t = new Terrain(size, { seed, ...opts });
        for (const b of t.bridges) {
          for (const lat of [-0.9, 0, 0.9]) {
            t.bridgeEnd(b, -1, lat, p);
            t.bridgeEnd(b, 1, lat, q);
            expect(t.walkable(p.x, p.y), `boyut ${size} tohum ${seed} kopru s=${b.s} lat=${lat} -1 ucu`).toBe(true);
            expect(t.walkable(q.x, q.y), `boyut ${size} tohum ${seed} kopru s=${b.s} lat=${lat} +1 ucu`).toBe(true);
            expect(t.regionAt(p.x, p.y), `boyut ${size} tohum ${seed} kopru ${b.s}: iki yaka ayni bolgede olmali`).toBe(t.regionAt(q.x, q.y));
          }
        }
      }
    }
  });

  it('nehrin iki yakasi arasinda A* yolu kopruden gecer ve tamamen yurunebilirdir', () => {
    for (const size of [40, 56, 80]) {
      for (let seed = 1; seed <= 15; seed++) {
        const t = new Terrain(size, { seed, ...opts });
        const a = t.nearestWalkable(size * 0.2, size * 0.8, 10, true)!;
        const b = t.nearestWalkable(size * 0.8, size * 0.2, 10, true)!;
        const path = t.findPath(a.x, a.y, b.x, b.y);
        expect(path, `boyut ${size} tohum ${seed}`).not.toBeNull();
        let px = a.x;
        let py = a.y;
        for (let i = 0; i < path!.length; i += 2) {
          // Merkez cizgisi boyunca yurunebilir (kenar payi olmadan; bitisik karo merkezleri payi asabilir).
          const len = Math.hypot(path![i] - px, path![i + 1] - py);
          for (let k = 0; k <= Math.ceil(len / 0.2); k++) {
            const f = len === 0 ? 0 : (k * 0.2) / len;
            const x = px + (path![i] - px) * Math.min(1, f);
            const y = py + (path![i + 1] - py) * Math.min(1, f);
            expect(t.walkable(x, y), `boyut ${size} tohum ${seed} parca ${i / 2} nokta ${x.toFixed(2)},${y.toFixed(2)}`).toBe(true);
          }
          px = path![i];
          py = path![i + 1];
        }
      }
    }
  });

  it('nehir ve harita merkeze gore simetrik (iki takim icin adil)', () => {
    for (const size of [40, 56, 80]) {
      const t = new Terrain(size, { seed: 7, ...opts });
      let asym = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (t.flags[y * size + x] !== t.flags[(size - 1 - y) * size + (size - 1 - x)]) asym++;
      expect(asym, `boyut ${size}`).toBe(0);
    }
  });

  it('ana bolge dis engellerle bolunmez: yurunebilir karolarin cogu ana bolgede', () => {
    for (const size of [40, 56, 80]) {
      for (let seed = 1; seed <= 20; seed++) {
        const t = new Terrain(size, { seed, ...opts });
        let walkable = 0;
        let main = 0;
        for (let i = 0; i < t.region.length; i++) {
          if (t.region[i] >= 0) walkable++;
          if (t.region[i] === t.mainRegion) main++;
        }
        expect(main / walkable, `boyut ${size} tohum ${seed}`).toBeGreaterThan(0.95);
      }
    }
  });
});
