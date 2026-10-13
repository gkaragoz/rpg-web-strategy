import type { FrameInfo, MeterView, ProjView, SimBackend, SimStats, UnitsView } from './backend';
import { DBG_KEYS, mapSizeFor, projectileCapacity, unitCapacity, type BattleConfig, type SimEvent } from './battle';
import { SIM_DT } from './constants';
import {
  F_ALIVE_BASE,
  F_DBG,
  F_MAX_MS,
  F_PREV_PUBLISH,
  F_PROF,
  F_PUBLISH,
  F_SIM_TIME,
  F_STEPS,
  F_TOTAL_MS,
  F_WINNER,
  I_COUNT,
  I_LATEST,
  I_PCOUNT,
  METER_DMG_LEN,
  PROF_KEYS,
  SNAP_SLOTS,
  allocShared,
  bindShared,
  type Shared,
} from './shared';
import type { WorkerCommand, WorkerEvent } from './worker';

/** Runs the sim in a Web Worker; reads the state from a SharedArrayBuffer ring buffer. */
export class WorkerSim implements SimBackend {
  readonly kind = 'worker' as const;
  readonly mapSize: number;
  readonly events: SimEvent[] = [];
  readonly alivePerTeam: number[] = [0, 0, 0, 0, 0, 0];
  winner = -1;
  time = 0;
  readonly units: UnitsView;
  readonly projectiles: ProjView;
  readonly meter: MeterView;
  protected readonly worker: Worker;
  protected readonly sh: Shared;
  private pendingReset: ((count: number) => void) | null = null;

