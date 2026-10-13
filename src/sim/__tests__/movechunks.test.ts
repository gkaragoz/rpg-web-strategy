import { describe, expect, it } from 'vitest';
import { chunkSize, MAX_CHUNKS } from '../mover';
import { benchBattle } from '../testing/benchEntry';

/** The movement phase is split into chunks that helper threads take in any order: the result must not depend on that order. */
describe('movement chunks', () => {
  it('chunk size depends only on the unit count and gives at most MAX_CHUNKS chunks', () => {
    for (const n of [10, 255, 256, 1000, 5000, 30000]) {
      const size = chunkSize(n);
      expect(Math.ceil(n / size)).toBeLessThanOrEqual(MAX_CHUNKS);
      expect(size % 64).toBe(0);
    }
  });

  it('natural, reversed and shuffled chunk order give the same battle', () => {
    const run = (order: ((n: number) => number[]) | null): number => {
      const { battle } = benchBattle(900, 2, 90);
      battle.chunkOrder = order;
      for (let i = 0; i < 160; i++) battle.step(1 / 30);
      return battle.hash();
    };
    const natural = run(null);
    expect(run((n) => Array.from({ length: n }, (_, k) => n - 1 - k))).toBe(natural);
    let seed = 5;
    const shuffled = (n: number): number[] => {
      const a = Array.from({ length: n }, (_, k) => k);
      for (let k = n - 1; k > 0; k--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const j = seed % (k + 1);
        [a[k], a[j]] = [a[j], a[k]];
      }
      return a;
    };
    expect(run(shuffled)).toBe(natural);
  });
});
