# Units

- The roster lives in `src/sim/data/troops.ts` (45 original units, plus structure kinds appended at the end) with skills in `skills.ts`. Each unit has a race, role, rarity, optional skill and localized text.
- Stats come from a role/rarity **budget** (`BUDGET`: common 1000, rare 1450, epic 2250, legendary 3500) split into hp/attack/defense by role archetype; `src/sim/units.ts` normalizes to sim units.
- Visuals: `src/render/looks.ts` recipes keyed by troop id; projectile style by tag in `projectileStyle.ts`.
- Adding or rebalancing: use the `add-unit` and `balance-check` skills. Names, numbers and texts must be original.

## Combat rules that shape matchups

- **Damage type × armor class** (`src/sim/data/combat.ts`, `TYPE_MULT`): slash beats light armor, pierce beats medium, blunt beats heavy, magic beats spirit and heavy. Every roster unit's pair is in the `TYPING` table of `troops.ts` and shown as chips on the unit card.
- **Area damage**: basic-attack splash falls off with distance (50% at the edge) and hits at most 14 enemies; skills have their own rules. Cards show "Area r" / "Single target" and "Area skill".
- **Crowd control**: after a stun or fear a unit is immune for 1.2 s, so many casters cannot lock an army.
- **Terrain** (`combat.ts`): height difference gives ±9% damage per step and +0.6 / −0.4 tile range for ranged units; climbing slows by steepness; ridges block direct fire (not lobbed or magic shots). The renderer shows gold chevrons (1-3) above a unit standing at least 1 step above its current target (`Units.hgAdv`, display only, computed every 4th step).
- **Gold costs** are the formula in `src/net/economy.ts` times a calibrated factor (`src/sim/data/costs.ts`, generated): equal gold buys armies of equal strength.

## Balance harness (headless, deterministic)

`npm run balance:quick` (about 15 s) and `npm run balance` run gold-equal single-type tournaments on worker threads without any graphics; results go to `.balance/<name>.txt|json` (git-ignored) and end with a `hash` that is identical for identical inputs. `node scripts/balance.mjs --calibrate 12 --scenarios open,forest --seeds 2 --gold 900 --cap 120 --write` re-fits the cost factors. Healers are tested behind a Warrior line.
- **Structures** (`TroopDef.structure`, currently only `siege-core`) are game-mode objects, not units: they are listed last in `TROOPS` so no kind number ever changes, are flagged `summoned` too (hidden from the gallery, placement and gold costs), have speed 0 / power 0 / no skill, and are immune to knockback, launch, stun, fear and taunt. See `docs/SIMULATION.md` (Siege).
