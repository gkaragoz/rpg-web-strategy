import type { CameraBackend } from '../contracts/backend';
import { clampRig, fitDist, orbitRig, panAxes, pinchRig, TILT_MAX, TILT_MIN } from './cameraRig';
import { groundHeight } from './terrainMesh';
import type { View3D } from './scene3d';

/**
 * The 3D camera, behind the same interface as the 2D one so the editor and battle HUD work unchanged.
 * Mouse: middle-drag (or Alt+left-drag) rotates and tilts, Shift+middle-drag pans, wheel zooms to the cursor (left and right buttons belong to the
 * editor: paint / erase). Keys: WASD / arrows pan, [ ] turn, PageUp/PageDown tilt (Q/E, R and F belong to the studio and the battle). Touch: one finger pans only in battle (otherwise it
 * paints), two fingers pinch-zoom, twist-rotate and drag.
 */
export class Camera3D implements CameraBackend {
  enabled = true;
  singleFingerPan = false;
  private readonly touches = new Map<number, { x: number; y: number }>();
  private mode: 'none' | 'pan' | 'rotate' | 'pinch' = 'none';
  private pinch = { dist: 0, angle: 0, cx: 0, cy: 0 };
  private last = { x: 0, y: 0 };
  private mouseId = -1;
  private readonly keys = new Set<string>();
  private size = 56;
  private readonly canvas: HTMLCanvasElement;

  constructor(private readonly view: View3D) {
    this.canvas = view.renderer.domElement;
    this.canvas.style.touchAction = 'none';
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    c.addEventListener('auxclick', (e) => e.preventDefault());
    // The middle button would start the browser's autoscroll; the right button belongs to the editor (erase) and has no menu.
    c.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return; // browser / OS shortcuts (Ctrl+W, Ctrl+A, Alt+arrow) never move the camera
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Focus lost mid-gesture (Alt+Tab, a dialog, the window being minimised): the release may never arrive, so drop every drag and key.
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
  }

  /** Ends a running mouse drag and clears the held keys (touches stay: they end with their own pointerup/pointercancel). */
  private releaseAll(): void {
    this.keys.clear();
    this.mouseId = -1;
    this.mode = this.touches.size >= 2 ? 'pinch' : this.touches.size === 1 && this.singleFingerPan ? 'pan' : 'none';
  }

  get touchCount(): number {
    return this.touches.size;
  }

  /** Larger = closer (distance 45 is 1). Sound and effect gating read this like the 2D zoom. */
  get audioZoom(): number {
    return Math.min(2.5, Math.max(0.05, 45 / this.view.rig.dist));
  }

  setMap(size: number): void {
    this.size = size;
  }

  /** Fits the whole map on screen (the default framing; portrait screens stand further back). */
  fit(screenW: number, screenH: number): void {
    const aspect = Math.max(0.2, screenW / Math.max(1, screenH));
    const c = this.size / 2;
    const yaw = Math.PI / 4;
    const tilt = (48 * Math.PI) / 180;
    this.view.rig = clampRig({ fx: c, fz: c, yaw, tilt, dist: fitDist(this.size, aspect, this.view.camera.fov, tilt, yaw) }, this.size);
  }

  zoomBy(factor: number): void {
    this.view.rig.dist /= factor;
  }

  shake(_amount: number): void {
    /* no camera shake (as in 2D) */
  }

  punch(_amount: number): void {
    /* no zoom punch (as in 2D) */
  }

  /** Rotates (radians) and tilts the camera: the on-screen buttons use this. */
  orbit(dYaw: number, dTilt: number): void {
    this.view.rig = orbitRig(this.view.rig, dYaw, dTilt);
  }

  project(x: number, y: number): { sx: number; sy: number } {
    const t = this.view.terrain;
    const p = this.view.project(x, t ? Math.max(0, groundHeight(t, x, y)) : 0, y);
    return { sx: p.x, sy: p.y };
  }

  // ---- input ----

  private worldPerPixel(): number {
    const h = this.canvas.clientHeight || 600;
    return (2 * Math.tan((this.view.camera.fov * Math.PI) / 360) * this.view.rig.dist) / h;
  }

