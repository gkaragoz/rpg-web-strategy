/**
 * Comedy mode runtime flag: the render layers (UnitView, MassRenderer, FxSystem, AudioSystem)
 * read it. visual: look/sound only (does not touch the sim). The physics flag lives in the sim's config.comedy field.
 */
export const comedy = { visual: false };

/** Fixed per-unit "randomness" (fast, seeded); 0..1. */
export function hash01(n: number): number {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) / 4294967296;
}
