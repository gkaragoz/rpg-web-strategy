/** Harita tarifi: sim (arazi uretimi) ve renderer (gorunum) ayni tarifi paylasir. */
export type Biome = 'forest' | 'desert' | 'snow' | 'swamp';
export type RiverType = 'winding' | 'straight' | 'islands' | 'lake' | 'none';
export type ForestType = 'dense' | 'sparse' | 'grove' | 'ring' | 'none';
export type VillageType = 'village' | 'scattered' | 'ruins' | 'camp' | 'none';
export type CrossingType = 'wood' | 'stone' | 'ford';

export interface MapSpec {
  biome: Biome;
  river: RiverType;
  forest: ForestType;
  village: VillageType;
  crossing: CrossingType;
}

/** Varsayilan (ilk surumdeki) harita: orman, kivrimli nehir, yogun cam, koy, ahsap kopru. */
export const DEFAULT_MAP: MapSpec = { biome: 'forest', river: 'winding', forest: 'dense', village: 'village', crossing: 'wood' };

export const BIOMES: Biome[] = ['forest', 'desert', 'snow', 'swamp'];
export const RIVERS: RiverType[] = ['winding', 'straight', 'islands', 'lake', 'none'];
export const FORESTS: ForestType[] = ['dense', 'sparse', 'grove', 'ring', 'none'];
export const VILLAGES: VillageType[] = ['village', 'scattered', 'ruins', 'camp', 'none'];
export const CROSSINGS: CrossingType[] = ['wood', 'stone', 'ford'];

export const BIOME_NAMES: Record<Biome, string> = { forest: 'Orman', desert: 'Çöl', snow: 'Kar', swamp: 'Bataklık' };
export const RIVER_NAMES: Record<RiverType, string> = { winding: 'Kıvrımlı', straight: 'Düz', islands: 'Adalı', lake: 'Göllü', none: 'Nehirsiz' };
export const FOREST_NAMES: Record<ForestType, string> = { dense: 'Yoğun', sparse: 'Seyrek', grove: 'Koru', ring: 'Çevre ormanı', none: 'Ormansız' };
export const VILLAGE_NAMES: Record<VillageType, string> = { village: 'Köy', scattered: 'Dağınık evler', ruins: 'Harabe kale', camp: 'Kamp', none: 'Köysüz' };
export const CROSSING_NAMES: Record<CrossingType, string> = { wood: 'Ahşap köprü', stone: 'Taş köprü', ford: 'Sığ geçit' };

export interface MapPreset {
  id: string;
  name: string;
  spec: MapSpec;
}

const P = (id: string, name: string, biome: Biome, river: RiverType, forest: ForestType, village: VillageType, crossing: CrossingType): MapPreset => ({
  id,
  name,
  spec: { biome, river, forest, village, crossing },
});

export const PRESETS: MapPreset[] = [
  P('pine-valley', 'Çam Vadisi', 'forest', 'winding', 'dense', 'village', 'wood'),
  P('shallow-ford', 'Sığ Geçit', 'forest', 'straight', 'sparse', 'scattered', 'ford'),
  P('lake-grove', 'Göllü Koru', 'forest', 'lake', 'grove', 'village', 'stone'),
  P('clay-villages', 'Kil Köyleri', 'desert', 'winding', 'sparse', 'village', 'stone'),
  P('dry-oasis', 'Vaha', 'desert', 'lake', 'none', 'scattered', 'ford'),
  P('ruined-fort', 'Harabe Kalesi', 'desert', 'none', 'sparse', 'ruins', 'wood'),
  P('glacier-river', 'Buzul Nehri', 'snow', 'islands', 'dense', 'camp', 'stone'),
  P('winter-forest', 'Kış Ormanı', 'snow', 'straight', 'dense', 'scattered', 'wood'),
  P('frozen-lake', 'Donmuş Göl', 'snow', 'lake', 'ring', 'village', 'ford'),
  P('rotten-marsh', 'Çürük Bataklık', 'swamp', 'islands', 'sparse', 'scattered', 'wood'),
  P('reed-bed', 'Sazlık', 'swamp', 'winding', 'grove', 'camp', 'ford'),
  P('dead-trees', 'Ölü Ağaçlar', 'swamp', 'lake', 'dense', 'ruins', 'wood'),
];

export function sameSpec(a: MapSpec, b: MapSpec): boolean {
  return a.biome === b.biome && a.river === b.river && a.forest === b.forest && a.village === b.village && a.crossing === b.crossing;
}

/** Bozuk/eski kayitlari guvenli bir tarife cevirir. */
export function sanitizeSpec(x: unknown): MapSpec {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
  return {
    biome: pick(BIOMES, o.biome, DEFAULT_MAP.biome),
    river: pick(RIVERS, o.river, DEFAULT_MAP.river),
    forest: pick(FORESTS, o.forest, DEFAULT_MAP.forest),
    village: pick(VILLAGES, o.village, DEFAULT_MAP.village),
    crossing: pick(CROSSINGS, o.crossing, DEFAULT_MAP.crossing),
  };
}

/** Rastgele tarif (verilen 0..1 uretecinden). */
export function randomSpec(rnd: () => number): MapSpec {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];
  return { biome: pick(BIOMES), river: pick(RIVERS), forest: pick(FORESTS), village: pick(VILLAGES), crossing: pick(CROSSINGS) };
}
