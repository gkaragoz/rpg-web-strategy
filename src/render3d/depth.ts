/**
 * Pure helpers for how sprites stand in the 3D world (no three.js, testable in Node).
 *
 * The 2D art is drawn for an isometric 3/4 view. A fully camera-facing quad tilts back with the camera, so at a steep tilt it
 * lies almost flat and cuts into the terrain; a house is anchored at the front corner of its footprint diamond, so seen from the
 * side the diamond's edges hang above the ground. The fixes are: an upright-leaning quad (`billboardLean`), the footprint centre
 * as the anchor of structures (`footprintOf`) and one depth for the whole sprite (the feet, in the vertex shader).
 */

/** Largest lean (radians from vertical) a sprite may take; a sprite never lies flatter than this however high the camera is. */
export const MAX_LEAN = (50 * Math.PI) / 180;
/** The lean's height compensation never stretches a sprite by more than this. */
export const MAX_LEAN_SCALE = 1.35;

/**
 * Lean of the sprite plane for a camera `tilt` above the horizon (radians). A camera-facing quad leans by exactly `tilt` from
 * the vertical; it is capped at `maxLean`, and `scale` stretches the quad's height so that it still covers about the same screen
 * height as the camera-facing one (the cost of leaning less is a shorter projection: cos(tilt - lean)).
 */
export function billboardLean(tilt: number, maxLean = MAX_LEAN): { lean: number; scale: number } {
  const lean = Math.max(0, Math.min(tilt, maxLean));
  const scale = Math.min(MAX_LEAN_SCALE, 1 / Math.max(0.2, Math.cos(tilt - lean)));
  return { lean, scale };
}

/**
 * The up axis of leaning sprites as a vector (length = height scale). `fx`, `fz` is the camera's horizontal view direction
 * (it need not be normalized); the sprite top leans away from the camera along it.
 */
export function leanUpVector(tilt: number, fx: number, fz: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const { lean, scale } = billboardLean(tilt);
  const len = Math.hypot(fx, fz) || 1;
  const s = (Math.sin(lean) * scale) / len;
  out.x = fx * s;
  out.y = Math.cos(lean) * scale;
  out.z = fz * s;
  return out;
}

/** Footprint (tiles) of a house variant, as in `Terrain`'s house table. */
const HOUSE_FOOTPRINT: ReadonlyArray<readonly [number, number]> = [
  [2, 2],
  [3, 2],
  [2, 3],
];

export interface Footprint {
  /** World position of the footprint centre (where the sprite stands). */
  x: number;
  z: number;
  /** Sprite pixels from the front corner of the iso diamond (the 2D anchor) up to the footprint centre. */
  rise: number;
}

/** Tile size in the iso art: the diamond's front corner is (w + h) * 8 px below its centre. */
const DIAMOND_PX = 8;

/**
 * Where a structure really stands. The map stores the front corner of the footprint (houses, keep: the far corner; towers: the
 * tile corner; walls: the tile centre); in 3D the sprite is anchored at the footprint centre so its base touches the ground
 * on all sides whatever the view direction.
 */
export function footprintOf(kind: string, variant: number, x: number, y: number): Footprint {
  switch (kind) {
    case 'house': {
      const [w, h] = HOUSE_FOOTPRINT[(variant >> 1) % HOUSE_FOOTPRINT.length];
      return { x: x - w / 2, z: y - h / 2, rise: (w + h) * DIAMOND_PX };
    }
    case 'keep':
      return { x: x - 2, z: y - 2, rise: 8 * DIAMOND_PX };
    case 'tower':
      return { x: x - 0.5, z: y - 0.5, rise: 2 * DIAMOND_PX };
    case 'wall':
      return { x, z: y, rise: 2 * DIAMOND_PX };
    default:
      return { x, z: y, rise: 0 };
  }
}
