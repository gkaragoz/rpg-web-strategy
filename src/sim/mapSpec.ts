/** Harita tarifi: sim (arazi uretimi) ve renderer (gorunum) ayni tarifi paylasir. */
export type Biome = 'forest' | 'desert' | 'snow' | 'swamp';
export type RiverType = 'winding' | 'straight' | 'islands' | 'lake' | 'none';
export type ForestType = 'dense' | 'sparse' | 'grove' | 'ring' | 'none';
export type VillageType = 'village' | 'scattered' | 'ruins' | 'camp' | 'none';
export type CrossingType = 'wood' | 'stone' | 'ford';
/** Arazi kabartmasi: duz, tepecikler, siradag, plato (rampali), zirve (dag). */
/** Yerlesim kurgusu: klasik (nehir+kabartma tarifi), vadi, merkez kale, adalar, capraz yol. */
export type LayoutType = 'classic' | 'valley' | 'citadel' | 'archipelago' | 'crossroads';
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

/** Varsayilan (ilk surumdeki) harita: orman, kivrimli nehir, yogun cam, koy, ahsap kopru. */
export const DEFAULT_MAP: MapSpec = { biome: 'forest', river: 'winding', forest: 'dense', village: 'village', crossing: 'wood', relief: 'flat', layout: 'classic' };

export const BIOMES: Biome[] = ['forest', 'desert', 'snow', 'swamp'];
export const RIVERS: RiverType[] = ['winding', 'straight', 'islands', 'lake', 'none'];
export const FORESTS: ForestType[] = ['dense', 'sparse', 'grove', 'ring', 'none'];
export const VILLAGES: VillageType[] = ['village', 'scattered', 'ruins', 'camp', 'none'];
export const CROSSINGS: CrossingType[] = ['wood', 'stone', 'ford'];
export const RELIEFS: ReliefType[] = ['flat', 'hills', 'ridge', 'plateau', 'peak'];
export const LAYOUTS: LayoutType[] = ['classic', 'valley', 'citadel', 'archipelago', 'crossroads'];

export const BIOME_NAMES: Record<Biome, string> = { forest: 'Orman', desert: 'Çöl', snow: 'Kar', swamp: 'Bataklık' };
export const RIVER_NAMES: Record<RiverType, string> = { winding: 'Kıvrımlı', straight: 'Düz', islands: 'Adalı', lake: 'Göllü', none: 'Nehirsiz' };
export const FOREST_NAMES: Record<ForestType, string> = { dense: 'Yoğun', sparse: 'Seyrek', grove: 'Koru', ring: 'Çevre ormanı', none: 'Ormansız' };
export const VILLAGE_NAMES: Record<VillageType, string> = { village: 'Köy', scattered: 'Dağınık evler', ruins: 'Harabe kale', camp: 'Kamp', none: 'Köysüz' };
export const CROSSING_NAMES: Record<CrossingType, string> = { wood: 'Ahşap köprü', stone: 'Taş köprü', ford: 'Sığ geçit' };
export const LAYOUT_NAMES: Record<LayoutType, string> = { classic: 'Klasik', valley: 'Vadi ve geçit', citadel: 'Merkez kale', archipelago: 'Adalar ve köprüler', crossroads: 'Çapraz yol' };
export const RELIEF_NAMES: Record<ReliefType, string> = { flat: 'Düz', hills: 'Tepecikler', ridge: 'Sıradağ', plateau: 'Plato', peak: 'Dağ' };

export interface MapPreset {
  id: string;
  name: string;
  spec: MapSpec;
}

