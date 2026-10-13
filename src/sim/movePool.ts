import type { BattleConfig } from './battle';
import { chunkSize } from './mover';
import type { Units } from './units';

/** Control block (Int32 slots) shared by the sim thread and the helpers. */
export const C_GEN = 0; // generation: bumped to start a phase
export const C_NEXT = 1; // next chunk to take
export const C_DONE = 2; // helpers finished with the current phase
export const C_COUNT = 3; // unit count
export const C_STEP = 4; // step number
export const C_LOS = 5; // line-of-sight interval
export const C_QUIT = 6;
export const C_READY = 7; // helpers that finished their setup (each takes the next index)
export const C_ACTIVE = 8; // helpers taking part in the current phase (indices 0 .. active-1)
export const C_LEN = 10;
/** Float64 params: dt, brakeK. */
export const F_DT = 0;
export const F_BRAKE = 1;

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
  readonly fctrl = new Float64Array(new SharedArrayBuffer(4 * 8));
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
    readonly log: (msg: string) => void = (m) => console.warn('[move pool]', m),
  ) {
    const bufs = shareUnitArrays(units);
    post({ type: 'init', units: bufs, cap: units.cap, config, rageA, ctrl: this.ctrl.buffer as SharedArrayBuffer, fctrl: this.fctrl.buffer as SharedArrayBuffer, counts: this.counts.buffer as SharedArrayBuffer });
  }

  /** Helpers that are set up and waiting. */
  get size(): number {
    return Atomics.load(this.ctrl, C_READY);
  }

  /** Runs the chunks of the movement phase on all available threads; `runChunk` is the sim thread's own mover. */
  run(count: number, dt: number, stepNo: number, brakeK: number, losEvery: number, runChunk: (from: number, to: number) => void): void {
    const c = this.ctrl;
    const size = chunkSize(count);
    const chunks = Math.ceil(count / size);
    const active = this.broken ? 0 : Atomics.load(c, C_READY);
    Atomics.store(c, C_COUNT, count);
    Atomics.store(c, C_STEP, stepNo);
    Atomics.store(c, C_LOS, losEvery);
    this.fctrl[F_DT] = dt;
    this.fctrl[F_BRAKE] = brakeK;
    Atomics.store(c, C_NEXT, 0);
    Atomics.store(c, C_DONE, 0);
    Atomics.store(c, C_ACTIVE, active);
    if (active > 0) {
      Atomics.add(c, C_GEN, 1);
      Atomics.notify(c, C_GEN);
    }
    for (;;) {
      const k = Atomics.add(c, C_NEXT, 1);
      if (k >= chunks) break;
      runChunk(k * size, Math.min(count, (k + 1) * size));
    }
    if (active === 0) return;
    // Wait for the helpers that are still inside a chunk (a helper that never answers is given up on).
    const t0 = Date.now();
    for (;;) {
      const d = Atomics.load(c, C_DONE);
      if (d >= active) break;
      if (Date.now() - t0 > 2000) {
        this.broken = true;
        this.log('a movement helper did not answer within 2 s: continuing on one thread');
        this.stop();
        break;
      }
      Atomics.wait(c, C_DONE, d, 20);
    }
  }

  /** Tells the helpers to exit (the page terminates them). */
  stop(): void {
    Atomics.store(this.ctrl, C_QUIT, 1);
    Atomics.add(this.ctrl, C_GEN, 1);
    Atomics.notify(this.ctrl, C_GEN);
  }
}
