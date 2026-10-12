import type { FrameInfo, SimBackend, SimStats } from './backend';
import { Battle, type BattleConfig, type SimEvent } from './battle';
import { SIM_DT } from './constants';

const MAX_STEPS_PER_FRAME = 5;
/** Bench modunda kare basina sim butcesi: asilirsa sim yavaslar, render akici kalir. */
const SIM_BUDGET_MS = 12;

/** Sim'i ana thread'de calistirir (karsilastirma ve worker'siz ortam icin). */
export class InlineSim implements SimBackend {
  readonly kind = 'inline' as const;
  private readonly battle: Battle;
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
  get events(): SimEvent[] {
    return this.battle.events;
  }
  get alivePerTeam(): [number, number] {
    return this.battle.alivePerTeam as [number, number];
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
        const ms = performance.now() - s0;
        this.totalMs += ms;
        this.steps++;
        if (ms > this.maxMs) this.maxMs = ms;
        this.acc -= SIM_DT;
        steps++;
        if (bench && performance.now() - t0 > SIM_BUDGET_MS) break;
      }
      // Sim yetisemiyorsa birikmis zamani at: sim yavaslar ama kareler akici kalir.
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
  }

  stats(): SimStats {
    return { steps: this.steps, totalMs: this.totalMs, maxMs: this.maxMs, prof: { ...this.battle.prof } };
  }
}
