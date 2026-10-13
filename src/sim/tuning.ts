/** Numbers shared by the battle and its parallel kernels (picker, separator). */
export const MELEE_SLOTS = 3;
export const SEPARATION_RADIUS = 0.9;
export const GRID_CELL = 4;
/** Fine grid for separation: cell size ~ separation radius, a 3x3 neighborhood is enough. */
export const SEP_CELL = 1;
/** Separation processes 1/SEP_STRIDE of the units each step; the push strength grows by the same factor. */
export const SEP_STRIDE = 3;
/** Push velocity: gain, maximum displacement per step (tiles), decay per step. */
export const SEP_GAIN = 1.5;
export const SEP_MAX_STEP = 0.08;
export const SEP_DECAY = 0.82;
/** If there is no enemy within this many cell rings, walk toward the army. */
export const MAX_RING = 6;
export const PRIEST_RING = 2;
/** Target score penalty for an enemy on the opposite bank (enemies on the same bank are fought first). */
export const OTHER_BANK_PENALTY = 15;
/** Resistance to switching targets (score bonus). */
export const SWITCH_BONUS = 6;
/** A target in range is locked: while within range (scaled by this multiplier) no new target is searched. */
export const ENGAGE_LOCK = 1.25;
/** Melee attack range tolerance (so a unit pushed around in a crowd can still hit). */
export const MELEE_SLACK = 0.4;
