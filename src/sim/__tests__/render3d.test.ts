import { describe, expect, it } from 'vitest';
import { teamZones } from '../../net/economy';
import { PLACE_GAP } from '../../net/protocol';
import { newFrameTable, unitFrame, UnitInstances, type UnitsLike, DEATH_FADE } from '../../render3d/billboards';
import { clampRig, eyeOf, panAxes, TILT_MAX, TILT_MIN } from '../../render3d/cameraRig';
import { fillFormations } from '../../render3d/formation';
import { pickGround } from '../../render3d/pick';
import { groundHeight, HEIGHT_PER_STEP, terrainGeometry, WATER_DEPTH } from '../../render3d/terrainMesh';
import { DEFAULT_MAP } from '../mapSpec';
import { Terrain, T_WATER } from '../terrain';

const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };

describe('3D terrain mesh', () => {
  it('has one quad per tile plus shore walls, upward-facing tops and corner heights from the height field', () => {
    const t = new Terrain(56, { seed: 3, spec: { ...DEFAULT_MAP, relief: 'hills' }, ...opts });
    const g = terrainGeometry(t);
    const n = t.size;
    expect(g.positions.length / 12).toBeGreaterThanOrEqual(n * n);
    expect(g.indices.length / 6).toBe(g.positions.length / 12);
    // The first n*n quads are the tile tops: normals point up, land corners sit on vh, water tiles sink.
    for (let ty = 0; ty < n; ty += 5) {
      for (let tx = 0; tx < n; tx += 5) {
        const q = ty * n + tx;
        expect(g.normals[q * 12 + 1], `tile ${tx},${ty} normal`).toBeGreaterThan(0);
        const y0 = g.positions[q * 12 + 1];
        if (t.flags[ty * n + tx] === T_WATER) expect(y0).toBeCloseTo(-WATER_DEPTH, 5);
        else if (t.flags[ty * n + tx] !== 2) expect(y0).toBeCloseTo(t.vh[ty * (n + 1) + tx] * HEIGHT_PER_STEP, 4);
      }
    }
  });

  it('is flat on a map without relief', () => {
    const t = new Terrain(40, { seed: 1, spec: { ...DEFAULT_MAP, relief: 'flat' }, ...opts });
    expect(t.hasRelief).toBe(false);
    expect(groundHeight(t, 10.3, 20.7)).toBe(0);
  });
});

describe('ground picking', () => {
  it('hits a flat plane where the ray crosses it and misses when looking up or outside the map', () => {
    const flat = (): number => 0;
    const hit = pickGround(10, 10, 10, 1, -1, 1, flat, 56)!;
    expect(hit.y).toBeCloseTo(0, 3);
    expect(hit.x).toBeCloseTo(20, 2);
    expect(hit.z).toBeCloseTo(20, 2);
    expect(pickGround(10, 10, 10, 0, 1, 0, flat, 56)).toBeNull();
    expect(pickGround(50, 10, 50, 1, -0.3, 1, flat, 56)).toBeNull();
  });

  it('hits the top of a hill before the plane behind it', () => {
    const hill = (x: number): number => (x > 20 && x < 30 ? 4 : 0);
    const hit = pickGround(0, 8, 28, 1, -0.2, 0, hill, 56)!;
    expect(hit.y).toBe(4);
    expect(hit.x).toBeGreaterThan(20);
    expect(hit.x).toBeLessThan(30);
  });
});

describe('camera rig', () => {
  it('clamps tilt, distance and focus, and keeps eye above the focus on the viewing side', () => {
    const r = clampRig({ fx: -5, fz: 99, yaw: -1, tilt: 3, dist: 0.1 }, 56);
    expect(r.fx).toBe(0);
    expect(r.fz).toBe(56);
    expect(r.tilt).toBe(TILT_MAX);
    expect(r.dist).toBeGreaterThan(0);
    expect(r.yaw).toBeGreaterThanOrEqual(0);
    expect(clampRig({ fx: 1, fz: 1, yaw: 0, tilt: -1, dist: 10 }, 56).tilt).toBe(TILT_MIN);
    const e = eyeOf({ fx: 10, fz: 10, yaw: 0, tilt: Math.PI / 4, dist: 10 }, 0);
    expect(e.y).toBeGreaterThan(0);
    expect(e.z).toBeLessThan(10); // yaw 0 looks toward +z, so the eye is on the -z side
    const a = panAxes(0.7);
    expect(Math.hypot(a.rx, a.rz)).toBeCloseTo(1, 6);
    expect(a.rx * a.ux + a.rz * a.uz).toBeCloseTo(0, 6);
  });
});

