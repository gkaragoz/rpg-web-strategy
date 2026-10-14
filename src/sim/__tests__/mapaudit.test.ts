import { describe, expect, it } from 'vitest';
import { placeBlock, teamZones } from '../../net/economy';
import { PRESETS } from '../mapSpec';
import { Terrain } from '../terrain';

/** Walking route between two points: length, and the share of its waypoints that hug the map border. */
function route(t: Terrain, size: number, a: { x: number; y: number }, b: { x: number; y: number }): { detour: number; edge: number } | null {
  const path = t.findPath(a.x, a.y, b.x, b.y);
  if (!path) return null;
  let len = 0;
  let px = a.x;
  let py = a.y;
  let edge = 0;
  let count = 1;
  for (let i = 0; i + 1 < path.length; i += 2) {
    len += Math.hypot(path[i] - px, path[i + 1] - py);
    px = path[i];
    py = path[i + 1];
    if (Math.min(px, py, size - px, size - py) < 3.5) edge++;
    count++;
  }
  return { detour: len / Math.hypot(a.x - b.x, a.y - b.y), edge: edge / count };
}

function build(id: string, size: number, seed: number): Terrain {
  const spec = PRESETS.find((p) => p.id === id)!.spec;
  return new Terrain(size, { seed, spec, spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 });
}

describe('map audit', () => {
  it('the gate of every valley map is open on every map size (armies do not walk around the map edge)', () => {
    const valleys = PRESETS.filter((p) => p.spec.layout === 'valley');
    expect(valleys.length).toBeGreaterThanOrEqual(3); // Mountain Pass, Frozen Gorge, Canyon Gate
    for (const p of valleys) {
      for (const size of [40, 56, 80, 100, 120, 160, 200, 256]) {
        for (const seed of [1, 2, 3, 7]) {
          const t = build(p.id, size, seed);
          const z = teamZones(size, 2, t);
          const a = t.nearestWalkable(z[0].cx, z[0].cy, 10, true)!;
          const b = t.nearestWalkable(z[1].cx, z[1].cy, 10, true)!;
          const r = route(t, size, a, b);
          const where = `${p.id} ${size} seed ${seed}`;
          expect(r, where).not.toBeNull();
          expect(r!.detour, `${where} detour`).toBeLessThan(1.35);
          expect(r!.edge, `${where} border hugging`).toBeLessThan(0.05);
        }
      }
    }
  });

  it('every preset connects all team zones with a sane route and has room to place armies', () => {
    for (const p of PRESETS) {
      for (const size of [56, 80]) {
        for (const seed of [1, 2]) {
          const t = build(p.id, size, seed);
          for (const teams of [2, 3, 4]) {
            const zones = teamZones(size, teams, t);
            const anchors = zones.map((z) => t.nearestWalkable(z.cx, z.cy, 10, true));
            const where = `${p.id} ${size} seed ${seed} ${teams} teams`;
            zones.forEach((z, i) => {
              expect(anchors[i], `${where} anchor ${i}`).not.toBeNull();
              let cap = 0;
              for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (placeBlock(t, z, x + 0.5, y + 0.5) === null) cap++;
              expect(cap, `${where} zone ${i} capacity`).toBeGreaterThanOrEqual(60);
            });
            for (let a = 0; a < teams; a++) {
              for (let b = a + 1; b < teams; b++) {
                const r = route(t, size, anchors[a]!, anchors[b]!);
                expect(r, `${where} route ${a}-${b}`).not.toBeNull();
                expect(r!.edge, `${where} route ${a}-${b} border hugging`).toBeLessThan(0.15);
                expect(r!.detour, `${where} route ${a}-${b} detour`).toBeLessThan(3.2);
              }
            }
          }
        }
      }
    }
  });
});
