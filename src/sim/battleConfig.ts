import { Terrain } from './terrain';
import type { MapSpec } from './mapSpec';
import type { GameModeId } from './modes/types';
import { KIND_OF_TROOP, type StatOverrides } from './units';

// Battle configuration, shared constants and the pure setup helpers (capacities, map size, spawn area, terrain).
// Battle (battle.ts) re-exports the public parts.

export const MAP_SIZE = 56;
export const ARROW_SPEED = 13;
export const LANDING_RADIUS = 0.75;
/** If no one dies for this many seconds, damage grows by STALE_RAMP percent per second. */
export const STALE_AFTER = 20;
export const STALE_RAMP = 0.08;
/** Extra close-combat range margin against tank targets (tank push radius 1.8 > 1.4). */
export const TANK_REACH = 0.6;
/** Extra close-combat range margin against structures (the keep is a big body). */
export const STRUCT_REACH = 1.0;
/** Comedy physics: longest launch distance (tiles). */
export const MAX_LAUNCH = 14;
/** Progress watchdog: a unit that cannot get closer to its target bans it after this time. */
export const CHASE_TIMEOUT = 6;
export const BAN_TIME = 8;
/** If a unit waits this many seconds because of the leash, the leash is temporarily disabled. */
export const LEASH_HOLD_MAX = 3;
export const LEASH_OFF = 8;
/** Draw if there is no damage for this long (s): once damage has occurred / if none ever has. */
export const NO_DAMAGE_DRAW = 90;
export const NO_DAMAGE_DRAW_FIRST = 150;
/** Draw after this time if no unit that can deal damage remains. */
export const NO_DAMAGER_DRAW = 4;
export const DEMO_GAP_HALF = 9;
export const BENCH_GAP = 24;

export interface SimEvent {
  /** hit: took damage (value = damage), shot: arrow fired, land: arrow landed on nothing, heal: healed (value = amount). */
  type: 'heal' | 'death' | 'bash' | 'slam' | 'hit' | 'shot' | 'land' | 'burst';
  x: number;
  y: number;
  unit: number;
  /** bash: push direction (radians, in the world x/y plane). */
  angle?: number;
  value?: number;
  /** Kind of the unit the event belongs to (for death/hit). */
  kind?: number;
  /** burst: effect element (0 physical, 1 fire, 2 ice, 3 holy, 4 dark, 5 nature, 6 energy); value = radius. */
  element?: number;
}

/** Upper limit of events produced per step (so messages/allocations do not blow up in big crowds). */
export const EVENT_CAP = 300;
/** Number of pre-allocated (dormant) skeletons per Bone Caller. */
export const SUMMON_POOL = 8;

/** Persistent effect zone: burning, curse (affects enemy teams). */
export interface Zone {
  x: number;
  y: number;
  r: number;
  t: number;
  dps: number;
  /** Team that placed the zone (the other teams are affected). */
  team: number;
  slowK: number;
}

export interface BattleConfig {
  /** 'demo': hand-made 10v10 layout, 'bench': block layout of perTeam units per team,
   *  'custom': the user-placed `layout`. */
  mode: 'demo' | 'bench' | 'custom';
  perTeam: number;
  /** Number of teams (2..6); default 2. */
  teamCount?: number;
  /** custom: map size (tiles). */
  mapSize?: number;
  /** custom: units, in groups of 4 (team, kind, x, y). */
  layout?: Float32Array;
  /** Unit stat overrides (by kind index); defaults if absent. */
  stats?: StatOverrides;
  /** false: no environment (river, obstacles), the old bare map. Default true. */
  env?: boolean;
  /** Map recipe (biome, river, forest, village, pass); the default forest map if absent. */
  map?: MapSpec;
  /** Comedy physics: hits launch units, some fall into water and die (sim only; visuals are separate). */
  comedy?: boolean;
  /** Map seed. */
  terrainSeed?: number;
  /** false: archer/priest kiting and the line limit are off (old behavior, for comparison). */
  kite?: boolean;
  /** Game mode rules (default 'classic'). Not the launch kind: that is `mode`. */
  rules?: GameModeId;
  /**
   * VIP mode only: per team index, the LAYOUT unit index (position order in `layout`, i.e. the k-th group of 4 floats) of the
   * team's VIP, or -1 / missing for "auto" (highest max HP, ties: lowest layout index). Resolved at reset through
   * `Battle.layoutUnits` (layout index -> unit index), because spawnLayout skips a layout entry whose spot has no walkable
   * tile. A pick that is out of range, skipped, of another team or a summon-pool unit falls back to auto. Ignored by other
   * modes and by the demo / bench layouts.
   */
  vips?: number[];
  /** Siege mode only: team index of the defender (the others attack). Missing, non-integer or out of range: team 0. */
  siegeDefender?: number;
}

