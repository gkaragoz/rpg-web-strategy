/** A point on the ground (world x, height, world y). */
export interface GroundHit {
  x: number;
  y: number;
  z: number;
}

/**
 * Ray against the height field: marches along the ray until it dips below the ground, then bisects. `height(x, z)` is the
 * ground height; the map spans [0, size] in x and z. Returns null when the ray leaves the map or never reaches the ground.
 */
export function pickGround(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, height: (x: number, z: number) => number, size: number, maxDist = 600): GroundHit | null {
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len;
  dy /= len;
  dz /= len;
  const inside = (x: number, z: number): boolean => x >= 0 && z >= 0 && x <= size && z <= size;
  let prev = 0;
  let prevAbove = oy - (inside(ox, oz) ? height(ox, oz) : 0);
  const step = 0.6;
  for (let t = step; t <= maxDist; t += step) {
    const x = ox + dx * t;
    const y = oy + dy * t;
    const z = oz + dz * t;
    const g = inside(x, z) ? height(x, z) : 0;
    const above = y - g;
    if (above <= 0 && prevAbove > 0) {
      // Crossing between prev and t: bisect.
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        const mx = ox + dx * mid;
        const mz = oz + dz * mid;
        const my = oy + dy * mid;
        if (my - (inside(mx, mz) ? height(mx, mz) : 0) > 0) lo = mid;
        else hi = mid;
      }
      const hx = ox + dx * hi;
      const hz = oz + dz * hi;
      if (!inside(hx, hz)) return null;
      return { x: hx, y: height(hx, hz), z: hz };
    }
    prev = t;
    prevAbove = above;
  }
  return null;
}
