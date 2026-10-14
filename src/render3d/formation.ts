import { laneOf, placeableKinds } from '../app/armies';
import { PLACE_GAP } from '../net/protocol';
import { placeBlock, type Zone } from '../net/economy';
import type { Terrain } from '../sim/terrain';
import { mulberry32 } from '../sim/random';

export interface PlacedSoldier {
  team: number;
  kind: number;
  x: number;
  y: number;
}

/** Lattice points of a team zone that are valid placements, nearest to the enemy first (the front line). */
export function zoneSpots(t: Terrain, zone: Zone, enemy: { x: number; y: number }, gap = PLACE_GAP + 0.1): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number; d: number }> = [];
  const n = t.size;
  for (let y = gap / 2; y < n; y += gap) {
    for (let x = gap / 2; x < n; x += gap) {
      if (placeBlock(t, zone, x, y) !== null) continue;
      out.push({ x, y, d: Math.hypot(x - enemy.x, y - enemy.y) });
    }
  }
  out.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  return out;
}

/**
 * Armies for all teams: `perTeam` soldiers each (fewer if the zone is too small), melee first (front line, nearest to the
 * enemy), then ranged, then healers/siege at the back; the kinds come from the pools of each lane, seeded.
 */
export function fillFormations(t: Terrain, zones: Zone[], perTeam: number, seed: number, kinds: number[] = placeableKinds()): PlacedSoldier[] {
  const rnd = mulberry32(seed * 7919 + 13);
  const lanes = { front: [] as number[], mid: [] as number[], back: [] as number[] };
  for (const k of kinds) lanes[laneOf(k)].push(k);
  const out: PlacedSoldier[] = [];
  zones.forEach((zone, team) => {
    // Enemy = centroid of all other zones.
    let ex = 0;
    let ey = 0;
    let en = 0;
    zones.forEach((z, i) => {
      if (i === team) return;
      ex += z.cx;
      ey += z.cy;
      en++;
    });
    const enemy = en ? { x: ex / en, y: ey / en } : { x: t.size / 2, y: t.size / 2 };
    const spots = zoneSpots(t, zone, enemy);
    const count = Math.min(perTeam, spots.length);
    // Few kinds per lane per team (a coherent army), proportions 50 % / 32 % / 18 %.
    const pick = (pool: number[], n: number): number[] => (pool.length ? Array.from({ length: Math.min(n, pool.length) }, () => pool[Math.floor(rnd() * pool.length)]) : []);
    const pools = { front: pick(lanes.front, 2), mid: pick(lanes.mid, 2), back: pick(lanes.back, 2) };
    const nFront = Math.round(count * 0.5);
    const nMid = Math.round(count * 0.32);
    for (let i = 0; i < count; i++) {
      const lane = i < nFront ? 'front' : i < nFront + nMid ? 'mid' : 'back';
      const pool = pools[lane].length ? pools[lane] : pools.front.length ? pools.front : kinds;
      out.push({ team, kind: pool[Math.floor(rnd() * pool.length)], x: spots[i].x, y: spots[i].y });
    }
  });
  return out;
}
