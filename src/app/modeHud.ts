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
/** VIP mode: one health bar per team's VIP (hp is the fraction of its maximum, 0 when dead). */
export interface VipStrip {
  kind: 'vip';
  teams: Array<{ unit: number; hp: number; alive: boolean }>;
  timeLeft: number;
}
/** Capture the Flag: captures per team and where each flag is (home base or carried by a unit). */
export interface CtfStrip {
  kind: 'ctf';
  captures: number[];
  target: number;
  radius: number;
  flags: Array<{ team: number; x: number; y: number; carrier: number; carrierTeam: number }>;
  timeLeft: number;
}
/** Siege: the defending team's core (hp as a fraction) and the time left. */
export interface SiegeStrip {
  kind: 'siege';
  defender: number;
  coreHp: number;
  coreMaxHp: number;
  timeLeft: number;
}
/** Horde: wave counter, time to the next wave and how many monsters are alive. */
export interface HordeStrip {
  kind: 'horde';
  wave: number;
  waves: number;
  nextIn: number;
  hordeAlive: number;
  hordeTeam: number;
  timeLeft: number;
}
export type StripData = HillStrip | VipStrip | CtfStrip | SiegeStrip | HordeStrip;

/** Colours per team index as CSS strings. */
export type StripColors = string[];

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const fmtClock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Share of the goal reached, 0..1. */
export function stripProgress(score: number, target: number): number {
  return target > 0 ? Math.max(0, Math.min(1, score / target)) : 0;
}

