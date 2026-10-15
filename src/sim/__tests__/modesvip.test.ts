import { describe, expect, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { damage, killUnit } from '../battleDamage';
import { InlineSim } from '../inlineSim';
import { VIP_TIME_LIMIT, modeFor, vipUnitsOf, type ModeHud } from '../modes';
import { F_LEN, readModeHud, writeModeHud } from '../shared';
import { KIND_OF_TROOP, Kind, MAX_TEAMS } from '../units';

const DT = 1 / 30;

type VipHud = Extract<ModeHud, { kind: 'vip' }>;

function vipHud(b: Battle): VipHud {
  const h = b.modeHud();
  if (h.kind !== 'vip') throw new Error('not a vip battle');
  return h;
}

/** Flat layout rows: [team, kind, x, y]. */
type Row = [number, number, number, number];

function battle(rows: Row[], opts: Partial<BattleConfig> = {}, seed = 7): Battle {
  const teams = Math.max(...rows.map((r) => r[0])) + 1;
  return new Battle(seed, { mode: 'custom', perTeam: 0, teamCount: Math.max(2, teams), mapSize: 56, env: true, kite: true, terrainSeed: 3, layout: new Float32Array(rows.flat()), rules: 'vip', ...opts });
}

/** n units of one kind in a small cluster around (cx, cy). */
function cluster(team: number, kind: number, cx: number, cy: number, n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push([team, kind, cx + (i % 3) * 1.2, cy + Math.floor(i / 3) * 1.2]);
  return out;
}

const TWO: Row[] = [...cluster(0, Kind.Warrior, 10, 10, 6), ...cluster(1, Kind.Warrior, 40, 40, 5)];

function aliveOf(b: Battle, team: number): number {
  let n = 0;
  for (let i = 0; i < b.units.count; i++) if (b.units.alive[i] && b.units.team[i] === team) n++;
  return n;
}

describe('vip mode: other modes are unaffected', () => {
  it('config.vips is ignored by classic and hill (same hashes with and without it)', () => {
    for (const rules of ['classic', 'hill'] as const) {
      const a = battle(TWO, { rules });
      const b = battle(TWO, { rules, vips: [3, 2] });
      for (let s = 0; s < 120; s++) {
        a.step(DT);
        b.step(DT);
      }
      expect(b.hash(), rules).toBe(a.hash());
      expect(b.vipUnits().every((v) => v === -1)).toBe(true);
    }
  });

  it('a classic battle exposes no vip units', () => {
    const b = battle(TWO, { rules: 'classic' });
    expect(Array.from(b.vipUnits())).toEqual([-1, -1, -1, -1, -1, -1]);
    expect(b.modeHud()).toEqual({ kind: 'classic' });
  });
});

describe('vip mode: picking the VIP', () => {
  it('auto pick: the unit with the highest max HP, ties go to the lowest index', () => {
    const rows: Row[] = [
      [0, Kind.Archer, 10, 10],
      [0, Kind.Shield, 12, 10],
      [0, Kind.Warrior, 14, 10],
      [0, Kind.Shield, 16, 10],
      [1, Kind.Warrior, 40, 40],
      [1, Kind.Warrior, 42, 40],
    ];
    const b = battle(rows);
    const v = b.vipUnits();
    const u = b.units;
    expect(v[0]).toBe(b.layoutUnits[1]); // first of the two shield tanks
    expect(u.maxHp[v[0]]).toBeGreaterThan(u.maxHp[b.layoutUnits[2]]);
    expect(v[1]).toBe(b.layoutUnits[4]); // all equal: the lowest index
    for (let t = 2; t < MAX_TEAMS; t++) expect(v[t]).toBe(-1);
    const h = vipHud(b);
    expect(h.teams.length).toBe(MAX_TEAMS);
    expect(h.teams[0]).toEqual({ unit: v[0], hp: 1, alive: true });
    expect(h.teams[3]).toEqual({ unit: -1, hp: 0, alive: false });
    expect(h.timeLeft).toBeCloseTo(VIP_TIME_LIMIT, 5);
    expect(b.modeScores()).toBeUndefined();
  });

  it('an explicit pick (layout index) is respected, even when spawnLayout skips an entry before it', () => {
    const rows: Row[] = [
      [0, Kind.Warrior, -300, -300], // no walkable tile near: skipped by spawnLayout, so layout index != unit index below
      [0, Kind.Warrior, 10, 10],
      [0, Kind.Warrior, 12, 10],
      [0, Kind.Shield, 14, 10],
      [1, Kind.Warrior, 40, 40],
      [1, Kind.Archer, 42, 40],
    ];
    const b = battle(rows, { vips: [2, 5] });
    expect(b.layoutUnits).toEqual([-1, 0, 1, 2, 3, 4]);
    const v = b.vipUnits();
    expect(v[0]).toBe(1); // layout 2 -> unit 1
    expect(v[1]).toBe(4); // layout 5 -> unit 4 (the weaker archer, although a warrior has more HP)
    expect(v[0]).toBe(b.layoutUnits[2]);
    // Without the explicit pick the shield tank would win.
    expect(battle(rows).vipUnits()[0]).toBe(2);
  });

  it('invalid picks fall back to auto: skipped entry, other team, out of range, not an integer', () => {
    const rows: Row[] = [[0, Kind.Warrior, -300, -300], ...cluster(0, Kind.Warrior, 10, 10, 2), [0, Kind.Shield, 14, 10], ...cluster(1, Kind.Warrior, 40, 40, 2)];
    const auto = battle(rows).vipUnits();
    // 0: skipped entry; 4 and 5: team 1's units; the rest: out of range or not an index.
    for (const bad of [0, 4, 5, 6, 99, -5, 1.5, NaN, Infinity]) {
      const b = battle(rows, { vips: [bad, -1] });
      expect(Array.from(b.vipUnits()), String(bad)).toEqual(Array.from(auto));
    }
  });

  it('a short or missing vips array means auto for the rest', () => {
    const a = battle(TWO).vipUnits();
    expect(Array.from(battle(TWO, { vips: [] }).vipUnits())).toEqual(Array.from(a));
    const b = battle(TWO, { vips: [-1, 20] }); // team 1 picks layout 20 = out of range
    expect(Array.from(b.vipUnits())).toEqual(Array.from(a));
    expect(battle(TWO, { vips: [3] }).vipUnits()[0]).toBe(3);
  });

  it('a VIP is never a summon-pool unit', () => {
    const caller = KIND_OF_TROOP['bone-caller'];
    const b = battle([[0, caller, 10, 10], ...cluster(1, Kind.Warrior, 40, 40, 3)]);
    expect(b.units.count).toBeGreaterThan(4); // pool skeletons exist
    for (const v of b.vipUnits()) if (v >= 0) expect(b.units.owner[v]).toBe(-1);
    expect(b.vipUnits()[0]).toBe(0);
    // Even an explicit pick of a layout index cannot name a pool unit: pool units are not in the layout.
    expect(battle([[0, caller, 10, 10], ...cluster(1, Kind.Warrior, 40, 40, 3)], { vips: [50, 0] }).vipUnits()[0]).toBe(0);
  });
});

describe('vip mode: the VIP dies, the team dies', () => {
  it('kills the whole team at once through the normal kill path and credits the killer of the VIP', () => {
    const b = battle(TWO);
    const v = b.vipUnits();
    const killer = b.layoutUnits[6]; // a team 1 unit
    const before = b.counters.kills;
    const total = aliveOf(b, 0);
    b.events.length = 0;
    killUnit(b, v[0], killer, 30);
    expect(aliveOf(b, 0)).toBe(0);
    expect(aliveOf(b, 1)).toBe(5);
    expect(b.counters.kills - before).toBe(total);
    expect(b.meter.kills[1]).toBe(total);
    expect(b.meter.kills[0]).toBe(0);
    expect(b.events.filter((e) => e.type === 'death').length).toBe(total);
    const h = vipHud(b);
    expect(h.teams[0]).toEqual({ unit: v[0], hp: 0, alive: false });
    expect(h.teams[1].alive).toBe(true);
    b.step(DT);
    expect(b.winner).toBe(1);
    expect(b.alivePerTeam[0]).toBe(0);
  });

  it('a VIP killed by damage ends the team the same way (and non-VIP deaths do not)', () => {
    const b = battle(TWO);
    const v = b.vipUnits();
    const other = b.layoutUnits.find((i, k) => k < 6 && i !== v[0])!;
    killUnit(b, other, b.layoutUnits[6], 5);
    expect(aliveOf(b, 0)).toBe(5);
    b.units.hp[v[0]] = 0.001;
    damage(b, v[0], 50, b.layoutUnits[6], true);
    expect(aliveOf(b, 0)).toBe(0);
    b.step(DT);
    expect(b.winner).toBe(1);
  });

  it('with 3 teams an eliminated team does not stop the others; the last team standing wins', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 8, 8, 3), ...cluster(1, Kind.Warrior, 44, 8, 3), ...cluster(2, Kind.Warrior, 26, 46, 3)];
    const b = battle(rows);
    const v = b.vipUnits();
    killUnit(b, v[0], b.layoutUnits[3], 1);
    b.step(DT);
    expect(b.winner).toBe(-1);
    expect(aliveOf(b, 0)).toBe(0);
    expect(vipHud(b).teams.map((t) => t.alive)).toEqual([false, true, true, false, false, false]);
    for (let s = 0; s < 30; s++) b.step(DT);
    expect(b.winner).toBe(-1);
    killUnit(b, v[1], b.layoutUnits[6], 1);
    b.step(DT);
    expect(b.winner).toBe(2);
  });

  it('a full battle ends when a VIP falls and the loser has no living units', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 20, 24, 9), ...cluster(1, Kind.Warrior, 30, 24, 9)];
    const b = battle(rows);
    const v = b.vipUnits();
    for (let s = 0; s < 30 * 120 && b.winner === -1; s++) b.step(DT);
    expect(b.winner).toBeGreaterThanOrEqual(-2);
    expect(b.winner).not.toBe(-1);
    if (b.winner >= 0) {
      const loser = 1 - b.winner;
      expect(b.units.alive[v[loser]]).toBe(0);
      expect(aliveOf(b, loser)).toBe(0);
    }
  });
});

