// Bundle size budget for the production build (run after `npm run build`). Limits are raw bytes with ~15 % headroom;
// raise one deliberately (and say why in the commit) when a feature needs it.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist', 'assets');
const files = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => ({ f, size: statSync(join(dir, f)).size }));
const budgets = [
  { name: 'main entry', match: /^main-.*\.js$/, max: 560_000 },
  { name: '3D chunk (lazy)', match: /^world3d-.*\.js$/, max: 600_000 },
  { name: 'sim worker', match: /^worker-.*.js$/, max: 150_000 },
];
let failed = false;
for (const b of budgets) {
  const hit = files.find((x) => b.match.test(x.f));
  if (!hit) {
    console.error(`budget: no file for ${b.name}`);
    failed = true;
  } else if (hit.size > b.max) {
    console.error(`budget exceeded: ${b.name} ${hit.size} > ${b.max} (${hit.f})`);
    failed = true;
  } else console.log(`ok ${b.name}: ${hit.size} / ${b.max}`);
}
const total = files.reduce((n, x) => n + x.size, 0);
const TOTAL_MAX = 2_000_000;
if (total > TOTAL_MAX) {
  console.error(`budget exceeded: all JS ${total} > ${TOTAL_MAX}`);
  failed = true;
} else console.log(`ok all JS: ${total} / ${TOTAL_MAX}`);
process.exit(failed ? 1 : 0);
