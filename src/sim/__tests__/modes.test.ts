import { describe, expect, it } from 'vitest';
import { Battle, type BattleConfig } from '../battle';
import { teamZones } from '../../net/economy';
import { PRESETS } from '../mapSpec';
import { HILL_TARGET, HILL_TIME_LIMIT, hillControlPoints, hillRadius, modeFor, type ModeHud } from '../modes';
import { packSnapshot, unpackSnapshot } from '../snapshot';
import { makeScenario } from '../testing/scenarios';
import { Terrain } from '../terrain';
import { Kind } from '../units';

const DT = 1 / 30;

type Pt = { x: number; y: number; radius: number; owner: number };

function hill(b: Battle): Extract<ModeHud, { kind: 'hill' }> {
  const h = b.modeHud();
  if (h.kind !== 'hill') throw new Error('not a hill battle');
  return h;
}

/** A custom battle on the default forest map with priests only (they never move and never deal damage). */
function priestBattle(rules: 'classic' | 'hill' | undefined, layout: number[], size = 56): Battle {
  const config: BattleConfig = { mode: 'custom', perTeam: 0, teamCount: 2, mapSize: size, env: true, kite: true, terrainSeed: 3, layout: new Float32Array(layout), rules };
  return new Battle(7, config);
}

/** Control points of an empty-ish hill battle (probe), to know where to place units. */
function probePoints(size = 56): Pt[] {
  return hill(priestBattle('hill', [0, Kind.Priest, 10, 10, 1, Kind.Priest, 40, 40], size)).points;
}

