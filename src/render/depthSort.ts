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
 * How the origin sums are grouped into depth bands. Every band is one draw call and every band edge is one particle slab of the
 * crowd renderer (also a draw call), so fewer bands are cheaper; but a unit is drawn over the whole band that starts at or below
 * its sum, so tiles of the same band that lie in front of it never hide it. `planBandStarts` therefore only starts a new band where
 * terrain in front really hides something (steeper than the iso slope, see `computeCover`) by more than `tolPx` pixels; on smooth
 * ground whole stretches share one band. `maxWidth` caps a band in sums.
 */
export interface BandPlan {
  tolPx: number;
  maxWidth: number;
}

/** Crowds are drawn small, so the hiding error that is tolerated grows with the number of units. */
export function bandPlanFor(units: number): BandPlan {
  const tolPx = units <= 3000 ? RAISE_COVER_PX : units <= 8000 ? 14 : units <= 16000 ? 28 : 45;
  return { tolPx, maxWidth: 12 };
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
 * Groups the tiles that have relief by origin sum tx+ty, in `width`-wide bands (or, with a start table from `planBandStarts`, in the bands it plans). Nearly flat tiles (and, with `overlay`, low tiles
 * under river/bridge art) are left out: they stay in the base layer.
 */
export function reliefBands(size: number, vertexH: (vx: number, vy: number) => number, width: number | Int32Array = 1, overlay?: Uint8Array | null): ReliefBands {
  const tiles = new Map<number, number[]>();
  for (let sum = 0; sum <= 2 * size - 2; sum++) {
    const key = typeof width === 'number' ? sum - (sum % width) : width[sum];
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

/** Sample offsets inside a tile (per axis): units stand anywhere on a tile, not only at its centre. */
const PLAN_GRID = [0.15, 0.5, 0.85];

/**
 * Band start (first origin sum) of every origin sum 0..2*size-2: runs of consecutive sums share one band unless terrain in front of
 * a point of the run hides it by more than `plan.tolPx`. A point on a tile of sum S is hidden by terrain on a tile of sum Q >= S+2
 * (a unit at x+y in [S+1, S+2) is already above band S+1 in the exact order), which needs a band starting in [S+2, Q]; a minimal
 * set of starts is picked greedily (interval stabbing), and runs are cut at `plan.maxWidth`. Each tile is sampled at nine points
 * and along the screen-vertical diagonal in quarter-tile steps (the hiding test of `computeCover`, finer).
 */
export function planBandStarts(size: number, elevPx: (x: number, y: number) => number, maxElevPx: number, plan: BandPlan): Int32Array {
  const sums = 2 * size - 1;
  const startOf = new Int32Array(sums);
  // Per start S+2: the smallest Q that needs a band start in [S+2, Q]; best[from] = min Q over the intervals starting there.
  const best = new Int32Array(sums + 2).fill(1 << 30);
  if (maxElevPx > 0) {
    // Terrain can only hide a point if it rises faster than the iso slope somewhere between the two: a tile whose height
    // gradient along (1,1) can exceed PX_PER_T. Per diagonal (x - y) the last such tile; a point with no such tile ahead on its
    // own or the two neighbouring diagonals is skipped (exact: the skipped samples could never exceed `tolPx`).
    const eh = (x: number, y: number): number => elevPx(Math.min(size - 0.001, x), Math.min(size - 0.001, y));
    const lastSteep = new Int32Array(2 * size + 3).fill(-1);
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const h00 = eh(tx, ty);
        const h10 = eh(tx + 1, ty);
        const h01 = eh(tx, ty + 1);
        const h11 = eh(tx + 1, ty + 1);
        if (Math.max(h10 - h00, h11 - h01) + Math.max(h01 - h00, h11 - h10) > PX_PER_T) lastSteep[tx - ty + size + 1] = Math.max(lastSteep[tx - ty + size + 1], tx);
      }
    }
    const sample = (cx: number, cy: number, s: number): void => {
      const px0 = Math.min(size - 0.001, Math.max(0, cx));
      const py0 = Math.min(size - 0.001, Math.max(0, cy));
      const base = elevPx(px0, py0);
      for (let t = 0.25; t * PX_PER_T < maxElevPx - base + PX_PER_T; t += 0.25) {
        const px = cx + t;
        const py = cy + t;
        if (px >= size || py >= size) break;
        if (elevPx(px, py) - PX_PER_T * t - base > plan.tolPx) {
          const q = Math.floor(px) + Math.floor(py);
          if (q >= s + 2) {
            if (q < best[s + 2]) best[s + 2] = q;
            return;
          }
        }
      }
    };
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const dg = tx - ty + size + 1;
        if (lastSteep[dg - 1] < tx && lastSteep[dg] < tx && lastSteep[dg + 1] < tx) continue;
        for (const oy of PLAN_GRID) for (const ox of PLAN_GRID) sample(tx + ox, ty + oy, tx + ty);
      }
    }
  }
  // Intervals [from, best[from]]: sweep ascending right ends. Right ends are > from, so bucket by from and stab greedily.
  const intervals: Array<[number, number]> = [];
  for (let from = 0; from < best.length; from++) if (best[from] < 1 << 30) intervals.push([from, best[from]]);
  intervals.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const isStart = new Uint8Array(sums + 2);
  let lastPick = -1;
  for (const [from, to] of intervals) {
    // Picks ascend and never exceed the current right end, so [from, to] is stabbed iff the last pick is at or after `from`.
    if (lastPick >= from) continue;
    isStart[to] = 1;
    lastPick = to;
  }
  let start = 0;
  for (let s = 0; s < sums; s++) {
    if (isStart[s] || s - start >= plan.maxWidth) start = s;
    startOf[s] = start;
  }
  return startOf;
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

/** What the renderers need to order things against the terrain and the big decor . */
export interface DepthInfo {
  /** Origin sums of the relief depth bands, ascending (empty on flat maps). */
  cuts: number[];
  boxes: DepthBoxIndex;
  /** Per tile: pixels of terrain in front that hide a ground point (0 on flat maps). */
  cover: Float32Array;
  /** Per tile: key raise of entities standing there (1 where no terrain in front hides them; see computeLift). */
  lift: Uint8Array;
  size: number;
}
