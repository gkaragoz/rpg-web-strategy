import { describe, expect, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { DEFAULT_MAP } from '../mapSpec';
import { makeScenario } from '../testing/scenarios';
import { checkInvariants, runScenario } from '../testing/stall';
import { T_WATER } from '../terrain';

function duel(comedy: boolean, seed = 5): Battle {
  const layout = [0, 0, 8, 8, 1, 0, 40, 40];
  const config: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: 56, env: true, kite: true, terrainSeed: 3, map: DEFAULT_MAP, comedy, layout: new Float32Array(layout) };
  return new Battle(seed, config);
}

/** Birimi (x0,y0) -> (x1,y1) hedefli ucusa sokar (firlatma jitter'i olmadan), inene kadar adimlar. */
function flyTo(b: Battle, i: number, x1: number, y1: number): void {
  const u = b.units;
  u.airX0[i] = u.x[i];
  u.airY0[i] = u.y[i];
  u.airX1[i] = x1;
  u.airY1[i] = y1;
  u.airDur[i] = 0.4;
  u.airT[i] = 0.4;
  u.airH[i] = 2;
  for (let s = 0; s < 40 && u.airT[i] > 0; s++) {
    b.step(1 / 30);
    expect(u.lift[i]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(u.x[i]) && Number.isFinite(u.y[i])).toBe(true);
  }
}

describe('komedi fizigi', () => {
  it('suya inen birim boguluyor, cimene inen hayatta kalip yatiyor', () => {
    const b = duel(true);
    const t = b.terrain!;
    // Suyun merkezinden ve kara bir noktadan sec.
    let water = { x: 0, y: 0 };
    let land = { x: 0, y: 0 };
    outer: for (let y = 20; y < 36; y++) for (let x = 20; x < 36; x++) if (t.flags[y * t.size + x] === T_WATER) { water = { x: x + 0.5, y: y + 0.5 }; break outer; }
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) if (t.walkable(x + 0.5, y + 0.5) && t.reachable(x + 0.5, y + 0.5)) { land = { x: x + 0.5, y: y + 0.5 }; break; }
    expect(water.x).toBeGreaterThan(0);
    flyTo(b, 0, water.x, water.y);
    expect(b.units.alive[0]).toBe(0);
    const c = duel(true);
    flyTo(c, 0, land.x, land.y);
    expect(c.units.alive[0]).toBe(1);
    expect(c.units.lift[0]).toBe(0);
    expect(c.units.stunT[0]).toBeGreaterThan(0.5);
    expect(c.terrain!.walkable(c.units.x[0], c.units.y[0])).toBe(true);
  });

  it('engel uzerine inen birim en yakin yurunebilir noktaya konur', () => {
    const b = duel(true);
    const t = b.terrain!;
    let blocked: { x: number; y: number } | null = null;
    for (let y = 2; y < 54 && !blocked; y++) for (let x = 2; x < 54; x++) if (t.flags[y * t.size + x] === 3) { blocked = { x: x + 0.5, y: y + 0.5 }; break; }
    expect(blocked).not.toBeNull();
    flyTo(b, 0, blocked!.x, blocked!.y);
    expect(b.units.alive[0]).toBe(1);
    expect(t.walkable(b.units.x[0], b.units.y[0])).toBe(true);
  });

  it('mod kapaliyken birim hic havalanmaz', () => {
    const sc = makeScenario(12);
    const b = new Battle(sc.simSeed, { ...sc.config, comedy: false });
    let maxLift = 0;
    for (let s = 0; s < 30 * 40 && b.winner === -1; s++) {
      b.step(1 / 30);
      for (let i = 0; i < b.units.count; i++) maxLift = Math.max(maxLift, b.units.lift[i]);
    }
    expect(maxLift).toBe(0);
  });

  it('mod acikken savasta birimler havalanir ve degismezler korunur', () => {
    let launched = 0;
    for (const id of [3, 17, 42, 77]) {
      const sc = makeScenario(id);
      const b = new Battle(sc.simSeed, { ...sc.config, comedy: true });
      for (let s = 0; s < 30 * 60 && b.winner === -1; s++) {
        b.step(1 / 30);
        for (let i = 0; i < b.units.count; i++) {
          if (b.units.lift[i] > 0) launched++;
          expect(b.units.lift[i]).toBeGreaterThanOrEqual(0);
        }
        if (s % 60 === 0) expect(checkInvariants(b), `senaryo ${id}`).toEqual([]);
      }
    }
    expect(launched).toBeGreaterThan(0);
  }, 120000);
});

// COMEDY_N: komedi fizigi acik rastgele senaryo sayisi (takilma/dongu/degismez taramasi).
const N = Number(process.env.COMEDY_N ?? 60);
describe('komedi fizigi: rastgele senaryolar', () => {
  for (let id = 1; id <= N; id++) {
    it(`senaryo ${id}`, () => {
      const sc = makeScenario(id);
      sc.config = { ...sc.config, comedy: true };
      const r = runScenario(sc);
      expect(r.flags.map((f) => `${f.type} t=${f.t}: ${f.info}`), sc.desc).toEqual([]);
    });
  }
});
