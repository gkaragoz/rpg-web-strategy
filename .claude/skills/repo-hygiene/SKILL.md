---
name: repo-hygiene
description: Run the repository policy checks (forbidden terms, Turkish in code, license notices, README images).
---

# Repo hygiene

- `npm run lint:repo` runs `scripts/check-repo.mjs`; the rules live in `scripts/lib/rules.mjs` and are also enforced on edits by `scripts/hooks/guard.mjs`.
- It checks: forbidden third-party terms in tracked files, Turkish diacritics outside the i18n allowlist, license files and the `Required Notice:` line, README image files exist.
- Fix findings in the file, not in the rules.