const P = (id: string, name: string, biome: Biome, river: RiverType, forest: ForestType, village: VillageType, crossing: CrossingType, relief: ReliefType = 'flat', layout: LayoutType = 'classic'): MapPreset => ({
  id,
  name,
  spec: { biome, river, forest, village, crossing, relief, layout },
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
  P('rolling-hills', 'Yeşil Tepeler', 'forest', 'winding', 'sparse', 'scattered', 'wood', 'hills'),
  P('twin-ridges', 'İkiz Sıradağ', 'forest', 'none', 'dense', 'camp', 'wood', 'ridge'),
  P('high-plateau', 'Yüksek Plato', 'forest', 'none', 'grove', 'ruins', 'wood', 'plateau'),
  P('dune-peaks', 'Kum Tepeleri', 'desert', 'none', 'sparse', 'scattered', 'stone', 'hills'),
  P('mesa', 'Mesa', 'desert', 'lake', 'none', 'ruins', 'ford', 'plateau'),
  P('snow-peak', 'Karlı Dağ', 'snow', 'none', 'dense', 'camp', 'stone', 'peak'),
  P('frozen-ridge', 'Donmuş Sırt', 'snow', 'straight', 'sparse', 'village', 'wood', 'ridge'),
  P('marsh-mounds', 'Bataklık Höyükleri', 'swamp', 'islands', 'grove', 'scattered', 'wood', 'hills'),
  P('mountain-pass', 'Dağ Geçidi', 'forest', 'none', 'dense', 'ruins', 'wood', 'flat', 'valley'),
  P('frozen-gorge', 'Donmuş Boğaz', 'snow', 'straight', 'dense', 'camp', 'stone', 'flat', 'valley'),
  P('canyon-gate', 'Kanyon Kapısı', 'desert', 'winding', 'sparse', 'scattered', 'ford', 'flat', 'valley'),
  P('citadel-hill', 'Kale Tepesi', 'forest', 'none', 'grove', 'scattered', 'wood', 'flat', 'citadel'),
  P('desert-fortress', 'Çöl Kalesi', 'desert', 'none', 'sparse', 'scattered', 'stone', 'flat', 'citadel'),
  P('snow-keep', 'Kar Hisarı', 'snow', 'none', 'dense', 'camp', 'stone', 'flat', 'citadel'),
  P('swamp-fort', 'Bataklık Kalesi', 'swamp', 'none', 'grove', 'scattered', 'wood', 'flat', 'citadel'),
  P('forest-isles', 'Orman Adaları', 'forest', 'islands', 'grove', 'village', 'wood', 'flat', 'archipelago'),
  P('ice-archipelago', 'Buz Takımadaları', 'snow', 'islands', 'sparse', 'camp', 'stone', 'flat', 'archipelago'),
  P('sand-isles', 'Kum Adaları', 'desert', 'islands', 'sparse', 'scattered', 'wood', 'flat', 'archipelago'),
  P('crossroads-green', 'Yeşil Kavşak', 'forest', 'none', 'sparse', 'village', 'wood', 'flat', 'crossroads'),
  P('crossroads-sand', 'Kervan Yolu', 'desert', 'none', 'none', 'scattered', 'wood', 'flat', 'crossroads'),
  P('crossroads-snow', 'Kış Kavşağı', 'snow', 'none', 'dense', 'camp', 'wood', 'flat', 'crossroads'),
];

export function sameSpec(a: MapSpec, b: MapSpec): boolean {
  return a.biome === b.biome && a.river === b.river && a.forest === b.forest && a.village === b.village && a.crossing === b.crossing && a.relief === b.relief && a.layout === b.layout;
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
    relief: pick(RELIEFS, o.relief, DEFAULT_MAP.relief),
    layout: pick(LAYOUTS, o.layout, DEFAULT_MAP.layout),
  };
}

/** Rastgele tarif (verilen 0..1 uretecinden). */
export function randomSpec(rnd: () => number): MapSpec {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];
  return { biome: pick(BIOMES), river: pick(RIVERS), forest: pick(FORESTS), village: pick(VILLAGES), crossing: pick(CROSSINGS), relief: pick(RELIEFS), layout: pick(LAYOUTS) };
}
