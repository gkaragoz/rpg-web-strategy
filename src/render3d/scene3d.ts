import * as THREE from 'three';
import { PALETTES } from '../render/biome';
import { projStyle } from '../render/projectileStyle';
import type { ProjView } from '../sim/backend';
import type { Terrain } from '../sim/terrain';
import { STATS } from '../sim/units';
import { type AtlasGpu, decorFrame } from './atlasBridge';
import { PX_WORLD, UnitInstances, type UnitsLike } from './billboards';
import { clampRig, eyeOf, type Rig } from './cameraRig';
import { pickGround, type GroundHit } from './pick';
import {
  BAR_FRAG,
  BAR_VERT,
  BILLBOARD_FRAG,
  BILLBOARD_VERT,
  PROJ_FRAG,
  PROJ_VERT,
  SHADOW_FRAG,
  SHADOW_VERT,
  WATER_FRAG,
  WATER_VERT,
} from './shaders';
import { groundHeight, terrainGeometry } from './terrainMesh';

export interface ZoneOverlay {
  team: number;
  color: number;
  /** Tiles (x, y) of the zone that are valid placements. */
  tiles: Array<[number, number]>;
}

const QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_INDEX = [0, 1, 2, 0, 2, 3];

function quadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('corner', new THREE.BufferAttribute(QUAD, 2));
  g.setIndex(QUAD_INDEX);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3)); // three.js wants a position attribute for bounds
  return g;
}

function instAttr(g: THREE.InstancedBufferGeometry, name: string, data: Float32Array, size: number): void {
  const a = new THREE.InstancedBufferAttribute(data, size);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
}

function touch(g: THREE.InstancedBufferGeometry, names: string[], count: number): void {
  for (const n of names) (g.getAttribute(n) as THREE.InstancedBufferAttribute).needsUpdate = true;
  g.instanceCount = count;
}

/**
 * The 3D world: terrain mesh from the height field, water, billboard soldiers/decor (GPU instancing), blob shadows, health
 * bars, projectiles, lights/shadow/fog and an orbit camera. It only reads simulation data.
 */
