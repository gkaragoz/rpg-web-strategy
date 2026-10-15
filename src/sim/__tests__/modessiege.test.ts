import { describe, expect, it } from 'vitest';
import { placeableKinds } from '../../app/armies';
import { buyable, costTable, teamZones, mapSizeForPlayers } from '../../net/economy';
import { Battle, type BattleConfig, unitCapacity } from '../battle';
import { damage, killUnit, launch, pushUnit } from '../battleDamage';
import { applyFear, applyStun, applyTaunt } from '../battleEffects';
import { InlineSim } from '../inlineSim';
import { GAME_MODE_IDS, SIEGE_CORE_HP, SIEGE_CORE_KIND, SIEGE_TIME_LIMIT, isGameModeId, modeFor, structureKinds, type ModeHud } from '../modes';
import { PRESETS } from '../mapSpec';
import { F_LEN, F_MODE_ON, readModeHud, writeModeHud } from '../shared';
import { packSnapshot, unpackSnapshot } from '../snapshot';
import { Terrain } from '../terrain';
import { KIND_COUNT, KIND_OF_TROOP, Kind, STATS, isStructure } from '../units';
import { TROOPS } from '../data/troops';

const DT = 1 / 30;

type SiegeHud = Extract<ModeHud, { kind: 'siege' }>;

function siege(b: Battle): SiegeHud {
  const h = b.modeHud();
  if (h.kind !== 'siege') throw new Error('not a siege battle');
  return h;
}

/** Flat layout rows: [team, kind, x, y]. */
type Row = [number, number, number, number];

function battle(rows: Row[], opts: Partial<BattleConfig> = {}, seed = 7): Battle {
  const teams = Math.max(...rows.map((r) => r[0])) + 1;
  return new Battle(seed, { mode: 'custom', perTeam: 0, teamCount: Math.max(2, teams), mapSize: 56, env: false, kite: true, terrainSeed: 3, layout: new Float32Array(rows.flat()), rules: 'siege', ...opts });
}

function cluster(team: number, kind: number, cx: number, cy: number, n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push([team, kind, cx + (i % 4) * 1.2, cy + Math.floor(i / 4) * 1.2]);
  return out;
}

/** Defender (team 0) around (12,12), attackers (team 1) around (36,36). */
const TWO: Row[] = [...cluster(0, Kind.Warrior, 12, 12, 4), ...cluster(1, Kind.Warrior, 36, 36, 8)];

function freeze(b: Battle, team: number): void {
  const u = b.units;
  for (let i = 0; i < u.count; i++) if (u.team[i] === team) u.stunT[i] = 1e9;
}

function coreOf(b: Battle): number {
  return siege(b).coreUnit;
}

