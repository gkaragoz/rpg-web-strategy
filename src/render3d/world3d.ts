import type { Renderer } from 'pixi.js';
import type { Battle3D, GhostSpec, PlacedLayer, PlacedLike, WorldBackend, ZoneSpec } from '../app/backend';
import type { Atlas } from '../render/atlas';
import type { SimBackend } from '../sim/backend';
import { mapSizeFor, terrainFor, type BattleConfig, type SimEvent } from '../sim/battle';
import type { Terrain } from '../sim/terrain';
import { atlasToGpu } from './atlasBridge';
import type { UnitsLike } from './billboards';
import { Camera3D } from './camera3d';
import { mountCamControls } from './camControls';
import { View3D } from './scene3d';
import { groundHeight } from './terrainMesh';

/** The soldiers of the editor as a static "units" view: the same writer draws them before and during the battle. */
export class EditUnits implements UnitsLike {
  count = 0;
  kind = new Uint8Array(0);
  team = new Uint8Array(0);
  x = new Float32Array(0);
  y = new Float32Array(0);
  px = this.x;
  py = this.y;
  hp = new Float32Array(0);
  maxHp = new Float32Array(0);
  alive = new Uint8Array(0);
  facing = new Int8Array(0);
  moving = new Uint8Array(0);
  swing = new Float32Array(0);
  flash = new Float32Array(0);
  deathT = new Float32Array(0);
  status = new Uint8Array(0);

  set(list: Iterable<PlacedLike>, n: number): void {
    if (n > this.kind.length) {
      const cap = Math.max(n, 1024);
      this.kind = new Uint8Array(cap);
      this.team = new Uint8Array(cap);
      this.x = new Float32Array(cap);
      this.y = new Float32Array(cap);
      this.px = this.x;
      this.py = this.y;
      this.hp = new Float32Array(cap).fill(1);
      this.maxHp = new Float32Array(cap).fill(1);
      this.alive = new Uint8Array(cap).fill(1);
      this.facing = new Int8Array(cap);
      this.moving = new Uint8Array(cap);
      this.swing = new Float32Array(cap);
      this.flash = new Float32Array(cap);
      this.deathT = new Float32Array(cap);
      this.status = new Uint8Array(cap);
    }
    let i = 0;
    for (const s of list) {
      this.kind[i] = s.kind;
      this.team[i] = s.team;
      this.x[i] = s.x;
      this.y[i] = s.y;
      // Faces the center of the map (the same rule as the 2D editor).
      this.facing[i] = s.x <= s.y ? 1 : -1;
      i++;
    }
    this.count = n;
  }
}

class Layer3D implements PlacedLayer {
  readonly items = new Map<unknown, PlacedLike>();

  constructor(private readonly owner: World3D) {}

  set(key: unknown, u: PlacedLike): void {
    this.items.set(key, { team: u.team, kind: u.kind, x: u.x, y: u.y });
    this.owner.markPlacedDirty();
  }

  drop(key: unknown): void {
    if (this.items.delete(key)) this.owner.markPlacedDirty();
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.owner.markPlacedDirty();
  }

  has(key: unknown): boolean {
    return this.items.has(key);
  }

  destroy(): void {
    this.clear();
    this.owner.removeLayer(this);
  }
}

const NO_PROJECTILES = { count: 0 } as never;

/**
 * The Three.js world: the 3D implementation of `WorldBackend` (map, picking, brush ring, zones, placed soldiers) and of
 * `Battle3D` (units, projectiles and effects of a running battle). Everything else of the game UI is shared with the 2D view.
 */
export class World3D implements WorldBackend, Battle3D {
  readonly view: View3D;
  readonly camera3d: Camera3D;
  readonly canvas: HTMLCanvasElement;
  terrain: Terrain | null = null;
  mapSize = 56;
  private atlas: Atlas | null = null;
  private readonly layers: Layer3D[] = [];
  private readonly edit = new EditUnits();
  private placedDirty = true;
  private inBattle = false;

  constructor(
    private readonly pixi: Renderer,
    host: HTMLElement,
  ) {
    this.view = new View3D(host);
    this.canvas = this.view.renderer.domElement;
    // Same place and stacking as the 2D canvas: under every overlay of the page.
    Object.assign(this.canvas.style, { position: 'fixed', left: '0', top: '0', zIndex: '0' });
    host.prepend(this.canvas);
    this.camera3d = new Camera3D(this.view);
    mountCamControls(this.camera3d);
    window.addEventListener('resize', () => this.view.resize());
    (window as unknown as { __v3: unknown }).__v3 = { view: this.view, world: this };
  }

