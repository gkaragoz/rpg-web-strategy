import { describe, expect, it } from 'vitest';
import { makeRosterScenario } from '../testing/scenarios';
import { runScenario } from '../testing/stall';

// ROSTER_N: number of scenarios, ROSTER_START: first id. Random stall/loop sweep using roster units.
const N = Number(process.env.ROSTER_N ?? 80);
const START = Number(process.env.ROSTER_START ?? 1);

describe('random scenarios with roster units', () => {
  for (let id = START; id < START + N; id++) {
    it(`scenario ${id}`, () => {
      const sc = makeRosterScenario(id);
      if (process.env.ROSTER_COMEDY === '1') sc.config = { ...sc.config, comedy: true };
      const r = runScenario(sc);
      expect(r.flags.map((f) => `${f.type} t=${f.t}: ${f.info}`), sc.desc).toEqual([]);
    });
  }
});
