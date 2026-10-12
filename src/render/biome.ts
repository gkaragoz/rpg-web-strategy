import type { Biome } from '../sim/mapSpec';

/** Biyom renk paleti: zemin, yan yuzler, yol, nehir/su ve kopru renkleri. */
export interface BiomePalette {
  grassA: number;
  grassB: number;
  sideL: number;
  sideR: number;
  path: number;
  bank: number;
  water: number;
  waterMid: number;
  waterShine: number;
  /** Dalga cizgisi rengi ve opakligi. */
  wave: number;
  waveAlpha: number;
  /** Ahsap kopru renkleri: tabla, iki yan yuz, direk, korkuluk. */
  deck: number;
  deckSideA: number;
  deckSideB: number;
  post: number;
  rail: number;
  /** Tas kopru renkleri. */
  stoneDeck: number;
  stoneSideA: number;
  stoneSideB: number;
  stoneRail: number;
  /** Dik yamac/ucurum kaya rengi. */
  cliff: number;
}

const base = {
  deck: 0xa9794a,
  deckSideA: 0x6b4a2b,
  deckSideB: 0x7f5733,
  post: 0x5b3d22,
  rail: 0x8a6238,
  stoneDeck: 0xaaa9a1,
  stoneSideA: 0x6f6e68,
  stoneSideB: 0x85847d,
  stoneRail: 0x8d8c85,
};
const CLIFF: Record<string, number> = { forest: 0x8c8776, desert: 0xa88a5e, snow: 0xaebccb, swamp: 0x5c5a45 };

export const PALETTES: Record<Biome, BiomePalette> = {
  forest: { ...base, cliff: CLIFF.forest, grassA: 0x78ab52, grassB: 0x6c9e48, sideL: 0x4a3a2a, sideR: 0x372a1e, path: 0xb79a6a, bank: 0xe3d3a4, water: 0x4a90c8, waterMid: 0x6fb0e0, waterShine: 0x8cc6ee, wave: 0xffffff, waveAlpha: 0.55 },
  desert: { ...base, cliff: CLIFF.desert, grassA: 0xdcc07f, grassB: 0xd0b473, sideL: 0x7a5c36, sideR: 0x5e4528, path: 0xb48e58, bank: 0xeee0ae, water: 0x3f9fb0, waterMid: 0x62bccb, waterShine: 0x8fd8e2, wave: 0xffffff, waveAlpha: 0.5 },
  snow: { ...base, cliff: CLIFF.snow, grassA: 0xe9f1f7, grassB: 0xdbe7f1, sideL: 0x7d8fa0, sideR: 0x607080, path: 0xb7c5d3, bank: 0xf8fcff, water: 0x7db5d6, waterMid: 0xa9d4ea, waterShine: 0xd8f0fb, wave: 0xffffff, waveAlpha: 0.8, deck: 0xb59470, deckSideA: 0x7a5c3e, deckSideB: 0x8c6c4a },
  swamp: { ...base, cliff: CLIFF.swamp, grassA: 0x6e8140, grassB: 0x617439, sideL: 0x3a3a22, sideR: 0x2c2c1a, path: 0x7f6e45, bank: 0x8e9152, water: 0x38594a, waterMid: 0x4a7358, waterShine: 0x6d9c78, wave: 0xc8e0b0, waveAlpha: 0.35, deck: 0x8a6a42, deckSideA: 0x5a4128, deckSideB: 0x6b4d30 },
};
