import { Battle, type BattleConfig } from '../battle';
import { teamZones } from '../../net/economy';
import { mapsFor, compatibleLayouts } from '../mapModes';
import { DEFAULT_MAP, PRESETS, type LayoutType, type MapPreset, type MapSpec } from '../mapSpec';
import type { GameModeId } from '../modes';
import { Terrain } from '../terrain';
import { Kind } from '../units';

// Shared helpers of the map/mode audits (mapmodes.test.ts, mapmodesaudit.test.ts).

export const opts = { spawnD0: 1e9, spawnD1: -1e9, spawnHalfS: 0 };
export const NEW_LAYOUTS: LayoutType[] = ['arena', 'forts', 'plateau'];
export const newPresets = (): MapPreset[] => PRESETS.filter((p) => NEW_LAYOUTS.includes(p.spec.layout));

export type Row = [number, number, number, number];

/** Route between two points: path length / straight distance, or null when there is none. */
export function detour(t: Terrain, a: { x: number; y: number }, b: { x: number; y: number }): number | null {
  const path = t.findPath(a.x, a.y, b.x, b.y);
  if (!path) return null;
  let len = 0;
  let px = a.x;
  let py = a.y;
  for (let i = 0; i + 1 < path.length; i += 2) {
    len += Math.hypot(path[i] - px, path[i + 1] - py);
    px = path[i];
    py = path[i + 1];
  }
  return len / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
}

/** Three warriors at the centre of every team zone (like a player placing a small army). */
export function zoneRows(t: Terrain, size: number, teams: number): { rows: Row[]; anchors: Array<{ x: number; y: number }> } {
  const rows: Row[] = [];
  const anchors: Array<{ x: number; y: number }> = [];
  for (const z of teamZones(size, teams, t)) {
    const c = t.nearestWalkable(z.cx, z.cy, 12, true) ?? { x: z.cx, y: z.cy };
    anchors.push(c);
    for (let k = 0; k < 3; k++) {
      const q = t.nearestWalkable(c.x + k * 1.5, c.y + (k % 2) * 1.5, 6, true) ?? c;
      rows.push([z.team, Kind.Warrior, q.x, q.y]);
    }
  }
  return { rows, anchors };
}

export function battleOn(spec: MapSpec, rules: GameModeId, size: number, teams: number, seed: number, extra: Partial<BattleConfig> = {}): { b: Battle; t: Terrain; anchors: Array<{ x: number; y: number }> } {
  const t = new Terrain(size, { seed, spec, ...opts });
  const { rows, anchors } = zoneRows(t, size, teams);
  const b = new Battle(5, { mode: 'custom', perTeam: 0, teamCount: teams, mapSize: size, env: true, kite: true, terrainSeed: seed, map: spec, layout: new Float32Array(rows.flat()), rules, ...extra });
  return { b, t: b.terrain!, anchors };
}

/** What the mode audit looks at: every spec the table lists (the presets of the layout, plus the default recipe on that layout). */
export function listedSpecs(mode: GameModeId): Array<[string, MapSpec]> {
  const out: Array<[string, MapSpec]> = mapsFor(mode).map((p) => [p.id, p.spec] as [string, MapSpec]);
  for (const l of compatibleLayouts(mode)) if (l !== 'lanes') out.push([`default:${l}`, { ...DEFAULT_MAP, layout: l }]);
  return out;
}
