import { TROOP_BY_ID } from '../sim/data/troops';
import { STATS, isHealer, isTank } from '../sim/units';
import { overlayFor, frameAt, type Overlay } from './previewOverlay';

/** A sprite sheet: `frames` attack frames followed by one idle frame, side by side. */
export interface FrameSheet {
  canvas: HTMLCanvasElement;
  /** Attack frames (the idle frame is at index `frames`). */
  frames: number;
  fw: number;
  fh: number;
}

/** Renders a sheet incrementally (one frame per step) so the main thread is never blocked for long. */
export interface FrameJob {
  /** Renders the next frame; returns the finished sheet when done, otherwise null. */
  step(): FrameSheet | null;
  cancel(): void;
}

export interface PreviewDeps {
  begin(kind: number, team: number, frames: number): FrameJob;
}

interface Entry {
  el: HTMLElement;
  kind: number;
  canvas: HTMLCanvasElement | null;
  sheet: FrameSheet | null;
  overlay: Overlay;
  visible: boolean;
  /** Per-card phase offset so cards do not all strike together. */
  phase: number;
}

const CYCLE_MS = 1800;
const TICK_MS = 42; // ~24 fps
const BUDGET_MS = 4;

/**
 * Plays an automatic, looping attack preview on every visible unit card.
 * Frames are rendered lazily (visible cards first) into small sprite sheets and cached; playback is just drawImage.
 */
export class UnitPreview {
  private entries: Entry[] = [];
  private observer: IntersectionObserver | null = null;
  private raf = 0;
  private lastTick = 0;
  private job: { entry: Entry; job: FrameJob } | null = null;
  private team = 0;
  private readonly cache = new Map<string, FrameSheet>();
  private readonly touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  private readonly frames = this.touch ? 6 : 8;
  private readonly cap = this.touch ? 16 : 24;
  private readonly onVis = (): void => {
    if (document.hidden) this.stopLoop();
    else if (this.entries.length) this.startLoop();
  };

  constructor(private readonly d: PreviewDeps) {}

