import { describe, expect, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { killUnit } from '../battleDamage';
import { teamZones, mapSizeForPlayers } from '../../net/economy';
import { InlineSim } from '../inlineSim';
import { CTF_TARGET, CTF_TIME_LIMIT, ctfRadius, modeFor, type ModeHud } from '../modes';
import { PRESETS } from '../mapSpec';
import { F_LEN, readModeHud, writeModeHud } from '../shared';
import { packSnapshot, unpackSnapshot } from '../snapshot';
import { Terrain } from '../terrain';
import { KIND_OF_TROOP, Kind, MAX_TEAMS } from '../units';

const DT = 1 / 30;

type CtfHud = Extract<ModeHud, { kind: 'ctf' }>;

function ctf(b: Battle): CtfHud {
  const h = b.modeHud();
  if (h.kind !== 'ctf') throw new Error('not a ctf battle');
  return h;
}

/** Flat layout rows: [team, kind, x, y]. */
type Row = [number, number, number, number];

function battle(rows: Row[], opts: Partial<BattleConfig> = {}, seed = 7): Battle {
  const teams = Math.max(...rows.map((r) => r[0])) + 1;
  return new Battle(seed, { mode: 'custom', perTeam: 0, teamCount: Math.max(2, teams), mapSize: 56, env: false, kite: true, terrainSeed: 3, layout: new Float32Array(rows.flat()), rules: 'ctf', ...opts });
}

function cluster(team: number, kind: number, cx: number, cy: number, n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push([team, kind, cx + (i % 3) * 1.2, cy + Math.floor(i / 3) * 1.2]);
  return out;
}

/** Team 0 around (10,10), team 1 around (44,44): bases near the cluster centroids. */
const TWO: Row[] = [...cluster(0, Kind.Warrior, 10, 10, 4), ...cluster(1, Kind.Warrior, 44, 44, 4)];

/** Team units cannot act (so tests control exactly who moves). */
function freeze(b: Battle, team: number): void {
  const u = b.units;
  for (let i = 0; i < u.count; i++) if (u.team[i] === team) u.stunT[i] = 1e9;
}

function teleport(b: Battle, i: number, x: number, y: number): void {
  b.units.x[i] = b.units.px[i] = x;
  b.units.y[i] = b.units.py[i] = y;
}

function flagOf(b: Battle, team: number) {
  const f = ctf(b).flags.find((x) => x.team === team);
  if (!f) throw new Error('no flag for team ' + team);
  return f;
}

function homeOf(b: Battle, team: number): { x: number; y: number } {
  const st = b.mode.serialize();
  return { x: st[2 * MAX_TEAMS + team * 3], y: st[2 * MAX_TEAMS + team * 3 + 1] };
}

describe('ctf mode: setup and the HUD', () => {
  it('ctf has its own rules and a flag per team that has units', () => {
    expect(modeFor('ctf').id).toBe('ctf');
    expect(modeFor('ctf').drive).toBeTypeOf('function');
    for (const id of ['classic', 'hill', 'vip'] as const) expect(modeFor(id).drive).toBeUndefined();
    const b = battle(TWO);
    const h = ctf(b);
    expect(h.captures).toEqual([0, 0, 0, 0, 0, 0]);
    expect(h.target).toBe(CTF_TARGET);
    expect(h.radius).toBe(ctfRadius(56));
    expect(h.radius).toBeCloseTo(Math.max(3, 56 * 0.05), 9);
    expect(h.timeLeft).toBeCloseTo(CTF_TIME_LIMIT, 5);
    expect(h.flags.map((f) => f.team)).toEqual([0, 1]);
    for (const f of h.flags) expect([f.carrier, f.carrierTeam]).toEqual([-1, -1]);
    // The base is the centroid of the team's units (flat bare map: no snapping needed).
    expect(h.flags[0].x).toBeCloseTo(10.9, 4);
    expect(h.flags[1].x).toBeCloseTo(44.9, 4);
    expect(b.modeScores()).toEqual([0, 0]);
  });

  it('a team without units has no flag', () => {
    const b = battle(cluster(0, Kind.Warrior, 10, 10, 3).concat(cluster(2, Kind.Warrior, 40, 40, 3)), { teamCount: 3 });
    expect(ctf(b).flags.map((f) => f.team)).toEqual([0, 2]);
  });
});

describe('ctf mode: pickup', () => {
  it('the lowest unit index wins when two enemies touch the flag in the same check', () => {
    const b = battle(TWO);
    freeze(b, 1);
    const base = homeOf(b, 1);
    teleport(b, 3, base.x + 0.2, base.y); // nearer, but a higher index
    teleport(b, 1, base.x + 2, base.y);
    b.step(DT);
    const f = flagOf(b, 1);
    expect(f.carrier).toBe(1);
    expect(f.carrierTeam).toBe(0);
    expect(flagOf(b, 0).carrier).toBe(-1);
  });

  it('own units at their own base do not pick anything up; a flag has at most one carrier', () => {
    const b = battle(TWO);
    freeze(b, 1);
    b.step(DT);
    expect(ctf(b).flags.every((f) => f.carrier === -1)).toBe(true);
    const base = homeOf(b, 1);
    for (const i of [0, 1, 2]) teleport(b, i, base.x, base.y);
    b.step(DT);
    for (let s = 0; s < 8; s++) b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(0);
  });

  it('one carrier takes one flag only; another unit takes the second flag', () => {
    const rows = [...cluster(0, Kind.Warrior, 8, 8, 3), ...cluster(1, Kind.Warrior, 44, 10, 3), ...cluster(2, Kind.Warrior, 28, 46, 3)];
    const b = battle(rows, { teamCount: 3 });
    for (const t of [1, 2]) freeze(b, t);
    const b1 = homeOf(b, 1);
    const b2 = homeOf(b, 2);
    teleport(b, 0, b1.x, b1.y);
    teleport(b, 1, b2.x, b2.y);
    b.step(DT);
    const h = ctf(b);
    expect(h.flags.length).toBe(3);
    expect(flagOf(b, 1).carrier).toBe(0);
    expect(flagOf(b, 2).carrier).toBe(1);
    expect(flagOf(b, 2).carrierTeam).toBe(0);
  });

  it('pool, summoned and dormant units never carry', () => {
    const caller = KIND_OF_TROOP['bone-caller'];
    const b = battle([[0, caller, 10, 10], ...cluster(1, Kind.Warrior, 44, 44, 3)]);
    freeze(b, 1);
    const u = b.units;
    const base = homeOf(b, 1);
    const pool = [...u.owner].map((o, i) => (o >= 0 ? i : -1)).filter((i) => i >= 0 && i < u.count);
    expect(pool.length).toBeGreaterThan(0);
    // Dormant pool units (not alive) inside the enemy base.
    for (const i of pool) teleport(b, i, base.x, base.y);
    b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(-1);
    // A summoned (alive) pool unit inside the enemy base.
    u.alive[pool[0]] = 1;
    u.hp[pool[0]] = u.maxHp[pool[0]];
    for (let s = 0; s < 12; s++) b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(-1);
    // The summoner itself can.
    teleport(b, 0, base.x, base.y);
    for (let s = 0; s < 8; s++) b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(0);
  });
});

describe('ctf mode: carrying, capturing, dying', () => {
  it('the carrier walks home, ignores the fight, and a capture scores and returns the flag', () => {
    const b = battle(TWO);
    freeze(b, 1);
    const base1 = homeOf(b, 1);
    const base0 = homeOf(b, 0);
    teleport(b, 0, base1.x, base1.y);
    b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(0);
    const u = b.units;
    const d0 = Math.hypot(u.x[0] - base0.x, u.y[0] - base0.y);
    for (let s = 0; s < 60; s++) b.step(DT);
    const d1 = Math.hypot(u.x[0] - base0.x, u.y[0] - base0.y);
    expect(d1).toBeLessThan(d0 - 3);
    // The flag travels with the carrier.
    const f = flagOf(b, 1);
    expect(f.x).toBeCloseTo(u.x[0], 9);
    expect(f.y).toBeCloseTo(u.y[0], 9);
    let s = 0;
    while (ctf(b).captures[0] === 0 && s++ < 3000) b.step(DT);
    const h = ctf(b);
    expect(h.captures).toEqual([1, 0, 0, 0, 0, 0]);
    expect(flagOf(b, 1)).toMatchObject({ carrier: -1, carrierTeam: -1, x: base1.x, y: base1.y });
    expect(b.winner).toBe(-1);
    expect(b.modeScores()).toEqual([1, 0]);
    // The released unit fights again: it is no longer driven.
    expect(b.mode.drive!(b, 0, DT)).toBe(false);
  });

  it('carrier death returns the flag home at once and stays consistent', () => {
    const b = battle(TWO);
    freeze(b, 1);
    const base1 = homeOf(b, 1);
    teleport(b, 0, base1.x, base1.y);
    b.step(DT);
    for (let s = 0; s < 20; s++) b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(0);
    const kills = b.meter.kills[1];
    killUnit(b, 0, 5, 0);
    expect(flagOf(b, 1)).toMatchObject({ carrier: -1, carrierTeam: -1, x: base1.x, y: base1.y });
    expect(b.meter.kills[1]).toBe(kills + 1);
    expect(ctf(b).captures).toEqual([0, 0, 0, 0, 0, 0]);
    // The flag can be taken again by the next unit.
    teleport(b, 2, base1.x, base1.y);
    for (let s = 0; s < 8; s++) b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(2);
  });

  it('a stunned carrier does not move', () => {
    const b = battle(TWO);
    freeze(b, 1);
    const base1 = homeOf(b, 1);
    teleport(b, 0, base1.x, base1.y);
    b.step(DT);
    b.units.stunT[0] = 1e9;
    const x = b.units.x[0];
    for (let s = 0; s < 30; s++) b.step(DT);
    expect(Math.abs(b.units.x[0] - x)).toBeLessThan(0.3); // only soft separation moves it, no walking (~3 tiles)
  });
});

describe('ctf mode: team goals', () => {
  it('attack the nearest enemy flag, escort the carrier home, hunt the carrier of my flag', () => {
    const b = battle(TWO);
    freeze(b, 1);
    const base0 = homeOf(b, 0);
    const base1 = homeOf(b, 1);
    b.step(DT);
    expect([b.teamHasGoal[0], b.teamGoalX[0], b.teamGoalY[0]]).toEqual([1, Math.fround(base1.x), Math.fround(base1.y)]);
    expect([b.teamHasGoal[1], b.teamGoalX[1], b.teamGoalY[1]]).toEqual([1, Math.fround(base0.x), Math.fround(base0.y)]);
    teleport(b, 0, base1.x, base1.y);
    for (let s = 0; s < 6; s++) b.step(DT);
    expect(flagOf(b, 1).carrier).toBe(0);
    // Team 0 escorts: goal = own base. Team 1 hunts: goal = the carrier's position.
    expect([b.teamGoalX[0], b.teamGoalY[0]]).toEqual([Math.fround(base0.x), Math.fround(base0.y)]);
    expect(Math.abs(b.teamGoalX[1] - b.units.x[0])).toBeLessThan(1.5);
    expect(Math.abs(b.teamGoalY[1] - b.units.y[0])).toBeLessThan(1.5);
    // The flag returns: back to attack goals.
    killUnit(b, 0, -1, 0);
    for (let s = 0; s < 6; s++) b.step(DT);
    expect([b.teamGoalX[0], b.teamGoalY[0]]).toEqual([Math.fround(base1.x), Math.fround(base1.y)]);
  });

  it('with three teams everyone heads for the nearest enemy flag that is at home', () => {
    const rows = [...cluster(0, Kind.Warrior, 8, 8, 3), ...cluster(1, Kind.Warrior, 44, 10, 3), ...cluster(2, Kind.Warrior, 28, 46, 3)];
    const b = battle(rows, { teamCount: 3 });
    for (const t of [0, 1, 2]) freeze(b, t);
    b.step(DT);
    for (let t = 0; t < 3; t++) {
      expect(b.teamHasGoal[t]).toBe(1);
      let best = -1;
      let bd = Infinity;
      for (let f = 0; f < 3; f++) {
        if (f === t) continue;
        const h = homeOf(b, f);
        const d = (h.x - b.centroidX[t]) ** 2 + (h.y - b.centroidY[t]) ** 2;
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
      expect([b.teamGoalX[t], b.teamGoalY[t]]).toEqual([Math.fround(homeOf(b, best).x), Math.fround(homeOf(b, best).y)]);
    }
  });
});

describe('ctf mode: winning', () => {
  it('first to 3 captures wins and the result carries the captures', () => {
    const b = battle(TWO);
    freeze(b, 1);
    let s = 0;
    while (b.winner === -1 && s++ < 8000) {
      const f = flagOf(b, 1);
      if (f.carrier < 0 && b.units.alive[0]) {
        const h = homeOf(b, 1);
        teleport(b, 0, h.x, h.y);
      }
      b.step(DT);
    }
    expect(b.winner).toBe(0);
    expect(b.modeScores()).toEqual([CTF_TARGET, 0]);
    expect(b.scores).toEqual([CTF_TARGET, 0]);
  });

  it('the last team standing wins even without captures, and a team with no units cannot capture', () => {
    const b = battle(TWO);
    const u = b.units;
    for (let i = 0; i < u.count; i++) if (u.team[i] === 1) killUnit(b, i, 0, 0);
    b.countAlive();
    b.step(DT);
    expect(b.winner).toBe(0);
    expect(b.modeScores()).toEqual([0, 0]);
  });

  it('after 10 minutes the most captures win; a tie or all zero is a draw', () => {
    const run = (caps: number[]): number => {
      const b = battle(TWO);
      freeze(b, 0);
      freeze(b, 1);
      const st = b.mode.serialize();
      for (let t = 0; t < MAX_TEAMS; t++) st[t] = caps[t] ?? 0;
      b.mode.restore(st);
      b.stepNo = CTF_TIME_LIMIT * 30 - 3;
      b.step(DT);
      b.step(DT);
      expect(b.winner).toBe(-1);
      b.step(DT);
      return b.winner;
    };
    expect(run([1, 2])).toBe(1);
    expect(run([2, 0])).toBe(0);
    expect(run([1, 1])).toBe(-2);
    expect(run([0, 0])).toBe(-2);
  });

  it('the classic no-damage draw does not end a quiet capture battle', () => {
    const b = battle(TWO);
    freeze(b, 0);
    freeze(b, 1);
    for (let s = 0; s < 30 * 100; s++) b.step(DT);
    expect(b.winner).toBe(-1);
  });
});

describe('ctf mode: determinism', () => {
  const script = (b: Battle, s: number): void => {
    if (s === 3) teleport(b, 0, homeOf(b, 1).x, homeOf(b, 1).y);
  };

  it('two runs give the same hash at every checkpoint', () => {
    const a = battle(TWO);
    const b = battle(TWO);
    for (let s = 0; s < 400; s++) {
      script(a, s);
      script(b, s);
      a.step(DT);
      b.step(DT);
      if (s % 20 === 0) expect(b.hash(), `step ${s}`).toBe(a.hash());
    }
    expect(b.modeHud()).toEqual(a.modeHud());
  });

  it('snapshot -> restore -> same continuation, including a flag in transit', () => {
    const a = battle(TWO);
    for (let s = 0; s < 40; s++) {
      script(a, s);
      a.step(DT);
    }
    expect(ctf(a).flags.some((f) => f.carrier >= 0)).toBe(true);
    const snap = unpackSnapshot(packSnapshot(a.serialize()));
    const b = battle(TWO);
    b.restore(snap);
    expect(b.hash()).toBe(a.hash());
    expect(b.modeHud()).toEqual(a.modeHud());
    for (let s = 0; s < 500; s++) {
      a.step(DT);
      b.step(DT);
      if (s % 10 === 0) expect(b.hash(), `continued step ${s}`).toBe(a.hash());
    }
    expect(b.winner).toBe(a.winner);
    expect(b.modeScores()).toEqual(a.modeScores());
  });

  it('mode state changes the hash (carrier is part of it)', () => {
    const a = battle(TWO);
    const b = battle(TWO);
    freeze(a, 1);
    freeze(b, 1);
    teleport(a, 0, homeOf(a, 1).x, homeOf(a, 1).y);
    teleport(b, 0, homeOf(a, 1).x, homeOf(a, 1).y);
    a.step(DT);
    b.step(DT);
    expect(a.hash()).toBe(b.hash());
    const st = b.mode.serialize();
    st[MAX_TEAMS + 1] = -1; // drop the carrier of flag 1
    b.mode.restore(st);
    expect(a.hash()).not.toBe(b.hash());
  });
});

describe('ctf mode: bases on every preset map', () => {
  it('are walkable and reachable for 2-6 teams on all presets and several sizes', () => {
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
          const b = new Battle(5, { mode: 'custom', perTeam: 0, teamCount: teams, mapSize: size, env: true, terrainSeed: 3, map: p.spec, layout: new Float32Array(rows.flat()), rules: 'ctf' });
          const flags = ctf(b).flags;
          expect(flags.length, `${p.id} ${teams} teams`).toBe(teams);
          for (const f of flags) {
            expect(b.terrain!.walkable(f.x, f.y), `${p.id} t${f.team} walkable`).toBe(true);
            expect(b.terrain!.reachable(f.x, f.y), `${p.id} t${f.team} reachable`).toBe(true);
          }
        }
      }
    }
  }, 120000);
});

