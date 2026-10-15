import { T_GRASS, T_WATER, T_BRIDGE, T_BLOCKED, T_PATH, CLIFF_UNITS } from './terrainTypes';
import type { Terrain } from './terrain';

// Terrain: river, bridges, islands, cross channels, castle and roads (the map skeleton).

export function buildRiver(tr: Terrain): void {
  const n = tr.size;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const s = tr.toS(x, y);
      if (Math.abs(tr.toD(x, y) - tr.offsetAt(s)) < tr.widthAt(s) / 2) tr.flags[ty * n + tx] = T_WATER;
    }
  }
}

export function buildBridges(tr: Terrain): void {
  const n = tr.size;
  const spacing = n < 90 ? 16 : 28;
  const limit = n * 0.5 - 3;
  for (let k = -Math.floor(limit / spacing); k <= Math.floor(limit / spacing); k++) {
    const s = k * spacing;
    const w = tr.widthAt(s);
    tr.bridges.push({ s, o: tr.offsetAt(s), w, halfLen: w / 2 + 2.5, halfW: tr.spec.crossing === 'ford' ? 2.4 : 1.8 });
  }
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const s = tr.toS(x, y);
      const d = tr.toD(x, y);
      for (const b of tr.bridges) {
        if (Math.abs(s - b.s) < b.halfW + 0.05 && Math.abs(d - b.o) < b.halfLen) {
          tr.flags[ty * n + tx] = T_BRIDGE;
          break;
        }
      }
    }
  }
}

/** Small islands between the bridges in the river (only the d < 0 half; mirror produces the other). */
export function carveIslands(tr: Terrain): void {
  const n = tr.size;
  const spacing = n < 90 ? 16 : 28;
  const limit = n * 0.5 - 3;
  const K = Math.floor(limit / spacing);
  for (let k = -K - 1; k <= K; k++) {
    const sc = (k + 0.5) * spacing;
    if (Math.abs(sc) > limit - 2) continue;
    const o = tr.offsetAt(sc);
    const rd = tr.widthAt(sc) * 0.3;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = ty * n + tx;
        if (tr.flags[i] !== T_WATER) continue;
        const x = tx + 0.5;
        const y = ty + 0.5;
        if (tr.toD(x, y) >= 0) continue;
        const a = (tr.toS(x, y) - sc) / 3.4;
        const b = (tr.toD(x, y) - o) / rd;
        if (a * a + b * b < 1) tr.flags[i] = T_GRASS;
      }
    }
  }
}

/** Land tiles remaining inside the river (islands): for drawing. */
export function collectLand(tr: Terrain): void {
  tr.landTiles.length = 0;
  if (tr.riverKind === 'none') return;
  const n = tr.size;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const i = ty * n + tx;
      if (tr.flags[i] !== T_GRASS) continue;
      if (tr.riverEdgeDist(tx + 0.5, ty + 0.5) < 0) tr.landTiles.push(i);
    }
  }
}

/** Archipelago layout: two channels perpendicular to the river (s = about +-bridge spacing/2) and bridges crossing them. */
export function buildCrossChannels(tr: Terrain): void {
  const n = tr.size;
  const cw = Math.max(4, n * 0.07);
  tr.crossHalf = cw / 2;
  const s0 = (n < 90 ? 16 : 28) / 2;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const x = tx + 0.5;
      const y = ty + 0.5;
      const s = tr.toS(x, y);
      if (Math.abs(Math.abs(s) - s0) >= cw / 2) continue;
      if (tr.reserved(x, y, 1)) continue;
      const i = ty * n + tx;
      if (tr.flags[i] === T_GRASS || tr.flags[i] === T_PATH) {
        tr.flags[i] = T_WATER;
        tr.crossWaterTiles.push(i);
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
          if (Math.abs(tr.toD(x, y) - dc) > 1.4 || Math.abs(tr.toS(x, y) - sc) > cw / 2 + 1.3) continue;
          const i = ty * n + tx;
          if (tr.flags[i] === T_BRIDGE) continue;
          if (tr.flags[i] === T_WATER || tr.flags[i] === T_GRASS) {
            tr.flags[i] = T_BRIDGE;
            tr.crossBridgeTiles.push(i);
          }
        }
      }
    }
  }
}

/** Clears the area: removes decor and tree/house obstacles (for the citadel). */
export function clearArea(tr: Terrain, cx: number, cy: number, r: number): void {
  const n = tr.size;
  const keep = tr.decor.filter((d) => Math.hypot(d.x - cx, d.y - cy) >= r);
  tr.decor.length = 0;
  for (const d of keep) tr.decor.push(d);
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      if (Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy) >= r) continue;
      const i = ty * n + tx;
      if (tr.flags[i] === T_BLOCKED && tr.height[i] >= 0) {
        // only non-cliff obstacles (tree/house/rock) are removed
        let cliff = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx >= 0 && ny >= 0 && nx < n && ny < n && tr.height[i] - tr.height[ny * n + nx] >= CLIFF_UNITS) cliff = true;
        }
        if (!cliff) tr.flags[i] = T_GRASS;
      }
      tr.occ[i] = 0;
    }
  }
}

/** Central citadel: a ring wall on the plateau (gates toward the ramps), 4 corner towers and a keep in the middle. Point-symmetric. */
export function placeCastle(tr: Terrain): void {
  const n = tr.size;
  const c = n / 2;
  const r = n * 0.21;
  const rho = r * 0.6;
  clearArea(tr, c, c, rho + 2.5);
  const put = (tx: number, ty: number, kind: 'wall' | 'tower', variant: number): void => {
    const i = ty * n + tx;
    if (tx < 1 || ty < 1 || tx >= n - 1 || ty >= n - 1 || tr.flags[i] !== T_GRASS) return;
    tr.flags[i] = T_BLOCKED;
    tr.occ[i] = 1;
    tr.decor.push(kind === 'wall' ? { kind, variant, x: tx + 0.5, y: ty + 0.5 } : { kind, variant, x: tx + 1, y: ty + 1 });
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
    if (tr.flags[i] === T_BLOCKED && tr.decor.some((d) => d.kind === 'wall' && Math.floor(d.x) === tx && Math.floor(d.y) === ty)) {
      const k = tr.decor.findIndex((d) => d.kind === 'wall' && Math.floor(d.x) === tx && Math.floor(d.y) === ty);
      tr.decor.splice(k, 1);
      tr.flags[i] = T_GRASS;
    }
    put(tx, ty, 'tower', 0);
  }
  // Keep: a 4x4 block in the middle (tiles c-2..c+1), an obstacle.
  for (let ty = c - 2; ty < c + 2; ty++) for (let tx = c - 2; tx < c + 2; tx++) {
    tr.flags[ty * n + tx] = T_BLOCKED;
    tr.occ[ty * n + tx] = 1;
  }
  tr.decor.push({ kind: 'keep', variant: 0, x: c + 2, y: c + 2 });
}

/** Crossroads: dirt road along the middle axes (symmetric). */
export function carveRoads(tr: Terrain): void {
  const n = tr.size;
  for (let t = -n; t <= n; t += 0.4) {
    for (const [x, y] of [[tr.worldX(0, t), tr.worldY(0, t)], [tr.worldX(t, 0), tr.worldY(t, 0)]]) {
      if (!tr.inMap(x, y, 1)) continue;
      const idx = tr.tileIdx(x, y);
      if (tr.flags[idx] === T_GRASS) {
        tr.flags[idx] = T_PATH;
        tr.pathTiles.push(idx);
      }
    }
  }
}
