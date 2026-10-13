import { describe, expect, it } from 'vitest';
import { makeRosterScenario } from '../testing/scenarios';
import { runScenario } from '../testing/stall';

// ROSTER_N: kac senaryo, ROSTER_START: baslangic id. Roster birimleriyle rastgele takilma/dongu taramasi.
const N = Number(process.env.ROSTER_N ?? 80);
const START = Number(process.env.ROSTER_START ?? 1);

describe('roster birimli rastgele senaryolar', () => {
  for (let id = START; id < START + N; id++) {
    it(`senaryo ${id}`, () => {
      const sc = makeRosterScenario(id);
      if (process.env.ROSTER_COMEDY === '1') sc.config = { ...sc.config, comedy: true };
      const r = runScenario(sc);
      expect(r.flags.map((f) => `${f.type} t=${f.t}: ${f.info}`), sc.desc).toEqual([]);
    });
  }
});
