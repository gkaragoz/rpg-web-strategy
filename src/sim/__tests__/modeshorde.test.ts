import { describe, expect, it } from 'vitest';
import { isStructure } from '../units';
import { placeableKinds } from '../../app/armies';
import { mapSizeForPlayers, teamZones } from '../../net/economy';
import { Battle, type BattleConfig, unitCapacity } from '../battle';
import { hordeTeamIndex, humanTeamCount, teamGroups, totalTeamCount } from '../battleConfig';
import { killUnit } from '../battleDamage';
import { InlineSim } from '../inlineSim';
import {
  GAME_MODE_IDS,
  HORDE_FIRST_WAVE,
  HORDE_INTERVAL,
  HORDE_MAX_HUMANS,
  HORDE_MIX,
  HORDE_TIME_LIMIT,
  HORDE_WAVES,
  hordeKind,
  hordePoolSize,
  hordeWaveSize,
  isGameModeId,
  modeFor,
  structureKinds,
  type ModeHud,
} from '../modes';
import { HORDE_ROSTER, hordeWaveOffset, hordeWaveStep } from '../modes/hordeWaves';
import { PRESETS } from '../mapSpec';
import { F_LEN, F_MODE_ON, readModeHud, writeModeHud } from '../shared';
import { packSnapshot, unpackSnapshot } from '../snapshot';
import { hordeScenario, runHorde } from '../testing/hordeBalance';
import { Terrain } from '../terrain';
import { KIND_OF_TROOP, Kind, STATS, STRUCT_OF } from '../units';
import { TROOPS } from '../data/troops';

const DT = 1 / 30;
const SPS = 30;

type HordeHud = Extract<ModeHud, { kind: 'horde' }>;

function hud(b: Battle): HordeHud {
  const h = b.modeHud();
  if (h.kind !== 'horde') throw new Error('not a horde battle');
  return h;
}

/** Flat layout rows: [team, kind, x, y]. */
type Row = [number, number, number, number];

function battle(rows: Row[], opts: Partial<BattleConfig> = {}, seed = 7): Battle {
  const teams = Math.max(...rows.map((r) => r[0])) + 1;
  return new Battle(seed, { mode: 'custom', perTeam: 0, teamCount: teams, mapSize: 56, env: false, kite: true, terrainSeed: 3, layout: new Float32Array(rows.flat()), rules: 'horde', ...opts });
}

function cluster(team: number, kind: number, cx: number, cy: number, n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push([team, kind, cx + (i % 4) * 1.2, cy + Math.floor(i / 4) * 1.2]);
  return out;
}

/** Two allied human teams in the middle of an open map. */
const TWO: Row[] = [...cluster(0, Kind.Warrior, 22, 24, 8), ...cluster(1, Kind.Archer, 28, 24, 8)];

function invulnerable(b: Battle, from = 0, to = b.hordeTeam): void {
  const u = b.units;
  for (let i = 0; i < u.count; i++) if (u.team[i] >= from && u.team[i] < to) u.invulnT[i] = 1e9;
}

function hordeUnits(b: Battle): number[] {
  const out: number[] = [];
  const u = b.units;
  for (let i = 0; i < u.count; i++) if (u.team[i] === b.hordeTeam) out.push(i);
  return out;
}

function run(b: Battle, steps: number): void {
  for (let s = 0; s < steps && b.winner === -1; s++) b.step(DT);
}

function runUntilWave(b: Battle, wave: number): void {
  for (let s = 0; s < 40000 && hud(b).wave < wave && b.winner === -1; s++) b.step(DT);
}

