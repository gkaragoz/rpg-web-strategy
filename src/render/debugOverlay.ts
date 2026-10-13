import { Graphics } from 'pixi.js';
import { t } from '../i18n';
import { isoX, isoY } from '../iso';
import type { Battle } from '../sim/battle';
import { STATS } from '../sim/units';
import { StallDetector, type Flag } from '../sim/testing/stall';
import type { WorldView } from '../app/world';

const FLAG_SHOW_SECS = 12;

/**
   * ?debug=1: stall/loop tracking layer. The sim runs on the main thread (InlineSim), the
   * StallDetector from the test suite watches the battle live; problem units are marked on
   * the map with a ring, target lines / A* paths / closed regions can be toggled.
 *
   * Keys: H layer on/off · T target lines · P paths · G closed regions
 */
export class DebugOverlay {
  private readonly g = new Graphics();
  private readonly regions = new Graphics();
  private readonly panel: HTMLElement;
  private readonly detector: StallDetector;
  private readonly marked = new Map<number, { until: number; type: Flag['type'] }>();
  private seen = 0;
  private showAll = true;
  private showTargets = false;
  private showPaths = true;
  private showRegions = false;
  private lastPanel = 0;
  private readonly keyHandler: (e: KeyboardEvent) => void;

  constructor(
    private readonly battle: Battle,
    world: WorldView,
  ) {
    this.detector = new StallDetector(battle);
    world.fxLayer.addChild(this.regions, this.g);
    this.buildRegions();
    this.regions.visible = false;

    this.panel = document.createElement('div');
    this.panel.id = 'debug-panel';
    document.body.appendChild(this.panel);

    this.keyHandler = (e) => {
      if (e.code === 'KeyH') this.showAll = !this.showAll;
      else if (e.code === 'KeyT') this.showTargets = !this.showTargets;
      else if (e.code === 'KeyP') this.showPaths = !this.showPaths;
      else if (e.code === 'KeyG') {
        this.showRegions = !this.showRegions;
        this.regions.visible = this.showRegions && this.showAll;
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  /** Called on every sim step (InlineSim.onStep). */
  onStep(): void {
    this.detector.observe();
    const flags = this.detector.flags;
    for (; this.seen < flags.length; this.seen++) {
      const f = flags[this.seen];
      if (f.unit !== undefined) this.marked.set(f.unit, { until: this.battle.time + FLAG_SHOW_SECS, type: f.type });
    }
  }

  private buildRegions(): void {
    const t = this.battle.terrain;
    if (!t) return;
    const n = t.size;
    for (let i = 0; i < t.region.length; i++) {
      if (t.region[i] < 0 || t.region[i] === t.mainRegion) continue;
      const tx = i % n;
      const ty = Math.floor(i / n);
      const pts = [isoX(tx + 0.5, ty), isoY(tx + 0.5, ty), isoX(tx + 1, ty + 0.5), isoY(tx + 1, ty + 0.5), isoX(tx + 0.5, ty + 1), isoY(tx + 0.5, ty + 1), isoX(tx, ty + 0.5), isoY(tx, ty + 0.5)];
      this.regions.poly(pts).fill({ color: 0xff2d95, alpha: 0.45 });
    }
  }

  /** Every frame: draw + panel (alpha: interpolation within the sim interval). */
  update(alpha: number): void {
    const g = this.g;
    g.clear();
    const b = this.battle;
    const u = b.units;
    this.regions.visible = this.showRegions && this.showAll;
    const paths = (b as unknown as { paths: Map<number, { pts: number[]; k: number }> }).paths;
    let stuck = 0;
    for (let i = 0; i < u.count; i++) {
      if (!u.alive[i]) continue;
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      const sx = isoX(wx, wy);
      const sy = isoY(wx, wy);
      const isStuck = u.stuckT[i] > 0.3;
      if (isStuck) stuck++;
      if (!this.showAll) continue;

      const m = this.marked.get(i);
      if (m && m.until > b.time) {
        // Detector flag: red pulsing ring.
        const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 160);
        g.ellipse(sx, sy, 26 * pulse + 6, 13 * pulse + 3).stroke({ width: 3, color: 0xff3b30, alpha: 0.95 });
      } else if (isStuck) {
        g.ellipse(sx, sy, 20, 10).stroke({ width: 2, color: 0xffa500, alpha: 0.9 });
      } else if (u.banT[i] > 0) {
        g.ellipse(sx, sy, 18, 9).stroke({ width: 1.5, color: 0xb388ff, alpha: 0.9 });
      }

      const t = u.target[i];
      if (this.showTargets && t >= 0 && u.alive[t]) {
        g.moveTo(sx, sy).lineTo(isoX(u.x[t], u.y[t]), isoY(u.x[t], u.y[t])).stroke({ width: 1, color: 0xffffff, alpha: 0.35 });
      } else if (m && m.until > b.time && t >= 0 && u.alive[t]) {
        g.moveTo(sx, sy).lineTo(isoX(u.x[t], u.y[t]), isoY(u.x[t], u.y[t])).stroke({ width: 2, color: 0xff3b30, alpha: 0.8 });
      }
    }

    if (this.showAll && this.showPaths) {
      for (const [i, p] of paths) {
        if (!u.alive[i]) continue;
        let px = isoX(u.x[i], u.y[i]);
        let py = isoY(u.x[i], u.y[i]);
        g.moveTo(px, py);
        for (let k = p.k; k < p.pts.length / 2; k++) {
          px = isoX(p.pts[k * 2], p.pts[k * 2 + 1]);
          py = isoY(p.pts[k * 2], p.pts[k * 2 + 1]);
          g.lineTo(px, py);
        }
        g.stroke({ width: 1.5, color: 0x3ddc84, alpha: 0.85 });
      }
    }

    const now = performance.now();
    if (now - this.lastPanel > 250) {
      this.lastPanel = now;
      this.renderPanel(stuck, paths.size);
    }
  }

  private renderPanel(stuck: number, pathCount: number): void {
    const b = this.battle;
    const flags = this.detector.flags;
    const counts = new Map<string, number>();
    for (const f of flags) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
    const recent = flags
      .slice(-6)
      .reverse()
      .map((f) => `<div class="dbg-flag"><b>${f.type}</b> t=${f.t}<br>${f.info.replace(/</g, '&lt;')}</div>`)
      .join('');
    const sum = [...counts.entries()].map(([k, v]) => `${k}:${v}`).join('  ') || t('battle.dbg.clean');
    this.panel.innerHTML = `<div class="dbg-title">${t('battle.dbg.title')}</div>
<div>${t('battle.dbg.summary', { stuck, paths: pathCount, bans: b.dbg.bans, leash: b.dbg.leashBreaks, fails: b.dbg.pathFails })}</div>
<div>${t('battle.dbg.flags', { sum })}</div>
<div class="dbg-sub">${t('battle.dbg.alive', { alive: b.alivePerTeam.slice(0, 6).join('/'), kinds: STATS.length })}</div>${recent}`;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keyHandler);
    this.panel.remove();
    this.g.destroy();
    this.regions.destroy();
  }
}
