import { panAxes, type Rig } from './cameraRig';
import type { GroundHit } from './pick';
import type { View3D } from './scene3d';

export type Tool = 'look' | 'place' | 'erase';

export interface ControlHooks {
  /** Cursor moved over the ground (null: not over the map). */
  onHover(hit: GroundHit | null): void;
  /** A paint stroke point: tool is place/erase, `repeat` false for the first point of a stroke. */
  onPaint(hit: GroundHit, tool: 'place' | 'erase', repeat: boolean): void;
  onStrokeEnd(): void;
}

/**
 * Mouse, touch and keyboard camera for the 3D view. Mouse: wheel zoom (to the cursor), right-drag rotate + tilt, middle-drag or
 * left-drag in "look" mode pan, left-drag paints in place/erase mode (shift = erase, ctrl = pan). Touch: one finger pans (or
 * paints), two fingers pinch-zoom, twist-rotate and drag. Keys: WASD pan, Q/E rotate, R/F tilt, +/- zoom.
 */
export class Controls {
  tool: Tool = 'look';
  private readonly pointers = new Map<number, { x: number; y: number; button: number }>();
  private mode: 'none' | 'pan' | 'rotate' | 'paint' | 'pinch' = 'none';
  private lastPaint: GroundHit | null = null;
  private pinch = { dist: 0, angle: 0, cx: 0, cy: 0 };
  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private readonly cleanup: Array<() => void> = [];

  constructor(
    private readonly view: View3D,
    private readonly hooks: ControlHooks,
  ) {
    this.canvas = view.renderer.domElement;
    const on = (el: HTMLElement | Window, ev: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void => {
      el.addEventListener(ev, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(ev, fn as EventListener));
    };
    on(this.canvas, 'pointerdown', (e: PointerEvent) => this.down(e));
    on(window, 'pointermove', (e: PointerEvent) => this.move(e));
    on(window, 'pointerup', (e: PointerEvent) => this.up(e));
    on(window, 'pointercancel', (e: PointerEvent) => this.up(e));
    on(this.canvas, 'wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    on(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());
    on(window, 'keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input,select,textarea')) return;
      this.keys.add(e.code);
    });
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
  }

  dispose(): void {
    for (const f of this.cleanup) f();
    this.cleanup.length = 0;
  }

  private get rig(): Rig {
    return this.view.rig;
  }

  private worldPerPixel(): number {
    const h = this.canvas.clientHeight || 600;
    return (2 * Math.tan((this.view.camera.fov * Math.PI) / 360) * this.rig.dist) / h;
  }

  private panBy(dx: number, dy: number): void {
    const r = this.rig;
    const a = panAxes(r.yaw);
    const wpp = this.worldPerPixel();
    r.fx -= a.rx * dx * wpp;
    r.fz -= a.rz * dx * wpp;
    const k = wpp / Math.max(0.25, Math.sin(r.tilt));
    r.fx += a.ux * dy * k;
    r.fz += a.uz * dy * k;
  }

  private down(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released pointer */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
    if (e.pointerType === 'touch') {
      if (this.pointers.size >= 2) {
        this.beginPinch();
        return;
      }
      this.mode = this.tool === 'look' ? 'pan' : 'paint';
    } else if (e.button === 2) this.mode = 'rotate';
    else if (e.button === 1) this.mode = 'pan';
    else if (e.button === 0) this.mode = this.tool !== 'look' && !e.ctrlKey ? 'paint' : 'pan';
    if (this.mode === 'paint') this.paint(e, false);
  }

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    if (this.mode === 'paint') this.hooks.onStrokeEnd();
    this.mode = 'pinch';
  }

  private paint(e: PointerEvent, repeat: boolean): void {
    const hit = this.view.pick(e.clientX, e.clientY);
    if (!hit) return;
    // A stroke point only when the cursor has moved a little over the ground (brush spacing).
    if (repeat && this.lastPaint && Math.hypot(hit.x - this.lastPaint.x, hit.z - this.lastPaint.z) < 0.5) return;
    this.lastPaint = hit;
    const erase = this.tool === 'erase' || e.shiftKey || this.pointers.get(e.pointerId)?.button === 2;
    this.hooks.onPaint(hit, erase ? 'erase' : 'place', repeat);
  }

  private move(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (e.target === this.canvas) this.hooks.onHover(this.view.pick(e.clientX, e.clientY));
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.mode === 'pan') this.panBy(dx, dy);
    else if (this.mode === 'rotate') {
      this.rig.yaw -= dx * 0.006;
      this.rig.tilt += dy * 0.004;
    } else if (this.mode === 'paint') {
      this.paint(e, true);
    } else if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (this.pinch.dist > 8) this.rig.dist *= this.pinch.dist / Math.max(8, dist);
      let da = angle - this.pinch.angle;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      this.rig.yaw -= da;
      this.panBy(cx - this.pinch.cx, cy - this.pinch.cy);
      this.pinch = { dist, angle, cx, cy };
    }
    if (e.pointerType !== 'touch') this.hooks.onHover(this.view.pick(e.clientX, e.clientY));
  }

  private up(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.mode === 'paint') this.hooks.onStrokeEnd();
    if (this.pointers.size === 0) {
      this.mode = 'none';
      this.lastPaint = null;
    } else if (this.pointers.size === 1) {
      this.mode = 'none';
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const before = this.view.pick(e.clientX, e.clientY);
    const k = Math.exp(Math.max(-120, Math.min(120, e.deltaY)) * 0.0012);
    this.rig.dist *= k;
    this.view.rig = { ...this.rig };
    if (before) {
      // Keep the ground point under the cursor where it was.
      this.view.applyCamera();
      const after = this.view.pick(e.clientX, e.clientY);
      if (after) {
        this.rig.fx += before.x - after.x;
        this.rig.fz += before.z - after.z;
      }
    }
  }

  /** Keyboard movement; call every frame. */
  update(dt: number): void {
    if (this.keys.size === 0) return;
    const r = this.rig;
    const a = panAxes(r.yaw);
    const sp = r.dist * 0.9 * dt;
    const ax = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const ay = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    r.fx += (a.rx * ax + a.ux * ay) * sp;
    r.fz += (a.rz * ax + a.uz * ay) * sp;
    if (this.keys.has('KeyQ')) r.yaw += 1.6 * dt;
    if (this.keys.has('KeyE')) r.yaw -= 1.6 * dt;
    if (this.keys.has('KeyR')) r.tilt += 0.9 * dt;
    if (this.keys.has('KeyF')) r.tilt -= 0.9 * dt;
    if (this.keys.has('Equal') || this.keys.has('NumpadAdd')) r.dist *= Math.exp(-1.2 * dt);
    if (this.keys.has('Minus') || this.keys.has('NumpadSubtract')) r.dist *= Math.exp(1.2 * dt);
  }
}
