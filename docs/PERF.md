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

## Online at ~28 000 units (v1.16.0, real two-page test)
Two browser pages on one machine (LAN lobby, map 256, 1 000 000 gold, `__session.send({t:'place', ...})` batches to fill both zones: 14k + 14k units). Both pages ran the battle with the sim in the worker; the host page showed 75–77 fps (1 % low 47–55), main thread sim 0.00 ms/frame, no errors. Placing that many units needed two client fixes: `Placement.onMessage('placed')` handled own units one by one (O(n²) with a sprite refresh per unit) and now does one lookup table and one refresh per message.

Wire changes (protocol 10): the start layout is packed (10 bytes per unit, base64: ~13 bytes instead of ~45 characters of JSON per unit); snapshots (`resync`) travel as `[header byte][packed]` and are gzip-compressed when produced by a worker host (1.9 MB → 0.34 MB for 6 000 units after 20 steps); the worker gzips/gunzips off the main thread and handles its commands strictly in arrival order. `placed` lists are sent in batches of 400.

## Adaptive simulation rate (v1.17.0)
Armies of 12 000 soldiers or more run at 20 Hz instead of 30 Hz (`simDtFor` in `src/sim/constants.ts`, derived from the config only so online clients agree). Per-step constants that were tuned at 30 Hz (movement braking, separation decay/gain/step limit, line-of-sight and kite scan intervals) are scaled by `tk = dt * 30` in `Battle.step`; at 30 Hz every factor is exactly 1, so smaller battles are bit-identical to before (bench hashes unchanged). Browser benchmark, 30 000 units: realtime factor 0.90 → 1.00 (20 Hz needs one third less CPU per second of battle). A 20 Hz battle plays out in the same ballpark as a 30 Hz one (`simrate.test.ts`).

## Multi-threaded movement (v1.18.0)
Unit movement (route over bridges, A* path following, heading smoothing, slope speed, obstacle sliding: about 40 % of a step) moved out of `Battle.updateUnit` into `src/sim/mover.ts`. Units now *decide* first (target, attack, state machine) and only queue a move intent (`Units.mv*`); a movement phase at the end of the step executes all intents. A move reads only the unit's own state, its goal and the static terrain and writes only its own state, so the phase runs in **chunks** (`chunkSize`: at most 16, derived from the unit count only) that any thread may take in any order: the result is identical for 0, 1, 3 helper threads.
- `src/sim/movePool.ts` / `moverWorker.ts`: helper Web Workers (created by the page, because a worker blocked in `Atomics.wait` cannot start nested ones) share the unit arrays through SharedArrayBuffers and take chunks from an atomic counter; until they have started the sim thread does all chunks itself. `?threads=N` forces a count (0 = off), default is derived from `navigator.hardwareConcurrency`; only battles of 3 000+ units use helpers.
- Things that used to depend on call order were made order-independent: the shared RNG in the stuck logic became `unitRand(i, step)`, the global A* budget (24 per step) became 2 path requests per chunk, per-unit paths moved from a `Map` into fixed typed arrays (`pathN/pathK/pathPts`, 24 waypoints), and "target unreachable" is recorded in `mvFail` and applied afterwards in unit order. Decisions now see start-of-step positions (the unit loop no longer mixes moved and unmoved units); costs were re-calibrated (`npm run balance:calibrate`) for that.
- Proof: `node scripts/bench-sim.mjs --units 10000 --dt 0.0333333333 --threads 0|3` gives the same `hash` (real `worker_threads` helpers); `movechunks.test.ts` checks chunk-order independence; a LAN match with host `?threads=3` and guest `?threads=0` ended with identical damage/kills tables after 4:16 of battle and no resync.
- Speed (node, map 256): 10 000 units 18.1 → 12.8 ms/step, 30 000 units 39.7 → 32.2 ms/step with 3 helpers. The rest of the step (decisions, target picking, grid, separation) is still serial.