describe('ctf mode: backends', () => {
  it('HUD survives the shared-memory frame block, for a flag at home and one in transit', () => {
    const b = battle(TWO);
    freeze(b, 1);
    const f = new Float64Array(F_LEN);
    writeModeHud(f, b.modeHud());
    expect(readModeHud(f)).toEqual(b.modeHud());
    teleport(b, 0, homeOf(b, 1).x, homeOf(b, 1).y);
    for (let s = 0; s < 30; s++) b.step(DT);
    expect(ctf(b).flags.some((x) => x.carrier >= 0)).toBe(true);
    writeModeHud(f, b.modeHud());
    expect(readModeHud(f)).toEqual(b.modeHud());
  });

  it('six teams fit in the frame block', () => {
    const rows: Row[] = [];
    for (let t = 0; t < 6; t++) rows.push(...cluster(t, Kind.Warrior, 8 + (t % 3) * 18, 8 + Math.floor(t / 3) * 30, 2));
    const b = battle(rows, { teamCount: 6, mapSize: 70 });
    teleport(b, 0, homeOf(b, 5).x, homeOf(b, 5).y);
    b.step(DT);
    const f = new Float64Array(F_LEN);
    writeModeHud(f, b.modeHud());
    expect(readModeHud(f)).toEqual(b.modeHud());
    expect(ctf(b).flags.length).toBe(6);
  });

  it('other modes keep their frame layouts', () => {
    for (const rules of ['hill', 'vip', 'classic'] as const) {
      const b = battle(TWO, { rules });
      const f = new Float64Array(F_LEN);
      writeModeHud(f, b.modeHud());
      expect(readModeHud(f), rules).toEqual(b.modeHud());
    }
  });

  it('the inline sim exposes the ctf HUD and the captures as scores', () => {
    const sim = new InlineSim({ mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: false, kite: true, terrainSeed: 3, layout: new Float32Array(TWO.flat()), rules: 'ctf' }, 7);
    expect(sim.modeHud).toEqual(sim.battle.modeHud());
    expect(sim.modeHud.kind).toBe('ctf');
    expect(sim.scores).toEqual([0, 0]);
  });
});

describe('ctf mode: performance sanity', () => {
  it('3000 units: the mode adds no noticeable cost per step', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 3000; i++) {
      const t = i % 2;
      rows.push([t, Kind.Warrior, 4 + (i % 50) * 0.9 + t * 0, 4 + Math.floor(i / 50) * 0.9 + t * 0]);
      if (t === 1) rows[rows.length - 1][2] += 0; // same area, the mode only needs positions
    }
    const b = battle(rows, { mapSize: 120 });
    b.step(DT);
    const t0 = performance.now();
    for (let s = 0; s < 100; s++) {
      b.stepNo++;
      b.mode.step(b, DT);
    }
    const per = (performance.now() - t0) / 100;
    expect(per).toBeLessThan(5);
  });
});
