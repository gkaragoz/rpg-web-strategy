# Units

- The roster lives in `src/sim/data/troops.ts` (45 original units) with skills in `skills.ts`. Each unit has a race, role, rarity, optional skill and localized text.
- Stats come from a role/rarity **budget** (`BUDGET`: common 1000, rare 1450, epic 2250, legendary 3500) split into hp/attack/defense by role archetype; `src/sim/units.ts` normalizes to sim units.
- Visuals: `src/render/looks.ts` recipes keyed by troop id; projectile style by tag in `projectileStyle.ts`.
- Adding or rebalancing: use the `add-unit` and `balance-check` skills. Names, numbers and texts must be original.
