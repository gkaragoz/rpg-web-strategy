# Simulation

- `src/sim/battle.ts` (large; grep, do not read top to bottom) owns the step loop: targeting, movement on the grid (`grid.ts`), attacks, skills, projectiles (`projectiles.ts`), terrain effects (`terrain.ts`).
- Unit state is struct-of-arrays in `units.ts` (typed arrays) for speed; stats are normalized from the raw roster numbers there.
- **Determinism**: same seed + same inputs ⇒ same state on every client. Randomness only via `Mulberry` (`random.ts`). The state hash is compared every 60 steps online.
- `snapshot.ts` serializes/restores a battle (used for late joiners and desync recovery); new state must be included in `serialize/restore/hash`.
- Stall detector (`testing/stall.ts`) and fuzz tests guard against fights that never end.
- Rules for editing: `.claude/rules/sim-determinism.md`.
