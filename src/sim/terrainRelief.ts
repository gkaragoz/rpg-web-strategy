import { T_GRASS, T_WATER, T_BRIDGE, T_BLOCKED, MAX_LEVEL_H, H_UNITS, CLIFF_UNITS, type DecorKind } from './terrainTypes';
import { noise } from './terrainNoise';
import type { Terrain } from './terrain';

// Terrain: elevation (hills, plateaus, valleys), connected regions and the ramps that open closed-in ground.

/** Closed-in ground of fewer tiles is simply sealed; larger areas get a ramp (see fixPockets). */
const POCKET_MIN_TILES = 12;
const RAMP_MAX_TILES = 6;
/** Ramp search: crossings tried, tiles a slope may be extended into the higher side, height units per step of a slope. */
const RAMP_TRIES = 24;
const RAMP_EXTEND = 14;
const RAMP_STEP = 20;

/** Splits walkable tiles into connected components (8-neighborhood, no corner cutting). */
export function computeRegions(tr: Terrain): void {
  const n = tr.size;
  const region = new Int32Array(n * n).fill(-1);
  const sizes: number[] = [];
  const walk = (x: number, y: number) => x >= 0 && y >= 0 && x < n && y < n && tr.walkable(x + 0.5, y + 0.5);
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
  tr.region = region;
  tr.mainRegion = sizes.length ? sizes.indexOf(Math.max(...sizes)) : -1;
}

/**
 * No walkable ground may be unreachable (a plateau or valley closed in by cliffs, an island): such places are useless for
 * players and look like bugs. Every closed-in area of a useful size gets a short ramp through the cliff or obstacle ring
 * (the heights are smoothed along it); whatever cannot be connected within a few tiles is sealed as an obstacle. Every change is
 * applied to the point-mirrored tile as well, so the map stays fair.
 */
export function fixPockets(tr: Terrain): void {
  const n = tr.size;
  for (let pass = 0; pass < 4; pass++) {
    const sizes = new Map<number, number>();
    for (let i = 0; i < tr.region.length; i++) if (tr.region[i] >= 0) sizes.set(tr.region[i], (sizes.get(tr.region[i]) ?? 0) + 1);
    const pockets = [...sizes.keys()].filter((r) => r !== tr.mainRegion).sort((a, b) => a - b);
    if (!pockets.length) break;
    let changed = false;
    for (const r of pockets) {
      if ((sizes.get(r) ?? 0) < POCKET_MIN_TILES) continue; // tiny nooks are sealed below
      // Earlier ramps of this pass may already have joined it to the main area: skip if so.
      const first = tr.region.indexOf(r);
      if (first < 0 || tr.region[first] !== r) continue;
      if (carveRamp(tr, r)) changed = true;
    }
    if (!changed) break;
    computeRegions(tr);
  }
  // Seal what is left.
  tr.sealedMark = new Uint8Array(n * n);
  let sealed = false;
  for (let i = 0; i < n * n; i++) {
    if (tr.region[i] >= 0 && tr.region[i] !== tr.mainRegion) {
      tr.flags[i] = T_BLOCKED;
      tr.sealedMark[i] = 1;
      tr.fixInfo.sealed++;
      sealed = true;
    }
  }
  if (sealed) {
    computeRegions(tr);
    dressSealed(tr);
  }
  finishRelief(tr);
}

