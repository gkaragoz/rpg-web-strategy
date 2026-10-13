---
name: add-unit
description: Add or change a roster unit (stats, skill, look recipe, projectile tag, tests). Use when asked to create a new unit or rebalance one.
---

# Add a roster unit

1. **Data**: `src/sim/data/troops.ts` — add a `Troop` entry (id kebab-case, English `name`, `Localized` description, rarity, stats, optional `skill`). Check the budget formulas with `docs/UNITS.md`.
2. **Skill** (optional): `src/sim/data/skills.ts` (`Localized` name/desc) and the behavior in `src/sim/battle.ts` (grep an existing skill id to see every touch point; keep it deterministic and add new state to `serialize/restore/hash`).
3. **Look**: `src/render/looks.ts` — add a recipe keyed by the troop id (grep an existing recipe of the same race); projectile style via the tag map (`TAG_OF`) in `src/render/projectileStyle.ts` if ranged.
4. **Preview**: `src/app/previewOverlay.ts` picks the strike overlay automatically; `preview.test.ts` checks every roster unit gets one.
5. **Tests**: add a case to `src/sim/__tests__/skills.test.ts` or `troops.test.ts`; run `npm run test:sim`.
6. **Balance**: use the `balance-check` skill.
7. `npm run check` before committing. No names/stats copied from other games.
