import { T_GRASS, T_WATER, T_BRIDGE, T_BLOCKED, MAX_LEVEL_H, H_UNITS, CLIFF_UNITS } from './terrainTypes';
import { noise } from './terrainNoise';
import { placeForest, placeVillages, mirror } from './terrainDecor';
import type { Terrain } from './terrain';

// Terrain: the three layouts built for the game modes ('arena', 'forts', 'plateau'). Like 'lanes' they are an additive branch at the top
// of the Terrain constructor (no river, no random relief); villages and forests of the recipe are still placed around the structures.
// Every layout is point-symmetric about the map centre (fair to both sides): everything is built for the d < 0 half in the river frame
// (team 0's side; the teams stand on the +-u axis) and mirrored, or derived from symmetric hashes after the mirror.

/** The layouts handled here. */
export function isModeLayout(layout: string): boolean {
  return layout === 'arena' || layout === 'forts' || layout === 'plateau';
}

/** Tiles at the centre line (d = 0) that stay clear of random structures: the open lane between the two sides. */
const AXIS_CLEAR = 0.8;

/** Fort layout numbers (fractions of the map size), exported for tests and docs. Fort 0 is on team 0's side (d < 0), fort 1 its point mirror. */
export function fortGeometry(n: number): { fx0: number; fy0: number; fx1: number; fy1: number; half: number; gate: number } {
  const c = n / 2;
  const k = 0.19 * n;
  return { fx0: c - k, fy0: c + k, fx1: c + k, fy1: c - k, half: Math.max(3.5, 0.105 * n), gate: Math.max(3, Math.round(0.07 * n)) };
}

/** Arena radius (tiles): the open ground is a disc of this radius, the corners of the square map are forest wall. */
export function arenaRadius(n: number): number {
  return n / 2 - 1.5;
}