describe('siege mode: wiring', () => {
  it('siege is a known mode with its own rules and a structure kind', () => {
    expect(GAME_MODE_IDS).toContain('siege');
    expect(isGameModeId('siege')).toBe(true);
    expect(modeFor('siege').id).toBe('siege');
    expect(modeFor('siege').onDamage).toBeTypeOf('function');
    expect(structureKinds('siege')).toEqual([SIEGE_CORE_KIND]);
    for (const id of ['classic', 'hill', 'vip', 'ctf', undefined] as const) expect(structureKinds(id)).toEqual([]);
    expect(SIEGE_CORE_KIND).toBe(KIND_OF_TROOP['siege-core']);
    expect(TROOPS.filter((t) => t.structure)[0].id).toBe('siege-core'); // the first structure; later ones are appended after it
    expect(isStructure(SIEGE_CORE_KIND)).toBe(true);
    expect(STATS.filter((s) => s.structure).length).toBe(3); // siege core + lane castle + lane tower
    const s = STATS[SIEGE_CORE_KIND];
    expect(s.name).toBe('Siege Core');
    expect([s.hp, s.speed, s.power, s.range, s.skill]).toEqual([SIEGE_CORE_HP, 0, 0, 0, null]);
    expect(s.scale).toBe(2);
  });

  it('the structure is hidden from placement, gallery filters, purchase and the host', () => {
    expect(placeableKinds()).not.toContain(SIEGE_CORE_KIND);
    expect(buyable(SIEGE_CORE_KIND)).toBe(false);
    expect(TROOPS.find((t) => t.id === 'siege-core')!.summoned).toBe(true);
    expect(costTable().length).toBe(KIND_COUNT);
    // Normal roster units are still placeable (49 = 5 classic + 45 - the skeleton).
    expect(placeableKinds().length).toBe(49);
  });

  it('only siege reserves a unit slot for the core', () => {
    const base: BattleConfig = { mode: 'custom', perTeam: 0, mapSize: 56, layout: new Float32Array(TWO.flat()) };
    const classic = unitCapacity({ ...base, rules: 'classic' });
    expect(unitCapacity({ ...base, rules: 'siege' })).toBe(classic + 1);
    for (const r of ['hill', 'vip', 'ctf'] as const) expect(unitCapacity({ ...base, rules: r })).toBe(classic);
    expect(unitCapacity({ mode: 'demo', perTeam: 10, rules: 'siege' })).toBe(unitCapacity({ mode: 'demo', perTeam: 10 }) + 1);
  });

  it('spawnStructure rejects ordinary kinds', () => {
    const b = battle(TWO, { rules: 'classic' });
    expect(b.spawnStructure(Kind.Warrior, 0, 5, 5)).toBe(-1);
  });
});

