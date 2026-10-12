import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { makeScenario } from '../testing/scenarios';
import { runScenario, type RunResult } from '../testing/stall';

// FUZZ_N: kac senaryo, FUZZ_START: baslangic id, HUNT=1: hatalari toplayip raporla (testi dusurme).
const N = Number(process.env.FUZZ_N ?? 120);
const START = Number(process.env.FUZZ_START ?? 1);
const HUNT = process.env.HUNT === '1';
const results: RunResult[] = [];

describe('rastgele senaryolar (takilma / dongu / sonuc)', () => {
  for (let id = START; id < START + N; id++) {
    it(`senaryo ${id}`, () => {
      const sc = makeScenario(id);
      const r = runScenario(sc);
      results.push(r);
      if (!HUNT) expect(r.flags.map((f) => `${f.type} t=${f.t}: ${f.info}`), sc.desc).toEqual([]);
    });
  }

  it('determinizm: ayni tohum ayni sonuc', () => {
    for (const id of [3, 17, 42]) {
      const a = runScenario(makeScenario(id), 60, false);
      const b = runScenario(makeScenario(id), 60, false);
      expect(b.signature, `senaryo ${id}`).toBe(a.signature);
    }
  });

  afterAll(() => {
    const byType = new Map<string, Array<{ id: number; desc: string; info: string }>>();
    for (const r of results) {
      for (const f of r.flags) {
        const arr = byType.get(f.type) ?? [];
        arr.push({ id: r.scenario.id, desc: r.scenario.desc, info: `t=${f.t} ${f.info}` });
        byType.set(f.type, arr);
      }
    }
    const secs = results.map((r) => r.secs).sort((a, b) => a - b);
    const lines: string[] = [
      `=== FUZZ OZETI: ${results.length} senaryo, ${results.filter((r) => r.flags.length > 0).length} tanesinde bayrak ===`,
      `sure (sn): medyan ${secs[Math.floor(secs.length / 2)]}, p90 ${secs[Math.floor(secs.length * 0.9)]}, max ${secs[secs.length - 1]}`,
      `kazanan yok (-1): ${results.filter((r) => r.winner === -1).length}, berabere (-2): ${results.filter((r) => r.winner === -2).length}`,
      `ortalama birim: ${(results.reduce((a, r) => a + r.initialUnits, 0) / Math.max(1, results.length)).toFixed(0)}`,
    ];
    for (const [type, arr] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const scen = new Set(arr.map((x) => x.id));
      lines.push(`- ${type}: ${arr.length} bayrak, ${scen.size} senaryo`);
      const seen = new Set<number>();
      for (const x of arr) {
        if (seen.size >= 4 || seen.has(x.id)) continue;
        seen.add(x.id);
        lines.push(`    ${x.desc}\n      -> ${x.info}`);
      }
    }
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/fuzz-report.txt', lines.join('\n') + '\n');
  });
});
