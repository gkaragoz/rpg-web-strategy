import type { FrameInfo, MeterView, ProjView, SimBackend, SimStats, UnitsView } from './backend';
import { DBG_KEYS, mapSizeFor, projectileCapacity, unitCapacity, type BattleConfig, type SimEvent } from './battle';
import { THREADS_MIN_UNITS, armySize, simDtFor } from './constants';
import { quitHelpers } from './movePool';
import type { ModeHud } from './modes';
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
  readModeHud,
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

/** Control buffer of each helper set (from the setup message): lets the page wake the helpers so they exit before they are terminated. */
const helperCtrl = new WeakMap<Worker[], SharedArrayBuffer>();

/** Terminates the helpers; they are woken first, otherwise a helper blocked in Atomics.wait lingers for Blink's 2 s forced-termination delay. */
function killHelpers(helpers: Worker[]): void {
  const ctrl = helperCtrl.get(helpers);
  if (ctrl) quitHelpers(ctrl);
  for (const h of helpers) h.terminate();
}

/**
 * Helper threads for the movement phase of big battles: `?threads=N` forces a number (0 = off), otherwise a share of the
 * cores. Results never depend on this number, so every player of an online match may use a different one.
 */
export function helperThreads(): number {
  try {
    const q = new URLSearchParams(location.search).get('threads');
    if (q !== null) return Math.max(0, Math.min(7, parseInt(q, 10) || 0));
  } catch {
    /* no location (tests) */
  }
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return hc >= 8 ? 3 : hc >= 6 ? 2 : hc >= 4 ? 1 : 0;
}

/** Runs the sim in a Web Worker; reads the state from a SharedArrayBuffer ring buffer. */
export class WorkerSim implements SimBackend {
  readonly kind = 'worker' as const;
  readonly mapSize: number;
  readonly stepDt: number;
  readonly events: SimEvent[] = [];
  readonly alivePerTeam: number[] = [0, 0, 0, 0, 0, 0];
  winner = -1;
  time = 0;
  readonly units: UnitsView;
  readonly projectiles: ProjView;
  readonly meter: MeterView;
  /** Display data of the game mode (hill scores and control points, vip teams), refreshed with every frame(). */
  modeHud: ModeHud = { kind: 'classic' };
  /** Points per team of the mode, or undefined for classic. */
  get scores(): number[] | undefined {
    const h = this.modeHud;
    if (h.kind === 'hill') return h.scores.slice(0, this.alivePerTeam.length);
    return h.kind === 'ctf' ? h.captures.slice(0, this.alivePerTeam.length) : undefined;
  }
  protected readonly worker: Worker;
  protected readonly sh: Shared;
  private pendingReset: ((count: number) => void) | null = null;

  protected constructor(
    readonly config: BattleConfig,
    worker: Worker,
    sh: Shared,
    count: number,
    protected readonly helpers: Worker[] = [],
  ) {
    this.worker = worker;
    this.sh = sh;
    this.mapSize = mapSizeFor(config);
    this.stepDt = simDtFor(config);
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
      else if (m.type === 'log') console.warn('[sim worker]', m.msg);
      else if (m.type === 'helpers') {
        helperCtrl.set(helpers, m.init.ctrl);
        for (const h of helpers) h.postMessage(m.init);
      }
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
    const { worker, sh, count, helpers } = await WorkerSim.spawn(config, seed);
    return new WorkerSim(config, worker, sh, count, helpers);
  }

  /** Starts the worker (self-timed solo loop, or lockstep mode when `lockCheckEvery` is given) and waits until it is ready. */
  protected static async spawn(config: BattleConfig, seed: number, lockCheckEvery = 0): Promise<{ worker: Worker; sh: Shared; count: number; helpers: Worker[] }> {
    const sab = allocShared(unitCapacity(config), projectileCapacity(config));
    const sh = bindShared(sab, unitCapacity(config), projectileCapacity(config));
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    // Movement helpers are created here (a worker blocked in Atomics.wait cannot start nested workers); the sim worker
    // sends their setup message through us once its battle exists.
    const n = armySize(config) >= THREADS_MIN_UNITS && typeof SharedArrayBuffer !== 'undefined' ? helperThreads() : 0;
    const helpers: Worker[] = Array.from({ length: n }, () => new Worker(new URL('./moverWorker.ts', import.meta.url), { type: 'module' }));
    let count: number;
    try {
      count = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sim worker did not start')), 15000);
        worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
          if (e.data.type === 'log') console.warn('[sim worker]', e.data.msg);
          if (e.data.type === 'helpers') {
            helperCtrl.set(helpers, e.data.init.ctrl);
            for (const h of helpers) h.postMessage(e.data.init);
          }
          if (e.data.type === 'ready') {
            clearTimeout(timer);
            resolve(e.data.count);
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(`sim worker error: ${e.message}`));
        };
        const threads = n;
        worker.postMessage((lockCheckEvery > 0 ? { type: 'initLock', sab, config, seed, checkEvery: lockCheckEvery, threads } : { type: 'init', sab, config, seed, threads }) satisfies WorkerCommand);
      });
    } catch (err) {
      worker.terminate(); // never leave a half-started worker running
      killHelpers(helpers);
      throw err;
    }
    worker.onerror = (e) => console.error('[sim worker]', e.message);
    return { worker, sh, count, helpers };
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
    this.modeHud = readModeHud(f);

    // Interpolate using the real interval between the last two publishes: one step behind but smooth.
    const interval = Math.max(1, f[F_PUBLISH] - f[F_PREV_PUBLISH]);
    const now = performance.timeOrigin + performance.now();
    const alpha = Math.min(1, Math.max(0, (now - f[F_PUBLISH]) / Math.min(interval, this.stepDt * 1000 * 4)));
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
    killHelpers(this.helpers);
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
