import { fmtNum, t } from '../i18n';
import type { SimBackend } from '../sim/backend';
import { KIND_COUNT, MAX_TEAMS, unitDisplayName } from '../sim/units';

/** Damage with a short suffix: 950, 4.2k, 48.2k, 1.3m. */
export function fmtDamage(n: number): string {
  if (n >= 1e6) return `${fmtNum(n / 1e6)}m`;
  if (n >= 1000) return `${fmtNum(n / 1000)}k`;
  return String(Math.round(n));
}

/** m:ss */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export interface MeterRow {
  kind: number;
  dmg: number;
  alive: number;
  total: number;
  /** Share of the team's damage, 0..100 (rounded). */
  share: number;
  /** Damage per second over the whole battle so far. */
  dps: number;
  dead: boolean;
  /** Battle time at which the last soldier of this kind fell (-1 while alive). */
  fellAt: number;
}

/**
 * Builds the ranked rows of one team: kinds that have soldiers (or damage), sorted by damage, ties by kind.
 * `dmg[kind]`, `alive[kind]`, `total[kind]` and `fellAt[kind]` are per kind of that team.
 */
export function rankRows(dmg: ArrayLike<number>, alive: ArrayLike<number>, total: ArrayLike<number>, fellAt: ArrayLike<number>, time: number): MeterRow[] {
  let sum = 0;
  for (let k = 0; k < dmg.length; k++) sum += dmg[k];
  const rows: MeterRow[] = [];
  for (let k = 0; k < dmg.length; k++) {
    if (total[k] <= 0 && alive[k] <= 0 && dmg[k] <= 0) continue;
    const tot = Math.max(total[k], alive[k]);
    rows.push({
      kind: k,
      dmg: dmg[k],
      alive: alive[k],
      total: tot,
      share: sum > 0 ? Math.round((dmg[k] / sum) * 100) : 0,
      dps: time > 0.5 ? dmg[k] / time : 0,
      dead: alive[k] <= 0 && tot > 0,
      fellAt: fellAt[k],
    });
  }
  rows.sort((a, b) => b.dmg - a.dmg || a.kind - b.kind);
  return rows;
}

export interface MeterDeps {
  /** Still image of a unit in a team's colours. */
  icon(kind: number, team: number): HTMLCanvasElement;
  teamName(team: number): string;
  /** Team colours as CSS strings. */
  colors: string[];
}

const KEY_COLLAPSED = 'rpgweb.meter.collapsed';
const MEDAL = ['#e0a82e', '#aeb6c2', '#c27a3f'];

/** In-battle damage meter: team tabs and, for the selected team, its unit types ranked by damage dealt. */
export class DpsMeter {
  private readonly el: HTMLElement;
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows = new Map<number, { el: HTMLElement; fill: HTMLElement; rk: HTMLElement; sub: HTMLElement; val: HTMLElement; pct: HTMLElement }>();
  private readonly thumbs = new Map<string, string>();
  private team = 0;
  private collapsed: boolean;
  // Per team x kind bookkeeping derived from the unit arrays.
  private readonly total = new Int32Array(MAX_TEAMS * KIND_COUNT);
  private readonly peak = new Int32Array(MAX_TEAMS * KIND_COUNT);
  private readonly fell = new Float32Array(MAX_TEAMS * KIND_COUNT).fill(-1);
  private started = false;
  // Scratch buffers: update() runs 5 times a second and must not allocate.
  private readonly aliveBuf = new Int32Array(MAX_TEAMS * KIND_COUNT);
  private readonly sDmg = new Float64Array(KIND_COUNT);
  private readonly sAlive = new Float64Array(KIND_COUNT);
  private readonly sTotal = new Float64Array(KIND_COUNT);
  private readonly sFell = new Float64Array(KIND_COUNT);

