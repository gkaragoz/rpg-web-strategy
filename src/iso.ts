export const TILE_W = 64;
export const TILE_H = 32;

export function isoX(x: number, y: number): number {
  return ((x - y) * TILE_W) / 2;
}

export function isoY(x: number, y: number, z = 0): number {
  return ((x + y) * TILE_H) / 2 - z;
}
