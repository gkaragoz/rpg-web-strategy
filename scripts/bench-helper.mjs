// Node worker thread for `bench-sim.mjs --threads N`: a movement helper (see src/sim/moverWorker.ts).
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const lib = await import(pathToFileURL(workerData.bundle).href);
parentPort.once('message', (init) => lib.runHelper(init));
