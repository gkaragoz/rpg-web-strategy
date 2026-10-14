import type { DecorKind } from '../sim/terrain';

/**
 * Pure helpers for the 2D isometric depth order (no PixiJS, runs in Node tests).
 *
 * Painter's order is the iso sum x+y (bigger = nearer to the camera). Three things need more than that:
 *  - Relief: elevated ground tiles are drawn in "bands" (tiles grouped by origin sum) inside the sorted entity layer, so a unit
 *    behind a ridge is covered by it and a unit in front draws over it. Flat ground stays in the static layer below everything.
 *  - Big decor: houses, towers and the keep have a footprint; a unit beside it is in front of it although its x+y is smaller than
 *    the footprint's front corner. `DepthBoxIndex` lifts such units above the decor.
 *  - Overlays that are not depth sorted (health bars, arrows, shadows of mass units): `computeCover` tells how many pixels of
 *    terrain in front hide a ground point, so those can be hidden for units behind a mountain.
 */

/**
 * Origin sums grouped per depth band: 1 = exact order; larger = fewer bands and fewer particle slabs (each slab is one draw call
 * with a fixed cost), coarser order near cliffs. Crowds are drawn small, so the order gets coarser with the number of units.
 */
export function bandWidthFor(units: number): number {
  return units <= 3000 ? 1 : units <= 8000 ? 2 : units <= 16000 ? 3 : 4;
}

/** Terrain tile with any corner above the base level is part of a depth band. */
export interface ReliefBands {
  /** Band keys (origin sum of the first tile row), ascending. */
  keys: number[];
  /** Tile indexes (ty * size + tx) per band key. */
  tiles: Map<number, number[]>;
}

/** Groups the tiles that have relief (some corner above 0) by origin sum tx+ty, in `width`-wide bands. */
export function reliefBands(size: number, vertexH: (vx: number, vy: number) => number, width = 1): ReliefBands {
  const tiles = new Map<number, number[]>();
  for (let sum = 0; sum <= 2 * size - 2; sum++) {
    const key = sum - (sum % width);
    for (let tx = Math.max(0, sum - size + 1); tx <= Math.min(size - 1, sum); tx++) {
      const ty = sum - tx;
      if (vertexH(tx, ty) <= 0 && vertexH(tx + 1, ty) <= 0 && vertexH(tx, ty + 1) <= 0 && vertexH(tx + 1, ty + 1) <= 0) continue;
      let list = tiles.get(key);
      if (!list) tiles.set(key, (list = []));
      list.push(ty * size + tx);
    }
  }
  return { keys: [...tiles.keys()].sort((a, b) => a - b), tiles };
}

/** zIndex of band `key`: just below a unit standing exactly on the band's first sum, so units with x+y >= key draw over it. */
export function bandZ(key: number): number {
  return key - 0.0005;
}

/**
 * Slab index of each integer iso sum, for a renderer that splits its units between the bands: slab j holds the units whose
 * floor(x+y) lies in [cuts[j-1], cuts[j]) (slab 0: below the first band). Returns a table indexed by the integer sum.
 */
export function slabTable(cuts: readonly number[], maxSum: number): Uint16Array {
  const t = new Uint16Array(maxSum + 2);
  let j = 0;
  for (let s = 0; s < t.length; s++) {
    while (j < cuts.length && cuts[j] <= s) j++;
    t[s] = j;
  }
  return t;
}

/** zIndex of slab j (j >= 1 sits right after band cuts[j-1]; slab 0 is first). */
export function slabZ(cuts: readonly number[], j: number): number {
  return j === 0 ? -1 : cuts[j - 1];
}

// ---- decor footprints ----

export interface DepthBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const HOUSE_SIZES: ReadonlyArray<readonly [number, number]> = [
  [2, 2],
  [3, 2],
  [2, 3],
];

/** Footprint (tile coordinates) of a big decor item, or null for items that are fine with a point sort key. */
export function decorBox(d: { kind: DecorKind; variant: number; x: number; y: number }): DepthBox | null {
  switch (d.kind) {
    case 'house': {
      const [w, h] = HOUSE_SIZES[Math.min(2, d.variant >> 1)];
      return { x0: d.x - w, y0: d.y - h, x1: d.x, y1: d.y };
    }
    case 'tower':
      return { x0: d.x - 1, y0: d.y - 1, x1: d.x, y1: d.y };
    case 'keep':
      return { x0: d.x - 4, y0: d.y - 4, x1: d.x, y1: d.y };
    default:
      return null;
  }
}

