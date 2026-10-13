# Architecture

PixiJS v8 + Vite + TypeScript. The game is an isometric auto-battler: place armies in the studio, then watch a deterministic simulation play out.

| Layer | Path | Role |
|---|---|---|
| Simulation | `src/sim` | Pure, deterministic battle engine (`battle.ts`), SoA unit/projectile storage, terrain, roster data. Runs inline or in a Web Worker (`backend.ts`, `worker.ts`). No DOM. |
| Rendering | `src/render` | Pixi views: `massRenderer` (instanced crowd), `unitView` (detailed sprites + attack poses), `looks` (per-unit recipes), terrain/biome, fx, audio, comedy ragdolls. |
| App / UI | `src/app` | Studio (placement, unit gallery, map picker), battle HUD, language picker, bottom-bar layout vars, unit previews. |
| Online | `src/net`, `src/app/online`, `relay/` | Host-authoritative lobby, lockstep sync, WebSocket (LAN/relay) and WebRTC transports. See [ONLINE.md](ONLINE.md). |
| i18n | `src/i18n.ts`, `src/i18n/*` | `t()` tables, English default + Turkish. See [UI.md](UI.md). |
| Entry | `src/main.ts` | Wires the Pixi app, icon baking, studio, battle, online app. |

Data flow: studio state (`state.ts`, persisted in localStorage) → `Battle` created from armies + map spec → worker/inline backend steps the sim at a fixed rate → renderer reads snapshots each frame.

See also: [SIMULATION.md](SIMULATION.md), [UNITS.md](UNITS.md), [TESTING.md](TESTING.md), [RELEASING.md](RELEASING.md).