/** Rocks on the ground that had to be sealed, so it reads as impassable rock and not as ground one could walk on. Point-symmetric. */
export function dressSealed(tr: Terrain): void {
  const n = tr.size;
  const mirror = (i: number): number => n * n - 1 - i;
  for (let i = 0; i < n * n; i++) {
    const m = mirror(i);
    if (i > m || tr.flags[i] !== T_BLOCKED || tr.sealedMark[i] === 0) continue;
    // The same decision for a tile and its mirror (hash of the smaller index).
    let h = Math.imul(i + 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 13;
    const u = (h >>> 0) / 4294967296;
    if (u > 0.55) continue;
    const kind: DecorKind = u < 0.12 ? 'boulder' : 'rock';
    const variant = Math.floor(u * 100) % 3;
    for (const t of i === m ? [i] : [i, m]) {
      const tx = t % n;
      const ty = (t / n) | 0;
      tr.decor.push({ kind, variant, x: tx + 0.5, y: ty + 0.5 });
    }
  }
}

/**
 * Opens a ramp from the closed-in region `r` to the main area: through the ring of obstacle (cliff) tiles, and, because a
 * cliff is a height step of CLIFF_UNITS or more, down a gradual slope cut into the higher side (the tiles beside the cut
 * that end up too high become cliffs, like the walls of a cutting). Tries the shortest crossings first; false if none fits.
 */
export function carveRamp(tr: Terrain, r: number): boolean {
  const n = tr.size;
  const parent = new Int32Array(n * n).fill(-2);
  const queue: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (tr.region[i] === r) {
      parent[i] = -1;
      queue.push(i);
    }
  }
  const dirs = [1, -1, n, -n];
  const depth = new Uint8Array(n * n);
  const crossings: Array<[number, number]> = [];
  for (let q = 0; q < queue.length && crossings.length < RAMP_TRIES; q++) {
    const cur = queue[q];
    const cx = cur % n;
    for (const d of dirs) {
      const nx = cx + (d === 1 ? 1 : d === -1 ? -1 : 0);
      const ni = cur + d;
      if (nx < 1 || nx >= n - 1 || ni < n || ni >= n * (n - 1)) continue;
      if (tr.region[ni] === tr.mainRegion && parent[cur] !== -1) {
        crossings.push([cur, ni]);
        continue;
      }
      if (parent[ni] !== -2 || tr.flags[ni] !== T_BLOCKED || depth[cur] >= RAMP_MAX_TILES) continue;
      parent[ni] = cur;
      depth[ni] = depth[cur] + 1;
      queue.push(ni);
    }
  }
  for (const [last, exit] of crossings) {
    const rim: number[] = [];
    for (let p = last; parent[p] !== -1; p = parent[p]) rim.push(p);
    rim.reverse();
    const plan = planRamp(tr, rim, parent[rim[0]], exit);
    if (!plan) continue;
    tr.fixInfo.ramps++;
    plan.chain.forEach((tile, k) => openTile(tr, tile, plan.heights[k]));
    recutCliffs(tr, plan.chain);
    return true;
  }
  return false;
}

/**
 * The chain of tiles of a ramp (high end first) and their heights: the rim tiles between `entry` (pocket side) and `exit`
 * (main side), plus as many walkable tiles of the higher side as the slope needs (steps of at most 20 height units). Null when
 * the slope does not fit (not enough room on the higher side, or a step toward a neighbour would be a cliff).
 */
export function planRamp(tr: Terrain, rim: number[], entry: number, exit: number): { chain: number[]; heights: number[] } | null {
  const n = tr.size;
  const hEntry = tr.height[entry];
  const hExit = tr.height[exit];
  const entryHigh = hEntry >= hExit;
  // Inward direction of the higher side, away from the rim.
  const dir = entryHigh ? entry - rim[0] : exit - rim[rim.length - 1];
  const base = entryHigh ? [entry, ...rim, exit] : [entry, ...rim, exit].reverse(); // high end ... low end
  const drop = Math.abs(hEntry - hExit);
  const ext: number[] = [];
  let tile = base[0];
  for (let e = 0; e <= RAMP_EXTEND; e++) {
    const chain = [...ext.slice().reverse(), ...base];
    const steps = chain.length - 1;
    if (steps * RAMP_STEP >= drop) {
      const top = tr.height[chain[0]];
      const bottom = tr.height[chain[chain.length - 1]];
      const heights = chain.map((_, k) => Math.round(top + ((bottom - top) * k) / steps));
      // Inner tiles are rewritten; the two ends keep their height.
      if (rampOk(tr, chain, heights)) return { chain: chain.slice(1, -1), heights: heights.slice(1, -1) };
    }
    const next = tile - dir;
    const col = tile % n;
    if (next < 0 || next >= n * n || (dir === 1 && col === 0) || (dir === -1 && col === n - 1)) return null;
    // Keep going into the higher side only through ordinary walkable ground of that side.
    if (tr.flags[next] !== T_GRASS) return null;
    ext.push(next);
    tile = next;
  }
  return null;
}

