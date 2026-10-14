import { describe, expect, it } from 'vitest';
import { bandPlanFor, bandZ, computeCover, computeLift, coverAt, decorBox, DepthBoxIndex, FLAT_LEVELS, OVERLAY_LEVELS, overlayTiles, planBandStarts, RAISE_COVER_PX, reliefBands, slabTable, slabZ } from '../../render/depthSort';
import { LEVEL_PX } from '../terrain';

describe('relief depth bands', () => {
  // 6x6 map; a single raised vertex at (3,3) makes the four tiles around it relief tiles.
  const size = 6;
  const vh = (vx: number, vy: number): number => (vx === 3 && vy === 3 ? 2 : 0);

  it('keeps flat tiles out and groups the relief tiles by origin sum', () => {
    const b = reliefBands(size, vh);
    // Tiles (2,2) (3,2) (2,3) (3,3) touch vertex (3,3): origin sums 4, 5, 5, 6.
    expect(b.keys).toEqual([4, 5, 6]);
    expect(b.tiles.get(4)).toEqual([2 * size + 2]);
    expect([...b.tiles.get(5)!].sort((a, c) => a - c)).toEqual([2 * size + 3, 3 * size + 2]);
    expect(b.tiles.get(6)).toEqual([3 * size + 3]);
  });

  it('wider bands merge neighbouring sums into one key', () => {
    const b = reliefBands(size, vh, 2);
    expect(b.keys).toEqual([4, 6]);
    expect(b.tiles.get(4)).toHaveLength(3);
    expect(b.tiles.get(6)).toHaveLength(1);
  });

  it('a flat map has no bands', () => {
    expect(reliefBands(8, () => 0).keys).toEqual([]);
  });

  it('bandZ sits just below a unit standing on the first sum of the band', () => {
    expect(bandZ(7)).toBeLessThan(7);
    expect(bandZ(7)).toBeGreaterThan(6.99);
  });

  it('crowds tolerate more hiding error before a band is split', () => {
    expect(bandPlanFor(100).tolPx).toBe(RAISE_COVER_PX);
    expect(bandPlanFor(5000).tolPx).toBeGreaterThan(bandPlanFor(100).tolPx);
    expect(bandPlanFor(12000).tolPx).toBeGreaterThan(bandPlanFor(5000).tolPx);
    expect(bandPlanFor(30000).tolPx).toBeGreaterThan(bandPlanFor(12000).tolPx);
    expect(bandPlanFor(100).maxWidth).toBeGreaterThan(1);
  });

  it('reliefBands accepts a start table', () => {
    const starts = Int32Array.from([0, 0, 0, 0, 4, 4, 4, 7, 7, 7, 7]);
    const b = reliefBands(size, vh, starts);
    expect(b.keys).toEqual([4]);
    expect(b.tiles.get(4)).toHaveLength(4);
  });
});

describe('adaptive band starts', () => {
  const PLAN = { tolPx: RAISE_COVER_PX, maxWidth: 12 };

  /** Brute-force statement of the invariant: a point hidden by more than tolPx by a tile that is at least two sums in front. */
  function violations(size: number, elev: (x: number, y: number) => number, maxElev: number, starts: Int32Array, tol: number): number {
    let bad = 0;
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        for (const [dx, dy] of [[0.5, 0.5], [0.15, 0.85], [0.85, 0.15], [0.15, 0.15], [0.85, 0.85]]) {
          const cx = tx + dx;
          const cy = ty + dy;
          const base = elev(Math.min(size - 0.001, Math.max(0, cx)), Math.min(size - 0.001, Math.max(0, cy)));
          for (let t = 0.25; t * 32 < maxElev - base + 32; t += 0.25) {
            const px = cx + t;
            const py = cy + t;
            if (px >= size || py >= size) break;
            const q = Math.floor(px) + Math.floor(py);
            if (elev(px, py) - 32 * t - base > tol && q >= tx + ty + 2 && starts[q] < tx + ty + 2) bad++;
          }
        }
      }
    }
    return bad;
  }

  it('smooth ground shares one band up to maxWidth, a cliff splits it', () => {
    const size = 24;
    const smooth = (x: number, y: number): number => (x + y) * 3;
    const s1 = planBandStarts(size, smooth, 3 * 2 * size, PLAN);
    expect(s1[0]).toBe(0);
    expect(s1[11]).toBe(0);
    expect(s1[12]).toBe(12);
    expect(new Set(s1).size).toBe(Math.ceil((2 * size - 1) / PLAN.maxWidth));
    // A 3-level wall rising toward the camera across the whole map at x+y = 20.
    const wall = (x: number, y: number): number => (x + y >= 20 ? 3 * 26 : 0);
    const s2 = planBandStarts(size, wall, 3 * 26, PLAN);
    expect(violations(size, wall, 3 * 26, s2, PLAN.tolPx)).toBe(0);
    expect(new Set(s2).size).toBeGreaterThan(Math.ceil((2 * size - 1) / PLAN.maxWidth));
  });

  it('keeps the hiding invariant on a rough height field and always at least as coarse as width 1', () => {
    const size = 40;
    const elev = (x: number, y: number): number => 26 * (2 + Math.sin(x * 0.7) * Math.cos(y * 0.5) * 1.6 + Math.sin((x + y) * 0.23) * 1.2);
    for (const tol of [RAISE_COVER_PX, 20, 30]) {
      const starts = planBandStarts(size, elev, 26 * 5, { tolPx: tol, maxWidth: 12 });
      expect(violations(size, elev, 26 * 5, starts, tol)).toBe(0);
      expect(new Set(starts).size).toBeLessThan(2 * size - 1);
      for (let i = 1; i < starts.length; i++) expect(starts[i] === starts[i - 1] || starts[i] === i).toBe(true);
    }
  });

  it('flat or gentle ground needs no split at all', () => {
    expect(new Set(planBandStarts(30, () => 0, 0, PLAN)).size).toBe(Math.ceil(59 / 12));
  });
});

