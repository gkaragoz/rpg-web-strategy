import { t } from '../i18n';

const HISTORY = 120;

export interface StatsInfo {
  blue: number;
  red: number;
  projectiles: number;
  simSteps: number;
  speed: number;
  paused: boolean;
  extra?: string[];
}

/** FPS / profiler panel at the top right. */
/** On touch devices the stats panel is hidden by default (it covers the screen); opened with the HUD button. */
export const STATS_DEFAULT_SHOWN = typeof matchMedia === 'undefined' || !matchMedia('(pointer: coarse)').matches;

export class StatsPanel {
  private readonly el: HTMLElement;
  private readonly graph: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly frames = new Float32Array(HISTORY);
  private idx = 0;
  private filled = 0;
  private simAcc = 0;
  private renderAcc = 0;
  private samples = 0;
  private lastUpdate = 0;
  visible = true;
  /** Whether the scene wants the panel shown (hidden in the studio). */
  private shown = true;

  constructor(el: HTMLElement) {
    this.el = el;
    this.graph = document.createElement('canvas');
    this.graph.width = 200;
    this.graph.height = 36;
    this.ctx = this.graph.getContext('2d')!;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.apply();
  }

  setShown(show: boolean): void {
    this.shown = show;
    this.apply();
  }

  private apply(): void {
    this.el.style.display = this.visible && this.shown ? '' : 'none';
  }

  push(frameMs: number, simMs: number, renderMs: number): void {
    this.frames[this.idx] = frameMs;
    this.idx = (this.idx + 1) % HISTORY;
    this.filled = Math.min(HISTORY, this.filled + 1);
    this.simAcc += simMs;
    this.renderAcc += renderMs;
    this.samples++;
  }

  update(now: number, info: StatsInfo): void {
    if (!this.visible || !this.shown || now - this.lastUpdate < 250) return;
    this.lastUpdate = now;

    const n = this.filled;
    const sorted = Array.from(this.frames.subarray(0, n)).sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    const avgMs = n ? sum / n : 0;
    const worst = Math.max(1, Math.ceil(n * 0.01));
    let worstSum = 0;
    for (let i = n - worst; i < n; i++) worstSum += sorted[i];
    const lowMs = n ? worstSum / worst : 0;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

    const lines = [
      `FPS        ${(1000 / (avgMs || 1)).toFixed(0)}  (1% low ${(1000 / (lowMs || 1)).toFixed(0)})`,
      `${t('battle.stats.frame').padEnd(11)}${avgMs.toFixed(2)} ms`,
      `${t('battle.stats.sim').padEnd(11)}${(this.simAcc / (this.samples || 1)).toFixed(2)} ms  ${t('battle.stats.stepsPerFrame', { n: info.simSteps })}`,
      `${t('battle.stats.render').padEnd(11)}${(this.renderAcc / (this.samples || 1)).toFixed(2)} ms  (CPU)`,
      `${t('battle.stats.blue')} ${String(info.blue).padStart(4)}   ${t('battle.stats.red')} ${String(info.red).padStart(4)}`,
      `${t('battle.stats.arrows').padEnd(11)}${info.projectiles}`,
      heap ? `JS heap    ${(heap.usedJSHeapSize / 1048576).toFixed(1)} MB` : '',
      `${t('battle.stats.speed').padEnd(11)}x${info.speed}${info.paused ? '  ' + t('battle.stats.paused') : ''}`,
      ...(info.extra ?? []),
    ].filter(Boolean);
    this.el.textContent = lines.join('\n');
    this.el.appendChild(this.graph);
    this.drawGraph();
    this.simAcc = this.renderAcc = 0;
    this.samples = 0;
  }

  private drawGraph(): void {
    const { ctx, graph } = this;
    ctx.clearRect(0, 0, graph.width, graph.height);
    const scale = graph.height / 33.3; // 30 FPS = full height
    for (let i = 0; i < this.filled; i++) {
      const v = this.frames[(this.idx - this.filled + i + HISTORY * 2) % HISTORY];
      const h = Math.min(graph.height, v * scale);
      ctx.fillStyle = v > 25 ? '#e0463b' : v > 17.5 ? '#e6b73a' : '#4cc35b';
      ctx.fillRect(i * (graph.width / HISTORY), graph.height - h, graph.width / HISTORY - 0.5, h);
    }
  }
}
