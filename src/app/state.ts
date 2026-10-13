import { t } from '../i18n';
import { DEFAULT_LEVEL, KIND_COUNT, MAX_LEVEL, MAX_TEAMS, TUNABLE, type StatOverrides } from '../sim/units';
import type { TeamColors } from '../render/unitView';
import { DEFAULT_MAP, PRESETS, sanitizeSpec, type MapSpec } from '../sim/mapSpec';

export interface PaletteSet {
  id: string;
  name: string;
  colors: number[];
}

/** Preset color themes: colors are assigned to teams in order. */
export const PALETTES: PaletteSet[] = [
  { id: 'classic', name: t('studio.pal.classic'), colors: [0x4a8fe8, 0xe85a4f, 0x4cc35b, 0xe6b73a, 0xa76ad8, 0xee8a3c] },
  { id: 'desert', name: t('studio.pal.desert'), colors: [0x2e86c1, 0xc0392b, 0xd4ac0d, 0x17a589, 0x6c3483, 0x7d6608] },
  { id: 'night', name: t('studio.pal.night'), colors: [0x4dd0e1, 0xff5d73, 0xb388ff, 0xffd54f, 0x69f0ae, 0xff8a65] },
  { id: 'pastel', name: t('studio.pal.pastel'), colors: [0x9cc5f0, 0xf4a6a0, 0xa8dba8, 0xf7dc8a, 0xcdb4e6, 0xf6c28f] },
];

export const MAP_SIZES = [
  { id: 40, name: t('studio.size.small') },
  { id: 56, name: t('studio.size.medium') },
  { id: 80, name: t('studio.size.large') },
] as const;

/** Maximum units that can be placed in the editor (the benchmark is separate). */
export const MAX_PLACED = 3000;

export const BRUSHES = [
  { id: 0, name: t('studio.brush.single'), radius: 0.6, count: 1 },
  { id: 1, name: t('studio.brush.small'), radius: 2.2, count: 5 },
  { id: 2, name: t('studio.brush.large'), radius: 4.5, count: 15 },
] as const;

export interface PlacedUnit {
  team: number;
  kind: number;
  x: number;
  y: number;
  /** Online: the unit id assigned by the host and the pending client id. */
  id?: number;
  cid?: number;
}

/** Display and sound options. */
export interface Options {
  sound: boolean;
  volume: number;
  fx: 'auto' | 'high' | 'low' | 'off';
  numbers: boolean;
  bars: 'damaged' | 'always' | 'never';
  /** Debug overlay (the sim runs on the main thread). */
  debug: boolean;
  /** Comedy visuals (ragdoll death, exaggerated animation/effects/sound) and comedy physics (sim: launching). */
  comedyVisual: boolean;
  comedyPhysics: boolean;
}

export function defaultOptions(): Options {
  return { sound: true, volume: 0.6, fx: 'auto', numbers: true, bars: 'damaged', debug: false, comedyVisual: false, comedyPhysics: false };
}

export interface AppState {
  mapSize: number;
  env: boolean;
  /** Map recipe (biome, river, forest, village, pass). */
  map: MapSpec;
  /** Selected preset map: preset id, 'random' (last drawn) or 'custom'. */
  mapPreset: string;
  kite: boolean;
  seed: number;
  teamCount: number;
  palette: string;
  speed: number;
  selTeam: number;
  selKind: number;
  brush: number;
  tool: 'place' | 'erase';
  /** Erasing only affects the selected team's units (the touch equivalent of Shift). */
  eraseTeamOnly: boolean;
  benchPerTeam: number;
  /** Level of the roster units (1-10). */
  level: number;
  /** Unit stat overrides (only the changed ones). */
  stats: StatOverrides;
  options: Options;
  units: PlacedUnit[];
  /** Temporary states such as online placement are not written to localStorage. */
  ephemeral?: boolean;
  /** Team colors (instead of the palette); player colors when online. */
  customColors?: TeamColors[];
  /** If there is no saved setup, a quick formation is built on first launch. */
  fresh: boolean;
  /** Unit type table version (KINDS_VER). */
  kindsVer: number;
}

const KEY = 'rpgweb.studio.v1';
/** When type numbers change (a unit was added/removed), old placements are invalid. */
const KINDS_VER = 2;

export function defaultState(): AppState {
  return {
    mapSize: 56,
    env: true,
    map: { ...DEFAULT_MAP },
    mapPreset: 'pine-valley',
    kite: true,
    seed: 1,
    teamCount: 2,
    palette: 'classic',
    speed: 1,
    selTeam: 0,
    selKind: 0,
    brush: 1,
    tool: 'place',
    eraseTeamOnly: false,
    benchPerTeam: 10000,
    level: DEFAULT_LEVEL,
    stats: Array.from({ length: KIND_COUNT }, () => ({})),
    options: defaultOptions(),
    units: [],
    fresh: true,
    kindsVer: KINDS_VER,
  };
}

function darken(c: number, k: number): number {
  const r = Math.round(((c >> 16) & 255) * k);
  const g = Math.round(((c >> 8) & 255) * k);
  const b = Math.round((c & 255) * k);
  return (r << 16) | (g << 8) | b;
}

