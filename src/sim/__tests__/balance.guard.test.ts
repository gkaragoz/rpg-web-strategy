import { describe, expect, it } from 'vitest';
import { aggregate, makeJobs, playableKinds, runFight, type Played } from '../testing/balance';

// A small slice of the headless tournament (every third unit, one map): a regression guard for the calibrated balance.
// The full tournament and the calibration run with `npm run balance` (see docs/UNITS.md).
describe('balance guard', () => {
  it('no unit dominates or is useless, and every unit has counters and victims', () => {
    const kinds = playableKinds().filter((_, i) => i % 3 === 0);
    const jobs = makeJobs(kinds, ['open'], 1, 900, 120);
    const played: Played[] = jobs.map((job) => ({ job, res: runFight(job) }));
    const t = aggregate(kinds, played);
    const bad = t.rows.filter((r) => r.rate > 0.8 || r.rate < 0.2 || r.clearWins < 1 || r.clearLosses < 1).map((r) => `${r.name} ${(r.rate * 100).toFixed(0)}% wins ${r.clearWins} losses ${r.clearLosses}`);
    expect(bad).toEqual([]);
    expect(t.draws / t.fights).toBeLessThan(0.1);
  }, 240000);
});
