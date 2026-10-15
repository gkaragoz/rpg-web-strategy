import { T_BLOCKED, T_GRASS, T_PATH } from './terrainTypes';
import type { Terrain } from './terrain';

// Terrain: the 'lanes' layout of Lane Conquest. Two open castle plazas (left = team 0, right = team 1) joined by three parallel
// lane corridors (top, middle, bottom) that are walled off from each other: the only place where lanes meet is a plaza. x runs
// along the lanes, y across them. The whole map is mirror-symmetric (x -> n - x and y -> n - y), so it is fair to both sides.

/** Smallest map size of the layout (the sim clamps smaller configured sizes up to it, see `mapSizeFor`). */
export const LANES_MIN_SIZE = 80;
export const LANE_COUNT = 3;
/** Nominal lane centre lines (fraction of the map size, across the lanes). */
export const LANE_Y = [0.2, 0.5, 0.8] as const;
/** Lane half width (tiles): corridors are 6 to 7 tiles wide. */
export const LANE_HALF_W = 3.3;
/** Plazas cover x < PLAZA_X * size (left) and x > (1 - PLAZA_X) * size (right). */
export const PLAZA_X = 0.22;
/** Castle position along the lanes (fraction of the map size, from its own edge). */
export const CASTLE_X = 0.1;
/** Tower positions along the lane (fraction of the map size, from the team's own edge): outer tower first. */
export const TOWER_X = [0.3, 0.42] as const;
/** Waypoints per lane (corridor columns, plaza edge to plaza edge). */
export const LANE_WAYPOINTS = 8;
/** Plaza extent across the lanes (fraction of the map size) and corner radius. */
const PLAZA_Y0 = 0.12;
const PLAZA_CORNER = 0.06;
/** Tiles at the map edge that stay blocked. */
const EDGE = 2;

export interface LanePoint {
  x: number;
  y: number;
}

/** Everything the lanes mode needs to know about the generated map (all positions are walkable tile centres). */
export interface LanesGeometry {
  /** Castle position per team (team 0 left, team 1 right). */
  castle: LanePoint[];
  /** Centre-line waypoints of each lane, west (team 0 plaza) to east (team 1 plaza), taken from the generated corridor. */
  lane: LanePoint[][];
  /** [team][lane]: where the team's soldiers appear (in front of its castle, towards the lane). */
  spawn: LanePoint[][];
  /** [team][lane][k]: tower positions, outermost (closest to the plaza) first. */
  tower: LanePoint[][][];
}

/** Shape parameters of the wavy lanes (from the seed). */
interface Shape {
  amp: number;
  lambda: number;
}

function shapeOf(n: number, r1: number, r2: number): Shape {
  return { amp: n * (0.01 + 0.01 * r1), lambda: n * (0.22 + 0.18 * r2) };
}

/** Lane centre line y at x. Lane 1 is straight; lanes 0 and 2 mirror each other and bulge symmetrically about the map centre. */
function laneCentre(n: number, sh: Shape, lane: number, x: number): number {
  const base = LANE_Y[lane] * n;
  if (lane === 1) return base;
  const px = PLAZA_X * n;
  const t = Math.min(1, Math.max(0, Math.min(x - px, n - px - x) / (0.1 * n)));
  const env = t * t * (3 - 2 * t);
  return base + (lane === 0 ? 1 : -1) * sh.amp * env * Math.cos(((x - n / 2) / sh.lambda) * Math.PI * 2);
}

function inPlaza(n: number, x: number, y: number): boolean {
  const dx = Math.min(x, n - x);
  if (dx < EDGE || dx > PLAZA_X * n) return false;
  const y0 = PLAZA_Y0 * n;
  const y1 = n - y0;
  if (y < y0 || y > y1) return false;
  // Rounded corners at the far (map edge) side.
  const r = PLAZA_CORNER * n;
  const cx = EDGE + r;
  if (dx < cx) {
    const cy = y < n / 2 ? y0 + r : y1 - r;
    if ((y < y0 + r || y > y1 - r) && Math.hypot(dx - cx, y - cy) > r) return false;
  }
  return true;
}

