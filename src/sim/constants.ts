/** Fixed simulation step (30 Hz). */
export const SIM_DT = 1 / 30;

/** Armies of at least this many soldiers are simulated at 20 Hz instead of 30 Hz (a third less work per second of battle). */
export const BIG_ARMY_UNITS = 12000;

/** The fixed step of a battle: derived from the config only, so every client of an online match agrees on it. */
export function simDtFor(config: ArmyConfig): number {
  return armySize(config) >= BIG_ARMY_UNITS ? 1 / 20 : SIM_DT;
}

type ArmyConfig = { mode: string; perTeam?: number; teamCount?: number; layout?: ArrayLike<number> };

/** Number of soldiers a battle starts with (from the config alone). */
export function armySize(config: ArmyConfig): number {
  return config.mode === 'custom' ? (config.layout?.length ?? 0) / 4 : (config.perTeam ?? 0) * (config.teamCount ?? 2);
}

/** Armies of at least this many soldiers may use movement helper threads (below that the hand-over costs more than it saves). */
export const THREADS_MIN_UNITS = 3000;

/** Waypoints a unit stores per A* path (longer paths are cut; the unit asks for a new one at the end). */
export const PATH_MAX = 24;
