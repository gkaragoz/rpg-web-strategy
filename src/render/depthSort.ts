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

/** Tiles whose highest corner is at most this many levels are drawn flat in the base layer (a 9 px bump hides nothing worth sorting). */
export const FLAT_LEVELS = 0.35;
/** Low tiles that carry river, bridge or island art stay in the base layer too, so the static overlay is drawn over them. */
export const OVERLAY_LEVELS = 1.6;

/** The terrain data `overlayTiles` needs (a structural subset of `Terrain`). */
export interface OverlaySource {
  size: number;
  riverKind: string;
  toS(x: number, y: number): number;
  toD(x: number, y: number): number;
  offsetAt(s: number): number;
  widthAt(s: number): number;
  landTiles: readonly number[];
  crossWaterTiles: readonly number[];
  crossBridgeTiles: readonly number[];
  bridges: ReadonlyArray<{ s: number; o: number; halfLen: number; halfW: number }>;
}

/** Tiles (index ty * size + tx) that carry static overlay art (river with banks, islands, channels, bridges, fords). */
export function overlayTiles(t: OverlaySource): Uint8Array {
  const n = t.size;
  const mask = new Uint8Array(n * n);
  const mark = (idx: number, grow: number): void => {
    const cx = idx % n;
    const cy = (idx / n) | 0;
    for (let y = Math.max(0, cy - grow); y <= Math.min(n - 1, cy + grow); y++) for (let x = Math.max(0, cx - grow); x <= Math.min(n - 1, cx + grow); x++) mask[y * n + x] = 1;
  };
  if (t.riverKind !== 'none') {
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        // Sample the corners and the centre of the tile against the river band plus its bank.
        for (let k = 0; k < 5; k++) {
          const x = tx + (k === 4 ? 0.5 : k & 1);
          const y = ty + (k === 4 ? 0.5 : k >> 1);
          const s = t.toS(x, y);
          if (Math.abs(t.toD(x, y) - t.offsetAt(s)) <= t.widthAt(s) / 2 + 1.4) {
            mask[ty * n + tx] = 1;
            break;
          }
        }
      }
    }
  }
  for (const i of t.landTiles) mark(i, 1);
  for (const i of t.crossWaterTiles) mark(i, 1);
  for (const i of t.crossBridgeTiles) mark(i, 1);
  if (t.bridges.length > 0) {
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const s = t.toS(tx + 0.5, ty + 0.5);
        const d = t.toD(tx + 0.5, ty + 0.5);
        for (const b of t.bridges) {
          if (Math.abs(s - b.s) < b.halfW + 1.2 && Math.abs(d - b.o) < b.halfLen + 1.2) {
            mask[ty * n + tx] = 1;
            break;
          }
        }
      }
    }
  }
  return mask;
}

/**
 * Groups the tiles that have relief by origin sum tx+ty, in `width`-wide bands. Nearly flat tiles (and, with `overlay`, low tiles
 * under river/bridge art) are left out: they stay in the base layer.
 */
export function reliefBands(size: number, vertexH: (vx: number, vy: number) => number, width = 1, overlay?: Uint8Array | null): ReliefBands {
  const tiles = new Map<number, number[]>();
  for (let sum = 0; sum <= 2 * size - 2; sum++) {
    const key = sum - (sum % width);
    for (let tx = Math.max(0, sum - size + 1); tx <= Math.min(size - 1, sum); tx++) {
      const ty = sum - tx;
      const mh = Math.max(vertexH(tx, ty), vertexH(tx + 1, ty), vertexH(tx, ty + 1), vertexH(tx + 1, ty + 1));
      if (mh <= FLAT_LEVELS) continue;
      if (overlay && overlay[ty * size + tx] === 1 && mh <= OVERLAY_LEVELS) continue;
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
  /** Sort-key raise of the decor's own tile (see `computeLift`); units lifted above the decor use it too. */
  lift: number;
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
      return { x0: d.x - w, y0: d.y - h, x1: d.x, y1: d.y, lift: 0 };
    }
    case 'tower':
      return { x0: d.x - 1, y0: d.y - 1, x1: d.x, y1: d.y, lift: 0 };
    case 'keep':
      return { x0: d.x - 4, y0: d.y - 4, x1: d.x, y1: d.y, lift: 0 };
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
    liftAt?: (x: number, y: number) => number,
  ) {
    let n = 0;
    this.cells = new Array<DepthBox[] | undefined>(size * size);
    for (const d of decor) {
      const b = decorBox(d);
      if (!b) continue;
      if (liftAt) b.lift = liftAt(d.x, d.y);
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
        const k = b.x1 + b.y1 + b.lift + eps;
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

/** How much the sort key of everything standing on an uncovered tile is raised above its x+y (see `computeLift`). */
export const GROUND_RAISE = 1;
/** A tile whose cover (px, widened sideways) is below this counts as uncovered. */
export const RAISE_COVER_PX = 6;
/** Sideways reach (tiles, along x-y) of the widened cover test: a sprite is about this wide. */
const SIDE = 0.4;

/**
 * Per tile: 1 where nothing in front hides even the feet of a unit (also not beside it), else 0. Those entities get their sort key
 * raised by GROUND_RAISE, so the ground tiles just in front of them (whose back tip would otherwise clip the selection ring, the
 * shadow and the shoes) are drawn below them. All uncovered entities are raised alike, so their order among each other is unchanged;
 * entities that terrain really hides keep the exact order. All zero on flat maps.
 */
export function computeLift(size: number, elevPx: (x: number, y: number) => number, maxElevPx: number): Uint8Array {
  const lift = new Uint8Array(size * size);
  if (maxElevPx <= 0) return lift;
  const at = (cx: number, cy: number): number => {
    const base = elevPx(Math.min(size - 0.001, Math.max(0, cx)), Math.min(size - 0.001, Math.max(0, cy)));
    let best = 0;
    for (let t = 0.5; t * PX_PER_T < maxElevPx - base + PX_PER_T; t += 0.5) {
      const px = cx + t;
      const py = cy + t;
      if (px >= size || py >= size) break;
      const v = elevPx(px, py) - PX_PER_T * t - base;
      if (v > best) best = v;
    }
    return best;
  };
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      const worst = Math.max(at(cx, cy), at(cx + SIDE, cy - SIDE), at(cx - SIDE, cy + SIDE));
      lift[ty * size + tx] = worst < RAISE_COVER_PX ? GROUND_RAISE : 0;
    }
  }
  return lift;
}

/** Key raise at a world point (nearest tile). */
export function liftAt(lift: Uint8Array, size: number, x: number, y: number): number {
  const tx = x < 0 ? 0 : x >= size ? size - 1 : x | 0;
  const ty = y < 0 ? 0 : y >= size ? size - 1 : y | 0;
  return lift[ty * size + tx];
}

/** Terrain in front hiding more than this many pixels of a unit's body (at scale 1) also hides its health bar and chevrons. */
export const HIDDEN_BODY_PX = 45;

/** Cover at a world point (nearest tile). */
export function coverAt(cover: Float32Array, size: number, x: number, y: number): number {
  const tx = x < 0 ? 0 : x >= size ? size - 1 : x | 0;
  const ty = y < 0 ? 0 : y >= size ? size - 1 : y | 0;
  return cover[ty * size + tx];
}
