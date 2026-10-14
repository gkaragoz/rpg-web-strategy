import { describe, expect, it } from 'vitest';
import { newFrameTable, unitFrame, UnitInstances, type UnitsLike, DEATH_FADE } from '../../render3d/billboards';
import { billboardLean, footprintOf, leanUpVector, MAX_LEAN, MAX_LEAN_SCALE } from '../../render3d/depth';
import { clampRig, eyeOf, panAxes, TILT_MAX, TILT_MIN } from '../../render3d/cameraRig';
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
    expect(w.bar[1]).toBeCloseTo(2, 5); // feet; the shader adds the head height
    expect(w.barB[1]).toBeCloseTo(1.5 * 0.95 + 0.12, 5); // frame top above the anchor + gap
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

describe('3D effects pool', () => {
  const flat = (): number => 0;
  const rnd = (() => {
    let s = 1;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })();

  it('spawns a damage number as one glyph per digit and fades it out', async () => {
    const { Fx3D, GLYPH_CELLS } = await import('../../render3d/fx3d');
    const fx = new Fx3D(256);
    fx.spawn([{ type: 'hit', x: 5, y: 6, unit: 1, value: 123 }], flat, { numbers: true, particles: false }, rnd);
    expect(fx.count).toBe(3);
    expect([...fx.glyph.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect(fx.offX[0]).toBeLessThan(fx.offX[2]);
    const a = new Float32Array(4 * 256);
    const b = new Float32Array(4 * 256);
    const c = new Float32Array(4 * 256);
    const o = new Float32Array(3 * 256);
    expect(fx.write(a, b, c, o)).toBe(3);
    expect(b[2]).toBeCloseTo(1 / GLYPH_CELLS);
    expect(o[2]).toBe(1);
    fx.update(0.5);
    expect(fx.py[0]).toBeGreaterThan(0.75 + 0.9);
    fx.update(1);
    expect(fx.count).toBe(0);
  });

  it('respects the per-call caps, the visibility test and the toggles', async () => {
    const { Fx3D } = await import('../../render3d/fx3d');
    const fx = new Fx3D(4096);
    const many = Array.from({ length: 500 }, (_, i) => ({ type: 'hit' as const, x: i, y: 0, unit: i, value: 9 }));
    fx.spawn(many, flat, { numbers: true, particles: true, maxNumbers: 10, maxParticles: 20 }, rnd);
    expect(fx.count).toBeLessThan(10 + 20 + 40);
    const none = new Fx3D(64);
    none.spawn(many, flat, { numbers: false, particles: false }, rnd);
    expect(none.count).toBe(0);
    const far = new Fx3D(64);
    far.spawn(many, flat, { numbers: true, particles: true, visible: () => false }, rnd);
    expect(far.count).toBe(0);
  });

  it('never overflows the pool and keeps survivors intact when others expire', async () => {
    const { Fx3D } = await import('../../render3d/fx3d');
    const fx = new Fx3D(8);
    fx.spawn(Array.from({ length: 50 }, () => ({ type: 'death' as const, x: 1, y: 1, unit: 0 })), flat, { numbers: false, particles: true, maxParticles: 1000 }, rnd);
    expect(fx.count).toBe(8);
    fx.life[0] = 0.01;
    const keepX = fx.px[7];
    fx.update(0.02);
    expect(fx.count).toBe(7);
    expect(Number.isFinite(fx.px[0])).toBe(true);
    expect(keepX).toBeDefined();
  });
});

describe('3D camera input helpers', () => {
  const rig = { fx: 10, fz: 10, yaw: 1, tilt: 0.8, dist: 40 };

  it('orbits: drag turns the yaw and tilts within the limits', async () => {
    const { orbitRig, TILT_MAX, TILT_MIN } = await import('../../render3d/cameraRig');
    const a = orbitRig(rig, 0.5, 0.1);
    expect(a.yaw).toBeCloseTo(1.5);
    expect(a.tilt).toBeCloseTo(0.9);
    expect(orbitRig(rig, 0, 9).tilt).toBe(TILT_MAX);
    expect(orbitRig(rig, 0, -9).tilt).toBe(TILT_MIN);
    expect(rig.yaw).toBe(1); // pure: the input rig is untouched
  });

  it('pinches: spreading the fingers zooms in, twisting rotates the shortest way', async () => {
    const { pinchRig } = await import('../../render3d/cameraRig');
    const closer = pinchRig(rig, { dist: 100, angle: 0 }, { dist: 200, angle: 0 });
    expect(closer.dist).toBeCloseTo(20);
    const wrap = pinchRig(rig, { dist: 100, angle: Math.PI - 0.1 }, { dist: 100, angle: -Math.PI + 0.1 });
    expect(wrap.yaw).toBeCloseTo(1 - 0.2);
    // Fingers that start together do not zoom by a huge factor.
    expect(pinchRig(rig, { dist: 2, angle: 0 }, { dist: 300, angle: 0 }).dist).toBe(40);
  });
});

describe('3D world helpers', () => {
  it('shows placed soldiers facing the map center like the 2D editor', async () => {
    const { EditUnits } = await import('../../render3d/world3d');
    const u = new EditUnits();
    const list = [
      { team: 0, kind: 3, x: 5, y: 20 },
      { team: 1, kind: 4, x: 30, y: 6 },
    ];
    u.set(list, list.length);
    expect(u.count).toBe(2);
    expect([u.facing[0], u.facing[1]]).toEqual([1, -1]);
    expect([u.team[1], u.kind[1]]).toEqual([1, 4]);
    expect(u.alive[0]).toBe(1);
  });

  it('keeps the 2D view as the default option', async () => {
    const { defaultOptions } = await import('../../app/state');
    expect(defaultOptions().view).toBe('2d');
  });
});

describe('view switch persistence', () => {
  it('saveStateNow writes immediately (the debounced save is lost by the reload that switches the view)', async () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    const prev = { window: g.window, localStorage: g.localStorage };
    g.window = { clearTimeout, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms) };
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    try {
      const { defaultState, saveState, saveStateNow } = await import('../../app/state');
      const s = defaultState();
      s.options.view = '3d';
      saveState(s);
      expect(store.size).toBe(0); // debounced: nothing yet
      saveStateNow(s);
      expect(JSON.parse([...store.values()][0]).options.view).toBe('3d');
    } finally {
      g.window = prev.window;
      g.localStorage = prev.localStorage;
    }
  });
});