  markPlacedDirty(): void {
    this.placedDirty = true;
  }

  /** Forgets a layer that its owner (an editor / placement) has finished with. */
  removeLayer(l: Layer3D): void {
    const i = this.layers.indexOf(l);
    if (i >= 0) this.layers.splice(i, 1);
    this.placedDirty = true;
  }

  size(): { w: number; h: number } {
    return { w: this.canvas.clientWidth || window.innerWidth, h: this.canvas.clientHeight || window.innerHeight };
  }

  // ---- WorldBackend ----

  rebuild(config: BattleConfig, atlas: Atlas | null, _decor: boolean, _ground = true): void {
    this.mapSize = mapSizeFor(config);
    this.terrain = terrainFor(config);
    this.useAtlas(atlas);
    if (this.terrain) this.view.setTerrain(this.terrain);
    this.camera3d.setMap(this.mapSize);
  }

  setAtlas(atlas: Atlas, _decor: boolean): void {
    this.useAtlas(atlas);
  }

  private useAtlas(atlas: Atlas | null): void {
    if (!atlas || atlas === this.atlas) return;
    this.atlas = atlas;
    this.view.setAtlas(atlasToGpu(this.pixi, atlas));
  }

  pick(clientX: number, clientY: number): { x: number; y: number } {
    const h = this.view.pick(clientX, clientY);
    return h ? { x: h.x, y: h.z } : { x: -999, y: -999 };
  }

  toClient(x: number, y: number): { x: number; y: number } {
    const t = this.terrain;
    const p = this.view.project(x, t ? Math.max(0, groundHeight(t, x, y)) : 0, y);
    const r = this.canvas.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y + r.top };
  }

  setGhost(g: GhostSpec | null): void {
    const t = this.terrain;
    if (!g || !t || g.x < -900) {
      this.view.setHover(null, 0);
      return;
    }
    const gy = Math.max(0, groundHeight(t, Math.min(this.mapSize, Math.max(0, g.x)), Math.min(this.mapSize, Math.max(0, g.y))));
    this.view.setHover({ x: g.x, y: gy, z: g.y }, Math.max(0.35, g.radius), g.bad ? 0xe0463b : g.color);
  }

  setZones(zones: ZoneSpec[] | null): void {
    this.view.setZones(zones ? zones.map((z, i) => ({ team: i, color: z.color, tiles: z.tiles, mine: z.mine })) : null);
  }

  createPlacedLayer(): PlacedLayer {
    const l = new Layer3D(this);
    this.layers.push(l);
    return l;
  }

  /** The studio / placement frame: placed soldiers and the ground, no battle. */
  render(dt: number): void {
    if (this.inBattle) return;
    if (this.placedDirty) {
      this.placedDirty = false;
      let n = 0;
      for (const l of this.layers) n += l.items.size;
      this.edit.set(
        (function* (layers: Layer3D[]) {
          for (const l of layers) yield* l.items.values();
        })(this.layers),
        n,
      );
    }
    this.view.setOutlineColor(0xffffff);
    this.view.setUnits(this.edit, 1, dt, -1, false);
    this.view.setProjectiles(NO_PROJECTILES, 0);
    this.view.updateFx([], dt, false, false);
    this.view.render(dt);
  }

  // ---- Battle3D ----

  reset(): void {
    this.inBattle = true;
    this.view.clearFx();
  }

  end(): void {
    this.inBattle = false;
    this.view.clearFx();
    this.placedDirty = true;
  }

  events(ev: readonly SimEvent[], dt: number, o: { numbers: boolean; particles: boolean }): void {
    this.view.updateFx(ev, dt, o.numbers, o.particles);
  }

  draw(sim: SimBackend, alpha: number, dt: number, o: { focusTeam: number; bars: boolean }): { projectiles: number; draws: number; tris: number } {
    this.view.setOutlineColor(0xffffff);
    this.view.setUnits(sim.units as UnitsLike, alpha, dt, o.focusTeam, o.bars);
    const p = sim.projectiles;
    this.view.setProjectiles(p, alpha * sim.stepDt);
    let active = 0;
    for (let i = 0; i < p.count; i++) if (p.active[i]) active++;
    this.view.render(dt);
    return { projectiles: active, draws: this.view.info.draws, tris: this.view.info.tris };
  }
}