  private static reduced(): boolean {
    return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** (Re)attaches to the `.ug-icon[data-icon]` elements under `root`; call after every gallery render. */
  attach(root: HTMLElement, team: number): void {
    this.detach();
    if (UnitPreview.reduced()) return;
    this.team = team;
    const grid = (root.querySelector('.ug-grid') as HTMLElement | null) ?? null;
    this.observer = new IntersectionObserver(
      (list) => {
        for (const e of list) {
          const en = this.entries.find((x) => x.el === e.target);
          if (en) en.visible = e.isIntersecting;
        }
      },
      { root: grid, rootMargin: '80px', threshold: 0.01 },
    );
    root.querySelectorAll<HTMLElement>('.ug-icon[data-icon]').forEach((el, i) => {
      const kind = Number(el.dataset.icon);
      const tr = STATS[kind].troop ? TROOP_BY_ID[STATS[kind].troop!] : undefined;
      const overlay = overlayFor({
        ranged: tr ? tr.ranged : STATS[kind].range > 2.2,
        magical: !!tr?.magical,
        healer: isHealer(kind),
        tank: isTank(kind),
        shape: tr?.shape ?? 'single',
        aoe: tr?.aoe ?? 0,
        skill: tr?.skill ?? null,
        race: tr?.race ?? null,
      });
      this.entries.push({ el, kind, canvas: null, sheet: this.cache.get(this.key(kind)) ?? null, overlay, visible: false, phase: (i * 0.37) % 1 });
      this.observer!.observe(el);
    });
    document.addEventListener('visibilitychange', this.onVis);
    this.startLoop();
  }

  /** Stops the loop and forgets the current cards (the sheet cache stays). */
  detach(): void {
    this.stopLoop();
    document.removeEventListener('visibilitychange', this.onVis);
    this.observer?.disconnect();
    this.observer = null;
    this.job?.job.cancel();
    this.job = null;
    this.entries = [];
  }

  /** Drops all cached sheets (palette / team colours changed). */
  clear(): void {
    this.cache.clear();
    for (const e of this.entries) e.sheet = null;
    this.job?.job.cancel();
    this.job = null;
  }

  private key(kind: number): string {
    return `${kind}:${this.team}`;
  }

  private startLoop(): void {
    if (this.raf) return;
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      this.pump();
      if (now - this.lastTick < TICK_MS) return;
      this.lastTick = now;
      this.draw(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Renders pending sheets, visible cards first, within a small time budget per frame. */
  private pump(): void {
    const t0 = performance.now();
    while (performance.now() - t0 < BUDGET_MS) {
      if (!this.job) {
        const next = this.entries.find((e) => e.visible && !e.sheet) ?? null;
        if (!next) return;
        this.job = { entry: next, job: this.d.begin(next.kind, this.team, this.frames) };
      }
      const sheet = this.job.job.step();
      if (!sheet) continue;
      const done = this.job.entry;
      this.job = null;
      this.cache.set(this.key(done.kind), sheet);
      if (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value as string);
      for (const e of this.entries) if (e.kind === done.kind) e.sheet = sheet;
    }
  }

  private draw(now: number): void {
    for (const e of this.entries) {
      if (!e.visible || !e.sheet) continue;
      if (!e.canvas) {
        const c = document.createElement('canvas');
        const r = e.el.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, this.touch ? 2 : 1.5);
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
        e.el.replaceChildren(c);
        e.canvas = c;
      }
      const s = e.sheet;
      const ctx = e.canvas.getContext('2d')!;
      const { frame, swing } = frameAt(now / CYCLE_MS + e.phase, s.frames);
      ctx.clearRect(0, 0, e.canvas.width, e.canvas.height);
      ctx.drawImage(s.canvas, frame * s.fw, 0, s.fw, s.fh, 0, 0, e.canvas.width, e.canvas.height);
      if (swing >= 0.5) drawOverlay(ctx, e.overlay, (swing - 0.5) / 0.5, e.canvas.width, e.canvas.height);
    }
  }
}

/** Strike effect on top of the frame: `p` runs 0..1 over the strike/recovery part of the attack. */
function drawOverlay(ctx: CanvasRenderingContext2D, o: Overlay, p: number, w: number, h: number): void {
  const a = Math.max(0, 1 - p * p);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = o.color;
  ctx.fillStyle = o.color;
  ctx.lineCap = 'round';
  const cx = w * 0.64;
  const cy = h * 0.58;
  const u = w / 118; // scale relative to the desktop card width
  switch (o.kind) {
    case 'slash':
    case 'wide-slash': {
      const r = (o.kind === 'slash' ? 26 : 38) * u;
      ctx.lineWidth = 4 * u;
      ctx.beginPath();
      ctx.arc(cx - 10 * u, cy, r, -1.0 + p * 0.6, 0.9 + p * 0.5);
      ctx.stroke();
      break;
    }
    case 'ring': {
      ctx.lineWidth = 3 * u;
      ctx.beginPath();
      ctx.ellipse(cx, cy + 18 * u, (16 + p * 36) * u, (6 + p * 14) * u, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'shock': {
      ctx.lineWidth = 4 * u;
      ctx.beginPath();
      ctx.ellipse(cx - 6 * u, cy + 22 * u, (12 + p * 44) * u, (5 + p * 16) * u, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'arrow':
    case 'bolt': {
      const x = w * (0.66 + 0.4 * p);
      const len = (o.kind === 'bolt' ? 22 : 14) * u;
      ctx.globalAlpha = 1 - p * 0.6;
      ctx.lineWidth = (o.kind === 'bolt' ? 3 : 2) * u;
      ctx.beginPath();
      ctx.moveTo(x - len, cy - 6 * u);
      ctx.lineTo(x, cy - 6 * u);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, cy - 6 * u);
      ctx.lineTo(x - 4 * u, cy - 9 * u);
      ctx.lineTo(x - 4 * u, cy - 3 * u);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'axe': {
      const x = w * (0.66 + 0.4 * p);
      ctx.translate(x, cy - 6 * u);
      ctx.rotate(p * 9);
      ctx.globalAlpha = 1 - p * 0.5;
      ctx.fillRect(-3 * u, -8 * u, 6 * u, 16 * u);
      break;
    }
    case 'orb': {
      const x = w * (0.62 + 0.44 * p);
      const r = (6 + (1 - p) * 4) * u;
      ctx.globalAlpha = 0.9 - p * 0.5;
      const g = ctx.createRadialGradient(x, cy - 8 * u, 0, x, cy - 8 * u, r * 2.2);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, o.color);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, cy - 8 * u, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}