describe('horde mode: wiring', () => {
  it('horde is a known mode with its own rules, no structure kinds and constants as specified', () => {
    expect(GAME_MODE_IDS).toContain('horde');
    expect(isGameModeId('horde')).toBe(true);
    expect(modeFor('horde').id).toBe('horde');
    expect(modeFor('horde').lastStanding).toBe(false);
    // The monsters are not placed by anyone, so the app asks for their kinds to bake them into the atlas (no structures).
    expect(structureKinds('horde').length).toBeGreaterThan(20);
    expect(structureKinds('horde').every((k) => !isStructure(k))).toBe(true);
    expect([HORDE_WAVES, HORDE_FIRST_WAVE, HORDE_INTERVAL, HORDE_TIME_LIMIT, HORDE_MAX_HUMANS]).toEqual([12, 15, 25, 900, 5]);
    expect(HORDE_MIX.length).toBe(HORDE_WAVES);
    for (const row of HORDE_MIX) expect(row.reduce((a, c) => a + c, 0)).toBe(100);
  });

  it('wave n has 4 + 3(n-1) units per human team', () => {
    for (let n = 1; n <= HORDE_WAVES; n++) expect(hordeWaveSize(n, 1)).toBe(4 + 3 * (n - 1));
    expect(hordeWaveSize(12, 1)).toBe(37);
    expect(hordePoolSize(1)).toBe(246);
    expect(hordePoolSize(3)).toBe(246 * 3);
    expect(hordeWaveSize(5, 4)).toBe(16 * 4);
  });

  it('team helpers: the horde team index is the number of human teams; classic teams are their own groups', () => {
    const cfg = (teamCount: number | undefined, rules?: BattleConfig['rules']): BattleConfig => ({ mode: 'custom', perTeam: 0, teamCount, rules });
    expect(hordeTeamIndex(cfg(3, 'horde'))).toBe(3);
    expect(totalTeamCount(cfg(3, 'horde'))).toBe(4);
    expect(teamGroups(cfg(3, 'horde'))).toEqual([0, 0, 0, 3]);
    expect(teamGroups(cfg(1, 'horde'))).toEqual([0, 1]);
    expect(hordeTeamIndex(cfg(3))).toBe(-1);
    expect(teamGroups(cfg(4, 'siege'))).toEqual([0, 1, 2, 3]);
    expect(teamGroups(cfg(undefined))).toEqual([0, 1]);
    // At most five human teams: the horde needs the sixth index.
    expect(humanTeamCount(cfg(6, 'horde'))).toBe(5);
    expect(totalTeamCount(cfg(6, 'horde'))).toBe(6);
    expect(humanTeamCount(cfg(9, 'horde'))).toBe(5);
    expect(humanTeamCount(cfg(0, 'horde'))).toBe(1);
    expect(humanTeamCount(cfg(6))).toBe(6);
  });

  it('the pool reserved by unitCapacity is exactly the dormant horde, and only horde reserves it', () => {
    for (const teams of [1, 2, 3, 5]) {
      const rows: Row[] = [];
      for (let t = 0; t < teams; t++) rows.push(...cluster(t, Kind.Warrior, 6 + t * 8, 10, 3));
      const b = battle(rows, { teamCount: teams });
      const cfg = b.config;
      expect(b.units.cap).toBe(unitCapacity(cfg));
      expect(b.units.count).toBe(rows.length + hordePoolSize(teams));
      expect(unitCapacity(cfg)).toBe(rows.length + 16 + hordePoolSize(teams));
      expect(b.hordeTeam).toBe(teams);
      expect(b.alivePerTeam.slice(0, teams + 1)).toEqual([...new Array(teams).fill(3), 0]);
    }
    const base: BattleConfig = { mode: 'custom', perTeam: 0, mapSize: 56, layout: new Float32Array(TWO.flat()) };
    expect(unitCapacity({ ...base, rules: 'horde' }) - unitCapacity(base)).toBe(hordePoolSize(2));
    for (const rules of ['hill', 'vip', 'ctf', 'classic'] as const) expect(unitCapacity({ ...base, rules })).toBe(unitCapacity(base));
  });

  it('roster: horde kinds are placeable, not structures, not summoned and need no placement-time setup', () => {
    expect(HORDE_ROSTER.length).toBe(4);
    for (const tier of HORDE_ROSTER) expect(tier.length).toBeGreaterThan(0);
    const placeable = new Set(placeableKinds());
    HORDE_ROSTER.forEach((tier, r) => {
      for (const k of tier) {
        expect(placeable.has(k)).toBe(true);
        expect(STRUCT_OF[k]).toBe(0);
        expect(['summonSkeleton', 'destinyBond']).not.toContain(STATS[k].skill);
        expect(TROOPS.find((t) => t.id === STATS[k].troop)!.rarity).toBe(['common', 'rare', 'epic', 'legendary'][r]);
      }
    });
    expect(HORDE_ROSTER.flat()).not.toContain(KIND_OF_TROOP['bone-caller']);
  });
});