describe('siege mode: the core', () => {
  it('is spawned for the defender with 3000 HP, listed in the HUD, and not counted as an army unit', () => {
    const b = battle(TWO);
    const h = siege(b);
    const c = h.coreUnit;
    expect(c).toBe(b.units.count - 1);
    expect(b.units.kind[c]).toBe(SIEGE_CORE_KIND);
    expect(b.units.team[c]).toBe(0);
    expect(b.units.hp[c]).toBe(3000);
    expect(h.defender).toBe(0);
    expect(h.coreHp).toBe(1);
    expect(h.coreMaxHp).toBe(3000);
    expect(h.timeLeft).toBeCloseTo(SIEGE_TIME_LIMIT, 5);
    expect(h.x).toBeCloseTo(b.units.x[c], 5);
    expect(b.alivePerTeam.slice(0, 2)).toEqual([4, 8]);
    expect(b.structPerTeam.slice(0, 2)).toEqual([1, 0]);
    expect(b.modeScores()).toBeUndefined();
  });

  it('spawns at the centroid of the defender when the map has no keep', () => {
    const b = battle(TWO);
    const h = siege(b);
    expect(h.x).toBeCloseTo(13.8, 4);
    expect(h.y).toBeCloseTo(12, 4);
  });

  it('team siegeDefender defends; invalid values fall back to team 0', () => {
    expect(siege(battle(TWO, { siegeDefender: 1 })).defender).toBe(1);
    expect(battle(TWO, { siegeDefender: 1 }).units.team[coreOf(battle(TWO, { siegeDefender: 1 }))]).toBe(1);
    for (const bad of [-1, 2, 7, 0.5, NaN, Infinity]) expect(siege(battle(TWO, { siegeDefender: bad })).defender, String(bad)).toBe(0);
    expect(siege(battle(TWO)).defender).toBe(0);
  });

  it('stands on the keep of a citadel map, else on the defender centroid; always walkable and reachable (all presets, 2-6 teams, several sizes)', () => {
    let keepMaps = 0;
    for (const p of PRESETS) {
      for (const teams of [2, 3, 4, 6]) {
        for (const size of [mapSizeForPlayers(teams), 120]) {
          const t = new Terrain(size, { seed: 3, spec: p.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
          const rows: Row[] = [];
          for (const z of teamZones(size, teams, t)) {
            const c = t.nearestWalkable(z.cx, z.cy, 12, true) ?? { x: z.cx, y: z.cy };
            for (let k = 0; k < 3; k++) {
              const q = t.nearestWalkable(c.x + k * 1.5, c.y + (k % 2) * 1.5, 6, true) ?? c;
              rows.push([z.team, Kind.Warrior, q.x, q.y]);
            }
          }
          const defender = teams - 1;
          const b = new Battle(5, { mode: 'custom', perTeam: 0, teamCount: teams, mapSize: size, env: true, terrainSeed: 3, map: p.spec, layout: new Float32Array(rows.flat()), rules: 'siege', siegeDefender: defender });
          const h = siege(b);
          const where = `${p.id} ${teams} teams size ${size}`;
          expect(h.coreUnit, where).toBeGreaterThanOrEqual(0);
          expect(b.units.team[h.coreUnit], where).toBe(defender);
          expect(b.terrain!.walkable(h.x, h.y), `${where} walkable`).toBe(true);
          expect(b.terrain!.reachable(h.x, h.y), `${where} reachable`).toBe(true);
          expect([b.units.x[h.coreUnit], b.units.y[h.coreUnit]], where).toEqual([Math.fround(h.x), Math.fround(h.y)]);
          const keep = b.terrain!.decor.find((d) => d.kind === 'keep');
          if (keep) {
            keepMaps++;
            expect(Math.hypot(h.x - keep.x, h.y - keep.y), `${where} near the keep`).toBeLessThan(2.5);
          }
        }
      }
    }
    expect(keepMaps).toBeGreaterThan(0);
  }, 180000);

  it('is deterministic: the same inputs give the same core position', () => {
    const p = PRESETS.find((x) => x.spec.layout === 'citadel')!;
    const mk = (): SiegeHud => siege(new Battle(5, { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 80, env: true, terrainSeed: 9, map: p.spec, layout: new Float32Array(TWO.flat()), rules: 'siege' }));
    expect(mk()).toEqual(mk());
  });
});

describe('siege mode: a structure never acts', () => {
  it('does not move, attack, or react to knockback / launch / stun / fear / taunt', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 12, 12, 2), ...cluster(1, Kind.Brute, 14, 12, 6), [1, Kind.Shield, 15, 14]];
    const b = battle(rows, { comedy: true });
    const c = coreOf(b);
    const u = b.units;
    const x0 = u.x[c];
    const y0 = u.y[c];
    for (let s = 0; s < 400; s++) {
      if (s % 20 === 5) {
        applyStun(b, c, 5);
        applyFear(b, c, 5, x0 + 1, y0);
        applyTaunt(b, c, 8, 5);
        pushUnit(b, c, 1, 0, 6);
        launch(b, c, 1, 0, 9);
        u.kbVx[c] = 40; // even a raw knockback velocity is cleared
      }
      b.step(DT);
      if (!u.alive[c]) break;
      expect([u.x[c], u.y[c]], `step ${s}`).toEqual([Math.fround(x0), Math.fround(y0)]);
      expect([u.stunT[c], u.fearT[c], u.tauntT[c], u.airT[c], u.lift[c], u.kbVx[c], u.swing[c]], `step ${s}`).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(u.target[c]).toBe(-1);
    }
    expect(u.hp[c]).toBeLessThan(3000); // it was attacked
    expect(b.counters.damage).toBeGreaterThan(0);
  });

  it('deals no damage to anyone', () => {
    const b = battle([...cluster(0, Kind.Warrior, 12, 12, 1), ...cluster(1, Kind.Warrior, 14, 12, 1)]);
    freeze(b, 1);
    freeze(b, 0);
    let before = 0;
    for (let i = 0; i < b.units.count; i++) if (b.units.team[i] === 1) before += b.units.hp[i];
    for (let s = 0; s < 200; s++) b.step(DT);
    let after = 0;
    for (let i = 0; i < b.units.count; i++) if (b.units.team[i] === 1) after += b.units.hp[i];
    expect(after).toBe(before);
    expect(b.units.hp[coreOf(b)]).toBe(3000);
  });

  it('attackers do not flee from it and tanks do not push it', () => {
    const b = battle([...cluster(0, Kind.Warrior, 5, 5, 1), ...cluster(1, Kind.Shield, 6.6, 5, 1), ...cluster(1, Kind.Archer, 14, 5, 3)]);
    const c = coreOf(b);
    const x0 = b.units.x[c];
    for (let s = 0; s < 100; s++) b.step(DT);
    expect(b.units.x[c]).toBe(x0);
    for (let i = 0; i < b.units.count; i++) if (b.units.team[i] === 1) expect(b.units.kiteState[i]).toBe(0);
  });
});

