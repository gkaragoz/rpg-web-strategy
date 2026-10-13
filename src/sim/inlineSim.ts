import type { FrameInfo, SimBackend, SimStats } from './backend';
import { Battle, DBG_KEYS, type BattleConfig, type SimEvent } from './battle';
import { SIM_DT } from './constants';

const MAX_STEPS_PER_FRAME = 5;
/** Per-frame sim budget in bench mode: if exceeded, the sim slows down while rendering stays smooth. */
const SIM_BUDGET_MS = 12;

/** Runs the sim on the main thread (for comparison and for environments without workers). */
export class InlineSim implements SimBackend {
  readonly kind = 'inline' as const;
  /** Debugging: direct Battle access and a hook called after every step. */
  readonly battle: Battle;
  onStep: (() => void) | null = null;
  private acc = 0;
  private speed = 1;
  private paused = false;
  private steps = 0;
  private totalMs = 0;
  private maxMs = 0;

  constructor(
    readonly config: BattleConfig,
    seed: number,
  ) {
    this.battle = new Battle(seed, config);
  }

  get mapSize(): number {
    return this.battle.mapSize;
  }
  get units() {
    return this.battle.units;
  }
  get projectiles() {
    return this.battle.projectiles;
  }
  get meter() {
    return this.battle.meter;
  }
  get events(): SimEvent[] {
    return this.battle.events;
  }
  get alivePerTeam(): number[] {
    return this.battle.alivePerTeam;
  }
  get winner(): number {
    return this.battle.winner;
  }
  set winner(v: number) {
    this.battle.winner = v;
  }
  get time(): number {
    return this.battle.time;
  }
  set time(v: number) {
    this.battle.time = v;
  }

  frame(dt: number): FrameInfo {
    const t0 = performance.now();
    let steps = 0;
    if (!this.paused) {
      this.acc += dt * this.speed;
      const bench = this.config.mode === 'bench';
      while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
        const s0 = performance.now();
        this.battle.step(SIM_DT);
        this.onStep?.();
        const ms = performance.now() - s0;
        this.totalMs += ms;
        this.steps++;
        if (ms > this.maxMs) this.maxMs = ms;
        this.acc -= SIM_DT;
        steps++;
        if (bench && performance.now() - t0 > SIM_BUDGET_MS) break;
      }
      // If the sim cannot keep up, drop the accumulated time: the sim slows down but frames stay smooth.
      if (this.acc > SIM_DT && (bench || steps === MAX_STEPS_PER_FRAME)) this.acc = 0;
    }
    return {
      steps,
      mainSimMs: performance.now() - t0,
      alpha: this.paused ? 1 : Math.min(1, this.acc / SIM_DT),
    };
  }

  async reset(seed: number): Promise<void> {
    this.battle.reset(seed);
    this.acc = 0;
    this.resetStats();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  resetStats(): void {
    this.steps = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    const p = this.battle.prof;
    p.prep = p.grid = p.units = p.pick = p.separate = p.arrows = p.steps = 0;
    for (const k of DBG_KEYS) this.battle.dbg[k] = 0;
  }

  dispose(): void {}

  stats(): SimStats {
    return { steps: this.steps, totalMs: this.totalMs, maxMs: this.maxMs, prof: { ...this.battle.prof }, dbg: { ...this.battle.dbg } };
  }
}