describe('horde mode: alliances', () => {
  it('allied teams are not enemies; the horde is the only enemy of every human team', () => {
    const b = battle([...TWO, ...cluster(2, Kind.Shield, 24, 30, 4)], { teamCount: 3 });
    expect(b.group).toEqual([0, 0, 0, 3]);
    run(b, 460); // wave 1 is up
    expect(b.alivePerTeam[3]).toBeGreaterThan(0);
    expect(b.enemyList[0]).toEqual([3]);
    expect(b.enemyList[1]).toEqual([3]);
    expect(b.enemyList[2]).toEqual([3]);
    expect(b.enemyList[3]).toEqual([0, 1, 2]);
    expect(b.nearestEnemy[0]).toBe(3);
    expect(b.nearestEnemy[3]).toBeGreaterThanOrEqual(0);
    expect(b.selfList[0]).toEqual([0, 1, 2]);
    expect(b.selfList[3]).toEqual([3]);
  });

  it('no unit ever targets an ally (all rosters, three allied teams)', () => {
    const rows: Row[] = [];
    const kinds = placeableKinds();
    kinds.forEach((k, i) => rows.push([i % 3, k, 20 + (i % 7) * 1.3, 20 + Math.floor(i / 7) * 1.3]));
    const b = battle(rows, { teamCount: 3, mapSize: 80 });
    let waves = 0;
    for (let s = 0; s < 1200; s++) {
      b.step(DT);
      waves = hud(b).wave;
      const u = b.units;
      for (let i = 0; i < u.count; i++) {
        const t = u.target[i];
        if (!u.alive[i] || t < 0) continue;
        const sameSide = b.group[u.team[i]] === b.group[u.team[t]];
        // Healers target allies on purpose; everyone else must target the other side.
        if (STATS[u.kind[i]].role === 2) expect(sameSide).toBe(true);
        else if (u.tauntT[i] <= 0) expect(sameSide, `unit ${i} kind ${u.kind[i]} -> ${t}`).toBe(false);
      }
    }
    expect(waves).toBeGreaterThanOrEqual(2);
  });

  it('no damage, area strike, projectile or effect ever crosses between allies', () => {
    const rows: Row[] = [];
    placeableKinds().forEach((k, i) => rows.push([i % 3, k, 24 + (i % 7) * 1.1, 24 + Math.floor(i / 7) * 1.1]));
    const b = battle(rows, { teamCount: 3, mapSize: 80 });
    const pairs = new Set<string>();
    (b.mode as { onDamage?: unknown }).onDamage = (bb: Battle, j: number, dealt: number, src: number) => {
      if (src >= 0 && dealt > 0) pairs.add(`${bb.units.team[src]}>${bb.units.team[j]}`);
    };
    Object.defineProperty(b, 'modeDamages', { value: true });
    run(b, 2400);
    expect(pairs.size).toBeGreaterThan(0);
    for (const p of pairs) {
      const [s, v] = p.split('>').map(Number);
      expect(b.group[s] === b.group[v], p).toBe(false);
    }
    // The humans did hurt the horde and the horde hurt the humans.
    expect([...pairs].some((p) => p.endsWith('>3'))).toBe(true);
    expect([...pairs].some((p) => p.startsWith('3>'))).toBe(true);
  });

  it('healers heal allied teams (a priest of team 0 heals a wounded unit of team 1)', () => {
    const b = battle([[0, Kind.Priest, 26, 26], [1, Kind.Warrior, 28, 26], [1, Kind.Warrior, 29, 27]]);
    const w = 1;
    b.units.hp[w] = b.units.maxHp[w] * 0.3;
    run(b, 200);
    expect(b.counters.heal).toBeGreaterThan(0);
    expect(b.units.hp[w]).toBeGreaterThan(b.units.maxHp[w] * 0.3);
  });

  it('classic and the other modes keep one group per team (nothing changes without Horde)', () => {
    for (const rules of [undefined, 'hill', 'vip', 'ctf', 'siege'] as const) {
      const b = battle(cluster(0, Kind.Warrior, 10, 10, 3).concat(cluster(1, Kind.Warrior, 30, 30, 3), cluster(2, Kind.Warrior, 10, 30, 3)), { rules, teamCount: 3 });
      expect(b.group).toEqual([0, 1, 2]);
      expect(b.hordeTeam).toBe(-1);
      b.step(DT);
      expect(b.enemyList[0]).toEqual([1, 2]);
      expect(b.selfList[1]).toEqual([1]);
    }
  });
});

