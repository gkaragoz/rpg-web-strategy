import type { BattleConfig, SimEvent } from './battle';
import type { Units } from './units';

/** Unit fields read by the renderer (Units and the worker snapshot share the same shape). */
export type UnitsView = Pick<
  Units,
  'count' | 'kind' | 'team' | 'x' | 'y' | 'px' | 'py' | 'hp' | 'maxHp' | 'facing' | 'moving' | 'swing' | 'flash' | 'alive' | 'deathT' | 'status' | 'lift' | 'hgAdv'
>;

export interface ProjView {
  count: number;
  active: Uint8Array;
  sx: Float32Array;
  sy: Float32Array;
  tx: Float32Array;
  ty: Float32Array;
  t: Float32Array;
  dur: Float32Array;
  height: Float32Array;
  tag: Uint8Array;
}

export interface SimStats {
  steps: number;
  totalMs: number;
  maxMs: number;
  /** Accumulated time per phase (prep, grid, units, pick, separate, arrows). */
  prof: Record<string, number>;
  /** Behavior counters (kite, stuck, ...). */
  dbg: Record<string, number>;
}

export interface FrameInfo {
  /** Number of sim steps run on the MAIN thread this frame (0 with a worker). */
  steps: number;
  /** Time spent on the sim on the MAIN thread this frame. */
  mainSimMs: number;
  /** Interpolation ratio for rendering (0..1). */
  alpha: number;
}

export interface SimBackend {
  readonly kind: 'inline' | 'worker';
  readonly mapSize: number;
  readonly config: BattleConfig;
  readonly units: UnitsView;
  readonly projectiles: ProjView;
  readonly events: SimEvent[];
  readonly alivePerTeam: number[];
  winner: number;
  time: number;
  /** Called every render frame: advances the sim inline, binds the latest snapshot with a worker. */
  frame(dt: number): FrameInfo;
  reset(seed: number): Promise<void>;
  setSpeed(speed: number): void;
  setPaused(paused: boolean): void;
  resetStats(): void;
  stats(): SimStats;
  /** Terminates the worker / releases resources. */
  dispose(): void;
}

export type SimView = Pick<SimBackend, 'units' | 'projectiles' | 'mapSize'>;
