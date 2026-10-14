# 3D view

The game has two ways to draw the world: the isometric 2D view (PixiJS) and a 3D view (Three.js): a polygonal terrain mesh built from the
height field, billboard soldiers (GPU instancing, up to 30 000), a low sun with shadow map, fog, hit effects and a free camera.
**It is the same app**: the home menu, studio, lobby, placement dock, battle HUD, damage meter, scoreboard and online flows are the
same DOM code in both views. Switch with the **2D | 3D** buttons next to the language picker (saved in `options.view`), or open
`?view=3d` / `?view=2d` (`/3d/` just redirects to `?view=3d`). The 3D code is loaded lazily, so the 2D bundle is unchanged.

The simulation is untouched: both views only **read** a `SimBackend`, so results and determinism are identical (a 3D host and a 2D
guest see exactly the same battle). Cross-view online play works (3D host + 2D guest and the other way round).

## Architecture
`src/app/backend.ts` (types only) is the seam between the UI and the world drawing:
- `WorldBackend` (`app/world.ts` = PixiJS `WorldView`, `render3d/world3d.ts` = `World3D`): `canvas`, `terrain`, `rebuild`, `setAtlas`,
  `pick(clientX, clientY)` → map tile, `toClient(x, y)`, `setGhost` (brush ring), `setZones` (placement zones), `createPlacedLayer()`
  (soldiers shown while armies are placed). `Editor`, `Placement` and `CursorLayer` only use this interface.
- `CameraBackend` (`camera.ts` = 2D `Camera`, `render3d/camera3d.ts` = `Camera3D`): `touchCount`, `singleFingerPan`, `fit`, `zoomBy`,
  `project` (sound panning), `audioZoom` (sound / effect gating).
- `Battle3D` (implemented by `World3D`): `reset/end`, `events` (hit effects), `draw` (units + projectiles + render). `BattleScene` keeps its
  PixiJS code for 2D and calls `battle3d` instead when it is set; the HUD is shared.
- `main.ts` picks the backend; the hidden Pixi application stays alive in 3D (atlas baking, unit icons, previews).

## Modules (`src/render3d/`)
| File | Purpose |
|---|---|
| `world3d.ts` | `World3D`: `WorldBackend` + `Battle3D` over `View3D`; `EditUnits` (placed soldiers as a units view) |
| `camera3d.ts`, `camControls.ts` | `Camera3D` input; the on-screen rotate / tilt buttons |
| `scene3d.ts` | `View3D`: renderer, lights, meshes, picking, effects |
| `terrainMesh.ts`, `pick.ts`, `cameraRig.ts` | pure: terrain mesh from `Terrain.vh`, ray picking, rig math (`orbitRig`, `pinchRig`) |
| `billboards.ts`, `atlasBridge.ts`, `shaders.ts` | instance writer, 2D atlas → GPU texture, shaders |
| `fx3d.ts` | pure effect pool: hit sparks, dust, bursts, floating damage/heal numbers from sim events |

## Controls
- Mouse: left paint / right erase exactly as in 2D; **middle-drag pans**, **Alt + left-drag rotates and tilts**, wheel zooms to the cursor,
  W A S D / arrows pan, Q/E rotate, R/F tilt. The buttons at the bottom right (↺ ↻ ⤒ ⤓) rotate and tilt.
- Touch: one finger paints (pans in battle), two fingers pinch-zoom, twist-rotate and drag; tilt with the buttons.

## Differences from 2D
The comedy look (ragdolls) and the debug overlay are 2D-only (their buttons are hidden in 3D); health bars follow the Health bars option
(damaged / always → shown, never → hidden). Effects are drawn on top of everything and capped per frame in huge battles.

## Measurements
- PC: 165 fps; 30 000 soldiers on a 256 map ≈ 150 fps (sim worker 24 ms/step at 20 Hz); online 30 000 (two pages) verified in sync.
- Phone (Chrome via adb): 60 fps with ~1 700 soldiers with effects on; touch paint / twist / pinch verified.
