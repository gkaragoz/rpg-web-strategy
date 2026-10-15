import type { Terrain } from '../sim/terrain';
import { T_GRASS, T_PATH } from '../sim/terrain';
import { KIND_COUNT, STATS } from '../sim/units';
import { TROOP_BY_ID } from '../sim/data/troops';
import { COST_ADJ } from '../sim/data/costs';

/** Key of a kind in the cost calibration table: roster id, or the lower-case classic name. */
export function costKey(kind: number): string {
  return STATS[kind].troop ?? STATS[kind].name.toLowerCase().replace(/ /g, '-');
}

/** Warrior (classic) = 10 gold; the others scale with power (proportional to sqrt(effective HP x damage per second)) times a simulation-calibrated factor (data/costs.ts). */
const WARRIOR = Math.sqrt((160 / 1) * (16 / 0.9));
export const MIN_COST = 5;
export const MAX_COST = 600;

/** Kinds that are not in the placement list (summoned skeletons, etc.). */
export function buyable(kind: number): boolean {
  const t = STATS[kind].troop ? TROOP_BY_ID[STATS[kind].troop!] : undefined;
  return !t?.summoned;
}

/**
 * Gold cost of a unit (based on the current STATS).
 * Effective HP (including armor) x power per second, with range/area/skill multipliers; rounded to the nearest 5.
 */
/** Cost before rounding and clamping. */
export function rawCost(kind: number): number {
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
  return ((10 * strength) / WARRIOR) * (COST_ADJ[costKey(kind)] ?? 1);
}

export function unitGold(kind: number): number {
  return Math.min(MAX_COST, Math.max(MIN_COST, Math.round(rawCost(kind))));
}

/** Cost table of all kinds. */
export function costTable(): number[] {
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

/** Hard ceiling of placed units in a whole online room (keeps messages and the simulation bounded; gold normally limits first). */
export const MAX_ROOM_UNITS = 30000;

/** Gold range the host accepts for the lobby setting. */
export const MAX_GOLD = 10_000_000;

/** Map sizes the host accepts (0 = automatic by player count). */
export const ONLINE_MAP_SIZES: readonly number[] = [0, 40, 56, 80, 100, 120, 160, 200, 256];

/**
 * Why a unit cannot be placed at (x, y): outside the team zone or not walkable ('zone'), or walkable but cut off from the
 * main area, e.g. an isolated plateau ('unreachable'). null: allowed. Host and client use this same check.
 */
export function placeBlock(terrain: Terrain, zone: Zone, x: number, y: number): 'zone' | 'unreachable' | null {
  if (!zone.contains(x, y) || !terrain.walkable(x, y)) return 'zone';
  return terrain.reachable(x, y) ? null : 'unreachable';
}

/** Edge margin (tiles) of the Lane Conquest zones: units are not placed right at the map border. */
const LANE_ZONE_EDGE = 2;

/**
 * Lane Conquest zones: each team gets its own half of the map along the lanes (team 0 the left half with its castle plaza, team 1 the
 * right), with a neutral band of `gap` tiles on each side of the middle line.
 */
export function laneZones(size: number, terrain: Terrain, gap = 3): Zone[] {
  const mid = size / 2;
  const zones: Zone[] = [];
  for (let t = 0; t < 2; t++) {
    const contains = (x: number, y: number): boolean => y >= LANE_ZONE_EDGE && y <= size - LANE_ZONE_EDGE && (t === 0 ? x >= LANE_ZONE_EDGE && x <= mid - gap : x >= mid + gap && x <= size - LANE_ZONE_EDGE);
    let area = 0;
    let sx = 0;
    let sy = 0;
    for (let ty = 0; ty < size; ty++) {
      for (let tx = 0; tx < size; tx++) {
        const x = tx + 0.5;
        const y = ty + 0.5;
        if (!contains(x, y)) continue;
        const f = terrain.flags[ty * size + tx];
        if ((f !== T_GRASS && f !== T_PATH) || !terrain.reachable(x, y)) continue;
        area++;
        sx += x;
        sy += y;
      }
    }
    zones.push({ team: t, contains, area, cx: area ? sx / area : size * (t === 0 ? 0.25 : 0.75), cy: area ? sy / area : mid });
  }
  return zones;
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
  if (terrain?.layout === 'lanes' && teams === 2) return laneZones(size, terrain, gap);
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
