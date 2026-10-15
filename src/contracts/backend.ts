import type { Atlas } from '../render/atlas';
import type { SimBackend } from '../sim/backend';
import type { BattleConfig, SimEvent } from '../sim/battle';
import type { Terrain } from '../sim/terrain';

/**
 * The seam between the game UI (editor, placement, online cursors, battle HUD) and the way the world is drawn.
 * `WorldView` (PixiJS, isometric) and `World3D` (Three.js, `src/render3d/world3d.ts`) both implement it, so every screen
 * works the same in 2D and 3D. Positions are always map tile coordinates.
 */

/** A soldier shown on the map while armies are being placed. */
export interface PlacedLike {
  team: number;
  kind: number;
  x: number;
  y: number;
}

/** A set of placed soldiers drawn on the map (own army or other players' armies). */
export interface PlacedLayer {
  /** Adds or moves the soldier stored under `key`. */
  set(key: unknown, u: PlacedLike): void;
  drop(key: unknown): void;
  clear(): void;
  has(key: unknown): boolean;
  /** Empties the layer and releases it for good (the world forgets it); the layer is not used afterwards. */
  destroy(): void;
}

/** The brush ring under the cursor. */
export interface GhostSpec {
  x: number;
  y: number;
  radius: number;
  color: number;
  /** Placement is not valid here (red). */
  bad: boolean;
  erase: boolean;
}

/** One team's placement zone: the tiles to tint. */
export interface ZoneSpec {
  color: number;
  /** The player's own zone (stronger tint). */
  mine: boolean;
  /** An objective area (control point): drawn more clearly than a placement zone. */
  strong?: boolean;
  tiles: Array<[number, number]>;
}

export interface WorldBackend {
  /** The element that receives pointer input (editor strokes, camera, cursors). */
  readonly canvas: HTMLCanvasElement;
  terrain: Terrain | null;
  mapSize: number;
  /** Visible size in CSS pixels. */
  size(): { w: number; h: number };
  /** Rebuilds the map (ground, water, bridges, decor). */
  rebuild(config: BattleConfig, atlas: Atlas | null, decor: boolean, ground?: boolean): void;
  /** The atlas was re-baked (palette / kinds changed). */
  setAtlas(atlas: Atlas, decor: boolean): void;
  /** Map tile under a client position (not clamped to the map). */
  pick(clientX: number, clientY: number): { x: number; y: number };
  /** Client position of a map tile position. */
  toClient(x: number, y: number): { x: number; y: number };
  setGhost(g: GhostSpec | null): void;
  setZones(zones: ZoneSpec[] | null): void;
  createPlacedLayer(): PlacedLayer;
}

/** The battle drawing of the 3D world (units, projectiles, effects). The 2D battle keeps its own PixiJS renderers. */
export interface Battle3D {
  /** A battle starts or restarts: drop old effects. */
  reset(): void;
  /** The battle was left: the world shows the editor again. */
  end(): void;
  /** Hit sparks, dust and floating numbers from this frame's sim events. */
  events(ev: readonly SimEvent[], dt: number, o: { numbers: boolean; particles: boolean }): void;
  /** Draws units and projectiles (interpolated by alpha) and renders the frame. */
  draw(sim: SimBackend, alpha: number, dt: number, o: { focusTeam: number; bars: boolean }): { projectiles: number; draws: number; tris: number };
}

export interface CameraBackend {
  /** While false, input is ignored (automatic benchmark). */
  enabled: boolean;
  /** While true (battle), one finger pans as well. */
  singleFingerPan: boolean;
  /** Fingers on the screen: 2+ means camera movement, not painting. */
  readonly touchCount: number;
  /** Zoom factor read by sound and effect gating (larger = closer). */
  readonly audioZoom: number;
  setMap(size: number): void;
  /** Fits the whole map on screen. */
  fit(screenW: number, screenH: number): void;
  zoomBy(factor: number): void;
  update(dt: number): void;
  /** Screen position (client-relative to the canvas) of a map position, for sound panning and culling. */
  project(x: number, y: number): { sx: number; sy: number };
  shake(amount: number): void;
  punch(amount: number): void;
}
