import { T_GRASS, T_BLOCKED, T_PATH } from './terrainTypes';
import { noise } from './terrainNoise';
import type { Terrain } from './terrain';

// Terrain: villages, forests, walls, paths and the point-symmetric mirror of one half of the map.

export function freeRect(tr: Terrain, tx: number, ty: number, w: number, h: number, margin: number): boolean {
  const n = tr.size;
  const h0 = tx >= 0 && ty >= 0 && tx < n && ty < n ? tr.height[ty * n + tx] : 0;
  for (let y = ty - margin; y < ty + h + margin; y++) {
    for (let x = tx - margin; x < tx + w + margin; x++) {
      if (x < 1 || y < 1 || x >= n - 1 || y >= n - 1) return false;
      const i = y * n + x;
      if (tr.flags[i] !== T_GRASS || tr.occ[i]) return false;
      if (Math.abs(tr.height[i] - h0) > 4) return false; // structures are built on flat ground
      if (tr.reserved(x + 0.5, y + 0.5, 1)) return false;
    }
  }
  return true;
}

export function placeVillages(tr: Terrain): void {
  const n = tr.size;
  const rng = tr.rng;
  const vt = tr.spec.village;
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

  if (tr.layout === 'crossroads') {
    // Crossroads layout: fixed hamlets in the four corners of the junction.
    for (const [sc, dc] of [[-0.25, -0.2], [0.25, -0.2]]) {
      const x = tr.worldX(sc * n, dc * n);
      const y = tr.worldY(sc * n, dc * n);
      if (tr.inMap(x, y, 6) && tr.flags[tr.tileIdx(x, y)] === T_GRASS) centers.push({ x, y, side: -1 });
    }
  }
  for (let k = 0; tr.layout !== 'crossroads' && k < sites; k++) {
    const side = -1; // only one half is generated, then mirrored
    for (let attempt = 0; attempt < 80; attempt++) {
      const s = (rng() * 2 - 1) * n * 0.6;
      const dd = 10 + rng() * 14;
      const x = tr.worldX(s, side * dd);
      const y = tr.worldY(s, side * dd);
      if (!tr.inMap(x, y, 8) || tr.reserved(x, y, 4)) continue;
      if (centers.some((c) => Math.hypot(c.x - x, c.y - y) < spacing)) continue;
      if (tr.flags[tr.tileIdx(x, y)] !== T_GRASS) continue;
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
      if (!freeRect(tr, tx, ty, w, h, 1)) continue;
      for (let y = ty - 1; y < ty + h + 1; y++) for (let x = tx - 1; x < tx + w + 1; x++) tr.occ[y * n + x] = 1;
      for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) tr.flags[y * n + x] = T_BLOCKED;
      const sizeIdx = sizes.findIndex((z) => z[0] === w && z[1] === h);
      tr.decor.push({ kind: 'house', variant: sizeIdx * 2 + (rng() < 0.5 ? 0 : 1), x: tx + w, y: ty + h });
      placed++;
      // Rubble and broken wall pieces: around the house.
      for (let q = 0; q < 3; q++) {
        const rx = tx - 1 + Math.floor(rng() * (w + 2));
        const ry = ty - 1 + Math.floor(rng() * (h + 2));
        const edge = rx < tx || ry < ty || rx >= tx + w || ry >= ty + h;
        const i = ry * n + rx;
        if (!edge || rx < 1 || ry < 1 || rx >= n - 1 || ry >= n - 1 || tr.flags[i] !== T_GRASS) continue;
        if (q === 0) {
          tr.flags[i] = T_BLOCKED;
          tr.decor.push({ kind: 'wall', variant: rng() < 0.5 ? 0 : 1, x: rx + 0.5, y: ry + 0.5 });
        } else {
          tr.decor.push({ kind: 'rubble', variant: rng() < 0.5 ? 0 : 1, x: rx + 0.3 + rng() * 0.4, y: ry + 0.3 + rng() * 0.4 });
        }
      }
    }
    if (vt === 'camp') wallRing(tr, c.x, c.y, 5, 16, 5);
    if (vt === 'ruins') {
      wallRing(tr, c.x, c.y, 7.5, 28, 7);
      for (let q = 0; q < 10; q++) {
        const a = rng() * Math.PI * 2;
        const r = 3 + rng() * 5;
        const x = c.x + Math.cos(a) * r;
        const y = c.y + Math.sin(a) * r;
        if (freeRect(tr, Math.floor(x), Math.floor(y), 1, 1, 0)) tr.decor.push({ kind: 'rubble', variant: rng() < 0.5 ? 0 : 1, x, y });
      }
    }
    carvePath(tr, c.x, c.y, c.side);
  }
}

/** Is any of the tile's 8 neighbors an obstacle (walls must not touch corner to corner: that leaves leaks). */
export function blockedAround(tr: Terrain, tx: number, ty: number): boolean {
  const n = tr.size;
  for (let y = ty - 1; y <= ty + 1; y++) {
    for (let x = tx - 1; x <= tx + 1; x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      if (tr.flags[y * n + x] === T_BLOCKED) return true;
    }
  }
  return false;
}

