import { describe, expect, it } from 'vitest';
import type { OnlineModel } from '../../net/client';
import type { HostLobby } from '../../net/host';
import { CHECK_EVERY } from '../../net/host';
import { LockstepRunner, type SimLike } from '../../net/lockstep';
import { b64decode, b64encode } from '../../net/protocol';

/** A sim like the worker-backed one: stepping only counts, hashes and snapshots arrive through callbacks. */
function asyncSim() {
  let steps = 0;
  let cb: ((step: number, hash: number) => void) | null = null;
  const restored: Array<{ step: number; len: number }> = [];
  const sim: SimLike = {
    dt: 1 / 30,
    step: () => {
      steps++;
      if (steps % CHECK_EVERY === 0) cb?.(steps, 1000 + steps);
    },
    get stepCount() {
      return steps;
    },
    hash: () => {
      throw new Error('hash() must not be called on an async sim');
    },
    serialize: () => {
      throw new Error('no sync snapshot');
    },
    restore: () => {
      throw new Error('no sync restore');
    },
    winner: -1,
    alivePerTeam: [1, 1],
    onHash: (c) => (cb = c),
    restorePacked: (data, step) => {
      steps = step;
      restored.push({ step, len: data.length });
    },
    snapshotPacked: () => Promise.resolve({ step: steps, data: new Uint8Array([1, 2, 3]) }),
  };
  return { sim, restored };
}

describe('lockstep runner with an asynchronous (worker) sim', () => {
  it('host: checkpoint hashes come from the sim callback; snapshots are served asynchronously', async () => {
    const { sim } = asyncSim();
    const hashes: Array<[number, number]> = [];
    const host = {
      simProvider: null as HostLobby['simProvider'],
      recordHash: (s: number, h: number) => hashes.push([s, h]),
      broadcastTick: () => {},
      finish: () => {},
    } as unknown as HostLobby;
    const runner = new LockstepRunner(sim, {} as OnlineModel, { host, now: () => 0 });
    for (let i = 0; i < 70; i++) runner.advance(1 / 30);
    expect(sim.stepCount).toBeGreaterThanOrEqual(CHECK_EVERY);
    expect(hashes[0]).toEqual([CHECK_EVERY, 1000 + CHECK_EVERY]);
    const snap = await host.simProvider!.snapshot();
    expect(snap.step).toBe(sim.stepCount);
    expect([...b64decode(snap.data)]).toEqual([1, 2, 3]);
  });

  it('guest: sends checks from the callback and restores packed snapshots without unpacking them', () => {
    const { sim, restored } = asyncSim();
    const sent: unknown[] = [];
    const model = { pendingResync: null as { step: number; data: string } | null, speed: 1, paused: false, hostStep: -1, hostStepAt: 0 } as unknown as OnlineModel;
    const runner = new LockstepRunner(sim, model, { send: (m) => sent.push(m), now: () => 0 });
    for (let i = 0; i < 70; i++) runner.advance(1 / 30);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ t: 'check', step: CHECK_EVERY });
    model.pendingResync = { step: 500, data: b64encode(new Uint8Array([9, 9])) };
    runner.advance(1 / 30);
    expect(restored).toEqual([{ step: 500, len: 2 }]);
  });
});
