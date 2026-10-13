import type { FrameInfo, SimBackend, SimStats } from '../sim/backend';
import { Battle, DBG_KEYS, type BattleConfig, type SimEvent } from '../sim/battle';
import { SIM_DT } from '../sim/constants';
import type { OnlineModel } from './client';
import type { HostLobby } from './host';
import { LockstepRunner } from './lockstep';
import type { ClientMsg } from './protocol';

/**
 * Cevrimici savasin sim arka ucu: ana thread'de Battle + LockstepRunner. BattleScene bunu SimBackend olarak surer;
 * adim ilerletme host'a yetisme/bekleme ve kontrol toplami mantigini runner yurutur.
 */
export class LockstepSim implements SimBackend {
  readonly kind = 'inline' as const;
  readonly battle: Battle;
  readonly runner: LockstepRunner;
  private steps = 0;
  private totalMs = 0;
  private maxMs = 0;

  constructor(
    readonly config: BattleConfig,
    seed: number,
    model: OnlineModel,
    opts: { host?: HostLobby; send?: (m: ClientMsg) => void },
  ) {
    this.battle = new Battle(seed, config);
    this.runner = new LockstepRunner(this.battle, model, opts);
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
    const ran = this.runner.advance(dt);
    const ms = performance.now() - t0;
    if (ran > 0) {
      this.steps += ran;
      this.totalMs += ms;
      if (ms / ran > this.maxMs) this.maxMs = ms / ran;
    }
    return { steps: ran, mainSimMs: ms, alpha: this.runner.alpha };
  }

  async reset(): Promise<void> {
    /* cevrimicide yeniden baslatma yok */
  }
  setSpeed(speed: number): void {
    this.runner.speed = speed;
  }
  setPaused(paused: boolean): void {
    this.runner.paused = paused;
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

/** Sim adimi sabiti (disa aktarilir: runner ile ayni). */
export { SIM_DT };