## Target picking and separation in parallel (v1.19.0)
Two more phases run on the helper threads, with the same rule (a chunk is independent of every other chunk):
- **Target picking** (`src/sim/picker.ts`): before the unit loop, every unit that is about to retarget gets its choice computed from start-of-step data (positions, hit points, attacker/healer counts, team grids, terrain) into `pickBest[i]`; the unit loop only applies it (`Battle.pickNow/applyPick`, in unit order) and recomputes inline if the choice died in the meantime. The per-candidate call of the shared RNG became a stateless `pairRand(i, j, step)`.
- **Separation** (`src/sim/separator.ts`): `scan` (each unit sums the push of all its neighbours onto itself, only its own push velocity is written) and `apply` (each unit moves by its own push velocity), two phases with a barrier. The tanks' push of other units stays serial. The grids (team grids and the separation grid) live in shared memory for the helpers.
- `movePool.ts` now dispatches several kernels (`PH_MOVE/PICK/SEP_SCAN/SEP_APPLY`) with per-step inputs written once per step (`setStep`).
- Proof: `bench-sim --threads 0|2|3` gives identical hashes for 10 000 units (2 teams, 30 Hz) and for 12 000 units on 6 teams (20 Hz); `movechunks.test.ts` shuffles the chunk order of all phases; the balance tournament (`npm run balance:quick`) shows 0 problems without re-calibration.
- Speed (node, map 256, 3 helpers): 30 000 units 37.3 → 25.6 ms/step (1.46×, 1.57× against the single-threaded step of v1.17); 10 000 units 17.6 → 12.3 ms/step. What is still serial: the decision loop (timers, attacks, kiting), grid building, the tanks' push, status and projectile updates.

## Grid builds in parallel, finer chunks, no wake-up tax (v1.20.0)
- The team grids and the separation grid are built in parallel (one grid per chunk, `PH_GRID`).
- Chunks: up to 64 (was 16) for better balance. A* searches stay budgeted per chunk so the army as a whole gets about 24-30 per step: few chunks (small armies) get `ceil(24 / chunks)` each step, many chunks one every other step (a first version with a flat budget starved small battles of paths: the fuzz stall detector caught it).
- Chunk hand-out carries the phase tag (`C_NEXT = tag << 16 | index`) and the sim thread returns as soon as all chunks are finished (`C_FIN`): it no longer waits for helpers that are still waking up, and a late helper can never take a chunk of a later phase. Helpers spin for 60 µs after a phase before they sleep.
- **A helper's `Units` object must have the regular property layout** (`new Units(1)` with the fields then pointed at the shared buffers). Building it with `Object.create` + 100 assignments produced a dictionary-mode object and made every kernel on the helper several times slower (30 000 units: 19.0 → 14.7 ms/step from this fix alone).
- Speed (node, map 256, 3 helpers, 20 Hz): 30 000 units 31.4 → 17.1 ms/step (1.8×; 28.1 → 14.7 in an earlier, quieter run); browser benchmark (`?bench=15000`, helpers on): sim 15.6 ms/step, 153 fps. Hashes are identical for 0/2/3 helpers (10 000 units 2 teams at 30 Hz; 12 000 units 6 teams at 20 Hz).
- Still serial and why: the decision loop (about 5 ms at 30 000 units: timers, attacks/projectiles/damage touch other units and global pools), prep (centroids, attacker counts), the tanks' push (writes other units), status/projectile updates. Splitting attacks out of the loop would mean restructuring skills and damage; not worth the risk for the remaining ~2 ms.

## Real online battle with 30 000 soldiers (v1.21.1)
Two browser pages on one machine (LAN lobby, map 256 "desert archipelago" plateau, 1 000 000 gold, both pages with helper threads, 20 Hz): 29 998 soldiers placed through `__session.send` batches (12 270 + 17 728; the room cap is 30 000). The host page ran at 85-109 fps (1 % low 47-66), the simulation at 19.9 steps/s of 20 (average 45.7 ms per step while the second page's simulation competed for the same CPU; about 17 ms alone). After 6:19 of battle both pages showed the identical result table (winner, survivors 8 615 / 17 730, damage 3.6m / 3.3m, kills 12 270 / 9 115) and no errors. A rematch re-sent all 30 000 placements in batches and both pages were back in placement with their formations; this found one bug: after restoring many own units the gold bar was not refreshed on the guest (fixed: `refreshUi()` after adding the units). Old atlases are now freed 300 ms after a re-bake (Pixi warned about a texture destroyed while still bound).

