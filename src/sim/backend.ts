import type { BattleConfig, SimEvent } from './battle';
import type { Units } from './units';

/** Renderer'in okudugu birim alanlari (Units ve worker anlik goruntusu ayni sekli tasir). */
export type UnitsView = Pick<
  Units,
  'count' | 'kind' | 'team' | 'x' | 'y' | 'px' | 'py' | 'hp' | 'maxHp' | 'facing' | 'moving' | 'swing' | 'flash' | 'alive' | 'deathT' | 'status'
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
}

export interface SimStats {
  steps: number;
  totalMs: number;
  maxMs: number;
  /** Faz bazli birikimli sure (prep, grid, units, pick, separate, arrows). */
  prof: Record<string, number>;
  /** Davranis sayaclari (kite, sikisma, ...). */
  dbg: Record<string, number>;
}

export interface FrameInfo {
  /** Bu karede ANA thread'de calisan sim adimi sayisi (worker'da 0). */
  steps: number;
  /** Bu karede ANA thread'de sim'e harcanan sure. */
  mainSimMs: number;
  /** Render icin interpolasyon orani (0..1). */
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
  /** Her render karesinde cagrilir: inline'da sim'i ilerletir, worker'da son goruntuyu baglar. */
  frame(dt: number): FrameInfo;
  reset(seed: number): Promise<void>;
  setSpeed(speed: number): void;
  setPaused(paused: boolean): void;
  resetStats(): void;
  stats(): SimStats;
  /** Worker'i sonlandirir / kaynaklari birakir. */
  dispose(): void;
}

export type SimView = Pick<SimBackend, 'units' | 'projectiles' | 'mapSize'>;
