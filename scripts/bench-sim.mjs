// Headless simulation benchmark: ms per step (and per phase) for big armies. No graphics.
//   node scripts/bench-sim.mjs [--units 3000,10000,30000] [--teams 2] [--size 256] [--steps 200] [--name label]
// Prints a table and writes .bench/<name>.json. The `hash` column is identical for identical code and inputs.
import { build } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const totals = opt('units', '3000,10000,30000').split(',').map(Number);
const teams = Number(opt('teams', 2));
const size = Number(opt('size', 256));
const steps = Number(opt('steps', 200));
const name = opt('name', 'latest');
const dtOverride = Number(opt('dt', 0));

const outDir = path.join(root, '.bench', '.build');
await build({
  root,
  configFile: false,
  logLevel: 'silent',
  build: { ssr: path.join(root, 'src/sim/testing/benchEntry.ts'), outDir, emptyOutDir: true, minify: false, rollupOptions: { output: { format: 'es', entryFileNames: 'bench.mjs' } } },
  ssr: { noExternal: true },
});
const lib = await import(pathToFileURL(path.join(outDir, 'bench.mjs')).href);

const rows = [];
for (const total of totals) {
  const r = lib.runBench(Math.round(total / teams), teams, size, steps, dtOverride);
  rows.push(r);
  const ph = Object.entries(r.phases).map(([k, v]) => `${k} ${v}`).join('  ');
  console.log(`${String(r.units).padStart(6)} units  dt 1/${Math.round(1 / r.dt)}  map ${r.size}  ${r.msPerStep.toFixed(2).padStart(7)} ms/step  (max ${r.maxStepMs} ms)  ${ph}  hash ${r.hash}`);
  if (args.includes('--dbg')) console.log('        dbg', JSON.stringify(r.dbg));
}
mkdirSync(path.join(root, '.bench'), { recursive: true });
writeFileSync(path.join(root, '.bench', `${name}.json`), JSON.stringify(rows, null, 2));
