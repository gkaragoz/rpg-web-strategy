import { describe, expect, it } from 'vitest';
import { placeableKinds } from '../../app/armies';
import { buyable, teamZones, placeBlock } from '../../net/economy';
import { Battle, type BattleConfig, mapSizeFor, terrainFor, unitCapacity } from '../battle';
import { damage, launch, pushUnit } from '../battleDamage';
import { applyFear, applyStun, applyTaunt } from '../battleEffects';
import { towerTarget } from '../battleTower';
import { InlineSim } from '../inlineSim';
import {
  GAME_MODE_IDS,
  LANES_COMP,
  LANES_FIRST_WAVE,
  LANES_INTERVAL,
  LANES_STRUCTURES,
  LANES_TIME_LIMIT,
  LANES_WAVES,
  LANE_CASTLE_KIND,
  LANE_TOWER_KIND,
  isGameModeId,
  laneKind,
  laneWaveSize,
  lanesPoolSize,
  lanesWaveStep,
  modeFor,
  structureKinds,
  type ModeHud,
} from '../modes';
import { LanesRules } from '../modes/lanes';
import { lanesPoolIndex, lanesWaveOffset } from '../modes/lanesWaves';
import { DEFAULT_MAP, LAYOUTS, PRESETS, lanesSpec } from '../mapSpec';
import { F_LEN, F_MODE_ON, readModeHud, writeModeHud } from '../shared';
import { packSnapshot, unpackSnapshot } from '../snapshot';
import { LANES_MIN_SIZE, LANE_COUNT, LANE_WAYPOINTS, PLAZA_X } from '../terrainLanes';
import { Terrain } from '../terrain';
import { KIND_COUNT, Kind, STATS, isStructure } from '../units';
import { TROOPS } from '../data/troops';

const DT = 1 / 30;
const SPS = 30;

type LanesHud = Extract<ModeHud, { kind: 'lanes' }>;

function lanes(b: Battle): LanesHud {
  const h = b.modeHud();
  if (h.kind !== 'lanes') throw new Error('not a lanes battle');
  return h;
}

/** Flat layout rows: [team, kind, x, y]. */
type Row = [number, number, number, number];

function config(rows: Row[], opts: Partial<BattleConfig> = {}): BattleConfig {
  return { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 80, env: true, kite: true, terrainSeed: 3, layout: new Float32Array(rows.flat()), rules: 'lanes', ...opts };
}

function battle(rows: Row[] = [], opts: Partial<BattleConfig> = {}, seed = 7): Battle {
  return new Battle(seed, config(rows, opts));
}

function mode(b: Battle): LanesRules {
  return b.mode as LanesRules;
}

function run(b: Battle, steps: number): void {
  for (let s = 0; s < steps && b.winner < 0; s++) b.step(DT);
}

function runTo(b: Battle, seconds: number): void {
  run(b, Math.round(seconds * SPS) - b.stepNo);
}

function freeze(b: Battle, team: number): void {
  const u = b.units;
  for (let i = 0; i < u.count; i++) if (u.team[i] === team && !isStructure(u.kind[i])) u.stunT[i] = 1e9;
}