describe('slabs between the bands', () => {
  const cuts = [4, 5, 9];
  const table = slabTable(cuts, 12);

  it('maps every integer sum to the count of cuts at or below it', () => {
    expect([...table].slice(0, 12)).toEqual([0, 0, 0, 0, 1, 2, 2, 2, 2, 3, 3, 3]);
  });

  it('slab z follows the band it sits after', () => {
    expect(slabZ(cuts, 0)).toBe(-1);
    expect(slabZ(cuts, 1)).toBe(4);
    expect(slabZ(cuts, 3)).toBe(9);
    // A unit at the first sum of slab j is drawn after band cuts[j-1] and before band cuts[j-1] + 1.
    expect(slabZ(cuts, 2)).toBeGreaterThan(bandZ(cuts[1]));
    expect(slabZ(cuts, 2)).toBeLessThan(bandZ(cuts[1] + 1));
  });
});

describe('cover of terrain in front', () => {
  const size = 20;
  // A wall rising 3 levels at tiles with x+y >= 20 (distance along the diagonal), flat elsewhere.
  const wall = (x: number, y: number): number => (x + y >= 20 ? 3 * LEVEL_PX : 0);

  it('hides ground behind a high wall and nothing in front of or on it', () => {
    const c = computeCover(size, wall, 3 * LEVEL_PX);
    // Tile (9,9) centre x+y = 19: right behind the wall. Its column reaches the wall (t = 1 -> (10.5,10.5)).
    expect(coverAt(c, size, 9.5, 9.5)).toBeGreaterThan(40);
    // Further back the wall's top (78 px) is hidden by 32 px per tile of distance: no cover beyond ~2.4 tiles.
    expect(coverAt(c, size, 5.5, 5.5)).toBe(0);
    // On the wall and in front of it: nothing hides them.
    expect(coverAt(c, size, 14.5, 14.5)).toBe(0);
    expect(coverAt(c, size, 18.5, 2.5)).toBe(0);
  });

  it('is all zero on flat ground and when sampled outside the map', () => {
    const flat = computeCover(size, () => 0, 0);
    expect(flat.every((v) => v === 0)).toBe(true);
    expect(coverAt(flat, size, -3, 99)).toBe(0);
  });
});

describe('big decor footprints', () => {
  it('knows the footprint of houses, towers and the keep, and ignores small decor', () => {
    expect(decorBox({ kind: 'house', variant: 0, x: 10, y: 10 })).toEqual({ x0: 8, y0: 8, x1: 10, y1: 10, lift: 0 });
    expect(decorBox({ kind: 'house', variant: 2, x: 10, y: 10 })).toEqual({ x0: 7, y0: 8, x1: 10, y1: 10, lift: 0 });
    expect(decorBox({ kind: 'house', variant: 5, x: 10, y: 10 })).toEqual({ x0: 8, y0: 7, x1: 10, y1: 10, lift: 0 });
    expect(decorBox({ kind: 'tower', variant: 0, x: 5, y: 6 })).toEqual({ x0: 4, y0: 5, x1: 5, y1: 6, lift: 0 });
    expect(decorBox({ kind: 'keep', variant: 0, x: 30, y: 30 })).toEqual({ x0: 26, y0: 26, x1: 30, y1: 30, lift: 0 });
    expect(decorBox({ kind: 'tree', variant: 1, x: 3, y: 3 })).toBeNull();
    expect(decorBox({ kind: 'wall', variant: 0, x: 3.5, y: 3.5 })).toBeNull();
  });

  // One 3 x 2 house: footprint x 10..13, y 20..22, front corner (13,22): its sort key is 35.
  const idx = new DepthBoxIndex(40, [{ kind: 'house', variant: 2, x: 13, y: 22 }]);

  it('lifts a unit beside the house above the decor key', () => {
    // To the right of the house (x past x1): x+y = 13.5+20.5 = 34 < 35, yet the unit is in front of the house.
    expect(idx.frontKey(13.5, 20.5, 34, 0.01)).toBeCloseTo(35.01);
    // To the left (y past y1).
    expect(idx.frontKey(11, 22.5, 33.5, 0.01)).toBeCloseTo(35.01);
  });

  it('leaves units behind the house and units far away alone', () => {
    expect(idx.frontKey(11, 19, 30, 0.01)).toBe(30); // behind (y < y0)
    expect(idx.frontKey(9, 21, 30, 0.01)).toBe(30); // behind-left (x < x0)
    expect(idx.frontKey(2, 2, 4, 0.01)).toBe(4);
    expect(idx.frontKey(-1, 50, 49, 0.01)).toBe(49); // outside the map
  });

  it('never lowers a key that is already in front', () => {
    expect(idx.frontKey(14, 23, 37, 0.01)).toBe(37);
  });

  it('an index without big decor is a no-op', () => {
    const none = new DepthBoxIndex(10, [{ kind: 'tree', variant: 0, x: 2, y: 2 }]);
    expect(none.count).toBe(0);
    expect(none.frontKey(3, 3, 6, 0.5)).toBe(6);
  });
});

