import type { Localized } from '../contracts/localized';

/** Map recipe: the sim (terrain generation) and the renderer (appearance) share the same recipe. */
export type Biome = 'forest' | 'desert' | 'snow' | 'swamp';
export type RiverType = 'winding' | 'straight' | 'islands' | 'lake' | 'none';
export type ForestType = 'dense' | 'sparse' | 'grove' | 'ring' | 'none';
export type VillageType = 'village' | 'scattered' | 'ruins' | 'camp' | 'none';
export type CrossingType = 'wood' | 'stone' | 'ford';
/** Layout: classic (river + relief recipe), valley, central citadel, archipelago, crossroads. */
export type LayoutType = 'classic' | 'valley' | 'citadel' | 'archipelago' | 'crossroads';
/** Terrain relief: flat, hills, ridge, plateau (with ramps), peak (mountain). */
export type ReliefType = 'flat' | 'hills' | 'ridge' | 'plateau' | 'peak';

export interface MapSpec {
  biome: Biome;
  river: RiverType;
  forest: ForestType;
  village: VillageType;
  crossing: CrossingType;
  relief: ReliefType;
  layout: LayoutType;
}

/** Default map (the one from the first version): forest, winding river, dense pines, village, wooden bridge. */
export const DEFAULT_MAP: MapSpec = { biome: 'forest', river: 'winding', forest: 'dense', village: 'village', crossing: 'wood', relief: 'flat', layout: 'classic' };

export const BIOMES: Biome[] = ['forest', 'desert', 'snow', 'swamp'];
export const RIVERS: RiverType[] = ['winding', 'straight', 'islands', 'lake', 'none'];
export const FORESTS: ForestType[] = ['dense', 'sparse', 'grove', 'ring', 'none'];
export const VILLAGES: VillageType[] = ['village', 'scattered', 'ruins', 'camp', 'none'];
export const CROSSINGS: CrossingType[] = ['wood', 'stone', 'ford'];
export const RELIEFS: ReliefType[] = ['flat', 'hills', 'ridge', 'plateau', 'peak'];
export const LAYOUTS: LayoutType[] = ['classic', 'valley', 'citadel', 'archipelago', 'crossroads'];

export const BIOME_NAMES: Record<Biome, Localized> = { forest: { en: 'Forest', tr: 'Orman' }, desert: { en: 'Desert', tr: 'Çöl' }, snow: { en: 'Snow', tr: 'Kar' }, swamp: { en: 'Swamp', tr: 'Bataklık' } };
export const RIVER_NAMES: Record<RiverType, Localized> = { winding: { en: 'Winding', tr: 'Kıvrımlı' }, straight: { en: 'Straight', tr: 'Düz' }, islands: { en: 'Islands', tr: 'Adalı' }, lake: { en: 'Lake', tr: 'Göllü' }, none: { en: 'No river', tr: 'Nehirsiz' } };
export const FOREST_NAMES: Record<ForestType, Localized> = { dense: { en: 'Dense', tr: 'Yoğun' }, sparse: { en: 'Sparse', tr: 'Seyrek' }, grove: { en: 'Grove', tr: 'Koru' }, ring: { en: 'Ring forest', tr: 'Çevre ormanı' }, none: { en: 'No forest', tr: 'Ormansız' } };
export const VILLAGE_NAMES: Record<VillageType, Localized> = { village: { en: 'Village', tr: 'Köy' }, scattered: { en: 'Scattered houses', tr: 'Dağınık evler' }, ruins: { en: 'Ruined fort', tr: 'Harabe kale' }, camp: { en: 'Camp', tr: 'Kamp' }, none: { en: 'No village', tr: 'Köysüz' } };
export const CROSSING_NAMES: Record<CrossingType, Localized> = { wood: { en: 'Wooden bridge', tr: 'Ahşap köprü' }, stone: { en: 'Stone bridge', tr: 'Taş köprü' }, ford: { en: 'Shallow ford', tr: 'Sığ geçit' } };
export const LAYOUT_NAMES: Record<LayoutType, Localized> = { classic: { en: 'Classic', tr: 'Klasik' }, valley: { en: 'Valley and pass', tr: 'Vadi ve geçit' }, citadel: { en: 'Central citadel', tr: 'Merkez kale' }, archipelago: { en: 'Islands and bridges', tr: 'Adalar ve köprüler' }, crossroads: { en: 'Crossroads', tr: 'Çapraz yol' } };
export const RELIEF_NAMES: Record<ReliefType, Localized> = { flat: { en: 'Flat', tr: 'Düz' }, hills: { en: 'Hills', tr: 'Tepecikler' }, ridge: { en: 'Mountain ridge', tr: 'Sıradağ' }, plateau: { en: 'Plateau', tr: 'Plato' }, peak: { en: 'Mountain', tr: 'Dağ' } };

