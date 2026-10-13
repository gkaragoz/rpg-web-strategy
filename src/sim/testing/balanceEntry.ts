import { isMainThread, parentPort } from 'node:worker_threads';
import { setCalibration } from '../data/costs';
import { refreshStats } from '../units';
import { runFight, type Job } from './balance';

export * from './balance';
export { COST_ADJ, STAT_ADJ } from '../data/costs';
export { costKey, rawCost } from '../../net/economy';

export type Calibration = { cost: Record<string, number>; stat: Record<string, number> };

/** Installs a calibration (cost and stat multipliers) in this thread. */
export function applyCalibration(c: Calibration): void {
  setCalibration(c.cost, c.stat);
  refreshStats();
}

interface Msg {
  /** Calibration to use for these jobs (sent whenever it changes). */
  cal?: Calibration;
  jobs: Job[];
}

// When this bundle is loaded as a worker (scripts/balance.mjs), it runs batches of fights on request.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (m: Msg) => {
    if (m.cal) applyCalibration(m.cal);
    port.postMessage(m.jobs.map((job) => ({ job, res: runFight(job) })));
  });
}
