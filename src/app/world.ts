import { Container, Graphics, Sprite } from 'pixi.js';
import { isoX, isoY } from '../iso';
import type { Atlas } from '../render/atlas';
import { PALETTES } from '../render/biome';
import { bandPlanFor, bandZ, computeCover, computeLift, coverAt, DepthBoxIndex, liftAt } from '../render/depthSort';
import { buildGround } from '../render/ground';
import { buildTerrainOverlay, drawRoadTile } from '../render/terrainView';
import { POSES } from '../render/unitView';
import { mapSizeFor, terrainFor, unitCapacity, type BattleConfig } from '../sim/battle';
import { LEVEL_PX, type Terrain } from '../sim/terrain';
import { MAX_TEAMS } from '../sim/units';
import type { GhostSpec, PlacedLayer, PlacedLike, WorldBackend, ZoneSpec } from './backend';

/** Screen ellipse of a circle: radius r tiles -> rx = r*TILE_W/2*sqrt2, ry = rx/2. */
const ELLIPSE_X = 45.25;
/** Zone tiles that terrain in front hides by more than this many pixels are not drawn. */
const ZONE_HIDDEN_PX = 10;

/** What the renderers need to order things against the terrain and the big decor (see render/depthSort.ts). */
export interface DepthInfo {
  /** Origin sums of the relief depth bands, ascending (empty on flat maps). */
  cuts: number[];
  boxes: DepthBoxIndex;
  /** Per tile: pixels of terrain in front that hide a ground point (0 on flat maps). */
  cover: Float32Array;
  /** Per tile: key raise of entities standing there (1 where no terrain in front hides them; see computeLift). */
  lift: Uint8Array;
  size: number;
}

/**
 * The world shared by the scenes: flat ground + river/bridge layer (static), the sorted entity layer (units, decor sprites and
 * the relief ground bands, sorted by zIndex = x+y) and the effects layer. This is the PixiJS (isometric 2D) implementation of `WorldBackend`.
 */
