import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { C_GEN, C_QUIT, quitHelpers } from '../movePool';

describe('helper thread shutdown', () => {
  it('wakes a thread blocked in Atomics.wait and raises the quit flag (so a terminated helper does not linger)', async () => {
    const sab = new SharedArrayBuffer(64 * 4);
    const ctrl = new Int32Array(sab);
    // A helper-like thread: sleeps on C_GEN exactly like runHelper does (a 3 s safety timeout keeps a failing test short).
    const code = `const { workerData, parentPort } = require('node:worker_threads');
      const c = new Int32Array(workerData.sab);
      parentPort.postMessage('ready');
      parentPort.postMessage(Atomics.wait(c, ${C_GEN}, 0, 3000));`;
    const w = new Worker(code, { eval: true, workerData: { sab } });
    const results: string[] = [];
    const done = new Promise<void>((resolve) =>
      w.on('message', (m: string) => {
        results.push(m);
        if (m !== 'ready') resolve();
      }),
    );
    while (!results.includes('ready')) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    quitHelpers(sab); // the page passes the plain SharedArrayBuffer from the setup message
    await done;
    await w.terminate();
    expect(results[1]).not.toBe('timed-out'); // woken by the notify (or saw the bumped generation), not by the safety timeout
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(Atomics.load(ctrl, C_QUIT)).toBe(1);
    expect(Atomics.load(ctrl, C_GEN)).toBe(1);
    quitHelpers(ctrl); // a second call (dispose twice) is harmless
    expect(Atomics.load(ctrl, C_QUIT)).toBe(1);
    expect(Atomics.load(ctrl, C_GEN)).toBe(2);
  });
});
