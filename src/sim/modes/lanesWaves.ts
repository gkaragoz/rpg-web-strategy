import { Kind } from '../units';
import { LANE_COUNT, LANE_WAYPOINTS } from '../terrainLanes';

// Lane Conquest: the pure wave tables and timing (no battle state). Capacity planning (`unitCapacity`) and the mode rules both use
// them, so every client reserves and wakes exactly the same units. All numbers a designer would tune live in this file.

/** Sim seconds until the first wave, and between two waves. */
export const LANES_FIRST_WAVE = 10;
export const LANES_INTERVAL = 25;
/** Sim seconds after which the castle with the higher health fraction wins (equal: draw). */
export const LANES_TIME_LIMIT = 720;
/** Waves released in a battle: wave n appears at LANES_FIRST_WAVE + LANES_INTERVAL * (n - 1) <= LANES_TIME_LIMIT. */
export const LANES_WAVES = Math.floor((LANES_TIME_LIMIT - LANES_FIRST_WAVE) / LANES_INTERVAL) + 1;
/** Teams in a lanes battle (exactly two). */
export const LANES_TEAMS = 2;
/** Towers per lane per team (outer, inner). */
export const LANES_TOWERS_PER_LANE = 2;
/** Structures spawned by the mode: a castle per team and the towers. */
export const LANES_STRUCTURES = LANES_TEAMS * (1 + LANE_COUNT * LANES_TOWERS_PER_LANE);

/**
 * Wave composition per lane (every lane of every team gets the same). Warriors (Kind.Warrior) start at `warriors` and gain one every
 * `warriorsEvery` waves; archers (Kind.Archer) the same; a Shield Tank joins from wave `shieldFrom`, a Hammer Tank from `hammerFrom`.
 */
export const LANES_COMP = {
  warriors: 3,
  warriorsEvery: 10,
  archers: 2,
  archersEvery: 15,
  shieldFrom: 5,
  hammerFrom: 10,
} as const;

/** Soldiers per lane in wave n (1-based). */
export function laneWaveSize(n: number): number {
  return laneWarriors(n) + laneArchers(n) + (n >= LANES_COMP.shieldFrom ? 1 : 0) + (n >= LANES_COMP.hammerFrom ? 1 : 0);
}

export function laneWarriors(n: number): number {
  return LANES_COMP.warriors + Math.floor((n - 1) / LANES_COMP.warriorsEvery);
}

export function laneArchers(n: number): number {
  return LANES_COMP.archers + Math.floor((n - 1) / LANES_COMP.archersEvery);
}

/** Unit kind of soldier k (0-based) of a lane in wave n: warriors, then archers, then the Shield Tank, then the Hammer Tank. */
export function laneKind(n: number, k: number): number {
  const w = laneWarriors(n);
  if (k < w) return Kind.Warrior;
  if (k < w + laneArchers(n)) return Kind.Archer;
  if (n >= LANES_COMP.shieldFrom && k === w + laneArchers(n)) return Kind.Shield;
  return Kind.Brute;
}

/** Soldiers of wave n for the whole battle (both teams, every lane). */
export function lanesWaveTotal(n: number): number {
  return laneWaveSize(n) * LANE_COUNT * LANES_TEAMS;
}

/** Index of the first unit of wave n inside the pool (waves are stored one after the other). */
export function lanesWaveOffset(n: number): number {
  let o = 0;
  for (let w = 1; w < n; w++) o += lanesWaveTotal(w);
  return o;
}

/** Dormant soldiers reserved for the whole battle. */
export function lanesPoolSize(): number {
  return lanesWaveOffset(LANES_WAVES + 1);
}

/** Pool index (relative to the pool start) of soldier k of lane `lane` of team `team` in wave n. */
export function lanesPoolIndex(n: number, team: number, lane: number, k: number): number {
  const size = laneWaveSize(n);
  return lanesWaveOffset(n) + (team * LANE_COUNT + lane) * size + k;
}

/** Step at which wave n (1-based) is released (integer step counting, `sps` steps per second). */
export function lanesWaveStep(n: number, sps: number): number {
  return (LANES_FIRST_WAVE + LANES_INTERVAL * (n - 1)) * sps;
}

/** Stateless 32-bit mix of two small integers (deterministic spawn jitter). */
export function lanesHash(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Route length of a soldier: the lane waypoints followed by the enemy castle. */
export const LANES_ROUTE_LEN = LANE_WAYPOINTS + 1;
