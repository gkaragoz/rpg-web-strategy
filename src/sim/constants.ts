/** Fixed simulation step (30 Hz). */
export const SIM_DT = 1 / 30;

/** Armies of at least this many soldiers are simulated at 20 Hz instead of 30 Hz (a third less work per second of battle). */
export const BIG_ARMY_UNITS = 12000;

/** The fixed step of a battle: derived from the config only, so every client of an online match agrees on it. */
export function simDtFor(config: { mode: string; perTeam?: number; teamCount?: number; layout?: ArrayLike<number> }): number {
  const units = config.mode === 'custom' ? (config.layout?.length ?? 0) / 4 : (config.perTeam ?? 0) * (config.teamCount ?? 2);
  return units >= BIG_ARMY_UNITS ? 1 / 20 : SIM_DT;
}
