# 3D view (prototype)

A second page, `/3d/` (`3d/index.html` → `src/render3d/main3d.ts`), draws the same battles with Three.js: a polygonal terrain mesh built from the
height field, billboard soldiers (GPU instancing, up to 30 000), sun light + shadow map + fog, and a free camera (rotate, tilt, zoom).
Live: https://gkaragoz.github.io/rpg-web-strategy/3d/

The simulation is untouched: the page only **reads** a `SimBackend` (`units`, `projectiles`, `winner`, ...), so results and determinism are
identical to the 2D game for the same config and seed (checked: a watched online battle ends with exactly the host's survivors).

## Modules (`src/render3d/`)
| File | Purpose |
|---|---|
| `terrainMesh.ts` | pure: per-tile quads from `Terrain.vh`, water sunk, bridge decks lifted, shore walls, biome colors |
| `pick.ts` | pure: camera ray vs the height field (march + bisection) |
| `cameraRig.ts` | pure: focus/yaw/tilt/dist rig, clamps, pan axes |
| `billboards.ts` | pure: writes instance arrays (position, uv, pose, tint, bars, shadows) from a units view |
| `atlasBridge.ts` | the 2D atlas (baked by a hidden Pixi app) → `CanvasTexture` + frame tables |
| `shaders.ts` | billboard (with outline pass), blob shadow, health bar, projectile, water |
| `scene3d.ts` | `View3D`: renderer, lights, meshes, picking, camera |
| `controls.ts` | mouse / touch / keyboard camera and paint tools |
| `formation.ts` | army fill inside team zones |
| `watch.ts` | joins an online room as a spectator (LAN → relay → WebRTC) |
| `main3d.ts` | panel, edit/battle/watch modes, main loop; `window.__v3` for automation |

## Using it
- Offline: pick map/seed/size/teams, fill armies or paint them (Place/Erase tools), Start. URL shortcuts: `?map=&seed=&size=&teams=&per=&auto=1&speed=`.
- Online: type a room code under "Watch online" (or `?watch=CODE`). The page follows the lobby: map and placed armies during placement,
  the lockstep battle itself afterwards (rematch included). Spectating only; the protocol is unchanged.
- Camera: right-drag rotate + tilt, wheel zoom, middle-drag / Look tool pan, WASD, Q/E, R/F; touch: drag, pinch, twist.
- The sim worker (and helper threads) needs cross-origin isolation; the page loads `../coi-register.js` like the game and falls back to the main thread.

## Measurements (dev machine / phone)
- PC: 165 fps small map; 30 000 soldiers on a 256 map ≈ 150 fps (sim worker 24 ms/step at 20 Hz).
- Phone (Chrome via adb): 60 fps with 4 000 soldiers; online spectating over the relay also 60 fps.

## Gaps / next steps
- No hit particles or damage numbers yet; terrain lighting is simple (flat shading + shadow map).
- Spectator only: no placing or hosting from the 3D page.
- Water is a flat shader plane; no depth-based foam.
