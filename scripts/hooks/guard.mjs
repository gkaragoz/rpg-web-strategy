#!/usr/bin/env node
// Claude Code PreToolUse hook (see .claude/settings.json): blocks Write/Edit calls whose new content breaks the repo rules
// (forbidden third-party references, Turkish text in code outside src/i18n). Exit code 2 = block, the message goes to Claude.
import path from 'node:path';
import { problemsIn } from '../lib/rules.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // not our business
}
const ti = input.tool_input ?? {};
const file = ti.file_path;
if (!file) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
if (rel.startsWith('..') || rel === 'scripts/lib/rules.mjs') process.exit(0);

const texts = [ti.content, ti.new_string, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])].filter((t) => typeof t === 'string');
const problems = texts.flatMap((t) => problemsIn(rel, t));
if (problems.length) {
  console.error(`Blocked by the repository rules:\n- ${problems.join('\n- ')}\nFix the content (see CLAUDE.md "Rules") and try again.`);
  process.exit(2);
}
