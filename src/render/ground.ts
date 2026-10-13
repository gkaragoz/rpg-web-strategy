import { Graphics } from 'pixi.js';
import { TILE_H, TILE_W, isoX, isoY } from '../iso';
import { LEVEL_PX, type Terrain } from '../sim/terrain';
import { PALETTES, type BiomePalette } from './biome';

function shade(c: number, k: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * k)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * k)));
  const b = Math.min(255, Math.max(0, Math.round((c & 255) * k)));
  return (r << 16) | (g << 8) | b;
}

function mix(a: number, b: number, t: number): number {
  const ch = (s: number): number => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export function buildGround(size: number, pal: BiomePalette = PALETTES.forest, terrain: Terrain | null = null): Graphics {
  const g = new Graphics();
  const depth = 26;

  // Side faces of the map (sense of depth).
  const lx = isoX(0, size);
  const ly = isoY(0, size);
  const bx = isoX(size, size);
  const by = isoY(size, size);
  const rx = isoX(size, 0);
  const ry = isoY(size, 0);
  g.poly([lx, ly, bx, by, bx, by + depth, lx, ly + depth]).fill(pal.sideL);
  g.poly([bx, by, rx, ry, rx, ry + depth, bx, by + depth]).fill(pal.sideR);

  if (!terrain || !terrain.hasRelief) {
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const cx = isoX(tx + 0.5, ty + 0.5);
        const cy = isoY(tx + 0.5, ty + 0.5);
        const light = (tx + ty) % 2 === 0;
        g.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill(light ? pal.grassA : pal.grassB);
      }
    }
    return g;
  }

  // Relief ground: each tile is a sloped quad from its corner heights; drawn back to front (x+y increasing).
  const bright = (pal.grassA & 255) > 0xe0; // snow: only shadow is applied, to avoid saturating the white
  const P = (vx: number, vy: number): [number, number] => [isoX(vx, vy), isoY(vx, vy, terrain.vertexH(vx, vy) * LEVEL_PX)];
  for (let sum = 0; sum <= 2 * size - 2; sum++) {
    for (let tx = Math.max(0, sum - size + 1); tx <= Math.min(size - 1, sum); tx++) {
      const ty = sum - tx;
      const h00 = terrain.vertexH(tx, ty);
      const h10 = terrain.vertexH(tx + 1, ty);
      const h01 = terrain.vertexH(tx, ty + 1);
      const h11 = terrain.vertexH(tx + 1, ty + 1);
      const gx = (h10 + h11 - h00 - h01) / 2;
      const gy = (h01 + h11 - h00 - h10) / 2;
      const steep = Math.hypot(gx, gy);
      // Light from the top-left: slopes rising in +x are lit, slopes rising in +y are shaded.
      const hAvg = (h00 + h10 + h01 + h11) / 4;
      let k = bright ? 0.93 + 0.8 * gx - 0.9 * gy : 1 + 0.95 * gx - 0.75 * gy + 0.025 * hAvg;
      k = Math.min(bright ? 1.02 : 1.3, Math.max(0.5, k));
      let col = shade((tx + ty) % 2 === 0 ? pal.grassA : pal.grassB, k);
      if (hAvg > 2) col = mix(col, shade(pal.cliff, k), Math.min(0.55, (hAvg - 2) * 0.28));
      if (steep > 0.85) col = mix(col, shade(pal.cliff, Math.min(1.2, Math.max(0.6, 1 + 0.25 * gx - 0.2 * gy))), Math.min(1, (steep - 0.85) / 0.9));
      const a = P(tx, ty);
      const b = P(tx + 1, ty);
      const c = P(tx + 1, ty + 1);
      const d = P(tx, ty + 1);
      g.poly([a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]]).fill(col);
    }
  }
  return g;
}