/** Lane (0..2) whose corridor contains the point, -1 for none. Plaza columns belong to no lane. */
function corridorAt(n: number, sh: Shape, x: number, y: number): number {
  if (x < EDGE || x > n - EDGE) return -1;
  for (let l = 0; l < LANE_COUNT; l++) if (Math.abs(y - laneCentre(n, sh, l, x)) <= LANE_HALF_W) return l;
  return -1;
}

/**
 * Builds the layout: walkable plazas and corridors, everything else blocked (forest wall with rocks), a dirt road along each lane, and
 * the lane map used by target picking. Uses the terrain's RNG for the corridor shape and the decor only.
 */
export function buildLanes(tr: Terrain): void {
  const n = tr.size;
  const rng = tr.rng;
  const sh = shapeOf(n, rng(), rng());
  const laneOf = new Int8Array(n * n).fill(-1);
  const px = PLAZA_X * n;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const i = ty * n + tx;
      const lane = corridorAt(n, sh, x, y);
      const plaza = inPlaza(n, x, y);
      if (!plaza && lane < 0) {
        tr.flags[i] = T_BLOCKED;
        continue;
      }
      tr.flags[i] = T_GRASS;
      if (!plaza && lane >= 0 && x >= px && x <= n - px) {
        laneOf[i] = lane;
        // Dirt road along the centre line.
        if (Math.abs(y - laneCentre(n, sh, lane, x)) <= 1) {
          tr.flags[i] = T_PATH;
          tr.pathTiles.push(i);
        }
      }
    }
  }
  tr.laneOf = laneOf;
  // Forest wall: trees (blocked tiles) thick near the corridors, sparse deeper in; a few rocks.
  const near = (tx: number, ty: number, r: number): boolean => {
    for (let y = Math.max(0, ty - r); y <= Math.min(n - 1, ty + r); y++) {
      for (let x = Math.max(0, tx - r); x <= Math.min(n - 1, tx + r); x++) if (tr.flags[y * n + x] !== T_BLOCKED) return true;
    }
    return false;
  };
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const i = ty * n + tx;
      if (tr.flags[i] !== T_BLOCKED) continue;
      const edge = near(tx, ty, 2);
      const p = edge ? 0.75 : 0.14;
      const u = rng();
      const v = rng();
      const jx = (rng() - 0.5) * 0.4;
      const jy = (rng() - 0.5) * 0.4;
      if (u < p) tr.decor.push({ kind: 'tree', variant: Math.floor(v * 3), x: tx + 0.5 + jx, y: ty + 0.5 + jy });
      else if (u < p + (edge ? 0.04 : 0.02)) tr.decor.push({ kind: v < 0.3 ? 'boulder' : 'rock', variant: Math.floor(v * 9) % 3, x: tx + 0.5 + jx, y: ty + 0.5 + jy });
    }
  }
  tr.laneShape = sh;
}

/** Centre of the walkable run of column tile `tx` that contains (or lies closest to) row `ty0`; null when the column has no walkable tile nearby. */
function runCentre(tr: Terrain, tx: number, ty0: number): number | null {
  const n = tr.size;
  const walk = (y: number): boolean => y >= 0 && y < n && tr.walkable(tx + 0.5, y + 0.5);
  let seed = -1;
  for (let d = 0; d <= Math.ceil(n * 0.1) && seed < 0; d++) {
    if (walk(ty0 + d)) seed = ty0 + d;
    else if (walk(ty0 - d)) seed = ty0 - d;
  }
  if (seed < 0) return null;
  let lo = seed;
  let hi = seed;
  while (walk(lo - 1)) lo--;
  while (walk(hi + 1)) hi++;
  return (lo + hi + 1) / 2;
}

