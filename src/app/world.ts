import { Container, Sprite } from 'pixi.js';
import { isoX, isoY } from '../iso';
import type { Atlas } from '../render/atlas';
import { PALETTES } from '../render/biome';
import { buildGround } from '../render/ground';
import { buildTerrainOverlay } from '../render/terrainView';
import { mapSizeFor, terrainFor, type BattleConfig } from '../sim/battle';
import type { Terrain } from '../sim/terrain';

/**
 * Sahnelerin paylastigi dunya: zemin + nehir/kopru katmani (statik), birim/dekor katmani
 * (zIndex = x+y ile siralanir) ve efekt katmani.
 */
export class WorldView {
  readonly root = new Container();
  readonly staticLayer = new Container();
  /** Birim golgeleri/ok golgeleri: birimlerin altinda. */
  readonly shadowLayer = new Container();
  /** Birimler ve (ayrintili modda) dekor sprite'lari burada, zIndex = x+y ile siralanir. */
  readonly entityLayer = new Container();
  readonly fxLayer = new Container();
  terrain: Terrain | null = null;
  mapSize = 56;
  private decorSprites: Sprite[] = [];

  constructor() {
    this.entityLayer.sortableChildren = true;
    this.root.addChild(this.staticLayer, this.shadowLayer, this.entityLayer, this.fxLayer);
  }

  /** Haritayi (zemin, nehir, kopru) yeniden kurar. decorSprites: dekor Sprite olarak mi eklensin. */
  rebuild(config: BattleConfig, atlas: Atlas | null, decorSprites: boolean, ground = true): void {
    for (const s of this.decorSprites) s.destroy();
    this.decorSprites = [];
    for (const c of this.staticLayer.removeChildren()) c.destroy({ children: true });

    this.mapSize = mapSizeFor(config);
    this.terrain = terrainFor(config);
    if (ground) this.staticLayer.addChild(buildGround(this.mapSize, PALETTES[config.map?.biome ?? 'forest']));
    if (this.terrain) this.staticLayer.addChild(buildTerrainOverlay(this.terrain));
    if (this.terrain && atlas && decorSprites) this.addDecor(this.terrain, atlas);
  }

  /** Palet degisince atlas yenilenir: dekor sprite'larini yeni dokularla yeniden kurar. */
  setAtlas(atlas: Atlas, decorSprites: boolean): void {
    for (const s of this.decorSprites) s.destroy();
    this.decorSprites = [];
    if (this.terrain && decorSprites) this.addDecor(this.terrain, atlas);
  }

  private addDecor(t: Terrain, atlas: Atlas): void {
    for (const d of t.decor) {
      const list = atlas.decor[d.kind];
      const spr9 = list[d.variant % list.length];
      const s = new Sprite(spr9.texture);
      s.anchor.set(spr9.ax, spr9.ay);
      s.position.set(isoX(d.x, d.y), isoY(d.x, d.y));
      s.zIndex = d.x + d.y;
      this.entityLayer.addChild(s);
      this.decorSprites.push(s);
    }
  }
}