  protected constructor(
    readonly config: BattleConfig,
    worker: Worker,
    sh: Shared,
    count: number,
  ) {
    this.worker = worker;
    this.sh = sh;
    this.mapSize = mapSizeFor(config);
    this.meter = { dmg: sh.meter.subarray(0, METER_DMG_LEN), kills: sh.meter.subarray(METER_DMG_LEN) };
    const s0 = sh.slots[0];
    this.units = {
      count,
      kind: sh.kind,
      team: sh.team,
      maxHp: sh.maxHp,
      x: s0.x,
      y: s0.y,
      px: s0.x,
      py: s0.y,
      hp: s0.hp,
      facing: s0.facing,
      moving: s0.moving,
      swing: s0.swing,
      flash: s0.flash,
      alive: s0.alive,
      deathT: s0.deathT,
      status: s0.status,
      lift: s0.lift,
      hgAdv: s0.hgAdv,
    };
    this.projectiles = {
      count: 0,
      active: sh.pActive,
      sx: s0.pSx,
      sy: s0.pSy,
      tx: s0.pTx,
      ty: s0.pTy,
      t: s0.pT,
      dur: s0.pDur,
      height: s0.pH,
      tag: s0.pTag,
    };
    worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
      const m = e.data;
      if (m.type === 'events') this.events.push(...m.events);
      else if (m.type === 'hash' || m.type === 'snapshot') this.onExtra(m);
      else if (m.type === 'reset') {
        // Events the worker sent before this reset belong to the old battle.
        this.events.length = 0;
        this.units.count = m.count;
        this.pendingReset?.(m.count);
        this.pendingReset = null;
      }
    };
  }

  /** Hook for the lockstep subclass (hash / snapshot replies). */
  protected onExtra(_m: WorkerEvent): void {}

  static async create(config: BattleConfig, seed: number): Promise<WorkerSim> {
    const { worker, sh, count } = await WorkerSim.spawn(config, seed);
    return new WorkerSim(config, worker, sh, count);
  }

  /** Starts the worker (self-timed solo loop, or lockstep mode when `lockCheckEvery` is given) and waits until it is ready. */
  protected static async spawn(config: BattleConfig, seed: number, lockCheckEvery = 0): Promise<{ worker: Worker; sh: Shared; count: number }> {
    const sab = allocShared(unitCapacity(config), projectileCapacity(config));
    const sh = bindShared(sab, unitCapacity(config), projectileCapacity(config));
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let count: number;
    try {
      count = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sim worker did not start')), 15000);
        worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
          if (e.data.type === 'ready') {
            clearTimeout(timer);
            resolve(e.data.count);
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(`sim worker error: ${e.message}`));
        };
        worker.postMessage((lockCheckEvery > 0 ? { type: 'initLock', sab, config, seed, checkEvery: lockCheckEvery } : { type: 'init', sab, config, seed }) satisfies WorkerCommand);
      });
    } catch (err) {
      worker.terminate(); // never leave a half-started worker running
      throw err;
    }
    worker.onerror = (e) => console.error('[sim worker]', e.message);
    return { worker, sh, count };
  }

  frame(_dt?: number): FrameInfo {
    const sh = this.sh;
    const latest = Atomics.load(sh.ctrlI, I_LATEST);
    const cur = latest % SNAP_SLOTS;
    const prev = latest > 0 ? (latest - 1) % SNAP_SLOTS : cur;
    const c = sh.slots[cur];
    const p = sh.slots[prev];
    const u = this.units;
    u.x = c.x;
    u.y = c.y;
    u.px = p.x;
    u.py = p.y;
    u.hp = c.hp;
    u.facing = c.facing;
    u.moving = c.moving;
    u.swing = c.swing;
    u.flash = c.flash;
    u.alive = c.alive;
    u.deathT = c.deathT;
    u.status = c.status;
    u.lift = c.lift;
    u.hgAdv = c.hgAdv;
    u.count = sh.ctrlI[I_COUNT];

    const pr = this.projectiles;
    pr.count = sh.ctrlI[I_PCOUNT + cur];
    pr.sx = c.pSx;
    pr.sy = c.pSy;
    pr.tx = c.pTx;
    pr.ty = c.pTy;
    pr.t = c.pT;
    pr.dur = c.pDur;
    pr.height = c.pH;
    pr.tag = c.pTag;

    const f = sh.ctrlF;
    this.winner = f[F_WINNER];
    this.time = f[F_SIM_TIME];
    for (let tm = 0; tm < this.alivePerTeam.length; tm++) this.alivePerTeam[tm] = f[F_ALIVE_BASE + tm];

    // Interpolate using the real interval between the last two publishes: one step behind but smooth.
    const interval = Math.max(1, f[F_PUBLISH] - f[F_PREV_PUBLISH]);
    const now = performance.timeOrigin + performance.now();
    const alpha = Math.min(1, Math.max(0, (now - f[F_PUBLISH]) / Math.min(interval, SIM_DT * 1000 * 4)));
    return { steps: 0, mainSimMs: 0, alpha };
  }

  reset(seed: number): Promise<void> {
    return new Promise((resolve) => {
      this.pendingReset = () => resolve();
      this.worker.postMessage({ type: 'reset', seed } satisfies WorkerCommand);
    });
  }

  setSpeed(speed: number): void {
    this.worker.postMessage({ type: 'speed', speed } satisfies WorkerCommand);
  }

  setPaused(paused: boolean): void {
    this.worker.postMessage({ type: 'pause', paused } satisfies WorkerCommand);
  }

  resetStats(): void {
    this.worker.postMessage({ type: 'resetStats' } satisfies WorkerCommand);
  }

  dispose(): void {
    // A reset still waiting for its reply would hang forever once the worker is gone.
    this.pendingReset?.(0);
    this.pendingReset = null;
    this.worker.terminate();
  }

  stats(): SimStats {
    const f = this.sh.ctrlF;
    const prof: Record<string, number> = {};
    PROF_KEYS.forEach((k, i) => (prof[k] = f[F_PROF + i]));
    const dbg: Record<string, number> = {};
    DBG_KEYS.forEach((k, i) => (dbg[k] = f[F_DBG + i]));
    return { steps: f[F_STEPS], totalMs: f[F_TOTAL_MS], maxMs: f[F_MAX_MS], prof, dbg };
  }
}
