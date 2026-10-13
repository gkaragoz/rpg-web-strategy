import type { Graphics } from 'pixi.js';

/** Color and size by projectile look tag (shared by massRenderer and detailed mode). */
export interface ProjStyle {
  /** true: round glowing orb (puff texture), false: arrow/spear line. */
  orb: boolean;
  color: number;
  scale: number;
}

export const PROJ_STYLES: ProjStyle[] = [
  { orb: false, color: 0xffffff, scale: 1 },
  { orb: true, color: 0xff8a2a, scale: 1.05 },
  { orb: true, color: 0x9ae0ff, scale: 0.95 },
  { orb: true, color: 0x3a3f48, scale: 0.8 },
  { orb: true, color: 0x9a9a92, scale: 1.1 },
  { orb: true, color: 0xffe27a, scale: 0.95 },
  { orb: true, color: 0xb04fff, scale: 0.95 },
  { orb: true, color: 0x2b2f36, scale: 1.1 },
  { orb: false, color: 0xf0e0b0, scale: 1.6 },
  { orb: false, color: 0xe6e6ea, scale: 1.35 },
  { orb: true, color: 0x4fc3ff, scale: 1.0 },
];

export function projStyle(tag: number): ProjStyle {
  return PROJ_STYLES[tag] ?? PROJ_STYLES[0];
}

/** Detailed mode: draws the projectile as Graphics (center 0,0; direction +x). */
export function drawProjectile(g: Graphics, tag: number): void {
  g.clear();
  const st = projStyle(tag);
  if (st.orb) {
    g.circle(0, 0, 9 * st.scale).fill({ color: st.color, alpha: 0.25 });
    g.circle(0, 0, 5.5 * st.scale).fill({ color: st.color, alpha: 0.85 });
    g.circle(-1, -1, 2.2 * st.scale).fill({ color: 0xffffff, alpha: 0.8 });
    return;
  }
  const k = st.scale;
  g.moveTo(-9 * k, 0).lineTo(7 * k, 0).stroke({ width: 2, color: tag === 0 ? 0x6b4a2b : 0x8a6a3a });
  g.poly([7 * k, -3, 12 * k, 0, 7 * k, 3]).fill(tag === 9 ? 0xc9ced6 : 0xcfd4dc);
  g.poly([-9 * k, 0, -12 * k, -3, -6 * k, 0, -12 * k, 3]).fill(0xf2f2f2);
}