export class WorldView implements WorldBackend {
  readonly root = new Container();
  readonly staticLayer = new Container();
  /** Unit shadows/arrow shadows: below the units. */
  readonly shadowLayer = new Container();
  /** Units, (in detailed mode) decor sprites and the relief ground bands live here, sorted by zIndex = x+y. */
  readonly entityLayer = new Container();
  readonly fxLayer = new Container();
  terrain: Terrain | null = null;
  mapSize = 56;
  private atlas: Atlas | null = null;
  private decorSprites: Sprite[] = [];
  private bandGfx: Graphics[] = [];
  depth: DepthInfo = { cuts: [], boxes: new DepthBoxIndex(1, []), cover: new Float32Array(1), lift: new Uint8Array(1), size: 1 };
  private readonly zoneGfx = new Graphics();
  private readonly ghostGfx = new Graphics();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.entityLayer.sortableChildren = true;
    this.root.addChild(this.staticLayer, this.shadowLayer, this.entityLayer, this.fxLayer);
    this.fxLayer.addChild(this.zoneGfx, this.ghostGfx);
  }

  size(): { w: number; h: number } {
    return { w: this.canvas.clientWidth || window.innerWidth, h: this.canvas.clientHeight || window.innerHeight };
  }

  /** Rebuilds the map (ground, river, bridge). decorSprites: whether decor is added as Sprites. */
  rebuild(config: BattleConfig, atlas: Atlas | null, decorSprites: boolean, ground = true): void {
    for (const s of this.decorSprites) s.destroy();
    this.decorSprites = [];
    for (const c of this.staticLayer.removeChildren()) c.destroy({ children: true, context: true });
    for (const b of this.bandGfx) b.destroy();
    this.bandGfx = [];

    this.atlas = atlas;
    this.mapSize = mapSizeFor(config);
    this.terrain = terrainFor(config);
    const t = this.terrain;
    const parts = ground ? buildGround(this.mapSize, PALETTES[config.map?.biome ?? 'forest'], t, bandPlanFor(unitCapacity(config))) : null;
    if (parts) this.staticLayer.addChild(parts.base);
    // Road tiles on terrain with relief belong to their depth band (otherwise the band would cover them).
    if (t) this.staticLayer.addChild(buildTerrainOverlay(t, parts ? (idx) => parts.bandOfTile.has(idx) : undefined));
    if (t && parts) {
      for (const idx of t.pathTiles) {
        const bg = parts.bandOfTile.get(idx);
        if (bg) drawRoadTile(bg, t, idx);
      }
    }
    const cuts: number[] = [];
    if (parts) {
      for (const [key, g] of parts.bands) {
        g.zIndex = bandZ(key);
        this.entityLayer.addChild(g);
        this.bandGfx.push(g);
        cuts.push(key);
      }
      cuts.sort((a, b) => a - b);
    }
    const lift = t && t.hasRelief && cuts.length > 0 ? computeLift(this.mapSize, (x, y) => t.elevPx(x, y), t.maxH * LEVEL_PX) : new Uint8Array(this.mapSize * this.mapSize);
    this.depth = {
      cuts,
      boxes: new DepthBoxIndex(this.mapSize, t ? t.decor : [], (x, y) => liftAt(lift, this.mapSize, x, y)),
      cover: t && t.hasRelief ? computeCover(this.mapSize, (x, y) => t.elevPx(x, y), t.maxH * LEVEL_PX) : new Float32Array(this.mapSize * this.mapSize),
      lift,
      size: this.mapSize,
    };
    if (this.terrain && atlas && decorSprites) this.addDecor(this.terrain, atlas);
  }

  /** When the palette changes the atlas is renewed: rebuilds the decor sprites with the new textures. */
  setAtlas(atlas: Atlas, decorSprites: boolean): void {
    for (const s of this.decorSprites) s.destroy();
    this.decorSprites = [];
    this.atlas = atlas;
    if (this.terrain && decorSprites) this.addDecor(this.terrain, atlas);
  }

  private addDecor(t: Terrain, atlas: Atlas): void {
    for (const d of t.decor) {
      const list = atlas.decor[d.kind];
      const spr9 = list[d.variant % list.length];
      const s = new Sprite(spr9.texture);
      s.anchor.set(spr9.ax, spr9.ay);
      s.position.set(isoX(d.x, d.y), isoY(d.x, d.y, t.elevPx(d.x, d.y)));
      s.zIndex = d.x + d.y + liftAt(this.depth.lift, this.mapSize, d.x, d.y);
      this.entityLayer.addChild(s);
      this.decorSprites.push(s);
    }
  }

  /** Depth sort key of something standing at (x, y): x+y, raised above the big decor (houses, towers, keep) it stands in front of. */
  depthKey(x: number, y: number): number {
    return this.depth.boxes.frontKey(x, y, x + y + liftAt(this.depth.lift, this.depth.size, x, y), 0.01);
  }

  /** Pixels of terrain in front that hide a ground point (a ridge between the point and the camera); 0 on flat maps. */
  coverAt(x: number, y: number): number {
    return coverAt(this.depth.cover, this.depth.size, x, y);
  }

  // ---- WorldBackend: picking ----

  /** Terrain height (screen pixels) at a map position; 0 without relief. */
  elevAt(x: number, y: number): number {
    const t = this.terrain;
    return t && t.hasRelief ? t.elevPx(Math.min(this.mapSize, Math.max(0, x)), Math.min(this.mapSize, Math.max(0, y))) : 0;
  }

  pick(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.root.toLocal({ x: clientX - rect.left, y: clientY - rect.top });
    // On elevated terrain the screen point shifts up by the elevation: correct it iteratively.
    let x = p.x / 64 + p.y / 32;
    let y = p.y / 32 - p.x / 64;
    const t = this.terrain;
    if (t && t.hasRelief) {
      for (let k = 0; k < 3; k++) {
        const e = this.elevAt(x, y);
        x = p.x / 64 + (p.y + e) / 32;
        y = (p.y + e) / 32 - p.x / 64;
      }
    }
    return { x, y };
  }

  toClient(x: number, y: number): { x: number; y: number } {
    const g = this.root.toGlobal({ x: isoX(x, y), y: isoY(x, y, this.elevAt(x, y)) });
    const rect = this.canvas.getBoundingClientRect();
    return { x: g.x + rect.left, y: g.y + rect.top };
  }

  // ---- WorldBackend: editor / placement visuals ----

  setGhost(s: GhostSpec | null): void {
    const g = this.ghostGfx;
    g.clear();
    if (!s) return;
    const cx = isoX(s.x, s.y);
    const cy = isoY(s.x, s.y, this.elevAt(s.x, s.y));
    const col = s.bad ? 0xe0463b : s.color;
    g.ellipse(cx, cy, s.radius * ELLIPSE_X, (s.radius * ELLIPSE_X) / 2).fill({ color: col, alpha: 0.18 }).stroke({ width: 2, color: col, alpha: 0.9 });
    if (s.erase) {
      g.moveTo(cx - 8, cy - 4).lineTo(cx + 8, cy + 4).moveTo(cx - 8, cy + 4).lineTo(cx + 8, cy - 4).stroke({ width: 2, color: 0xe0463b });
    }
  }

  setZones(zones: ZoneSpec[] | null): void {
    const g = this.zoneGfx;
    g.clear();
    if (!zones) return;
    const t = this.terrain;
    const e = (x: number, y: number): number => (t && t.hasRelief ? t.elevPx(x, y) : 0);
    const p = (x: number, y: number): [number, number] => [isoX(x, y), isoY(x, y, e(x, y))];
    for (const z of zones) {
      for (const [tx, ty] of z.tiles) {
        // Behind a ridge or mountain: the terrain in front hides the tile (the overlay is not depth sorted).
        if (this.coverAt(tx + 0.5, ty + 0.5) > ZONE_HIDDEN_PX) continue;
        const a = p(tx, ty);
        const b = p(tx + 1, ty);
        const c = p(tx + 1, ty + 1);
        const d = p(tx, ty + 1);
        g.poly([a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]]).fill({ color: z.color, alpha: z.mine ? 0.26 : 0.1 });
      }
    }
  }

  createPlacedLayer(): PlacedLayer {
    return new PixiPlacedLayer(this);
  }

  /** Sprite of a placed soldier (used by the layers below). */
  placedSprite(u: PlacedLike): Sprite | null {
    const atlas = this.atlas;
    if (!atlas) return null;
    const idx = (u.kind * MAX_TEAMS + u.team) * POSES;
    const tex = atlas.unitTex[idx] ?? atlas.unitTex[u.kind * MAX_TEAMS * POSES];
    const anc = atlas.unitAnchor[idx] ?? atlas.unitAnchor[u.kind * MAX_TEAMS * POSES];
    if (!tex || !anc) return null;
    const spr = new Sprite(tex);
    spr.anchor.set(anc.ax, anc.ay);
    spr.position.set(isoX(u.x, u.y), isoY(u.x, u.y, this.elevAt(u.x, u.y)));
    spr.zIndex = this.depthKey(u.x, u.y);
    // Faces the center of the map.
    const c = this.mapSize / 2;
    spr.scale.x = isoX(c, c) - isoX(u.x, u.y) >= 0 ? 1 : -1;
    return spr;
  }
}

/** Placed soldiers as idle sprites in the entity layer. */
class PixiPlacedLayer implements PlacedLayer {
  private readonly sprites = new Map<unknown, Sprite>();

  constructor(private readonly world: WorldView) {}

  set(key: unknown, u: PlacedLike): void {
    this.drop(key);
    const spr = this.world.placedSprite(u);
    if (!spr) return;
    this.world.entityLayer.addChild(spr);
    this.sprites.set(key, spr);
  }

  drop(key: unknown): void {
    const spr = this.sprites.get(key);
    if (spr) {
      spr.destroy();
      this.sprites.delete(key);
    }
  }

  clear(): void {
    for (const spr of this.sprites.values()) spr.destroy();
    this.sprites.clear();
  }

  has(key: unknown): boolean {
    return this.sprites.has(key);
  }

  destroy(): void {
    this.clear();
  }
}