/** Walkable point of a corridor column near the nominal row: x snapped to a tile centre, y the centre of the corridor run. */
function columnPoint(tr: Terrain, lane: number, xf: number): LanePoint {
  const sh = tr.laneShape as Shape;
  const n = tr.size;
  const tx = Math.min(n - 1, Math.max(0, Math.floor(xf)));
  const nominal = laneCentre(n, sh, lane, tx + 0.5);
  const y = runCentre(tr, tx, Math.floor(nominal));
  return { x: tx + 0.5, y: y ?? nominal };
}

function snap(tr: Terrain, x: number, y: number): LanePoint {
  const p = tr.nearestWalkable(x, y, 12, true);
  return p ? { x: p.x, y: p.y } : { x, y };
}

/**
 * Castle, lane waypoints, spawn points and tower spots, computed from the generated walkable corridors (never from assumptions).
 * Deterministic: a pure function of the finished terrain.
 */
export function computeLanesGeometry(tr: Terrain): LanesGeometry {
  const n = tr.size;
  const castle = [snap(tr, CASTLE_X * n, n / 2), snap(tr, n - CASTLE_X * n, n / 2)];
  const lane: LanePoint[][] = [];
  const x0 = PLAZA_X * n + 1.5;
  const x1 = n - PLAZA_X * n - 1.5;
  for (let l = 0; l < LANE_COUNT; l++) {
    const pts: LanePoint[] = [];
    for (let k = 0; k < LANE_WAYPOINTS; k++) pts.push(columnPoint(tr, l, x0 + ((x1 - x0) * k) / (LANE_WAYPOINTS - 1)));
    lane.push(pts);
  }
  const spawn: LanePoint[][] = [[], []];
  const tower: LanePoint[][][] = [[], []];
  for (let t = 0; t < 2; t++) {
    for (let l = 0; l < LANE_COUNT; l++) {
      const first = t === 0 ? lane[l][0] : lane[l][LANE_WAYPOINTS - 1];
      const c = castle[t];
      const len = Math.hypot(first.x - c.x, first.y - c.y) || 1;
      const reach = Math.min(4.5, len * 0.5);
      spawn[t].push(snap(tr, c.x + ((first.x - c.x) / len) * reach, c.y + ((first.y - c.y) / len) * reach));
      tower[t].push(TOWER_X.map((f) => columnPoint(tr, l, t === 0 ? f * n : n - f * n)));
    }
  }
  return { castle, lane, spawn, tower };
}

/** The same positions on an open map without terrain (tests with `env: false`): straight lanes at the nominal rows. */
export function openLanesGeometry(n: number): LanesGeometry {
  const castle = [{ x: CASTLE_X * n, y: n / 2 }, { x: n - CASTLE_X * n, y: n / 2 }];
  const x0 = PLAZA_X * n + 1.5;
  const x1 = n - PLAZA_X * n - 1.5;
  const lane: LanePoint[][] = LANE_Y.map((fy) => Array.from({ length: LANE_WAYPOINTS }, (_, k) => ({ x: x0 + ((x1 - x0) * k) / (LANE_WAYPOINTS - 1), y: fy * n })));
  const spawn: LanePoint[][] = [[], []];
  const tower: LanePoint[][][] = [[], []];
  for (let t = 0; t < 2; t++) {
    for (let l = 0; l < LANE_COUNT; l++) {
      const first = t === 0 ? lane[l][0] : lane[l][LANE_WAYPOINTS - 1];
      const c = castle[t];
      const len = Math.hypot(first.x - c.x, first.y - c.y) || 1;
      const reach = Math.min(4.5, len * 0.5);
      spawn[t].push({ x: c.x + ((first.x - c.x) / len) * reach, y: c.y + ((first.y - c.y) / len) * reach });
      tower[t].push(TOWER_X.map((f) => ({ x: t === 0 ? f * n : n - f * n, y: LANE_Y[l] * n })));
    }
  }
  return { castle, lane, spawn, tower };
}