describe('siege mode: winning', () => {
  it('attackers target and destroy the core; the attacking team wins and the defender army can be alive', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 10, 10, 2), ...cluster(1, Kind.Warrior, 30, 30, 20), ...cluster(1, Kind.Archer, 32, 34, 8)];
    const b = battle(rows);
    freeze(b, 0);
    const c = coreOf(b);
    let s = 0;
    for (; s < 30 * 120 && b.winner < 0; s++) b.step(DT);
    expect(b.winner).toBe(1);
    expect(b.units.alive[c]).toBe(0);
    expect(siege(b).coreHp).toBe(0);
    expect(siege(b).coreUnit).toBe(c);
  }, 60000);

  it('the defender army wiped out does not end the battle while the core stands', () => {
    const b = battle(TWO);
    freeze(b, 1);
    freeze(b, 0);
    for (let i = 0; i < b.units.count; i++) if (b.units.team[i] === 0 && i !== coreOf(b)) killUnit(b, i, -1);
    for (let s = 0; s < 60; s++) b.step(DT);
    expect(b.alivePerTeam[0]).toBe(0);
    expect(b.winner).toBe(-1);
    expect(b.units.alive[coreOf(b)]).toBe(1);
    // And nothing broke for the attackers: they still see the defender as an enemy team.
    expect(b.enemyList[1]).toContain(0);
  });

  it('the final blow decides: a killer from a third team gets the win', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 10, 10, 2), ...cluster(1, Kind.Warrior, 40, 10, 2), ...cluster(2, Kind.Warrior, 10, 40, 2)];
    const b = battle(rows, { teamCount: 3 });
    freeze(b, 0);
    freeze(b, 1);
    freeze(b, 2);
    const c = coreOf(b);
    const t1 = b.layoutUnits[b.layoutUnits.findIndex((_, k) => rows[k][0] === 1)];
    const t2 = b.layoutUnits[b.layoutUnits.findIndex((_, k) => rows[k][0] === 2)];
    damage(b, c, 100, t1, true);
    damage(b, c, 100000, t2, true);
    b.step(DT);
    expect(b.winner).toBe(2);
  });

  it('an unknown killer (damage over time) credits the attacker team with the most damage on the core', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 10, 10, 2), ...cluster(1, Kind.Warrior, 40, 10, 2), ...cluster(2, Kind.Warrior, 10, 40, 2)];
    const b = battle(rows, { teamCount: 3 });
    for (const t of [0, 1, 2]) freeze(b, t);
    const c = coreOf(b);
    const t1 = b.layoutUnits[rows.findIndex((r) => r[0] === 1)];
    const t2 = b.layoutUnits[rows.findIndex((r) => r[0] === 2)];
    damage(b, c, 300, t2, true);
    damage(b, c, 100, t1, true);
    damage(b, c, 99999, -1, false, true); // environment finishes it
    b.step(DT);
    expect(b.winner).toBe(2);
  });

  it('a defender killing its own core (or damage by nobody) credits the top attacker, or a draw if nobody hurt it', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 10, 10, 2), ...cluster(1, Kind.Warrior, 40, 10, 2)];
    const a = battle(rows);
    for (const t of [0, 1]) freeze(a, t);
    damage(a, coreOf(a), 50, a.layoutUnits[rows.findIndex((r) => r[0] === 1)], true);
    damage(a, coreOf(a), 1e6, a.layoutUnits[0], true); // friendly fire by the defender
    a.step(DT);
    expect(a.winner).toBe(1);
    const b = battle(rows);
    for (const t of [0, 1]) freeze(b, t);
    killUnit(b, coreOf(b), -1);
    b.step(DT);
    expect(b.winner).toBe(-2);
  });

  it('300 seconds with the core alive: the defender wins', () => {
    const b = battle(TWO);
    freeze(b, 0);
    freeze(b, 1);
    const limit = SIEGE_TIME_LIMIT * 30;
    b.stepNo = limit - 5;
    for (let s = 0; s < 4; s++) b.step(DT);
    expect(b.winner).toBe(-1);
    b.step(DT);
    b.step(DT);
    expect(b.winner).toBe(0);
    expect(siege(b).timeLeft).toBe(0);
  });

  it('all attackers dead: the defender wins at once', () => {
    const b = battle(TWO);
    for (let i = 0; i < b.units.count; i++) if (b.units.team[i] === 1) killUnit(b, i, -1);
    b.step(DT);
    expect(b.winner).toBe(0);
  });

  it('with two attacking teams the battle goes on while one of them lives, and the core standing keeps the defender in', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 10, 10, 2), ...cluster(1, Kind.Warrior, 40, 10, 2), ...cluster(2, Kind.Warrior, 10, 40, 2)];
    const b = battle(rows, { teamCount: 3 });
    for (let i = 0; i < b.units.count; i++) if (b.units.team[i] === 1) killUnit(b, i, -1);
    b.step(DT);
    expect(b.winner).toBe(-1);
    for (let i = 0; i < b.units.count; i++) if (b.units.team[i] === 2) killUnit(b, i, -1);
    b.step(DT);
    expect(b.winner).toBe(0);
  });

  it('the classic no-damage draw does not end a quiet siege', () => {
    const b = battle(TWO);
    freeze(b, 0);
    freeze(b, 1);
    for (let s = 0; s < 30 * 200; s++) b.step(DT);
    expect(b.winner).toBe(-1);
  });
});