describe('horde mode: waves', () => {
  it('wave n spawns at 15 s + 25 s (n-1) of sim time, with its exact size, and nothing before', () => {
    const b = battle([...cluster(0, Kind.Warrior, 22, 24, 8), ...cluster(1, Kind.Warrior, 28, 24, 8)]);
    invulnerable(b);
    expect(hud(b)).toMatchObject({ wave: 0, waves: 12, hordeAlive: 0, hordeTeam: 2 });
    expect(hud(b).nextIn).toBeCloseTo(15, 6);
    expect(hud(b).timeLeft).toBeCloseTo(900, 6);
    const poolStart = b.units.count - hordePoolSize(2);
    let last = 0;
    let steps = 0;
    while (hud(b).wave < HORDE_WAVES && steps < 12000) {
      b.step(DT);
      steps++;
      const w = hud(b).wave;
      if (w !== last) {
        expect(w).toBe(last + 1);
        expect(b.stepNo).toBe(hordeWaveStep(w, SPS));
        expect(b.stepNo).toBe((15 + 25 * (w - 1)) * 30);
        // The woken units are exactly the pool slice of this wave.
        const first = poolStart + hordeWaveOffset(w, 2);
        const size = hordeWaveSize(w, 2);
        for (let k = 0; k < size; k++) {
          expect(b.units.alive[first + k]).toBe(1);
          expect(b.units.team[first + k]).toBe(2);
          expect(b.units.kind[first + k]).toBe(hordeKind(w, k, 2));
        }
        for (let i = first + size; i < b.units.count; i++) expect(b.units.alive[i]).toBe(0);
        last = w;
      } else if (w > 0) expect(hud(b).nextIn).toBeGreaterThan(0);
    }
    expect(last).toBe(12);
    expect(b.stepNo).toBe(290 * 30);
    expect(hud(b).nextIn).toBe(0);
    expect(hud(b).waves).toBe(12);
    expect(b.winner).toBe(-1);
  });

  it('tiers rise with the wave: common first, rare from wave 4, epic from 7, legendary only from wave 10', () => {
    const rarityOf = (k: number): string => TROOPS.find((t) => t.id === STATS[k].troop)!.rarity;
    const mix = (n: number): Record<string, number> => {
      const m: Record<string, number> = { common: 0, rare: 0, epic: 0, legendary: 0 };
      for (let k = 0; k < hordeWaveSize(n, 1); k++) m[rarityOf(hordeKind(n, k, 1))]++;
      return m;
    };
    for (let n = 1; n <= 3; n++) expect(mix(n).common).toBe(hordeWaveSize(n, 1));
    expect(mix(4).rare).toBeGreaterThan(0);
    for (let n = 1; n <= 6; n++) expect(mix(n).epic + mix(n).legendary).toBe(0);
    expect(mix(7).epic).toBeGreaterThan(0);
    for (let n = 1; n <= 9; n++) expect(mix(n).legendary).toBe(0);
    for (let n = 10; n <= 12; n++) {
      expect(mix(n).legendary).toBeGreaterThan(0);
      expect(mix(n).legendary).toBeLessThan(hordeWaveSize(n, 1) / 2);
    }
    expect(mix(12).common).toBe(0);
  });

  it('kinds and positions are deterministic: two runs spawn the same horde at the same places', () => {
    const make = (): Battle => {
      const b = battle([...TWO]);
      invulnerable(b);
      runUntilWave(b, 3);
      return b;
    };
    const a = make();
    const c = make();
    expect(a.hash()).toBe(c.hash());
    for (let i = 0; i < a.units.count; i++) {
      expect(a.units.kind[i]).toBe(c.units.kind[i]);
      expect(a.units.x[i]).toBe(c.units.x[i]);
      expect(a.units.y[i]).toBe(c.units.y[i]);
    }
    expect(hordeKind(5, 3, 2)).toBe(hordeKind(5, 3, 2));
  });

  it('spawn points: units appear next to the gates, away from the humans, on walkable main-region tiles', () => {
    const sc = hordeScenario(3, 2);
    const b = new Battle(sc.simSeed, sc.config);
    invulnerable(b);
    const humansCentroid = { x: 0, y: 0, n: 0 };
    for (let i = 0; i < b.units.count; i++) if (b.units.alive[i]) humansCentroid.x += b.units.x[i], humansCentroid.y += b.units.y[i], humansCentroid.n++;
    runUntilWave(b, 1);
    const first = b.units.count - hordePoolSize(2);
    const size = hordeWaveSize(1, 2);
    const cx = humansCentroid.x / humansCentroid.n;
    const cy = humansCentroid.y / humansCentroid.n;
    for (let k = 0; k < size; k++) {
      const i = first + k;
      expect(b.terrain!.walkable(b.units.x[i], b.units.y[i])).toBe(true);
      expect(b.terrain!.reachable(b.units.x[i], b.units.y[i])).toBe(true);
      // Near the map edge, far from the human centroid.
      const edge = Math.min(b.units.x[i], b.units.y[i], b.mapSize - b.units.x[i], b.mapSize - b.units.y[i]);
      expect(edge).toBeLessThan(9);
      expect(Math.hypot(b.units.x[i] - cx, b.units.y[i] - cy)).toBeGreaterThan(b.mapSize * 0.25);
    }
  });

  it('gates are walkable and reachable on every preset, at several sizes, with 1-5 human teams (1-3 gates)', () => {
    for (const p of PRESETS) {
      for (const teams of [1, 2, 3, 5]) {
        for (const size of [40, mapSizeForPlayers(teams), 120]) {
          const t = new Terrain(size, { seed: 3, spec: p.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
          const rows: Row[] = [];
          for (const z of teamZones(size, Math.max(teams, 2), t).slice(0, teams)) {
            const c = t.nearestWalkable(z.cx, z.cy, 12, true) ?? { x: z.cx, y: z.cy };
            for (let k = 0; k < 3; k++) {
              const q = t.nearestWalkable(c.x + k * 1.5, c.y + (k % 2) * 1.5, 6, true) ?? c;
              rows.push([z.team, Kind.Warrior, q.x, q.y]);
            }
          }
          const b = new Battle(5, { mode: 'custom', perTeam: 0, teamCount: teams, mapSize: size, env: true, kite: true, terrainSeed: 3, map: p.spec, rules: 'horde', layout: new Float32Array(rows.flat()) });
          const state = b.mode.serialize();
          const gates = state[2];
          expect(gates, `${p.id} ${size} ${teams}`).toBeGreaterThanOrEqual(1);
          expect(gates).toBeLessThanOrEqual(3);
          for (let g = 0; g < gates; g++) {
            const x = state[3 + g * 2];
            const y = state[4 + g * 2];
            expect(b.terrain!.walkable(x, y), `${p.id} ${size} ${teams} gate ${g}`).toBe(true);
            expect(b.terrain!.reachable(x, y), `${p.id} ${size} ${teams} gate ${g}`).toBe(true);
          }
        }
      }
    }
  }, 120000);

  it('the damage-ramp clock restarts with every wave (a quiet stretch does not amplify the new fight)', () => {
    const b = battle(TWO);
    invulnerable(b);
    run(b, 460);
    expect(b.time - b.lastDeathTime).toBeLessThan(1);
  });
});

describe('horde mode: result', () => {
  it('victory: wave 12 spawned and every horde unit dead -> the lowest-index human team with units wins; scores are waves reached', () => {
    const b = battle([...TWO, ...cluster(2, Kind.Warrior, 24, 34, 4)], { teamCount: 3 });
    invulnerable(b);
    runUntilWave(b, 12);
    expect(hud(b).wave).toBe(12);
    expect(b.modeScores()).toEqual([12, 12, 12, 0]);
    expect(b.winner).toBe(-1);
    // Kill team 0, then the horde: the next human team (1) is the winner.
    const u = b.units;
    for (let i = 0; i < u.count; i++) if (u.alive[i] && u.team[i] === 0) killUnit(b, i);
    for (const i of hordeUnits(b)) if (u.alive[i]) killUnit(b, i);
    b.step(DT);
    expect(b.winner).toBe(1);
    expect(b.modeScores()).toEqual([12, 12, 12, 0]);
  });

  it('no victory while a horde unit lives or while a wave is still to come', () => {
    const b = battle(TWO);
    invulnerable(b);
    runUntilWave(b, 2);
    for (const i of hordeUnits(b)) if (b.units.alive[i]) killUnit(b, i);
    run(b, 5);
    expect(hud(b).hordeAlive).toBe(0);
    expect(hud(b).wave).toBe(2);
    expect(b.winner).toBe(-1);
    expect(b.modeScores()).toEqual([2, 2, 0]);
  });

  it('defeat: every human unit dead -> the horde team wins, with the waves reached as score', () => {
    const b = battle(TWO);
    runUntilWave(b, 2);
    const u = b.units;
    for (let i = 0; i < u.count; i++) if (u.alive[i] && u.team[i] < 2) killUnit(b, i);
    b.step(DT);
    expect(b.winner).toBe(2);
    expect(b.modeScores()).toEqual([2, 2, 0]);
    // The battle is over: no further wave spawns.
    run(b, 1000);
    expect(hud(b).wave).toBe(2);
  });

  it('the humans losing the whole army before wave 1 is a defeat as well (never a draw)', () => {
    const b = battle(TWO);
    for (let i = 0; i < b.units.count; i++) if (b.units.alive[i]) killUnit(b, i);
    b.step(DT);
    expect(b.winner).toBe(2);
    expect(b.modeScores()).toEqual([0, 0, 0]);
  });

  it('safety limit: after 15 minutes with the horde alive the humans lose (no draw)', () => {
    const b = battle(cluster(0, Kind.Warrior, 24, 24, 4), { teamCount: 1 });
    invulnerable(b);
    runUntilWave(b, 12);
    const u = b.units;
    for (const i of hordeUnits(b)) {
      u.invulnT[i] = 1e9;
      u.stunT[i] = 1e9;
    }
    // Keep everyone out of the fight so nothing changes until the limit.
    for (let i = 0; i < u.count; i++) u.stunT[i] = 1e9;
    while (b.winner === -1 && b.stepNo < HORDE_TIME_LIMIT * SPS + 10) b.step(DT);
    expect(b.stepNo).toBe(HORDE_TIME_LIMIT * SPS);
    expect(b.winner).toBe(1);
    expect(hud(b).timeLeft).toBe(0);
    expect(b.modeScores()).toEqual([12, 0]);
  }, 120000);

  it('the classic draw rules are off: damage-less sides do not end in a draw', () => {
    // Priests deal no damage: in classic two such teams are drawn after a few seconds.
    const rows = [...cluster(0, Kind.Priest, 20, 24, 3), ...cluster(1, Kind.Priest, 30, 24, 3)];
    const classic = battle(rows, { rules: 'classic' });
    run(classic, 14 * SPS);
    expect(classic.winner).toBe(-2);
    const b = battle(rows);
    run(b, 14 * SPS);
    expect(b.winner).toBe(-1);
  });
});

describe('horde mode: determinism and snapshots', () => {
  it('two runs end with the same hash, mid-wave and at the end', () => {
    const sc = hordeScenario(2, 1);
    const hashes: number[][] = [];
    for (let r = 0; r < 2; r++) {
      const b = new Battle(sc.simSeed, sc.config);
      const h: number[] = [];
      for (let s = 0; s < 1500 && b.winner === -1; s++) {
        b.step(DT);
        if (s % 250 === 0) h.push(b.hash());
      }
      h.push(b.hash());
      hashes.push(h);
    }
    expect(hashes[0]).toEqual(hashes[1]);
    expect(new Set(hashes[0]).size).toBeGreaterThan(4);
  });

  it('snapshot -> restore -> the same continuation (mid-wave), also through pack/unpack', () => {
    const sc = hordeScenario(4, 2);
    const a = new Battle(sc.simSeed, sc.config);
    run(a, 15 * SPS + 90); // a wave is on the way
    expect(hud(a).wave).toBe(1);
    expect(hud(a).hordeAlive).toBeGreaterThan(0);
    const snap = unpackSnapshot(packSnapshot(a.serialize()));
    const c = new Battle(sc.simSeed, sc.config);
    c.restore(snap);
    expect(c.hash()).toBe(a.hash());
    expect(c.modeHud()).toEqual(a.modeHud());
    expect(c.modeScores()).toEqual(a.modeScores());
    for (let s = 0; s < 1000 && a.winner === -1; s++) {
      a.step(DT);
      c.step(DT);
      if (s % 100 === 0) expect(c.hash()).toBe(a.hash());
    }
    expect(c.hash()).toBe(a.hash());
    expect(hud(c).wave).toBe(hud(a).wave);
    expect(hud(a).wave).toBeGreaterThanOrEqual(2);
  });

  it('classic hashes do not include any horde state', () => {
    const rows = [...cluster(0, Kind.Warrior, 20, 20, 3), ...cluster(1, Kind.Warrior, 30, 30, 3)];
    const a = battle(rows, { rules: undefined });
    const b = battle(rows, { rules: 'classic' });
    run(a, 50);
    run(b, 50);
    expect(a.hash()).toBe(b.hash());
  });
});

describe('horde mode: backends', () => {
  it('the HUD survives the shared-memory frame block (before, during and after the waves)', () => {
    const b = battle(TWO);
    invulnerable(b);
    const f = new Float64Array(F_LEN);
    writeModeHud(f, b.modeHud());
    expect(f[F_MODE_ON]).toBe(5);
    expect(readModeHud(f)).toEqual(b.modeHud());
    run(b, 500);
    writeModeHud(f, b.modeHud());
    expect(readModeHud(f)).toEqual(b.modeHud());
    expect(hud(b).wave).toBe(1);
    runUntilWave(b, 12);
    writeModeHud(f, b.modeHud());
    const h = readModeHud(f);
    expect(h).toEqual(b.modeHud());
    expect((h as HordeHud).nextIn).toBe(0);
  });

  it('other modes keep their frame layouts', () => {
    for (const rules of ['hill', 'vip', 'ctf', 'siege', 'classic'] as const) {
      const b = battle(TWO, { rules });
      const f = new Float64Array(F_LEN);
      writeModeHud(f, b.modeHud());
      expect(readModeHud(f), rules).toEqual(b.modeHud());
    }
  });

  it('the inline sim exposes the horde HUD, the scores and the horde team in alivePerTeam', () => {
    const sim = new InlineSim({ mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: false, kite: true, terrainSeed: 3, layout: new Float32Array(TWO.flat()), rules: 'horde' }, 7);
    expect(sim.modeHud.kind).toBe('horde');
    expect(sim.scores).toEqual([0, 0, 0]);
    expect(sim.alivePerTeam.slice(0, 3)).toEqual([8, 8, 0]);
    for (let i = 0; i < 480; i++) sim.frame(DT);
    expect(sim.modeHud).toEqual(sim.battle.modeHud());
    expect(sim.scores).toEqual([1, 1, 0]);
    expect(sim.alivePerTeam[2]).toBeGreaterThan(0);
  });
});

describe('horde mode: balance and performance', () => {
  it('a typical 2000-gold army survives about 6-9 waves; a strong one can win', () => {
    // Measured with `hordeScenario(seed, humans, gold)` (src/sim/testing/hordeBalance.ts), seeds 1-40, one team: 8.2 waves
    // reached on average (6-11); 2 teams 7.9, 3 teams 7.6, 5 teams 7.7 (10 seeds each). Waves reached = waves spawned.
    let sum = 0;
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const s of seeds) {
      const r = runHorde(hordeScenario(s, 1));
      expect(r.winner).toBe(1);
      sum += r.waves;
    }
    const avg = sum / seeds.length;
    expect(avg).toBeGreaterThanOrEqual(6);
    expect(avg).toBeLessThanOrEqual(9);
    // The waves are beatable: a 3x army wins the whole battle on a seed that is close at 2000 gold.
    const strong = runHorde(hordeScenario(5, 1, 6000));
    expect(strong.waves).toBe(12);
    expect(strong.humanVictory).toBe(true);
    expect(strong.winner).toBe(0);
  }, 300000);

  it('more human teams face proportionally larger waves and still last a similar number of waves', () => {
    for (const humans of [3, 5]) {
      const r = runHorde(hordeScenario(2, humans));
      expect(r.winner).toBe(humans);
      expect(r.waves).toBeGreaterThanOrEqual(5);
      expect(r.waves).toBeLessThanOrEqual(11);
    }
  }, 300000);

  it('3000 human units: a horde step costs about the same as a classic one', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 3000; i++) {
      const t = i % 2;
      rows.push([t, Kind.Warrior, 4 + (i % 50) * 0.9, 4 + Math.floor(i / 50) * 0.9 + t * 60]);
    }
    const time = (rules: 'horde' | 'classic'): number => {
      const b = battle(rows, { mapSize: 120, rules });
      b.step(DT);
      const t0 = performance.now();
      for (let s = 0; s < 20; s++) b.step(DT);
      return (performance.now() - t0) / 20;
    };
    time('classic');
    const classic = time('classic');
    const horde = time('horde');
    expect(horde).toBeLessThan(classic * 1.6 + 8);
  }, 120000);
});
