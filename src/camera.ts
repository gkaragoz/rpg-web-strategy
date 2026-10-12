import type { Container } from 'pixi.js';
import { TILE_H, TILE_W } from './iso';

const PAN_SPEED = 900;
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 2.5;

export class Camera {
  /** Ekrandaki merkez noktasi (dunya/iso piksel koordinati). */
  x = 0;
  y: number;
  zoom = 1;
  /** false iken girdi (klavye/fare/tekerlek) yok sayilir: otomatik benchmark icin. */
  enabled = true;
  private keys = new Set<string>();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly mapSize: number,
  ) {
    this.y = (mapSize * TILE_H) / 2;
    window.addEventListener('keydown', (e) => this.enabled && this.keys.add(e.code));
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
        // Imlecin altindaki nokta sabit kalsin.
        this.x += mx / before - mx / this.zoom;
        this.y += my / before - my / this.zoom;
      },
      { passive: false },
    );
  }

  /** Tum haritayi ekrana sigdirir. */
  fit(screenW: number, screenH: number): void {
    this.x = 0;
    this.y = (this.mapSize * TILE_H) / 2;
    this.zoom = Math.max(MIN_ZOOM, Math.min(screenW / (this.mapSize * TILE_W), screenH / (this.mapSize * TILE_H)) * 0.95);
  }

  update(dt: number): void {
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
    world.scale.set(this.zoom);
    world.position.set(screenW / 2 - this.x * this.zoom, screenH / 2 - this.y * this.zoom);
  }
}
