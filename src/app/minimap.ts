import type { MapSpec } from '../sim/mapSpec';

/** Cache key of a minimap: the whole recipe, the seed and the (clamped) size. */
export function minimapKey(spec: MapSpec, seed: number, size: number): string {
  const n = Math.max(32, Math.min(72, size));
  return `${spec.biome}|${spec.river}|${spec.forest}|${spec.village}|${spec.crossing}|${spec.relief}|${spec.layout}|${seed}|${n}`;
}

const MAX_CACHED = 96;
const cache = new Map<string, HTMLCanvasElement>();

/** Copies a cached minimap into `canvas`; false when it has not been generated yet. */
export function paintCached(canvas: HTMLCanvasElement, key: string): boolean {
  const src = cache.get(key);
  if (!src) return false;
  cache.delete(key); // most recently used goes last
  cache.set(key, src);
  canvas.width = src.width;
  canvas.height = src.height;
  canvas.getContext('2d')?.drawImage(src, 0, 0);
  return true;
}

/** Stores a finished minimap (a copy of `canvas`) in the cache. */
export function storeMinimap(canvas: HTMLCanvasElement, key: string): void {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d')?.drawImage(canvas, 0, 0);
  cache.set(key, copy);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

/**
 * Work queue for lazy minimap generation: one job per animation frame, visible cards first.
 * Jobs with the same id are kept once (a re-render replaces the pending job).
 */
export class MinimapQueue {
  private jobs: Array<{ id: string; run: () => void }> = [];
  private raf = 0;

  /** Adds a job; `urgent` jobs (visible cards) go to the front. */
  add(id: string, run: () => void, urgent = false): void {
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (urgent) this.jobs.unshift({ id, run });
    else this.jobs.push({ id, run });
    this.kick();
  }

  /** Moves a pending job to the front (the card scrolled into view). */
  bump(id: string): void {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i > 0) this.jobs.unshift(...this.jobs.splice(i, 1));
  }

  get size(): number {
    return this.jobs.length;
  }

  /** Runs the first job (used by the frame loop and by tests). Returns false when the queue is empty. */
  step(): boolean {
    const job = this.jobs.shift();
    if (!job) return false;
    job.run();
    return true;
  }

  clear(): void {
    this.jobs = [];
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private kick(): void {
    if (this.raf || typeof requestAnimationFrame === 'undefined') return;
    const tick = (): void => {
      this.raf = 0;
      if (this.step() && this.jobs.length > 0) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
