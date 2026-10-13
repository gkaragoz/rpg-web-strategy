import { isMainThread, parentPort } from 'node:worker_threads';
import { runFight, type Job } from './balance';

export * from './balance';

// When this bundle is loaded as a worker (scripts/balance.mjs), it runs batches of fights on request.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (jobs: Job[]) => port.postMessage(jobs.map((job) => ({ job, res: runFight(job) }))));
}
