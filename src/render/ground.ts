import { Graphics } from 'pixi.js';
import { TILE_H, TILE_W, isoX, isoY } from '../iso';

export function buildGround(size: number): Graphics {
  const g = new Graphics();
  const depth = 26;

  // Haritanin yan yuzleri (derinlik hissi).
  const lx = isoX(0, size);
  const ly = isoY(0, size);
  const bx = isoX(size, size);
  const by = isoY(size, size);
  const rx = isoX(size, 0);
  const ry = isoY(size, 0);
  g.poly([lx, ly, bx, by, bx, by + depth, lx, ly + depth]).fill(0x4a3a2a);
  g.poly([bx, by, rx, ry, rx, ry + depth, bx, by + depth]).fill(0x372a1e);

  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const cx = isoX(tx + 0.5, ty + 0.5);
      const cy = isoY(tx + 0.5, ty + 0.5);
      const light = (tx + ty) % 2 === 0;
      g.poly([cx, cy - TILE_H / 2, cx + TILE_W / 2, cy, cx, cy + TILE_H / 2, cx - TILE_W / 2, cy]).fill(light ? 0x78ab52 : 0x6c9e48);
    }
  }
  return g;
}
