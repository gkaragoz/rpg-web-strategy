import * as THREE from 'three';
import { Texture, type Renderer } from 'pixi.js';
import type { Atlas } from '../render/atlas';
import type { DecorKind } from '../sim/terrain';
import { KIND_COUNT, MAX_TEAMS } from '../sim/units';
import { POSES, PX_WORLD, newFrameTable, unitFrame, type FrameTable } from './billboards';

export const DECOR_KINDS: DecorKind[] = ['tree', 'rock', 'boulder', 'house', 'wall', 'rubble', 'tower', 'keep'];
const DECOR_VARIANTS = 8;

/** Index of a decor sprite in the decor frame table. */
export const decorFrame = (kind: DecorKind, variant: number): number => DECOR_KINDS.indexOf(kind) * DECOR_VARIANTS + (variant % DECOR_VARIANTS);

export interface AtlasGpu {
  texture: THREE.CanvasTexture;
  units: FrameTable;
  decor: FrameTable;
  /** Atlas size in pixels (for the outline shader's texel step). */
  width: number;
  height: number;
  dispose(): void;
}

function fillFrame(t: FrameTable, i: number, tex: Texture, ax: number, ay: number): void {
  const uvs = tex.uvs;
  // Pixi texture space has the origin at the top-left; three.js (flipY) at the bottom-left.
  t.uv[i * 4] = uvs.x0;
  t.uv[i * 4 + 1] = 1 - uvs.y2;
  t.uv[i * 4 + 2] = uvs.x2;
  t.uv[i * 4 + 3] = 1 - uvs.y0;
  t.anchor[i * 2] = ax;
  t.anchor[i * 2 + 1] = ay;
  t.size[i * 2] = tex.frame.width * PX_WORLD;
  t.size[i * 2 + 1] = tex.frame.height * PX_WORLD;
  t.has[i] = 1;
}

/**
 * Moves the 2D atlas to the GPU of the 3D view: the baked sheet is read back into a canvas (the art is identical to the 2D game)
 * and every sprite frame gets UV rectangle, anchor and world size.
 */
export function atlasToGpu(renderer: Renderer, atlas: Atlas): AtlasGpu {
  const first = atlas.unitTex.find((t) => t !== undefined);
  if (!first) throw new Error('empty atlas');
  const source = first.source;
  const full = new Texture({ source });
  const canvas = renderer.extract.canvas({ target: full, resolution: source.resolution }) as HTMLCanvasElement;
  full.destroy(false);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 1;

  const units = newFrameTable(KIND_COUNT * MAX_TEAMS * POSES);
  for (const kind of atlas.kinds) {
    for (let team = 0; team < MAX_TEAMS; team++) {
      for (let pose = 0; pose < POSES; pose++) {
        const i = unitFrame(kind, team, pose);
        const tex = atlas.unitTex[i];
        const an = atlas.unitAnchor[i];
        if (tex && an) fillFrame(units, i, tex, an.ax, an.ay);
      }
    }
  }
  const decor = newFrameTable(DECOR_KINDS.length * DECOR_VARIANTS);
  DECOR_KINDS.forEach((k, ki) => {
    const list = atlas.decor[k];
    for (let v = 0; v < DECOR_VARIANTS; v++) {
      const spr = list[v % Math.max(1, list.length)];
      if (spr) fillFrame(decor, ki * DECOR_VARIANTS + v, spr.texture, spr.ax, spr.ay);
    }
  });
  return {
    texture,
    units,
    decor,
    width: canvas.width,
    height: canvas.height,
    dispose: () => texture.dispose(),
  };
}
