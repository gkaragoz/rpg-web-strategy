/** Orbit-style camera state around a ground focus point. */
export interface Rig {
  /** Focus point on the ground (world x, z). */
  fx: number;
  fz: number;
  /** Rotation around the vertical axis, radians (0 looks toward +z). */
  yaw: number;
  /** Angle of the view above the horizon, radians. */
  tilt: number;
  dist: number;
}

export const TILT_MIN = (12 * Math.PI) / 180;
export const TILT_MAX = (86 * Math.PI) / 180;
export const DIST_MIN = 4;

export function clampRig(r: Rig, size: number): Rig {
  const maxDist = Math.max(40, size * 2.4);
  return {
    fx: Math.min(size, Math.max(0, r.fx)),
    fz: Math.min(size, Math.max(0, r.fz)),
    yaw: ((r.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
    tilt: Math.min(TILT_MAX, Math.max(TILT_MIN, r.tilt)),
    dist: Math.min(maxDist, Math.max(DIST_MIN, r.dist)),
  };
}

/** Camera position for a rig whose focus sits at height `fy`. */
export function eyeOf(r: Rig, fy: number): { x: number; y: number; z: number } {
  const horiz = Math.cos(r.tilt) * r.dist;
  return {
    x: r.fx - Math.sin(r.yaw) * horiz,
    y: fy + Math.sin(r.tilt) * r.dist,
    z: r.fz - Math.cos(r.yaw) * horiz,
  };
}

/** Ground-plane vectors of the screen axes for the current yaw (used to pan with the mouse): right and "up the screen". */
export function panAxes(yaw: number): { rx: number; rz: number; ux: number; uz: number } {
  return { rx: -Math.cos(yaw), rz: Math.sin(yaw), ux: Math.sin(yaw), uz: Math.cos(yaw) };
}
