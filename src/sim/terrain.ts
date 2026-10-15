import { DEFAULT_MAP, type LayoutType, type MapSpec, type ReliefType, type RiverType } from './mapSpec';
import { mulberry32 } from './random';
import { COVER_SAMPLE, COVER_STEPS } from './data/combat';
import { T_WATER, T_BLOCKED, LEVEL_PX, U_X, U_Y, V_X, V_Y, type Decor, type Bridge, type TerrainOptions } from './terrainTypes';
import { computeRegions, fixPockets, buildRelief, finishRelief } from './terrainRelief';
import { buildRiver, buildBridges, carveIslands, collectLand, buildCrossChannels, placeCastle, carveRoads } from './terrainRiver';
import { PathScratch, lineWalkable, findPath } from './terrainPath';
import { placeVillages, mirror, placeForest } from './terrainDecor';
import { buildLanes, computeLanesGeometry, type LanesGeometry } from './terrainLanes';
import { buildModeMap, isModeLayout } from './terrainModes';

// Constants and data types live in terrainTypes.ts; re-exported so everything is still imported from './terrain'.
export * from './terrainTypes';

/** Map data: the sim (collision) and the renderer (drawing) get identical results from the same seed. */
export class Terrain {
  readonly size: number;
  readonly flags: Uint8Array;
  readonly bridges: Bridge[] = [];
  readonly decor: Decor[] = [];
  /** Dirt path tiles (index). */
  readonly pathTiles: number[] = [];
  /** Land (island) tiles inside the river (index). */
  readonly landTiles: number[] = [];
  /** Tile elevation (0..4 steps), corner elevations ((n+1)^2, average of neighboring tiles) and cliff tiles. */
  height: Uint8Array;
  vh: Float32Array;
  hasRelief = false;
  /** Highest tile (elevation steps); 0 on flat maps. */
  maxH = 0;
  readonly cliffTiles: number[] = [];
  readonly spec: MapSpec;
  /** Effective river and relief type for the layout (citadel/crossroads have no river, archipelago has islands). */
  readonly riverKind: RiverType;
  readonly layout: LayoutType;
  /** @internal */
  readonly reliefKind: ReliefType | 'valley';
  /** Cross-channel (archipelago layout) bridge tiles and channel half width. */
  readonly crossBridgeTiles: number[] = [];
  readonly crossWaterTiles: number[] = [];
  crossHalf = 0;
  /** Connected-component id of walkable tiles (-1: not walkable) and the largest component. */
  region: Int32Array = new Int32Array(0);
  mainRegion = -1;
  /** What fixPockets did: ramps opened and closed-in tiles that had to be sealed (diagnostics / tests). */
  readonly fixInfo = { ramps: 0, sealed: 0 };
  /** 1 for tiles sealed by fixPockets (the ground there is closed in and now an obstacle). */
  /** @internal */
  sealedMark = new Uint8Array(0);
  /** Lanes layout only: lane (0..2) of every tile of a lane corridor, -1 elsewhere (plazas, walls); null on every other layout. */
  laneOf: Int8Array | null = null;
  /** Lanes layout only: castle, lane waypoints, spawn and tower spots computed from the generated corridors. */
  laneGeo: LanesGeometry | null = null;
  /** @internal Lanes layout only: shape parameters of the corridors. */
  laneShape: unknown = null;
  readonly cx: number;
  readonly cy: number;
  private readonly sMin: number;
  private readonly invStep: number;
  private readonly offTab: Float32Array;
  private readonly widTab: Float32Array;
  /** @internal */
  readonly occ: Uint8Array;
  /** @internal */
  readonly rng: () => number;
  /** @internal */
  readonly opts: TerrainOptions;