/** How far (tiles) a sprite reaches sideways past its footprint. */
const MARGIN = 0.6;

/**
 * Spatial index of the big decor footprints. A unit standing beside a box (past its x1 side or its y1 side) is in front of it,
 * even though its x+y can be smaller than the box's front corner (x1+y1, which is the decor's own sort key).
 */
export class DepthBoxIndex {
  private readonly cells: Array<DepthBox[] | undefined>;
  readonly count: number;

  constructor(
    private readonly size: number,
    decor: ReadonlyArray<{ kind: DecorKind; variant: number; x: number; y: number }>,
  ) {
    let n = 0;
    this.cells = new Array<DepthBox[] | undefined>(size * size);
    for (const d of decor) {
      const b = decorBox(d);
      if (!b) continue;
      n++;
      // Units that can be lifted lie in the strips beside the box: up to (box depth) tiles past the far edges.
      const ex = b.x1 + (b.y1 - b.y0) + MARGIN;
      const ey = b.y1 + (b.x1 - b.x0) + MARGIN;
      const cx0 = Math.max(0, Math.floor(b.x0 - MARGIN));
      const cy0 = Math.max(0, Math.floor(b.y0 - MARGIN));
      const cx1 = Math.min(size - 1, Math.floor(ex));
      const cy1 = Math.min(size - 1, Math.floor(ey));
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cy * size + cx;
          const list = this.cells[k];
          if (list) list.push(b);
          else this.cells[k] = [b];
        }
      }
    }
    this.count = n;
  }

  /** Depth key of a point (ux, uy): `key` (normally ux+uy), raised above the front corner of any box it stands in front of. */
  frontKey(ux: number, uy: number, key: number, eps: number): number {
    if (this.count === 0) return key;
    const cx = Math.floor(ux);
    const cy = Math.floor(uy);
    if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return key;
    const list = this.cells[cy * this.size + cx];
    if (!list) return key;
    for (const b of list) {
      if ((ux >= b.x1 && uy > b.y0 - MARGIN) || (uy >= b.y1 && ux > b.x0 - MARGIN)) {
        const k = b.x1 + b.y1 + eps;
        if (k > key) key = k;
      }
    }
    return key;
  }
}

// ---- cover (how much terrain in front hides a ground point) ----

/** Moving t tiles along the screen-vertical diagonal (x+t, y+t) shifts the screen position by 32 t px (x+y grows by 2t, 16 px each). */
const PX_PER_T = 32;

/**
 * For each tile centre: the height (px) of the terrain in front (same screen column, nearer to the camera) above the point's own
 * screen position. A unit standing there is hidden up to that height. 0 on flat maps. `elevPx` is the ground height in px.
 */
export function computeCover(size: number, elevPx: (x: number, y: number) => number, maxElevPx: number): Float32Array {
  const cover = new Float32Array(size * size);
  if (maxElevPx <= 0) return cover;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      const base = elevPx(cx, cy);
      let best = 0;
      for (let t = 0.5; t * PX_PER_T < maxElevPx - base + PX_PER_T; t += 0.5) {
        const px = cx + t;
        const py = cy + t;
        if (px >= size || py >= size) break;
        const v = elevPx(px, py) - PX_PER_T * t - base;
        if (v > best) best = v;
      }
      cover[ty * size + tx] = best;
    }
  }
  return cover;
}

/** Terrain in front hiding more than this many pixels of a unit's body (at scale 1) also hides its health bar and chevrons. */
export const HIDDEN_BODY_PX = 45;

/** Cover at a world point (nearest tile). */
export function coverAt(cover: Float32Array, size: number, x: number, y: number): number {
  const tx = x < 0 ? 0 : x >= size ? size - 1 : x | 0;
  const ty = y < 0 ? 0 : y >= size ? size - 1 : y | 0;
  return cover[ty * size + tx];
}
