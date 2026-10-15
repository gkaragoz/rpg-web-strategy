import { TROOPS, type Rarity } from '../data/troops';
import { KIND_OF_TROOP, MAX_TEAMS } from '../units';

// Horde mode: the pure wave tables (no battle state). Capacity planning (`unitCapacity`) and the mode rules both use them, so
// every client reserves and wakes exactly the same units.

/** Waves in a battle. */
export const HORDE_WAVES = 12;
/** Sim seconds until wave 1, and between two waves. */
export const HORDE_FIRST_WAVE = 15;
export const HORDE_INTERVAL = 25;
/** Safety limit (sim seconds): the humans lose when the horde is still alive then. */
export const HORDE_TIME_LIMIT = 900;
/** Most human teams (the horde team needs the last of MAX_TEAMS indices). */
export const HORDE_MAX_HUMANS = MAX_TEAMS - 1;
/** Wave n has `(HORDE_BASE + HORDE_GROWTH * (n - 1))` units per human team. */
export const HORDE_BASE = 4;
export const HORDE_GROWTH = 3;
/** Most spawn gates, and the minimum distance (tiles) between two gates. */
export const HORDE_GATES = 3;

/**
 * Tier mix per wave (percent common / rare / epic / legendary), index = wave - 1. The units of a wave are assigned to tiers
 * by stratification (the first units are common, the last the highest tier), so the counts are exact and need no RNG.
 * TUNING KNOBS: change these rows to make the horde easier or harder (see docs/SIMULATION.md "Horde balance").
 */
export const HORDE_MIX: ReadonlyArray<readonly [number, number, number, number]> = [
  [100, 0, 0, 0],
  [100, 0, 0, 0],
  [100, 0, 0, 0],
  [75, 25, 0, 0],
  [65, 35, 0, 0],
  [50, 50, 0, 0],
  [35, 45, 20, 0],
  [25, 40, 35, 0],
  [15, 35, 50, 0],
  [10, 30, 50, 10],
  [0, 25, 60, 15],
  [0, 20, 55, 25],
];

/** Skills whose units need setup done only for placed units (skeleton pool, linked foes): the horde does not field them. */
const EXCLUDED_SKILLS = new Set<string | null>(['summonSkeleton', 'destinyBond']);

const RARITIES: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Horde roster per tier (kind numbers, roster order): non-structure, non-summoned, no skill that needs placement-time setup. */
export const HORDE_ROSTER: ReadonlyArray<readonly number[]> = RARITIES.map((r) =>
  TROOPS.filter((t) => t.rarity === r && !t.summoned && !t.structure && !EXCLUDED_SKILLS.has(t.skill)).map((t) => KIND_OF_TROOP[t.id]),
);

/** Units of wave n (1-based) for `humans` human teams. */
export function hordeWaveSize(n: number, humans: number): number {
  return (HORDE_BASE + HORDE_GROWTH * (n - 1)) * humans;
}

/** Index of the first unit of wave n inside the pool (waves are stored one after the other). */
export function hordeWaveOffset(n: number, humans: number): number {
  let o = 0;
  for (let w = 1; w < n; w++) o += hordeWaveSize(w, humans);
  return o;
}

/** Dormant units reserved for the whole battle. */
export function hordePoolSize(humans: number): number {
  return hordeWaveOffset(HORDE_WAVES + 1, humans);
}

/** Step at which wave n (1-based) spawns (integer step counting, `sps` steps per second). */
export function hordeWaveStep(n: number, sps: number): number {
  return (HORDE_FIRST_WAVE + HORDE_INTERVAL * (n - 1)) * sps;
}

/** Stateless 32-bit mix of two small integers. */
export function hordeHash(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Tier (0 common .. 3 legendary) of unit k of a wave with `size` units. */
export function hordeTier(n: number, k: number, size: number): number {
  const mix = HORDE_MIX[Math.min(HORDE_WAVES, Math.max(1, n)) - 1];
  const pos = ((k + 0.5) / size) * 100;
  let acc = 0;
  for (let t = 0; t < 4; t++) {
    acc += mix[t];
    if (pos < acc) return t;
  }
  return 3;
}

/** Kind of unit k (0-based) of wave n (1-based) for `humans` human teams: a pure function of its arguments. */
export function hordeKind(n: number, k: number, humans: number): number {
  const size = hordeWaveSize(n, humans);
  let tier = hordeTier(n, k, size);
  while (tier > 0 && HORDE_ROSTER[tier].length === 0) tier--;
  const list = HORDE_ROSTER[tier];
  return list[hordeHash(n * 977 + 13, k) % list.length];
}