export const DBG_KEYS = ['kites', 'kiteSteps', 'snapShots', 'archerDeaths', 'archerDeathsKiting', 'stuck', 'cornered'] as const;
/** Sim-internal counters only (for verification): not written to shared. */
export const EXTRA_DBG = ['bans', 'leashBreaks', 'paths', 'pathFails'] as const;

/** Block width (columns) and spacing; the block ends up wider than it is deep. */
export function benchLayout(perTeam: number): { cols: number; rows: number; spacing: number } {
  const cols = Math.max(2, Math.ceil(Math.sqrt(perTeam * 1.6)));
  return { cols, rows: Math.ceil(perTeam / cols), spacing: 1.2 };
}

function benchMapSize(perTeam: number): number {
  const { cols, rows, spacing } = benchLayout(perTeam);
  const depth = 2 * rows * spacing + BENCH_GAP;
  const width = cols * spacing;
  // Since the armies line up along the diagonal (x-y) axis, the map diagonal (x1.41) must suffice.
  return Math.ceil(Math.max(depth, width) / 1.38) + 8;
}

export function unitCapacity(config: BattleConfig): number {
  // Modes that spawn structures reserve a slot for each (Siege: the core).
  const extra = config.rules === 'siege' ? 1 : 0;
  if (config.mode === 'custom') {
    const L = config.layout;
    let necro = 0;
    if (L) for (let k = 1; k < L.length; k += 4) if (L[k] === KIND_OF_TROOP['bone-caller']) necro++;
    return Math.floor((L?.length ?? 0) / 4) + 16 + necro * SUMMON_POOL + extra;
  }
  return config.perTeam * 2 + 16 + extra;
}

export function projectileCapacity(config: BattleConfig): number {
  // Custom (solo studio / online) battles can have 30 000 soldiers: about 3 in 4 may have a shot in the air at once.
  if (config.mode === 'custom') return Math.max(4096, Math.ceil(unitCapacity(config) * 0.75));
  return config.mode === 'bench' ? 16384 : 1024;
}

export function mapSizeFor(config: BattleConfig): number {
  if (config.mode === 'custom') return config.mapSize ?? MAP_SIZE;
  if (config.mode !== 'bench') return MAP_SIZE;
  // If the environment is on, room is left around the army block for forest/village.
  return Math.ceil(benchMapSize(config.perTeam) * (config.env === false ? 1 : 1.3));
}

/** Area covered by the spawns: obstacles/decor are not placed in this area. */
function spawnZone(config: BattleConfig): { spawnD0: number; spawnD1: number; spawnHalfS: number } {
  // custom: the user places freely, no spawn area is reserved.
  if (config.mode === 'custom') return { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };
  if (config.mode === 'bench') {
    const { cols, rows, spacing } = benchLayout(config.perTeam);
    return {
      spawnD0: BENCH_GAP / 2 - 1,
      spawnD1: BENCH_GAP / 2 + rows * spacing + 2,
      spawnHalfS: (cols * spacing) / 2 + 3,
    };
  }
  return { spawnD0: DEMO_GAP_HALF - 1, spawnD1: DEMO_GAP_HALF + 4.5 + 1.5, spawnHalfS: 7 };
}

/** The sim (worker) and the renderer (main thread) both generate the same map with this. */
export function terrainFor(config: BattleConfig): Terrain | null {
  if (config.env === false) return null;
  return new Terrain(mapSizeFor(config), { seed: config.terrainSeed ?? 1, spec: config.map, ...spawnZone(config) });
}
