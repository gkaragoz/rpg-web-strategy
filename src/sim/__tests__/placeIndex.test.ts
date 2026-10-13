import { describe, expect, it } from 'vitest';
import { PlaceIndex } from '../../net/placeIndex';

const mk = (id: number, team: number, x: number, y: number, kind = 0) => ({ id, cid: id, team, kind, x, y });

describe('PlaceIndex', () => {
  it('tracks spent gold and counts per team, and refuses nothing by itself', () => {
    const ix = new PlaceIndex(1, (k) => 10 + k);
    ix.add(mk(1, 0, 5, 5, 0));
    ix.add(mk(2, 0, 7, 5, 2));
    ix.add(mk(3, 1, 5, 5, 1));
    expect(ix.spent(0)).toBe(10 + 12);
    expect(ix.count(0)).toBe(2);
    expect(ix.spent(1)).toBe(11);
    expect(ix.remove([1, 3, 99], 0)).toEqual([1]); // 3 belongs to team 1, 99 does not exist
    expect(ix.spent(0)).toBe(12);
    expect(ix.count(1)).toBe(1);
  });

  it('near() only sees the same team and respects the gap', () => {
    const ix = new PlaceIndex(1, () => 1);
    ix.add(mk(1, 0, 5.0, 5.0));
    expect(ix.near(0, 5.5, 5.0)).toBe(true);
    expect(ix.near(0, 6.2, 5.0)).toBe(false);
    expect(ix.near(1, 5.1, 5.0)).toBe(false);
    ix.remove([1], 0);
    expect(ix.near(0, 5.1, 5.0)).toBe(false);
  });

  it('matches a brute-force scan and stays fast with 30000 units', () => {
    const ix = new PlaceIndex(1, () => 1);
    const placed: ReturnType<typeof mk>[] = [];
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const t0 = performance.now();
    let id = 1;
    for (let i = 0; i < 60000; i++) {
      const x = rnd() * 400;
      const y = rnd() * 400;
      const near = ix.near(0, x, y);
      if (i % 500 === 0) expect(near).toBe(placed.some((u) => (u.x - x) ** 2 + (u.y - y) ** 2 < 1));
      if (!near && placed.length < 30000) {
        const u = mk(id++, 0, x, y);
        placed.push(u);
        ix.add(u);
      }
    }
    expect(placed.length).toBeGreaterThan(20000);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
