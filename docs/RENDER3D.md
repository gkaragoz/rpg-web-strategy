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
- Mouse: left paint / right erase exactly as in 2D; **middle-drag (or Alt + left-drag) rotates and tilts**, **Shift + middle-drag pans**, wheel zooms to the cursor,
  W A S D / arrows pan, [ ] turn, PageUp/PageDown tilt (Q/E, R and F stay with the studio and battle). The buttons at the bottom right (↺ ↻ ⤒ ⤓) rotate and tilt.
- Touch: one finger paints (pans in battle), two fingers pinch-zoom, twist-rotate and drag; tilt with the buttons.

## Depth and anchoring of sprites
The 2D art is drawn for an isometric view, so a plain camera-facing quad looked wrong in 3D. What the shaders do now:
- **One depth per sprite**: the billboard vertex shader sets the clip depth of every vertex to the depth of the sprite's *feet* (nudged toward the
  camera by `0.12 + 0.1 * width`). Sprites never sink into terrain in front of or behind them (units on slopes were half buried at steep tilts)
  and sort by where they stand; depth stays constant over the quad so early-z still works. Health bars use the same trick.
- **Leaning quads**: the sprite's up axis follows the camera tilt only up to 50 degrees (`MAX_LEAN`), then stays; the height is stretched by
  `1/cos(tilt - lean)` (max 1.35) to keep the screen size. The camera-facing `uUp` is only used by effects and bar thickness.
- **Footprint anchors**: houses, towers, walls and the keep are drawn with the sprite anchored at the footprint *centre* (`footprintOf`; the map stores the
  front corner of the iso diamond), so the base touches the ground on all sides at low tilt instead of floating.
- The packed tint (0xRRGGBB) is decoded in the vertex shader: interpolating a number near 2^24 across a tilted quad rounds per row and drew
  coloured scanlines.

## Game modes in 3D
- `setZones` draws placement zones and Hill control points (`strong`, the clearest tint) as ground tiles; `overlayCornerHeight` puts them on the bridge decks instead of under them.
- `setMarkers` draws VIP rings with a gold cone and CTF flags as a pole with a pennant; they grow with the camera distance (`markerScale`) so they stay readable zoomed out, and the pennant turns toward the camera.
- Structures (siege core, lane castles and towers) and horde monsters are ordinary units: their kinds must be in the baked atlas (`structureKinds`, see `main.ts` / `online.ts`), otherwise `atlasToGpu` has no frame and they fight invisibly.
- `Camera3D.fit` uses `fitDist`: the four map corners (where armies, flags and cores start) are inside the view, like the 2D fit.

## Differences from 2D
The comedy look (ragdolls) and the debug overlay are 2D-only (their buttons are hidden in 3D); health bars follow the Health bars option
(damaged / always → shown, never → hidden). Effects are drawn on top of everything and capped per frame in huge battles.

## Measurements
- PC: 165 fps; 30 000 soldiers on a 256 map ≈ 150 fps (sim worker 24 ms/step at 20 Hz); online 30 000 (two pages) verified in sync.
- Phone (Chrome via adb): 60 fps with ~1 700 soldiers with effects on; touch paint / twist / pinch verified.
