import { describe, expect, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { DEFAULT_MAP } from '../mapSpec';
import { KIND_COUNT, KIND_OF_TROOP, Kind } from '../units';

function duel(seed: number): Battle {
  const layout: number[] = [];
  for (let i = 0; i < 8; i++) {
    layout.push(0, Kind.Warrior, 20 + (i % 3) * 1.2, 28 + Math.floor(i / 3) * 1.2);
    layout.push(1, KIND_OF_TROOP.longbowmen, 29 + (i % 3) * 1.2, 28 + Math.floor(i / 3) * 1.2);
  }
  const cfg: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: false, kite: true, map: DEFAULT_MAP, layout: new Float32Array(layout) };
  return new Battle(seed, cfg);
}

function run(b: Battle, seconds: number): void {
  for (let s = 0; s < seconds * 30 && b.winner === -1; s++) b.step(1 / 30);
}

describe('damage meter', () => {
  it('credits damage to the dealing team and kind, and kills to the killer team', () => {
    const b = duel(3);
    run(b, 40);
    const sum = (team: number): number => {
      let t = 0;
      for (let k = 0; k < KIND_COUNT; k++) t += b.meter.dmg[team * KIND_COUNT + k];
      return t;
    };
    expect(sum(0)).toBeGreaterThan(0);
    expect(sum(1)).toBeGreaterThan(0);
    // Only the unit types that exist fight: warriors for team 0, longbowmen for team 1.
    expect(b.meter.dmg[0 * KIND_COUNT + Kind.Warrior]).toBe(sum(0));
    expect(b.meter.dmg[1 * KIND_COUNT + KIND_OF_TROOP.longbowmen]).toBe(sum(1));
    // Never more than the total damage counter (damage over time has no credited source).
    expect(sum(0) + sum(1)).toBeLessThanOrEqual(b.counters.damage + 1e-6);
    // Every death in a duel is caused by the other team.
    const dead0 = 8 - b.alivePerTeam[0];
    const dead1 = 8 - b.alivePerTeam[1];
    expect(b.meter.kills[1]).toBeLessThanOrEqual(dead0);
    expect(b.meter.kills[0]).toBeLessThanOrEqual(dead1);
    expect(b.meter.kills[0] + b.meter.kills[1]).toBeGreaterThan(0);
  });

  it('survives serialize/restore and is deterministic', () => {
    const a = duel(5);
    const c = duel(5);
    run(a, 12);
    run(c, 12);
    expect(Array.from(c.meter.dmg)).toEqual(Array.from(a.meter.dmg));
    const copy = duel(5);
    copy.restore(a.serialize());
    expect(Array.from(copy.meter.dmg)).toEqual(Array.from(a.meter.dmg));
    expect(Array.from(copy.meter.kills)).toEqual(Array.from(a.meter.kills));
  });
});

import { fmtDamage, fmtTime, rankRows } from '../../app/dpsMeter';

describe('damage meter helpers', () => {
  it('formats damage and time', () => {
    expect(fmtDamage(950)).toBe('950');
    expect(fmtDamage(4200)).toBe('4.2k');
    expect(fmtDamage(48200)).toBe('48.2k');
    expect(fmtDamage(1_300_000)).toBe('1.3m');
    expect(fmtTime(125)).toBe('2:05');
    expect(fmtTime(0)).toBe('0:00');
  });

  it('ranks kinds by damage with share, dps and dead detection', () => {
    const n = 5;
    const dmg = [10, 30, 0, 60, 0];
    const alive = [2, 0, 0, 5, 0];
    const total = [4, 3, 0, 6, 0];
    const fell = [-1, 95, -1, -1, -1];
    const rows = rankRows(dmg, alive, total, fell, 100);
    expect(rows.map((r) => r.kind)).toEqual([3, 1, 0]);
    expect(rows[0].share).toBe(60);
    expect(rows[1].dead).toBe(true);
    expect(rows[1].fellAt).toBe(95);
    expect(rows[2].dead).toBe(false);
    expect(rows[0].dps).toBeCloseTo(0.6, 5);
    expect(rows.length).toBeLessThanOrEqual(n);
    // Summoned units can exceed the starting total.
    expect(rankRows([5], [7], [3], [-1], 10)[0].total).toBe(7);
  });
});
