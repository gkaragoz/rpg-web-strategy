import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Battle } from '../battle';
import { makeRosterScenario, makeScenario } from '../testing/scenarios';

/**
 * Golden hashes: the simulation result for fixed (scenario, seed, step) triples is committed in `golden.json`. Any change to the
 * sim (including pure refactors such as splitting files) that alters a result shows up here. When a change is intended, regenerate
 * with `GOLDEN_UPDATE=1 npx vitest run src/sim/__tests__/golden.test.ts` and commit the new file together with the sim change.
 */
const FILE = fileURLToPath(new URL('./golden.json', import.meta.url));
const STEPS = [60, 300, 900];
const CASES: Array<{ name: string; roster: boolean; id: number; comedy: boolean }> = [
  { name: 'classic-3', roster: false, id: 3, comedy: false },
  { name: 'classic-42-comedy', roster: false, id: 42, comedy: true },
  { name: 'classic-9', roster: false, id: 9, comedy: false },
  { name: 'roster-17', roster: true, id: 17, comedy: false },
  { name: 'roster-77-comedy', roster: true, id: 77, comedy: true },
  { name: 'roster-5', roster: true, id: 5, comedy: false },
  { name: 'roster-23', roster: true, id: 23, comedy: false },
  { name: 'roster-31', roster: true, id: 31, comedy: false },
];

interface Golden {
  hashes: number[];
  winner: number;
  kills: number;
}

function run(c: (typeof CASES)[number]): Golden {
  const sc = c.roster ? makeRosterScenario(c.id) : makeScenario(c.id);
  const b = new Battle(sc.simSeed, { ...sc.config, comedy: c.comedy });
  const hashes: number[] = [];
  let step = 0;
  for (const target of STEPS) {
    while (step < target && b.winner === -1) {
      b.step(1 / 30);
      step++;
    }
    hashes.push(b.hash());
  }
  return { hashes, winner: b.winner, kills: b.counters.kills };
}

describe('golden simulation results', () => {
  const update = process.env.GOLDEN_UPDATE === '1';
  const stored: Record<string, Golden> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  const fresh: Record<string, Golden> = {};

  for (const c of CASES) {
    it(`${c.name} matches the committed hashes`, () => {
      const got = run(c);
      fresh[c.name] = got;
      if (update) return;
      expect(stored[c.name], 'missing golden entry; run with GOLDEN_UPDATE=1').toBeDefined();
      expect(got).toEqual(stored[c.name]);
    });
  }

  it('writes the golden file when asked to', () => {
    if (!update) return;
    writeFileSync(FILE, JSON.stringify(fresh, null, 2) + '\n');
  });
});
