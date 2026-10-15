import type { FrameInfo } from '../sim/backend';
import type { BattleConfig } from '../sim/battle';
import { I_LATEST, type Shared } from '../sim/shared';
import { WorkerSim } from '../sim/workerSim';
import type { WorkerCommand, WorkerEvent } from '../sim/worker';
import type { OnlineModel } from './client';
import { CHECK_EVERY, type HostLobby } from './host';
import { LockstepRunner, type SimLike } from './lockstep';
import type { ClientMsg } from './protocol';

/**
 * Online sim backend with the Battle running in a Web Worker (SharedArrayBuffer ring for rendering). The lockstep
 * runner stays on the main thread and decides how many steps to run each frame; the worker runs them in order, reports
 * the checkpoint hashes and serves/accepts snapshots. Result: the main thread only renders, like in solo play.
 */
export class LockstepWorkerSim extends WorkerSim {
  readonly runner: LockstepRunner;
  private queued = 0;
  private batch = 0;
  private hashCb: ((step: number, hash: number) => void) | null = null;
  private snapId = 0;
  private readonly snapWaiters = new Map<number, (r: { step: number; data: Uint8Array }) => void>();
  private frameAlpha = 1;

  static async createLockstep(config: BattleConfig, seed: number, model: OnlineModel, opts: { host?: HostLobby; send?: (m: ClientMsg) => void }): Promise<LockstepWorkerSim> {
    const { worker, sh, count, helpers } = await WorkerSim.spawn(config, seed, CHECK_EVERY);
    return new LockstepWorkerSim(config, worker, sh, count, helpers, model, opts);
  }

  private constructor(config: BattleConfig, worker: Worker, sh: Shared, count: number, helpers: Worker[], model: OnlineModel, opts: { host?: HostLobby; send?: (m: ClientMsg) => void }) {
    super(config, worker, sh, count, helpers);
    this.runner = new LockstepRunner(this.adapter(), model, opts);
  }

  /** What the runner drives: step() only counts and batches; the worker does the real stepping. */
  private adapter(): SimLike {
    const me = this;
    return {
      dt: me.stepDt,
      step: () => {
        me.queued++;
        me.batch++;
      },
      get stepCount() {
        return me.queued;
      },
      get pending() {
        return me.queued - Atomics.load(me.sh.ctrlI, I_LATEST);
      },
      hash: () => 0,
      serialize: () => {
        throw new Error('snapshots are asynchronous with a worker sim');
      },
      restore: () => {
        throw new Error('snapshots are asynchronous with a worker sim');
      },
      get winner() {
        return me.winner;
      },
      get alivePerTeam() {
        return me.alivePerTeam;
      },
      get scores() {
        return me.scores;
      },
      onHash: (cb) => {
        me.hashCb = cb;
      },
      restorePacked: (data, step) => {
        me.queued = step;
        me.batch = 0;
        me.worker.postMessage({ type: 'restore', data } satisfies WorkerCommand, [data.buffer]);
      },
      snapshotPacked: () =>
        new Promise((resolve) => {
          const id = ++me.snapId;
          me.snapWaiters.set(id, resolve);
          me.worker.postMessage({ type: 'snapshot', id } satisfies WorkerCommand);
        }),
    };
  }

  protected override onExtra(m: WorkerEvent): void {
    if (m.type === 'hash') this.hashCb?.(m.step, m.hash);
    else if (m.type === 'snapshot') {
      this.snapWaiters.get(m.id)?.({ step: m.step, data: m.data });
      this.snapWaiters.delete(m.id);
    }
  }

  override frame(dt: number): FrameInfo {
    this.batch = 0;
    const ran = this.runner.advance(dt);
    if (this.batch > 0) this.worker.postMessage({ type: 'steps', n: this.batch } satisfies WorkerCommand);
    this.frameAlpha = this.runner.alpha;
    super.frame();
    return { steps: ran, mainSimMs: 0, alpha: this.frameAlpha };
  }

  // The runner owns speed and pause online.
  override setSpeed(speed: number): void {
    this.runner.speed = speed;
  }
  override setPaused(paused: boolean): void {
    this.runner.paused = paused;
  }
  override reset(): Promise<void> {
    return Promise.resolve();
  }
  override resetStats(): void {
    this.worker.postMessage({ type: 'resetStats' } satisfies WorkerCommand);
  }
}