describe('vip mode: time limit', () => {
  const far: Row[] = [...cluster(0, Kind.Warrior, 8, 8, 3), ...cluster(1, Kind.Warrior, 44, 44, 3)];

  it('after 10 minutes the VIP with the most health wins; equal health is a draw', () => {
    expect(VIP_TIME_LIMIT).toBe(600);
    const run = (hp0: number, hp1: number): Battle => {
      const b = battle(far);
      const v = b.vipUnits();
      b.units.hp[v[0]] *= hp0;
      b.units.hp[v[1]] *= hp1;
      b.stepNo = VIP_TIME_LIMIT * 30 - 10;
      return b;
    };
    const a = run(0.5, 1);
    for (let s = 0; s < 5; s++) a.step(DT);
    expect(a.winner).toBe(-1);
    expect(vipHud(a).timeLeft).toBeGreaterThan(0);
    for (let s = 0; s < 10; s++) a.step(DT);
    expect(a.winner).toBe(1);
    expect(vipHud(a).timeLeft).toBe(0);
    const c = run(1, 0.5);
    for (let s = 0; s < 15; s++) c.step(DT);
    expect(c.winner).toBe(0);
    const d = run(1, 1);
    for (let s = 0; s < 15; s++) d.step(DT);
    expect(d.winner).toBe(-2);
  });

  it('the classic no-damage draw does not apply (a quiet battle runs on until the limit)', () => {
    const b = battle(far);
    for (let s = 0; s < 30 * 5; s++) b.step(DT);
    expect(b.winner).toBe(-1);
    b.time = 400; // would have been a classic no-damage draw long ago
    b.step(DT);
    expect(b.winner).toBe(-1);
  });
});