export interface MapPreset {
  id: string;
  name: Localized;
  spec: MapSpec;
}

const P = (id: string, name: Localized, biome: Biome, river: RiverType, forest: ForestType, village: VillageType, crossing: CrossingType, relief: ReliefType = 'flat', layout: LayoutType = 'classic'): MapPreset => ({
  id,
  name,
  spec: { biome, river, forest, village, crossing, relief, layout },
});

export const PRESETS: MapPreset[] = [
  P('pine-valley', { en: 'Pine Valley', tr: 'Çam Vadisi' }, 'forest', 'winding', 'dense', 'village', 'wood'),
  P('shallow-ford', { en: 'Shallow Ford', tr: 'Sığ Geçit' }, 'forest', 'straight', 'sparse', 'scattered', 'ford'),
  P('lake-grove', { en: 'Lakeside Grove', tr: 'Göllü Koru' }, 'forest', 'lake', 'grove', 'village', 'stone'),
  P('clay-villages', { en: 'Clay Villages', tr: 'Kil Köyleri' }, 'desert', 'winding', 'sparse', 'village', 'stone'),
  P('dry-oasis', { en: 'Dry Oasis', tr: 'Vaha' }, 'desert', 'lake', 'none', 'scattered', 'ford'),
  P('ruined-fort', { en: 'Ruined Fort', tr: 'Harabe Kalesi' }, 'desert', 'none', 'sparse', 'ruins', 'wood'),
  P('glacier-river', { en: 'Glacier River', tr: 'Buzul Nehri' }, 'snow', 'islands', 'dense', 'camp', 'stone'),
  P('winter-forest', { en: 'Winter Forest', tr: 'Kış Ormanı' }, 'snow', 'straight', 'dense', 'scattered', 'wood'),
  P('frozen-lake', { en: 'Frozen Lake', tr: 'Donmuş Göl' }, 'snow', 'lake', 'ring', 'village', 'ford'),
  P('rotten-marsh', { en: 'Rotten Marsh', tr: 'Çürük Bataklık' }, 'swamp', 'islands', 'sparse', 'scattered', 'wood'),
  P('reed-bed', { en: 'Reed Bed', tr: 'Sazlık' }, 'swamp', 'winding', 'grove', 'camp', 'ford'),
  P('dead-trees', { en: 'Dead Trees', tr: 'Ölü Ağaçlar' }, 'swamp', 'lake', 'dense', 'ruins', 'wood'),
  P('rolling-hills', { en: 'Green Hills', tr: 'Yeşil Tepeler' }, 'forest', 'winding', 'sparse', 'scattered', 'wood', 'hills'),
  P('twin-ridges', { en: 'Twin Ridges', tr: 'İkiz Sıradağ' }, 'forest', 'none', 'dense', 'camp', 'wood', 'ridge'),
  P('high-plateau', { en: 'High Plateau', tr: 'Yüksek Plato' }, 'forest', 'none', 'grove', 'ruins', 'wood', 'plateau'),
  P('dune-peaks', { en: 'Dune Crests', tr: 'Kum Tepeleri' }, 'desert', 'none', 'sparse', 'scattered', 'stone', 'hills'),
  P('mesa', { en: 'Mesa', tr: 'Mesa' }, 'desert', 'lake', 'none', 'ruins', 'ford', 'plateau'),
  P('snow-peak', { en: 'Snowy Peak', tr: 'Karlı Dağ' }, 'snow', 'none', 'dense', 'camp', 'stone', 'peak'),
  P('frozen-ridge', { en: 'Frozen Ridge', tr: 'Donmuş Sırt' }, 'snow', 'straight', 'sparse', 'village', 'wood', 'ridge'),
  P('marsh-mounds', { en: 'Marsh Mounds', tr: 'Bataklık Höyükleri' }, 'swamp', 'islands', 'grove', 'scattered', 'wood', 'hills'),
  P('mountain-pass', { en: 'Mountain Pass', tr: 'Dağ Geçidi' }, 'forest', 'none', 'dense', 'ruins', 'wood', 'flat', 'valley'),
  P('frozen-gorge', { en: 'Frozen Gorge', tr: 'Donmuş Boğaz' }, 'snow', 'straight', 'dense', 'camp', 'stone', 'flat', 'valley'),
  P('canyon-gate', { en: 'Canyon Gate', tr: 'Kanyon Kapısı' }, 'desert', 'winding', 'sparse', 'scattered', 'ford', 'flat', 'valley'),
  P('citadel-hill', { en: 'Citadel Hill', tr: 'Kale Tepesi' }, 'forest', 'none', 'grove', 'scattered', 'wood', 'flat', 'citadel'),
  P('desert-fortress', { en: 'Desert Fortress', tr: 'Çöl Kalesi' }, 'desert', 'none', 'sparse', 'scattered', 'stone', 'flat', 'citadel'),
  P('snow-keep', { en: 'Snow Keep', tr: 'Kar Hisarı' }, 'snow', 'none', 'dense', 'camp', 'stone', 'flat', 'citadel'),
  P('swamp-fort', { en: 'Swamp Fort', tr: 'Bataklık Kalesi' }, 'swamp', 'none', 'grove', 'scattered', 'wood', 'flat', 'citadel'),
  P('forest-isles', { en: 'Forest Isles', tr: 'Orman Adaları' }, 'forest', 'islands', 'grove', 'village', 'wood', 'flat', 'archipelago'),
  P('ice-archipelago', { en: 'Ice Archipelago', tr: 'Buz Takımadaları' }, 'snow', 'islands', 'sparse', 'camp', 'stone', 'flat', 'archipelago'),
  P('sand-isles', { en: 'Sand Isles', tr: 'Kum Adaları' }, 'desert', 'islands', 'sparse', 'scattered', 'wood', 'flat', 'archipelago'),
  P('crossroads-green', { en: 'Green Crossroads', tr: 'Yeşil Kavşak' }, 'forest', 'none', 'sparse', 'village', 'wood', 'flat', 'crossroads'),
  P('crossroads-sand', { en: 'Caravan Road', tr: 'Kervan Yolu' }, 'desert', 'none', 'none', 'scattered', 'wood', 'flat', 'crossroads'),
  P('crossroads-snow', { en: 'Winter Crossroads', tr: 'Kış Kavşağı' }, 'snow', 'none', 'dense', 'camp', 'wood', 'flat', 'crossroads'),
];