/** No step along the chain, and none between a chain tile and a walkable tile beside it that is not plain grass, may reach the cliff threshold. */
export function rampOk(tr: Terrain, chain: number[], heights: number[]): boolean {
  const n = tr.size;
  const limit = CLIFF_UNITS - 1;
  for (let k = 1; k < heights.length; k++) if (Math.abs(heights[k] - heights[k - 1]) > limit) return false;
  const on = new Map<number, number>();
  chain.forEach((c, k) => on.set(c, heights[k]));
  for (let k = 0; k < chain.length; k++) {
    for (const d of [1, -1, n, -n]) {
      const j = chain[k] + d;
      if (j < 0 || j >= n * n || (d === 1 && j % n === 0) || (d === -1 && j % n === n - 1)) continue;
      const hj = on.get(j) ?? tr.height[j];
      if (on.has(j) || !tr.walkable((j % n) + 0.5, ((j / n) | 0) + 0.5)) continue;
      const lower = heights[k] - hj; // how much higher the chain tile is than the neighbour
      if (lower >= CLIFF_UNITS) return false; // the chain tile would become a cliff
      if (-lower >= CLIFF_UNITS && tr.flags[j] !== T_GRASS) return false; // a non-grass neighbour cannot be turned into a cliff
    }
  }
  return true;
}

/** After a ramp: the tiles beside it that are now a cliff step higher than a neighbour become obstacles (as at generation). */
export function recutCliffs(tr: Terrain, chain: number[]): void {
  const n = tr.size;
  const protectedTiles = new Set<number>();
  for (const c of chain) {
    protectedTiles.add(c);
    protectedTiles.add(n * n - 1 - c);
  }
  const near = new Set<number>();
  for (const c of protectedTiles) {
    const cx = c % n;
    const cy = (c / n) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n && !protectedTiles.has(y * n + x)) near.add(y * n + x);
      }
    }
  }
  for (const i of near) {
    if (tr.flags[i] !== T_GRASS) continue;
    const tx = i % n;
    const ty = (i / n) | 0;
    let cliff = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && tr.height[i] - tr.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
    }
    if (cliff) tr.flags[i] = T_BLOCKED;
  }
}

/** Makes tile i (and its point mirror) walkable ground at the given height, without decor. */
export function openTile(tr: Terrain, i: number, h: number): void {
  const n = tr.size;
  for (const t of [i, n * n - 1 - i]) {
    tr.flags[t] = T_GRASS;
    tr.height[t] = h;
    tr.occ[t] = 0;
    const tx = t % n;
    const ty = (t / n) | 0;
    const keep = tr.decor.filter((d) => Math.floor(d.x) !== tx || Math.floor(d.y) !== ty);
    tr.decor.length = 0;
    for (const d of keep) tr.decor.push(d);
  }
}