export function paletteById(id: string): PaletteSet {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}

/** The state's team colors: custom colors if present, otherwise the palette. */
export function colorsOf(s: AppState): TeamColors[] {
  return s.customColors ?? teamColors(s.palette, s.teamCount);
}

/** Team color from a single main color (the dark shade is derived). */
export function makeTeamColor(main: number): TeamColors {
  return { main, dark: darken(main, 0.55) };
}

export function teamColors(paletteId: string, count: number): TeamColors[] {
  const p = paletteById(paletteId);
  return Array.from({ length: Math.min(MAX_TEAMS, Math.max(1, count)) }, (_, i) => ({
    main: p.colors[i % p.colors.length],
    dark: darken(p.colors[i % p.colors.length], 0.55),
  }));
}

export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

/** Loads from localStorage; falls back to defaults on corrupt/missing data. */
export function loadState(): AppState {
  const d = defaultState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const o = JSON.parse(raw) as Partial<AppState>;
    const num = (v: unknown, lo: number, hi: number, def: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
    const s: AppState = {
      mapSize: MAP_SIZES.some((m) => m.id === o.mapSize) ? (o.mapSize as number) : d.mapSize,
      env: typeof o.env === 'boolean' ? o.env : d.env,
      map: sanitizeSpec(o.map),
      mapPreset: o.mapPreset === 'random' || o.mapPreset === 'custom' || PRESETS.some((p) => p.id === o.mapPreset) ? (o.mapPreset as string) : 'custom',
      kite: typeof o.kite === 'boolean' ? o.kite : d.kite,
      seed: Math.floor(num(o.seed, 1, 999999, d.seed)),
      teamCount: Math.floor(num(o.teamCount, 2, MAX_TEAMS, d.teamCount)),
      palette: PALETTES.some((p) => p.id === o.palette) ? (o.palette as string) : d.palette,
      speed: [1, 2, 4].includes(o.speed as number) ? (o.speed as number) : 1,
      selTeam: 0,
      selKind: (o as { kindsVer?: number }).kindsVer === KINDS_VER ? Math.floor(num(o.selKind, 0, KIND_COUNT - 1, 0)) : 0,
      brush: Math.floor(num(o.brush, 0, BRUSHES.length - 1, d.brush)),
      tool: 'place',
      eraseTeamOnly: false,
      benchPerTeam: [1000, 3000, 10000].includes(o.benchPerTeam as number) ? (o.benchPerTeam as number) : d.benchPerTeam,
      level: Math.floor(num(o.level, 1, MAX_LEVEL, d.level)),
      stats: Array.from({ length: KIND_COUNT }, () => ({})),
      options: defaultOptions(),
      units: [],
      fresh: false,
      kindsVer: KINDS_VER,
    };
    if (o.options && typeof o.options === 'object') {
      const op = o.options as Partial<Options>;
      if (typeof op.sound === 'boolean') s.options.sound = op.sound;
      if (typeof op.volume === 'number' && Number.isFinite(op.volume)) s.options.volume = Math.min(1, Math.max(0, op.volume));
      if (op.fx === 'auto' || op.fx === 'high' || op.fx === 'low' || op.fx === 'off') s.options.fx = op.fx;
      if (typeof op.numbers === 'boolean') s.options.numbers = op.numbers;
      if (typeof op.debug === 'boolean') s.options.debug = op.debug;
      if (typeof op.comedyVisual === 'boolean') s.options.comedyVisual = op.comedyVisual;
      if (typeof op.comedyPhysics === 'boolean') s.options.comedyPhysics = op.comedyPhysics;
      if (op.bars === 'damaged' || op.bars === 'always' || op.bars === 'never') s.options.bars = op.bars;
    }
    const stale = (o as { kindsVer?: number }).kindsVer !== KINDS_VER;
    if (!stale && Array.isArray(o.stats)) {
      o.stats.slice(0, KIND_COUNT).forEach((row, k) => {
        if (!row || typeof row !== 'object') return;
        for (const tn of TUNABLE) {
          const v = (row as Record<string, unknown>)[tn.key];
          if (typeof v === 'number' && Number.isFinite(v)) s.stats[k][tn.key] = Math.min(tn.max, Math.max(tn.min, v));
        }
      });
    }
    if (!stale && Array.isArray(o.units)) {
      for (const u of o.units.slice(0, MAX_PLACED)) {
        if (!u || typeof u !== 'object') continue;
        const { team, kind, x, y } = u as PlacedUnit;
        if (![team, kind, x, y].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
        if (team < 0 || team >= s.teamCount || kind < 0 || kind >= KIND_COUNT) continue;
        if (x < 0 || y < 0 || x > s.mapSize || y > s.mapSize) continue;
        s.units.push({ team: team | 0, kind: kind | 0, x, y });
      }
    }
    s.selTeam = 0;
    s.fresh = s.units.length === 0 && o.fresh !== false ? true : false;
    return s;
  } catch {
    return d;
  }
}

let saveTimer: number | undefined;
/** Delays saving slightly (so it does not write on every step while painting by dragging). */
export function saveState(s: AppState): void {
  if (s.ephemeral) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* quota full / private mode: ignore silently */
    }
  }, 250);
}