export function sameSpec(a: MapSpec, b: MapSpec): boolean {
  return a.biome === b.biome && a.river === b.river && a.forest === b.forest && a.village === b.village && a.crossing === b.crossing && a.relief === b.relief && a.layout === b.layout;
}

/** Turns broken/old saved data into a safe recipe. */
export function sanitizeSpec(x: unknown): MapSpec {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const pick = <T extends string>(list: readonly T[], v: unknown, d: T): T => (list.includes(v as T) ? (v as T) : d);
  return {
    biome: pick(BIOMES, o.biome, DEFAULT_MAP.biome),
    river: pick(RIVERS, o.river, DEFAULT_MAP.river),
    forest: pick(FORESTS, o.forest, DEFAULT_MAP.forest),
    village: pick(VILLAGES, o.village, DEFAULT_MAP.village),
    crossing: pick(CROSSINGS, o.crossing, DEFAULT_MAP.crossing),
    relief: pick(RELIEFS, o.relief, DEFAULT_MAP.relief),
    layout: pick(LAYOUTS, o.layout, DEFAULT_MAP.layout),
  };
}

/** Random recipe (from the given 0..1 generator). */
export function randomSpec(rnd: () => number): MapSpec {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];
  return { biome: pick(BIOMES), river: pick(RIVERS), forest: pick(FORESTS), village: pick(VILLAGES), crossing: pick(CROSSINGS), relief: pick(RELIEFS), layout: pick(LAYOUTS) };
}
