import type { Battle } from '../battle';
import type { ModeHud, ModeRules } from './types';

/** The original rules: last team standing (plus the no-damage draws in Battle). Does nothing, changes nothing. */
export class ClassicRules implements ModeRules {
  readonly id = 'classic' as const;
  init(_b: Battle): void {}
  step(_b: Battle, _dt: number): void {}
  winner(_b: Battle): number | undefined {
    return undefined;
  }
  serialize(): number[] {
    return [];
  }
  restore(_state: number[]): void {}
  hud(_b: Battle): ModeHud {
    return { kind: 'classic' };
  }
  scores(): number[] | undefined {
    return undefined;
  }
}