/** Elevation generation: continuous field by relief type -> steps; flattened near the border, river and spawns. */
export function buildRelief(tr: Terrain): void {
  const rl = tr.reliefKind;
  if (rl === 'flat') return;
  const amp = tr.layout === 'archipelago' ? 0.7 : tr.layout === 'crossroads' ? 0.8 : 1;
  const n = tr.size;
  const c = n / 2;
  const seed = tr.opts.seed + 101;
  const hasRiver = tr.riverKind !== 'none';
  const smooth = (a: number, b: number, v: number): number => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const radial = rl === 'plateau' || rl === 'peak';
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const d = tr.toD(x, y);
      if (d > 1e-9) continue; // only the d <= 0 half is generated, then mirrored
      const s = tr.toS(x, y);
      const ad = Math.abs(d);
      const dist = Math.hypot(x - c, y - c);
      let H = 0;
      if (rl === 'hills') {
        H = 15 * amp * (0.65 * noise(x / 13, y / 13, seed) + 0.35 * noise(x / 6, y / 6, seed + 5) - 0.36);
      } else if (rl === 'valley') {
        // Two high ridges parallel to the middle axis; only one pass (gate) is open near s ~ 0.
        const R = n * 0.17;
        const hw = n * 0.05 * (1 - 0.97 * Math.exp(-((s / (n * 0.075)) ** 2)));
        // The gate is a flat corridor: the ridge profile alone never drops to zero on its centre line (a thin wall stayed
        // there and the armies walked around the map edge on big maps), so the ridge is cut out explicitly.
        const gate = Math.max(4.5, n * 0.055);
        const open = smooth(gate * 0.55, gate, Math.abs(s));
        H = 7 * smooth(0, 1, (hw - Math.abs(ad - R)) / 0.9 + 0.5) * open + 0.5 * noise(x / 6, y / 6, seed + 4);
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
        const top = tr.layout === 'citadel' && dist < r * 0.85 ? 0 : 0.3;
        H = 5.6 * smooth(0, 1, (r - dist) / w + 0.5) + top * noise(x / 5, y / 5, seed + 2);
      } else {
        const R = n * 0.23;
        H = 8.2 * Math.pow(Math.max(0, 1 - dist / R), 1.0) + 1.6 * Math.abs(noise(x / 4.5, y / 4.5, seed + 9) - 0.5) * 2 * smooth(0, 5, R - dist);
      }
      if (!radial) H *= smooth(1.5, 5, ad); // river/middle axis valley
      if (hasRiver && !radial) H *= smooth(2.5, 6, tr.riverEdgeDist(x, y));
      else if (hasRiver) H *= smooth(0, 2.5, tr.riverEdgeDist(x, y));
      // Bridges and approach paths stay flat (ramps/cliffs must not cut the bridge).
      for (const br of tr.bridges) {
        const bd = Math.max(Math.abs(s - br.s) / 4.5, Math.abs(d - br.o) / (br.halfLen + 6));
        if (bd < 1) H *= smooth(0.55, 1, bd);
      }
      H *= smooth(0, 3, Math.min(tx, ty, n - 1 - tx, n - 1 - ty)); // map edge is flat
      if (tr.reserved(x, y, 2)) H = 0;
      const f = tr.flags[ty * n + tx];
      if (f === T_WATER || f === T_BRIDGE) H = 0;
      tr.height[ty * n + tx] = Math.min(MAX_LEVEL_H * H_UNITS, Math.max(0, Math.round(H * H_UNITS)));
    }
  }
  // Point symmetry.
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const d = tr.toD(tx + 0.5, ty + 0.5);
      if (d > 1e-9 || (d >= -1e-9 && ty * n + tx > (n - 1 - ty) * n + (n - 1 - tx))) continue;
      tr.height[(n - 1 - ty) * n + (n - 1 - tx)] = tr.height[ty * n + tx];
    }
  }
  // Cliff: a walkable tile >= 2 steps higher than its neighbor is impassable.
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const i = ty * n + tx;
      if (tr.flags[i] !== T_GRASS) continue;
      const h = tr.height[i];
      let cliff = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        if (h - tr.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
      }
      if (cliff) {
        tr.flags[i] = T_BLOCKED;
        tr.cliffTiles.push(i);
      }
    }
  }
}

/** After elevation is done: corner elevations and the relief flag. */
export function finishRelief(tr: Terrain): void {
  const n = tr.size;
  let any = false;
  for (let i = 0; i < tr.height.length; i++) if (tr.height[i] > 0) any = true;
  tr.hasRelief = any;
  let mh = 0;
  for (let i = 0; i < tr.height.length; i++) if (tr.height[i] > mh) mh = tr.height[i];
  tr.maxH = mh / H_UNITS;
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
          sum += tr.height[ty * n + tx];
          cnt++;
        }
      }
      tr.vh[vy * w + vx] = sum / Math.max(1, cnt) / H_UNITS;
    }
  }
  // Keep the cliff tiles as a list for drawing (decor/house placement already treats them as obstacles).
  tr.cliffTiles.length = 0;
  for (let i = 0; i < tr.flags.length; i++) {
    if (tr.flags[i] !== T_BLOCKED) continue;
    const tx = i % n;
    const ty = (i / n) | 0;
    const h = tr.height[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && h - tr.height[ny * n + nx] >= CLIFF_UNITS) {
        tr.cliffTiles.push(i);
        break;
      }
    }
  }
}
