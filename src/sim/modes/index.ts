import { ClassicRules } from './classic';
import { CtfRules } from './ctf';
import { HillRules } from './hill';
import { VipRules } from './vip';
import { SiegeRules } from './siege';
import { HordeRules } from './horde';
import { LanesRules } from './lanes';
import { Kind, LANE_CASTLE_KIND, LANE_TOWER_KIND, SIEGE_CORE_KIND } from '../units';
import type { GameModeId, ModeRules } from './types';

export * from './types';
export { VIP_TIME_LIMIT } from './vip';
export { CTF_TARGET, CTF_TIME_LIMIT, ctfRadius, ctfBasePoint } from './ctf';
export { SIEGE_TIME_LIMIT, SIEGE_CORE_HP, siegeCorePoint } from './siege';
export { SIEGE_CORE_KIND } from '../units';
import { HORDE_ROSTER } from './hordeWaves';
export { HORDE_WAVES, HORDE_FIRST_WAVE, HORDE_INTERVAL, HORDE_TIME_LIMIT, HORDE_MAX_HUMANS, HORDE_MIX, hordeWaveSize, hordePoolSize, hordeKind } from './hordeWaves';
export { LANES_COMP, LANES_FIRST_WAVE, LANES_INTERVAL, LANES_TIME_LIMIT, LANES_WAVES, LANES_TEAMS, LANES_TOWERS_PER_LANE, LANES_STRUCTURES, laneWaveSize, laneKind, lanesPoolSize, lanesWaveStep } from './lanesWaves';
export { LANE_CASTLE_KIND, LANE_TOWER_KIND } from '../units';
export { HILL_TARGET, HILL_TIME_LIMIT, hillControlPoints, hillRadius } from './hill';

const FACTORIES: Record<GameModeId, () => ModeRules> = {
  classic: () => new ClassicRules(),
  hill: () => new HillRules(),
  vip: () => new VipRules(),
  ctf: () => new CtfRules(),
  siege: () => new SiegeRules(),
  horde: () => new HordeRules(),
  lanes: () => new LanesRules(),
};

/**
 * Kinds a mode spawns that no player placed (the siege core, the horde's monsters, the lane castle / towers / soldiers): the app must bake them into the unit atlas / draw them,
 * because placed-kind lists never contain them.
 */
export function structureKinds(rules: GameModeId | undefined): number[] {
  if (rules === 'siege') return [SIEGE_CORE_KIND];
  if (rules === 'horde') return [...new Set(HORDE_ROSTER.flat())];
  // Lane Conquest: the castle, the tower and the soldier kinds of the waves (warrior, archer, shield tank, hammer tank).
  if (rules === 'lanes') return [LANE_CASTLE_KIND, LANE_TOWER_KIND, Kind.Warrior, Kind.Archer, Kind.Shield, Kind.Brute];
  return [];
}

/** A fresh rules instance for the mode id (unknown or not yet implemented ids give the classic rules). */
export function modeFor(id: GameModeId | undefined): ModeRules {
  return (FACTORIES[id ?? 'classic'] ?? FACTORIES.classic)();
}