describe('siege mode: goals', () => {
  it('attackers and defenders without a target head for the core', () => {
    const b = battle(TWO);
    b.step(DT);
    const h = siege(b);
    expect([b.teamHasGoal[0], b.teamHasGoal[1]]).toEqual([1, 1]);
    expect([b.teamGoalX[1], b.teamGoalY[1]]).toEqual([Math.fround(h.x), Math.fround(h.y)]);
  });
});

describe('siege mode: determinism and snapshots', () => {
  it('two runs give the same hash at every checkpoint', () => {
    const a = battle(TWO);
    const b = battle(TWO);
    for (let s = 0; s < 500; s++) {
      a.step(DT);
      b.step(DT);
      if (s % 20 === 0) expect(b.hash(), `step ${s}`).toBe(a.hash());
    }
    expect(b.modeHud()).toEqual(a.modeHud());
  });

  it('snapshot -> restore -> same continuation, with a damaged core', () => {
    const close: Row[] = [...cluster(0, Kind.Warrior, 12, 12, 4), ...cluster(1, Kind.Warrior, 17, 12, 8)];
    const a = battle(close);
    for (let s = 0; s < 250; s++) {
      if (s === 100) damage(a, coreOf(a), 800, a.layoutUnits[5], true);
      a.step(DT);
    }
    expect(siege(a).coreHp).toBeLessThan(1);
    const snap = unpackSnapshot(packSnapshot(a.serialize()));
    const b = battle(close);
    b.restore(snap);
    expect(b.hash()).toBe(a.hash());
    expect(b.modeHud()).toEqual(a.modeHud());
    for (let s = 0; s < 600; s++) {
      a.step(DT);
      b.step(DT);
      if (s % 10 === 0) expect(b.hash(), `continued step ${s}`).toBe(a.hash());
    }
    expect(b.winner).toBe(a.winner);
  });

  it('the structure and the mode state are part of the hash', () => {
    const a = battle(TWO);
    const b = battle(TWO);
    expect(a.hash()).toBe(b.hash());
    b.units.hp[coreOf(b)] -= 1;
    expect(a.hash()).not.toBe(b.hash());
    const c = battle(TWO);
    const st = c.mode.serialize();
    st[4] = 1; // credited winner
    c.mode.restore(st);
    expect(a.hash()).not.toBe(c.hash());
    // Another defender is another battle.
    expect(battle(TWO, { siegeDefender: 1 }).hash()).not.toBe(a.hash());
  });

  it('classic is untouched by the structure support (no core, same capacity)', () => {
    const b = battle(TWO, { rules: 'classic' });
    expect(b.units.count).toBe(TWO.length);
    expect(b.alivePerTeam.slice(0, 2)).toEqual([4, 8]);
    expect(b.structPerTeam.every((n) => n === 0)).toBe(true);
  });
});

