/// <reference lib="webworker" />
import { Battle, DBG_KEYS, type BattleConfig, type SimEvent, projectileCapacity, unitCapacity } from './battle';
import { SIM_DT } from './constants';
import {
  F_ALIVE_BASE,
  F_DBG,
  F_LAST_MS,
  F_MAX_MS,
  F_PREV_PUBLISH,
  F_PROF,
  F_PUBLISH,
  F_SIM_TIME,
  F_STEPS,
  F_TOTAL_MS,
  F_WINNER,
  I_COUNT,
  I_EPOCH,
  I_LATEST,
  I_PCOUNT,
  PROF_KEYS,
  SNAP_SLOTS,
  bindShared,
  type Shared,
} from './shared';

export type WorkerCommand =
  | { type: 'init'; sab: SharedArrayBuffer; config: BattleConfig; seed: number }
  | { type: 'reset'; seed: number }
  | { type: 'speed'; speed: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'resetStats' };

export type WorkerEvent =
  | { type: 'ready'; count: number }
  | { type: 'reset'; count: number }
  | { type: 'events'; events: SimEvent[] };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let battle: Battle;
let sh: Shared;
let config: BattleConfig;
let step = 0;
let speed = 1;
let paused = false;
let next = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let totalMs = 0;
let steps = 0;
let maxMs = 0;

const epochNow = () => performance.timeOrigin + performance.now();

function publishStatic(): void {
  const u = battle.units;
  sh.kind.set(u.kind.subarray(0, u.count));
  sh.team.set(u.team.subarray(0, u.count));
  sh.maxHp.set(u.maxHp.subarray(0, u.count));
  sh.ctrlI[I_COUNT] = u.count;
}

/** Copies the current state into the next ring slot and publishes it last with Atomics.store. */
function publish(): void {
  const u = battle.units;
  const n = u.count;
  const s = sh.slots[step % SNAP_SLOTS];
  s.x.set(u.x.subarray(0, n));
  s.y.set(u.y.subarray(0, n));
  s.hp.set(u.hp.subarray(0, n));
  s.swing.set(u.swing.subarray(0, n));
  s.flash.set(u.flash.subarray(0, n));
  s.deathT.set(u.deathT.subarray(0, n));
  s.facing.set(u.facing.subarray(0, n));
  s.moving.set(u.moving.subarray(0, n));
  s.alive.set(u.alive.subarray(0, n));
  s.status.set(u.status.subarray(0, n));
  s.lift.set(u.lift.subarray(0, n));
  s.hgAdv.set(u.hgAdv.subarray(0, n));

  const p = battle.projectiles;
  let pn = 0;
  for (let i = 0; i < p.count; i++) {
    if (!p.active[i]) continue;
    s.pSx[pn] = p.sx[i];
    s.pSy[pn] = p.sy[i];
    s.pTx[pn] = p.tx[i];
    s.pTy[pn] = p.ty[i];
    s.pT[pn] = p.t[i];
    s.pDur[pn] = p.dur[i];
    s.pH[pn] = p.height[i];
    s.pTag[pn] = p.tag[i];
    pn++;
  }
  sh.ctrlI[I_PCOUNT + (step % SNAP_SLOTS)] = pn;

  const f = sh.ctrlF;
  f[F_PREV_PUBLISH] = f[F_PUBLISH];
  f[F_PUBLISH] = epochNow();
  f[F_SIM_TIME] = battle.time;
  f[F_WINNER] = battle.winner;
  for (let tm = 0; tm < battle.alivePerTeam.length; tm++) f[F_ALIVE_BASE + tm] = battle.alivePerTeam[tm];
  Atomics.store(sh.ctrlI, I_LATEST, step);
}

function runStep(): void {
  const t0 = performance.now();
  battle.step(SIM_DT);
  const ms = performance.now() - t0;
  step++;
  publish();

  totalMs += ms;
  steps++;
  if (ms > maxMs) maxMs = ms;
  const f = sh.ctrlF;
  f[F_STEPS] = steps;
  f[F_TOTAL_MS] = totalMs;
  f[F_MAX_MS] = maxMs;
  f[F_LAST_MS] = ms;
  PROF_KEYS.forEach((k, i) => (f[F_PROF + i] = battle.prof[k]));
  DBG_KEYS.forEach((k, i) => (f[F_DBG + i] = battle.dbg[k]));

  if (battle.events.length) {
    ctx.postMessage({ type: 'events', events: battle.events.splice(0) } satisfies WorkerEvent);
  }
}

function tick(): void {
  const now = performance.now();
  const interval = (SIM_DT * 1000) / speed;
  if (paused) {
    next = now;
  } else {
    let n = 0;
    while (now >= next && n < 2) {
      runStep();
      next += interval;
      n++;
    }
    // If we cannot keep up, drop the accumulated backlog: the sim slows down and the queue does not grow.
    if (performance.now() - next > 100) next = performance.now();
  }
  timer = setTimeout(tick, Math.max(0, next - performance.now()));
}

function zeroStats(): void {
  totalMs = steps = maxMs = 0;
  battle.prof.prep = battle.prof.grid = battle.prof.units = battle.prof.pick = 0;
  battle.prof.separate = battle.prof.arrows = battle.prof.steps = 0;
  const f = sh.ctrlF;
  f[F_STEPS] = f[F_TOTAL_MS] = f[F_MAX_MS] = 0;
  for (let i = 0; i < PROF_KEYS.length; i++) f[F_PROF + i] = 0;
  for (const k of DBG_KEYS) battle.dbg[k] = 0;
  for (let i = 0; i < DBG_KEYS.length; i++) f[F_DBG + i] = 0;
}

ctx.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      config = m.config;
      battle = new Battle(m.seed, config);
      sh = bindShared(m.sab, unitCapacity(config), projectileCapacity(config));
      sh.pActive.fill(1);
      publishStatic();
      publish();
      next = performance.now();
      ctx.postMessage({ type: 'ready', count: battle.units.count } satisfies WorkerEvent);
      tick();
      break;
    }
    case 'reset': {
      battle.reset(m.seed);
      step = 0;
      zeroStats();
      publishStatic();
      publish();
      Atomics.add(sh.ctrlI, I_EPOCH, 1);
      next = performance.now();
      ctx.postMessage({ type: 'reset', count: battle.units.count } satisfies WorkerEvent);
      break;
    }
    case 'speed':
      speed = m.speed;
      break;
    case 'pause':
      paused = m.paused;
      break;
    case 'resetStats':
      zeroStats();
      break;
  }
};

void timer;