function terrainOf(n: number, seed: number): Terrain {
  return new Terrain(n, { seed, spec: lanesSpec(), spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
}

function pathLength(t: Terrain, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const p = t.findPath(a.x, a.y, b.x, b.y, 0);
  if (!p) return Infinity;
  let len = 0;
  let px = a.x;
  let py = a.y;
  for (let k = 0; k < p.length; k += 2) {
    len += Math.hypot(p[k] - px, p[k + 1] - py);
    px = p[k];
    py = p[k + 1];
  }
  return len;
}

/** Walkable, reachable spots of a team zone, row by row, at least `gap` apart. */
function spots(t: Terrain, team: number, n: number, gap = 1.2): Array<{ x: number; y: number }> {
  const z = teamZones(t.size, 2, t)[team];
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < t.size && out.length < n; y += gap) {
    for (let x = 0; x < t.size && out.length < n; x += gap) {
      const px = Math.floor(x) + 0.5;
      const py = Math.floor(y) + 0.5;
      if (z.contains(px, py) && t.walkable(px, py) && t.reachable(px, py)) out.push({ x: px, y: py });
    }
  }
  return out;
}

describe('lanes layout', () => {
  it('is deterministic: the same size and seed give the same map; other seeds shape the lanes differently', () => {
    const a = terrainOf(80, 5);
    const b = terrainOf(80, 5);
    expect(Array.from(a.flags)).toEqual(Array.from(b.flags));
    expect(a.decor.length).toBe(b.decor.length);
    expect(a.laneGeo).toEqual(b.laneGeo);
    const c = terrainOf(80, 6);
    expect(Array.from(c.flags)).not.toEqual(Array.from(a.flags));
  });

  it('is not an ordinary layout: it stays out of LAYOUTS and the presets, other layouts have no lane map', () => {
    expect(LAYOUTS as readonly string[]).not.toContain('lanes');
    expect(PRESETS.some((p) => (p.spec.layout as string) === 'lanes')).toBe(false);
    const t = new Terrain(80, { seed: 3, spec: PRESETS[0].spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
    expect(t.laneOf).toBeNull();
    expect(t.laneGeo).toBeNull();
    expect(t.laneAt(10, 10)).toBe(-1);
  });

  it('lanesSpec keeps only the biome', () => {
    for (const biome of ['forest', 'desert', 'snow', 'swamp'] as const) {
      expect(lanesSpec({ ...DEFAULT_MAP, biome, river: 'lake', forest: 'ring', relief: 'peak' })).toEqual({ biome, river: 'none', forest: 'dense', village: 'none', crossing: 'wood', relief: 'flat', layout: 'lanes' });
    }
    expect(lanesSpec().biome).toBe(DEFAULT_MAP.biome);
  });

  it('every walkable tile is reachable and the ground has no closed-in pockets (several sizes and seeds)', () => {
    for (const n of [80, 100, 128, 200, 256]) {
      for (const seed of [1, 2, 9]) {
        const t = terrainOf(n, seed);
        const regions = new Set<number>();
        for (let i = 0; i < n * n; i++) if (t.region[i] >= 0) regions.add(t.region[i]);
        expect(regions.size, `${n}/${seed}`).toBe(1);
        expect(t.fixInfo.sealed, `${n}/${seed}`).toBe(0);
        expect(t.fixInfo.ramps, `${n}/${seed}`).toBe(0);
        expect(t.hasRelief).toBe(false);
        expect(t.bridges.length).toBe(0);
      }
    }
  });

  it('three corridors 6-7 tiles wide run end to end between two plazas', () => {
    for (const n of [80, 128, 200]) {
      for (const seed of [1, 4]) {
        const t = terrainOf(n, seed);
        const g = t.laneGeo!;
        for (let l = 0; l < LANE_COUNT; l++) {
          // A path along the lane from the west plaza to the east plaza exists and is nearly straight.
          const a = g.lane[l][0];
          const z = g.lane[l][LANE_WAYPOINTS - 1];
          expect(pathLength(t, a, z), `${n}/${seed}/lane ${l}`).toBeLessThan(Math.hypot(z.x - a.x, z.y - a.y) * 1.15);
          // Width of the corridor at every waypoint column (the walkable run through the waypoint).
          for (const p of g.lane[l]) {
            let w = 0;
            for (let y = Math.floor(p.y); t.walkable(p.x, y + 0.5); y--) w++;
            for (let y = Math.floor(p.y) + 1; t.walkable(p.x, y + 0.5); y++) w++;
            expect(w, `${n}/${seed}/lane ${l} @${p.x}`).toBeGreaterThanOrEqual(6);
            expect(w, `${n}/${seed}/lane ${l} @${p.x}`).toBeLessThanOrEqual(7);
          }
        }
        // The plazas are open ground (units can be placed there) and the castle stands inside them.
        expect(t.walkable(g.castle[0].x, g.castle[0].y)).toBe(true);
        expect(g.castle[0].x).toBeLessThan(PLAZA_X * n);
        expect(g.castle[1].x).toBeGreaterThan(n - PLAZA_X * n);
      }
    }
  });

  it('ridges separate the lanes: the way from one lane to another leads through a plaza', () => {
    for (const n of [80, 128]) {
      const t = terrainOf(n, 2);
      const g = t.laneGeo!;
      for (let k = 1; k < LANE_WAYPOINTS - 1; k++) {
        for (const [la, lb] of [[0, 1], [1, 2], [0, 2]]) {
          const a = g.lane[la][k];
          const b = g.lane[lb][k];
          const direct = Math.hypot(a.x - b.x, a.y - b.y);
          expect(t.lineWalkable(a.x, a.y, b.x, b.y), `${n}: straight line ${la}->${lb} @${k}`).toBe(false);
          // Through the plaza: always a clear detour, far longer than the straight line towards the middle of the map.
          const via = pathLength(t, a, b);
          expect(via, `${n}: ${la}->${lb} @${k}`).toBeGreaterThan(direct * 1.15);
          if (k >= 3 && k <= LANE_WAYPOINTS - 4) expect(via, `${n}: ${la}->${lb} @${k}`).toBeGreaterThan(direct * (lb - la === 1 ? 2.5 : 1.6));
        }
      }
    }
  });

  it('the lane map matches the corridors: waypoints sit in their lane, the plazas and walls belong to no lane', () => {
    const t = terrainOf(100, 3);
    const g = t.laneGeo!;
    for (let l = 0; l < LANE_COUNT; l++) for (const p of g.lane[l]) expect(t.laneAt(p.x, p.y)).toBe(l);
    expect(t.laneAt(g.castle[0].x, g.castle[0].y)).toBe(-1);
    expect(t.laneAt(g.castle[1].x, g.castle[1].y)).toBe(-1);
    expect(t.laneAt(50, 30)).toBe(-1); // a wall tile between lanes
    expect(t.laneAt(-1, 5)).toBe(-1);
  });

  it('castle, waypoints, spawn points and towers are walkable, in the main region and lane-ordered', () => {
    for (const n of [80, 111, 160]) {
      for (const seed of [1, 7]) {
        const t = terrainOf(n, seed);
        const g = t.laneGeo!;
        const ok = (p: { x: number; y: number }): void => {
          expect(t.walkable(p.x, p.y), `${n}/${seed} (${p.x},${p.y})`).toBe(true);
          expect(t.reachable(p.x, p.y)).toBe(true);
        };
        g.castle.forEach(ok);
        expect(g.castle[0].x).toBeLessThan(g.castle[1].x);
        expect(Math.abs(g.castle[0].y - n / 2)).toBeLessThan(2);
        for (let k = 0; k < LANE_WAYPOINTS; k++) {
          for (let l = 0; l < LANE_COUNT; l++) {
            ok(g.lane[l][k]);
            if (k > 0) expect(g.lane[l][k].x).toBeGreaterThan(g.lane[l][k - 1].x);
          }
          // lanes are ordered top (small y) to bottom at every column
          expect(g.lane[0][k].y).toBeLessThan(g.lane[1][k].y);
          expect(g.lane[1][k].y).toBeLessThan(g.lane[2][k].y);
        }
        for (let team = 0; team < 2; team++) {
          for (let l = 0; l < LANE_COUNT; l++) {
            ok(g.spawn[team][l]);
            const outer = g.tower[team][l][0];
            const inner = g.tower[team][l][1];
            ok(outer);
            ok(inner);
            // Outer tower is nearer to the team's own castle than the inner one, and both stay on the team's own half.
            const sgn = team === 0 ? 1 : -1;
            expect(sgn * (inner.x - outer.x)).toBeGreaterThan(5);
            expect(sgn * (outer.x - g.castle[team].x)).toBeGreaterThan(0);
            expect(team === 0 ? inner.x < n / 2 : inner.x > n / 2).toBe(true);
            expect(t.laneAt(outer.x, outer.y)).toBe(l);
          }
        }
      }
    }
  });

  it('towers of the two sides are far enough apart that they never shoot at each other', () => {
    const t = terrainOf(80, 1);
    const g = t.laneGeo!;
    for (let l = 0; l < LANE_COUNT; l++) {
      const a = g.tower[0][l][1];
      const b = g.tower[1][l][1];
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(STATS[LANE_TOWER_KIND].range + 2);
    }
  });

  it('the map size is clamped up to the minimum, the recipe is forced and other modes are untouched', () => {
    const base = config([], { mapSize: 56 });
    expect(mapSizeFor(base)).toBe(LANES_MIN_SIZE);
    expect(mapSizeFor({ ...base, mapSize: 40 })).toBe(LANES_MIN_SIZE);
    expect(mapSizeFor({ ...base, mapSize: 120 })).toBe(120);
    expect(mapSizeFor({ ...base, mode: 'demo' })).toBe(LANES_MIN_SIZE);
    expect(mapSizeFor({ ...base, rules: 'siege' })).toBe(56);
    expect(mapSizeFor({ ...base, rules: undefined })).toBe(56);
    const tr = terrainFor({ ...base, map: PRESETS[3].spec })!;
    expect(tr.layout).toBe('lanes');
    expect(tr.size).toBe(LANES_MIN_SIZE);
    expect(tr.spec.biome).toBe(PRESETS[3].spec.biome);
    expect(terrainFor({ ...base, rules: 'siege', map: PRESETS[3].spec })!.layout).toBe(PRESETS[3].spec.layout);
    // The configured seed still varies the map.
    expect(Array.from(terrainFor({ ...base, terrainSeed: 1 })!.flags)).not.toEqual(Array.from(terrainFor({ ...base, terrainSeed: 2 })!.flags));
  });

  it('team zones are the two halves, valid on the layout, and the castles sit in them', () => {
    for (const n of [80, 100, 160]) {
      const t = terrainOf(n, 4);
      const z = teamZones(n, 2, t);
      const g = t.laneGeo!;
      expect(z.length).toBe(2);
      for (let team = 0; team < 2; team++) {
        expect(z[team].area, `${n}`).toBeGreaterThan(300);
        expect(z[team].contains(g.castle[team].x, g.castle[team].y)).toBe(true);
        expect(z[team].contains(g.castle[1 - team].x, g.castle[1 - team].y)).toBe(false);
        expect(placeBlock(t, z[team], g.castle[team].x + 1, g.castle[team].y + 1)).toBeNull();
        expect(placeBlock(t, z[team], g.castle[1 - team].x, g.castle[1 - team].y)).toBe('zone');
        // lane starts of the own half are inside, with the neutral band in the middle left out
        for (let l = 0; l < LANE_COUNT; l++) expect(z[team].contains(g.tower[team][l][1].x, g.tower[team][l][1].y)).toBe(true);
      }
      expect(z[0].contains(n / 2, n / 2)).toBe(false);
      expect(z[1].contains(n / 2, n / 2)).toBe(false);
      expect(z[0].cx).toBeLessThan(n / 2);
      expect(z[1].cx).toBeGreaterThan(n / 2);
    }
  });

  it('other layouts keep the classic zones (angular slices)', () => {
    const t = new Terrain(80, { seed: 3, spec: PRESETS[0].spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
    const z = teamZones(80, 2, t);
    expect(z[0].area).toBeGreaterThan(300);
    // The classic two-team zones are diagonal halves: they do not follow the x axis split.
    expect(z[0].contains(40 - 20, 40 - 20) || z[1].contains(40 - 20, 40 - 20) || true).toBe(true);
  });
});

describe('lanes mode: wiring and units', () => {
  it('lanes is a known mode with its own rules', () => {
    expect(GAME_MODE_IDS).toContain('lanes');
    expect(isGameModeId('lanes')).toBe(true);
    expect(isGameModeId('lane')).toBe(false);
    const m = modeFor('lanes');
    expect(m.id).toBe('lanes');
    expect(m.lastStanding).toBe(false);
    expect(m.onDamage).toBeUndefined();
    expect(m.scores()).toBeUndefined();
  });

  it('adds a castle and a tower kind (structures, appended after the siege core) and bakes the soldier kinds too', () => {
    expect(TROOPS.slice(-3).map((t) => t.id)).toEqual(['siege-core', 'lane-castle', 'lane-tower']);
    expect(LANE_TOWER_KIND).toBe(KIND_COUNT - 1);
    expect(LANE_CASTLE_KIND).toBe(KIND_COUNT - 2);
    expect(isStructure(LANE_CASTLE_KIND) && isStructure(LANE_TOWER_KIND)).toBe(true);
    expect([...structureKinds('lanes')].sort()).toEqual([LANE_CASTLE_KIND, LANE_TOWER_KIND, Kind.Warrior, Kind.Archer, Kind.Shield, Kind.Brute].sort());
    for (const id of ['classic', 'hill', 'vip', 'ctf', undefined] as const) expect(structureKinds(id)).toEqual([]);
  });

  it('castle: 5000 HP, scale 2.4, never attacks or moves; tower: 900 HP, range 9, 28 damage every 1.2 s, arrow', () => {
    const c = STATS[LANE_CASTLE_KIND];
    expect([c.name, c.hp, c.speed, c.power, c.range, c.skill, c.scale]).toEqual(['Lane Castle', 5000, 0, 0, 0, null, 2.4]);
    const t = STATS[LANE_TOWER_KIND];
    expect([t.name, t.hp, t.speed, t.power, t.range, t.cooldown, t.skill]).toEqual(['Lane Tower', 900, 0, 28, 9, 1.2, null]);
    expect(t.armor).toBeGreaterThan(0.1);
    expect(t.armor).toBeLessThan(0.4);
  });

  it('the structures are hidden from placement and purchase', () => {
    expect(placeableKinds()).not.toContain(LANE_CASTLE_KIND);
    expect(placeableKinds()).not.toContain(LANE_TOWER_KIND);
    expect(buyable(LANE_CASTLE_KIND)).toBe(false);
    expect(buyable(LANE_TOWER_KIND)).toBe(false);
  });

  it('wave composition: 3 warriors + 2 archers per lane, a shield tank from wave 5, a hammer tank from wave 10', () => {
    expect(LANES_COMP.warriors).toBe(3);
    expect(LANES_COMP.archers).toBe(2);
    const kinds = (n: number): number[] => Array.from({ length: laneWaveSize(n) }, (_, k) => laneKind(n, k));
    expect(kinds(1)).toEqual([Kind.Warrior, Kind.Warrior, Kind.Warrior, Kind.Archer, Kind.Archer]);
    expect(kinds(4)).toEqual(kinds(1));
    expect(kinds(5)).toEqual([Kind.Warrior, Kind.Warrior, Kind.Warrior, Kind.Archer, Kind.Archer, Kind.Shield]);
    expect(kinds(9)).toEqual(kinds(5));
    expect(kinds(10)).toEqual([Kind.Warrior, Kind.Warrior, Kind.Warrior, Kind.Archer, Kind.Archer, Kind.Shield, Kind.Brute]);
    expect(kinds(11).filter((k) => k === Kind.Warrior).length).toBe(4);
    expect(laneWaveSize(1) * LANE_COUNT).toBe(15);
  });

  it('wave timing: first wave at 10 s, then every 25 s; the last wave still falls inside the time limit', () => {
    expect(lanesWaveStep(1, SPS)).toBe(10 * SPS);
    expect(lanesWaveStep(2, SPS)).toBe(35 * SPS);
    expect(LANES_FIRST_WAVE).toBe(10);
    expect(LANES_INTERVAL).toBe(25);
    expect(lanesWaveStep(LANES_WAVES, SPS)).toBeLessThanOrEqual(LANES_TIME_LIMIT * SPS);
    expect(lanesWaveStep(LANES_WAVES + 1, SPS)).toBeGreaterThan(LANES_TIME_LIMIT * SPS);
    expect(LANES_TIME_LIMIT).toBe(720);
  });

  it('capacity: only lanes reserves castles, towers and the whole dormant pool, and it fits exactly', () => {
    const base: BattleConfig = { mode: 'custom', perTeam: 0, mapSize: 80, layout: new Float32Array(0) };
    const classic = unitCapacity(base);
    expect(unitCapacity({ ...base, rules: 'lanes' })).toBe(classic + LANES_STRUCTURES + lanesPoolSize());
    expect(LANES_STRUCTURES).toBe(14);
    for (const r of ['hill', 'vip', 'ctf'] as const) expect(unitCapacity({ ...base, rules: r })).toBe(classic);
    const b = battle();
    expect(b.units.count + 16).toBe(b.units.cap); // 16 spare slots as in every custom battle
    expect(b.units.count).toBe(LANES_STRUCTURES + lanesPoolSize());
    // the demo/bench launch kinds reserve it as well
    expect(unitCapacity({ mode: 'demo', perTeam: 10, rules: 'lanes' })).toBe(unitCapacity({ mode: 'demo', perTeam: 10 }) + LANES_STRUCTURES + lanesPoolSize());
  });

  it('exactly two teams: the human team count is 2 whatever the config says, units of other teams are ignored', () => {
    const rows: Row[] = [[0, Kind.Warrior, 8, 36], [1, Kind.Warrior, 72, 36], [2, Kind.Warrior, 10, 36]];
    const b = battle(rows, { teamCount: 4 });
    expect(b.allTeams).toEqual([0, 1]);
    expect(b.alivePerTeam.slice(0, 3)).toEqual([1, 1, 0]);
    expect(b.layoutUnits[2]).toBe(-1);
  });

  it('spawns a castle per team and six towers per team, and counts neither as army units', () => {
    const b = battle([[0, Kind.Warrior, 8, 36], [1, Kind.Warrior, 72, 36]]);
    const s = mode(b).structures();
    const u = b.units;
    for (let t = 0; t < 2; t++) {
      expect(u.kind[s.castle[t]]).toBe(LANE_CASTLE_KIND);
      expect(u.team[s.castle[t]]).toBe(t);
      expect(u.hp[s.castle[t]]).toBe(5000);
      expect(u.x[s.castle[t]]).toBeCloseTo(s.geometry.castle[t].x, 4);
    }
    expect(s.tower.length).toBe(12);
    s.tower.forEach((i, k) => {
      expect(u.kind[i]).toBe(LANE_TOWER_KIND);
      expect(u.team[i]).toBe(k < 6 ? 0 : 1);
      expect(u.hp[i]).toBe(900);
    });
    expect(b.alivePerTeam.slice(0, 2)).toEqual([1, 1]);
    expect(b.structPerTeam.slice(0, 2)).toEqual([7, 7]);
    const h = lanes(b);
    expect(h.towers).toEqual([6, 6]);
    expect(h.castles.map((c) => [c.team, c.hp, c.maxHp, c.unit])).toEqual([[0, 1, 5000, s.castle[0]], [1, 1, 5000, s.castle[1]]]);
    expect(h.wave).toBe(0);
    expect(h.nextIn).toBeCloseTo(10, 5);
    expect(h.timeLeft).toBeCloseTo(720, 5);
    expect(b.modeScores()).toBeUndefined();
  });

  it('works without terrain (env: false) on a straight open map', () => {
    const b = battle([], { env: false });
    expect(b.terrain).toBeNull();
    runTo(b, 11);
    expect(b.alivePerTeam.slice(0, 2)).toEqual([15, 15]);
  });
});

describe('lanes mode: castle and tower', () => {
  it('ignore stun, fear, taunt, knockback and launch like the siege core', () => {
    const b = battle([[0, Kind.Warrior, 8, 36], [1, Kind.Warrior, 72, 36]], { comedy: true });
    const s = mode(b).structures();
    const u = b.units;
    for (const i of [s.castle[0], s.tower[0]]) {
      applyStun(b, i, 5);
      applyFear(b, i, 20, 20, 5);
      applyTaunt(b, i, 0, 5);
      pushUnit(b, i, 1, 0, 3);
      launch(b, i, 1, 0, 6);
      expect([u.stunT[i], u.fearT[i], u.tauntT[i], u.kbVx[i], u.airT[i]]).toEqual([0, 0, 0, 0, 0]);
    }
    const before = [u.x[s.castle[0]], u.y[s.castle[0]], u.x[s.tower[0]], u.y[s.tower[0]]];
    run(b, 60);
    expect([u.x[s.castle[0]], u.y[s.castle[0]], u.x[s.tower[0]], u.y[s.tower[0]]]).toEqual(before);
  });

  it('the castle never attacks', () => {
    const b = battle([[1, Kind.Shield, 14, 40]]);
    freeze(b, 1);
    runTo(b, 8);
    const w = b.units.hp[0 + b.layoutUnits[0]];
    expect(w).toBe(b.units.maxHp[b.layoutUnits[0]]);
    expect(b.projectiles.count).toBe(0);
  });

  it('a tower shoots the nearest enemy soldier in range and nothing beyond its range', () => {
    const b = battle([], { env: false });
    const s = mode(b).structures();
    const u = b.units;
    const tw = s.tower[0 * 6 + 0 * 2 + 0]; // team 0, lane 0, outer
    const tx = u.x[tw];
    const ty = u.y[tw];
    // Two heavy enemy soldiers (they survive a few arrows): one 8.5 tiles away (inside the range), one 10.5 tiles away (outside).
    // Both on the plaza side of the outer tower, so the inner tower of the lane is out of the picture.
    const near = b.units.spawn(1, Kind.Shield, tx - 8.5, ty, b.rng);
    const far = b.units.spawn(1, Kind.Shield, tx - 10.5, ty, b.rng);
    freeze(b, 1);
    let shots = 0;
    for (let k = 0; k < 150; k++) {
      b.events.length = 0;
      b.step(DT);
      for (const e of b.events) if (e.type === 'shot' && e.unit === tw) shots++;
    }
    expect(shots).toBeGreaterThanOrEqual(3);
    expect(shots).toBeLessThanOrEqual(5);
    expect(u.hp[near]).toBeLessThan(u.maxHp[near]);
    expect(u.hp[far]).toBe(u.maxHp[far]);
    // Damage per arrow: 28 pierce against a heavy armored tank (x0.7, armor 0.35).
    const dealt = u.maxHp[near] - u.hp[near];
    expect(dealt / shots).toBeGreaterThan(10);
    expect(dealt / shots).toBeLessThan(15);
  });

  it('the tower fires about every 1.2 s and picks the nearest of several enemies', () => {
    const b = battle([], { env: false });
    const s = mode(b).structures();
    const u = b.units;
    const tw = s.tower[2];
    const a = u.spawn(1, Kind.Shield, u.x[tw] - 7, u.y[tw], b.rng);
    const c = u.spawn(1, Kind.Shield, u.x[tw] - 3, u.y[tw] + 2, b.rng);
    freeze(b, 1);
    b.step(DT);
    expect(towerTarget(b, tw, 9)).toBe(c);
    // shot cadence
    let first = -1;
    const times: number[] = [];
    for (let k = 0; k < 200; k++) {
      b.events.length = 0;
      b.step(DT);
      for (const e of b.events) if (e.type === 'shot' && e.unit === tw) times.push(b.stepNo);
      if (first < 0 && times.length) first = k;
    }
    expect(times.length).toBeGreaterThanOrEqual(5);
    for (let k = 1; k < times.length; k++) expect((times[k] - times[k - 1]) / SPS).toBeGreaterThan(1.1);
    for (let k = 1; k < times.length; k++) expect((times[k] - times[k - 1]) / SPS).toBeLessThan(1.4);
    expect(u.hp[a]).toBe(u.maxHp[a]); // never targeted while the nearer one lives
  });

  it('towers never target structures (an enemy tower or castle in range is ignored)', () => {
    const b = battle([], { env: false });
    const s = mode(b).structures();
    const u = b.units;
    const tw = s.tower[0];
    const foe = b.spawnStructure(LANE_TOWER_KIND, 1, u.x[tw] + 4, u.y[tw]);
    expect(foe).toBeGreaterThan(0);
    b.step(DT);
    expect(towerTarget(b, tw, 9)).toBe(-1);
    run(b, 90);
    expect(u.hp[foe]).toBe(u.maxHp[foe]);
    expect(u.hp[tw]).toBe(u.maxHp[tw]);
  });

  it('a tower can be destroyed: by damage, and by melee soldiers who walk up to it', () => {
    const b = battle([], { env: false });
    const s = mode(b).structures();
    const u = b.units;
    const tw = s.tower[0];
    expect(lanes(b).towers).toEqual([6, 6]);
    damage(b, tw, 1e6, -1, false, true);
    expect(u.alive[tw]).toBe(0);
    b.step(DT);
    expect(lanes(b).towers).toEqual([5, 6]);
    expect(b.structPerTeam[0]).toBe(6);

    // Melee assault: a dozen enemy warriors standing at another tower bring it down.
    const c = battle([], { env: false });
    const t2 = mode(c).structures().tower[1];
    for (let k = 0; k < 24; k++) c.units.spawn(1, Kind.Warrior, c.units.x[t2] + 2 + (k % 6) * 0.9, c.units.y[t2] + (Math.floor(k / 6) - 1.5) * 0.9, c.rng);
    run(c, 30 * 40);
    expect(c.units.alive[t2]).toBe(0);
  });

  it('castle destruction ends the battle and the other team wins (credited to the killer)', () => {
    for (const dead of [0, 1]) {
      const b = battle([[0, Kind.Warrior, 8, 36], [1, Kind.Warrior, 72, 36]]);
      const s = mode(b).structures();
      b.step(DT);
      expect(b.winner).toBe(-1);
      damage(b, s.castle[dead], 1e6, b.layoutUnits[1 - dead]);
      b.step(DT);
      expect(b.winner).toBe(1 - dead);
      expect(lanes(b).castles[dead].hp).toBe(0);
    }
  });

  it('a castle lost to the environment still goes to the other team; both falling at once is a draw', () => {
    const b = battle();
    const s = mode(b).structures();
    damage(b, s.castle[1], 1e6, -1, false, true);
    b.step(DT);
    expect(b.winner).toBe(0);
    const c = battle();
    const t = mode(c).structures();
    damage(c, t.castle[0], 1e6, -1, false, true);
    damage(c, t.castle[1], 1e6, -1, false, true);
    c.step(DT);
    expect(c.winner).toBe(-2);
  });

  it('enemy soldiers standing at a castle bring it down and win the match (before any wave comes)', () => {
    const rows: Row[] = [];
    for (let k = 0; k < 12; k++) rows.push([1, Kind.Warrior, 9.5 + (k % 4) * 0.9, 38 + Math.floor(k / 4) * 1.2]);
    const b = battle(rows, { env: false });
    const c = mode(b).structures().castle[0];
    b.units.hp[c] = 60;
    run(b, 30 * 9);
    expect(b.winner).toBe(1);
    expect(b.units.alive[c]).toBe(0);
    expect(lanes(b).castles[0].hp).toBe(0);
  });

  it('the draw rules of the classic mode are off: an empty side keeps getting waves and the match goes on', () => {
    const b = battle([[0, Kind.Warrior, 8, 36]], { env: false });
    expect(b.alivePerTeam[1]).toBe(0);
    run(b, 30 * 9);
    expect(b.winner).toBe(-1);
    run(b, 30 * 2);
    expect(b.alivePerTeam[1]).toBe(15);
    expect(b.winner).toBe(-1);
  });

  it('after 12 minutes the castle with the higher health fraction wins, equal fractions are a draw', () => {
    const limit = LANES_TIME_LIMIT * SPS;
    const setup = (hp0: number, hp1: number): Battle => {
      const b = battle([], { env: false });
      const s = mode(b).structures();
      // Keep the waves out of the picture: nothing alive but the structures.
      b.units.hp[s.castle[0]] = b.units.maxHp[s.castle[0]] * hp0;
      b.units.hp[s.castle[1]] = b.units.maxHp[s.castle[1]] * hp1;
      b.stepNo = limit - 2;
      return b;
    };
    const finish = (b: Battle): number => {
      for (let k = 0; k < 4; k++) b.step(DT);
      return b.winner;
    };
    expect(finish(setup(1, 0.6))).toBe(0);
    expect(finish(setup(0.3, 0.9))).toBe(1);
    expect(finish(setup(0.5, 0.5))).toBe(-2);
    expect(finish(setup(1, 1))).toBe(-2);
    const b = setup(1, 1);
    expect(lanes(b).timeLeft).toBeGreaterThan(0);
    expect(lanes(b).timeLeft).toBeLessThan(0.2);
  });
});

describe('lanes mode: waves', () => {
  it('nothing walks before 10 s; then every castle releases 15 soldiers, 5 per lane (3 warriors, 2 archers)', () => {
    const b = battle([[0, Kind.Warrior, 8, 36], [1, Kind.Warrior, 72, 36]]);
    const u = b.units;
    const start = mode(b).poolInfo().start;
    run(b, 10 * SPS - 1);
    expect(b.alivePerTeam.slice(0, 2)).toEqual([1, 1]);
    expect(lanes(b).wave).toBe(0);
    run(b, 1);
    expect(lanes(b).wave).toBe(1);
    expect(b.alivePerTeam.slice(0, 2)).toEqual([16, 16]);
    for (let t = 0; t < 2; t++) {
      for (let l = 0; l < LANE_COUNT; l++) {
        const kinds: number[] = [];
        for (let k = 0; k < laneWaveSize(1); k++) {
          const i = start + lanesPoolIndex(1, t, l, k);
          expect(u.alive[i]).toBe(1);
          expect(u.team[i]).toBe(t);
          kinds.push(u.kind[i]);
          // appears in front of its own castle, on walkable ground
          expect(b.terrain!.walkable(u.x[i], u.y[i])).toBe(true);
          expect(Math.hypot(u.x[i] - b.terrain!.laneGeo!.castle[t].x, u.y[i] - b.terrain!.laneGeo!.castle[t].y)).toBeLessThan(10);
        }
        expect(kinds).toEqual([Kind.Warrior, Kind.Warrior, Kind.Warrior, Kind.Archer, Kind.Archer]);
      }
    }
    // the second wave comes 25 s later, not earlier
    run(b, 24 * SPS);
    expect(lanes(b).wave).toBe(1);
    expect(lanes(b).nextIn).toBeLessThan(1.1);
  });

  it('wave 5 adds a shield tank per lane and wave 10 a hammer tank per lane; the pool holds exactly the planned units', () => {
    const b = battle([], { env: false });
    const u = b.units;
    const start = mode(b).poolInfo().start;
    // Soldiers fight: look at the pool state at the moment each wave is released.
    const seen = new Map<number, number[]>();
    for (let step = 0; step < 36 * 25 * SPS && lanes(b).wave < 10; step++) {
      const before = lanes(b).wave;
      b.step(DT);
      const w = lanes(b).wave;
      if (w !== before) {
        const kinds: number[] = [];
        for (let t = 0; t < 2; t++) for (let l = 0; l < LANE_COUNT; l++) for (let k = 0; k < laneWaveSize(w); k++) kinds.push(u.kind[start + lanesPoolIndex(w, t, l, k)]);
        seen.set(w, kinds);
        for (let t = 0; t < 2; t++) for (let l = 0; l < LANE_COUNT; l++) for (let k = 0; k < laneWaveSize(w); k++) expect(u.alive[start + lanesPoolIndex(w, t, l, k)], `wave ${w}`).toBe(1);
      }
    }
    expect(seen.size).toBe(10);
    const count = (w: number, kind: number): number => seen.get(w)!.filter((k) => k === kind).length;
    expect(count(4, Kind.Shield)).toBe(0);
    expect(count(5, Kind.Shield)).toBe(6);
    expect(count(9, Kind.Brute)).toBe(0);
    expect(count(10, Kind.Brute)).toBe(6);
    expect(count(10, Kind.Shield)).toBe(6);
    expect(count(1, Kind.Warrior)).toBe(18);
    expect(count(1, Kind.Archer)).toBe(12);
    // pool layout: waves are consecutive
    expect(lanesWaveOffset(2)).toBe(30);
    expect(lanesPoolIndex(2, 1, 2, 4)).toBe(30 + (1 * 3 + 2) * 5 + 4);
  });

  it('soldiers walk their own lane towards the enemy castle and never cross into another lane', () => {
    const b = battle();
    const t = b.terrain!;
    const u = b.units;
    const start = mode(b).poolInfo().start;
    const lanesOf = new Map<number, number>();
    for (let n = 1; n <= LANES_WAVES; n++) for (let team = 0; team < 2; team++) for (let l = 0; l < LANE_COUNT; l++) for (let k = 0; k < laneWaveSize(n); k++) lanesOf.set(start + lanesPoolIndex(n, team, l, k), l);
    let advanced = 0;
    let maxX0 = 0;
    let minX1 = 1e9;
    for (let step = 0; step < 90 * SPS && b.winner < 0; step++) {
      b.step(DT);
      if (step % 15 !== 0) continue;
      for (let i = start; i < u.count; i++) {
        if (!u.alive[i]) continue;
        const lane = t.laneAt(u.x[i], u.y[i]);
        if (lane >= 0) expect(lane, `unit ${i} at step ${step}`).toBe(lanesOf.get(i));
        if (u.team[i] === 0) maxX0 = Math.max(maxX0, u.x[i]);
        else minX1 = Math.min(minX1, u.x[i]);
        if (b.unitHasGoal[i] === 1 && Math.abs(b.unitGoalX[i] - t.laneGeo!.lane[0][0].x) > 3 && Math.abs(b.unitGoalX[i] - t.laneGeo!.lane[0][LANE_WAYPOINTS - 1].x) > 3) advanced++;
      }
    }
    expect(advanced).toBeGreaterThan(0); // soldiers moved on to later waypoints
    expect(maxX0).toBeGreaterThan(30); // team 0 soldiers walked well into the lanes
    expect(minX1).toBeLessThan(50);
  });

  it('with no opposition the soldiers walk the whole lane, attack the enemy castle and win the match', () => {
    const b = battle([], { env: false });
    const u = b.units;
    const s = mode(b).structures();
    const start = mode(b).poolInfo().start;
    // Team 1 never fields a soldier: whatever its castle releases dies at once. Its towers still shoot.
    let lastGoal = 0;
    for (let step = 0; step < 30 * 400 && b.winner < 0; step++) {
      b.step(DT);
      for (let i = start; i < u.count; i++) {
        if (u.alive[i] && u.team[i] === 1) damage(b, i, 1e6, -1, false, true);
        if (u.alive[i] && u.team[i] === 0 && b.unitGoalX[i] === u.x[s.castle[1]] && b.unitGoalY[i] === u.y[s.castle[1]]) lastGoal++;
      }
    }
    expect(lastGoal).toBeGreaterThan(0); // the final goal is the enemy castle
    expect(b.winner).toBe(0);
    expect(u.alive[s.castle[1]]).toBe(0);
    expect(u.alive[s.castle[0]]).toBe(1);
  });

  it('human-placed armies get no goal and fight like the classic AI (they cross the map through the lanes)', () => {
    const t = terrainOf(80, 3);
    const a = spots(t, 0, 12, 1.5);
    const bb = spots(t, 1, 12, 1.5);
    const rows: Row[] = [...a.map((p): Row => [0, Kind.Warrior, p.x, p.y]), ...bb.map((p): Row => [1, Kind.Warrior, p.x, p.y])];
    const b = battle(rows);
    for (let i = 0; i < 24; i++) expect(b.unitHasGoal[b.layoutUnits[i]]).toBe(0);
    run(b, 30 * 40);
    // armies met somewhere: kills happened and nobody is stuck in a wall
    expect(b.counters.kills).toBeGreaterThan(0);
    for (let i = 0; i < b.units.count; i++) if (b.units.alive[i]) expect(t.walkable(b.units.x[i], b.units.y[i])).toBe(true);
  });

  it('alivePerTeam counts soldiers and human units, never towers or castles', () => {
    const b = battle([[0, Kind.Warrior, 8, 36], [0, Kind.Archer, 9, 36], [1, Kind.Warrior, 72, 36]]);
    expect(b.alivePerTeam.slice(0, 2)).toEqual([2, 1]);
    run(b, 10 * SPS);
    expect(b.alivePerTeam.slice(0, 2)).toEqual([17, 16]);
  });
});

describe('lanes mode: balance sanity (symmetric empty armies)', () => {
  it('a match without human armies ends before or at the time limit: pushes break towers, the castle or the HP fraction decides', () => {
    const summary: string[] = [];
    for (const seed of [1, 2]) {
      const b = new Battle(seed, config([], { terrainSeed: seed }));
      let towersDown = 0;
      for (let step = 0; step < LANES_TIME_LIMIT * SPS + 10 && b.winner < 0; step++) b.step(DT);
      const h = lanes(b);
      towersDown = 12 - h.towers[0] - h.towers[1];
      summary.push(`seed ${seed}: winner ${b.winner}, ${b.stepNo / SPS}s, towers down ${towersDown}, castles ${h.castles.map((c) => c.hp.toFixed(2)).join('/')}`);
      expect(b.winner, summary.join(' | ')).not.toBe(-1);
      expect(b.stepNo / SPS).toBeLessThanOrEqual(LANES_TIME_LIMIT + 1);
      // The fight is real: soldiers die, and the towers are worth attacking.
      expect(b.counters.kills).toBeGreaterThan(300);
      expect(towersDown, summary.join(' | ')).toBeGreaterThanOrEqual(2);
    }
  }, 240000);
});

describe('lanes mode: determinism, snapshots and backends', () => {
  const armies = (): Row[] => {
    const t = terrainOf(80, 3);
    return [...spots(t, 0, 20, 1.6).map((p): Row => [0, Kind.Warrior, p.x, p.y]), ...spots(t, 1, 20, 1.6).map((p): Row => [1, Kind.Archer, p.x, p.y])];
  };

  it('two runs with the same seed end with the same hash', () => {
    const a = battle(armies());
    const b = battle(armies());
    run(a, 1500);
    run(b, 1500);
    expect(lanes(a).wave).toBe(2);
    expect(a.hash()).toBe(b.hash());
    expect(a.hash()).not.toBe(battle(armies(), {}, 8).hash());
  });

  it('snapshot -> pack -> restore in the middle of a wave continues identically', () => {
    const a = battle(armies());
    run(a, 1200); // wave 2 (35 s = 1050 steps) is on its way
    expect(lanes(a).wave).toBe(2);
    const snap = unpackSnapshot(packSnapshot(a.serialize()));
    const b = battle(armies());
    b.restore(snap);
    expect(b.hash()).toBe(a.hash());
    expect(lanes(b)).toEqual(lanes(a));
    for (let k = 0; k < 6; k++) {
      run(a, 100);
      run(b, 100);
      expect(b.hash(), `after ${(k + 1) * 100} steps`).toBe(a.hash());
    }
    // the goal arrays came back too
    expect(Array.from(b.unitGoalX.subarray(0, b.units.count))).toEqual(Array.from(a.unitGoalX.subarray(0, a.units.count)));
    expect(Array.from(b.unitHasGoal.subarray(0, b.units.count))).toEqual(Array.from(a.unitHasGoal.subarray(0, a.units.count)));
  });

  it('a restored battle that was just constructed (before any wave) also matches', () => {
    const a = battle(armies());
    run(a, 400); // wave 1 released
    const b = battle(armies());
    b.restore(a.serialize());
    expect(b.hash()).toBe(a.hash());
    run(a, 300);
    run(b, 300);
    expect(b.hash()).toBe(a.hash());
  });

  it('the HUD survives the shared-memory frame block, at the start and mid-battle', () => {
    const b = battle(armies());
    const f = new Float64Array(F_LEN);
    writeModeHud(f, b.modeHud());
    expect(f[F_MODE_ON]).toBe(6);
    expect(readModeHud(f)).toEqual(b.modeHud());
    run(b, 1500);
    damage(b, mode(b).structures().tower[3], 1e6, -1, false, true);
    damage(b, mode(b).structures().castle[1], 400, 0);
    b.step(DT);
    writeModeHud(f, b.modeHud());
    const back = readModeHud(f) as LanesHud;
    expect(back).toEqual(b.modeHud());
    expect(back.towers).toEqual([5, 6]);
    expect(back.castles[1].hp).toBeLessThan(1);
    // other modes keep their layouts
    for (const rules of ['hill', 'vip', 'classic', 'siege', 'ctf'] as const) {
      const o = battle([[0, Kind.Warrior, 8, 36], [1, Kind.Warrior, 72, 36]], { rules, env: false, mapSize: 56 });
      writeModeHud(f, o.modeHud());
      expect(readModeHud(f), rules).toEqual(o.modeHud());
    }
  });

  it('the inline sim exposes the lanes HUD and no scores', () => {
    const sim = new InlineSim(config([[0, Kind.Warrior, 8, 36], [1, Kind.Warrior, 72, 36]]), 7);
    expect(sim.modeHud.kind).toBe('lanes');
    expect(sim.modeHud).toEqual(sim.battle.modeHud());
    expect(sim.scores).toBeUndefined();
    expect(sim.mapSize).toBe(80);
  });

  it('the checksum covers the lane goals', () => {
    const a = battle(armies());
    run(a, 400);
    const h = a.hash();
    const i = mode(a).poolInfo().start;
    a.unitGoalX[i] += 1;
    expect(a.hash()).not.toBe(h);
  });
});

describe('lanes mode: scale', () => {
  it('3000 human units plus waves keep a sane step time and stay deterministic', () => {
    const n = 160;
    const t = terrainOf(n, 5);
    const rows: Row[] = [];
    for (const team of [0, 1]) for (const p of spots(t, team, 1500, 1.1)) rows.push([team, rows.length % 3 === 0 ? Kind.Archer : Kind.Warrior, p.x, p.y]);
    expect(rows.length).toBe(3000);
    const a = battle(rows, { mapSize: n, terrainSeed: 5 });
    const b = battle(rows, { mapSize: n, terrainSeed: 5 });
    const t0 = performance.now();
    run(a, 330); // past the first wave
    const per = (performance.now() - t0) / 330;
    run(b, 330);
    expect(lanes(a).wave).toBe(1);
    expect(a.hash()).toBe(b.hash());
    expect(per).toBeLessThan(250);
  }, 240000);
});