describe('siege mode: backends', () => {
  it('HUD survives the shared-memory frame block (full, damaged, destroyed)', () => {
    const b = battle(TWO);
    const f = new Float64Array(F_LEN);
    writeModeHud(f, b.modeHud());
    expect(f[F_MODE_ON]).toBe(4);
    expect(readModeHud(f)).toEqual(b.modeHud());
    damage(b, coreOf(b), 900, 5, true);
    writeModeHud(f, b.modeHud());
    expect(readModeHud(f)).toEqual(b.modeHud());
    expect(siege(b).coreHp).toBeLessThan(1);
    killUnit(b, coreOf(b), 5);
    writeModeHud(f, b.modeHud());
    expect(readModeHud(f)).toEqual(b.modeHud());
    expect(siege(b).coreHp).toBe(0);
  });

  it('other modes keep their frame layouts', () => {
    for (const rules of ['hill', 'vip', 'ctf', 'classic'] as const) {
      const b = battle(TWO, { rules });
      const f = new Float64Array(F_LEN);
      writeModeHud(f, b.modeHud());
      expect(readModeHud(f), rules).toEqual(b.modeHud());
    }
  });

  it('the inline sim exposes the siege HUD and no scores', () => {
    const sim = new InlineSim({ mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: false, kite: true, terrainSeed: 3, layout: new Float32Array(TWO.flat()), rules: 'siege' }, 7);
    expect(sim.modeHud).toEqual(sim.battle.modeHud());
    expect(sim.modeHud.kind).toBe('siege');
    expect(sim.scores).toBeUndefined();
    expect(sim.alivePerTeam.slice(0, 2)).toEqual([4, 8]);
  });
});

describe('siege mode: performance sanity', () => {
  it('3000 units: a siege step costs about the same as a classic one', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 3000; i++) {
      const t = i % 2;
      rows.push([t, Kind.Warrior, 4 + (i % 50) * 0.9, 4 + Math.floor(i / 50) * 0.9 + t * 60]);
    }
    const time = (rules: 'siege' | 'classic'): number => {
      const b = battle(rows, { mapSize: 120, rules });
      b.step(DT);
      const t0 = performance.now();
      for (let s = 0; s < 20; s++) b.step(DT);
      return (performance.now() - t0) / 20;
    };
    time('classic');
    const classic = time('classic');
    const sg = time('siege');
    expect(sg).toBeLessThan(classic * 1.6 + 8);
  }, 120000);

  it('the roster id resolves to the structure kind', () => {
    expect(KIND_OF_TROOP['siege-core']).toBe(SIEGE_CORE_KIND);
  });
});
