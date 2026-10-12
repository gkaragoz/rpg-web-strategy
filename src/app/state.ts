import { KIND_COUNT, MAX_TEAMS } from '../sim/units';
import type { TeamColors } from '../render/unitView';

export interface PaletteSet {
  id: string;
  name: string;
  colors: number[];
}

/** Hazir tema setleri: renkler takimlara sirayla atanir. */
export const PALETTES: PaletteSet[] = [
  { id: 'classic', name: 'Klasik', colors: [0x4a8fe8, 0xe85a4f, 0x4cc35b, 0xe6b73a, 0xa76ad8, 0xee8a3c] },
  { id: 'desert', name: 'Çöl', colors: [0x2e86c1, 0xc0392b, 0xd4ac0d, 0x17a589, 0x6c3483, 0x7d6608] },
  { id: 'night', name: 'Gece', colors: [0x4dd0e1, 0xff5d73, 0xb388ff, 0xffd54f, 0x69f0ae, 0xff8a65] },
  { id: 'pastel', name: 'Pastel', colors: [0x9cc5f0, 0xf4a6a0, 0xa8dba8, 0xf7dc8a, 0xcdb4e6, 0xf6c28f] },
];

export const MAP_SIZES = [
  { id: 40, name: 'Küçük' },
  { id: 56, name: 'Orta' },
  { id: 80, name: 'Büyük' },
] as const;

/** Editorde yerlestirilebilecek en fazla birim (benchmark ayri). */
export const MAX_PLACED = 3000;

export const BRUSHES = [
  { id: 0, name: 'Tek', radius: 0.6, count: 1 },
  { id: 1, name: 'Küçük', radius: 2.2, count: 5 },
  { id: 2, name: 'Büyük', radius: 4.5, count: 15 },
] as const;

export interface PlacedUnit {
  team: number;
  kind: number;
  x: number;
  y: number;
}

export interface AppState {
  mapSize: number;
  env: boolean;
  kite: boolean;
  seed: number;
  teamCount: number;
  palette: string;
  speed: number;
  selTeam: number;
  selKind: number;
  brush: number;
  tool: 'place' | 'erase';
  benchPerTeam: number;
  units: PlacedUnit[];
  /** Hic kaydedilmis kurulum yoksa ilk acilista hizli dizilim kurulur. */
  fresh: boolean;
}

const KEY = 'rpgweb.studio.v1';

export function defaultState(): AppState {
  return {
    mapSize: 56,
    env: true,
    kite: true,
    seed: 1,
    teamCount: 2,
    palette: 'classic',
    speed: 1,
    selTeam: 0,
    selKind: 0,
    brush: 1,
    tool: 'place',
    benchPerTeam: 10000,
    units: [],
    fresh: true,
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

/** Secili palet ve takim sayisi icin takim renk ciftleri. */
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

/** localStorage'dan yukler; bozuk/eksik veride varsayilanlara duser. */
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
      kite: typeof o.kite === 'boolean' ? o.kite : d.kite,
      seed: Math.floor(num(o.seed, 1, 999999, d.seed)),
      teamCount: Math.floor(num(o.teamCount, 2, MAX_TEAMS, d.teamCount)),
      palette: PALETTES.some((p) => p.id === o.palette) ? (o.palette as string) : d.palette,
      speed: [1, 2, 4].includes(o.speed as number) ? (o.speed as number) : 1,
      selTeam: 0,
      selKind: Math.floor(num(o.selKind, 0, KIND_COUNT - 1, 0)),
      brush: Math.floor(num(o.brush, 0, BRUSHES.length - 1, d.brush)),
      tool: 'place',
      benchPerTeam: [1000, 3000, 10000].includes(o.benchPerTeam as number) ? (o.benchPerTeam as number) : d.benchPerTeam,
      units: [],
      fresh: false,
    };
    if (Array.isArray(o.units)) {
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
/** Kaydi biraz geciktirir (surukleyerek boyarken her adimda yazmasin). */
export function saveState(s: AppState): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* kota dolu / ozel mod: sessizce gec */
    }
  }, 250);
}
