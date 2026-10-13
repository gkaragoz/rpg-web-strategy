# Performance notes

Goal: 20 000 – 30 000 soldiers in an online battle.

## Measuring
- `npm run bench:sim -- --units 3000,10000,30000 --steps 100 [--dbg] [--teams 2] [--size 256]` — headless simulation cost per step and per phase (`Battle.prof`), plus the end-state `hash` (identical hash before/after an optimisation = identical results). Output goes to `.bench/<name>.json`.
- CPU profile of the same run: `node --cpu-prof --cpu-prof-dir=.bench/prof scripts/bench-sim.mjs …` then `node scripts/prof-top.mjs`.
- Browser: `?bench=10000&auto=30` (units per team) prints `window.__benchResult`; `?sim=main` forces the main-thread sim.

## Architecture decisions
- **Online simulation runs in the Web Worker** (`src/net/lockstepWorkerSim.ts`, extends `WorkerSim`): the lockstep runner stays on the main thread and tells the worker how many steps to run each frame; hashes and snapshots come back asynchronously (`SimLike.onHash/restorePacked/snapshotPacked`). Needs `SharedArrayBuffer` (cross-origin isolation: dev/LAN servers send COOP/COEP, GitHub Pages uses `coi-sw.js`); without it the old main-thread `LockstepSim` is used. The runner stops queuing steps when the worker has more than `MAX_PENDING` unfinished ones.
- **Host placement validation is O(1)** per unit (`src/net/placeIndex.ts`: per-team spent/count and a spatial hash for the "too close" test); before, every placed unit scanned all units.
- **A\*** (`Terrain.findPath`) uses a reusable typed-array heap and a precomputed walkable mask; same results, ~20 % cheaper per call. The sim spends its 24-paths-per-step budget constantly while armies march, so path requests are the biggest fixed cost.

## Baseline (map 256, 2 teams, 100 steps, laptop)
| units | ms/step before | ms/step after |
|---|---|---|
| 3 000 | 11.5 | 9.1 |
| 10 000 | 14.7 | 13.3 |
| 30 000 | 25.1 | 25.4 |

## Browser benchmark (`?bench=15000&auto=12`, 30 000 units, whole map in view, worker sim)
| | before | after |
|---|---|---|
| render ms/frame | 9.8 | 7.1 |
| fps | 99 | 137 |
| sim ms/step (browser) | 36 | 34 (realtime factor 0.84 → 0.90) |

Render changes (`src/render/massRenderer.ts`): units outside the view are rejected before the terrain elevation lookup (`maxRise`/`minRise` bound the on-screen y), and below zoom 0.3 (`FAR_ZOOM`) units use an idle-pose fast path without walk/strike animation math.

## What is left (ideas, measured profile is flat at 30 000 units)
`updateUnit` 12 %, `moveToward` 11 %, `separate` 9 %, `pickTarget` 7 %, terrain `walkable`/`lineWalkable` 11 %, A* ~4 %. Next candidates: time-slice route/path refresh per unit, an alive-index list instead of scanning dead slots, shared flow fields instead of per-unit line-of-sight checks, a lower sim rate for huge armies. Each changes results (still deterministic) and needs a balance re-check.