describe('sprite lean and footprints', () => {
  it('leans like the camera up to the cap, then stays and compensates the height', () => {
    const low = billboardLean((30 * Math.PI) / 180);
    expect(low.lean).toBeCloseTo((30 * Math.PI) / 180, 6);
    expect(low.scale).toBeCloseTo(1, 6);
    const high = billboardLean((86 * Math.PI) / 180);
    expect(high.lean).toBe(MAX_LEAN);
    expect(high.scale).toBeGreaterThan(1);
    expect(high.scale).toBeLessThanOrEqual(MAX_LEAN_SCALE);
    expect(billboardLean(0).lean).toBe(0);
  });

  it('builds the up axis away from the camera and keeps the screen height', () => {
    const tilt = (70 * Math.PI) / 180;
    const up = leanUpVector(tilt, 0, 2, { x: 0, y: 0, z: 0 });
    expect(up.x).toBeCloseTo(0, 9);
    expect(up.z).toBeGreaterThan(0); // leans along the view direction
    expect(up.y).toBeGreaterThan(0);
    // The camera's up axis is (0, cos t, sin t) for a camera looking toward +z: the lean projects to ~1 on it.
    const onCam = up.y * Math.cos(tilt) + up.z * Math.sin(tilt);
    expect(onCam).toBeCloseTo(1, 5);
    const flat = leanUpVector(0.2, 3, 0, { x: 0, y: 0, z: 0 });
    expect(flat.x).toBeGreaterThan(0);
    expect(flat.z).toBeCloseTo(0, 9);
  });

  it('moves structures from the iso front corner to the footprint centre', () => {
    expect(footprintOf('house', 0, 10, 10)).toEqual({ x: 9, z: 9, rise: 32 });
    expect(footprintOf('house', 2, 10, 10)).toEqual({ x: 8.5, z: 9, rise: 40 }); // 3 x 2
    expect(footprintOf('house', 4, 10, 10)).toEqual({ x: 9, z: 8.5, rise: 40 }); // 2 x 3
    expect(footprintOf('keep', 0, 30, 30)).toEqual({ x: 28, z: 28, rise: 64 });
    expect(footprintOf('tower', 0, 5, 7)).toEqual({ x: 4.5, z: 6.5, rise: 16 });
    expect(footprintOf('wall', 0, 5.5, 7.5)).toEqual({ x: 5.5, z: 7.5, rise: 16 });
    expect(footprintOf('tree', 1, 3, 4)).toEqual({ x: 3, z: 4, rise: 0 });
  });
});
