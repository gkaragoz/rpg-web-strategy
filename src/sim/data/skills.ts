import type { SkillId } from './troops';

const lv = (a: number, b: number, level: number): number => a + ((b - a) * (Math.min(10, Math.max(1, level)) - 1)) / 9;

/** Per-level skill parameters (in game scale). Unused fields are 0. */
export interface SkillParams {
  /** Triggers every N attacks (0: every attack / continuous). */
  every: number;
  /** Skill damage (or healing). */
  dmg: number;
  /** Effect radius (tiles). */
  radius: number;
  /** Effect duration (s): stun, slow, fear, shield, zone... */
  dur: number;
  /** General coefficients: slow multiplier, shield multiplier, reflect ratio, etc. */
  a: number;
  b: number;
  /** Count (skeletons, orbs, split balls...). */
  count: number;
  /** Length and half-width for line/rectangle effects. */
  length: number;
  half: number;
}

const base: SkillParams = { every: 0, dmg: 0, radius: 0, dur: 0, a: 0, b: 0, count: 0, length: 0, half: 0 };
const P = (o: Partial<SkillParams>): SkillParams => ({ ...base, ...o });

export function skillParams(id: SkillId, l: number): SkillParams {
  switch (id) {
    case 'bash':
      return P({ every: Math.round(lv(2, 1, l)), dmg: lv(26, 120, l), radius: 2.8, a: 3.0 });
    case 'knives':
      return P({ every: 6, dmg: lv(34, 150, l), radius: 3.8, count: 4 });
    case 'rage':
      return P({ a: lv(0.12, 1.0, l), b: 0.5 });
    case 'frostBlast':
      // a: movement multiplier, b: attack-speed multiplier
      return P({ every: 4, dmg: lv(80, 260, l), radius: 3.4, dur: 3, a: 1 - lv(0.45, 0.8, l), b: 1 - lv(0.2, 0.6, l) });
    case 'shield':
      return P({ every: 5, radius: 3, dur: 4, a: 0.45, count: 3 });
    case 'burnOil':
      return P({ dmg: lv(30, 140, l), radius: 3, dur: 3.2 });
    case 'explode':
      // Single-unit burst; the x2.5 factor compensates for the old grouped-squad explosion tuning.
      return P({ dmg: lv(46, 190, l) * 2.5, radius: 3, dur: 3, a: lv(24, 120, l) * 2.5 });
    case 'thorns':
      return P({ a: lv(0.1, 0.32, l) });
    case 'summonSkeleton':
      return P({ count: 1 + Math.round(((l - 1) * 3) / 9) });
    case 'heal':
      return P({ dmg: lv(7, 56, l), radius: 5 });
    case 'stun':
      // Used on every hit instead of the plain attack: the stun stays shorter than the attack interval (no permanent lock).
      return P({ dmg: lv(30, 170, l), dur: lv(0.3, 0.7, l), length: 8, half: 1.5 });
    case 'fireball':
      return P({ every: 2, dmg: lv(7, 55, l), radius: 5, count: Math.round(lv(4, 8, l)) });
    case 'lifesteal':
      return P({ a: lv(0.18, 0.34, l) });
    case 'charge':
      return P({ every: 3, dmg: lv(65, 320, l), length: 8, half: 1.2, a: 2.5 });
    case 'spearBuild':
      return P({ a: lv(0.02, 0.036, l), dur: 3, count: 20 });
    case 'withstand':
      return P({ every: 4, radius: 2.4, dur: 4, a: 0.5 });
    case 'orbs':
      return P({ every: 3, dmg: lv(22, 120, l), count: 3 });
    case 'destinyBond':
      return P({ dmg: lv(40, 900, l), count: 3, a: 0.6 });
    case 'mock':
      return P({ every: 0, radius: lv(3, 4, l), dur: 2, a: 0.7, b: 3 });
    case 'hex':
      return P({ dur: lv(0.5, 0.95, l), radius: 3.4 });
    case 'ship':
      return P({ every: 2, dur: 1.6, radius: 3.6, a: 2.5 });
    case 'taunt':
      return P({ radius: 5, dur: 2, b: 4 });
    case 'swarm':
      return P({ every: 3, dmg: lv(48, 350, l), length: 10, half: 3 });
    case 'axes':
      return P({ every: 3, dmg: lv(80, 320, l), length: 12, half: 2.4 });
    case 'fear':
      return P({ every: 3, radius: 5, dur: lv(1, 5, l) });
    case 'rockThrow':
      return P({ every: 3, dmg: lv(56, 220, l), radius: 3.4, dur: lv(0.8, 1.5, l) });
    case 'refraction':
      return P({ every: Math.round(lv(4, 3, l)), dmg: lv(78, 390, l), radius: 3.2, dur: 1 });
    case 'chill':
      return P({ every: 3, dur: 2, a: 1 - lv(0.45, 0.8, l), b: 1 - lv(0.25, 0.6, l) });
    case 'crit':
      return P({ a: 0.28, b: lv(2, 3, l) });
    case 'curseZone':
      return P({ every: 4, dmg: lv(30, 64, l), radius: 3.8, dur: 5, a: 1 - lv(0.05, 0.22, l) });
    case 'stoneWill':
      return P({ every: 0, radius: 4, dur: 2, a: 1 - lv(0.4, 0.65, l), b: 1 - lv(0.2, 0.45, l) });
    case 'cleanse':
      return P({ radius: 2.2 });
    case 'revive':
      return P({ a: 0.5 });
  }
  return base;
}

/** Visual cue for the skill radius/effect: 0 physical, 1 fire, 2 ice, 3 holy, 4 dark, 5 nature/poison, 6 energy. */
export const SKILL_ELEMENT: Partial<Record<SkillId, number>> = {
  bash: 0,
  knives: 4,
  rage: 1,
  frostBlast: 2,
  shield: 3,
  burnOil: 1,
  explode: 1,
  thorns: 5,
  summonSkeleton: 4,
  revive: 3,
  heal: 3,
  cleanse: 3,
  stun: 4,
  fireball: 1,
  lifesteal: 4,
  charge: 3,
  withstand: 3,
  orbs: 1,
  destinyBond: 4,
  mock: 1,
  hex: 1,
  ship: 0,
  taunt: 0,
  swarm: 4,
  axes: 0,
  fear: 5,
  rockThrow: 1,
  refraction: 3,
  chill: 2,
  curseZone: 6,
  stoneWill: 0,
};