/** Plateau radius (tiles), top height (elevation steps) and the number of ramps. */
export function plateauRadius(n: number): number {
  return n * 0.2;
}
export const PLATEAU_RAMPS = 4;
const PLATEAU_STEPS = 5.6;

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Hash of a tile index to [0, 1) (the same for a tile and its mirror when fed the smaller index). */
function hash01(i: number, salt: number): number {
  let h = Math.imul(i + 0x9e3779b9 + salt * 0x632be5ab, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Blocks a grass tile of the d < 0 half with a decor piece. The centre line is kept free. False when the tile is not usable. */
function put(tr: Terrain, tx: number, ty: number, kind: 'wall' | 'boulder' | 'tree', variant: number, respectOcc = false): boolean {
  const n = tr.size;
  if (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1) return false;
  const i = ty * n + tx;
  if (tr.flags[i] !== T_GRASS || (respectOcc && tr.occ[i])) return false;
  const x = tx + 0.5;
  const y = ty + 0.5;
  if (tr.toD(x, y) > -AXIS_CLEAR || tr.reserved(x, y, 1)) return false;
  tr.flags[i] = T_BLOCKED;
  tr.occ[i] = 1;
  tr.decor.push({ kind, variant, x, y });
  return true;
}

/** Is every tile of the footprint plain grass of the d < 0 half (no structure, not reserved). */
function footprintFree(tr: Terrain, cx: number, cy: number, rx: number, ry: number): boolean {
  const n = tr.size;
  for (let ty = Math.floor(cy - ry) - 1; ty <= Math.ceil(cy + ry) + 1; ty++) {
    for (let tx = Math.floor(cx - rx) - 1; tx <= Math.ceil(cx + rx) + 1; tx++) {
      if (tx < 2 || ty < 2 || tx >= n - 2 || ty >= n - 2) return false;
      const i = ty * n + tx;
      if (tr.flags[i] !== T_GRASS || tr.occ[i]) return false;
      const x = tx + 0.5;
      const y = ty + 0.5;
      if (tr.toD(x, y) > -AXIS_CLEAR - 2 || tr.reserved(x, y, 2)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- arena

/** Open round arena: a disc of open ground, forest wall in the corners, scattered pillar clusters, a few ponds with small bridges. */
function buildArena(tr: Terrain): void {
  const n = tr.size;
  const c = n / 2;
  const rng = tr.rng;
  const rA = arenaRadius(n);
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      if (Math.hypot(tx + 0.5 - c, ty + 0.5 - c) > rA) tr.flags[ty * n + tx] = T_BLOCKED;
    }
  }
  // Ponds (one bridge across the narrow part of each): half only, the mirror makes the pair.
  const ponds = n >= 160 ? 3 : n >= 90 ? 2 : 1;
  const placed: Array<{ x: number; y: number; r: number }> = [];
  for (let k = 0; k < ponds; k++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ang = rng() * Math.PI * 2;
      const rad = n * (0.2 + 0.14 * rng());
      const alongX = rng() < 0.5;
      const px = Math.floor(c + Math.cos(ang) * rad) + 0.5;
      const py = Math.floor(c + Math.sin(ang) * rad) + 0.5;
      const A = n * 0.045 + 1.6;
      const B = n * 0.024 + 1;
      const rx = alongX ? A : B;
      const ry = alongX ? B : A;
      // Inside the disc, and clear of the open centre.
      const away = Math.hypot(px - c, py - c);
      if (away + A > rA - 2 || away - A < n * 0.16) continue;
      if (placed.some((q) => Math.hypot(q.x - px, q.y - py) < q.r + A + 5)) continue;
      if (!footprintFree(tr, px, py, rx, ry)) continue;
      for (let ty = Math.floor(py - ry); ty <= Math.ceil(py + ry); ty++) {
        for (let tx = Math.floor(px - rx); tx <= Math.ceil(px + rx); tx++) {
          const dx = tx + 0.5 - px;
          const dy = ty + 0.5 - py;
          if ((dx / rx) ** 2 + (dy / ry) ** 2 >= 1) continue;
          // The bridge runs across the short axis through the middle of the pond (2 tiles wide).
          const along = alongX ? dx : dy;
          tr.flags[ty * n + tx] = Math.abs(along) <= 1 ? T_BRIDGE : T_WATER;
          tr.occ[ty * n + tx] = 1;
        }
      }
      for (let ty = Math.floor(py - ry) - 2; ty <= Math.ceil(py + ry) + 2; ty++) for (let tx = Math.floor(px - rx) - 2; tx <= Math.ceil(px + rx) + 2; tx++) tr.occ[ty * n + tx] = 1;
      placed.push({ x: px, y: py, r: A });
      break;
    }
  }
  // The centre stays open: no pillars, trees or houses there.
  for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) if (Math.hypot(tx + 0.5 - c, ty + 0.5 - c) < n * 0.15) tr.occ[ty * n + tx] = 1;
  // Pillar clusters: 2-4 blocked tiles each, away from the open centre.
  const clusters = Math.max(4, Math.round((n * n) / 520));
  const centres: Array<{ x: number; y: number }> = [];
  const offs: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1]];
  for (let k = 0; k < clusters; k++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ang = rng() * Math.PI * 2;
      const rad = n * 0.16 + rng() * (rA - 3 - n * 0.16);
      const x = Math.floor(c + Math.cos(ang) * rad);
      const y = Math.floor(c + Math.sin(ang) * rad);
      if (centres.some((q) => Math.hypot(q.x - x, q.y - y) < Math.max(5, n * 0.09))) continue;
      if (!put(tr, x, y, rng() < 0.6 ? 'wall' : 'boulder', Math.floor(rng() * 2), true)) continue;
      centres.push({ x, y });
      const extra = 1 + Math.floor(rng() * 3);
      for (let e = 0; e < extra; e++) {
        const [ox, oy] = offs[Math.floor(rng() * offs.length)];
        put(tr, x + ox, y + oy, rng() < 0.6 ? 'wall' : 'boulder', Math.floor(rng() * 2), true);
      }
      break;
    }
  }
}

