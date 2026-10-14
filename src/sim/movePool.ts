import type { BattleConfig } from './battle';
import { chunkSize } from './mover';
import type { Units } from './units';

/** Control block (Int32 slots) shared by the sim thread and the helpers. */
export const C_GEN = 0; // generation: bumped to start a phase
export const C_NEXT = 1; // (phase tag << 16) | next chunk to take
export const C_FIN = 2; // chunks of the current phase that are finished
export const C_COUNT = 3; // unit count
export const C_STEP = 4; // step number
export const C_LOS = 5; // line-of-sight interval
export const C_QUIT = 6;
export const C_READY = 7; // helpers that finished their setup (each takes the next index)
export const C_PHASE = 9; // which kernel the current phase runs (PH_*)
export const C_MASK = 10; // bit mask of the teams that are alive
export const C_SEPPH = 11; // separation turn (step % SEP_STRIDE)
export const C_UNITS = 12; // number of units
export const C_LEN = 14;
/** Float64 params. */
export const F_DT = 0;
export const F_BRAKE = 1;
export const F_GAIN = 2;
export const F_MAXSTEP = 3;
export const F_DECAY = 4;
export const F_LEN = 6;

/** Kernels that can run on helper threads. */
export const PH_MOVE = 0;
export const PH_PICK = 1;
export const PH_SEP_SCAN = 2;
export const PH_SEP_APPLY = 3;
export const PH_GRID = 4;

/** Units per chunk of a phase (the grid phase hands out one grid per chunk). */
export function phaseChunk(phase: number, count: number): number {
  return phase === PH_GRID ? 1 : chunkSize(count);
}

/** Per-step inputs of the kernels, written once per step by the sim thread. */
export interface StepParams {
  dt: number;
  step: number;
  losEvery: number;
  brakeK: number;
  aliveMask: number;
  sepPhase: number;
  gain: number;
  maxStep: number;
  decay: number;
}

/** Message that sets a helper up (sent by the page: helpers are created there, see WorkerSim). */
export interface HelperInit {
  type: 'init';
  units: Record<string, SharedArrayBuffer>;
  cap: number;
  config: BattleConfig;
  rageA: number;
  ctrl: SharedArrayBuffer;
  fctrl: SharedArrayBuffer;
  counts: SharedArrayBuffer;
  /** Team grids (index = team) followed by the separation grid. */
  grids: Array<{ cell: number; cols: number; start: SharedArrayBuffer; items: SharedArrayBuffer }>;
  teamCount: number;
}

/** Takes the next chunk of the phase with this tag; -1 when the phase is over (or a later one has begun). */
export function takeChunk(c: Int32Array, tag: number, chunks: number): number {
  for (;;) {
    const v = Atomics.load(c, C_NEXT);
    if (v >>> 16 !== tag) return -1;
    const k = v & 0xffff;
    if (k >= chunks) return -1;
    if (Atomics.compareExchange(c, C_NEXT, v, v + 1) === v) return k;
  }
}

/** Moves the unit arrays into SharedArrayBuffers (in place, contents kept) and returns the buffers by field name. */
export function shareUnitArrays(units: Units): Record<string, SharedArrayBuffer> {
  const bufs: Record<string, SharedArrayBuffer> = {};
  const rec = units as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(units)) {
    if (!ArrayBuffer.isView(v) || v instanceof DataView) continue;
    const view = v as ArrayBufferView & { constructor: new (b: ArrayBufferLike) => unknown };
    if (view.buffer instanceof SharedArrayBuffer) {
      bufs[k] = view.buffer;
      continue;
    }
    const sab = new SharedArrayBuffer(view.byteLength);
    new Uint8Array(sab).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    rec[k] = new view.constructor(sab);
    bufs[k] = sab;
  }
  return bufs;
}

/**
 * The movement phase on several threads. The units' typed arrays live in SharedArrayBuffers; the sim thread and the helpers
 * take chunks (the same chunk boundaries whatever the number of threads) from a shared counter. A chunk is moved by one
 * thread in index order, so the result is the same as on one thread. Helpers are Web Workers created by the page (a worker
 * that blocks in Atomics.wait cannot start nested workers); they announce themselves through C_READY, and until they have
 * the sim thread simply does all chunks itself.
 */
export class MovePool {
  readonly ctrl = new Int32Array(new SharedArrayBuffer(C_LEN * 4));
  readonly fctrl = new Float64Array(new SharedArrayBuffer(F_LEN * 8));
  readonly counts = new Int32Array(new SharedArrayBuffer(4 * 4));
  /** A helper failed (or did not answer in time): the sim thread does all the chunks itself from now on. */
  broken = false;

