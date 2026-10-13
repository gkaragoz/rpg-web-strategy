import { describe, expect, it } from 'vitest';
import { BIG_ARMY_UNITS, SIM_DT, simDtFor } from '../constants';
import { benchBattle } from '../testing/benchEntry';

describe('simulation step of big armies', () => {
  it('uses 30 Hz below the threshold and 20 Hz at and above it, from the config alone', () => {
    const cfg = (n: number) => ({ mode: 'custom', layout: new Float32Array(n * 4) });
    expect(simDtFor(cfg(100))).toBe(SIM_DT);
    expect(simDtFor(cfg(BIG_ARMY_UNITS - 1))).toBe(SIM_DT);
    expect(simDtFor(cfg(BIG_ARMY_UNITS))).toBe(1 / 20);
    expect(simDtFor({ mode: 'bench', perTeam: 7000, teamCount: 2 })).toBe(1 / 20);
    expect(simDtFor({ mode: 'bench', perTeam: 100, teamCount: 2 })).toBe(SIM_DT);
  });

  it('a 20 Hz battle plays out like a 30 Hz one (same ballpark of losses after 30 s of battle time)', () => {
    const survivors = (dt: number): number => {
      const { battle } = benchBattle(300, 2, 80);
      for (let i = 0; i < Math.round(30 / dt); i++) battle.step(dt);
      return battle.alivePerTeam[0] + battle.alivePerTeam[1];
    };
    const a = survivors(1 / 30);
    const b = survivors(1 / 20);
    expect(b / a).toBeGreaterThan(0.6);
    expect(b / a).toBeLessThan(1.6);
  });
});