/** Arena, after the mirror: forest wall dressing outside the disc (hash based, so a tile and its mirror agree) and the pond lists for drawing. */
function dressArena(tr: Terrain): void {
  const n = tr.size;
  const c = n / 2;
  const rA = arenaRadius(n);
  for (let i = 0; i < n * n; i++) {
    const m = n * n - 1 - i;
    if (i > m) continue;
    const tx = i % n;
    const ty = (i / n) | 0;
    const dist = Math.hypot(tx + 0.5 - c, ty + 0.5 - c);
    if (dist <= rA) continue;
    const edge = dist < rA + 3.5;
    const u = hash01(i, 1);
    const kind = u < (edge ? 0.78 : 0.34) ? 'tree' : u < (edge ? 0.88 : 0.4) ? 'rock' : null;
    if (!kind) continue;
    const variant = Math.floor(hash01(i, 2) * 3);
    const jx = (hash01(i, 3) - 0.5) * 0.4;
    const jy = (hash01(i, 4) - 0.5) * 0.4;
    tr.decor.push({ kind, variant, x: tx + 0.5 + jx, y: ty + 0.5 + jy });
    if (m !== i) tr.decor.push({ kind, variant, x: (m % n) + 0.5 - jx, y: ((m / n) | 0) + 0.5 - jy });
  }
  for (let i = 0; i < n * n; i++) {
    if (tr.flags[i] === T_WATER) tr.crossWaterTiles.push(i);
    else if (tr.flags[i] === T_BRIDGE) tr.crossBridgeTiles.push(i);
  }
}

// ---------------------------------------------------------------- forts

/**
 * Two walled strongholds at opposite ends of the army axis. Fort 0 (team 0's side) is a square ring wall one tile thick with a gate in
 * each of the two walls that face the field, corner and gate towers (decor 'tower'); fort 1 is its point mirror. Cover (ruin
 * segments) is scattered in the field. Returns the tower tiles of fort 0 (their decor is placed after the mirror, see `placeTowers`).
 */
function buildForts(tr: Terrain): number[] {
  const n = tr.size;
  const rng = tr.rng;
  const { fx0: fx, fy0: fy, half: H, gate: G } = fortGeometry(n);
  const lo = H - 0.5;
  const hi = H + 0.5;
  const reach = 0.16 * n;
  const towers: number[] = [];
  for (let ty = 1; ty < n - 1; ty++) {
    for (let tx = 1; tx < n - 1; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const ax = Math.abs(x - fx);
      const ay = Math.abs(y - fy);
      const m = Math.max(ax, ay);
      const i = ty * n + tx;
      // Keep-out for random structures: the whole fort and the approach in front of both gates.
      if (m < H + 3) tr.occ[i] = 1;
      if (x > fx + H && ay < G / 2 + 2 && x < fx + H + reach) tr.occ[i] = 1;
      if (y < fy - H && ax < G / 2 + 2 && y > fy - H - reach) tr.occ[i] = 1;
      if (m < lo || m >= hi) continue;
      const east = x - fx > 0 && ax >= ay;
      const north = y - fy < 0 && ay > ax;
      if ((east && ay < G / 2) || (north && ax < G / 2)) continue; // gate
      const corner = ax >= lo && ay >= lo;
      const gateTower = (east && ay >= G / 2 && ay < G / 2 + 1) || (north && ax >= G / 2 && ax < G / 2 + 1);
      if (!put(tr, tx, ty, 'wall', (tx + ty) & 1)) continue;
      if (corner || gateTower) {
        // A tower instead of a wall piece: drop the wall decor just pushed and remember the tile.
        tr.decor.pop();
        towers.push(i);
      }
    }
  }
  // Cover in the field: short ruined wall segments.
  const segments = Math.max(4, Math.round(n / 10));
  for (let k = 0; k < segments; k++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = 4 + Math.floor(rng() * (n - 8));
      const y = 4 + Math.floor(rng() * (n - 8));
      const len = 3 + Math.floor(rng() * 2);
      const horiz = rng() < 0.5;
      let ok = true;
      for (let q = 0; q < len && ok; q++) {
        const tx = horiz ? x + q : x;
        const ty = horiz ? y : y + q;
        const i = ty * n + tx;
        ok = tr.flags[i] === T_GRASS && !tr.occ[i] && tr.toD(tx + 0.5, ty + 0.5) < -4 && Math.hypot(tx + 0.5 - n / 2, ty + 0.5 - n / 2) > n * 0.07;
      }
      if (!ok) continue;
      for (let q = 0; q < len; q++) {
        const tx = horiz ? x + q : x;
        const ty = horiz ? y : y + q;
        // A gap in the middle of long segments keeps them from reading as a wall.
        if (len === 4 && q === 2) tr.decor.push({ kind: 'rubble', variant: q & 1, x: tx + 0.5, y: ty + 0.5 });
        else put(tr, tx, ty, 'wall', (tx + ty) & 1);
      }
      break;
    }
  }
  return towers;
}

