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
