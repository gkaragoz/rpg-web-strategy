import type { Battle } from '../battle';
import { MAX_TEAMS } from '../units';

/**
 * Game modes: extra win conditions and goals on top of the normal fight. All modes are autonomous (no player orders during
 * a battle). 'classic', 'hill', 'vip' and 'ctf' have rules.
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
    }
  | {
      kind: 'vip';
      /**
       * One entry per team index (length = MAX_TEAMS; unused teams: unit -1, hp 0, alive false). `unit` is the VIP's unit
       * index (stable for the battle), `hp` its health fraction 0..1 (0 when dead), `alive` false once the team is out.
       */
      teams: Array<{ unit: number; hp: number; alive: boolean }>;
      /** Seconds of sim time left before the time limit decides the battle (VIP with the highest hp fraction wins). */
      timeLeft: number;
    }
  | {
      kind: 'ctf';
      /** Captures per team (index = team, length = MAX_TEAMS). */
      captures: number[];
      /** Captures needed to win. */
      target: number;
      /** Base pickup/capture radius in tiles (same for every base). */
      radius: number;
      /** One entry per team that has a flag, in team order. */
      flags: CtfFlagHud[];
      /** Seconds of sim time left before the time limit decides the battle (most captures wins). */
      timeLeft: number;
    };

/** One flag: `team` owns it; at home x/y is the base and carrier/carrierTeam are -1, in transit x/y is the carrier's position. */
export interface CtfFlagHud {
  team: number;
  x: number;
  y: number;
  carrier: number;
  carrierTeam: number;
}

/** Per-team VIP unit indices out of a mode HUD (length MAX_TEAMS, -1: none). Works for every backend that has `modeHud`. */
export function vipUnitsOf(hud: ModeHud): Int32Array {
  const out = new Int32Array(MAX_TEAMS).fill(-1);
  if (hud.kind === 'vip') for (let t = 0; t < MAX_TEAMS; t++) out[t] = hud.teams[t]?.unit ?? -1;
  return out;
}

/**
 * Rules of one mode instance (one per Battle). State must be plain numbers so it can go into Battle.serialize/restore/hash.
 */
export interface ModeRules {
  readonly id: GameModeId;
  /** Called at the end of Battle.reset (units are spawned, terrain exists). */
  init(b: Battle): void;
  /** Once per sim step, after the normal step logic and while the battle is undecided. */
  step(b: Battle, dt: number): void;
  /** Optional: called from killUnit after unit `j` died (`src` = killer unit or -1). Must not allocate. */
  onKill?(b: Battle, j: number, src: number): void;
  /**
   * Optional: per-unit override called from Battle.updateUnit after the stun/fear checks. Return true when the mode took
   * over unit `i` this step (it queued its own move); the normal AI is skipped. Must not allocate.
   */
  drive?(b: Battle, i: number, dt: number): boolean;
  /** Team index to end the battle with, -2 for a draw, undefined to go on. */
  winner(b: Battle): number | undefined;
  /** Mode state as plain numbers (restore() accepts exactly this). */
  serialize(): number[];
  restore(state: number[]): void;
  hud(b: Battle): ModeHud;
  /** Points per team for the result screen (undefined: the mode has no score). */
  scores(): number[] | undefined;
}
