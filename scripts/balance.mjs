// Headless balance tournament: gold-equal single-type armies fight in the deterministic simulation (no graphics).
//   node scripts/balance.mjs [--quick] [--scenarios open,forest] [--seeds 2] [--gold 900] [--cap 120] [--name label] [--strict]
//   node scripts/balance.mjs --calibrate 8 [--write]   adjust unit gold costs until equal gold buys equally strong armies
// Writes .balance/<name>.json|txt. Identical inputs always give an identical `hash` line.
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
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const quick = flag('quick');
const scenarios = opt('scenarios', quick ? 'open' : 'open,forest').split(',');
const seeds = Number(opt('seeds', quick ? 1 : 2));
const gold = Number(opt('gold', 900));
const cap = Number(opt('cap', 120));
const name = opt('name', quick ? 'quick' : 'full');
const calibrate = Number(opt('calibrate', 0));
const damping = Number(opt('damping', 0.3));
const bandHi = Number(opt('band-hi', 2.2));
const bandLo = Number(opt('band-lo', 0.45));
const threads = Math.max(1, Math.min(Number(opt('threads', cpus().length - 1)), 16));

const t0 = Date.now();
const outDir = path.join(root, '.balance', '.build');
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
console.log(`${kinds.length} units, ${jobs.length} fights per tournament, ${threads} threads, scenarios ${scenarios.join('+')}, seeds ${seeds}, gold ${gold}, cap ${cap}`);

const workers = Array.from({ length: threads }, () => new Worker(bundle));

/** Runs every job on the worker pool with the given cost calibration; returns the played fights in a deterministic order. */
async function play(adj) {
  const batch = 24;
  const queue = [];
  for (let i = 0; i < jobs.length; i += batch) queue.push(jobs.slice(i, i + batch));
  const played = [];
  await new Promise((resolve, reject) => {
    let active = workers.length;
    const pump = (w) => {
      const next = queue.shift();
      if (!next) {
        w.removeAllListeners('message');
        if (--active === 0) resolve();
        return;
      }
      w.postMessage({ cal: adj, jobs: next });
    };
    for (const w of workers) {
      w.removeAllListeners('error');
      w.on('error', reject);
      w.on('message', (r) => {
        played.push(...r);
        if (process.stdout.isTTY) process.stdout.write(`\r${played.length}/${jobs.length}`);
        pump(w);
      });
      pump(w);
    }
  });
  process.stdout.write('\r');
  const key = (p) => `${p.job.scenario}|${p.job.a}|${p.job.b}|${p.job.seed}`;
  played.sort((p, q) => (key(p) < key(q) ? -1 : key(p) > key(q) ? 1 : 0));
  return played;
}

let cal = { cost: { ...lib.COST_ADJ }, stat: { ...lib.STAT_ADJ } };
const classicKeys = new Set(kinds.filter((k) => k < 5).map((k) => lib.costKey(k)));
const median = (xs) => {
  const s = xs.slice().sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};
