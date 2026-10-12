import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP } from '../mapSpec';
import { TROOPS } from '../data/troops';
import { runScenario } from '../testing/stall';
import { KIND_OF_TROOP, LEGACY_COUNT, STATS, applyStats } from '../units';
import type { Scenario } from '../testing/scenarios';

/** Tek tur dizilimi: A takimi 6 birim, B takimi 6 Militia; verilen seviye. */
function duel(kind: number, foe: number, level: number, n = 6): Scenario {
  const layout: number[] = [];
  for (let i = 0; i < n; i++) {
    layout.push(0, kind, 12 + (i % 3) * 1.3, 38 + Math.floor(i / 3) * 1.3);
    layout.push(1, foe, 40 + (i % 3) * 1.3, 14 + Math.floor(i / 3) * 1.3);
  }
  return {
    id: kind * 100 + level,
    desc: `${STATS[kind].name} x${n} L${level} vs ${STATS[foe].name}`,
    simSeed: 7 + kind,
    config: { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: true, kite: true, terrainSeed: 3, map: DEFAULT_MAP, level, layout: new Float32Array(layout) },
  };
}

describe('roster birimleri', () => {
  it('46 birim tanimli ve istatistikleri gecerli', () => {
    expect(TROOPS.length).toBe(46);
    for (let i = 0; i < TROOPS.length; i++) {
      const s = STATS[LEGACY_COUNT + i];
      for (const key of ['hp', 'speed', 'range', 'power', 'cooldown', 'armor'] as const) {
        expect(Number.isFinite(s[key]) && s[key] > -1e-9, `${s.name}.${key}`).toBe(true);
      }
      expect(s.armor).toBeLessThanOrEqual(0.85);
    }
  });

  const foe = KIND_OF_TROOP.militia;
  for (const t of TROOPS) {
    for (const level of [1, 10]) {
      it(`${t.name} seviye ${level}: takilma/dongu yok, sonuca ulasir`, () => {
        applyStats(undefined, level);
        const kind = KIND_OF_TROOP[t.id];
        const r = runScenario(duel(kind, foe, level), 240);
        expect(r.flags.map((f) => `${f.type} t=${f.t}: ${f.info}`), r.scenario.desc).toEqual([]);
      });
    }
  }
});