/** Owned control points per team (index = team). */
export function pointsHeld(data: HillStrip, teamCount: number): number[] {
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
    if (key !== this.builtFor) this.build(teamCount, data.kind);
    if (data.kind === 'vip') {
      for (let i = 0; i < teamCount; i++) {
        const row = this.rows[i];
        const team = data.teams[i];
        if (!row || !team) continue;
        row.fill.style.width = `${(Math.max(0, Math.min(1, team.hp)) * 100).toFixed(1)}%`;
        row.score.textContent = team.alive ? `${Math.round(team.hp * 100)}%` : t('mode.hud.vip.down');
        row.held.textContent = team.alive ? '♛' : '';
      }
      const left = data.timeLeft > 0 ? ` · ${t('mode.hud.vip.time', { time: fmtClock(data.timeLeft) })}` : '';
      this.meta.textContent = `${t('mode.hud.vip.hint')}${left}`;
      return;
    }
    if (data.kind === 'horde') {
      const row = this.rows[0];
      if (row) {
        row.fill.style.width = `${(stripProgress(data.wave, data.waves) * 100).toFixed(1)}%`;
        row.fill.style.background = this.colors[data.hordeTeam] ?? '#c0392b';
        row.score.textContent = t('mode.hud.horde.wave', { n: data.wave, total: data.waves });
        row.held.textContent = '';
      }
      const next = data.wave >= data.waves ? t('mode.hud.horde.last') : t('mode.hud.horde.next', { s: Math.ceil(data.nextIn) });
      this.meta.textContent = `${next} · ${t('mode.hud.horde.alive', { n: data.hordeAlive })}`;
      return;
    }
    if (data.kind === 'siege') {
      const row = this.rows[0];
      if (row) {
        row.fill.style.width = `${(Math.max(0, Math.min(1, data.coreHp)) * 100).toFixed(1)}%`;
        row.fill.style.background = this.colors[data.defender] ?? '#888';
        row.score.textContent = `${Math.ceil(Math.max(0, data.coreHp) * data.coreMaxHp)}`;
        row.held.textContent = '';
        row.held.title = t('mode.hud.siege.core');
      }
      const left = data.timeLeft > 0 ? ` · ${t('mode.hud.siege.time', { time: fmtClock(data.timeLeft) })}` : '';
      this.meta.textContent = `${t('mode.hud.siege.defends', { n: data.defender + 1 })}${left}`;
      return;
    }
    if (data.kind === 'ctf') {
      const ctf = ctfStatus(data, teamCount);
      for (let i = 0; i < teamCount; i++) {
        const row = this.rows[i];
        if (!row) continue;
        const c = data.captures[i] ?? 0;
        row.fill.style.width = `${(stripProgress(c, data.target) * 100).toFixed(1)}%`;
        row.score.textContent = String(c);
        row.held.textContent = `${ctf.carrying[i] ? '⚑' : ''}${ctf.stolen[i] ? '⚐' : ''}`;
        row.held.title = [ctf.carrying[i] ? t('mode.hud.ctf.carrying') : '', ctf.stolen[i] ? t('mode.hud.ctf.stolen') : ''].filter(Boolean).join(' · ');
      }
      const left = data.timeLeft > 0 ? ` · ${t('mode.hud.ctf.time', { time: fmtClock(data.timeLeft) })}` : '';
      this.meta.textContent = `${t('mode.hud.ctf.target', { target: data.target })}${left}`;
      return;
    }
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

  private build(teamCount: number, kind: StripData['kind']): void {
    this.builtFor = `${kind}:${teamCount}`;
    this.el.innerHTML = '<div class="hm-rows"></div><div class="hm-meta"></div>';
    const rows = this.el.querySelector('.hm-rows') as HTMLElement;
    this.meta = this.el.querySelector('.hm-meta') as HTMLElement;
    this.rows = [];
    const single = kind === 'siege' || kind === 'horde';
    const n = single ? 1 : teamCount;
    for (let i = 0; i < n; i++) {
      const color = this.colors[single ? 0 : i] ?? '#888';
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

/** Map markers (crown + ring) of the VIPs that are still alive, at their interpolated positions. */
export function vipMarkers(
  hud: VipStrip,
  units: { px: ArrayLike<number>; py: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number>; alive: ArrayLike<number> },
  alpha: number,
  teamColors: number[],
): Array<{ x: number; y: number; color: number; kind: 'vip' }> {
  const out: Array<{ x: number; y: number; color: number; kind: 'vip' }> = [];
  hud.teams.forEach((team, ti) => {
    const i = team.unit;
    if (!team.alive || i < 0 || !units.alive[i]) return;
    out.push({ x: units.px[i] + (units.x[i] - units.px[i]) * alpha, y: units.py[i] + (units.y[i] - units.py[i]) * alpha, color: teamColors[ti] ?? 0xffffff, kind: 'vip' });
  });
  return out;
}

/** Per team: whether one of its units carries an enemy flag, and whether its own flag has been stolen. */
export function ctfStatus(data: CtfStrip, teamCount: number): { carrying: boolean[]; stolen: boolean[] } {
  const carrying = new Array<boolean>(teamCount).fill(false);
  const stolen = new Array<boolean>(teamCount).fill(false);
  for (const f of data.flags) {
    if (f.carrier < 0) continue;
    if (f.carrierTeam >= 0 && f.carrierTeam < teamCount) carrying[f.carrierTeam] = true;
    if (f.team >= 0 && f.team < teamCount) stolen[f.team] = true;
  }
  return { carrying, stolen };
}

/** Flag markers: at the home base, or over the carrier (interpolated like the unit). */
export function ctfMarkers(
  hud: CtfStrip,
  units: { px: ArrayLike<number>; py: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number>; alive: ArrayLike<number> },
  alpha: number,
  teamColors: number[],
): Array<{ x: number; y: number; color: number; kind: 'flag' }> {
  return hud.flags.map((f) => {
    const i = f.carrier;
    const carried = i >= 0 && !!units.alive[i];
    return {
      x: carried ? units.px[i] + (units.x[i] - units.px[i]) * alpha : f.x,
      y: carried ? units.py[i] + (units.y[i] - units.py[i]) * alpha : f.y,
      color: teamColors[f.team] ?? 0xffffff,
      kind: 'flag' as const,
    };
  });
}
