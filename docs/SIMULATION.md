# Simulation

- `src/sim/battle.ts` (large; grep, do not read top to bottom) owns the step loop: targeting, movement on the grid (`grid.ts`), attacks, skills, projectiles (`projectiles.ts`), terrain effects (`terrain.ts`).
- Unit state is struct-of-arrays in `units.ts` (typed arrays) for speed; stats are normalized from the raw roster numbers there.
- **Determinism**: same seed + same inputs ⇒ same state on every client. Randomness only via `Mulberry` (`random.ts`). The state hash is compared every 60 steps online.
- `snapshot.ts` serializes/restores a battle (used for late joiners and desync recovery); new state must be included in `serialize/restore/hash`.
- Stall detector (`testing/stall.ts`) and fuzz tests guard against fights that never end.
- Rules for editing: `.claude/rules/sim-determinism.md`.

## Map guarantees (`Terrain.fixPockets`, `mapsanity.test.ts`)
Every generated map is playable: no walkable tile is unreachable from the main area. Closed-in ground (a plateau or valley ringed by cliffs, an island) gets a ramp when one fits (a gradual slope cut into the higher side; the tiles beside it that end up too high become cliffs), otherwise it is sealed as an obstacle and dressed with rocks (`dressSealed`), e.g. the ridge walls of the valley layout. Everything is applied to the point-mirrored tile too, so maps stay fair, and it only depends on the seed, so all online clients build the same map. The sanity test sweeps all presets, layouts, reliefs and rivers over sizes and seeds: no unreachable walkable ground, point symmetry, bounded sealed ground, roomy team zones for 2/4/6 teams.

