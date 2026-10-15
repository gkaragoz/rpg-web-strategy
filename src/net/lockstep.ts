import { packSnapshot, unpackSnapshot, unwire, unwireRaw, wireIsCompressed, wireRaw, type BattleSnapshot } from '../sim/snapshot';
import { CHECK_EVERY, type HostLobby } from './host';
import type { OnlineModel } from './client';
import { b64decode, b64encode, type ClientMsg } from './protocol';

/** The sim surface lockstep needs (Battle provides it; a worker wrapper could too). */
export interface SimLike {
  step(dt: number): void;
  /** Seconds per simulation step. */
  readonly dt: number;
  readonly stepCount: number;
  hash(): number;
  serialize(): BattleSnapshot;
  restore(s: BattleSnapshot): void;
  readonly winner: number;
  readonly alivePerTeam: number[];
  /** Game mode points per team (hill), sent with the result; undefined for classic. */
  readonly scores?: number[];
  /** Worker-backed sims: steps handed to the worker that it has not finished yet (the runner stops queuing when it falls behind). */
  readonly pending?: number;
  /** Worker-backed sims report the checkpoint hashes asynchronously through this callback (instead of hash()). */
  onHash?(cb: (step: number, hash: number) => void): void;
  /** Worker-backed sims restore a snapshot in wire form (taken at `step`) without unpacking it on the main thread. */
  restorePacked?(data: Uint8Array, step: number): void;
  /** Worker-backed sims take snapshots asynchronously. */
  snapshotPacked?(): Promise<{ step: number; data: Uint8Array }>;
}

const MAX_STEPS_PER_FRAME = 8;
/** With a worker sim: do not queue more than this many unfinished steps (a slow machine slows down instead of lagging further and further behind). */
const MAX_PENDING = 12;
/** When the gap between the host step and the local step exceeds this, catching up / waiting kicks in. */
const LAG_TOLERANCE = 3;
/** Interval (steps) at which the host broadcasts its step info. */
const TICK_EVERY = 15;

/**
 * Time driver of the deterministic battle: the host runs at its own pace and broadcasts step/speed/pause info;
 * a guest catches up with or waits for the host's step, sends hashes at checkpoints, and loads a state snapshot on divergence.
 */
export class LockstepRunner {
  private acc = 0;
  private finished = false;
  private tickAt = 0;
  /** Host: local speed/pause (speed buttons). Read from the model on a guest. */
  speed = 1;
  paused = false;
  /** Diagnostics: number of resyncs so far. */
  resyncs = 0;
  /** Step fraction for render interpolation (0..1). */
  get alpha(): number {
    return this.paused || (!this.opts.host && this.model.paused) ? 1 : Math.min(1, this.acc / this.sim.dt);
  }

  constructor(
    readonly sim: SimLike,
    private readonly model: OnlineModel,
    private readonly opts: { host?: HostLobby; send?: (m: ClientMsg) => void; now?: () => number },
  ) {
    if (opts.host) {
      const host = opts.host;
      host.simProvider = {
        snapshot: () =>
          sim.snapshotPacked
            ? sim.snapshotPacked().then((r) => ({ step: r.step, data: b64encode(r.data) }))
            : { step: sim.stepCount, data: b64encode(wireRaw(packSnapshot(sim.serialize()))) },
      };
    }
    sim.onHash?.((step, hash) => {
      if (opts.host) opts.host.recordHash(step, hash);
      else opts.send?.({ t: 'check', step, hash });
    });
  }

  private now(): number {
    return (this.opts.now ?? (() => Date.now()))();
  }

  /** Called once per rendered frame (dt in seconds); returns the number of sim steps run. */
  advance(dt: number): number {
    const host = this.opts.host;
    // Guest: pending resync.
    const rs = this.model.pendingResync;
    if (!host && rs) {
      this.model.pendingResync = null;
      try {
        const wire = b64decode(rs.data);
        if (this.sim.restorePacked) this.sim.restorePacked(wire, rs.step);
        else if (wireIsCompressed(wire)) {
          // A compressed snapshot (from a worker host) needs the async gunzip; the sim keeps running until it is applied.
          void unwire(wire).then((raw) => {
            this.sim.restore(unpackSnapshot(raw));
            this.acc = 0;
            this.resyncs++;
          });
        } else this.sim.restore(unpackSnapshot(unwireRaw(wire)));
        this.resyncs++;
      } catch (e) {
        console.warn('[lockstep] snapshot ignored', e); // a bad snapshot must not end the battle for this player
      }
      this.acc = 0;
    }
    const speed = host ? this.speed : this.model.speed;
    const paused = host ? this.paused : this.model.paused;
    if (paused) {
      // When the host pauses (or its tab goes to the background), guests must not run ahead on the estimated step:
      // the paused state is broadcast periodically.
      if (host) {
        const t = this.now();
        if (t - this.tickAt >= 250) {
          this.tickAt = t;
          host.broadcastTick(this.sim.stepCount, this.speed, true);
        }
      }
      return 0;
    }
    this.acc += Math.min(dt, 0.1) * speed;
    let n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this.acc / this.sim.dt));
    this.acc -= Math.floor(this.acc / this.sim.dt) * this.sim.dt;
    if (!host && this.model.hostStep >= 0) {
      // Host step estimate: last tick + elapsed time.
      // The estimate advances at most 1.5 s: if the host goes silent (background tab, dropped network) the guest must not run forever.
      const est = this.model.hostStep + Math.round((Math.min(1500, this.now() - this.model.hostStepAt) / 1000) / this.sim.dt * speed);
      const lag = est - this.sim.stepCount;
      if (lag > LAG_TOLERANCE) n = Math.min(MAX_STEPS_PER_FRAME, Math.max(n, lag - 1));
      else if (lag < -LAG_TOLERANCE) n = 0;
    }
    if (this.sim.pending !== undefined) n = Math.min(n, Math.max(0, MAX_PENDING - this.sim.pending));
    let ran = 0;
    for (let i = 0; i < n && this.sim.winner === -1; i++) {
      this.sim.step(this.sim.dt);
      ran++;
      const step = this.sim.stepCount;
      if (!this.sim.onHash && step % CHECK_EVERY === 0) {
        if (host) host.recordHash(step, this.sim.hash());
        else this.opts.send?.({ t: 'check', step, hash: this.sim.hash() });
      }
    }
    if (host) {
      const t = this.now();
      if (t - this.tickAt >= 250 || this.sim.stepCount % TICK_EVERY === 0) {
        this.tickAt = t;
        host.broadcastTick(this.sim.stepCount, this.speed, this.paused);
      }
      if (this.sim.winner !== -1 && !this.finished) {
        this.finished = true;
        host.finish(this.sim.winner, this.sim.alivePerTeam.slice(0, 6), this.sim.scores?.slice(0, 6));
      }
    }
    return ran;
  }
}
