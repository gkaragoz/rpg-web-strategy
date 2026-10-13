// Headless balance tournament: gold-equal single-type armies fight in the deterministic simulation (no graphics).
//   node scripts/balance.mjs [--quick] [--scenarios open,forest] [--seeds 2] [--gold 300] [--cap 60] [--name label] [--strict]
// Writes test-results/balance/<name>.json|txt. Identical inputs always give an identical `hash` line.
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const quick = flag('quick');
const scenarios = opt('scenarios', quick ? 'open' : 'open,forest').split(',');
const seeds = Number(opt('seeds', quick ? 1 : 2));
const gold = Number(opt('gold', 300));
const cap = Number(opt('cap', 60));
const name = opt('name', quick ? 'quick' : 'full');
const threads = Math.max(1, Math.min(Number(opt('threads', cpus().length - 1)), 16));

const t0 = Date.now();
const outDir = path.join(root, 'test-results', 'balance', '.build');
await build({
  root,
  configFile: false,
  logLevel: 'silent',
  build: {
    ssr: path.join(root, 'src/sim/testing/balanceEntry.ts'),
    outDir,
    emptyOutDir: true,
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'balance.mjs' } },
  },
  ssr: { noExternal: true },
});
const bundle = path.join(outDir, 'balance.mjs');
const lib = await import(pathToFileURL(bundle).href);

const kinds = lib.playableKinds();
const jobs = lib.makeJobs(kinds, scenarios, seeds, gold, cap);
console.log(`${kinds.length} units, ${jobs.length} fights, ${threads} threads, scenarios ${scenarios.join('+')}, seeds ${seeds}, gold ${gold}`);

const batch = 24;
const queue = [];
for (let i = 0; i < jobs.length; i += batch) queue.push(jobs.slice(i, i + batch));
const played = [];
let done = 0;
await new Promise((resolve, reject) => {
  let active = 0;
  const workers = [];
  const pump = (w) => {
    const next = queue.shift();
    if (!next) {
      if (--active === 0) {
        workers.forEach((x) => x.terminate());
        resolve();
      }
      return;
    }
    w.postMessage(next);
  };
  for (let i = 0; i < threads; i++) {
    const w = new Worker(bundle);
    workers.push(w);
    active++;
    w.on('message', (r) => {
      played.push(...r);
      done += r.length;
      if (done % 480 < batch) process.stdout.write(`\r${done}/${jobs.length}`);
      pump(w);
    });
    w.on('error', reject);
    pump(w);
  }
});
process.stdout.write('\n');

// Deterministic order regardless of worker timing.
played.sort((p, q) => (p.job.scenario + p.job.a + ':' + p.job.b + ':' + p.job.seed).localeCompare(q.job.scenario + q.job.a + ':' + q.job.b + ':' + q.job.seed, 'en', { numeric: true }));
const t = lib.aggregate(kinds, played);
const text = lib.report(t);
const probs = lib.problems(t);
const hash = createHash('sha1').update(JSON.stringify(t.matrix.map((r) => r.map((v) => (Number.isNaN(v) ? -1 : Math.round(v * 1e6)))))).digest('hex').slice(0, 12);
const dir = path.join(root, 'test-results', 'balance');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `${name}.txt`), text + `\nproblems (${probs.length}):\n${probs.join('\n')}\nhash ${hash}\n`);
writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ args: { scenarios, seeds, gold, cap }, hash, kinds, matrix: t.matrix, rows: t.rows, problems: probs }));
console.log(text);
console.log(`problems: ${probs.length}   hash ${hash}   ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (flag('strict') && probs.length) process.exit(1);
