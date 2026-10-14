/** Combat constants that depend on terrain height (all heights are in elevation steps; one step = 16 height units). */

/** Damage bonus per elevation step the attacker stands above the target (negative below); melee uses a fraction. */
export const HG_DMG_PER_STEP = 0.09;
export const HG_MELEE_FACTOR = 0.5;
export const HG_DMG_MIN = 0.7;
export const HG_DMG_MAX = 1.35;

/** Range bonus (tiles) per step of height advantage for ranged attackers; disadvantage costs less. */
export const HG_RANGE_UP = 0.6;
export const HG_RANGE_UP_MAX = 1.8;
export const HG_RANGE_DOWN = 0.4;
export const HG_RANGE_DOWN_MAX = 1.2;

/** Direct-fire shots (arrows, bolts, javelins) are blocked when the ground between rises this many steps above both ends. */
export const COVER_STEPS = 1.5;
/** Sampling distance (tiles) of the line-of-fire check. */
export const COVER_SAMPLE = 0.75;

/** Uphill speed factor: 1 / (1 + SLOPE_K * grade), grade = steps climbed per tile; never below SLOPE_MIN. */
export const SLOPE_K = 1.1;
export const SLOPE_MIN = 0.35;
/** Extra slope sensitivity of heavy units (render scale > 1.5). */
export const SLOPE_HEAVY = 1.3;
/** Downhill speed bonus (per grade, capped). */
export const DOWNHILL_K = 0.1;
export const DOWNHILL_MAX = 0.1;

/** Path-finding: extra cost per step climbed, and the steepest line (steps per tile) path smoothing may cut across. */
export const PATH_SLOPE_COST = 1.5;
export const PATH_SMOOTH_MAX_GRADE = 0.9;
/** Extra cost per step of height difference beyond PATH_STEEP_FROM on one tile move, both uphill and downhill (the near-cliff slopes that are walkable but crawl-slow): routes prefer the gentler ramps. */
export const PATH_STEEP_COST = 7;
export const PATH_STEEP_FROM = 0.8;

/** Damage multiplier for an attacker standing `dh` steps above (positive) or below the target. */
export function highGroundDamage(dh: number, melee: boolean): number {
  const m = 1 + HG_DMG_PER_STEP * dh * (melee ? HG_MELEE_FACTOR : 1);
  return Math.min(HG_DMG_MAX, Math.max(HG_DMG_MIN, m));
}

/** Range bonus in tiles for a ranged attacker `dh` steps above (positive) or below its target. */
export function highGroundRange(dh: number): number {
  return dh >= 0 ? Math.min(HG_RANGE_UP_MAX, dh * HG_RANGE_UP) : Math.max(-HG_RANGE_DOWN_MAX, dh * HG_RANGE_DOWN);
}

/** Movement speed factor for a slope: `grade` is the height change per tile in the moving direction (positive = uphill). */
export function slopeSpeed(grade: number, heavy: boolean): number {
  if (grade > 0.05) return Math.max(SLOPE_MIN, 1 / (1 + SLOPE_K * grade * (heavy ? SLOPE_HEAVY : 1)));
  if (grade < -0.05) return 1 + Math.min(DOWNHILL_MAX, -grade * DOWNHILL_K);
  return 1;
}

// ---- Damage types and armor classes (rock-paper-scissors layer) ----

/** Damage types of attacks and armor classes of bodies; indices into TYPE_MULT. */
export const DMG = { slash: 0, pierce: 1, blunt: 2, magic: 3 } as const;
export const ARM = { light: 0, medium: 1, heavy: 2, spirit: 3 } as const;
export const DMG_IDS = ['slash', 'pierce', 'blunt', 'magic'] as const;
export const ARM_IDS = ['light', 'medium', 'heavy', 'spirit'] as const;
export type DmgId = (typeof DMG_IDS)[number];
export type ArmId = (typeof ARM_IDS)[number];

/**
 * TYPE_MULT[dmg * 4 + arm]: damage multiplier of a damage type against an armor class.
 * Every type is strong against one class and weak against another; every class has a natural counter.
 *            light  medium  heavy  spirit
 *   slash     1.30   1.00    0.70   0.90
 *   pierce    1.10   1.30    0.70   0.80
 *   blunt     0.80   1.00    1.30   0.70
 *   magic     1.00   1.00    1.20   1.40
 */
export const TYPE_MULT = new Float32Array([1.3, 1.0, 0.7, 0.9, 1.1, 1.3, 0.7, 0.8, 0.8, 1.0, 1.3, 0.7, 1.0, 1.0, 1.2, 1.4]);

export function typeMultiplier(dmg: number, arm: number): number {
  return TYPE_MULT[dmg * 4 + arm];
}

// ---- Area damage ----

/** Basic-attack splash: damage falls off linearly with the distance from the impact point (SPLASH_EDGE at the radius). */
export const SPLASH_EDGE = 0.5;
/** Basic-attack splash hits at most this many enemies, so a tight blob is not wiped out by one volley. */
export const SPLASH_TARGETS = 14;

export function splashFactor(dist: number, radius: number): number {
  return 1 - (1 - SPLASH_EDGE) * Math.min(1, dist / Math.max(0.01, radius));
}

// ---- Crowd control ----

/** Seconds a unit is immune to new stuns/fear after one ends (stops mass stun-locks from many casters). */
export const CC_IMMUNE = 1.2;
