---
name: balance-check
description: Run the roster fuzz/balance suites and read the results after changing unit stats or skills.
---

# Balance check

1. `npx vitest run rosterfuzz comedy troops skills` — fuzz batches (every unit vs. every other class), stall detector, budget/rarity invariants.
2. If a unit stalls a fight, check `stun`/`root` durations and `ATTACK` range vs. `reach` first.
3. Rarity tiers must stay sorted by budget (the `troops` test asserts it); stun must never permanently lock.
4. Finish with `npm run check`.
