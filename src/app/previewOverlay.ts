import type { Race, Shape, SkillId } from '../sim/data/troops';

/** What a unit card shows during the strike of its attack preview (drawn with Canvas2D over the unit frames). */
export type OverlayKind = 'slash' | 'wide-slash' | 'ring' | 'shock' | 'arrow' | 'bolt' | 'axe' | 'orb';

export interface Overlay {
  kind: OverlayKind;
  /** CSS color. */
  color: string;
}

export interface PreviewInfo {
  ranged: boolean;
  magical: boolean;
  healer: boolean;
  tank: boolean;
  shape: Shape;
  aoe: number;
  skill: SkillId | null;
  race: Race | null;
}

const FIRE = '#ff8a2a';
const ICE = '#9ae0ff';
const HOLY = '#ffe27a';
const DARK = '#b04fff';
const HEAL = '#7dffa8';

/** Picks the attack overlay for a unit from its stats (pure: unit tested). */
export function overlayFor(i: PreviewInfo): Overlay {
  if (i.healer || i.skill === 'heal' || i.skill === 'cleanse') return { kind: 'orb', color: HEAL };
  if (i.ranged && i.magical) {
    const c = i.skill === 'frostBlast' || i.skill === 'chill' ? ICE : i.skill === 'curseZone' || i.skill === 'hex' || i.skill === 'summonSkeleton' ? DARK : i.race === 'sacred' ? HOLY : i.race === 'dark' ? DARK : FIRE;
    return { kind: 'orb', color: c };
  }
  if (i.ranged) {
    if (i.skill === 'axes') return { kind: 'axe', color: '#e6e6ea' };
    if (i.shape === 'pierce') return { kind: 'bolt', color: '#f0e0b0' };
    if (i.shape === 'round' || i.aoe > 0) return { kind: 'orb', color: '#9a9a92' }; // bombs / flaming shot
    return { kind: 'arrow', color: '#ffffff' };
  }
  if (i.tank || i.skill === 'bash' || i.skill === 'rockThrow' || i.skill === 'stoneWill') return { kind: 'shock', color: '#e8d9b0' };
  if (i.shape === 'round') return { kind: 'ring', color: i.magical ? HOLY : '#ffffff' };
  if (i.shape === 'rect') return { kind: 'wide-slash', color: i.race === 'sacred' ? HOLY : '#ffffff' };
  return { kind: 'slash', color: '#ffffff' };
}

/** Preview cycle: attack frames play during the first `ATTACK_SHARE` of the loop, then the unit rests (idle frame). */
export const ATTACK_SHARE = 0.62;

/**
 * Maps a loop time (0..1, already offset per card) to a sheet frame index and the strike progress.
 * Frames 0..n-1 are the attack (swingProgress 0..1), frame n is the idle pose.
 */
export function frameAt(loopT: number, n: number): { frame: number; swing: number } {
  const t = ((loopT % 1) + 1) % 1;
  if (t >= ATTACK_SHARE) return { frame: n, swing: -1 };
  const swing = t / ATTACK_SHARE;
  return { frame: Math.min(n - 1, Math.floor(swing * n)), swing };
}
