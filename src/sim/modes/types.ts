import type { Battle } from '../battle';

/**
 * Game modes: extra win conditions and goals on top of the normal fight. All modes are autonomous (no player orders during
 * a battle). Only 'classic' and 'hill' have rules today; 'vip' and 'ctf' are accepted ids that fall back to classic rules.
 */
export type GameModeId = 'classic' | 'hill' | 'vip' | 'ctf';

/** Every mode id the lobby accepts (host-side validation uses this list). */
export const GAME_MODE_IDS: readonly GameModeId[] = ['classic', 'hill', 'vip', 'ctf'];

export function isGameModeId(v: unknown): v is GameModeId {
  return typeof v === 'string' && (GAME_MODE_IDS as readonly string[]).includes(v);
}

/** Control point owner values: a team index, or one of these. */
export const HILL_NEUTRAL = -1;
export const HILL_CONTESTED = -2;

export interface HillPointHud {
  x: number;
  y: number;
  radius: number;
  /** Team index, -1 neutral (nobody captured it yet), -2 contested (equal top counts inside the radius). */
  owner: number;
}

/** Pure data for the UI: what to draw/show for the running mode. */
export type ModeHud =
  | { kind: 'classic' }
  | {
      kind: 'hill';
      /** Points per team (index = team, length = MAX_TEAMS). */
      scores: number[];
      /** Points needed to win. */
      target: number;
      points: HillPointHud[];
      /** Seconds of sim time left before the time limit decides the battle. */
      timeLeft: number;
    };

/**
 * Rules of one mode instance (one per Battle). State must be plain numbers so it can go into Battle.serialize/restore/hash.
 */
export interface ModeRules {
  readonly id: GameModeId;
  /** Called at the end of Battle.reset (units are spawned, terrain exists). */
  init(b: Battle): void;
  /** Once per sim step, after the normal step logic and while the battle is undecided. */
  step(b: Battle, dt: number): void;
  /** Team index to end the battle with, -2 for a draw, undefined to go on. */
  winner(b: Battle): number | undefined;
  /** Mode state as plain numbers (restore() accepts exactly this). */
  serialize(): number[];
  restore(state: number[]): void;
  hud(b: Battle): ModeHud;
  /** Points per team for the result screen (undefined: the mode has no score). */
  scores(): number[] | undefined;
}
