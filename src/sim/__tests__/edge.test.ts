import { describe, expect, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { Terrain } from '../terrain';
import { runScenario, computeRegions } from '../testing/stall';
import type { Scenario } from '../testing/scenarios';
import { Kind } from '../units';

type U = [team: number, kind: number, x: number, y: number];

function scenario(desc: string, units: U[], extra: Partial<BattleConfig> = {}): Scenario {
  return {
    id: 0,
    desc,
    simSeed: 7,
    config: {
      mode: 'custom',
      perTeam: 0,
      teamCount: Math.max(2, ...units.map((u) => u[0] + 1)),
      mapSize: 56,
      env: false,
      kite: true,
      terrainSeed: 1,
      layout: new Float32Array(units.flat()),
      ...extra,
    },
  };
}

const repeat = (n: number, f: (i: number) => U): U[] => Array.from({ length: n }, (_, i) => f(i));

describe('targeted edge-case tests', () => {
  it('priests only vs priests only (nobody can deal damage) still reaches a result', () => {
    const sc = scenario('priest vs priest', [
      ...repeat(3, (i) => [0, Kind.Priest, 20 + i, 28] as U),
      ...repeat(3, (i) => [1, Kind.Priest, 34 + i, 28] as U),
    ]);
    const r = runScenario(sc, 120);
    expect(r.winner, r.flags.map((f) => f.type + ': ' + f.info).join(' | ')).not.toBe(-1);
  });

  it('a single archer vs many priests: the battle ends even if healing outpaces damage', () => {
    const sc = scenario('archer vs priests', [[0, Kind.Archer, 20, 28], ...repeat(6, (i) => [1, Kind.Priest, 32 + (i % 3), 27 + Math.floor(i / 3)] as U)]);
    const r = runScenario(sc, 240);
    expect(r.winner, r.flags.map((f) => f.type + ': ' + f.info).join(' | ')).not.toBe(-1);
  });

  it('a healing tank team vs weak attackers does not lock the battle', () => {
    const sc = scenario('tank+priest vs warrior+archer', [
      ...repeat(2, (i) => [0, Kind.Shield, 20 + i, 28] as U),
      ...repeat(6, (i) => [0, Kind.Priest, 17 + (i % 3), 27 + Math.floor(i / 3)] as U),
      [1, Kind.Warrior, 34, 28],
      [1, Kind.Archer, 36, 28],
    ]);
    const r = runScenario(sc, 300);
    expect(r.winner, r.flags.map((f) => f.type + ': ' + f.info).join(' | ')).not.toBe(-1);
  });

  it('tanks vs a warrior swarm: a stun chain does not lock the battle', () => {
    const sc = scenario('2 hammers + shield vs 10 warriors', [
      [0, Kind.Shield, 24, 28],
      [0, Kind.Brute, 25, 27],
      [0, Kind.Brute, 25, 29],
      ...repeat(10, (i) => [1, Kind.Warrior, 31 + (i % 3) * 0.8, 26 + Math.floor(i / 3) * 0.8] as U),
    ]);
    const r = runScenario(sc, 300);
    expect(r.winner, r.flags.map((f) => f.type + ': ' + f.info).join(' | ')).not.toBe(-1);
    expect(r.flags.filter((f) => f.type === 'cannotHit' || f.type === 'idleChaser').map((f) => f.info)).toEqual([]);
  });

  it("the attackers counter does not overflow when 300 attackers target a single unit", () => {
    const units: U[] = [[1, Kind.Shield, 28, 28], ...repeat(300, (i) => [0, Kind.Warrior, 20 + (i % 20) * 0.5, 18 + Math.floor(i / 20) * 0.5] as U)];
    const b = new Battle(3, scenario('overflow', units, { mapSize: 56 }).config);
    for (let s = 0; s < 60; s++) b.step(1 / 30);
    const u = b.units;
    let targeting = 0;
    for (let i = 1; i < u.count; i++) if (u.alive[i] && u.target[i] === 0) targeting++;
    expect(targeting).toBeGreaterThan(260);
    // The counter must reflect the real attacker count (it must not wrap at 255)
    expect(u.attackers[0]).toBeGreaterThanOrEqual(Math.min(targeting, 65000) - 5);
  });

  it('spawning stacked on the same point: no NaN, all alive and the battle ends', () => {
    const sc = scenario('stack', [
      ...repeat(60, () => [0, Kind.Warrior, 20, 28] as U),
      ...repeat(60, () => [1, Kind.Warrior, 36, 28] as U),
    ]);
    const r = runScenario(sc, 240);
    expect(r.invariants).toEqual([]);
    expect(r.winner, r.flags.map((f) => f.type + ': ' + f.info).join(' | ')).not.toBe(-1);
  });

  it('an enemy in an unreachable enclosed region: the battle ends (no deadlock)', () => {
    // Search the maps for a disconnected walkable region; use the first one found.
    let found: { seed: number; terrain: Terrain; region: Int32Array; small: number; main: number } | null = null;
    for (let seed = 1; seed <= 300 && !found; seed++) {
      const t = new Terrain(56, { seed, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
      const region = computeRegions(t);
      const sizes = new Map<number, number>();
      for (const r of region) if (r >= 0) sizes.set(r, (sizes.get(r) ?? 0) + 1);
      if (sizes.size < 2) continue;
      const sorted = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
      const [main] = sorted[0];
      const small = sorted.find(([id, n]) => id !== main && n >= 1)?.[0];
      if (small !== undefined) found = { seed, terrain: t, region, small, main };
    }
    if (!found) return; // no problem if no enclosed region is ever generated
    const n = found.terrain.size;
    const pick = (id: number): [number, number] => {
      for (let i = 0; i < found!.region.length; i++) if (found!.region[i] === id) return [(i % n) + 0.5, Math.floor(i / n) + 0.5];
      return [1, 1];
    };
    const a = pick(found.main);
    const c = pick(found.small);
    const sc = scenario(`enclosed region seed=${found.seed}`, [[0, Kind.Warrior, a[0], a[1]], [0, Kind.Archer, a[0] + 0.5, a[1]], [1, Kind.Warrior, c[0], c[1]]], { env: true, terrainSeed: found.seed });
    const r = runScenario(sc, 150);
    expect(r.winner, `seed ${found.seed}: ${r.flags.map((f) => f.type + ': ' + f.info).join(' | ')}`).not.toBe(-1);
  });
});
