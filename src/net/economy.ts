import type { Terrain } from '../sim/terrain';
import { T_GRASS, T_PATH } from '../sim/terrain';
import { KIND_COUNT, STATS, setUnitLevel } from '../sim/units';
import { TROOP_BY_ID } from '../sim/data/troops';

/** Warrior (classic) = 10 gold; the others scale with power: proportional to sqrt(effective HP x damage per second). */
const WARRIOR = Math.sqrt((160 / 1) * (16 / 0.9));
export const MIN_COST = 5;
export const MAX_COST = 600;

/** Kinds that are not in the placement list (summoned skeletons, etc.). */
export function buyable(kind: number): boolean {
  const t = STATS[kind].troop ? TROOP_BY_ID[STATS[kind].troop!] : undefined;
  return !t?.summoned;
}

/**
 * Gold cost of a unit (based on the current STATS level; setUnitLevel must be called first).
 * Effective HP (including armor) x power per second, with range/area/skill multipliers; rounded to the nearest 5.
 */
export function unitGold(kind: number): number {
  const s = STATS[kind];
  const ehp = s.hp / Math.max(0.15, 1 - s.armor);
  const dps = s.power / Math.max(0.3, s.cooldown);
  let mult = 1;
  if (s.role === 1) mult *= 1.12; // ranged: kiting advantage
  if (s.role === 2) mult *= 0.9; // healer: deals no direct damage
  if (s.splash > 0) mult *= 1 + Math.min(0.5, s.splash * 0.1);
  if (s.knockback > 0) mult *= 1.15;
  if (s.aoe > 0) mult *= 1 + Math.min(0.9, s.aoe * 0.3); // tank area strike (classic tanks)
  if (s.scale > 1.5) mult *= 1.25; // giant body: holds the front line
  if (s.skill) mult *= 1.12;
  const strength = Math.sqrt(ehp * dps) * mult;
  const raw = (10 * strength) / WARRIOR;
  return Math.min(MAX_COST, Math.max(MIN_COST, Math.round(raw / 5) * 5));
}

/** Cost table of all kinds at the given level (sets the STATS level). */
export function costTable(level: number): number[] {
  setUnitLevel(level);
  return Array.from({ length: KIND_COUNT }, (_, k) => unitGold(k));
}

export interface Placed {
  kind: number;
}

/** Total gold spent (table costs[kind]). */
export function spent(units: Placed[], costs: number[]): number {
  let t = 0;
  for (const u of units) t += costs[u.kind] ?? 0;
  return t;
}

/** Recommended map size for the number of players. */
export function mapSizeForPlayers(players: number): number {
  return players <= 2 ? 56 : players <= 4 ? 80 : 100;
}

export interface Zone {
  team: number;
  /** Whether (x,y) is in this team's placement zone (walkability is checked separately). */
  contains(x: number, y: number): boolean;
  /** Number of walkable tiles in the zone that are reachable from the main area. */
  area: number;
  /** Center of the zone (for the camera/label). */
  cx: number;
  cy: number;
}

/**
 * Team zones: angular slices from the map center (team t's axis matches its formation direction),
 * with a neutral band left between neighboring slices and in the center. With 2 teams, the two sides (bounded by the river axis).
 */
export function teamZones(size: number, teams: number, terrain: Terrain | null, gap = 3): Zone[] {
  const c = size / 2;
  const sector = (Math.PI * 2) / teams;
  const rMin = Math.max(3, size * 0.08);
  const rMax = size / 2 - 2.5;
  const zones: Zone[] = [];
  for (let t = 0; t < teams; t++) {
    const axis = (3 * Math.PI) / 4 + t * sector;
    const contains = (x: number, y: number): boolean => {
      const dx = x - c;
      const dy = y - c;
      const r = Math.hypot(dx, dy);
      if (r < rMin || r > rMax) return false;
      // Angle difference relative to the axis (-PI..PI).
      let d = Math.atan2(dy, dx) - axis;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const half = sector / 2;
      if (Math.abs(d) >= half) return false;
      // Perpendicular distance to the boundary line >= gap.
      return r * Math.sin(half - Math.abs(d)) >= gap || half - Math.abs(d) >= Math.PI / 2;
    };
    let area = 0;
    let sx = 0;
    let sy = 0;
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        if (!contains(x, y)) continue;
        if (terrain) {
          const f = terrain.flags[ty * size + tx];
          if ((f !== T_GRASS && f !== T_PATH) || !terrain.reachable(x, y)) continue;
        }
        area++;
        sx += x;
        sy += y;
      }
    }
    zones.push({ team: t, contains, area, cx: area ? sx / area : c + Math.cos(axis) * size * 0.3, cy: area ? sy / area : c + Math.sin(axis) * size * 0.3 });
  }
  return zones;
}
