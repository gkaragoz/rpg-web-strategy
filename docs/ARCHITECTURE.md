# Architecture

Vite + TypeScript. The game is an isometric auto-battler: place armies in the studio (or in an online lobby), then watch a deterministic simulation play out. The world is drawn either by PixiJS v8 (2D isometric) or by Three.js (3D, lazy chunk); the UI around it is plain DOM and identical in both.

| Layer | Path | Role |
|---|---|---|
| Simulation | `src/sim` | Pure, deterministic battle engine, SoA unit/projectile storage, terrain generation, roster data. Runs inline or in a Web Worker (`backend.ts`, `worker.ts`). No DOM, no UI imports. |
| Contracts | `src/contracts` | Types shared across layers: `WorldBackend` / `CameraBackend` / `Battle3D` (the seam between the UI and the 2D/3D drawing) and `Localized`. |
| Rendering | `src/render`, `src/render3d` | Pixi views (`massRenderer`, `unitView`, `looks`, terrain/biome, fx, audio, comedy) and the Three.js view (`world3d`, `camera3d`, `scene3d`, shaders). |
| App / UI | `src/app` | Studio, battle HUD, unit gallery, map picker, tour, language picker, bottom-bar layout, `scope.ts` (listener/timer cleanup), `hotkeys.ts`. |
| Online | `src/net`, `src/app/online`, `relay/` | Host-authoritative lobby, lockstep sync, WebSocket (LAN/relay) and WebRTC transports. See [ONLINE.md](ONLINE.md). |
| i18n | `src/i18n.ts`, `src/i18n/*` | `t()` tables, English default + Turkish. See [UI.md](UI.md). |
| Entry | `src/main.ts`, `src/debug.ts` | Wires the Pixi app, atlas/icon baking, studio, battle, online app; `debug.ts` gates the `window.__*` hooks. |

Data flow: studio state (`state.ts`, persisted in localStorage) → `Battle` created from armies + map spec → worker/inline backend steps the sim at a fixed rate → the active renderer reads snapshots each frame.

## Dependency rules (enforced by `npm run lint:layers`, part of `check`)

```
sim ──► contracts          sim never imports app, render, render3d, net or i18n
net ──► sim, contracts, i18n
render ──► sim, contracts, i18n, net
render3d ──► sim, contracts, render, i18n
app ──► everything above (never the other way round)
```

Runtime import cycles are rejected too. The sim reaches UI text only through `src/sim/text.ts` (`simText`), whose translator `src/i18n.ts` installs at start-up.

## Simulation internals

`battle.ts` holds the `Battle` class (state, `step`, serialize/restore/hash); the behaviour lives in `battleAi`, `battleSkills`, `battleDamage`, `battleEffects`, `battleSetup` (functions taking the battle). Terrain: `terrain.ts` (class, queries) plus `terrainRelief`, `terrainRiver`, `terrainDecor`, `terrainPath`. See [SIMULATION.md](SIMULATION.md). Any change that alters results is visible in `src/sim/__tests__/golden.test.ts` (committed hashes); regenerate with `GOLDEN_UPDATE=1` only for an intended change.

## Diagnostics

`window.__sim`, `__session`, `__placement`, `__camera`, `__audio`, `__app`, `__world`, `__v3`, `__benchResult` exist only with `?debug` (or `?bench`) in the URL (remembered for the tab session) and in the dev server. Use `setDebug` / `getDebug` from `src/debug.ts` in code; browser tests open pages with `?debug=1&tour=off`.

## Build and budgets

`npm run build` → `dist/` (two entries: the game and the `/3d/` redirect). `node scripts/check-bundle.mjs` enforces size budgets for the main entry, the lazy 3D chunk, the sim worker and the total. CSS is split into ordered parts under `src/app/css/` imported by `src/app/studio.css`.

See also: [SIMULATION.md](SIMULATION.md), [UNITS.md](UNITS.md), [TESTING.md](TESTING.md), [RELEASING.md](RELEASING.md), [RENDER3D.md](RENDER3D.md).