describe('vip mode: determinism', () => {
  it('two runs give the same hashes; the mode state is in the hash and in snapshots', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 20, 24, 8), ...cluster(0, Kind.Archer, 16, 24, 3), ...cluster(1, Kind.Warrior, 30, 24, 8), ...cluster(1, Kind.Priest, 34, 24, 2)];
    const a = battle(rows, { vips: [2, 12] });
    const b = battle(rows, { vips: [2, 12] });
    for (let s = 0; s < 400 && a.winner === -1; s++) {
      a.step(DT);
      b.step(DT);
      if (s % 20 === 0) expect(b.hash(), `step ${s}`).toBe(a.hash());
    }
    expect(b.hash()).toBe(a.hash());
    expect(a.serialize().extra.mode!.id).toBe('vip');
    // A different VIP pick changes the hash (the state is checksummed).
    const c = battle(rows, { vips: [3, 12] });
    const d = battle(rows, { vips: [2, 12] });
    expect(c.hash()).not.toBe(d.hash());
  });

  it('snapshot -> restore -> same continuation, including after an elimination', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 8, 8, 4), ...cluster(1, Kind.Warrior, 44, 8, 4), ...cluster(2, Kind.Warrior, 26, 46, 4)];
    const a = battle(rows, { vips: [1, -1, 9] });
    for (let s = 0; s < 40; s++) a.step(DT);
    killUnit(a, a.vipUnits()[0], a.layoutUnits[4], 1);
    for (let s = 0; s < 20; s++) a.step(DT);
    const snap = a.serialize();
    const b = battle(rows, { vips: [1, -1, 9] });
    b.restore(snap);
    expect(b.hash()).toBe(a.hash());
    expect(vipHud(b)).toEqual(vipHud(a));
    for (let s = 0; s < 30 * 200 && a.winner === -1; s++) {
      a.step(DT);
      b.step(DT);
      if (s % 100 === 0) expect(b.hash(), `step ${s}`).toBe(a.hash());
    }
    expect(b.winner).toBe(a.winner);
    expect(a.winner).not.toBe(-1);
  });

  it('restoring a vip snapshot into a classic battle (or the reverse) does not leak mode state', () => {
    const a = battle(TWO);
    a.step(DT);
    const c = battle(TWO, { rules: 'classic' });
    c.restore(a.serialize());
    expect(c.modeHud()).toEqual({ kind: 'classic' });
  });
});