/** The corner farthest from every control point (a safe place for a harmless far-away unit). */
function farCorner(points: Pt[], size: number): { x: number; y: number } {
  const m = 3;
  const corners = [
    { x: m, y: m },
    { x: size - m, y: m },
    { x: m, y: size - m },
    { x: size - m, y: size - m },
  ];
  let best = corners[0];
  let bestD = -1;
  for (const c of corners) {
    const d = Math.min(...points.map((p) => Math.hypot(p.x - c.x, p.y - c.y)));
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function priestsAt(team: number, x: number, y: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(team, Kind.Priest, x + (i % 3) * 0.9 - 0.9, y + Math.floor(i / 3) * 0.9 - 0.5);
  return out;
}

describe('game modes: classic stays exactly as before', () => {
  for (const rules of [undefined, 'classic'] as const) {
    it(`rules=${String(rules)}: same hashes and winner as a battle without the field, no mode state in snapshots`, () => {
      const sc = makeScenario(9);
      const a = new Battle(sc.simSeed, sc.config);
      const b = new Battle(sc.simSeed, { ...sc.config, rules });
      for (let s = 0; s < 500 && a.winner === -1; s++) {
        a.step(DT);
        b.step(DT);
        if (s % 25 === 0) expect(b.hash(), `step ${s}`).toBe(a.hash());
      }
      expect(b.winner).toBe(a.winner);
      expect(b.serialize().extra.mode).toBeUndefined();
      expect(b.modeHud()).toEqual({ kind: 'classic' });
      expect(b.modeScores()).toBeUndefined();
      expect(b.teamHasGoal.every((v) => v === 0)).toBe(true);
    });
  }

  it('the registry knows every id and falls back to classic rules for an unknown id', () => {
    expect(modeFor('hill').id).toBe('hill');
    expect(modeFor('classic').id).toBe('classic');
    expect(modeFor('vip').id).toBe('vip');
    expect(modeFor('ctf').id).toBe('ctf');
    expect(modeFor('nope' as never).id).toBe('classic');
    expect(modeFor(undefined).id).toBe('classic');
  });

  it('the hill rules change the checksum (mode state is part of it)', () => {
    const sc = makeScenario(9);
    const a = new Battle(sc.simSeed, sc.config);
    const b = new Battle(sc.simSeed, { ...sc.config, rules: 'hill' });
    expect(b.hash()).not.toBe(a.hash());
  });
});

describe('king of the hill: determinism', () => {
  const mk = (id: number): Battle => {
    const sc = makeScenario(id);
    return new Battle(sc.simSeed, { ...sc.config, rules: 'hill' });
  };
  for (const id of [3, 17, 42]) {
    it(`scenario ${id}: two runs give the same hash sequence`, () => {
      const a = mk(id);
      const b = mk(id);
      for (let s = 0; s < 700 && a.winner === -1; s++) {
        a.step(DT);
        b.step(DT);
        if (s % 10 === 0) expect(b.hash(), `step ${s}`).toBe(a.hash());
      }
      expect(b.winner).toBe(a.winner);
      expect(b.modeHud()).toEqual(a.modeHud());
    });

    it(`scenario ${id}: snapshot -> restore -> same continuation including mode state`, () => {
      const a = mk(id);
      for (let s = 0; s < 330 && a.winner === -1; s++) a.step(DT);
      const snap = unpackSnapshot(packSnapshot(a.serialize()));
      const b = mk(id);
      b.restore(snap);
      expect(b.hash()).toBe(a.hash());
      expect(b.modeHud()).toEqual(a.modeHud());
      for (let s = 0; s < 400 && a.winner === -1; s++) {
        a.step(DT);
        b.step(DT);
        if (s % 10 === 0) expect(b.hash(), `continued step ${s}`).toBe(a.hash());
      }
      expect(b.winner).toBe(a.winner);
      expect(b.modeScores()).toEqual(a.modeScores());
    });
  }

  it('teams head for a control point they do not own (goal hook)', () => {
    const b = mk(3);
    for (let s = 0; s < 40; s++) b.step(DT);
    const pts = hill(b).points;
    let goals = 0;
    for (let t = 0; t < b.allTeams.length; t++) {
      if (!b.teamHasGoal[t]) continue;
      goals++;
      const hit = pts.findIndex((p) => Math.abs(p.x - b.teamGoalX[t]) < 1e-3 && Math.abs(p.y - b.teamGoalY[t]) < 1e-3);
      expect(hit, `team ${t} goal is a control point`).toBeGreaterThanOrEqual(0);
      expect(pts[hit].owner).not.toBe(t);
    }
    expect(goals).toBeGreaterThan(0);
  });
});

describe('king of the hill: scoring and winning', () => {
  const size = 56;
  const points = probePoints(size);
  const far = farCorner(points, size);
  const centre = points[0];

  it('a team holding a point scores exactly one point per second; contested points score nobody', () => {
    const b = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 5), ...priestsAt(1, far.x, far.y, 1)], size);
    let expected = 0;
    for (let s = 1; s <= 150; s++) {
      b.step(DT);
      if (s % 30 === 0) expected += hill(b).points.filter((p) => p.owner === 0).length;
    }
    const h = hill(b);
    expect(h.points[0].owner).toBe(0);
    expect(h.scores[0]).toBe(expected);
    expect(h.scores[0]).toBe(5); // only the centre, five seconds
    expect(h.scores[1]).toBe(0);
    expect(b.modeScores()).toEqual([5, 0]);
    expect(h.target).toBe(HILL_TARGET);
  });

  it('equal numbers on a point: contested, nobody scores', () => {
    const b = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 4), ...priestsAt(1, centre.x + 0.4, centre.y + 0.4, 4)], size);
    for (let s = 0; s < 130; s++) b.step(DT);
    const h = hill(b);
    expect(h.points[0].owner).toBe(-2);
    expect(h.scores.every((v) => v === 0)).toBe(true);
    expect(b.winner).toBe(-1);
  });

  it('a strict majority takes over the point, and a point nobody stands on stays with its owner', () => {
    const b = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 3), ...priestsAt(1, centre.x + 0.4, centre.y + 0.4, 5)], size);
    for (let s = 0; s < 12; s++) b.step(DT);
    expect(hill(b).points[0].owner).toBe(1);
    // Team 1 walks away: team 0 now has the strict majority.
    const u = b.units;
    const move = (team: number, x: number, y: number): void => {
      for (let i = 0; i < u.count; i++) if (u.team[i] === team) [u.x[i], u.y[i]] = [x, y];
    };
    move(1, far.x, far.y);
    for (let s = 0; s < 12; s++) b.step(DT);
    expect(hill(b).points[0].owner).toBe(0);
    // Everybody leaves the point: it stays with its owner.
    move(0, far.x + 0.5, far.y + 0.5);
    for (let s = 0; s < 22; s++) b.step(DT);
    expect(hill(b).points[0].owner).toBe(0);
  });

  function nearWin(): Battle {
    const a = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 5), ...priestsAt(1, far.x, far.y, 1)], size);
    a.step(DT);
    const snap = a.serialize();
    snap.extra.mode!.state[0] = HILL_TARGET - 2; // team 0 has 98 points
    const b = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 5), ...priestsAt(1, far.x, far.y, 1)], size);
    b.restore(snap);
    return b;
  }

  it('the first team to 100 points wins and the scores are available for the result', () => {
    const b = nearWin();
    for (let s = 0; s < 200 && b.winner === -1; s++) b.step(DT);
    expect(b.winner).toBe(0);
    expect(b.modeScores()).toEqual([HILL_TARGET, 0]);
    expect(b.alivePerTeam[0]).toBeGreaterThan(0);
    expect(b.alivePerTeam[1]).toBeGreaterThan(0);
  });

  it('two teams reaching 100 together: the battle goes on until one is ahead', () => {
    const a = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 5), ...priestsAt(1, far.x, far.y, 1)], size);
    a.step(DT);
    const snap = a.serialize();
    snap.extra.mode!.state[0] = HILL_TARGET;
    snap.extra.mode!.state[1] = HILL_TARGET;
    const b = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 5), ...priestsAt(1, far.x, far.y, 1)], size);
    b.restore(snap);
    for (let s = 0; s < 25; s++) b.step(DT);
    expect(b.winner).toBe(-1); // 100 vs 100: no strict leader yet
    for (let s = 0; s < 40 && b.winner === -1; s++) b.step(DT);
    expect(b.winner).toBe(0);
    expect(b.modeScores()).toEqual([HILL_TARGET + 1, HILL_TARGET]);
  });

  it('time limit: after 10 minutes the team with the most points wins; a tie is a draw', () => {
    expect(HILL_TIME_LIMIT).toBe(600);
    const run = (s0: number, s1: number): Battle => {
      const a = priestBattle('hill', [...priestsAt(0, far.x, far.y, 2), ...priestsAt(1, size - far.x, size - far.y, 2)], size);
      a.step(DT);
      const snap = a.serialize();
      snap.extra.mode!.state[0] = s0;
      snap.extra.mode!.state[1] = s1;
      snap.scalars.stepNo = HILL_TIME_LIMIT * 30 - 20;
      const b = priestBattle('hill', [...priestsAt(0, far.x, far.y, 2), ...priestsAt(1, size - far.x, size - far.y, 2)], size);
      b.restore(snap);
      return b;
    };
    const lead = run(40, 25);
    for (let s = 0; s < 10; s++) lead.step(DT);
    expect(lead.winner).toBe(-1);
    for (let s = 0; s < 30; s++) lead.step(DT);
    expect(lead.winner).toBe(0);
    const behind = run(10, 25);
    for (let s = 0; s < 40; s++) behind.step(DT);
    expect(behind.winner).toBe(1);
    const tie = run(30, 30);
    for (let s = 0; s < 40; s++) tie.step(DT);
    expect(tie.winner).toBe(-2);
  });

  it('the no-damage draw is bypassed in hill mode (and still applies in classic)', () => {
    const layout = [...priestsAt(0, 12, 12, 3), ...priestsAt(1, 44, 44, 3)];
    const classic = priestBattle('classic', layout);
    const hillB = priestBattle('hill', layout);
    for (let s = 0; s < 600; s++) {
      classic.step(DT);
      hillB.step(DT);
    }
    expect(classic.winner).toBe(-2);
    expect(hillB.winner).toBe(-1);
  });

  it('the last team alive still wins a hill battle', () => {
    const b = priestBattle('hill', [...priestsAt(0, centre.x, centre.y, 3), ...priestsAt(1, far.x, far.y, 2)], size);
    b.step(DT);
    const u = b.units;
    for (let i = 0; i < u.count; i++) if (u.team[i] === 1) u.alive[i] = 0;
    b.step(DT);
    expect(b.winner).toBe(0);
  });
});

