import { DEFAULT_MAP, type LayoutType, type MapSpec, type ReliefType, type RiverType } from './mapSpec';
import { mulberry32 } from './random';
import { COVER_SAMPLE, COVER_STEPS, PATH_SLOPE_COST, PATH_SMOOTH_MAX_GRADE } from './data/combat';

export const T_GRASS = 0;
export const T_WATER = 1;
export const T_BRIDGE = 2;
export const T_BLOCKED = 3;
export const T_PATH = 4;

/** On-screen height of one elevation step (pixels). */
export const LEVEL_PX = 26;
export const MAX_LEVEL_H = 8;
/** Tile height units: 16 units per step; a neighbor difference >= CLIFF_UNITS makes a cliff. */
export const H_UNITS = 16;
export const CLIFF_UNITS = 24;

const R = Math.SQRT1_2;
/** River axes: u = army axis (horizontal on screen), v = river direction (vertical on screen). */
export const U_X = R;
export const U_Y = -R;
export const V_X = R;
export const V_Y = R;

export type DecorKind = 'tree' | 'rock' | 'boulder' | 'house' | 'wall' | 'rubble' | 'tower' | 'keep';

export interface Decor {
  kind: DecorKind;
  /** tree: size 0..2; rock/boulder: 0..2; house: size*2+style (0..5); wall/rubble: 0..1. */
  variant: number;
  /** World (tile) coordinates: the sprite's foot/bottom-corner point. */
  x: number;
  y: number;
}

export interface Bridge {
  /** Position along the river axis (v). */
  s: number;
  /** u-offset and width of the river center at this position. */
  o: number;
  w: number;
  /** Half length of the board (along u) and half width (along s). */
  halfLen: number;
  halfW: number;
}

export interface TerrainOptions {
  seed: number;
  /** The |d| range covered by army spawns and their half width (s). */
  spawnD0: number;
  spawnD1: number;
  spawnHalfS: number;
  /** Map recipe (defaults to the first-version forest map). */
  spec?: MapSpec;
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

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
  private readonly reliefKind: ReliefType | 'valley';
  /** Cross-channel (archipelago layout) bridge tiles and channel half width. */
  readonly crossBridgeTiles: number[] = [];
  readonly crossWaterTiles: number[] = [];
  crossHalf = 0;
  /** Connected-component id of walkable tiles (-1: not walkable) and the largest component. */
  region: Int32Array = new Int32Array(0);
  mainRegion = -1;
  readonly cx: number;
  readonly cy: number;
  private readonly sMin: number;
  private readonly invStep: number;
  private readonly offTab: Float32Array;
  private readonly widTab: Float32Array;
  private readonly occ: Uint8Array;
  private readonly rng: () => number;
  private readonly opts: TerrainOptions;

