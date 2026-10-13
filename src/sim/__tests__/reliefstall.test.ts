import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP, LAYOUTS, RELIEFS } from '../mapSpec';
import { makeScenario } from '../testing/scenarios';
import { runScenario } from '../testing/stall';

// Every relief x layout combination must still produce fights that finish: no units stuck on slopes, no idle chasers,
// no oscillation at the foot of a cliff (the stall detector watches for all of these).
const ALL = process.env.RELIEF_ALL === '1';
describe('relief stall detection', () => {
  let n = 0;
  for (const relief of RELIEFS) {
    for (const layout of LAYOUTS) {
      for (const id of [11, 12]) {
        n++;
        if (!ALL && n % 2 === 0) continue; // half of the grid in the regular run, everything with RELIEF_ALL=1
        it(`${relief}/${layout} scenario ${id}`, () => {
          const sc = makeScenario(id);
          sc.config = { ...sc.config, env: true, map: { ...DEFAULT_MAP, relief, layout } };
          const r = runScenario(sc);
          expect(r.flags.map((f) => `${f.type} t=${f.t}: ${f.info}`), `${relief}/${layout} ${sc.desc}`).toEqual([]);
        });
      }
    }
  }
});