describe('king of the hill: control points', () => {
  it('lie on walkable, reachable tiles on every map preset, size and team count', () => {
    for (const p of PRESETS) {
      for (const size of [40, 56, 80]) {
        const t = new Terrain(size, { seed: 5, spec: p.spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
        for (let teams = 2; teams <= 6; teams++) {
          const spawns = teamZones(size, teams, t).map((z) => ({ x: z.cx, y: z.cy }));
          const pts = hillControlPoints(t, size, spawns);
          const where = `${p.id} ${size} ${teams} teams`;
          expect(pts.length, where).toBe(3);
          const R = hillRadius(size);
          pts.forEach((q, i) => {
            expect(t.walkable(q.x, q.y), `${where} point ${i} walkable`).toBe(true);
            expect(t.reachable(q.x, q.y), `${where} point ${i} reachable`).toBe(true);
            expect(q.x >= 0 && q.y >= 0 && q.x < size && q.y < size, `${where} inside`).toBe(true);
          });
          for (let i = 0; i < 3; i++) {
            for (let j = i + 1; j < 3; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y), `${where} ${i}-${j} apart`).toBeGreaterThan(R);
          }
          // Deterministic: the same inputs give the same points.
          expect(hillControlPoints(t, size, spawns)).toEqual(pts);
        }
      }
    }
  });

  it('are the map centre plus flanks perpendicular to the spawn axis for two teams', () => {
    const pts = hillControlPoints(null, 60, [{ x: 10, y: 30 }, { x: 50, y: 30 }]);
    expect(pts[0]).toEqual({ x: 30, y: 30 });
    expect(Math.abs(pts[1].x - 30)).toBeLessThan(1e-6);
    expect(Math.abs(pts[2].x - 30)).toBeLessThan(1e-6);
    expect(pts[1].y).toBeCloseTo(30 + 60 * 0.28, 5);
    expect(pts[2].y).toBeCloseTo(30 - 60 * 0.28, 5);
    expect(hillRadius(40)).toBe(3.5);
    expect(hillRadius(80)).toBeCloseTo(4.8, 5);
  });

  it('a real battle on a preset map puts the points on reachable ground', () => {
    for (const p of PRESETS.slice(0, 6)) {
      const sc = makeScenario(5);
      const b = new Battle(sc.simSeed, { ...sc.config, env: true, map: p.spec, rules: 'hill' });
      for (const q of hill(b).points) {
        expect(b.terrain!.walkable(q.x, q.y), p.id).toBe(true);
        expect(b.terrain!.reachable(q.x, q.y), p.id).toBe(true);
      }
    }
  });
});

describe('king of the hill: cost', () => {
  it('the mode step is a negligible part of a step with 3000 units', () => {
    const b = new Battle(1, { mode: 'bench', perTeam: 1500, rules: 'hill' });
    for (let s = 0; s < 5; s++) b.step(DT);
    const t0 = performance.now();
    for (let s = 0; s < 20; s++) b.step(DT);
    const stepMs = (performance.now() - t0) / 20;
    // Worst case: a full evaluation. It runs once per 10 steps.
    const t1 = performance.now();
    const calls = 50;
    for (let k = 0; k < calls; k++) {
      b.stepNo = 1 + 10 * k;
      b.mode.step(b, DT);
    }
    const evalMs = (performance.now() - t1) / calls;
    expect(evalMs / 10).toBeLessThan(stepMs * 0.05);
  });
});
