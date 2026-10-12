import { Graphics } from 'pixi.js';
import { TILE_H, TILE_W, isoX, isoY } from '../iso';
import { PALETTES, type BiomePalette } from './biome';

export function buildGround(size: number, pal: BiomePalette = PALETTES.forest): Graphics {
  const g = new Graphics();
  const depth = 26;

  // Haritanin yan yuzleri (derinlik hissi).
  const lx = isoX(0, size);
  const ly = isoY(0, size);
  const bx = isoX(size, size);
  const by = isoY(size, size);
  const rx = isoX(size, 0);
  const ry = isoY(size, 0);
  g.poly([lx, ly, bx, by, bx, by + depth, lx, ly + depth]).fill(pal.sideL);
  g.poly([bx, by, rx, ry, rx, ry + depth, bx, by + depth]).fill(pal.sideR);

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