  constructor(size: number, opts: TerrainOptions) {
    this.size = size;
    this.opts = opts;
    this.spec = opts.spec ?? DEFAULT_MAP;
    this.layout = this.spec.layout;
    this.riverKind = this.layout === 'citadel' || this.layout === 'crossroads' || this.layout === 'lanes' || isModeLayout(this.layout) ? 'none' : this.layout === 'archipelago' ? 'islands' : this.spec.river;
    this.reliefKind = this.layout === 'lanes' || this.layout === 'arena' || this.layout === 'forts' ? 'flat' : this.layout === 'plateau' ? 'plateau' : this.layout === 'valley' ? 'valley' : this.layout === 'citadel' ? 'plateau' : this.layout === 'archipelago' || this.layout === 'crossroads' ? 'hills' : this.spec.relief;
    this.cx = this.cy = size / 2;
    this.flags = new Uint8Array(size * size);
    this.occ = new Uint8Array(size * size);
    this.height = new Uint8Array(size * size);
    this.vh = new Float32Array((size + 1) * (size + 1));
    this.rng = mulberry32(opts.seed * 9973 + 17);

    const step = 0.25;
    this.sMin = -size * 1.1;
    this.invStep = 1 / step;
    const n = Math.ceil((size * 2.2) / step) + 1;
    this.offTab = new Float32Array(n);
    this.widTab = new Float32Array(n);
    // The map is point-symmetric about its center (fair): the offset is an odd function, the width an even one.
    const a1 = 1.6 + this.rng() * 0.8;
    const a2 = 0.6 + this.rng() * 0.6;
    const k1 = 0.24 + this.rng() * 0.1;
    const k2 = 0.6 + this.rng() * 0.2;
    const k3 = 0.35 + this.rng() * 0.2;
    const rv = this.riverKind;
    const lakeL = size * 0.24;
    for (let i = 0; i < n; i++) {
      const s = this.sMin + i * step;
      // The river stays straight across the army width (fair to both sides); it bends outside it.
      const t = Math.min(1, Math.max(0, (Math.abs(s) - (opts.spawnHalfS + 2)) / 10));
      const wind = (a1 * Math.sin(s * k1) + a2 * Math.sin(s * k2)) * t * t * (3 - 2 * t);
      this.offTab[i] = rv === 'straight' || rv === 'none' ? 0 : wind;
      // Width is an even function (point symmetry): the lake bulges to both sides around |s| = lakeL.
      if (rv === 'none') this.widTab[i] = 0;
      else if (rv === 'straight') this.widTab[i] = 5 + 0.3 * Math.cos(s * k3);
      else if (rv === 'islands') this.widTab[i] = 8 + 0.8 * Math.cos(s * k3);
      else if (rv === 'lake') this.widTab[i] = 3.6 + 10 * Math.exp(-(((Math.abs(s) - lakeL) / 5.5) ** 2));
      else this.widTab[i] = 5.2 + 0.6 * Math.cos(s * k3);
    }

    if (this.layout === 'lanes') {
      // Dedicated Lane Conquest map: no river, relief, villages or random forest.
      buildLanes(this);
      computeRegions(this);
      fixPockets(this);
      this.laneGeo = computeLanesGeometry(this);
      return;
    }
    if (isModeLayout(this.layout)) {
      // Mode maps (arena, forts, plateau): their own skeleton, villages and forest of the recipe around it, no river.
      buildModeMap(this);
      computeRegions(this);
      fixPockets(this);
      return;
    }
    buildRiver(this);
    if (rv !== 'none') buildBridges(this);
    if (rv === 'islands') carveIslands(this);
    if (this.layout === 'archipelago') buildCrossChannels(this);
    buildRelief(this);
    placeVillages(this);
    placeForest(this);
    mirror(this);
    if (this.layout === 'citadel') placeCastle(this);
    if (this.layout === 'crossroads') carveRoads(this);
    finishRelief(this);
    collectLand(this);
    computeRegions(this);
    fixPockets(this);
  }

