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
| `fx3d.ts` | pure effect pool: hit sparks, dust, bursts, floating damage/heal numbers from sim events (+ glyph atlas) |
| `watch.ts` | host a room, or join one as player/spectator (LAN → relay → WebRTC; `?relay=off` forces WebRTC) |
| `main3d.ts` | panel, edit/battle/watch modes, main loop; `window.__v3` for automation |

## Using it
- Offline: pick map/seed/size/teams, fill armies or paint them (Place/Erase tools), Start. URL shortcuts: `?map=&seed=&size=&teams=&per=&auto=1&speed=`.
- Online: under "Watch online" type a room code (or `?watch=CODE`), optionally tick "Join as player" (`&play=1`) to place armies (paint,
  erase, "Fill armies") and ready up like in the 2D game. "Host room" (`?host=lan|net`) opens a room from the 3D page: the host picks map,
  seed, size, gold and open placement, starts the game, and controls pause/speed/rematch/lobby. The page follows the lobby phases
  (map and placed armies during placement, the lockstep battle afterwards, rematches). The protocol is unchanged.
- Effects: hit sparks, dust, shock rings, element bursts and floating damage/heal numbers are drawn from `sim.events` near the camera
  (toggles "Damage numbers" / "Hit effects", `?numbers=0`, `?fx=0`).
- Camera: right-drag rotate + tilt, wheel zoom, middle-drag / Look tool pan, WASD, Q/E, R/F; touch: drag, pinch, twist.
- The sim worker (and helper threads) needs cross-origin isolation; the page loads `../coi-register.js` like the game and falls back to the main thread.

## Measurements (dev machine / phone)
- PC: 165 fps small map; 30 000 soldiers on a 256 map ≈ 150 fps (sim worker 24 ms/step at 20 Hz).
- Phone (Chrome via adb): 60 fps with 4 000 soldiers with effects on; online spectating over the relay also 60 fps.
- Online 30 000: two 3D pages (host + player, 15 000 each, 256 map) fill, ready and fight in lockstep at 165 fps (host); both pages end with identical survivors. 3D host + 2D guest over LAN, relay and WebRTC all produce the same results as the 2D scoreboard.

## Gaps / next steps
- Effects are drawn on top of everything (no depth test) and numbers are capped per frame in huge battles.
- Water is a flat shader plane; no depth-based foam. Lighting is a low sun with flat shading and a shadow map (no ambient occlusion).
- The host UI of the 3D page is minimal (no password, banned rarities, placement timer or kick/mute; use the 2D lobby for those).
