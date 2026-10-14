// Shared repository rules used by scripts/check-repo.mjs and the Claude Code guard hook (scripts/hooks/guard.mjs).
// The forbidden terms are assembled from fragments on purpose so this file itself never contains them.

const j = (...parts) => parts.join('');

/** Third-party game / data-source references that must never appear in the repository. */
export const FORBIDDEN = [
  { re: new RegExp(j('art ', 'of ', 'war'), 'i'), why: 'reference to another game' },
  { re: new RegExp(j('artof', 'war'), 'i'), why: 'reference to another game' },
  { re: new RegExp(j('fand', 'om'), 'i'), why: 'reference to a third-party host' },
  { re: new RegExp(j('\\bwi', 'ki\\b'), 'i'), why: 'the unit roster is original; do not describe it as third-party data' },
  { re: new RegExp(j('\\blegi', 'ons\\b'), 'i'), why: 'reference to another game' },
  // Distinctive names of the old (removed) roster.
  { re: new RegExp(j('gobli', 'ka', 'ze|voo', 'doo ', 'doll|pump', 'kin', '-guard|tau', 'rus ', 'witcher|witch', 'craft ', 'totem|harbin', 'ger of ', 'fire|hell ', 'jailer'), 'i'), why: 'name from the old removed roster' },
];

/** Files that legitimately contain Turkish text (UI tables and bilingual data). */
export const TURKISH_ALLOWED = [/^src\/i18n\//, /^src\/i18n\.ts$/, /^src\/sim\/data\/troops\.ts$/, /^src\/sim\/mapSpec\.ts$/, /^src\/sim\/__tests__\/i18n\.test\.ts$/, /^index\.html$/, /^scripts\/lib\/rules\.mjs$/];

const TURKISH_RE = /[çğıöşüÇĞİÖŞÜ]/;

/** Returns human-readable problems found in `text` written to `file` (repo-relative, forward slashes). */
export function problemsIn(file, text) {
  const out = [];
  for (const { re, why } of FORBIDDEN) {
    const m = re.exec(text);
    if (m) out.push(`${file}: forbidden term "${m[0]}" (${why})`);
  }
  // Application code: the TypeScript sources, the relay worker, the helper scripts, the public scripts and the 3D redirect page.
  const isCode = (/^src\/.*\.ts$/.test(file) && !/__tests__\//.test(file)) || /^(relay\/src|scripts|public)\/.*\.m?js$/.test(file) || file === '3d/index.html';
  if (isCode && !TURKISH_ALLOWED.some((r) => r.test(file))) {
    const line = text.split(/\r?\n/).findIndex((l) => TURKISH_RE.test(l.replace(/(^|[\s;,{(])\/\/.*$/, '$1')));
    if (line >= 0) out.push(`${file}:${line + 1}: Turkish text in code (UI strings must go through src/i18n; comments are English)`);
  }
  return out;
}
