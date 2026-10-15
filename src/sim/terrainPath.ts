import { PATH_SLOPE_COST, PATH_SMOOTH_MAX_GRADE, PATH_STEEP_COST, PATH_STEEP_FROM } from './data/combat';
import { T_WATER, T_BLOCKED, H_UNITS } from './terrainTypes';
import type { Terrain } from './terrain';

// Terrain: walking queries on the tile grid: straight-line checks and A* path search (see Terrain.findPath).

/** Scratch buffers of the path search (allocated on first use; the terrain owns one instance). */
export class PathScratch {
  g: Float32Array | null = null;
  parent: Int32Array | null = null;
  stamp: Int32Array | null = null;
  closed: Int32Array | null = null;
  gen = 0;
  heapNode = new Int32Array(4096);
  heapF = new Float64Array(4096);
  nav: Uint8Array | null = null;
}

/** 1 per walkable tile (built once; the terrain never changes during a battle). */
export function navMask(tr: Terrain): Uint8Array {
  if (!tr.pathScratch.nav) {
    const nav = new Uint8Array(tr.size * tr.size);
    for (let i = 0; i < nav.length; i++) nav[i] = tr.flags[i] !== T_WATER && tr.flags[i] !== T_BLOCKED ? 1 : 0;
    tr.pathScratch.nav = nav;
  }
  return tr.pathScratch.nav;
}

/** Are all samples along the line (x0,y0)-(x1,y1) walkable (with a unit-radius margin). */
export function lineWalkable(tr: Terrain, x0: number, y0: number, x1: number, y1: number): boolean {
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
    if (!tr.stepOk(Math.fround(px), Math.fround(py), Math.fround(x), Math.fround(y))) return false;
    px = x;
    py = y;
    // Also check side neighbors so units do not scrape along edges (about the unit radius)
    const nx = -dy / (len || 1);
    const ny = dx / (len || 1);
    if (!tr.walkable(x + nx * 0.2, y + ny * 0.2) || !tr.walkable(x - nx * 0.2, y - ny * 0.2)) return false;
  }
  return true;
}

/**
 * A* on the tile grid (8 neighbors, no corner cutting) plus path smoothing by direct line of sight.
 * Returns [x0,y0,x1,y1,...] waypoints (excluding the start); null if there is no path; [] if already there.
 */
export function findPath(tr: Terrain, sx: number, sy: number, gx: number, gy: number, maxNodes = 0): number[] | null {
  const n = tr.size;
  const total = n * n;
  // Each tile is expanded at most once (closed set): `total` expansions suffice even if the whole map is scanned.
  if (maxNodes <= 0) maxNodes = Math.max(8000, total + 64);
  if (!tr.pathScratch.g) {
    tr.pathScratch.g = new Float32Array(total);
    tr.pathScratch.parent = new Int32Array(total);
    tr.pathScratch.stamp = new Int32Array(total);
    tr.pathScratch.closed = new Int32Array(total);
  }
  const C = tr.pathScratch.closed!;
  const G = tr.pathScratch.g;
  const P = tr.pathScratch.parent!;
  const S = tr.pathScratch.stamp!;
  const gen = ++tr.pathScratch.gen;
  let goal = { x: gx, y: gy };
  if (!tr.walkable(gx, gy)) {
    const q = tr.nearestWalkable(gx, gy, 4);
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
  const nav = navMask(tr);
  let hn = tr.pathScratch.heapNode;
  let hf = tr.pathScratch.heapF;
  let hs = 0;
  const push = (node: number, f: number): void => {
    if (hs === hn.length) {
      const nn = new Int32Array(hn.length * 2);
      nn.set(hn);
      const nf = new Float64Array(hf.length * 2);
      nf.set(hf);
      hn = tr.pathScratch.heapNode = nn;
      hf = tr.pathScratch.heapF = nf;
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
  const relief = tr.hasRelief;
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
        const dh = relief ? (tr.height[idx] - tr.height[cur]) / H_UNITS : 0;
        const climb = dh > 0 ? dh : 0;
        const steep = Math.abs(dh) > PATH_STEEP_FROM ? Math.abs(dh) - PATH_STEEP_FROM : 0;
        const ng = G[cur] + (dx && dy ? 1.414 : 1) * (1 + PATH_SLOPE_COST * climb + PATH_STEEP_COST * steep);
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
    while (j > i && !(lineWalkable(tr, ax, ay, pts[j * 2], pts[j * 2 + 1]) && tr.lineGrade(ax, ay, pts[j * 2], pts[j * 2 + 1]) <= PATH_SMOOTH_MAX_GRADE)) j--;
    out.push(pts[j * 2], pts[j * 2 + 1]);
    ax = pts[j * 2];
    ay = pts[j * 2 + 1];
    i = j + 1;
  }
  return out;
}