  private panBy(dx: number, dy: number): void {
    const r = this.view.rig;
    const a = panAxes(r.yaw);
    const wpp = this.worldPerPixel();
    r.fx -= a.rx * dx * wpp;
    r.fz -= a.rz * dx * wpp;
    const k = wpp / Math.max(0.25, Math.sin(r.tilt));
    r.fx += a.ux * dy * k;
    r.fz += a.uz * dy * k;
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2) this.beginPinch();
      else if (this.singleFingerPan) {
        this.mode = 'pan';
        this.last = { x: e.clientX, y: e.clientY };
      }
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.mode = e.shiftKey ? 'pan' : 'rotate';
    } else if (e.button === 0 && e.altKey) {
      e.preventDefault();
      this.mode = 'rotate';
    } else return;
    this.mouseId = e.pointerId;
    this.last = { x: e.clientX, y: e.clientY };
  }

  private beginPinch(): void {
    const [a, b] = [...this.touches.values()];
    this.pinch = { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    this.mode = 'pinch';
  }

  private move(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      const p = this.touches.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      if (!this.enabled) return;
      if (this.mode === 'pinch' && this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        this.view.rig = pinchRig(this.view.rig, this.pinch, { dist, angle });
        this.panBy(cx - this.pinch.cx, cy - this.pinch.cy);
        this.pinch = { dist, angle, cx, cy };
      } else if (this.mode === 'pan' && this.touches.size === 1) {
        this.panBy(e.clientX - this.last.x, e.clientY - this.last.y);
        this.last = { x: e.clientX, y: e.clientY };
      }
      return;
    }
    if (e.pointerId !== this.mouseId || this.mode === 'none') return;
    if (e.buttons === 0) {
      // The button was released where no pointerup reached us (outside the window, over a dialog): the drag is over.
      this.releaseAll();
      return;
    }
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.last = { x: e.clientX, y: e.clientY };
    if (this.mode === 'pan') this.panBy(dx, dy);
    else if (this.mode === 'rotate') this.orbit(-dx * 0.006, dy * 0.004);
  }

  private up(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      if (!this.touches.delete(e.pointerId)) return;
      if (this.touches.size === 0) this.mode = 'none';
      else if (this.touches.size === 1) {
        // One finger is left after a pinch: in battle it keeps panning from where it is.
        const [p] = [...this.touches.values()];
        this.mode = this.singleFingerPan ? 'pan' : 'none';
        this.last = { x: p.x, y: p.y };
      }
      return;
    }
    if (e.pointerId === this.mouseId) {
      this.mouseId = -1;
      this.mode = 'none';
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.enabled) return;
    const before = this.view.pick(e.clientX, e.clientY);
    // Pixels, lines (Firefox mouse wheel) or pages; a trackpad pinch arrives as ctrl+wheel with small deltas, so it gets a higher gain.
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const gain = e.ctrlKey ? 0.01 : 0.0012;
    const lim = e.ctrlKey ? 40 : 120;
    const k = Math.exp(Math.max(-lim, Math.min(lim, e.deltaY * unit)) * gain);
    this.view.rig.dist *= k;
    if (before) {
      // Keep the ground point under the cursor where it was.
      this.view.applyCamera();
      const after = this.view.pick(e.clientX, e.clientY);
      if (after) {
        this.view.rig.fx += before.x - after.x;
        this.view.rig.fz += before.z - after.z;
      }
    }
  }

  update(dt: number): void {
    if (this.keys.size === 0) return;
    const r = this.view.rig;
    const a = panAxes(r.yaw);
    const sp = r.dist * 0.9 * dt;
    const k = this.keys;
    const ax = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const ay = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    r.fx += (a.rx * ax + a.ux * ay) * sp;
    r.fz += (a.rz * ax + a.uz * ay) * sp;
    if (k.has('BracketLeft')) r.yaw += 1.6 * dt;
    if (k.has('BracketRight')) r.yaw -= 1.6 * dt;
    if (k.has('PageUp')) r.tilt = Math.min(TILT_MAX, r.tilt + 0.9 * dt);
    if (k.has('PageDown')) r.tilt = Math.max(TILT_MIN, r.tilt - 0.9 * dt);
  }
}
