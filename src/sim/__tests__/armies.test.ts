import { describe, expect, it } from 'vitest';
import { composeArmy, composeFromKind, laneOf, placeableKinds, unitCost } from '../../app/armies';
import { mulberry32 } from '../random';
import { KIND_OF_TROOP, STATS } from '../units';

describe('role-based army composition', () => {
  it('Tauntman was removed, skeletons cannot be placed', () => {
    expect(KIND_OF_TROOP.tauntman).toBeUndefined();
    expect(placeableKinds()).not.toContain(KIND_OF_TROOP['bone-soldier']);
  });

  it('every lane is filled, counts are reasonable and cost stays within budget', () => {
    const rnd = mulberry32(3);
    for (let i = 0; i < 100; i++) {
      const a = composeArmy(rnd);
      expect(a.front.length).toBeGreaterThan(0);
      expect(a.mid.length).toBeGreaterThan(0);
      expect(a.back.length).toBeGreaterThan(0);
      const cost = [...a.front, ...a.mid, ...a.back].reduce((s, k) => s + unitCost(k), 0);
      expect(cost).toBeLessThan(26 * 2.2);
      const n = a.front.length + a.mid.length + a.back.length;
      expect(n).toBeLessThanOrEqual(14 * 6);
      for (const k of a.front) expect(['front']).toContain(laneOf(k));
    }
  });

  it('the selected kind goes into its own lane', () => {
    const rnd = mulberry32(9);
    for (const k of placeableKinds()) {
      const a = composeFromKind(k, rnd);
      expect(a[laneOf(k)], STATS[k].name).toContain(k);
    }
  });
});
