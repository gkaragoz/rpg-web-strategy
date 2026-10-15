import { ClassicRules } from './classic';
import { CtfRules } from './ctf';
import { HillRules } from './hill';
import { VipRules } from './vip';
import type { GameModeId, ModeRules } from './types';

export * from './types';
export { VIP_TIME_LIMIT } from './vip';
export { CTF_TARGET, CTF_TIME_LIMIT, ctfRadius, ctfBasePoint } from './ctf';
export { HILL_TARGET, HILL_TIME_LIMIT, hillControlPoints, hillRadius } from './hill';

const FACTORIES: Record<GameModeId, () => ModeRules> = {
  classic: () => new ClassicRules(),
  hill: () => new HillRules(),
  vip: () => new VipRules(),
  ctf: () => new CtfRules(),
};

/** A fresh rules instance for the mode id (unknown or not yet implemented ids give the classic rules). */
export function modeFor(id: GameModeId | undefined): ModeRules {
  return (FACTORIES[id ?? 'classic'] ?? FACTORIES.classic)();
}