describe('which tiles join a band', () => {
  const size = 6;
  it('leaves nearly flat tiles in the base layer', () => {
    expect(reliefBands(size, (vx, vy) => (vx === 3 && vy === 3 ? FLAT_LEVELS : 0)).keys).toEqual([]);
    expect(reliefBands(size, (vx, vy) => (vx === 3 && vy === 3 ? FLAT_LEVELS + 0.1 : 0)).keys.length).toBeGreaterThan(0);
  });

  it('keeps low tiles under overlay art out of the bands, but not steep ones', () => {
    const mask = new Uint8Array(size * size).fill(1);
    expect(reliefBands(size, (vx, vy) => (vx === 3 && vy === 3 ? OVERLAY_LEVELS : 0), 1, mask).keys).toEqual([]);
    expect(reliefBands(size, (vx, vy) => (vx === 3 && vy === 3 ? OVERLAY_LEVELS + 0.5 : 0), 1, mask).keys.length).toBe(3);
    expect(reliefBands(size, (vx, vy) => (vx === 3 && vy === 3 ? 1 : 0), 1, new Uint8Array(size * size)).keys.length).toBe(3);
  });

  it('overlayTiles marks the river, its bank and the bridge area', () => {
    const t = {
      size: 10,
      riverKind: 'straight',
      toS: (x: number, _y: number) => x,
      toD: (_x: number, y: number) => y,
      offsetAt: () => 5,
      widthAt: () => 2,
      landTiles: [] as number[],
      crossWaterTiles: [] as number[],
      crossBridgeTiles: [] as number[],
      bridges: [] as Array<{ s: number; o: number; halfLen: number; halfW: number }>,
    };
    const m = overlayTiles(t);
    expect(m[5 * 10 + 3]).toBe(1);
    expect(m[1 * 10 + 3]).toBe(0);
    expect(m[8 * 10 + 3]).toBe(0);
    expect(overlayTiles({ ...t, riverKind: 'none' }).some((v) => v === 1)).toBe(false);
    t.riverKind = 'none';
    t.crossBridgeTiles = [3 * 10 + 3];
    const mb = overlayTiles(t);
    expect(mb[2 * 10 + 4]).toBe(1);
    expect(mb[6 * 10 + 6]).toBe(0);
  });
});

describe('key raise on uncovered ground', () => {
  const size = 12;
  // A 3-level wall across x >= 8 (steep: more than the view ray falls), flat elsewhere.
  const elev = (x: number): number => (x >= 8 ? 3 * LEVEL_PX : 0);
  const lift = computeLift(size, (x) => elev(x), 3 * LEVEL_PX);

  it('is zero on a flat map', () => {
    expect(computeLift(5, () => 0, 0).every((v) => v === 0)).toBe(true);
  });

  it('is 1 where nothing in front hides the feet, 0 right behind the wall', () => {
    expect(lift[3 * size + 2]).toBe(1);
    expect(lift[5 * size + 11]).toBe(1); // on top of the wall
    expect(lift[6 * size + 7]).toBe(0); // in the wall's shadow: a unit here is hidden
  });

  it('decor boxes remember their raise', () => {
    const idx = new DepthBoxIndex(size, [{ kind: 'house', variant: 0, x: 5, y: 5 }], () => 1);
    // A unit beside the house (x >= x1) is lifted to the house front corner (10) plus its raise.
    expect(idx.frontKey(5.5, 4, 9.5, 0.01)).toBeCloseTo(11.01);
  });
});
