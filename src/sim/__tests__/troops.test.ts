import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP } from '../mapSpec';
import { TROOPS } from '../data/troops';
import { runScenario } from '../testing/stall';
import { KIND_OF_TROOP, LEGACY_COUNT, STATS, applyStats } from '../units';
import type { Scenario } from '../testing/scenarios';

/** Single-kind setup: team A has 6 of the given unit, team B has 6 Militia. */
function duel(kind: number, foe: number, n = 6): Scenario {
  const layout: number[] = [];
  for (let i = 0; i < n; i++) {
    layout.push(0, kind, 12 + (i % 3) * 1.3, 38 + Math.floor(i / 3) * 1.3);
    layout.push(1, foe, 40 + (i % 3) * 1.3, 14 + Math.floor(i / 3) * 1.3);
  }
  return {
    id: kind * 100,
    desc: `${STATS[kind].name} x${n} vs ${STATS[foe].name}`,
    simSeed: 7 + kind,
    config: { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: true, kite: true, terrainSeed: 3, map: DEFAULT_MAP, layout: new Float32Array(layout) },
  };
}

describe('roster birimleri', () => {
  it('45 units plus the structures (siege core, lane castle, lane tower) are defined and their stats are valid', () => {
    expect(TROOPS.length).toBe(48);
    expect(TROOPS.filter((t) => t.structure).map((t) => t.id)).toEqual(['siege-core', 'lane-castle', 'lane-tower']);
    expect(TROOPS[TROOPS.length - 1].id).toBe('lane-tower'); // structures are appended last: older kind numbers never change
    for (let i = 0; i < TROOPS.length; i++) {
      const s = STATS[LEGACY_COUNT + i];
      for (const key of ['hp', 'speed', 'range', 'power', 'cooldown', 'armor'] as const) {
        expect(Number.isFinite(s[key]) && s[key] > -1e-9, `${s.name}.${key}`).toBe(true);
      }
      expect(s.armor).toBeLessThanOrEqual(0.85);
    }
  });

  const foe = KIND_OF_TROOP.militia;
  for (const t of TROOPS.filter((x) => !x.structure)) {
    {
      it(`${t.name}: no stall/loop, reaches a result`, () => {
        applyStats(undefined);
        const kind = KIND_OF_TROOP[t.id];
        const r = runScenario(duel(kind, foe), 240);
        expect(r.flags.map((f) => `${f.type} t=${f.t}: ${f.info}`), r.scenario.desc).toEqual([]);
      });
    }
  }
});

describe('roster data is wired everywhere', () => {
  it('every roster unit id has a drawing recipe, and every recipe belongs to a roster unit', () => {
    const looks = readFileSync('src/render/looks.ts', 'utf8');
    const body = looks.slice(looks.indexOf('export const LOOKS'));
    const keys = new Set([...body.matchAll(/^ {2}'?([a-z-]+)'?: \(/gm)].map((m) => m[1]));
    const ids = TROOPS.map((t) => t.id);
    expect(ids.filter((id) => !keys.has(id))).toEqual([]);
    expect([...keys].filter((k) => !ids.includes(k))).toEqual([]);
  });

  it('every key of the projectile-tag table is a roster unit id', () => {
    const units = readFileSync('src/sim/units.ts', 'utf8');
    const m = /const TAG_OF[^{]*\{([^}]*)\}/.exec(units)!;
    const keys = [...m[1].matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((x) => x[1]);
    const ids = new Set(TROOPS.map((t) => t.id));
    expect(keys.filter((k) => !ids.has(k))).toEqual([]);
  });
});
