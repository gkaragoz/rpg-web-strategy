import { ClassicRules } from './classic';
import { CtfRules } from './ctf';
import { HillRules } from './hill';
import { VipRules } from './vip';
import { SiegeRules } from './siege';
import { HordeRules } from './horde';
import { SIEGE_CORE_KIND } from '../units';
import type { GameModeId, ModeRules } from './types';

export * from './types';
export { VIP_TIME_LIMIT } from './vip';
export { CTF_TARGET, CTF_TIME_LIMIT, ctfRadius, ctfBasePoint } from './ctf';
export { SIEGE_TIME_LIMIT, SIEGE_CORE_HP, siegeCorePoint } from './siege';
export { SIEGE_CORE_KIND } from '../units';
import { HORDE_ROSTER } from './hordeWaves';
export { HORDE_WAVES, HORDE_FIRST_WAVE, HORDE_INTERVAL, HORDE_TIME_LIMIT, HORDE_MAX_HUMANS, HORDE_MIX, hordeWaveSize, hordePoolSize, hordeKind } from './hordeWaves';
export { HILL_TARGET, HILL_TIME_LIMIT, hillControlPoints, hillRadius } from './hill';

const FACTORIES: Record<GameModeId, () => ModeRules> = {
  classic: () => new ClassicRules(),
  hill: () => new HillRules(),
  vip: () => new VipRules(),
  ctf: () => new CtfRules(),
  siege: () => new SiegeRules(),
  horde: () => new HordeRules(),
};

/**
 * Kinds a mode spawns that no player placed (the siege core, the horde's monsters): the app must bake them into the unit atlas / draw them,
 * because placed-kind lists never contain them.
 */
export function structureKinds(rules: GameModeId | undefined): number[] {
  if (rules === 'siege') return [SIEGE_CORE_KIND];
  if (rules === 'horde') return [...new Set(HORDE_ROSTER.flat())];
  return [];
}

/** A fresh rules instance for the mode id (unknown or not yet implemented ids give the classic rules). */
export function modeFor(id: GameModeId | undefined): ModeRules {
  return (FACTORIES[id ?? 'classic'] ?? FACTORIES.classic)();
}