export class View3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.3, 1200);
  rig: Rig = { fx: 28, fz: 28, yaw: Math.PI / 4, tilt: (48 * Math.PI) / 180, dist: 60 };
  terrain: Terrain | null = null;
  size = 56;
  /** Stats shown on the panel. */
  info = { draws: 0, tris: 0 };
  private readonly sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
  private readonly hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b5a3c, 1.1);
  private terrainMesh: THREE.Mesh | null = null;
  private water: THREE.Mesh | null = null;
  private zoneMesh: THREE.Mesh | null = null;
  private hover: THREE.Mesh;
  private gpu: AtlasGpu | null = null;
  private inst: UnitInstances;
  private unitGeo = quadGeometry();
  private unitMat: THREE.ShaderMaterial;
  private outlineMat: THREE.ShaderMaterial;
  private unitMesh: THREE.Mesh;
  private outlineMesh: THREE.Mesh;
  private shadowGeo = quadGeometry();
  private shadowMesh: THREE.Mesh;
  private barGeo = quadGeometry();
  private barMesh: THREE.Mesh;
  private decorGeo = quadGeometry();
  private decorMesh: THREE.Mesh | null = null;
  private decorShadowGeo = quadGeometry();
  private decorShadowMesh: THREE.Mesh | null = null;
  private projGeo = quadGeometry();
  private projMesh: THREE.Mesh;
  private projPos = new Float32Array(0);
  private projDir = new Float32Array(0);
  private projCol = new Float32Array(0);
  private waterMat: THREE.ShaderMaterial | null = null;
  private time = 0;
  private fogColor = new THREE.Color(0x1a2332);
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  private readonly uniforms = {
    uRight: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uFogColor: { value: new THREE.Color(0x1a2332) },
    uFogDensity: { value: 0.0045 },
  };

  constructor(readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.touchAction = 'none';
    this.renderer.domElement.style.display = 'block';
    host.appendChild(this.renderer.domElement);
    this.scene.background = this.fogColor;
    this.scene.fog = new THREE.FogExp2(0x1a2332, 0.0045);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.inst = new UnitInstances(1024);
    const common = {
      uMap: { value: null as THREE.Texture | null },
      uLight: { value: new THREE.Vector3(1, 0.97, 0.92) },
      uOutline: { value: 0 },
      uMargin: { value: 0.07 },
      uOutlineColor: { value: new THREE.Color(0xffffff) },
      uTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      ...this.uniforms,
    };
    this.unitMat = new THREE.ShaderMaterial({ vertexShader: BILLBOARD_VERT, fragmentShader: BILLBOARD_FRAG, uniforms: { ...common, uOutline: { value: 0 } }, side: THREE.DoubleSide, transparent: false, alphaToCoverage: true });
    this.outlineMat = new THREE.ShaderMaterial({ vertexShader: BILLBOARD_VERT, fragmentShader: BILLBOARD_FRAG, uniforms: { ...common, uOutline: { value: 1 } }, side: THREE.DoubleSide, transparent: false });
    this.outlineMat.uniforms.uMap = this.unitMat.uniforms.uMap;
    this.unitMesh = new THREE.Mesh(this.unitGeo, this.unitMat);
    this.outlineMesh = new THREE.Mesh(this.unitGeo, this.outlineMat);
    this.shadowMesh = new THREE.Mesh(
      this.shadowGeo,
      new THREE.ShaderMaterial({ vertexShader: SHADOW_VERT, fragmentShader: SHADOW_FRAG, uniforms: { uFogDensity: this.uniforms.uFogDensity }, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.barMesh = new THREE.Mesh(
      this.barGeo,
      new THREE.ShaderMaterial({ vertexShader: BAR_VERT, fragmentShader: BAR_FRAG, uniforms: { ...this.uniforms }, side: THREE.DoubleSide }),
    );
    this.projMesh = new THREE.Mesh(
      this.projGeo,
      new THREE.ShaderMaterial({ vertexShader: PROJ_VERT, fragmentShader: PROJ_FRAG, uniforms: { ...this.uniforms }, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    for (const m of [this.unitMesh, this.outlineMesh, this.shadowMesh, this.barMesh, this.projMesh]) {
      m.frustumCulled = false;
      this.scene.add(m);
    }
    this.shadowMesh.renderOrder = -2;
    this.outlineMesh.renderOrder = 0;
    this.unitMesh.renderOrder = 1;
    this.projMesh.renderOrder = 3;
    this.initUnitGeometry(1024);
    this.initBarGeometry(1024);
    this.initProjGeometry(1024);

    const ring = new THREE.RingGeometry(0.92, 1, 48);
    ring.rotateX(-Math.PI / 2);
    this.hover = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }));
    this.hover.visible = false;
    this.hover.renderOrder = 10;
    this.scene.add(this.hover);
    this.resize();
    // The host element changes size with the phone's address bar, rotation and the soft keyboard.
    new ResizeObserver(() => this.resize()).observe(host);
  }

  // ---- geometry buffers ----

  private initUnitGeometry(cap: number): void {
    this.inst = new UnitInstances(cap);
    for (const g of [this.unitGeo]) {
      for (const [name, data, size] of [['iA', this.inst.iA, 4], ['iB', this.inst.iB, 4], ['iUV', this.inst.iUV, 4], ['iC', this.inst.iC, 4]] as const) instAttr(g, name, data, size);
    }
    instAttr(this.shadowGeo, 'iS', this.inst.shadow, 4);
    this.unitGeo.instanceCount = 0;
    this.shadowGeo.instanceCount = 0;
  }

  private initBarGeometry(cap: number): void {
    instAttr(this.barGeo, 'iBar', this.inst.bar, 4);
    instAttr(this.barGeo, 'iW', this.inst.barB.subarray(0, cap), 1);
    this.barGeo.instanceCount = 0;
  }

  private initProjGeometry(cap: number): void {
    this.projPos = new Float32Array(cap * 4);
    this.projDir = new Float32Array(cap * 4);
    this.projCol = new Float32Array(cap * 3);
    instAttr(this.projGeo, 'iPos', this.projPos, 4);
    instAttr(this.projGeo, 'iDir', this.projDir, 4);
    instAttr(this.projGeo, 'iCol', this.projCol, 3);
    this.projGeo.instanceCount = 0;
  }

  /** Makes room for `n` soldiers (rebuilds the instance buffers when it grows). */
  ensureCapacity(n: number): void {
    if (n <= this.inst.capacity) return;
    const cap = Math.max(n, Math.ceil(this.inst.capacity * 1.5));
    for (const g of [this.unitGeo, this.shadowGeo, this.barGeo]) for (const k of Object.keys(g.attributes)) if (k.startsWith('i')) g.deleteAttribute(k);
    this.initUnitGeometry(cap);
    this.initBarGeometry(cap);
  }

  // ---- world ----

  /** Builds the terrain mesh, water, shadow frustum and fog for a map. */
  setTerrain(t: Terrain): void {
    this.terrain = t;
    this.size = t.size;
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      (this.terrainMesh.material as THREE.Material).dispose();
    }
    const pal = PALETTES[t.spec.biome];
    const data = terrainGeometry(t, pal);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.castShadow = true;
    this.scene.add(this.terrainMesh);

    if (this.water) {
      this.scene.remove(this.water);
      this.water.geometry.dispose();
    }
    const wg = new THREE.PlaneGeometry(t.size, t.size);
    wg.rotateX(-Math.PI / 2);
    wg.translate(t.size / 2, -0.06, t.size / 2);
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      uniforms: { uTime: { value: 0 }, uWater: { value: new THREE.Color(pal.water) }, uShine: { value: new THREE.Color(pal.waterShine) }, ...this.uniforms },
      transparent: true,
      depthWrite: false,
    });
    this.water = new THREE.Mesh(wg, this.waterMat);
    this.water.renderOrder = -3;
    this.scene.add(this.water);

    // Lights, shadow frustum and fog follow the map.
    const half = t.size * 0.78;
    const c = t.size / 2;
    this.sun.position.set(c - t.size * 0.55, t.size * 0.9, c - t.size * 0.35);
    this.sun.target.position.set(c, 0, c);
    const cam = this.sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = t.size * 3;
    cam.updateProjectionMatrix();
    const fog = pal.sideR;
    this.fogColor.setHex(mix(0x1a2332, fog, 0.25));
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogColor);
    (this.scene.fog as THREE.FogExp2).density = 0.0035;
    this.uniforms.uFogColor.value.copy(this.fogColor);
    this.uniforms.uFogDensity.value = 0.0035;
    // Portrait screens need to stand further back to see the width of the map.
    const wide = Math.max(1, 0.95 / Math.max(0.2, this.camera.aspect));
    this.rig = clampRig({ ...this.rig, fx: c, fz: c, dist: t.size * 1.05 * wide }, t.size);
    this.buildDecor();
  }

  /** Static decor (trees, rocks, houses ...) as billboards with their own soft shadows. */
  private buildDecor(): void {
    for (const m of [this.decorMesh, this.decorShadowMesh]) {
      if (m) this.scene.remove(m);
    }
    this.decorMesh = null;
    this.decorShadowMesh = null;
    const t = this.terrain;
    if (!t || !this.gpu) return;
    const n = t.decor.length;
    const iA = new Float32Array(n * 4);
    const iB = new Float32Array(n * 4);
    const iUV = new Float32Array(n * 4);
    const iC = new Float32Array(n * 4);
    const iS = new Float32Array(n * 4);
    let count = 0;
    for (const d of t.decor) {
      const f = decorFrame(d.kind, d.variant);
      if (this.gpu.decor.has[f] === 0) continue;
      const o = count * 4;
      const gy = groundHeight(t, d.x, d.y);
      iA[o] = d.x;
      iA[o + 1] = gy;
      iA[o + 2] = d.y;
      iA[o + 3] = 1;
      iB[o] = this.gpu.decor.size[f * 2];
      iB[o + 1] = this.gpu.decor.size[f * 2 + 1];
      iB[o + 2] = this.gpu.decor.anchor[f * 2];
      iB[o + 3] = this.gpu.decor.anchor[f * 2 + 1];
      iUV.set(this.gpu.decor.uv.subarray(f * 4, f * 4 + 4), o);
      iC[o] = 0;
      iC[o + 1] = 0;
      iC[o + 2] = 0xffffff;
      iC[o + 3] = 1;
      iS[o] = d.x;
      iS[o + 1] = gy;
      iS[o + 2] = d.y;
      iS[o + 3] = d.kind === 'tree' ? 1.5 : d.kind === 'house' || d.kind === 'keep' || d.kind === 'tower' ? 2.4 : 0.9;
      count++;
    }
    const g = quadGeometry();
    instAttr(g, 'iA', iA.slice(0, count * 4), 4);
    instAttr(g, 'iB', iB.slice(0, count * 4), 4);
    instAttr(g, 'iUV', iUV.slice(0, count * 4), 4);
    instAttr(g, 'iC', iC.slice(0, count * 4), 4);
    g.instanceCount = count;
    this.decorGeo.dispose();
    this.decorGeo = g;
    this.decorMesh = new THREE.Mesh(g, this.unitMat);
    this.decorMesh.frustumCulled = false;
    this.decorMesh.renderOrder = 1;
    this.scene.add(this.decorMesh);
    const sg = quadGeometry();
    instAttr(sg, 'iS', iS.slice(0, count * 4), 4);
    sg.instanceCount = count;
    this.decorShadowGeo.dispose();
    this.decorShadowGeo = sg;
    this.decorShadowMesh = new THREE.Mesh(sg, this.shadowMesh.material);
    this.decorShadowMesh.frustumCulled = false;
    this.decorShadowMesh.renderOrder = -2;
    this.scene.add(this.decorShadowMesh);
  }

  /** Sets (or replaces) the sprite atlas; decor is rebuilt because its frames come from it. */
  setAtlas(gpu: AtlasGpu): void {
    this.gpu?.dispose();
    this.gpu = gpu;
    this.unitMat.uniforms.uMap.value = gpu.texture;
    (this.unitMat.uniforms.uTexel.value as THREE.Vector2).set(1 / gpu.width, 1 / gpu.height);
    (this.outlineMat.uniforms.uTexel.value as THREE.Vector2).set(1 / gpu.width, 1 / gpu.height);
    this.buildDecor();
  }

  get atlas(): AtlasGpu | null {
    return this.gpu;
  }

  /** Placement zones as coloured tiles on the ground (null removes them). */
  setZones(zones: ZoneOverlay[] | null): void {
    if (this.zoneMesh) {
      this.scene.remove(this.zoneMesh);
      this.zoneMesh.geometry.dispose();
      this.zoneMesh = null;
    }
    const t = this.terrain;
    if (!zones || !t) return;
    let tiles = 0;
    for (const z of zones) tiles += z.tiles.length;
    const pos = new Float32Array(tiles * 12);
    const col = new Float32Array(tiles * 12);
    const idx = new Uint32Array(tiles * 6);
    let q = 0;
    for (const z of zones) {
      const c = new THREE.Color(z.color);
      for (const [x, y] of z.tiles) {
        const corners = [[x, y], [x, y + 1], [x + 1, y + 1], [x + 1, y]];
        corners.forEach(([cx, cy], k) => {
          pos[(q * 4 + k) * 3] = cx;
          pos[(q * 4 + k) * 3 + 1] = Math.max(0, groundHeight(t, cx, cy)) + 0.05;
          pos[(q * 4 + k) * 3 + 2] = cy;
          col[(q * 4 + k) * 3] = c.r;
          col[(q * 4 + k) * 3 + 1] = c.g;
          col[(q * 4 + k) * 3 + 2] = c.b;
        });
        idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
        q++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.zoneMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
    this.zoneMesh.renderOrder = -1;
    this.scene.add(this.zoneMesh);
  }

  // ---- per frame ----

  /** Writes the soldiers (and their shadows and health bars) for this frame. */
  setUnits(u: UnitsLike, alpha: number, dt: number, focusTeam: number, showBars: boolean): void {
    const t = this.terrain;
    if (!t || !this.gpu) return;
    this.ensureCapacity(u.count);
    this.inst.write(u, alpha, dt, this.gpu.units, (x, y) => groundHeight(t, x, y), {
      focusTeam,
      swingTime: (kind) => STATS[kind].swing,
      showBars,
    });
    const n = this.inst.count;
    touch(this.unitGeo, ['iA', 'iB', 'iUV', 'iC'], n);
    touch(this.shadowGeo, ['iS'], n);
    touch(this.barGeo, ['iBar', 'iW'], this.inst.barCount);
  }

  /** Arrows and bolts in flight, as stretched quads along the 3D direction of travel. */
  setProjectiles(p: ProjView, advance: number): void {
    const t = this.terrain;
    if (!t) return;
    if (p.count * 4 > this.projPos.length) {
      for (const k of ['iPos', 'iDir', 'iCol']) this.projGeo.deleteAttribute(k);
      this.initProjGeometry(Math.max(p.count, this.projPos.length / 4 * 2));
    }
    let n = 0;
    for (let i = 0; i < p.count; i++) {
      if (!p.active[i]) continue;
      const k = Math.min(1, (p.t[i] + advance) / p.dur[i]);
      const k2 = Math.min(1, k + 0.04);
      const arc = (kk: number): number => 4 * p.height[i] * kk * (1 - kk) * PX_WORLD * 2.2;
      const x = p.sx[i] + (p.tx[i] - p.sx[i]) * k;
      const z = p.sy[i] + (p.ty[i] - p.sy[i]) * k;
      const x2 = p.sx[i] + (p.tx[i] - p.sx[i]) * k2;
      const z2 = p.sy[i] + (p.ty[i] - p.sy[i]) * k2;
      const y = groundHeight(t, x, z) + 0.55 + arc(k);
      const y2 = groundHeight(t, x2, z2) + 0.55 + arc(k2);
      const o = n * 4;
      this.projPos[o] = x;
      this.projPos[o + 1] = y;
      this.projPos[o + 2] = z;
      const st = projStyle(p.tag[i]);
      this.projPos[o + 3] = 0.7 * st.scale;
      let dx = x2 - x;
      let dy = y2 - y;
      let dz = z2 - z;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-6) dx = 1;
      const orb = st.orb ? 1 : 0;
      this.projDir[o] = dx;
      this.projDir[o + 1] = dy;
      this.projDir[o + 2] = dz;
      this.projDir[o + 3] = orb;
      this.projCol[n * 3] = ((st.color >> 16) & 255) / 255;
      this.projCol[n * 3 + 1] = ((st.color >> 8) & 255) / 255;
      this.projCol[n * 3 + 2] = (st.color & 255) / 255;
      n++;
    }
    touch(this.projGeo, ['iPos', 'iDir', 'iCol'], n);
  }

  setHover(hit: GroundHit | null, radius: number, color = 0xffffff): void {
    if (!hit) {
      this.hover.visible = false;
      return;
    }
    this.hover.visible = true;
    this.hover.position.set(hit.x, hit.y + 0.08, hit.z);
    this.hover.scale.setScalar(Math.max(0.3, radius));
    (this.hover.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  setOutlineColor(c: number): void {
    (this.outlineMat.uniforms.uOutlineColor.value as THREE.Color).setHex(c);
  }

  resize(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Phones render the shadow map smaller.
    const small = Math.min(w, h) < 520;
    this.sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as { map: unknown }).map = null;
  }

  /** Places the camera from the rig (it stays above the ground) and updates the billboard axes. */
  applyCamera(): void {
    this.rig = clampRig(this.rig, this.size);
    const fy = this.terrain ? Math.max(0, groundHeight(this.terrain, this.rig.fx, this.rig.fz)) : 0;
    const e = eyeOf(this.rig, fy);
    if (this.terrain) {
      const ground = groundHeight(this.terrain, Math.min(this.size, Math.max(0, e.x)), Math.min(this.size, Math.max(0, e.z)));
      e.y = Math.max(e.y, ground + 1.5);
    }
    this.camera.position.set(e.x, e.y, e.z);
    this.camera.lookAt(this.rig.fx, fy, this.rig.fz);
    this.camera.updateMatrixWorld();
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this.up.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.uniforms.uRight.value.copy(this.right);
    this.uniforms.uUp.value.copy(this.up);
  }

  /** Draws the frame. */
  render(dt: number): void {
    this.time += dt;
    this.applyCamera();
    if (this.waterMat) this.waterMat.uniforms.uTime.value = this.time;
    this.renderer.render(this.scene, this.camera);
    this.info.draws = this.renderer.info.render.calls;
    this.info.tris = this.renderer.info.render.triangles;
  }

  /** Ground point under a screen position (client coordinates), or null. */
  pick(clientX: number, clientY: number): GroundHit | null {
    const t = this.terrain;
    if (!t) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    return pickGround(o.x, o.y, o.z, d.x, d.y, d.z, (x, z) => groundHeight(t, x, z), t.size);
  }

  dispose(): void {
    this.gpu?.dispose();
    this.terrainMesh?.geometry.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function mix(a: number, b: number, k: number): number {
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = (a & 255) + (((b & 255) - (a & 255)) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}
