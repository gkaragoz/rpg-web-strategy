import type { Container } from 'pixi.js';
import { TILE_H, TILE_W } from './iso';

const PAN_SPEED = 900;
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 2.5;

/** Effect of a two-finger gesture on the camera (pure function: testable). mx/my: midpoint relative to the canvas center. */
export function gestureStep(
  cam: { x: number; y: number; zoom: number },
  prev: { mx: number; my: number; d: number },
  next: { mx: number; my: number; d: number },
): { x: number; y: number; zoom: number } {
  const before = cam.zoom;
  const ratio = prev.d > 1 && next.d > 1 ? next.d / prev.d : 1;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, before * ratio));
  // The world point under the midpoint stays with the fingers as the midpoint moves.
  const x = cam.x + prev.mx / before - next.mx / zoom;
  const y = cam.y + prev.my / before - next.my / zoom;
  return { x, y, zoom };
}

export class Camera {
  /** Center point on screen (world/iso pixel coordinates). */
  x = 0;
  y: number;
  zoom = 1;
  /** While false, input (keyboard/mouse/wheel) is ignored: for the automatic benchmark. */
  enabled = true;
  /** Camera shake amplitude (px); decays quickly. */
  private shakeAmp = 0;
  /** Short zoom punch (comedy mode): 0..0.08, decays quickly. */
  private punchAmp = 0;
  private keys = new Set<string>();
  /** Touch: active fingers (the editor reads this too: 2+ fingers = camera movement, not placement). */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private gesture: { mx: number; my: number; d: number } | null = null;
  /** While true (battle), a single finger pans too. */
  singleFingerPan = false;
  private canvasEl: HTMLCanvasElement;
  get touchCount(): number {
    return this.touches.size;
  }
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    canvas: HTMLCanvasElement,
    public mapSize: number,
  ) {
    this.y = (mapSize * TILE_H) / 2;
    this.canvasEl = canvas;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.touchDown(e));
    window.addEventListener('pointermove', (e) => this.touchMove(e));
    window.addEventListener('pointerup', (e) => this.touchEnd(e));
    window.addEventListener('pointercancel', (e) => this.touchEnd(e));
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (this.enabled && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'))) this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || e.button !== 1) return;
      e.preventDefault();
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) this.dragging = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.x -= (e.clientX - this.lastX) / this.zoom;
      this.y -= (e.clientY - this.lastY) / this.zoom;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    canvas.addEventListener('auxclick', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!this.enabled) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        const before = this.zoom;
        this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * Math.exp(-e.deltaY * 0.0015)));
        // Keep the point under the cursor fixed.
        this.x += mx / before - mx / this.zoom;
        this.y += my / before - my / this.zoom;
      },
      { passive: false },
    );
  }

  private touchState(): { mx: number; my: number; d: number } | null {
    const pts = [...this.touches.values()];
    if (pts.length === 0) return null;
    const rect = this.canvasEl.getBoundingClientRect();
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length - rect.left - rect.width / 2;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length - rect.top - rect.height / 2;
    const d = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { mx: cx, my: cy, d };
  }

  private touchDown(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.gesture = this.touchState();
  }

  private touchMove(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || !this.touches.has(e.pointerId)) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.enabled || !this.gesture) return;
    if (this.touches.size < 2 && !this.singleFingerPan) return;
    const next = this.touchState()!;
    const g = gestureStep(this, this.gesture, this.touches.size >= 2 ? next : { ...next, d: 0 });
    this.x = g.x;
    this.y = g.y;
    this.zoom = g.zoom;
    this.gesture = next;
  }

  private touchEnd(e: PointerEvent): void {
    if (e.pointerType !== 'touch') return;
    this.touches.delete(e.pointerId);
    this.gesture = this.touchState();
  }

  /** Zoom in/out (HUD buttons): toward the screen center. */
  zoomBy(f: number): void {
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * f));
  }

  punch(amount: number): void {
    this.punchAmp = Math.min(0.08, Math.max(this.punchAmp, amount));
  }

  /** Adds shake (the largest value is kept; range 0-14 px). */
  shake(amount: number): void {
    this.shakeAmp = Math.min(14, Math.max(this.shakeAmp, amount));
  }

  /** Updates the camera bounds when the map size changes. */
  setMap(size: number): void {
    this.mapSize = size;
    this.x = 0;
    this.y = (size * TILE_H) / 2;
  }

  /** Fits the whole map on screen. */
  fit(screenW: number, screenH: number): void {
    this.x = 0;
    this.y = (this.mapSize * TILE_H) / 2;
    this.zoom = Math.max(MIN_ZOOM, Math.min(screenW / (this.mapSize * TILE_W), screenH / (this.mapSize * TILE_H)) * 0.95);
  }

  update(dt: number): void {
    this.shakeAmp *= Math.exp(-dt * 9);
    this.punchAmp *= Math.exp(-dt * 8);
    if (this.punchAmp < 0.001) this.punchAmp = 0;
    if (this.shakeAmp < 0.05) this.shakeAmp = 0;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dy += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      this.x += ((dx / len) * PAN_SPEED * dt) / this.zoom;
      this.y += ((dy / len) * PAN_SPEED * dt) / this.zoom;
    }
    const half = (this.mapSize * TILE_W) / 2;
    this.x = Math.min(half, Math.max(-half, this.x));
    this.y = Math.min(this.mapSize * TILE_H, Math.max(0, this.y));
  }

  apply(world: Container, screenW: number, screenH: number): void {
    const z = this.zoom * (1 + this.punchAmp);
    world.scale.set(z);
    const sx = this.shakeAmp > 0 ? (Math.random() - 0.5) * 2 * this.shakeAmp : 0;
    const sy = this.shakeAmp > 0 ? (Math.random() - 0.5) * 2 * this.shakeAmp : 0;
    world.position.set(screenW / 2 - this.x * z + sx, screenH / 2 - this.y * z + sy);
  }
}