describe('vip mode: HUD data on every backend', () => {
  it('the shared-memory block round-trips the vip HUD exactly (worker path)', () => {
    const rows: Row[] = [...cluster(0, Kind.Warrior, 8, 8, 4), ...cluster(1, Kind.Warrior, 44, 8, 4), ...cluster(2, Kind.Warrior, 26, 46, 4)];
    const b = battle(rows);
    const f = new Float64Array(F_LEN);
    for (let s = 0; s < 80; s++) b.step(DT);
    b.units.hp[b.vipUnits()[1]] *= 0.37;
    writeModeHud(f, b.modeHud());
    expect(readModeHud(f)).toEqual(b.modeHud());
    killUnit(b, b.vipUnits()[2], b.layoutUnits[0], 1);
    writeModeHud(f, b.modeHud());
    const back = readModeHud(f);
    expect(back).toEqual(b.modeHud());
    expect(vipUnitsOf(back)).toEqual(b.vipUnits());
    // Switching back to a classic HUD clears the flag (no stale vip data).
    writeModeHud(f, { kind: 'classic' });
    expect(readModeHud(f)).toEqual({ kind: 'classic' });
  });

  it('hill data keeps its layout next to the vip block', () => {
    const hill = battle(TWO, { rules: 'hill' });
    const f = new Float64Array(F_LEN);
    writeModeHud(f, hill.modeHud());
    expect(readModeHud(f)).toEqual(hill.modeHud());
  });

  it('the inline sim exposes the same modeHud and no scores', () => {
    const sim = new InlineSim({ mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: true, kite: true, terrainSeed: 3, layout: new Float32Array(TWO.flat()), rules: 'vip', vips: [2, 1] }, 7);
    expect(sim.modeHud).toEqual(sim.battle.modeHud());
    expect(sim.modeHud.kind).toBe('vip');
    expect(sim.scores).toBeUndefined();
    expect(Array.from(vipUnitsOf(sim.modeHud))).toEqual(Array.from(sim.battle.vipUnits()));
    expect(sim.battle.vipUnits()[0]).toBe(2);
  });

  it('vipUnitsOf gives -1 for other modes', () => {
    expect(Array.from(vipUnitsOf({ kind: 'classic' }))).toEqual([-1, -1, -1, -1, -1, -1]);
    expect(modeFor('vip').id).toBe('vip');
  });
});

describe('vip mode: performance sanity', () => {
  it('3000 units: the mode adds no noticeable cost per step', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 3000; i++) {
      const t = i % 2;
      rows.push([t, Kind.Warrior, 8 + (i % 50) * 0.9 + t * 0, 8 + Math.floor(i / 50) * 0.9 + t * 0]);
    }
    const mk = (rules: 'classic' | 'vip'): Battle => new Battle(5, { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 120, env: false, kite: true, layout: new Float32Array(rows.flat()), rules });
    const time = (b: Battle): number => {
      b.step(DT); // warm up
      const t0 = performance.now();
      for (let s = 0; s < 15; s++) b.step(DT);
      return performance.now() - t0;
    };
    const classic = time(mk('classic'));
    const vip = time(mk('vip'));
    expect(vip).toBeLessThan(classic * 1.5 + 150);
  }, 120000);
});
