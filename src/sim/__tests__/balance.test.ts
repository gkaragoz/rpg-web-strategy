import { describe, expect, it } from 'vitest';
import { KIND_OF_TROOP } from '../units';
import { aggregate, armySize, makeJobs, playableKinds, runFight, scoreOf, type Played } from '../testing/balance';

// Full tournaments run headless with `npm run balance` (see docs/TESTING.md); these tests guard the harness itself.
describe('balance harness', () => {
  const a = KIND_OF_TROOP.militia;
  const b = KIND_OF_TROOP.longbowmen;

  it('fights are deterministic and use equal gold', () => {
    const job = { a, b, scenario: 'open', seed: 3, gold: 200, cap: 40 };
    const r1 = runFight(job);
    const r2 = runFight(job);
    expect(r2).toEqual(r1);
    expect(r1.winner).not.toBe(-1);
    expect(r1.nA).toBe(armySize(a, 200, 40));
  });

  it('swapping the sides mirrors the score', () => {
    const jobs = makeJobs([a, b], ['open'], 1, 200, 40);
    expect(jobs.length).toBe(2);
    const played: Played[] = jobs.map((job) => ({ job, res: runFight(job) }));
    const t = aggregate([a, b], played);
    expect(t.matrix[0][1] + t.matrix[1][0]).toBeCloseTo(1, 9);
    expect(scoreOf({ winner: -2, time: 0, nA: 1, nB: 1, left: 0 })).toBe(0.5);
  });

  it('playable kinds exclude summoned units', () => {
    const kinds = playableKinds();
    expect(kinds.includes(KIND_OF_TROOP['bone-soldier'])).toBe(false);
    expect(kinds.length).toBe(49);
  });
});