if (calibrate > 0) {
  for (let it = 1; it <= calibrate; it++) {
    lib.applyCalibration(cal);
    const t = lib.aggregate(kinds, await play(cal));
    const cost = { ...cal.cost };
    const stat = { ...cal.stat };
    let worst = 0;
    const d = damping / (1 + 0.15 * it);
    for (const r of t.rows) {
      const key = lib.costKey(r.kind);
      const rate = Math.min(0.96, Math.max(0.04, r.rate));
      worst = Math.max(worst, Math.abs(r.rate - 0.5));
      cost[key] = Math.min(16, Math.max(0.25, (cost[key] ?? 1) * Math.pow(rate / (1 - rate), d)));
    }
    // Units that need a price far from the typical one are nerfed/buffed instead (classics keep their stats).
    const med = median(Object.keys(cost).map((k) => cost[k]));
    const moved = [];
    for (const key of Object.keys(cost)) {
      if (classicKeys.has(key) || !flag('stat')) continue;
      const rel = cost[key] / med;
      let f = 1;
      if (rel > bandHi) f = Math.pow(bandHi / rel, 0.3);
      else if (rel < bandLo) f = Math.pow(bandLo / rel, 0.3);
      if (f !== 1) {
        stat[key] = Math.min(2.2, Math.max(0.4, (stat[key] ?? 1) * f));
        cost[key] = cost[key] / f ** 2; // keep the price consistent with the changed stats
        moved.push(`${key} x${stat[key].toFixed(2)}`);
      }
    }
    const bad = t.rows.filter((r) => Math.abs(r.rate - 0.5) > 0.25).map((r) => `${r.name} ${(r.rate * 100).toFixed(0)}%`);
    console.log(`iteration ${it}: worst ${(worst * 100).toFixed(0)}%, draws ${t.draws}, outside 25-75%: ${bad.join(', ') || 'none'}; stat changes: ${moved.join(', ') || 'none'}`);
    cal = { cost, stat };
    // Anchor: the Warrior always costs exactly 10 gold (all others scale with it).
    lib.applyCalibration(cal);
    const w = kinds.find((k) => lib.costKey(k) === 'warrior');
    const scale = 10 / lib.rawCost(w);
    for (const k of Object.keys(cal.cost)) cal.cost[k] *= scale;
  }
  lib.applyCalibration(cal);
  const table = (o) =>
    Object.keys(o)
      .sort()
      .map((k) => `  '${k}': ${o[k].toFixed(3)},`)
      .join('\n');
  const file = `/**
 * Balance calibration produced by \`npm run balance:calibrate\` (do not edit by hand):
 *  - COST_ADJ: multiplier on the formula gold cost of \`unitGold\` (src/net/economy.ts), keyed by roster id or classic name;
 *  - STAT_ADJ: multiplier on hp and power of a roster unit (units that stay too strong/weak at any price are nerfed/buffed).
 */
export const COST_ADJ: Record<string, number> = {
${table(cal.cost)}
};
export const STAT_ADJ: Record<string, number> = {
${table(cal.stat)}
};

/** Replaces both tables in place (used by the calibration tool; call refreshStats() in units.ts afterwards). */
export function setCalibration(cost: Record<string, number>, stat: Record<string, number>): void {
  for (const k of Object.keys(COST_ADJ)) delete COST_ADJ[k];
  for (const k of Object.keys(STAT_ADJ)) delete STAT_ADJ[k];
  Object.assign(COST_ADJ, cost);
  Object.assign(STAT_ADJ, stat);
}
`;
  mkdirSync(path.join(root, '.balance'), { recursive: true });
  writeFileSync(path.join(root, '.balance', 'costs.generated.ts'), file);
  if (flag('write')) {
    writeFileSync(path.join(root, 'src/sim/data/costs.ts'), file);
    console.log('wrote src/sim/data/costs.ts');
  } else console.log('calibration written to .balance/costs.generated.ts (use --write to update src/sim/data/costs.ts)');
}

const played = await play(cal);
const t = lib.aggregate(kinds, played);
const text = lib.report(t);
const probs = lib.problems(t);
const hash = createHash('sha1').update(JSON.stringify(t.matrix.map((r) => r.map((v) => (Number.isNaN(v) ? -1 : Math.round(v * 1e6)))))).digest('hex').slice(0, 12);
const dir = path.join(root, '.balance');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, `${name}.txt`), text + `\nproblems (${probs.length}):\n${probs.join('\n')}\nhash ${hash}\n`);
writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ args: { scenarios, seeds, gold, cap }, hash, kinds, matrix: t.matrix, rows: t.rows, problems: probs }));
console.log(text);
console.log(`problems: ${probs.length}   hash ${hash}   ${((Date.now() - t0) / 1000).toFixed(1)} s`);
workers.forEach((w) => w.terminate());
if (flag('strict') && probs.length) process.exit(1);