/** Tower decor for the fort tiles and their point mirrors (after the mirror: the tile flags are already blocked on both sides). */
function placeTowers(tr: Terrain, towers: number[]): void {
  const n = tr.size;
  for (const i of towers) {
    for (const t of [i, n * n - 1 - i]) tr.decor.push({ kind: 'tower', variant: 0, x: (t % n) + 1, y: ((t / n) | 0) + 1 });
  }
}

// ---------------------------------------------------------------- plateau

/** Plateau: a raised disc in the middle with four ramps (towards both armies and both flanks), a flat ring around it, boulder cover on top. */
function buildPlateau(tr: Terrain): void {
  const n = tr.size;
  const c = n / 2;
  const rp = plateauRadius(n);
  const seed = tr.opts.seed + 101;
  const a0 = -Math.PI / 4; // the +u direction (towards team 1)
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const d = tr.toD(x, y);
      if (d > 1e-9) continue; // the d <= 0 half, mirrored below
      const dist = Math.hypot(x - c, y - c);
      const ramp = Math.pow(Math.max(0, Math.cos(PLATEAU_RAMPS * (Math.atan2(y - c, x - c) - a0))), 1.5);
      const w = 0.9 + 7 * ramp;
      let H = PLATEAU_STEPS * smooth(0, 1, (rp - dist) / w + 0.5) + 0.3 * noise(x / 5, y / 5, seed + 2);
      H *= smooth(0, 3, Math.min(tx, ty, n - 1 - tx, n - 1 - ty));
      if (tr.reserved(x, y, 2)) H = 0;
      tr.height[ty * n + tx] = Math.min(MAX_LEVEL_H * H_UNITS, Math.max(0, Math.round(H * H_UNITS)));
    }
  }
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const d = tr.toD(tx + 0.5, ty + 0.5);
      if (d > 1e-9 || (d >= -1e-9 && ty * n + tx > (n - 1 - ty) * n + (n - 1 - tx))) continue;
      tr.height[(n - 1 - ty) * n + (n - 1 - tx)] = tr.height[ty * n + tx];
    }
  }
  // Cliff: a walkable tile at least CLIFF_UNITS higher than a neighbour is impassable (same rule as `buildRelief`).
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const i = ty * n + tx;
      if (tr.flags[i] !== T_GRASS) continue;
      const h = tr.height[i];
      let cliff = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx >= 0 && ny >= 0 && nx < n && ny < n && h - tr.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
      }
      if (cliff) {
        tr.flags[i] = T_BLOCKED;
        tr.cliffTiles.push(i);
      }
    }
  }
  // The ring around the plateau stays free of random structures; boulder cover sits on top between the ramps.
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      if (Math.hypot(tx + 0.5 - c, ty + 0.5 - c) < rp * 1.3 + 1) tr.occ[ty * n + tx] = 1;
    }
  }
  for (let k = 0; k < PLATEAU_RAMPS; k++) {
    const a = a0 + Math.PI / PLATEAU_RAMPS + (k * Math.PI * 2) / PLATEAU_RAMPS;
    const bx = Math.floor(c + Math.cos(a) * rp * 0.5);
    const by = Math.floor(c + Math.sin(a) * rp * 0.5);
    if (put(tr, bx, by, 'boulder', k % 3)) put(tr, bx + (k & 1 ? 1 : 0), by + (k & 1 ? 0 : 1), 'boulder', (k + 1) % 3);
  }
}

// ---------------------------------------------------------------- entry

/**
 * Builds a mode layout into `tr` (flags, heights, decor); the caller then computes regions and fixes pockets. Deterministic: uses the
 * terrain's RNG and symmetric hashes only.
 */
export function buildModeMap(tr: Terrain): void {
  let towers: number[] = [];
  if (tr.layout === 'arena') buildArena(tr);
  else if (tr.layout === 'forts') towers = buildForts(tr);
  else buildPlateau(tr);
  placeVillages(tr);
  placeForest(tr);
  mirror(tr);
  if (tr.layout === 'arena') dressArena(tr);
  else if (tr.layout === 'forts') placeTowers(tr, towers);
}