  constructor(size: number, opts: TerrainOptions) {
    this.size = size;
    this.opts = opts;
    this.spec = opts.spec ?? DEFAULT_MAP;
    this.layout = this.spec.layout;
    this.riverKind = this.layout === 'citadel' || this.layout === 'crossroads' ? 'none' : this.layout === 'archipelago' ? 'islands' : this.spec.river;
    this.reliefKind = this.layout === 'valley' ? 'valley' : this.layout === 'citadel' ? 'plateau' : this.layout === 'archipelago' || this.layout === 'crossroads' ? 'hills' : this.spec.relief;
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

    this.buildRiver();
    if (rv !== 'none') this.buildBridges();
    if (rv === 'islands') this.carveIslands();
    if (this.layout === 'archipelago') this.buildCrossChannels();
    this.buildRelief();
    this.placeVillages();
    this.placeForest();
    this.mirror();
    if (this.layout === 'citadel') this.placeCastle();
    if (this.layout === 'crossroads') this.carveRoads();
    this.finishRelief();
    this.collectLand();
    this.computeRegions();
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

  /** Splits walkable tiles into connected components (8-neighborhood, no corner cutting). */
  private computeRegions(): void {
    const n = this.size;
    const region = new Int32Array(n * n).fill(-1);
    const sizes: number[] = [];
    const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && this.walkable(x + 0.5, y + 0.5);
    const stack: number[] = [];
    let id = 0;
    for (let sy = 0; sy < n; sy++) {
      for (let sx = 0; sx < n; sx++) {
        if (region[sy * n + sx] !== -1 || !walk(sx, sy)) continue;
        let count = 0;
        region[sy * n + sx] = id;
        stack.push(sx, sy);
        while (stack.length) {
          const y = stack.pop()!;
          const x = stack.pop()!;
          count++;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = x + dx;
              const ny = y + dy;
              if (!walk(nx, ny) || region[ny * n + nx] !== -1) continue;
              if (dx && dy && !(walk(x + dx, y) && walk(x, y + dy))) continue;
              region[ny * n + nx] = id;
              stack.push(nx, ny);
            }
          }
        }
        sizes.push(count);
        id++;
      }
    }
    this.region = region;
    this.mainRegion = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
  }

  // ---- A* pathfinding (only for units that get stuck) ----
  private astarG: Float32Array | null = null;
  private astarParent: Int32Array | null = null;
  private astarStamp: Int32Array | null = null;
  private astarClosed: Int32Array | null = null;
  private astarGen = 0;
  private heapNode = new Int32Array(4096);
  private heapF = new Float64Array(4096);
  private nav: Uint8Array | null = null;

  /** 1 per walkable tile (built once; the terrain never changes during a battle). */
  private navMask(): Uint8Array {
    if (!this.nav) {
      const nav = new Uint8Array(this.size * this.size);
      for (let i = 0; i < nav.length; i++) nav[i] = this.flags[i] !== T_WATER && this.flags[i] !== T_BLOCKED ? 1 : 0;
      this.nav = nav;
    }
    return this.nav;
  }

  /** Are all samples along the line (x0,y0)-(x1,y1) walkable (with a unit-radius margin). */
  lineWalkable(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(len / 0.3));
    let px = x0;
    let py = y0;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (dx * i) / steps;
      const y = y0 + (dy * i) / steps;
      // Same rule as movement: diagonal corner crossing (two obstacles touching corner to corner) is forbidden.
      if (!this.stepOk(Math.fround(px), Math.fround(py), Math.fround(x), Math.fround(y))) return false;
      px = x;
      py = y;
      // Also check side neighbors so units do not scrape along edges (about the unit radius)
      const nx = -dy / (len || 1);
      const ny = dx / (len || 1);
      if (!this.walkable(x + nx * 0.2, y + ny * 0.2) || !this.walkable(x - nx * 0.2, y - ny * 0.2)) return false;
    }
    return true;
  }

  /**
   * A* on the tile grid (8 neighbors, no corner cutting) plus path smoothing by direct line of sight.
   * Returns [x0,y0,x1,y1,...] waypoints (excluding the start); null if there is no path; [] if already there.
   */
  findPath(sx: number, sy: number, gx: number, gy: number, maxNodes = 0): number[] | null {
    const n = this.size;
    const total = n * n;
    // Each tile is expanded at most once (closed set): `total` expansions suffice even if the whole map is scanned.
    if (maxNodes <= 0) maxNodes = Math.max(8000, total + 64);
    if (!this.astarG) {
      this.astarG = new Float32Array(total);
      this.astarParent = new Int32Array(total);
      this.astarStamp = new Int32Array(total);
      this.astarClosed = new Int32Array(total);
    }
    const C = this.astarClosed!;
    const G = this.astarG;
    const P = this.astarParent!;
    const S = this.astarStamp!;
    const gen = ++this.astarGen;
    let goal = { x: gx, y: gy };
    if (!this.walkable(gx, gy)) {
      const q = this.nearestWalkable(gx, gy, 4);
      if (!q) return null;
      goal = q;
    }
    const start = (sy | 0) * n + (sx | 0);
    const target = (goal.y | 0) * n + (goal.x | 0);
    if (start === target) return [];
    const tx = goal.x | 0;
    const ty = goal.y | 0;
    const h = (x: number, y: number): number => {
      const dx = Math.abs(x - tx);
      const dy = Math.abs(y - ty);
      return dx + dy + (1.414 - 2) * Math.min(dx, dy);
    };
    // binary heap (smallest f value first) on reusable typed arrays; same ordering rules as the original array heap
    const nav = this.navMask();
    let hn = this.heapNode;
    let hf = this.heapF;
    let hs = 0;
    const push = (node: number, f: number): void => {
      if (hs === hn.length) {
        const nn = new Int32Array(hn.length * 2);
        nn.set(hn);
        const nf = new Float64Array(hf.length * 2);
        nf.set(hf);
        hn = this.heapNode = nn;
        hf = this.heapF = nf;
      }
      let i = hs++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hf[p] <= f) break;
        hn[i] = hn[p];
        hf[i] = hf[p];
        i = p;
      }
      hn[i] = node;
      hf[i] = f;
    };
    const pop = (): number => {
      const top = hn[0];
      hs--;
      if (hs > 0) {
        const lastN = hn[hs];
        const lastF = hf[hs];
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          if (l >= hs) break;
          let m = l;
          const r = l + 1;
          let mf = hf[l];
          if (r < hs && hf[r] < mf) {
            m = r;
            mf = hf[r];
          }
          if (!(mf < lastF)) break;
          hn[i] = hn[m];
          hf[i] = mf;
          i = m;
        }
        hn[i] = lastN;
        hf[i] = lastF;
      }
      return top;
    };
    G[start] = 0;
    S[start] = gen;
    P[start] = -1;
    push(start, h(start % n, (start / n) | 0));
    let expanded = 0;
    let found = false;
    const relief = this.hasRelief;
    while (hs > 0 && expanded < maxNodes) {
      const cur = pop();
      if (C[cur] === gen) continue;
      C[cur] = gen;
      expanded++;
      if (cur === target) {
        found = true;
        break;
      }
      const cx = cur % n;
      const cy = (cur / n) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= n) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= n) continue;
          const idx = ny * n + nx;
          if (!nav[idx]) continue;
          if (dx && dy && !(nav[cy * n + nx] && nav[ny * n + cx])) continue;
          const climb = relief ? Math.max(0, this.height[idx] - this.height[cur]) / H_UNITS : 0;
          const ng = G[cur] + (dx && dy ? 1.414 : 1) * (1 + PATH_SLOPE_COST * climb);
          if (S[idx] === gen && ng >= G[idx]) continue;
          S[idx] = gen;
          G[idx] = ng;
          P[idx] = cur;
          push(idx, ng + h(nx, ny));
        }
      }
    }
    if (!found) return null;
    // rebuild the path backwards (tile centers)
    const nodes: number[] = [];
    for (let cur = target; cur !== -1 && cur !== start; cur = P[cur]) nodes.push(cur);
    nodes.reverse();
    const pts: number[] = [];
    for (const cur of nodes) pts.push((cur % n) + 0.5, ((cur / n) | 0) + 0.5);
    // smooth by direct line of sight
    const out: number[] = [];
    let ax = sx;
    let ay = sy;
    let i = 0;
    while (i < pts.length / 2) {
      let j = pts.length / 2 - 1;
      while (j > i && !(this.lineWalkable(ax, ay, pts[j * 2], pts[j * 2 + 1]) && this.lineGrade(ax, ay, pts[j * 2], pts[j * 2 + 1]) <= PATH_SMOOTH_MAX_GRADE)) j--;
      out.push(pts[j * 2], pts[j * 2 + 1]);
      ax = pts[j * 2];
      ay = pts[j * 2 + 1];
      i = j + 1;
    }
    return out;
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

  private tileIdx(x: number, y: number): number {
    return Math.floor(y) * this.size + Math.floor(x);
  }

  private inMap(x: number, y: number, m = 0): boolean {
    return x >= m && y >= m && x < this.size - m && y < this.size - m;
  }

  private buildRiver(): void {
    const n = this.size;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = this.toS(x, y);
        if (Math.abs(this.toD(x, y) - this.offsetAt(s)) < this.widthAt(s) / 2) this.flags[ty * n + tx] = T_WATER;
      }
    }
  }

  private buildBridges(): void {
    const n = this.size;
    const spacing = n < 90 ? 16 : 28;
    const limit = n * 0.5 - 3;
    for (let k = -Math.floor(limit / spacing); k <= Math.floor(limit / spacing); k++) {
      const s = k * spacing;
      const w = this.widthAt(s);
      this.bridges.push({ s, o: this.offsetAt(s), w, halfLen: w / 2 + 2.5, halfW: this.spec.crossing === 'ford' ? 2.4 : 1.8 });
    }
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = this.toS(x, y);
        const d = this.toD(x, y);
        for (const b of this.bridges) {
          if (Math.abs(s - b.s) < b.halfW + 0.05 && Math.abs(d - b.o) < b.halfLen) {
            this.flags[ty * n + tx] = T_BRIDGE;
            break;
          }
        }
      }
    }
  }

  /** Small islands between the bridges in the river (only the d < 0 half; mirror produces the other). */
  private carveIslands(): void {
    const n = this.size;
    const spacing = n < 90 ? 16 : 28;
    const limit = n * 0.5 - 3;
    const K = Math.floor(limit / spacing);
    for (let k = -K - 1; k <= K; k++) {
      const sc = (k + 0.5) * spacing;
      if (Math.abs(sc) > limit - 2) continue;
      const o = this.offsetAt(sc);
      const rd = this.widthAt(sc) * 0.3;
      for (let ty = 0; ty < n; ty++) {
        for (let tx = 0; tx < n; tx++) {
          const i = ty * n + tx;
          if (this.flags[i] !== T_WATER) continue;
          const x = tx + 0.5;
          const y = ty + 0.5;
          if (this.toD(x, y) >= 0) continue;
          const a = (this.toS(x, y) - sc) / 3.4;
          const b = (this.toD(x, y) - o) / rd;
          if (a * a + b * b < 1) this.flags[i] = T_GRASS;
        }
      }
    }
  }

  /** Land tiles remaining inside the river (islands): for drawing. */
  private collectLand(): void {
    this.landTiles.length = 0;
    if (this.riverKind === 'none') return;
    const n = this.size;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = ty * n + tx;
        if (this.flags[i] !== T_GRASS) continue;
        if (this.riverEdgeDist(tx + 0.5, ty + 0.5) < 0) this.landTiles.push(i);
      }
    }
  }

  /** Archipelago layout: two channels perpendicular to the river (s = about +-bridge spacing/2) and bridges crossing them. */
  private buildCrossChannels(): void {
    const n = this.size;
    const cw = Math.max(4, n * 0.07);
    this.crossHalf = cw / 2;
    const s0 = (n < 90 ? 16 : 28) / 2;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const s = this.toS(x, y);
        if (Math.abs(Math.abs(s) - s0) >= cw / 2) continue;
        if (this.reserved(x, y, 1)) continue;
        const i = ty * n + tx;
        if (this.flags[i] === T_GRASS || this.flags[i] === T_PATH) {
          this.flags[i] = T_WATER;
          this.crossWaterTiles.push(i);
        }
      }
    }
    // Bridges: d = +-0.16n and +-0.34n for each channel.
    for (const sc of [-s0, s0]) {
      for (const dc of [-0.34 * n, -0.16 * n, 0.16 * n, 0.34 * n]) {
        for (let ty = 0; ty < n; ty++) {
          for (let tx = 0; tx < n; tx++) {
            const x = tx + 0.5;
            const y = ty + 0.5;
            if (Math.abs(this.toD(x, y) - dc) > 1.4 || Math.abs(this.toS(x, y) - sc) > cw / 2 + 1.3) continue;
            const i = ty * n + tx;
            if (this.flags[i] === T_BRIDGE) continue;
            if (this.flags[i] === T_WATER || this.flags[i] === T_GRASS) {
              this.flags[i] = T_BRIDGE;
              this.crossBridgeTiles.push(i);
            }
          }
        }
      }
    }
  }

  /** Clears the area: removes decor and tree/house obstacles (for the citadel). */
  private clearArea(cx: number, cy: number, r: number): void {
    const n = this.size;
    const keep = this.decor.filter((d) => Math.hypot(d.x - cx, d.y - cy) >= r);
    this.decor.length = 0;
    for (const d of keep) this.decor.push(d);
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        if (Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy) >= r) continue;
        const i = ty * n + tx;
        if (this.flags[i] === T_BLOCKED && this.height[i] >= 0) {
          // only non-cliff obstacles (tree/house/rock) are removed
          let cliff = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx >= 0 && ny >= 0 && nx < n && ny < n && this.height[i] - this.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
          }
          if (!cliff) this.flags[i] = T_GRASS;
        }
        this.occ[i] = 0;
      }
    }
  }

  /** Central citadel: a ring wall on the plateau (gates toward the ramps), 4 corner towers and a keep in the middle. Point-symmetric. */
  private placeCastle(): void {
    const n = this.size;
    const c = n / 2;
    const r = n * 0.21;
    const rho = r * 0.6;
    this.clearArea(c, c, rho + 2.5);
    const put = (tx: number, ty: number, kind: 'wall' | 'tower', variant: number): void => {
      const i = ty * n + tx;
      if (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1 || this.flags[i] !== T_GRASS) return;
      this.flags[i] = T_BLOCKED;
      this.occ[i] = 1;
      this.decor.push(kind === 'wall' ? { kind, variant, x: tx + 0.5, y: ty + 0.5 } : { kind, variant, x: tx + 1, y: ty + 1 });
    };
    // Ring wall: every tile whose distance from the center is in [rho - 0.5, rho + 0.5); gates face the ramps.
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const dx = tx + 0.5 - c;
        const dy = ty + 0.5 - c;
        const dist = Math.hypot(dx, dy);
        if (dist < rho - 0.5 || dist >= rho + 0.5) continue;
        const gate = Math.pow(Math.max(0, Math.cos(2 * Math.atan2(dy, dx))), 4);
        if (gate > 0.55) continue;
        put(tx, ty, 'wall', (tx + ty) & 1);
      }
    }
    // Corner towers (4 diagonal directions, point-symmetric).
    const A = Math.round(rho * Math.SQRT1_2);
    for (const [tx, ty] of [[c + A, c + A], [c - A - 1, c - A - 1], [c + A, c - A - 1], [c - A - 1, c + A]]) {
      const i = ty * n + tx;
      if (this.flags[i] === T_BLOCKED && this.decor.some((d) => d.kind === 'wall' && Math.floor(d.x) === tx && Math.floor(d.y) === ty)) {
        const k = this.decor.findIndex((d) => d.kind === 'wall' && Math.floor(d.x) === tx && Math.floor(d.y) === ty);
        this.decor.splice(k, 1);
        this.flags[i] = T_GRASS;
      }
      put(tx, ty, 'tower', 0);
    }
    // Keep: a 4x4 block in the middle (tiles c-2..c+1), an obstacle.
    for (let ty = c - 2; ty < c + 2; ty++) for (let tx = c - 2; tx < c + 2; tx++) {
      this.flags[ty * n + tx] = T_BLOCKED;
      this.occ[ty * n + tx] = 1;
    }
    this.decor.push({ kind: 'keep', variant: 0, x: c + 2, y: c + 2 });
  }

  /** Crossroads: dirt road along the middle axes (symmetric). */
  private carveRoads(): void {
    const n = this.size;
    for (let t = -n; t <= n; t += 0.4) {
      for (const [x, y] of [[this.worldX(0, t), this.worldY(0, t)], [this.worldX(t, 0), this.worldY(t, 0)]]) {
        if (!this.inMap(x, y, 1)) continue;
        const idx = this.tileIdx(x, y);
        if (this.flags[idx] === T_GRASS) {
          this.flags[idx] = T_PATH;
          this.pathTiles.push(idx);
        }
      }
    }
  }

  /** Elevation generation: continuous field by relief type -> steps; flattened near the border, river and spawns. */
  private buildRelief(): void {
    const rl = this.reliefKind;
    if (rl === 'flat') return;
    const amp = this.layout === 'archipelago' ? 0.7 : this.layout === 'crossroads' ? 0.8 : 1;
    const n = this.size;
    const c = n / 2;
    const seed = this.opts.seed + 101;
    const hasRiver = this.riverKind !== 'none';
    const smooth = (a: number, b: number, v: number): number => {
      const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const radial = rl === 'plateau' || rl === 'peak';
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        const d = this.toD(x, y);
        if (d > 1e-9) continue; // only the d <= 0 half is generated, then mirrored
        const s = this.toS(x, y);
        const ad = Math.abs(d);
        const dist = Math.hypot(x - c, y - c);
        let H = 0;
        if (rl === 'hills') {
          H = 15 * amp * (0.65 * noise(x / 13, y / 13, seed) + 0.35 * noise(x / 6, y / 6, seed + 5) - 0.36);
        } else if (rl === 'valley') {
          // Two high ridges parallel to the middle axis; only one pass (gate) is open near s ~ 0.
          const R = n * 0.17;
          const hw = n * 0.05 * (1 - 0.97 * Math.exp(-((s / (n * 0.075)) ** 2)));
          H = 7 * smooth(0, 1, (hw - Math.abs(ad - R)) / 0.9 + 0.5) + 0.5 * noise(x / 6, y / 6, seed + 4);
        } else if (rl === 'ridge') {
          const R = n * 0.2;
          const pass = 0.5 + 0.5 * Math.cos((s * Math.PI * 2) / (n * 0.5));
          H = 7.4 * Math.exp(-(((ad - R) / (n * 0.07)) ** 2)) * (0.25 + 0.75 * smooth(0.25, 0.8, pass)) + 1 * noise(x / 7, y / 7, seed + 3);
        } else if (rl === 'plateau') {
          const r = n * 0.21;
          const ang = Math.atan2(y - c, x - c);
          const ramp = Math.pow(Math.max(0, Math.cos(2 * ang)), 4);
          const w = 0.9 + 6 * ramp;
          // In the citadel layout the plateau top is perfectly flat (the castle is built there).
          const top = this.layout === 'citadel' && dist < r * 0.85 ? 0 : 0.3;
          H = 5.6 * smooth(0, 1, (r - dist) / w + 0.5) + top * noise(x / 5, y / 5, seed + 2);
        } else {
          const R = n * 0.23;
          H = 8.2 * Math.pow(Math.max(0, 1 - dist / R), 1.0) + 1.6 * Math.abs(noise(x / 4.5, y / 4.5, seed + 9) - 0.5) * 2 * smooth(0, 5, R - dist);
        }
        if (!radial) H *= smooth(1.5, 5, ad); // river/middle axis valley
        if (hasRiver && !radial) H *= smooth(2.5, 6, this.riverEdgeDist(x, y));
        else if (hasRiver) H *= smooth(0, 2.5, this.riverEdgeDist(x, y));
        // Bridges and approach paths stay flat (ramps/cliffs must not cut the bridge).
        for (const br of this.bridges) {
          const bd = Math.max(Math.abs(s - br.s) / 4.5, Math.abs(d - br.o) / (br.halfLen + 6));
          if (bd < 1) H *= smooth(0.55, 1, bd);
        }
        H *= smooth(0, 3, Math.min(tx, ty, n - 1 - tx, n - 1 - ty)); // map edge is flat
        if (this.reserved(x, y, 2)) H = 0;
        const f = this.flags[ty * n + tx];
        if (f === T_WATER || f === T_BRIDGE) H = 0;
        this.height[ty * n + tx] = Math.min(MAX_LEVEL_H * H_UNITS, Math.max(0, Math.round(H * H_UNITS)));
      }
    }
    // Point symmetry.
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const d = this.toD(tx + 0.5, ty + 0.5);
        if (d > 1e-9 || (d >= -1e-9 && ty * n + tx > (n - 1 - ty) * n + (n - 1 - tx))) continue;
        this.height[(n - 1 - ty) * n + (n - 1 - tx)] = this.height[ty * n + tx];
      }
    }
    // Cliff: a walkable tile >= 2 steps higher than its neighbor is impassable.
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = ty * n + tx;
        if (this.flags[i] !== T_GRASS) continue;
        const h = this.height[i];
        let cliff = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          if (h - this.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
        }
        if (cliff) {
          this.flags[i] = T_BLOCKED;
          this.cliffTiles.push(i);
        }
      }
    }
  }

  /** After elevation is done: corner elevations and the relief flag. */
  private finishRelief(): void {
    const n = this.size;
    let any = false;
    for (let i = 0; i < this.height.length; i++) if (this.height[i] > 0) any = true;
    this.hasRelief = any;
    let mh = 0;
    for (let i = 0; i < this.height.length; i++) if (this.height[i] > mh) mh = this.height[i];
    this.maxH = mh / H_UNITS;
    if (!any) return;
    const w = n + 1;
    for (let vy = 0; vy <= n; vy++) {
      for (let vx = 0; vx <= n; vx++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 0; dy++) {
          for (let dx = -1; dx <= 0; dx++) {
            const tx = vx + dx;
            const ty = vy + dy;
            if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
            sum += this.height[ty * n + tx];
            cnt++;
          }
        }
        this.vh[vy * w + vx] = sum / Math.max(1, cnt) / H_UNITS;
      }
    }
    // Keep the cliff tiles as a list for drawing (decor/house placement already treats them as obstacles).
    this.cliffTiles.length = 0;
    for (let i = 0; i < this.flags.length; i++) {
      if (this.flags[i] !== T_BLOCKED) continue;
      const tx = i % n;
      const ty = (i / n) | 0;
      const h = this.height[i];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx >= 0 && ny >= 0 && nx < n && ny < n && h - this.height[ny * n + nx] >= CLIFF_UNITS) {
          this.cliffTiles.push(i);
          break;
        }
      }
    }
  }

  /** Army spawns and bridge approach corridors: no obstacles are placed. */
  private reserved(x: number, y: number, m: number): boolean {
    const s = this.toS(x, y);
    const d = Math.abs(this.toD(x, y));
    const { spawnD0, spawnD1, spawnHalfS } = this.opts;
    if (d > spawnD0 - m && d < spawnD1 + m && Math.abs(s) < spawnHalfS + m) return true;
    if (d < spawnD1 + 3 + m) {
      for (const b of this.bridges) if (Math.abs(s - b.s) < 3 + Math.min(m, 1)) return true;
    }
    return false;
  }

  private riverEdgeDist(x: number, y: number): number {
    const s = this.toS(x, y);
    return Math.abs(this.toD(x, y) - this.offsetAt(s)) - this.widthAt(s) / 2;
  }

  private freeRect(tx: number, ty: number, w: number, h: number, margin: number): boolean {
    const n = this.size;
    const h0 = tx >= 0 && ty >= 0 && tx < n && ty < n ? this.height[ty * n + tx] : 0;
    for (let y = ty - margin; y < ty + h + margin; y++) {
      for (let x = tx - margin; x < tx + w + margin; x++) {
        if (x < 1 || y < 1 || x >= n - 1 || y >= n - 1) return false;
        const i = y * n + x;
        if (this.flags[i] !== T_GRASS || this.occ[i]) return false;
        if (Math.abs(this.height[i] - h0) > 4) return false; // structures are built on flat ground
        if (this.reserved(x + 0.5, y + 0.5, 1)) return false;
      }
    }
    return true;
  }

  private placeVillages(): void {
    const n = this.size;
    const rng = this.rng;
    const vt = this.spec.village;
    if (vt === 'none') return;
    const sites =
      vt === 'scattered' ? Math.max(2, Math.round((n * n) / 900)) : vt === 'ruins' ? Math.max(1, Math.round((n * n) / 3600)) : vt === 'camp' ? Math.max(1, Math.round((n * n) / 3000)) : Math.max(1, Math.round((n * n) / 2200));
    const spacing = vt === 'scattered' ? 11 : vt === 'village' ? 16 : 20;
    const centers: Array<{ x: number; y: number; side: number }> = [];
    const sizes: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [2, 3],
    ];

    if (this.layout === 'crossroads') {
      // Crossroads layout: fixed hamlets in the four corners of the junction.
      for (const [sc, dc] of [[-0.25, -0.2], [0.25, -0.2]]) {
        const x = this.worldX(sc * n, dc * n);
        const y = this.worldY(sc * n, dc * n);
        if (this.inMap(x, y, 6) && this.flags[this.tileIdx(x, y)] === T_GRASS) centers.push({ x, y, side: -1 });
      }
    }
    for (let k = 0; this.layout !== 'crossroads' && k < sites; k++) {
      const side = -1; // only one half is generated, then mirrored
      for (let attempt = 0; attempt < 80; attempt++) {
        const s = (rng() * 2 - 1) * n * 0.6;
        const dd = 10 + rng() * 14;
        const x = this.worldX(s, side * dd);
        const y = this.worldY(s, side * dd);
        if (!this.inMap(x, y, 8) || this.reserved(x, y, 4)) continue;
        if (centers.some((c) => Math.hypot(c.x - x, c.y - y) < spacing)) continue;
        if (this.flags[this.tileIdx(x, y)] !== T_GRASS) continue;
        centers.push({ x, y, side });
        break;
      }
    }

    for (const c of centers) {
      const count = vt === 'scattered' ? 1 + Math.floor(rng() * 2) : vt === 'ruins' ? 2 + Math.floor(rng() * 2) : vt === 'camp' ? 2 : 3 + Math.floor(rng() * 4);
      let placed = 0;
      for (let attempt = 0; attempt < 40 && placed < count; attempt++) {
        const a = rng() * Math.PI * 2;
        const r = vt === 'camp' ? rng() * 2.2 : 2.5 + rng() * 5.5;
        const [w, h] = sizes[Math.floor(rng() * sizes.length)];
        const tx = Math.floor(c.x + Math.cos(a) * r);
        const ty = Math.floor(c.y + Math.sin(a) * r);
        if (!this.freeRect(tx, ty, w, h, 1)) continue;
        for (let y = ty - 1; y < ty + h + 1; y++) for (let x = tx - 1; x < tx + w + 1; x++) this.occ[y * n + x] = 1;
        for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) this.flags[y * n + x] = T_BLOCKED;
        const sizeIdx = sizes.findIndex((z) => z[0] === w && z[1] === h);
        this.decor.push({ kind: 'house', variant: sizeIdx * 2 + (rng() < 0.5 ? 0 : 1), x: tx + w, y: ty + h });
        placed++;
        // Rubble and broken wall pieces: around the house.
        for (let q = 0; q < 3; q++) {
          const rx = tx - 1 + Math.floor(rng() * (w + 2));
          const ry = ty - 1 + Math.floor(rng() * (h + 2));
          const edge = rx < tx || ry < ty || rx >= tx + w || ry >= ty + h;
          const i = ry * n + rx;
          if (!edge || rx < 1 || ry < 1 || rx >= n - 1 || ry >= n - 1 || this.flags[i] !== T_GRASS) continue;
          if (q === 0) {
            this.flags[i] = T_BLOCKED;
            this.decor.push({ kind: 'wall', variant: rng() < 0.5 ? 0 : 1, x: rx + 0.5, y: ry + 0.5 });
          } else {
            this.decor.push({ kind: 'rubble', variant: rng() < 0.5 ? 0 : 1, x: rx + 0.3 + rng() * 0.4, y: ry + 0.3 + rng() * 0.4 });
          }
        }
      }
      if (vt === 'camp') this.wallRing(c.x, c.y, 5, 16, 5);
      if (vt === 'ruins') {
        this.wallRing(c.x, c.y, 7.5, 28, 7);
        for (let q = 0; q < 10; q++) {
          const a = rng() * Math.PI * 2;
          const r = 3 + rng() * 5;
          const x = c.x + Math.cos(a) * r;
          const y = c.y + Math.sin(a) * r;
          if (this.freeRect(Math.floor(x), Math.floor(y), 1, 1, 0)) this.decor.push({ kind: 'rubble', variant: rng() < 0.5 ? 0 : 1, x, y });
        }
      }
      this.carvePath(c.x, c.y, c.side);
    }
  }

  /** Is any of the tile's 8 neighbors an obstacle (walls must not touch corner to corner: that leaves leaks). */
  private blockedAround(tx: number, ty: number): boolean {
    const n = this.size;
    for (let y = ty - 1; y <= ty + 1; y++) {
      for (let x = tx - 1; x <= tx + 1; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (this.flags[y * n + x] === T_BLOCKED) return true;
      }
    }
    return false;
  }

  /** Ring of spaced wall pieces around the center (leaves an entrance gap). */
  private wallRing(cx: number, cy: number, radius: number, segs: number, gapEvery: number): void {
    const n = this.size;
    for (let k = 0; k < segs; k++) {
      if (k % gapEvery === 0) continue;
      const a = (k / segs) * Math.PI * 2;
      const tx = Math.floor(cx + Math.cos(a) * radius);
      const ty = Math.floor(cy + Math.sin(a) * radius);
      if (!this.freeRect(tx, ty, 1, 1, 0) || this.blockedAround(tx, ty)) continue;
      this.flags[ty * n + tx] = T_BLOCKED;
      this.occ[ty * n + tx] = 1;
      this.decor.push({ kind: 'wall', variant: k % 2, x: tx + 0.5, y: ty + 0.5 });
    }
  }

  /** Copies the d < 0 half onto the d > 0 half by point reflection about the center: both sides get equal conditions. */
  private mirror(): void {
    const n = this.size;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const d = this.toD(tx + 0.5, ty + 0.5);
        // Tiles on the axis (d = 0) pair among themselves: the smaller index is the source.
        if (d > 1e-9 || (d >= -1e-9 && ty * n + tx > (n - 1 - ty) * n + (n - 1 - tx))) continue;
        this.flags[(n - 1 - ty) * n + (n - 1 - tx)] = this.flags[ty * n + tx];
      }
    }
    const houseSize = [
      [2, 2],
      [3, 2],
      [2, 3],
    ];
    const kept = this.decor.filter((d) => this.toD(d.x, d.y) < 0);
    this.decor.length = 0;
    for (const d of kept) this.decor.push(d);
    for (const d of kept) {
      let x = n - d.x;
      let y = n - d.y;
      if (d.kind === 'house') {
        const [w, h] = houseSize[d.variant >> 1];
        x += w;
        y += h;
      }
      this.decor.push({ kind: d.kind, variant: d.variant, x, y });
    }
    this.pathTiles.length = 0;
    for (let i = 0; i < this.flags.length; i++) if (this.flags[i] === T_PATH) this.pathTiles.push(i);
  }

  /** Dirt path from the village to the end of the nearest bridge on its own bank. */
  private carvePath(x0: number, y0: number, side: number): void {
    if (this.bridges.length === 0) return;
    const p = { x: 0, y: 0 };
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (const b of this.bridges) {
      this.bridgeEnd(b, side, 0, p);
      const d = Math.hypot(p.x - x0, p.y - y0);
      if (d < best) {
        best = d;
        bx = p.x;
        by = p.y;
      }
    }
    const steps = Math.ceil(best / 0.6);
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((bx - x0) * i) / steps;
      const y = y0 + ((by - y0) * i) / steps;
      if (!this.inMap(x, y, 1)) continue;
      const idx = this.tileIdx(x, y);
      if (this.flags[idx] === T_GRASS) {
        this.flags[idx] = T_PATH;
        this.pathTiles.push(idx);
      }
    }
  }

  private placeForest(): void {
    const n = this.size;
    const rng = this.rng;
    const seed = this.opts.seed;
    const ft = this.spec.forest;
    const hasRiver = this.riverKind !== 'none';
    // Forest type: threshold (thr), tree probability and the upper limit of the rock band.
    const thr = ft === 'none' ? 99 : ft === 'sparse' ? 0.66 : ft === 'grove' ? 0.64 : 0.6;
    const prob = ft === 'sparse' ? 0.3 : ft === 'grove' ? 0.55 : 0.4;
    const rockHi = ft === 'none' ? 0.6 : Math.min(thr, 0.66);
    const blockedNear = (tx: number, ty: number): boolean => {
      for (let y = ty - 1; y <= ty + 1; y++) {
        for (let x = tx - 1; x <= tx + 1; x++) {
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          if (this.flags[y * n + x] === T_BLOCKED) return true;
        }
      }
      return false;
    };
    for (let ty = 1; ty < n - 1; ty++) {
      for (let tx = 1; tx < n - 1; tx++) {
        const i = ty * n + tx;
        if (this.flags[i] !== T_GRASS || this.occ[i]) continue;
        const x = tx + 0.5;
        const y = ty + 0.5;
        if (this.reserved(x, y, 1)) continue;
        const edge = Math.min(tx, ty, n - tx, n - ty);
        const bias = 0.3 * (1 - Math.min(1, edge / 10));
        let v = 0.65 * noise(x / 9, y / 9, seed) + 0.35 * noise(x / 4, y / 4, seed + 7) + bias;
        if (ft === 'grove') v = 0.85 * noise(x / 17, y / 17, seed + 3) + 0.15 * noise(x / 5, y / 5, seed + 7);
        else if (ft === 'ring') v = edge < 9 ? 0.62 + 0.12 * (1 - edge / 9) + 0.1 * noise(x / 4, y / 4, seed + 7) : 0.3 * noise(x / 9, y / 9, seed);
        const riverDist = hasRiver ? this.riverEdgeDist(x, y) : 99;
        if (v > thr && riverDist > 4) {
          if (rng() < prob && !blockedNear(tx, ty)) {
            this.flags[i] = T_BLOCKED;
            this.decor.push({ kind: 'tree', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.4, y: y + (rng() - 0.5) * 0.4 });
          }
        } else if ((riverDist > 0.4 && riverDist < 2.5 && rng() < 0.05) || (v > 0.5 && v <= rockHi && rng() < 0.03)) {
          const boulder = rng() < 0.25 && !blockedNear(tx, ty);
          if (boulder) this.flags[i] = T_BLOCKED;
          this.decor.push({ kind: boulder ? 'boulder' : 'rock', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.5, y: y + (rng() - 0.5) * 0.5 });
        }
      }
    }
  }
}
