import { PALETTES, type BiomePalette } from '../render/biome';
import { T_BLOCKED, T_BRIDGE, T_GRASS, T_PATH, T_WATER, type Terrain } from '../sim/terrain';

/** Height of one elevation step in world units (a tile is 1 x 1). */
export const HEIGHT_PER_STEP = 0.6;
/** How far water tiles sit below the shore. */
export const WATER_DEPTH = 0.3;
/** Bridge decks float this far above the ground. */
export const DECK_LIFT = 0.14;

export interface TerrainMeshData {
  /** x, y (up), z per vertex; world x -> x, world y -> z. */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

const mix = (a: number, b: number, k: number): number => {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const r = ar + (((b >> 16) & 255) - ar) * k;
  const g = ag + (((b >> 8) & 255) - ag) * k;
  const bl = ab + ((b & 255) - ab) * k;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
};

/** Corner height (world units) of the corner (vx, vy), 0..n. */
export function cornerHeight(t: Terrain, vx: number, vy: number): number {
  return t.hasRelief ? t.vh[vy * (t.size + 1) + vx] * HEIGHT_PER_STEP : 0;
}

/** Terrain height (world units) at a point, bilinear over the corner heights like the simulation. */
export function groundHeight(t: Terrain, x: number, y: number): number {
  return t.hasRelief ? t.heightAt(x, y) * HEIGHT_PER_STEP : 0;
}

/**
 * Height of the drawn surface at a point: every land tile is two triangles (split along the (tx,ty)-(tx+1,ty+1) diagonal, like
 * `terrainGeometry`), which differs a little from the bilinear `groundHeight` on twisted tiles. Picking uses this so a ray hits what is
 * on screen: with the bilinear surface a grazing ray over a hill crest skipped the crest and the ring jumped behind the hill.
 * Water tiles keep the bilinear value (the water surface) and bridge decks float `DECK_LIFT` above it.
 */
export function surfaceHeight(t: Terrain, x: number, y: number): number {
  const n = t.size;
  const tx = Math.min(n - 1, Math.max(0, Math.floor(x)));
  const ty = Math.min(n - 1, Math.max(0, Math.floor(y)));
  const f = t.flags[ty * n + tx];
  if (f === T_WATER) return groundHeight(t, x, y);
  const u = Math.min(1, Math.max(0, x - tx));
  const w = Math.min(1, Math.max(0, y - ty));
  const lift = f === T_BRIDGE ? DECK_LIFT : 0;
  const c = (dx: number, dy: number): number => (f === T_BRIDGE ? Math.max(0, cornerHeight(t, tx + dx, ty + dy)) : cornerHeight(t, tx + dx, ty + dy));
  const h0 = c(0, 0);
  const h1 = c(0, 1);
  const h2 = c(1, 1);
  const h3 = c(1, 0);
  // Corner order (tx,ty) (tx,ty+1) (tx+1,ty+1) (tx+1,ty); triangles (0,1,2) and (0,2,3).
  return lift + (w > u ? h0 + w * (h1 - h0) + u * (h2 - h1) : h0 + u * (h3 - h0) + w * (h2 - h3));
}

/**
 * Polygonal terrain from the height field: every tile is its own quad (own colour, flat-shaded faces) on the corner heights of
 * the simulation, water tiles sink below the shore, bridge decks float above the water, and shore walls close the gaps.
 */
export function terrainGeometry(t: Terrain, pal: BiomePalette = PALETTES[t.spec.biome]): TerrainMeshData {
  const n = t.size;
  const isWater = (tx: number, ty: number): boolean => tx >= 0 && ty >= 0 && tx < n && ty < n && t.flags[ty * n + tx] === T_WATER;
  let walls = 0;
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const f = t.flags[ty * n + tx];
      if (f === T_WATER || f === T_BRIDGE) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isWater(tx + dx, ty + dy)) walls++;
    }
  }
  const quads = n * n + walls;
  const positions = new Float32Array(quads * 4 * 3);
  const normals = new Float32Array(quads * 4 * 3);
  const colors = new Float32Array(quads * 4 * 3);
  const indices = new Uint32Array(quads * 6);
  let q = 0;

  const put = (v: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, col: number): void => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    colors[v * 3] = ((col >> 16) & 255) / 255;
    colors[v * 3 + 1] = ((col >> 8) & 255) / 255;
    colors[v * 3 + 2] = (col & 255) / 255;
  };
  const quadIndices = (base: number, slot: number): void => {
    indices.set([base, base + 1, base + 2, base, base + 2, base + 3], slot * 6);
  };

  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const f = t.flags[ty * n + tx];
      const water = f === T_WATER;
      const bridge = f === T_BRIDGE;
      // Corners in the order (tx,ty) (tx,ty+1) (tx+1,ty+1) (tx+1,ty): counter-clockwise seen from above (y up, z toward the viewer).
      const cx = [tx, tx, tx + 1, tx + 1];
      const cz = [ty, ty + 1, ty + 1, ty];
      const h = cx.map((x, i) => cornerHeight(t, x, cz[i]));
      let ys = h;
      if (water) ys = h.map(() => -WATER_DEPTH);
      else if (bridge) ys = h.map((v) => Math.max(0, v) + DECK_LIFT);
      // Face normal from the two diagonals.
      const ax = cx[2] - cx[0];
      const az = cz[2] - cz[0];
      const ay = ys[2] - ys[0];
      const bx = cx[3] - cx[1];
      const bz = cz[3] - cz[1];
      const by = ys[3] - ys[1];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const slope = Math.max(...ys) - Math.min(...ys);
      let col: number;
      if (water) col = (tx + ty) % 2 === 0 ? pal.waterMid : pal.water;
      else if (bridge) col = pal.deck;
      else if (f === T_PATH) col = pal.path;
      else col = (tx + ty) % 2 === 0 ? pal.grassA : pal.grassB;
      if (!water && !bridge) {
        const shore = isWater(tx + 1, ty) || isWater(tx - 1, ty) || isWater(tx, ty + 1) || isWater(tx, ty - 1);
        if (shore) col = mix(col, pal.bank, 0.7);
        if (f === T_BLOCKED || slope > 0.85) col = mix(col, pal.cliff, Math.min(1, 0.35 + slope * 0.6));
      }
      const base = q * 4;
      for (let i = 0; i < 4; i++) put(base + i, cx[i], ys[i], cz[i], nx, ny, nz, col);
      quadIndices(base, q);
      q++;
    }
  }

  // Shore walls: from the edge of a land tile down to the water bed.
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const f = t.flags[ty * n + tx];
      if (f === T_WATER || f === T_BRIDGE) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!isWater(tx + dx, ty + dy)) continue;
        // Edge corners of this tile on the side of the water.
        const ex = dx === 1 ? [tx + 1, tx + 1] : dx === -1 ? [tx, tx] : [tx, tx + 1];
        const ez = dy === 1 ? [ty + 1, ty + 1] : dy === -1 ? [ty, ty] : [ty, ty + 1];
        const h0 = cornerHeight(t, ex[0], ez[0]);
        const h1 = cornerHeight(t, ex[1], ez[1]);
        // Outward normal (toward the water), ordered so the face points that way.
        const nx = dx;
        const nz = dy;
        const col = mix(pal.bank, pal.sideL, 0.55);
        const base = q * 4;
        // (ex0, top) (ex0, bottom) (ex1, bottom) (ex1, top), flipped when needed to face outward.
        const verts = [
          [ex[0], h0, ez[0]],
          [ex[0], -WATER_DEPTH, ez[0]],
          [ex[1], -WATER_DEPTH, ez[1]],
          [ex[1], h1, ez[1]],
        ];
        // Winding: normal of (v1-v0) x (v2-v0) must point outward; reverse otherwise.
        const e1 = [verts[1][0] - verts[0][0], verts[1][1] - verts[0][1], verts[1][2] - verts[0][2]];
        const e2 = [verts[2][0] - verts[0][0], verts[2][1] - verts[0][1], verts[2][2] - verts[0][2]];
        const cx2 = e1[1] * e2[2] - e1[2] * e2[1];
        const cz2 = e1[0] * e2[1] - e1[1] * e2[0];
        if (cx2 * nx + cz2 * nz < 0) verts.reverse();
        verts.forEach((v, i) => put(base + i, v[0], v[1], v[2], nx, 0, nz, col));
        quadIndices(base, q);
        q++;
      }
    }
  }
  return { positions, normals, colors, indices };
}

void T_GRASS;
