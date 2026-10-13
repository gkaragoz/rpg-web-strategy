/// <reference lib="webworker" />
import { mapSizeFor, terrainFor } from './battle';
import { Grid } from './grid';
import {
  C_ACTIVE,
  C_COUNT,
  C_DONE,
  C_GEN,
  C_LOS,
  C_MASK,
  C_NEXT,
  C_PHASE,
  C_QUIT,
  C_READY,
  C_SEPPH,
  C_STEP,
  F_BRAKE,
  F_DECAY,
  F_DT,
  F_GAIN,
  F_MAXSTEP,
  PH_MOVE,
  PH_PICK,
  PH_SEP_APPLY,
  PH_SEP_SCAN,
  type HelperInit,
} from './movePool';
import { Mover, chunkSize } from './mover';
import { Picker } from './picker';
import { Separator } from './separator';
import { Units, applyStats } from './units';

/**
 * Helper thread of the parallel phases (created by the page, set up with the shared buffers of the sim thread): waits for the
 * sim thread to open a phase and takes chunks from the shared counter.
 */
const ctx = (typeof self !== 'undefined' ? self : globalThis) as unknown as DedicatedWorkerGlobalScope;

type ViewCtor = new (b: SharedArrayBuffer) => unknown;

/** Typed-array constructor per Units field, learned from a reference instance. */
const KINDS: Record<string, ViewCtor> = (() => {
  const ref = new Units(1);
  const out: Record<string, ViewCtor> = {};
  for (const [k, v] of Object.entries(ref)) if (ArrayBuffer.isView(v) && !(v instanceof DataView)) out[k] = (v as unknown as { constructor: ViewCtor }).constructor;
  return out;
})();

/** The helper's life: set up from the shared buffers, then serve phases until the sim thread says quit. Blocks (Atomics.wait). */
export function runHelper(m: HelperInit): void {
  applyStats(m.config.stats);
  const units = Object.create(Units.prototype) as Units;
  for (const [k, buf] of Object.entries(m.units)) (units as unknown as Record<string, unknown>)[k] = new (KINDS[k] ?? Float32Array)(buf);
  (units as unknown as { cap: number }).cap = m.cap;
  const ctrl = new Int32Array(m.ctrl);
  const fctrl = new Float64Array(m.fctrl);
  const terrain = terrainFor(m.config);
  const mapSize = mapSizeFor(m.config);
  const grids = m.grids.map((g) => Grid.view(g));
  const mover = new Mover(units, terrain, mapSize, m.rageA, new Int32Array(m.counts));
  const picker = new Picker(units, terrain, grids.slice(0, m.teamCount), m.teamCount);
  const separator = new Separator(units, terrain, grids[m.teamCount], mapSize);
  // Read the generation first, then announce: a phase opened after this read wakes us, one opened before it does not count us.
  let seen = Atomics.load(ctrl, C_GEN);
  const index = Atomics.add(ctrl, C_READY, 1);
  for (;;) {
    Atomics.wait(ctrl, C_GEN, seen);
    seen = Atomics.load(ctrl, C_GEN);
    if (Atomics.load(ctrl, C_QUIT)) return;
    if (index >= Atomics.load(ctrl, C_ACTIVE)) continue;
    const count = Atomics.load(ctrl, C_COUNT);
    const phase = Atomics.load(ctrl, C_PHASE);
    const dt = fctrl[F_DT];
    const step = Atomics.load(ctrl, C_STEP);
    mover.stepNo = step;
    mover.losEvery = Atomics.load(ctrl, C_LOS);
    mover.brakeK = fctrl[F_BRAKE];
    picker.step = step;
    picker.dt = dt;
    picker.aliveMask = Atomics.load(ctrl, C_MASK);
    separator.phase = Atomics.load(ctrl, C_SEPPH);
    separator.gain = fctrl[F_GAIN];
    separator.maxStep = fctrl[F_MAXSTEP];
    separator.decay = fctrl[F_DECAY];
    if (phase === PH_PICK) picker.prepare();
    const size = chunkSize(count);
    const chunks = Math.ceil(count / size);
    for (;;) {
      const k = Atomics.add(ctrl, C_NEXT, 1);
      if (k >= chunks) break;
      const from = k * size;
      const to = Math.min(count, from + size);
      if (phase === PH_MOVE) mover.runChunk(from, to, dt);
      else if (phase === PH_PICK) picker.runChunk(from, to);
      else if (phase === PH_SEP_SCAN) separator.scan(from, to);
      else if (phase === PH_SEP_APPLY) separator.apply(from, to);
    }
    Atomics.add(ctrl, C_DONE, 1);
    Atomics.notify(ctrl, C_DONE);
  }
}

// In a Web Worker the setup message starts the helper (not when this module is imported by Node tooling).
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  ctx.onmessage = (e: MessageEvent<HelperInit>) => {
    if (e.data.type === 'init') runHelper(e.data);
  };
}