  constructor(
    units: Units,
    config: BattleConfig,
    rageA: number,
    /** Number of helpers the page was asked to start. */
    readonly expected: number,
    /** Hands the setup message to the page, which forwards it to the helpers. */
    post: (init: HelperInit) => void,
    grids: Array<{ cell: number; cols: number; start: SharedArrayBuffer; items: SharedArrayBuffer }>,
    teamCount: number,
    readonly log: (msg: string) => void = (m) => console.warn('[move pool]', m),
  ) {
    const bufs = shareUnitArrays(units);
    post({ type: 'init', units: bufs, cap: units.cap, config, rageA, ctrl: this.ctrl.buffer as SharedArrayBuffer, fctrl: this.fctrl.buffer as SharedArrayBuffer, counts: this.counts.buffer as SharedArrayBuffer, grids, teamCount });
  }

  /** Helpers that are set up and waiting. */
  get size(): number {
    return Atomics.load(this.ctrl, C_READY);
  }

  /** Publishes the per-step inputs of the kernels (call once per step, before the phases). */
  setStep(p: StepParams): void {
    const c = this.ctrl;
    Atomics.store(c, C_STEP, p.step);
    Atomics.store(c, C_LOS, p.losEvery);
    Atomics.store(c, C_MASK, p.aliveMask);
    Atomics.store(c, C_SEPPH, p.sepPhase);
    this.fctrl[F_DT] = p.dt;
    this.fctrl[F_BRAKE] = p.brakeK;
    this.fctrl[F_GAIN] = p.gain;
    this.fctrl[F_MAXSTEP] = p.maxStep;
    this.fctrl[F_DECAY] = p.decay;
  }

  /**
   * Runs the chunks of one phase (kernel `phase`) on all available threads; `runChunk` is the sim thread's own kernel. Chunks are
   * handed out through C_NEXT, which carries the phase's tag: a helper that wakes up late (after the phase is over) cannot take
   * a chunk of a later phase with stale inputs. The sim thread returns when every chunk is finished; it never waits for a
   * helper that has not started a chunk.
   */
  run(phase: number, count: number, units: number, runChunk: (from: number, to: number, k: number) => void): void {
    const c = this.ctrl;
    const size = phaseChunk(phase, count);
    const chunks = Math.ceil(count / size);
    if (this.broken || Atomics.load(c, C_READY) === 0) {
      for (let k = 0; k < chunks; k++) runChunk(k * size, Math.min(count, (k + 1) * size), k);
      return;
    }
    Atomics.store(c, C_COUNT, count);
    Atomics.store(c, C_PHASE, phase);
    Atomics.store(c, C_UNITS, units);
    const gen = (Atomics.load(c, C_GEN) + 1) | 0;
    const tag = gen & 0xffff;
    Atomics.store(c, C_FIN, 0);
    Atomics.store(c, C_NEXT, tag << 16);
    Atomics.store(c, C_GEN, gen);
    Atomics.notify(c, C_GEN);
    for (;;) {
      const k = takeChunk(c, tag, chunks);
      if (k < 0) break;
      runChunk(k * size, Math.min(count, (k + 1) * size), k);
      Atomics.add(c, C_FIN, 1);
    }
    // Chunks a helper took are still running: wait for them (a helper that stalls inside a chunk is given up on).
    const t0 = Date.now();
    for (;;) {
      const f = Atomics.load(c, C_FIN);
      if (f >= chunks) break;
      if (Date.now() - t0 > 2000) {
        this.broken = true;
        this.log('a movement helper did not finish its chunk within 2 s: continuing on one thread');
        this.stop();
        break;
      }
      Atomics.wait(c, C_FIN, f, 20);
    }
  }

  /** Tells the helpers to exit (the page terminates them). */
  stop(): void {
    quitHelpers(this.ctrl);
  }
}

/**
 * Wakes the helpers of a pool and tells them to leave their loop. The page calls this (with `HelperInit.ctrl`) right before it
 * terminates them: a worker blocked in Atomics.wait only dies after Blink's 2 s forced-termination delay, a worker that returned
 * from `runHelper` dies at once.
 */
export function quitHelpers(ctrl: Int32Array | SharedArrayBuffer): void {
  const c = ctrl instanceof Int32Array ? ctrl : new Int32Array(ctrl);
  Atomics.store(c, C_QUIT, 1);
  Atomics.add(c, C_GEN, 1);
  Atomics.notify(c, C_GEN);
}