  /** Height at point (x,y) (in steps, fractional): bilinear interpolation of the corner elevations. */
  heightAt(x: number, y: number): number {
    if (!this.hasRelief) return 0;
    const n = this.size;
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(y)));
    const fx = Math.min(1, Math.max(0, x - cx));
    const fy = Math.min(1, Math.max(0, y - cy));
    const w = n + 1;
    const i = cy * w + cx;
    const h00 = this.vh[i];
    const h10 = this.vh[i + 1];
    const h01 = this.vh[i + w];
    const h11 = this.vh[i + w + 1];
    return h00 + (h10 - h00) * fx + (h01 - h00) * fy + (h00 - h10 - h01 + h11) * fx * fy;
  }

  /**
   * Is a direct shot from (x0,y0) to (x1,y1) blocked by terrain: the ground between the two points rises at least
   * COVER_STEPS above both of them (a ridge or mountain in the way). Flat or low maps never block.
   */
  blocksFire(x0: number, y0: number, x1: number, y1: number): boolean {
    if (this.maxH < COVER_STEPS) return false;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 2 * COVER_SAMPLE) return false;
    const ref = Math.max(this.heightAt(x0, y0), this.heightAt(x1, y1)) + COVER_STEPS;
    const steps = Math.floor(len / COVER_SAMPLE);
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      if (this.heightAt(x0 + dx * f, y0 + dy * f) >= ref) return true;
    }
    return false;
  }

  /** Steepest uphill grade (elevation steps per tile) along the straight line, sampled every 0.5 tiles. */
  lineGrade(x0: number, y0: number, x1: number, y1: number): number {
    if (!this.hasRelief) return 0;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    let prev = this.heightAt(x0, y0);
    let best = 0;
    for (let i = 1; i <= steps; i++) {
      const h = this.heightAt(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
      const g = (h - prev) / (len / steps);
      if (g > best) best = g;
      prev = h;
    }
    return best;
  }

  /** On-screen height at point (x,y) (pixels). */
  elevPx(x: number, y: number): number {
    return this.hasRelief ? this.heightAt(x, y) * LEVEL_PX : 0;
  }

  /** Corner height (steps) for vx,vy in [0..n]. */
  vertexH(vx: number, vy: number): number {
    return this.vh[vy * (this.size + 1) + vx];
  }

  /**
   * Is the step (ox,oy) -> (nx,ny) valid: the target must be walkable, and on a diagonal corner crossing
   * both side neighbors must be open (no squeezing through where two obstacles touch corner to corner).
   */
  stepOk(ox: number, oy: number, nx: number, ny: number): boolean {
    if (!this.walkable(nx, ny)) return false;
    if ((ox | 0) !== (nx | 0) && (oy | 0) !== (ny | 0)) return this.walkable(nx, oy) && this.walkable(ox, ny);
    return true;
  }

  /** Is the tile walkable (excluding water and obstacles). */
  walkable(x: number, y: number): boolean {
    const n = this.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return false;
    const f = this.flags[((y | 0) * n + (x | 0)) | 0];
    return f !== T_WATER && f !== T_BLOCKED;
  }

  // ---- A* pathfinding (only for units that get stuck); the search itself lives in terrainPath.ts ----
  /** @internal */
  readonly pathScratch = new PathScratch();

  /** Are all samples along the line (x0,y0)-(x1,y1) walkable (with a unit-radius margin). */
  lineWalkable(x0: number, y0: number, x1: number, y1: number): boolean {
    return lineWalkable(this, x0, y0, x1, y1);
  }

  /**
   * A* on the tile grid (8 neighbors, no corner cutting) plus path smoothing by direct line of sight.
   * Returns [x0,y0,x1,y1,...] waypoints (excluding the start); null if there is no path; [] if already there.
   */
  findPath(sx: number, sy: number, gx: number, gy: number, maxNodes = 0): number[] | null {
    return findPath(this, sx, sy, gx, gy, maxNodes);
  }

  /** Lane (0..2) of the corridor tile at (x,y); -1 in a plaza, on a wall, off the map or on any other layout. */
  laneAt(x: number, y: number): number {
    const m = this.laneOf;
    if (m === null) return -1;
    const n = this.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return -1;
    return m[((y | 0) * n + (x | 0)) | 0];
  }

  /** Connected-component id of (x,y) (-1: not walkable / off the map). */
  regionAt(x: number, y: number): number {
    const n = this.size;
    if (x < 0 || y < 0 || x >= n || y >= n) return -1;
    return this.region[((y | 0) * n + (x | 0)) | 0];
  }

  /** Is it in the main (largest) region: not a closed pocket/island. */
  reachable(x: number, y: number): boolean {
    return this.regionAt(x, y) === this.mainRegion;
  }

  /** If (x,y) is not walkable, returns the nearest walkable tile center (ring-by-ring search). mainOnly: it must be in the main region. */
  nearestWalkable(x: number, y: number, maxR = 14, mainOnly = false): { x: number; y: number } | null {
    if (this.walkable(x, y) && (!mainOnly || this.reachable(x, y))) return { x, y };
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let r = 1; r <= maxR; r++) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const px = cx + dx + 0.5;
          const py = cy + dy + 0.5;
          if (!this.walkable(px, py) || (mainOnly && !this.reachable(px, py))) continue;
          const d = (px - x) * (px - x) + (py - y) * (py - y);
          if (d < bestD) {
            bestD = d;
            best = { x: px, y: py };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** (x,y) -> river coordinates: s (along the river), d (perpendicular to the river, the u axis). */
  toS(x: number, y: number): number {
    return (x - this.cx) * V_X + (y - this.cy) * V_Y;
  }
  toD(x: number, y: number): number {
    return (x - this.cx) * U_X + (y - this.cy) * U_Y;
  }

  offsetAt(s: number): number {
    return this.offTab[this.idx(s)];
  }
  widthAt(s: number): number {
    return this.widTab[this.idx(s)];
  }
  private idx(s: number): number {
    const i = ((s - this.sMin) * this.invStep + 0.5) | 0;
    return i < 0 ? 0 : i >= this.offTab.length ? this.offTab.length - 1 : i;
  }

  /** Which bank of the river: -1 or +1. */
  sideAt(x: number, y: number): number {
    const s = this.toS(x, y);
    return this.toD(x, y) >= this.offsetAt(s) ? 1 : -1;
  }

  /** World point (s, d). */
  worldX(s: number, d: number): number {
    return this.cx + s * V_X + d * U_X;
  }
  worldY(s: number, d: number): number {
    return this.cy + s * V_Y + d * U_Y;
  }

  /** Bridge end: side=-1/+1 is the bank, lat = lateral offset along the board. */
  bridgeEnd(b: Bridge, side: number, lat: number, out: { x: number; y: number }): void {
    const s = b.s + lat;
    // Slightly inside the board end (the very end could fall into water due to tile rounding).
    const d = b.o + side * (b.w / 2 + 1.7);
    out.x = this.worldX(s, d);
    out.y = this.worldY(s, d);
  }

  /** @internal */
  tileIdx(x: number, y: number): number {
    return Math.floor(y) * this.size + Math.floor(x);
  }

  /** @internal */
  inMap(x: number, y: number, m = 0): boolean {
    return x >= m && y >= m && x < this.size - m && y < this.size - m;
  }

  /** Army spawns and bridge approach corridors: no obstacles are placed. */
  /** @internal */
  reserved(x: number, y: number, m: number): boolean {
    const s = this.toS(x, y);
    const d = Math.abs(this.toD(x, y));
    const { spawnD0, spawnD1, spawnHalfS } = this.opts;
    if (d > spawnD0 - m && d < spawnD1 + m && Math.abs(s) < spawnHalfS + m) return true;
    if (d < spawnD1 + 3 + m) {
      for (const b of this.bridges) if (Math.abs(s - b.s) < 3 + Math.min(m, 1)) return true;
    }
    return false;
  }

  /** @internal */
  riverEdgeDist(x: number, y: number): number {
    const s = this.toS(x, y);
    return Math.abs(this.toD(x, y) - this.offsetAt(s)) - this.widthAt(s) / 2;
  }
}
