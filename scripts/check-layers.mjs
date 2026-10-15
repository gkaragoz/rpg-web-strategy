// Layer and cycle check for src/: no dependencies, runs in CI and in `npm run check`.
//   - layer rules: which top-level folders a folder may import from (type-only imports count too)
//   - runtime import cycles (imports that are not `import type`)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

/** area -> areas it may import (itself is always allowed). Files directly in src/ form the area '.'. */
const ALLOWED = {
  sim: ['contracts'],
  contracts: ['sim', 'render'],
  net: ['sim', 'contracts', 'i18n'],
  i18n: ['contracts', 'sim'],
  render: ['sim', 'contracts', 'i18n', 'net', '.'],
  render3d: ['sim', 'contracts', 'render', 'i18n', '.'],
  ui: ['sim', 'contracts', 'i18n', '.'],
  app: ['sim', 'contracts', 'net', 'render', 'render3d', 'ui', 'i18n', '.'],
  '.': ['sim', 'contracts', 'net', 'render', 'render3d', 'ui', 'app', 'i18n', '.'],
};
/** Known existing violations that are being removed; every entry must be justified and shrink over time. */
const ALLOW_FILES = new Set([]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'testing') continue;
      walk(p, out);
    } else if (/\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const area = (file) => {
  const rel = relative(src, file).split(sep);
  if (rel.length === 1) return rel[0] === 'i18n.ts' ? 'i18n' : '.';
  return rel[0];
};

const files = walk(src);
const graph = new Map();
const problems = [];
const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const deps = [];
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[3];
    if (!spec.startsWith('.')) continue;
    let target = resolve(dirname(file), spec);
    const candidates = [target + '.ts', join(target, 'index.ts'), target];
    const real = candidates.find((c) => files.includes(c));
    if (!real) continue;
    const typeOnly = !!m[2];
    const from = area(file);
    const to = area(real);
    if (from !== to && !(ALLOWED[from] ?? []).includes(to) && !ALLOW_FILES.has(relative(root, file).split(sep).join('/'))) {
      problems.push(`${relative(root, file).split(sep).join('/')}: ${from} must not import ${to} (${spec})`);
    }
    if (!typeOnly) deps.push(real);
  }
  graph.set(file, deps);
}

// Cycles (Tarjan-free DFS, reports each distinct cycle once).
const state = new Map();
const stack = [];
const seen = new Set();
function dfs(f) {
  state.set(f, 1);
  stack.push(f);
  for (const d of graph.get(f) ?? []) {
    if (state.get(d) === 1) {
      const cyc = stack.slice(stack.indexOf(d)).map((x) => relative(src, x).split(sep).join('/'));
      const key = [...cyc].sort().join('|');
      if (!seen.has(key)) {
        seen.add(key);
        problems.push(`runtime import cycle: ${cyc.join(' -> ')} -> ${cyc[0]}`);
      }
    } else if (!state.has(d)) dfs(d);
  }
  stack.pop();
  state.set(f, 2);
}
for (const f of files) if (!state.has(f)) dfs(f);

if (problems.length) {
  console.error(`layer check failed (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`layer check ok (${files.length} files)`);
