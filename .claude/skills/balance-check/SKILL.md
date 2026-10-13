---
name: balance-check
description: Run the headless balance tournament and read the results after changing unit stats, skills, damage types or terrain rules.
---

# Balance check

1. `npm run balance:quick` (about 15 s, no graphics). Read `.balance/quick.txt`: win rate per unit, clear wins/losses, hp left, gold cost, and a `problems` list. Target: every unit between 35% and 65%, at least 3 clear wins and 3 clear losses.
2. Costs are calibrated: after stat or skill changes run `node scripts/balance.mjs --gold 900 --cap 120 --scenarios open,forest --seeds 2 --calibrate 12 --write` (about 15 min) and commit `src/sim/data/costs.ts`. A unit that stays far outside the band at any price needs a stat or skill change instead.
3. `npx vitest run rosterfuzz comedy troops skills reliefstall` for stalls/loops; then `npm run check`.
4. Never read `dist/` or `node_modules/`; the harness writes to `.balance/` (git-ignored).
