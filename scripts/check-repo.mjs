#!/usr/bin/env node
// Repository hygiene checks (run by `npm run lint:repo` and as part of `npm run check`):
//  - no forbidden third-party references / Turkish text in code (see scripts/lib/rules.mjs)
//  - the license files and the notice line exist
//  - every image referenced from README.md exists
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { problemsIn } from './lib/rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  // binaries and generated files are not scanned
  .filter((f) => !/\.(jpg|jpeg|png|webp|gif|ico|woff2?|zip)$/i.test(f) && f !== 'package-lock.json');

for (const f of files) {
  if (f === 'scripts/lib/rules.mjs') continue;
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  } catch {
    continue; // deleted in the working tree but still tracked
  }
  problems.push(...problemsIn(f, text));
}

for (const req of ['LICENSE', 'CLA.md', 'CONTRIBUTING.md', 'THIRD_PARTY_NOTICES.md']) {
  if (!fs.existsSync(path.join(ROOT, req))) problems.push(`${req}: missing`);
}
const license = fs.existsSync(path.join(ROOT, 'LICENSE')) ? fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8') : '';
if (!/^Required Notice:/m.test(license)) problems.push('LICENSE: missing "Required Notice:" line');

const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
for (const m of readme.matchAll(/src="(docs\/[^"]+)"|\]\((docs\/[^)]+)\)/g)) {
  const rel = m[1] ?? m[2];
  if (!fs.existsSync(path.join(ROOT, rel))) problems.push(`README.md: missing image ${rel} (run \`npm run screenshots\`)`);
}

if (problems.length) {
  console.error(`repo check failed (${problems.length}):\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`repo check ok (${files.length} files)`);