  constructor(
    root: HTMLElement,
    private readonly d: MeterDeps,
    teamCount: number,
  ) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY_COLLAPSED);
    } catch {
      /* storage blocked */
    }
    this.collapsed = stored === null ? window.matchMedia('(max-width: 760px), (max-height: 520px)').matches : stored === '1';
    this.el = document.createElement('div');
    this.el.className = 'dps';
    this.el.innerHTML = `<div class="dps-tabs" role="tablist"></div><div class="dps-head"></div><div class="dps-list"></div>`;
    root.appendChild(this.el);
    const tabsEl = this.el.querySelector('.dps-tabs') as HTMLElement;
    this.head = this.el.querySelector('.dps-head') as HTMLElement;
    this.list = this.el.querySelector('.dps-list') as HTMLElement;
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    for (let ti = 0; ti < teamCount; ti++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dps-tab';
      b.setAttribute('role', 'tab');
      b.style.background = d.colors[ti];
      // On a narrow screen a default name ("Team 3" / "Takım 3") does not fit the tab: show the number, keep the name as the tooltip.
      const full = d.teamName(ti);
      b.textContent = narrow && full === t('battle.team.name', { n: ti + 1 }) ? String(ti + 1) : full;
      b.title = full;
      b.addEventListener('click', () => {
        this.team = ti;
        this.paintTabs();
        this.rows.forEach((r) => r.el.remove());
        this.rows.clear();
      });
      tabsEl.appendChild(b);
      this.tabs.push(b);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dps-toggle';
    toggle.setAttribute('aria-label', t('battle.meter.toggle'));
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      try {
        localStorage.setItem(KEY_COLLAPSED, this.collapsed ? '1' : '0');
      } catch {
        /* storage blocked */
      }
      this.paintCollapsed();
    });
    tabsEl.appendChild(toggle);
    this.paintTabs();
    this.paintCollapsed();
  }

  private paintTabs(): void {
    this.tabs.forEach((b, i) => {
      b.classList.toggle('on', i === this.team);
      b.setAttribute('aria-selected', String(i === this.team));
    });
  }

  private paintCollapsed(): void {
    this.el.classList.toggle('collapsed', this.collapsed);
    (this.el.querySelector('.dps-toggle') as HTMLElement).textContent = this.collapsed ? '▸' : '▾';
  }

  private thumb(kind: number, team: number): string {
    const key = `${kind}:${team}`;
    let url = this.thumbs.get(key);
    if (!url) {
      try {
        url = this.d.icon(kind, team).toDataURL('image/png');
      } catch {
        url = '';
      }
      this.thumbs.set(key, url);
    }
    return url;
  }

  /** Refreshes the numbers (called with the HUD tick). */
  update(sim: SimBackend): void {
    const u = sim.units;
    const alive = this.aliveBuf;
    alive.fill(0);
    for (let i = 0; i < u.count; i++) if (u.alive[i]) alive[u.team[i] * KIND_COUNT + u.kind[i]]++;
    if (!this.started) {
      // Starting strength: the soldiers that are alive at the first update (dormant summons are not counted).
      this.total.set(alive);
      this.started = true;
    }
    const time = sim.time;
    for (let k = 0; k < alive.length; k++) {
      if (alive[k] > this.peak[k]) this.peak[k] = alive[k];
      if (alive[k] === 0 && this.peak[k] > 0 && this.fell[k] < 0) this.fell[k] = time;
      else if (alive[k] > 0) this.fell[k] = -1;
    }
    if (this.collapsed) {
      this.head.textContent = '';
      return;
    }
    const base = this.team * KIND_COUNT;
    const sl = (a: ArrayLike<number>, out: Float64Array): Float64Array => {
      for (let k = 0; k < KIND_COUNT; k++) out[k] = a[base + k];
      return out;
    };
    const rows = rankRows(sl(sim.meter.dmg, this.sDmg), sl(alive, this.sAlive), sl(this.total, this.sTotal), sl(this.fell, this.sFell), time);
    let totalDmg = 0;
    for (const r of rows) totalDmg += r.dmg;
    this.head.textContent = t('battle.meter.total', { total: fmtDamage(totalDmg), time: fmtTime(time) });
    const max = rows.length ? Math.max(1, rows[0].dmg) : 1;
    const keep = new Set<number>();
    rows.forEach((r, i) => {
      keep.add(r.kind);
      let ui = this.rows.get(r.kind);
      if (!ui) {
        const el = document.createElement('div');
        el.className = 'dps-row';
        el.innerHTML = `<i class="dps-fill"></i><span class="dps-rk"></span><img class="dps-th" alt="" /><span class="dps-nm"><b></b><small></small></span><span class="dps-v"><b></b><em></em></span>`;
        (el.querySelector('.dps-th') as HTMLImageElement).src = this.thumb(r.kind, this.team);
        (el.querySelector('.dps-nm b') as HTMLElement).textContent = unitDisplayName(r.kind);
        ui = {
          el,
          fill: el.querySelector('.dps-fill') as HTMLElement,
          rk: el.querySelector('.dps-rk') as HTMLElement,
          sub: el.querySelector('.dps-nm small') as HTMLElement,
          val: el.querySelector('.dps-v b') as HTMLElement,
          pct: el.querySelector('.dps-v em') as HTMLElement,
        };
        (ui.fill.style as CSSStyleDeclaration).background = this.d.colors[this.team];
        this.rows.set(r.kind, ui);
      }
      ui.rk.textContent = String(i + 1);
      ui.rk.style.color = i < 3 ? MEDAL[i] : '';
      ui.fill.style.width = `${Math.round((r.dmg / max) * 100)}%`;
      ui.sub.textContent = r.dead && r.fellAt >= 0 ? t('battle.meter.fell', { alive: r.alive, total: r.total, time: fmtTime(r.fellAt) }) : t('battle.meter.alive', { alive: r.alive, total: r.total, dps: Math.round(r.dps) });
      ui.val.textContent = fmtDamage(r.dmg);
      ui.pct.textContent = `${r.share}%`;
      ui.el.classList.toggle('dead', r.dead);
      this.list.appendChild(ui.el); // re-appending moves the row: keeps the ranking order without rebuilding
    });
    for (const [k, ui] of this.rows) {
      if (!keep.has(k)) {
        ui.el.remove();
        this.rows.delete(k);
      }
    }
  }

  /** A new battle started in the same HUD (restart): forget the bookkeeping. */
  reset(): void {
    this.total.fill(0);
    this.peak.fill(0);
    this.fell.fill(-1);
    this.started = false;
    this.rows.forEach((r) => r.el.remove());
    this.rows.clear();
  }

  destroy(): void {
    this.el.remove();
  }
}
