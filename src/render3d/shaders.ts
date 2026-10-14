/** GLSL of the 3D view (WebGL2, via three.js ShaderMaterial). */

/** Camera-facing sprites (soldiers, decor) from the atlas, one instance per sprite; also draws the outline pass. */
export const BILLBOARD_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 iA;   // x, y(up), z, facing
attribute vec4 iB;   // width, height, anchorX, anchorY (from top)
attribute vec4 iUV;  // u0, v0, u1, v1
attribute vec4 iC;   // flash, outline, tint (0xRRGGBB), fade
uniform vec3 uRight;
uniform vec3 uUp;   // leaning up axis (see depth.ts), length = height scale
uniform float uOutline;
uniform float uMargin;
varying vec2 vCorner;
varying vec4 vUv4;
varying vec4 vC;
varying vec3 vTint;
varying float vDist;
void main() {
  vec2 c = corner;
  float grow = 0.0;
  if (uOutline > 0.5) {
    if (iC.y < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    grow = uMargin;
    c = (corner - 0.5) * (1.0 + 2.0 * grow) + 0.5;
  }
  vCorner = c;
  vUv4 = iUV;
  vC = iC;
  // The packed 0xRRGGBB tint is decoded here: interpolating a number near 2^24 across a quad that is tilted against the view
  // rounds it differently per row, which flipped the channels and drew coloured scanlines.
  vTint = vec3(floor(iC.z / 65536.0), mod(floor(iC.z / 256.0), 256.0), mod(iC.z, 256.0)) / 255.0;
  vec2 local = vec2((c.x - iB.z) * iB.x * iA.w, (c.y - (1.0 - iB.w)) * iB.y);
  vec3 world = iA.xyz + uRight * local.x + uUp * local.y;
  vDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  // The whole sprite takes the depth of its feet (nudged toward the camera): it never sinks into terrain in front of or behind
  // it, and sprites sort by where they stand. The depth is constant over the quad, so early-z still works.
  vec3 feet = iA.xyz + normalize(cameraPosition - iA.xyz) * (0.12 + 0.1 * iB.x);
  vec4 fc = projectionMatrix * viewMatrix * vec4(feet, 1.0);
  gl_Position.z = max(fc.z / fc.w, -0.999) * gl_Position.w;
}
`;

export const BILLBOARD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uLight;
uniform float uOutline;
uniform vec3 uOutlineColor;
uniform vec2 uTexel;
varying vec2 vCorner;
varying vec4 vUv4;
varying vec4 vC;
varying vec3 vTint;
varying float vDist;

float alphaAt(vec2 corner) {
  if (corner.x < 0.0 || corner.y < 0.0 || corner.x > 1.0 || corner.y > 1.0) return 0.0;
  return texture2D(uMap, mix(vUv4.xy, vUv4.zw, corner)).a;
}

void main() {
  float fogK = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
  if (uOutline > 0.5) {
    vec2 span = vUv4.zw - vUv4.xy;
    vec2 step = uTexel * 2.0 / span;
    float a = 0.0;
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.7853982;
      a = max(a, alphaAt(vCorner + vec2(cos(ang), sin(ang)) * step));
    }
    if (alphaAt(vCorner) > 0.3 || a < 0.5) discard;
    gl_FragColor = vec4(mix(uOutlineColor, uFogColor, fogK * 0.6), 1.0);
    return;
  }
  vec4 tex = texture2D(uMap, mix(vUv4.xy, vUv4.zw, vCorner));
  float alpha = tex.a * vC.w;
  if (alpha < 0.04) discard;
  vec3 col = tex.rgb;
  col = mix(col, vec3(1.0, 0.55, 0.55), vC.x * 0.55);
  col *= vTint * uLight;
  col = mix(col, uFogColor, fogK);
  gl_FragColor = vec4(col, alpha);
}
`;

/** Soft blob shadows lying on the ground. */
export const SHADOW_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 iS; // x, y(up), z, scale
varying vec2 vP;
varying float vDist;
void main() {
  vP = corner * 2.0 - 1.0;
  vec3 world = vec3(iS.x + vP.x * 0.55 * iS.w, iS.y + 0.04, iS.z + vP.y * 0.4 * iS.w);
  vDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;
export const SHADOW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vP;
varying float vDist;
uniform float uFogDensity;
void main() {
  float r = dot(vP, vP);
  if (r > 1.0) discard;
  float fogK = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
  gl_FragColor = vec4(0.0, 0.0, 0.0, (1.0 - r) * 0.42 * (1.0 - fogK));
}
`;

/** Health bars above damaged soldiers (camera-facing). */
export const BAR_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 iBar; // x, y(up), z (feet), ratio
attribute vec2 iWH;  // bar width, height of the head above the feet
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uLean;
varying vec2 vC;
varying float vRatio;
varying float vDist;
void main() {
  vC = corner;
  vRatio = iBar.w;
  // Above the head of the (leaning) sprite; the bar itself faces the camera.
  vec3 world = iBar.xyz + uLean * iWH.y + uRight * (corner.x - 0.5) * iWH.x + uUp * corner.y * 0.1;
  vDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vec3 feet = iBar.xyz + normalize(cameraPosition - iBar.xyz) * 0.6;
  vec4 fc = projectionMatrix * viewMatrix * vec4(feet, 1.0);
  gl_Position.z = max(fc.z / fc.w, -0.999) * gl_Position.w;
}
`;
export const BAR_FRAG = /* glsl */ `
precision highp float;
varying vec2 vC;
varying float vRatio;
varying float vDist;
uniform vec3 uFogColor;
uniform float uFogDensity;
void main() {
  float edge = 0.06;
  vec3 col = vec3(0.08);
  if (vC.x > edge && vC.x < 1.0 - edge && vC.y > 0.18 && vC.y < 0.82) {
    float f = (vC.x - edge) / (1.0 - 2.0 * edge);
    if (f <= vRatio) col = vRatio > 0.5 ? vec3(0.30, 0.76, 0.36) : vRatio > 0.25 ? vec3(0.90, 0.72, 0.23) : vec3(0.88, 0.27, 0.23);
    else col = vec3(0.2, 0.05, 0.05);
  }
  float fogK = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(col, uFogColor, fogK), 1.0);
}
`;

/** Arrows and magic bolts: quads stretched along the 3D flight direction, facing the camera around that axis. */
export const PROJ_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 iPos; // x, y(up), z, length
attribute vec4 iDir; // dx, dy, dz, style (0 arrow, 1 orb)
attribute vec3 iCol;
varying vec2 vC;
varying vec3 vCol;
varying float vStyle;
varying float vDist;
void main() {
  vec3 axis = normalize(iDir.xyz);
  vec3 toCam = normalize(cameraPosition - iPos.xyz);
  vec3 side = normalize(cross(axis, toCam));
  float w = iDir.w > 0.5 ? 0.34 : 0.07;
  float len = iDir.w > 0.5 ? 0.34 : iPos.w;
  vec3 world = iPos.xyz + axis * (corner.y - 0.5) * len + side * (corner.x - 0.5) * w;
  vC = corner;
  vCol = iCol;
  vStyle = iDir.w;
  vDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;
export const PROJ_FRAG = /* glsl */ `
precision highp float;
varying vec2 vC;
varying vec3 vCol;
varying float vStyle;
varying float vDist;
uniform vec3 uFogColor;
uniform float uFogDensity;
void main() {
  float a;
  if (vStyle > 0.5) {
    vec2 p = vC * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    a = 1.0 - r * 0.6;
  } else {
    // trail: bright head (vC.y = 1) fading toward the tail
    a = mix(0.12, 1.0, pow(vC.y, 2.0));
    if (abs(vC.x - 0.5) > 0.5) discard;
  }
  float fogK = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(vCol, uFogColor, fogK), a);
}
`;

export const FX_VERT = /* glsl */ `
attribute vec2 corner;
attribute vec4 iA; // x, y(up), z, size
attribute vec4 iB; // uv rect
attribute vec4 iC; // color, alpha
attribute vec3 iO; // x offset (glyph sizes), unused, number flag
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uNumScale;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  float s = iA.w * (iO.z > 0.5 ? uNumScale : 1.0);
  vec2 c = corner - 0.5 + vec2(iO.x, 0.0);
  vec3 world = iA.xyz + (uRight * c.x + uUp * c.y) * s;
  vUv = vec2(iB.x + corner.x * iB.z, corner.y);
  vCol = iC;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;
export const FX_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uFxMap;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 t = texture2D(uFxMap, vUv);
  float a = t.a * vCol.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(t.rgb * vCol.rgb, a);
}
`;

export const WATER_VERT = /* glsl */ `
varying vec3 vWorld;
varying float vDist;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vDist = length(w.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
export const WATER_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorld;
varying float vDist;
uniform float uTime;
uniform vec3 uWater;
uniform vec3 uShine;
uniform vec3 uFogColor;
uniform float uFogDensity;
void main() {
  float w = sin(vWorld.x * 1.9 + uTime * 1.3) * sin(vWorld.z * 1.5 - uTime * 0.9) * 0.5 + 0.5;
  float w2 = sin((vWorld.x + vWorld.z) * 3.1 + uTime * 2.1) * 0.5 + 0.5;
  vec3 col = mix(uWater, uShine, w * 0.28 + w2 * 0.12);
  float fogK = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(col, uFogColor, fogK), 0.74);
}
`;
