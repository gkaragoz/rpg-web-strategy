import { describe, expect, it } from 'vitest';
import { Battle, terrainFor, type BattleConfig } from '../battle';
import { DEFAULT_MAP, type MapSpec } from '../mapSpec';
import { DOWNHILL_MAX, SLOPE_MIN, highGroundDamage, highGroundRange, slopeSpeed } from '../data/combat';
import { KIND_OF_TROOP, Kind } from '../units';

const SPEC: MapSpec = { ...DEFAULT_MAP, river: 'none', forest: 'none', village: 'none', relief: 'hills' };

function config(layout: number[], spec: MapSpec = SPEC, seed = 5): BattleConfig {
  return { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: true, kite: true, terrainSeed: seed, map: spec, layout: new Float32Array(layout) };
}

describe('high ground rules (pure)', () => {
  it('damage grows with the height advantage and shrinks with the disadvantage', () => {
    expect(highGroundDamage(0, false)).toBe(1);
    expect(highGroundDamage(3, false)).toBeGreaterThan(1.2);
    expect(highGroundDamage(-3, false)).toBeLessThan(0.85);
    expect(highGroundDamage(3, true)).toBeLessThan(highGroundDamage(3, false));
    expect(highGroundDamage(50, false)).toBeLessThanOrEqual(1.35);
    expect(highGroundDamage(-50, false)).toBeGreaterThanOrEqual(0.7);
  });

  it('range bonus: advantage extends, disadvantage shortens, both are capped', () => {
    expect(highGroundRange(0)).toBe(0);
    expect(highGroundRange(2)).toBeGreaterThan(1);
    expect(highGroundRange(20)).toBe(1.8);
    expect(highGroundRange(-1)).toBeLessThan(0);
    expect(highGroundRange(-20)).toBe(-1.2);
  });

  it('climbing slows by steepness, heavy units more, downhill is slightly faster', () => {
    expect(slopeSpeed(0, false)).toBe(1);
    expect(slopeSpeed(0.5, false)).toBeLessThan(0.7);
    expect(slopeSpeed(1, false)).toBeLessThan(slopeSpeed(0.5, false));
    expect(slopeSpeed(1, true)).toBeLessThan(slopeSpeed(1, false));
    expect(slopeSpeed(10, false)).toBe(SLOPE_MIN);
    expect(slopeSpeed(-1, false)).toBeLessThanOrEqual(1 + DOWNHILL_MAX);
    expect(slopeSpeed(-1, false)).toBeGreaterThan(1);
  });
});

/** A top tile >= 3 steps high, and a lower tile 5-8 tiles away (to shoot across the slope). */
function hillPair(spec: MapSpec, seed: number): { hi: [number, number]; lo: [number, number] } | null {
  const probe = config([0, Kind.Warrior, 5, 5, 1, Kind.Warrior, 50, 50], spec, seed);
  const t = terrainFor(probe)!;
  for (let y = 4; y < 52; y += 2) {
    for (let x = 4; x < 52; x += 2) {
      if (!t.walkable(x + 0.5, y + 0.5) || t.heightAt(x + 0.5, y + 0.5) < 3) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7]]) {
        for (const d of [6, 7, 8]) {
          const lx = x + 0.5 + dx * d;
          const ly = y + 0.5 + dy * d;
          if (lx > 3 && ly > 3 && lx < 53 && ly < 53 && t.walkable(lx, ly) && t.heightAt(lx, ly) < 1.2 && t.reachable(lx, ly)) return { hi: [x + 0.5, y + 0.5], lo: [lx, ly] };
        }
      }
    }
  }
  return null;
}

function cluster(team: number, kind: number, cx: number, cy: number, n: number, out: number[]): void {
  for (let i = 0; i < n; i++) out.push(team, kind, cx + (i % 3) * 0.8 - 0.8, cy + Math.floor(i / 3) * 0.8 - 0.8);
}

describe('high ground in battle', () => {
  it('equal archer armies: the side holding the hill wins clearly more often', () => {
    const archer = KIND_OF_TROOP.longbowmen;
    let highWins = 0;
    let games = 0;
    for (const seed of [3, 5, 7, 9, 11, 13, 17, 19]) {
      const pair = hillPair(SPEC, seed);
      if (!pair) continue;
      for (const topTeam of [0, 1]) {
        const layout: number[] = [];
        cluster(topTeam, archer, pair.hi[0], pair.hi[1], 9, layout);
        cluster(1 - topTeam, archer, pair.lo[0], pair.lo[1], 9, layout);
        const b = new Battle(seed, config(layout, SPEC, seed));
        for (let s = 0; s < 30 * 120 && b.winner === -1; s++) b.step(1 / 30);
        games++;
        if (b.winner === topTeam) highWins++;
      }
    }
    expect(games).toBeGreaterThanOrEqual(8);
    expect(highWins / games).toBeGreaterThan(0.6);
  });
});
