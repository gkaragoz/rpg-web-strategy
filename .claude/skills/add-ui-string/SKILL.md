---
name: add-ui-string
description: Add a user-visible string in both English and Turkish. Use whenever UI text is added or changed.
---

# Add a UI string

1. Pick the table by area in `src/i18n/` (`studio`, `battle`, `maps`, `units`, `online`, `system`).
2. Add the key to **both** `en` and `tr` with identical `{placeholders}`; keys are `area.thing` (e.g. `sys.lang.aria`).
3. Use it as `t('area.thing', { n: 3 })`. Never concatenate translated fragments; use placeholders.
4. Turkish needs correct diacritics (ç ğ ı ö ş ü); they are only allowed in `src/i18n/**` and a few data files (see `scripts/lib/rules.mjs`).
5. Run `npx vitest run i18n` — it checks key and placeholder parity.
