import { ColorMatrixFilter, Filter, GlProgram, defaultFilterVert } from 'pixi.js';

/**
 * Outline for a display object (used on the detailed unit views): every transparent pixel next to an opaque one
 * is painted in the outline colour. WebGL only (the game forces the WebGL renderer).
 */
const FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputSize;
uniform vec4 uOutline; // rgb = colour, a = thickness in pixels

void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  vec2 px = uOutline.a * uInputSize.zw;
  float a = 0.0;
  a = max(a, texture(uTexture, vTextureCoord + vec2(px.x, 0.0)).a);
  a = max(a, texture(uTexture, vTextureCoord - vec2(px.x, 0.0)).a);
  a = max(a, texture(uTexture, vTextureCoord + vec2(0.0, px.y)).a);
  a = max(a, texture(uTexture, vTextureCoord - vec2(0.0, px.y)).a);
  a = max(a, texture(uTexture, vTextureCoord + px).a);
  a = max(a, texture(uTexture, vTextureCoord - px).a);
  a = max(a, texture(uTexture, vTextureCoord + vec2(px.x, -px.y)).a);
  a = max(a, texture(uTexture, vTextureCoord + vec2(-px.x, px.y)).a);
  float edge = (1.0 - c.a) * a;
  finalColor = c + vec4(uOutline.rgb * edge, edge);
}`;

const THICKNESS = 2.5;
let shared: Filter | null = null;
let colorArr: Float32Array | null = null;

/** The shared outline filter, set to the given colour (0xRRGGBB). One focus team at a time, so one instance is enough. */
export function outlineFilter(color: number): Filter {
  if (!shared) {
    colorArr = new Float32Array([0, 0, 0, THICKNESS]);
    shared = new Filter({
      glProgram: GlProgram.from({ vertex: defaultFilterVert, fragment: FRAGMENT, name: 'unit-outline' }),
      resources: { outlineUniforms: { uOutline: { value: colorArr, type: 'vec4<f32>' } } },
      padding: Math.ceil(THICKNESS) + 1,
    });
  }
  colorArr![0] = ((color >> 16) & 255) / 255;
  colorArr![1] = ((color >> 8) & 255) / 255;
  colorArr![2] = (color & 255) / 255;
  return shared;
}

/** A filter that paints everything with one flat colour but keeps the alpha (for the silhouette layer of crowds). */
export function flatColorFilter(color: number): ColorMatrixFilter {
  const f = new ColorMatrixFilter();
  setFlatColor(f, color);
  return f;
}

export function setFlatColor(f: ColorMatrixFilter, color: number): void {
  const r = ((color >> 16) & 255) / 255;
  const g = ((color >> 8) & 255) / 255;
  const b = (color & 255) / 255;
  // out.rgb = colour, out.a = in.a
  f.matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 1, 0];
}