function fakeUnits(n: number): UnitsLike & { alive: Uint8Array; deathT: Float32Array } {
  const mk = (len: number): Float32Array => new Float32Array(len);
  return {
    count: n,
    kind: new Uint8Array(n),
    team: Uint8Array.from({ length: n }, (_, i) => i % 2),
    x: Float32Array.from({ length: n }, (_, i) => 5 + i),
    y: Float32Array.from({ length: n }, () => 7),
    px: Float32Array.from({ length: n }, (_, i) => 4 + i),
    py: Float32Array.from({ length: n }, () => 7),
    hp: Float32Array.from({ length: n }, (_, i) => (i === 1 ? 50 : 100)),
    maxHp: Float32Array.from({ length: n }, () => 100),
    alive: new Uint8Array(n).fill(1),
    facing: Int8Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 1)),
    moving: new Uint8Array(n),
    swing: mk(n),
    flash: mk(n),
    deathT: mk(n),
    status: new Uint8Array(n),
  };
}

describe('billboard instance writer', () => {
  const frames = newFrameTable(5 * 6 * 5);
  for (const team of [0, 1]) {
    for (let pose = 0; pose < 5; pose++) {
      const f = unitFrame(0, team, pose);
      frames.has[f] = 1;
      frames.size[f * 2] = 1;
      frames.size[f * 2 + 1] = 1.5;
      frames.anchor[f * 2] = 0.5;
      frames.anchor[f * 2 + 1] = 0.95;
      frames.uv.set([0.1, 0.2, 0.3, 0.4], f * 4);
    }
  }
  const run = (u: UnitsLike, focus = -1, bars = true): UnitInstances => {
    const w = new UnitInstances(16);
    w.write(u, 0.5, 0.016, frames, () => 2, { focusTeam: focus, swingTime: () => 0.4, showBars: bars });
    return w;
  };

  it('interpolates positions, sets height/facing/uv, outline for the focus team and a bar for the damaged one', () => {
    const w = run(fakeUnits(3), 1);
    expect(w.count).toBe(3);
    expect(w.iA[0]).toBeCloseTo(4.5, 5); // between previous (4) and current (5)
    expect(w.iA[1]).toBeCloseTo(2, 5); // ground height from the callback
    expect(w.iA[3]).toBe(1);
    expect(w.iA[7]).toBe(-1); // unit 1 faces left
    expect(w.iUV[0]).toBeCloseTo(0.1, 5);
    expect(w.iC[1]).toBe(0);
    expect(w.iC[5]).toBe(1); // team 1 is highlighted
    expect(w.barCount).toBe(1);
    expect(w.bar[3]).toBeCloseTo(0.5, 5);
    expect(run(fakeUnits(3), -1, false).barCount).toBe(0);
  });

  it('sinks and fades a dead unit and drops it after the fade', () => {
    const u = fakeUnits(2);
    u.alive[0] = 0;
    u.deathT[0] = DEATH_FADE / 2;
    let w = run(u);
    expect(w.count).toBe(2);
    expect(w.iB[1]).toBeLessThan(1.5);
    expect(w.iC[3]).toBeLessThan(1);
    u.deathT[0] = DEATH_FADE + 0.1;
    w = run(u);
    expect(w.count).toBe(1);
  });
});

describe('formation fill', () => {
  it('puts every soldier on a valid spot of its own zone with the placement gap, up to the requested count', () => {
    const t = new Terrain(56, { seed: 2, spec: DEFAULT_MAP, ...opts });
    const zones = teamZones(56, 3, t);
    const list = fillFormations(t, zones, 300, 5);
    expect(list.length).toBeGreaterThan(300);
    for (const team of [0, 1, 2]) {
      const mine = list.filter((s) => s.team === team);
      expect(mine.length).toBeLessThanOrEqual(300);
      expect(mine.length).toBeGreaterThan(100);
      for (const s of mine) expect(zones[team].contains(s.x, s.y) && t.walkable(s.x, s.y) && t.reachable(s.x, s.y)).toBe(true);
      for (let i = 0; i < mine.length; i += 17) for (let j = i + 1; j < Math.min(mine.length, i + 40); j++) expect(Math.hypot(mine[i].x - mine[j].x, mine[i].y - mine[j].y)).toBeGreaterThanOrEqual(PLACE_GAP);
    }
    // Deterministic for a seed.
    expect(fillFormations(t, zones, 300, 5)).toEqual(list);
  });
});

describe('3D watch helpers', () => {
  it('colors teams by team index from the lobby players', async () => {
    const { teamColorsOf, paletteColor } = await import('../../render3d/watch');
    const init = { teamPlayers: ['a', 'b'], teams: 2 } as never;
    const st = {
      players: [
        { id: 'x', role: 'spectator', team: -1, color: 5 },
        { id: 'b2', role: 'player', team: 1, color: 2 },
        { id: 'a2', role: 'player', team: 0, color: 4 },
      ],
    } as never;
    const cols = teamColorsOf(init, st);
    expect(cols.map((c) => c.main)).toEqual([paletteColor(4), paletteColor(2)]);
    expect(paletteColor(-1)).toBe(paletteColor(5));
  });
});