/** Ring of spaced wall pieces around the center (leaves an entrance gap). */
export function wallRing(tr: Terrain, cx: number, cy: number, radius: number, segs: number, gapEvery: number): void {
  const n = tr.size;
  for (let k = 0; k < segs; k++) {
    if (k % gapEvery === 0) continue;
    const a = (k / segs) * Math.PI * 2;
    const tx = Math.floor(cx + Math.cos(a) * radius);
    const ty = Math.floor(cy + Math.sin(a) * radius);
    if (!freeRect(tr, tx, ty, 1, 1, 0) || blockedAround(tr, tx, ty)) continue;
    tr.flags[ty * n + tx] = T_BLOCKED;
    tr.occ[ty * n + tx] = 1;
    tr.decor.push({ kind: 'wall', variant: k % 2, x: tx + 0.5, y: ty + 0.5 });
  }
}

/** Copies the d < 0 half onto the d > 0 half by point reflection about the center: both sides get equal conditions. */
export function mirror(tr: Terrain): void {
  const n = tr.size;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const d = tr.toD(tx + 0.5, ty + 0.5);
      // Tiles on the axis (d = 0) pair among themselves: the smaller index is the source.
      if (d > 1e-9 || (d >= -1e-9 && ty * n + tx > (n - 1 - ty) * n + (n - 1 - tx))) continue;
      tr.flags[(n - 1 - ty) * n + (n - 1 - tx)] = tr.flags[ty * n + tx];
    }
  }
  const houseSize = [
    [2, 2],
    [3, 2],
    [2, 3],
  ];
  const kept = tr.decor.filter((d) => tr.toD(d.x, d.y) < 0);
  tr.decor.length = 0;
  for (const d of kept) tr.decor.push(d);
  for (const d of kept) {
    let x = n - d.x;
    let y = n - d.y;
    if (d.kind === 'house') {
      const [w, h] = houseSize[d.variant >> 1];
      x += w;
      y += h;
    }
    tr.decor.push({ kind: d.kind, variant: d.variant, x, y });
  }
  tr.pathTiles.length = 0;
  for (let i = 0; i < tr.flags.length; i++) if (tr.flags[i] === T_PATH) tr.pathTiles.push(i);
}

/** Dirt path from the village to the end of the nearest bridge on its own bank. */
export function carvePath(tr: Terrain, x0: number, y0: number, side: number): void {
  if (tr.bridges.length === 0) return;
  const p = { x: 0, y: 0 };
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (const b of tr.bridges) {
    tr.bridgeEnd(b, side, 0, p);
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
    if (!tr.inMap(x, y, 1)) continue;
    const idx = tr.tileIdx(x, y);
    if (tr.flags[idx] === T_GRASS) {
      tr.flags[idx] = T_PATH;
      tr.pathTiles.push(idx);
    }
  }
}

export function placeForest(tr: Terrain): void {
  const n = tr.size;
  const rng = tr.rng;
  const seed = tr.opts.seed;
  const ft = tr.spec.forest;
  const hasRiver = tr.riverKind !== 'none';
  // Forest type: threshold (thr), tree probability and the upper limit of the rock band.
  const thr = ft === 'none' ? 99 : ft === 'sparse' ? 0.66 : ft === 'grove' ? 0.64 : 0.6;
  const prob = ft === 'sparse' ? 0.3 : ft === 'grove' ? 0.55 : 0.4;
  const rockHi = ft === 'none' ? 0.6 : Math.min(thr, 0.66);
  const blockedNear = (tx: number, ty: number): boolean => {
    for (let y = ty - 1; y <= ty + 1; y++) {
      for (let x = tx - 1; x <= tx + 1; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        if (tr.flags[y * n + x] === T_BLOCKED) return true;
      }
    }
    return false;
  };
  for (let ty = 1; ty < n - 1; ty++) {
    for (let tx = 1; tx < n - 1; tx++) {
      const i = ty * n + tx;
      if (tr.flags[i] !== T_GRASS || tr.occ[i]) continue;
      const x = tx + 0.5;
      const y = ty + 0.5;
      if (tr.reserved(x, y, 1)) continue;
      const edge = Math.min(tx, ty, n - tx, n - ty);
      const bias = 0.3 * (1 - Math.min(1, edge / 10));
      let v = 0.65 * noise(x / 9, y / 9, seed) + 0.35 * noise(x / 4, y / 4, seed + 7) + bias;
      if (ft === 'grove') v = 0.85 * noise(x / 17, y / 17, seed + 3) + 0.15 * noise(x / 5, y / 5, seed + 7);
      else if (ft === 'ring') v = edge < 9 ? 0.62 + 0.12 * (1 - edge / 9) + 0.1 * noise(x / 4, y / 4, seed + 7) : 0.3 * noise(x / 9, y / 9, seed);
      const riverDist = hasRiver ? tr.riverEdgeDist(x, y) : 99;
      if (v > thr && riverDist > 4) {
        if (rng() < prob && !blockedNear(tx, ty)) {
          tr.flags[i] = T_BLOCKED;
          tr.decor.push({ kind: 'tree', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.4, y: y + (rng() - 0.5) * 0.4 });
        }
      } else if ((riverDist > 0.4 && riverDist < 2.5 && rng() < 0.05) || (v > 0.5 && v <= rockHi && rng() < 0.03)) {
        const boulder = rng() < 0.25 && !blockedNear(tx, ty);
        if (boulder) tr.flags[i] = T_BLOCKED;
        tr.decor.push({ kind: boulder ? 'boulder' : 'rock', variant: Math.floor(rng() * 3), x: x + (rng() - 0.5) * 0.5, y: y + (rng() - 0.5) * 0.5 });
      }
    }
  }
}
