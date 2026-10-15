import { t } from '../i18n';

/** What the objective strip shows (a structural copy of the sim's mode HUD data for hill; other modes add their own kinds). */
export interface HillStrip {
  kind: 'hill';
  /** Points per team (index = team). */
  scores: number[];
  target: number;
  points: Array<{ x: number; y: number; radius: number; owner: number }>;
  /** Seconds of battle left before the fallback result (0 = no limit). */
  timeLeft: number;
}
export type StripData = HillStrip;

/** Colours per team index as CSS strings. */
export type StripColors = string[];

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtClock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Share of the goal reached, 0..1. */
export function stripProgress(score: number, target: number): number {
  return target > 0 ? Math.max(0, Math.min(1, score / target)) : 0;
}

/** Owned control points per team (index = team). */
export function pointsHeld(data: StripData, teamCount: number): number[] {
  const held = new Array<number>(teamCount).fill(0);
  for (const p of data.points) if (p.owner >= 0 && p.owner < teamCount) held[p.owner]++;
  return held;
}

/**
 * Thin objective strip under the team bar: one progress bar per team towards the goal, the number of held points and the time left.
 * The DOM is built once and only text/width values change afterwards (it updates a few times per second during battle).
 */
export class ModeStrip {
  readonly el = document.createElement('div');
  private rows: Array<{ fill: HTMLElement; score: HTMLElement; held: HTMLElement }> = [];
  private meta!: HTMLElement;
  private builtFor = '';

  constructor(private readonly colors: StripColors) {
    this.el.className = 'hud-mode';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-label', t('mode.hud.aria'));
    this.el.hidden = true;
  }

  update(data: StripData | null, teamCount: number): void {
    if (!data) {
      this.el.hidden = true;
      return;
    }
    this.el.hidden = false;
    const key = `${data.kind}:${teamCount}`;
    if (key !== this.builtFor) this.build(teamCount);
    const held = pointsHeld(data, teamCount);
    for (let i = 0; i < teamCount; i++) {
      const row = this.rows[i];
      if (!row) continue;
      const score = Math.floor(data.scores[i] ?? 0);
      row.fill.style.width = `${(stripProgress(score, data.target) * 100).toFixed(1)}%`;
      row.score.textContent = String(score);
      row.held.textContent = '●'.repeat(held[i]);
    }
    const left = data.timeLeft > 0 ? ` · ${t('mode.hud.hill.time', { time: fmtClock(data.timeLeft) })}` : '';
    this.meta.textContent = `${t('mode.hud.hill.target', { target: data.target })} · ${t('mode.hud.hill.points', { n: held.reduce((a, b) => a + b, 0), total: data.points.length })}${left}`;
  }

  private build(teamCount: number): void {
    this.builtFor = `hill:${teamCount}`;
    this.el.innerHTML = '<div class="hm-rows"></div><div class="hm-meta"></div>';
    const rows = this.el.querySelector('.hm-rows') as HTMLElement;
    this.meta = this.el.querySelector('.hm-meta') as HTMLElement;
    this.rows = [];
    for (let i = 0; i < teamCount; i++) {
      const color = this.colors[i] ?? '#888';
      const row = document.createElement('div');
      row.className = 'hm-row';
      row.title = t('mode.hud.hill.score', { n: i + 1, score: 0 });
      row.innerHTML = `<span class="hm-dot" style="background:${esc(color)}"></span><span class="hm-bar"><i style="background:${esc(color)}"></i></span><b class="hm-score">0</b><span class="hm-held" style="color:${esc(color)}"></span>`;
      rows.appendChild(row);
      this.rows.push({ fill: row.querySelector('i') as HTMLElement, score: row.querySelector('.hm-score') as HTMLElement, held: row.querySelector('.hm-held') as HTMLElement });
    }
  }
}

/** Tiles of every control point (those whose centre lies within its radius), coloured by the owner: shown on the map as zone overlays. */
export function hillZoneSpecs(points: HillStrip['points'], teamColors: number[], mapSize: number, neutral = 0xd9dee7): Array<{ color: number; mine: boolean; strong: boolean; tiles: Array<[number, number]> }> {
  return points.map((p) => {
    const tiles: Array<[number, number]> = [];
    const r = Math.ceil(p.radius);
    for (let ty = Math.max(0, Math.floor(p.y) - r); ty <= Math.min(mapSize - 1, Math.floor(p.y) + r); ty++) {
      for (let tx = Math.max(0, Math.floor(p.x) - r); tx <= Math.min(mapSize - 1, Math.floor(p.x) + r); tx++) {
        if (Math.hypot(tx + 0.5 - p.x, ty + 0.5 - p.y) <= p.radius) tiles.push([tx, ty]);
      }
    }
    return { color: p.owner >= 0 ? (teamColors[p.owner] ?? neutral) : neutral, mine: true, strong: true, tiles };
  });
}
