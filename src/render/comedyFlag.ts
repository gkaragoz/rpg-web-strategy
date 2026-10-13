/**
 * Komedi modu calisma zamani bayragi: render katmanlari (UnitView, MassRenderer, FxSystem, AudioSystem)
 * bunu okur. visual: yalniz gorunum/ses (sim'e dokunmaz). Fizik bayragi sim'in config.comedy alanindadir.
 */
export const comedy = { visual: false };

/** Birim basina sabit "rastgelelik" (hizli, tohumlu); 0..1. */
export function hash01(n: number): number {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
}
