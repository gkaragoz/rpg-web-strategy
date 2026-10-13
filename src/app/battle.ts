import { drawProjectile, projStyle } from '../render/projectileStyle';
import { DpsMeter, fmtDamage, fmtTime } from './dpsMeter';
import { Graphics, type Application } from 'pixi.js';
import type { Camera } from '../camera';
import { isoX, isoY } from '../iso';
import type { Atlas } from '../render/atlas';
import { AudioSystem } from '../render/audio';
import { DebugOverlay } from '../render/debugOverlay';
import { ComedySystem, comedy } from '../render/comedy';
import { FxSystem, type FxQuality } from '../render/fx';
import { MassRenderer, type MassOptions, type MassViewport } from '../render/massRenderer';
import { DEATH_FADE, UnitView, type TeamColors } from '../render/unitView';
import type { SimBackend } from '../sim/backend';
import { terrainFor, type BattleConfig } from '../sim/battle';
import { SIM_DT } from '../sim/constants';
import { InlineSim } from '../sim/inlineSim';
import { KIND_COUNT, STATS, unitDisplayName } from '../sim/units';
import { WorkerSim } from '../sim/workerSim';
import type { StatsPanel } from '../ui/stats';
import { t } from '../i18n';
import { hex } from './state';
import type { WorldView } from './world';

const WARMUP_FRAMES = 60;
/** Below this unit count use detailed (animated) drawing, above it use mass drawing. */
const DETAILED_MAX = 150;

export interface BattleOptions {
  config: BattleConfig;
  colors: TeamColors[];
  speed: number;
  /** Benchmark: no HUD, automatic report. */
  bench: boolean;
  autoSeconds: number;
  useWorker: boolean;
  seed: number;
  /** Effect quality ('auto': by unit count) and floating damage numbers. */
  fx: 'auto' | FxQuality;
  numbers: boolean;
  /** ?debug=1: stall tracking layer (the sim runs on the main thread). */
  debug?: boolean;
  /** Back from the battle to the studio. */
  onEdit: () => void;
  /** Online (lockstep) sim; if given, BattleScene does not build its own sim. */
  sim?: SimBackend;
  /** Online match: controls are locked (speed/pause host only), player names, leave/rematch. */
  online?: {
    isHost: boolean;
    teamNames: string[];
    getSpeed: () => number;
    getPaused: () => boolean;
    /** Host only: tells everybody to switch the comedy look. */
    onComedyView?: (on: boolean) => void;
    onLeave: () => void;
    onRematch?: () => void;
  };
}

export interface BattleDeps {
  app: Application;
  world: WorldView;
  camera: Camera;
  getAtlas: () => Atlas;
  stats: StatsPanel;
  hudRoot: HTMLElement;
  banner: HTMLElement;
  audio: AudioSystem;
  /** Toggles sound (persistent); returns the new state. */
  toggleSound: () => boolean;
  isSoundOn: () => boolean;
  /** Toggles the debug layer (restarts the battle with the same layout). */
  isDebugOn: () => boolean;
  toggleDebug: () => void;
  /** Comedy view (live) and comedy physics (restarts the battle). */
  isComedyVisual: () => boolean;
  toggleComedyVisual: () => boolean;
  isComedyPhysics: () => boolean;
  toggleComedyPhysics: () => void;
  /** Still image of a unit in a team's colours (damage meter thumbnails). */
  icon: (kind: number, team: number) => HTMLCanvasElement;
}

/** Battle scene: sim (worker) + drawing (detailed or mass) + HUD + benchmark measurement. */
export class BattleScene {
  private sim!: SimBackend;
  private opts!: BattleOptions;
  private mass: MassRenderer | null = null;
  private views: UnitView[] = [];
  private arrowViews: Array<{ shadow: Graphics; arrow: Graphics; tag: number }> = [];
  private fx: FxSystem | null = null;
  private massOpts: MassOptions = { bars: true, sort: true, cull: true, focusTeam: -1, focusColor: 0xffffff };
  /** Team whose enemies are outlined: hovered bar segment, or the one pinned by a tap. -1: none. */
  private hoverTeam = -1;
  private pinnedTeam = -1;
  private segs: HTMLButtonElement[] = [];
  private tip: HTMLElement | null = null;
  private docDown: ((e: PointerEvent) => void) | null = null;
  private meterUi: DpsMeter | null = null;
  private speed = 1;
  private paused = false;
  private resetting = false;
  /** Incremented by exit(): an enter() that is still waiting for its worker must drop the result. */
  private enterId = 0;
  private seed = 1;
  private time = 0;
  private activeProjectiles = 0;
  /** Terrain height (screen pixels); 0 if there is no relief. */
  private elev: (x: number, y: number) => number = () => 0;
  private drawnLine = '';
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private lastHud = 0;
  private resultShown = false;
  private hiddenPaused = false;
  private debug: DebugOverlay | null = null;
  private comedySys: ComedySystem | null = null;
  private paintComedy: ((on: boolean) => void) | null = null;
  private initialAlive: number[] = [];
  private initialHp: number[] = [];
  private visHandler: (() => void) | null = null;

  // measurement
  private frameLog = new Float32Array(60 * 60 * 20);
  private frameCount = 0;
  private wallStart = 0;
  private mainSimTotalMs = 0;
  private renderTotalMs = 0;
  private stallMs = 0;
  private stallCount = 0;
  private reported = false;
  private simTimeBase = -1;

  constructor(private readonly d: BattleDeps) {}

  /** Speed and seed of the running battle (a restart keeps them). */
  get currentSpeed(): number {
    return this.speed;
  }
  get currentSeed(): number {
    return this.seed;
  }

  async enter(opts: BattleOptions): Promise<void> {
    const token = ++this.enterId;
    this.resetting = false;
    this.opts = opts;
    this.speed = opts.speed;
    this.seed = opts.seed;
    this.paused = false;
    this.resultShown = false;
    this.resetBenchStats();

    const cfg = opts.config;
    const sim = opts.sim ?? (opts.useWorker ? await WorkerSim.create(cfg, this.seed) : new InlineSim(cfg, this.seed));
    if (token !== this.enterId) {
      // exit() or a newer enter() happened while the worker was starting: this battle is stale.
      if (!opts.sim) sim.dispose();
      return;
    }
    this.sim = sim;
    this.sim.setSpeed(this.speed);

    const unitCount = this.sim.units.count;
    this.initialAlive = new Array(6).fill(0);
    this.initialHp = new Array(6).fill(0);
    // Summoned (dormant) skeletons do not count toward the starting tally: only living units.
    let anyAlive = false;
    for (let i = 0; i < unitCount; i++) if (this.sim.units.alive[i]) anyAlive = true;
    for (let i = 0; i < unitCount; i++) {
      if (anyAlive && !this.sim.units.alive[i]) continue;
      this.initialAlive[this.sim.units.team[i]]++;
      this.initialHp[this.sim.units.team[i]] += this.sim.units.maxHp[i];
    }
    const detailed = !opts.bench && unitCount <= DETAILED_MAX;
    const atlas = this.d.getAtlas();
    const { world, camera, app } = this.d;
    const reliefMap = !!cfg.map && cfg.map.relief !== 'flat';
    world.rebuild(cfg, atlas, detailed, !opts.bench || reliefMap);
    const terr = world.terrain;
    this.elev = terr && terr.hasRelief ? (x, y) => terr.elevPx(x, y) : () => 0;
    camera.setMap(world.mapSize);
    camera.fit(app.screen.width, app.screen.height);
    camera.enabled = !(opts.bench && opts.autoSeconds > 0);
    camera.singleFingerPan = true;

    if (detailed) {
      this.buildViews();
    } else {
      this.mass = new MassRenderer(app, this.sim, atlas, world.terrain);
      if (opts.bench && !reliefMap) world.staticLayer.addChildAt(this.mass.buildGround(), 0);
      world.entityLayer.addChild(this.mass.layer);
    }

    if (!opts.bench) {
      const quality: FxQuality = opts.fx === 'auto' ? (unitCount <= 400 ? 'high' : 'low') : opts.fx;
      // In a crowd floating numbers are unreadable: show only with few units.
      this.fx = new FxSystem(atlas, camera, quality, opts.numbers && unitCount <= 200);
      this.fx.elev = this.elev;
      this.fx.comicOn = opts.numbers && unitCount <= 400;
      this.comedySys = new ComedySystem(atlas, world.terrain, this.elev);
      world.fxLayer.addChild(this.comedySys.layer, this.fx.layer, this.fx.numbers);
    }

    if (opts.debug && this.sim instanceof InlineSim) {
      this.debug = new DebugOverlay(this.sim.battle, world);
      this.sim.onStep = () => this.debug?.onStep();
    }

    this.buildHud();
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    // When the tab is hidden the sim pauses (the battle is not missed) and sound is muted.
    this.visHandler = () => {
      this.d.audio.setHidden(document.hidden);
      if (document.hidden) {
        if (!this.paused) {
          this.sim.setPaused(true);
          this.hiddenPaused = true;
        }
      } else if (this.hiddenPaused) {
        this.sim.setPaused(this.paused);
        this.hiddenPaused = false;
      }
    };
    document.addEventListener('visibilitychange', this.visHandler);
    (window as unknown as { __sim: SimBackend }).__sim = this.sim;
  }

  exit(): void {
    this.enterId++;
    this.resetting = false;
    this.d.camera.singleFingerPan = false;
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    if (this.visHandler) document.removeEventListener('visibilitychange', this.visHandler);
    this.visHandler = null;
    this.sim?.dispose();
    for (const v of this.views) v.root.destroy({ children: true });
    this.views = [];
    for (const a of this.arrowViews) {
      a.arrow.destroy();
      a.shadow.destroy();
    }
    this.arrowViews = [];
    if (this.debug) {
      this.debug.destroy();
      this.debug = null;
    }
    if (this.comedySys) {
      this.comedySys.layer.destroy();
      this.comedySys = null;
    }
    if (this.fx) {
      this.fx.layer.destroy();
      this.fx.numbers.destroy({ children: true });
      this.fx = null;
    }
    if (this.mass) {
      this.mass.destroy();
      this.mass = null;
    }
    if (this.docDown) document.removeEventListener('pointerdown', this.docDown);
    this.docDown = null;
    this.segs = [];
    this.hoverTeam = this.pinnedTeam = -1;
    this.meterUi = null;
    this.d.hudRoot.innerHTML = '';
    this.d.hudRoot.hidden = true;
    this.d.banner.style.display = 'none';
    this.d.camera.enabled = true;
  }

  // ---- HUD ----

  private buildHud(): void {
    const root = this.d.hudRoot;
    root.hidden = false;
    if (this.opts.bench) {
      root.innerHTML = '';
      return;
    }
    root.innerHTML = `
<div class="hud-top" id="hud-teams"></div>
<div class="hud-tip" id="hud-tip" role="status" hidden></div>
<div class="hud-bottom">
  <div class="seg" id="hud-speed" role="group" aria-label="${t('battle.speed.aria')}"></div>
  <button type="button" id="hud-pause">${t('battle.pause')}</button>
  <button type="button" id="hud-sound" aria-pressed="true">${t('battle.sound')}</button>
  <button type="button" id="hud-cv" aria-pressed="false" title="${t('battle.cv.title')}">${t('battle.cv')}</button>
  <button type="button" id="hud-cp" class="sec" aria-pressed="false" title="${t('battle.cp.title')}">${t('battle.cp')}</button>
  <button type="button" id="hud-debug" class="sec" aria-pressed="false" title="${t('battle.debug.title')}">${t('battle.debug')}</button>
  <span class="hud-view" role="group" aria-label="${t('battle.camera.aria')}"><button type="button" id="hud-zout" aria-label="${t('battle.zoomOut')}">−</button><button type="button" id="hud-zin" aria-label="${t('battle.zoomIn')}">+</button><button type="button" id="hud-center" aria-label="${t('battle.center')}" title="${t('battle.center')}">⌖</button><button type="button" id="hud-stats" aria-label="${t('battle.stats.aria')}" title="${t('battle.stats.title')}">📊</button></span>
  <button type="button" id="hud-restart">${t('battle.restart')}</button>
  <button type="button" id="hud-edit" class="primary">${t('battle.edit')}</button>
</div>
<div class="hud-hint">${window.matchMedia('(pointer: coarse)').matches ? t('battle.hint.touch') : ''}${window.matchMedia('(pointer: coarse)').matches ? '' : this.opts.online ? (this.opts.online.isHost ? t('battle.hint.host') : t('battle.hint.guest')) + t('battle.hint.online') : t('battle.hint.solo')}</div>
<div class="result" id="hud-result" hidden></div>`;
    const q = (s: string) => root.querySelector(s) as HTMLElement;
    q('#hud-pause').addEventListener('click', () => this.togglePause());
    q('#hud-zin').addEventListener('click', () => this.d.camera.zoomBy(1.35));
    q('#hud-zout').addEventListener('click', () => this.d.camera.zoomBy(1 / 1.35));
    q('#hud-center').addEventListener('click', () => this.d.camera.fit(this.d.app.screen.width, this.d.app.screen.height));
    q('#hud-stats').addEventListener('click', () => this.d.stats.toggle());
    if (this.opts.online) {
      // Online: only Sound, Comedy view and Leave remain.
      for (const id of ['#hud-restart', '#hud-debug', '#hud-cp']) q(id).hidden = true;
      q('#hud-edit').textContent = this.opts.online.isHost ? t('battle.leave.host') : t('battle.leave.guest');
      q('#hud-edit').addEventListener('click', () => this.opts.online!.onLeave());
    }
    const cv = q('#hud-cv');
    const paintCv = (on: boolean): void => {
      cv.textContent = on ? t('battle.cv.on') : t('battle.cv.off');
      cv.setAttribute('aria-pressed', String(on));
    };
    paintCv(this.d.isComedyVisual());
    cv.addEventListener('click', () => this.toggleComedyView());
    this.paintComedy = paintCv;
    if (this.opts.online && !this.opts.online.isHost) {
      // Online: only the host changes the comedy look (guests follow the host).
      (cv as HTMLButtonElement).disabled = true;
      cv.title = t('battle.cv.hostOnly');
    }
    const cp = q('#hud-cp');
    cp.textContent = this.d.isComedyPhysics() ? t('battle.cp.on') : t('battle.cp.off');
    cp.setAttribute('aria-pressed', String(this.d.isComedyPhysics()));
    cp.addEventListener('click', () => this.d.toggleComedyPhysics());
    const dbg = q('#hud-debug');
    dbg.textContent = this.d.isDebugOn() ? t('battle.debug.on') : t('battle.debug.off');
    dbg.setAttribute('aria-pressed', String(this.d.isDebugOn()));
    dbg.addEventListener('click', () => this.d.toggleDebug());
    const snd = q('#hud-sound');
    const paintSnd = (on: boolean): void => {
      snd.textContent = on ? t('battle.sound.on') : t('battle.sound.off');
      snd.setAttribute('aria-pressed', String(on));
    };
    paintSnd(this.d.isSoundOn());
    snd.addEventListener('click', () => paintSnd(this.d.toggleSound()));
    q('#hud-restart').addEventListener('click', () => void this.restart());
    q('#hud-edit').addEventListener('click', () => this.opts.onEdit());
    this.renderSpeed();
    this.buildTeamBar();
    this.meterUi?.destroy();
    this.meterUi = null;
    if (!this.opts.bench) {
      this.meterUi = new DpsMeter(
        root,
        { icon: (k, ti) => this.d.icon(k, ti), teamName: (ti) => this.teamName(ti), colors: this.opts.colors.map((c) => hex(c.main)) },
        this.opts.colors.length,
      );
    }
    this.updateHud(true);
  }

  /** The focused team (hover or pinned): its enemies are outlined on the map. */
  private get focusTeam(): number {
    return this.pinnedTeam >= 0 ? this.pinnedTeam : this.hoverTeam;
  }

  /** One shared bar: every team is a segment whose width follows its share of the total remaining health. */
  private buildTeamBar(): void {
    const host = document.getElementById('hud-teams');
    this.tip = document.getElementById('hud-tip');
    this.segs = [];
    this.hoverTeam = this.pinnedTeam = -1;
    if (this.docDown) document.removeEventListener('pointerdown', this.docDown);
    this.docDown = null;
    if (!host || this.opts.bench) return;
    const bar = document.createElement('div');
    bar.className = 'hud-split';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('battle.teams.aria'));
    this.opts.colors.forEach((c, ti) => {
      const seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'hud-seg';
      seg.dataset.team = String(ti);
      seg.style.background = hex(c.main);
      seg.innerHTML = '<span class="hud-seg-n"></span>';
      seg.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'touch') return;
        this.hoverTeam = ti;
        this.showTip(ti);
      });
      seg.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'touch') return;
        if (this.hoverTeam === ti) this.hoverTeam = -1;
        if (this.pinnedTeam < 0) this.hideTip();
        else this.showTip(this.pinnedTeam);
      });
      seg.addEventListener('focus', () => {
        this.hoverTeam = ti;
        this.showTip(ti);
      });
      seg.addEventListener('blur', () => {
        if (this.hoverTeam === ti) this.hoverTeam = -1;
        if (this.pinnedTeam < 0) this.hideTip();
      });
      // Tap (touch) pins the team; tapping the same segment again, or anywhere else, clears it.
      seg.addEventListener('click', () => {
        this.pinnedTeam = this.pinnedTeam === ti ? -1 : ti;
        if (this.pinnedTeam >= 0) this.showTip(ti);
        else if (this.hoverTeam < 0) this.hideTip();
      });
      bar.appendChild(seg);
      this.segs.push(seg);
    });
    host.replaceChildren(bar);
    this.docDown = (e) => {
      if (this.pinnedTeam >= 0 && !(e.target as HTMLElement | null)?.closest('.hud-split')) {
        this.pinnedTeam = -1;
        if (this.hoverTeam < 0) this.hideTip();
      }
    };
    document.addEventListener('pointerdown', this.docDown);
  }

  private teamName(ti: number): string {
    return this.opts.online?.teamNames[ti] || t('battle.team.name', { n: ti + 1 });
  }

  private showTip(ti: number): void {
    const tip = this.tip;
    const seg = this.segs[ti];
    if (!tip || !seg) return;
    const s = this.teamStats[ti];
    tip.innerHTML = `<i class="dot" style="background:${hex(this.opts.colors[ti].main)}"></i><b>${this.teamName(ti).replace(/[&<>]/g, '')}</b><span>${t('battle.team.tip', { alive: s?.alive ?? 0, pct: s?.pct ?? 0, share: s?.share ?? 0 })}</span>`;
    tip.hidden = false;
    const r = seg.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.round(r.bottom + 8)}px`;
  }

  private hideTip(): void {
    if (this.tip) this.tip.hidden = true;
  }

  private teamStats: Array<{ alive: number; pct: number; share: number }> = [];

  private renderSpeed(): void {
    const el = this.d.hudRoot.querySelector('#hud-speed') as HTMLElement | null;
    if (!el) return;
    const locked = !!this.opts.online && !this.opts.online.isHost;
    el.innerHTML = [1, 2, 4].map((v) => `<button type="button" data-v="${v}" aria-pressed="${v === this.speed}"${locked ? ` disabled title="${t('battle.speed.locked')}"` : ''}>${v}×</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.setSpeed(Number((b as HTMLElement).dataset.v))));
    const p = this.d.hudRoot.querySelector('#hud-pause') as HTMLButtonElement | null;
    if (p) {
      p.textContent = this.paused ? t('battle.resume') : t('battle.pause');
      p.disabled = locked;
    }
  }

  private updateHud(force = false): void {
    if (this.opts.bench) return;
    const now = performance.now();
    if (!force && now - this.lastHud < 200) return;
    this.lastHud = now;
    if (this.segs.length > 0) {
      const u = this.sim.units;
      const hp = new Array(6).fill(0);
      for (let i = 0; i < u.count; i++) if (u.alive[i]) hp[u.team[i]] += u.hp[i];
      const total = hp.reduce((a: number, b: number) => a + b, 0);
      this.opts.colors.forEach((_c, ti) => {
        const seg = this.segs[ti];
        const n = this.sim.alivePerTeam[ti];
        const share = total > 0 ? hp[ti] / total : 0;
        const pct = Math.round(Math.min(1, hp[ti] / Math.max(1, this.initialHp[ti])) * 100);
        this.teamStats[ti] = { alive: n, pct, share: Math.round(share * 100) };
        // Every living team keeps a readable minimum; the bar always adds up to 100%.
        seg.style.flexGrow = String(n === 0 ? 0 : Math.max(share, 0.02));
        seg.classList.toggle('out', n === 0);
        seg.classList.toggle('focus', ti === this.focusTeam);
        (seg.firstElementChild as HTMLElement).textContent = n === 0 ? '' : `${this.opts.online ? this.teamName(ti) + ' ' : ''}${n}`;
        seg.setAttribute('aria-label', `${this.teamName(ti)}: ${t('battle.team.tip', this.teamStats[ti])}`);
      });
      if (this.focusTeam >= 0 && !this.tip?.hidden) this.showTip(this.focusTeam);
      this.meterUi?.update(this.sim);
    }
    const w = this.sim.winner;
    const res = document.getElementById('hud-result');
    if (res && w !== -1 && !this.resultShown) {
      this.resultShown = true;
      const color = w >= 0 ? hex(this.opts.colors[w].main) : '#e6edf6';
      res.hidden = false;
      const dur = fmtTime(this.sim.time);
      const on = this.opts.online;
      const title = w >= 0 ? t('battle.result.wins', { name: this.teamName(w) }) : t('battle.result.draw');
      const btns = on
        ? `${on.onRematch ? `<button type="button" id="res-restart" class="primary">${t('battle.result.rematch')}</button>` : `<span class="note">${t('battle.result.hostNote')}</span>`}<button type="button" id="res-edit">${on.isHost ? t('battle.leave.host') : t('battle.leave.guest')}</button>`
        : `<button type="button" id="res-restart">${t('battle.result.replay')}</button><button type="button" id="res-edit" class="primary">${t('battle.edit')}</button>`;
      res.innerHTML = `<div class="res-card" role="dialog" aria-label="${t('battle.result.over', { dur })}"><p class="res-sub">${t('battle.result.over', { dur })}</p><h2 style="color:${color}">${title}</h2>${this.scoreboard(w)}${this.details(w)}<div class="btns"><button type="button" id="res-details" aria-expanded="false">${t('battle.result.details')}</button>${btns}</div></div>`;
      document.getElementById('res-details')!.addEventListener('click', (e) => {
        const box = res.querySelector('.res-detail') as HTMLElement;
        box.hidden = !box.hidden;
        (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!box.hidden));
        (e.currentTarget as HTMLElement).classList.toggle('on', !box.hidden);
      });
      document.getElementById('res-restart')?.addEventListener('click', () => (on ? on.onRematch?.() : void this.restart()));
      document.getElementById('res-edit')!.addEventListener('click', () => (on ? on.onLeave() : this.opts.onEdit()));
      (document.getElementById('res-restart') ?? document.getElementById('res-edit'))?.focus();
    }
  }

  /** Final scoreboard: one row per team (winner first), with survivors, health left, damage, kills and the MVP unit type. */
  private scoreboard(winner: number): string {
    const u = this.sim.units;
    const hp = new Array(6).fill(0);
    for (let i = 0; i < u.count; i++) if (u.alive[i]) hp[u.team[i]] += u.hp[i];
    const rows = this.opts.colors.map((c, ti) => {
      let dmg = 0;
      let best = -1;
      let bestDmg = 0;
      for (let k = 0; k < KIND_COUNT; k++) {
        const v = this.sim.meter.dmg[ti * KIND_COUNT + k];
        dmg += v;
        if (v > bestDmg) {
          bestDmg = v;
          best = k;
        }
      }
      return { ti, color: hex(c.main), alive: this.sim.alivePerTeam[ti], start: this.initialAlive[ti], pct: Math.round(Math.min(1, hp[ti] / Math.max(1, this.initialHp[ti])) * 100), dmg, kills: this.sim.meter.kills[ti], best, bestDmg };
    });
    rows.sort((x, y) => Number(y.ti === winner) - Number(x.ti === winner) || y.alive - x.alive || y.dmg - x.dmg);
    const body = rows
      .map((r) => {
        let thumb = '';
        if (r.best >= 0) {
          try {
            thumb = `<img class="dps-th" alt="" src="${this.d.icon(r.best, r.ti).toDataURL('image/png')}" />`;
          } catch {
            thumb = '';
          }
        }
        const mvp = r.best >= 0 ? `<span class="res-mvp">${thumb}<span>${unitDisplayName(r.best)}<small>${fmtDamage(r.bestDmg)}</small></span></span>` : '–';
        return `<tr class="${r.ti === winner ? 'win' : ''}"><td><span class="res-dot" style="background:${r.color}"></span>${this.teamName(r.ti).replace(/[&<>]/g, '')}${r.ti === winner ? ` <em>${t('battle.result.winner')}</em>` : ''}</td><td>${r.alive} / ${r.start}</td><td>${r.pct}%</td><td>${fmtDamage(r.dmg)}</td><td>${Math.round(r.kills)}</td><td>${mvp}</td></tr>`;
      })
      .join('');
    const th = (k: string): string => `<th>${t(`battle.result.col.${k}`)}</th>`;
    return `<div class="res-scroll"><table class="res-tbl"><thead><tr>${th('team')}${th('alive')}${th('health')}${th('damage')}${th('kills')}${th('mvp')}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  /** Per-team breakdown by unit type (hidden until the Details button is pressed). */
  private details(winner: number): string {
    const u = this.sim.units;
    const alive = new Int32Array(6 * KIND_COUNT);
    for (let i = 0; i < u.count; i++) if (u.alive[i]) alive[u.team[i] * KIND_COUNT + u.kind[i]]++;
    const order = this.opts.colors.map((_, ti) => ti).sort((x, y) => Number(y === winner) - Number(x === winner));
    const cols = order
      .map((ti) => {
        const kinds: number[] = [];
        let sum = 0;
        for (let k = 0; k < KIND_COUNT; k++) {
          const v = this.sim.meter.dmg[ti * KIND_COUNT + k];
          sum += v;
          if (v > 0 || alive[ti * KIND_COUNT + k] > 0) kinds.push(k);
        }
        kinds.sort((a, c) => this.sim.meter.dmg[ti * KIND_COUNT + c] - this.sim.meter.dmg[ti * KIND_COUNT + a]);
        const rows = kinds
          .map((k, i) => {
            const v = this.sim.meter.dmg[ti * KIND_COUNT + k];
            let src = '';
            try {
              src = this.d.icon(k, ti).toDataURL('image/png');
            } catch {
              src = '';
            }
            const a = alive[ti * KIND_COUNT + k];
            return `<li class="${a ? '' : 'dead'}"><span class="dps-rk">${i + 1}</span><img class="dps-th" alt="" src="${src}" /><span class="dps-nm"><b>${unitDisplayName(k)}</b><small>${t('battle.result.left', { n: a })}</small></span><span class="dps-v"><b>${fmtDamage(v)}</b><em>${sum > 0 ? Math.round((v / sum) * 100) : 0}%</em></span></li>`;
          })
          .join('');
        return `<div class="res-col"><h3><span class="res-dot" style="background:${hex(this.opts.colors[ti].main)}"></span>${this.teamName(ti).replace(/[&<>]/g, '')}</h3><ul>${rows}</ul></div>`;
      })
      .join('');
    return `<div class="res-detail" hidden>${cols}</div>`;
  }

  /** Comedy view toggle (button / K). Online it is host-only and the host's choice goes to everybody. */
  private toggleComedyView(): void {
    const on = this.opts.online;
    if (on && !on.isHost) return;
    const next = this.d.toggleComedyVisual();
    this.paintComedy?.(next);
    on?.onComedyView?.(next);
  }

  /** Repaints the comedy view button (the host changed the look). */
  showComedyView(on: boolean): void {
    this.paintComedy?.(on);
  }

  private setSpeed(v: number): void {
    if (this.opts.online && !this.opts.online.isHost) return;
    this.speed = v;
    this.sim.setSpeed(v);
    this.renderSpeed();
  }

  private togglePause(): void {
    if (this.opts.online && !this.opts.online.isHost) return;
    this.paused = !this.paused;
    this.sim.setPaused(this.paused);
    this.renderSpeed();
  }

  private onKey(e: KeyboardEvent): void {
    const tg = e.target as HTMLElement | null;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA')) return;
    // Holding a key must not toggle pause / restart / debug dozens of times a second.
    if (e.repeat) return;
    const bench = this.opts.bench;
    const on = this.opts.online;
    if (on) {
      // Online: no restart/edit/debug; speed and pause are host-only.
      if (e.code === 'F3') {
        e.preventDefault();
        this.d.stats.toggle();
      } else if (e.code === 'KeyK') this.toggleComedyView();
      else if (on.isHost && e.code === 'Space') {
        e.preventDefault();
        this.togglePause();
      } else if (on.isHost && e.code === 'Digit1') this.setSpeed(1);
      else if (on.isHost && e.code === 'Digit2') this.setSpeed(2);
      else if (on.isHost && e.code === 'Digit3') this.setSpeed(4);
      return;
    }
    if (e.code === 'KeyR') void this.restart();
    else if (e.code === 'F3') {
      e.preventDefault();
      this.d.stats.toggle();
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.togglePause();
    } else if (e.code === 'Digit1') this.setSpeed(1);
    else if (e.code === 'Digit2') this.setSpeed(2);
    else if (e.code === 'Digit3') this.setSpeed(4);
    else if (e.code === 'Escape' && !bench) this.opts.onEdit();
    else if (e.code === 'KeyV' && !bench) this.d.toggleDebug();
    else if (e.code === 'KeyK' && !bench) this.toggleComedyView();
    else if (bench && e.code === 'KeyB') this.massOpts.bars = !this.massOpts.bars;
    else if (bench && e.code === 'KeyO') this.massOpts.sort = !this.massOpts.sort;
    else if (bench && e.code === 'KeyC') this.massOpts.cull = !this.massOpts.cull;
    else if (bench && e.code === 'KeyP') this.showReport();
  }

  // ---- loop ----

  async restart(): Promise<void> {
    if (this.resetting) return;
    this.resetting = true;
    const token = this.enterId;
    try {
      this.seed++;
      await this.sim.reset(this.seed);
      if (token !== this.enterId) return; // the battle was left while the worker was resetting
      this.resetBenchStats();
      this.meterUi?.reset();
      this.resultShown = false;
      const res = document.getElementById('hud-result');
      if (res) res.hidden = true;
      if (this.mass) this.mass.rebuild();
      else this.buildViews();
      this.fx?.clear();
      this.comedySys?.clear();
      this.d.banner.style.display = 'none';
    } finally {
      if (token === this.enterId) this.resetting = false;
    }
  }

  frame(now: number, frameMs: number): void {
    // Long pauses (tab/window waiting) do not advance the simulation.
    const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
    this.time += dt;
    if (!this.wallStart) {
      this.wallStart = performance.now();
      this.sim.resetStats();
    }
    if (this.resetting) return;
    const { camera, app, world, stats } = this.d;

    const on = this.opts.online;
    if (on && !on.isHost) {
      const sp = on.getSpeed();
      const pa = on.getPaused();
      if (sp !== this.speed || pa !== this.paused) {
        this.speed = sp;
        this.paused = pa;
        this.renderSpeed();
      }
    }
    camera.update(dt);
    camera.apply(world.root, app.screen.width, app.screen.height);

    const info = this.sim.frame(dt);
    if (this.simTimeBase < 0) this.simTimeBase = this.sim.time;

    const t1 = performance.now();
    if (this.comedySys) {
      if (comedy.visual) {
        // Comedy view: deaths fly as ragdolls; synthetic events (landing, whoosh) are added to sound/effects.
        const u = this.sim.units;
        const evs = this.sim.events;
        for (const ev of evs) {
          if (ev.type === 'death' && ev.unit >= 0) this.comedySys.spawnDeath(ev.x, ev.y, ev.angle ?? 0, ev.value ?? 10, ev.kind ?? 0, u.team[ev.unit], u.facing[ev.unit], u.count);
        }
        this.comedySys.update(this.paused ? 0 : dt);
        for (const e of this.comedySys.events) evs.push(e);
        this.comedySys.events.length = 0;
      } else if (this.comedySys.active > 0) this.comedySys.clear();
    }
    if (!this.opts.bench) this.d.audio.handle(this.sim.events, camera, app.screen.width, app.screen.height);
    if (this.fx) {
      this.fx.handle(this.sim.events, this.viewRect());
      this.fx.update(this.paused ? 0 : dt);
    }
    this.sim.events.length = 0;
    if (this.mass) this.syncMass(info.alpha);
    else this.syncViews(dt, info.alpha);
    this.debug?.update(info.alpha);
    app.render();
    const t2 = performance.now();

    if (frameMs > 500) {
      this.stallMs += frameMs;
      this.stallCount++;
    } else {
      if (this.frameCount < this.frameLog.length) this.frameLog[this.frameCount] = frameMs;
      this.frameCount++;
    }
    this.mainSimTotalMs += info.mainSimMs;
    this.renderTotalMs += t2 - t1;
    if (this.opts.bench && this.opts.autoSeconds > 0 && !this.reported && this.wallSeconds() >= this.opts.autoSeconds) this.showReport();

    stats.push(frameMs, info.mainSimMs, t2 - t1);
    const st = this.sim.stats();
    const wall = this.wallSeconds();
    const stepMs = st.totalMs / Math.max(1, st.steps);
    const extra: string[] = [
      `${t('battle.stats.simThread')} ${this.sim.kind === 'worker' ? t('battle.stats.worker') : t('battle.stats.mainThread')}`,
      `${t('battle.stats.simPerStep').padEnd(11)}${stepMs.toFixed(2)} ms (max ${st.maxMs.toFixed(1)})  ${t('battle.stats.load', { pct: ((stepMs / (SIM_DT * 1000)) * 100).toFixed(0) })}`,
      `${t('battle.stats.timeX').padEnd(11)}${((this.sim.time - this.simTimeBase) / Math.max(0.001, wall)).toFixed(2)} ${t('battle.stats.realtime')}`,
    ];
    if (this.opts.bench) {
      extra.push(
        this.drawnLine,
        t('battle.bench.toggles', { bars: onOff(this.massOpts.bars), sort: onOff(this.massOpts.sort), cull: onOff(this.massOpts.cull) }),
      );
    }
    stats.update(now, {
      blue: this.sim.alivePerTeam[0],
      red: this.sim.alivePerTeam[1],
      projectiles: this.activeProjectiles,
      simSteps: info.steps,
      speed: this.speed,
      paused: this.paused,
      extra,
    });
    this.updateHud();
  }

  /** Visible world rectangle (iso pixels). */
  private viewRect(): MassViewport {
    const { camera, app } = this.d;
    const w = app.screen.width / camera.zoom;
    const h = app.screen.height / camera.zoom;
    return { left: camera.x - w / 2 - 60, right: camera.x + w / 2 + 60, top: camera.y - h / 2 - 100, bottom: camera.y + h / 2 + 40, zoom: camera.zoom };
  }

  private wallSeconds(): number {
    return (performance.now() - this.wallStart - this.stallMs) / 1000;
  }

  // ---- mass drawing ----

  private syncMass(alpha: number): void {
    const ft = this.focusTeam;
    this.massOpts.focusTeam = ft;
    this.massOpts.focusColor = ft >= 0 ? this.opts.colors[ft].main : 0xffffff;
    this.mass!.sync(this.time, alpha, this.viewRect(), this.massOpts);
    this.activeProjectiles = this.mass!.drawnArrows;
    this.drawnLine = `${t('battle.stats.drawn').padEnd(11)}${t('battle.stats.drawnLine', { units: this.mass!.drawnUnits, decor: this.mass!.drawnDecor, arrows: this.mass!.drawnArrows })}`;
  }

  // ---- detailed drawing ----

  private buildViews(): void {
    for (const v of this.views) v.root.destroy({ children: true });
    this.views = [];
    const u = this.sim.units;
    for (let i = 0; i < u.count; i++) {
      const v = new UnitView(u.kind[i], this.opts.colors[u.team[i]] ?? this.opts.colors[0], i);
      this.d.world.entityLayer.addChild(v.root);
      this.views.push(v);
    }
  }

  private arrowView(i: number): { shadow: Graphics; arrow: Graphics; tag: number } {
    let v = this.arrowViews[i];
    if (!v) {
      const shadow = new Graphics();
      shadow.ellipse(0, 0, 4, 2).fill({ color: 0x000000, alpha: 0.25 });
      const arrow = new Graphics();
      drawProjectile(arrow, 0);
      this.d.world.shadowLayer.addChild(shadow);
      this.d.world.fxLayer.addChild(arrow);
      v = { shadow, arrow, tag: 0 };
      this.arrowViews[i] = v;
    }
    return v;
  }

  private syncViews(dt: number, alpha: number): void {
    const u = this.sim.units;
    const vdt = this.paused ? 0 : dt;

    for (let i = 0; i < u.count; i++) {
      const v = this.views[i];
      if (!v) continue;
      const alive = u.alive[i] === 1;
      if (!alive && (comedy.visual || u.deathT[i] > DEATH_FADE)) {
        v.root.visible = false;
        continue;
      }
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      v.root.visible = true;
      const ft = this.focusTeam;
      v.setOutline(alive && ft >= 0 && u.team[i] !== ft ? this.opts.colors[ft].main : -1);
      const ground = this.elev(wx, wy);
      v.root.position.set(isoX(wx, wy), isoY(wx, wy, ground + (u.lift ? u.lift[i] * 38 : 0)));
      // Height advantage over its current target (half steps): gold chevrons, one per step of advantage (max 3).
      const adv = u.hgAdv[i];
      v.setHighGround(alive ? (adv >= 6 ? 3 : adv >= 4 ? 2 : adv >= 2 ? 1 : 0) : 0);
      v.root.zIndex = wx + wy;
      const swingTotal = u.swing[i] > 0 ? STATS[u.kind[i]].swing : 0;
      v.update(
        {
          hp: u.hp[i],
          maxHp: u.maxHp[i],
          facing: u.facing[i],
          moving: u.moving[i] === 1,
          swingProgress: swingTotal > 0 ? 1 - u.swing[i] / swingTotal : -1,
          flash: u.flash[i] > 0,
          status: u.status[i],
          lift: u.lift ? u.lift[i] : 0,
          deathT: alive ? -1 : u.deathT[i],
        },
        this.time,
        vdt,
      );
    }

    const p = this.sim.projectiles;
    const advance = alpha * SIM_DT;
    this.activeProjectiles = 0;
    for (let i = 0; i < p.count; i++) {
      const v = this.arrowView(i);
      if (!p.active[i]) {
        v.arrow.visible = v.shadow.visible = false;
        continue;
      }
      this.activeProjectiles++;
      const k = Math.min(1, (p.t[i] + advance) / p.dur[i]);
      const pos = arcPoint(p, i, k, this.elev);
      const next = arcPoint(p, i, Math.min(1, k + 0.03), this.elev);
      v.arrow.visible = v.shadow.visible = true;
      if (v.tag !== p.tag[i]) {
        v.tag = p.tag[i];
        drawProjectile(v.arrow, v.tag);
      }
      v.arrow.position.set(pos.sx, pos.sy);
      v.arrow.rotation = projStyle(v.tag).orb ? 0 : Math.atan2(next.sy - pos.sy, next.sx - pos.sx);
      v.shadow.position.set(pos.gx, pos.gy);
      v.shadow.scale.set(1 - pos.z / 120);
    }
    for (let i = p.count; i < this.arrowViews.length; i++) {
      const v = this.arrowViews[i];
      if (v) v.arrow.visible = v.shadow.visible = false;
    }

  }

  // ---- benchmark measurement ----

  private resetBenchStats(): void {
    this.frameCount = 0;
    this.wallStart = 0;
    this.mainSimTotalMs = this.renderTotalMs = this.stallMs = this.stallCount = 0;
    this.simTimeBase = -1;
    this.reported = false;
  }

  private pct(sorted: Float32Array, p: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  private summary() {
    const n = Math.min(this.frameCount, this.frameLog.length) - WARMUP_FRAMES;
    if (n < 10) return null;
    const arr = this.frameLog.slice(WARMUP_FRAMES, WARMUP_FRAMES + n).sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    const avg = sum / n;
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const wall = this.wallSeconds();
    const st = this.sim.stats();
    const simSteps = Math.max(1, st.steps);
    const terrain = this.d.world.terrain ?? terrainFor(this.opts.config);
    return {
      backend: this.sim.kind,
      perTeam: this.opts.config.perTeam,
      mapSize: this.sim.mapSize,
      seconds: Number(wall.toFixed(1)),
      stalls: this.stallCount,
      frames: n,
      avgFps: Number((1000 / avg).toFixed(1)),
      avgFrameMs: Number(avg.toFixed(2)),
      p95FrameMs: Number(this.pct(arr, 0.95).toFixed(2)),
      p99FrameMs: Number(this.pct(arr, 0.99).toFixed(2)),
      worstFrameMs: Number(arr[n - 1].toFixed(2)),
      onePercentLowFps: Number((1000 / this.pct(arr, 0.99)).toFixed(1)),
      mainThreadSimMsPerFrame: Number((this.mainSimTotalMs / Math.max(1, this.frameCount)).toFixed(2)),
      simMsPerStep: Number((st.totalMs / simSteps).toFixed(2)),
      simMaxStepMs: Number(st.maxMs.toFixed(2)),
      behavior: st.dbg,
      decor: terrain ? terrain.decor.length : 0,
      simPhasesMsPerStep: Object.fromEntries(
        Object.entries(st.prof)
          .filter(([k]) => k !== 'steps')
          .map(([k, v]) => [k, Number((v / Math.max(1, st.prof.steps)).toFixed(2))]),
      ),
      renderMsPerFrame: Number((this.renderTotalMs / Math.max(1, this.frameCount)).toFixed(2)),
      realtimeFactor: Number(((this.sim.time - this.simTimeBase) / Math.max(0.001, wall)).toFixed(2)),
      aliveBlue: this.sim.alivePerTeam[0],
      aliveRed: this.sim.alivePerTeam[1],
      heapMB: heap ? Number((heap.usedJSHeapSize / 1048576).toFixed(1)) : null,
    };
  }

  private showReport(): void {
    const r = this.summary();
    if (!r) return;
    this.reported = true;
    (window as unknown as { __benchResult: unknown }).__benchResult = r;
    console.log('BENCH RESULT', JSON.stringify(r));
    const b = this.d.banner;
    b.style.display = 'flex';
    b.innerHTML = `<div style="background:rgba(10,14,20,.85);padding:16px 22px;border-radius:10px;font:14px/1.6 ui-monospace,Consolas,monospace;text-align:left;white-space:pre">${
      t('battle.bench.title', { n: r.perTeam, backend: r.backend, size: r.mapSize, sec: r.seconds }) + '\n' +
      t('battle.bench.fps', { avg: r.avgFps, low: r.onePercentLowFps }) + '\n' +
      t('battle.bench.frame', { avg: r.avgFrameMs, p95: r.p95FrameMs, p99: r.p99FrameMs, worst: r.worstFrameMs }) + '\n' +
      t('battle.bench.sim', { step: r.simMsPerStep, max: r.simMaxStepMs, main: r.mainThreadSimMsPerFrame }) + '\n' +
      t('battle.bench.render', { ms: r.renderMsPerFrame }) + '\n' +
      t('battle.bench.realtime', { factor: r.realtimeFactor, blue: r.aliveBlue, red: r.aliveRed }) + '\n' +
      t('battle.bench.restart')
    }</div>`;
  }
}

const onOff = (v: boolean): string => t(v ? 'battle.bench.on' : 'battle.bench.off');

function arcPoint(p: SimBackend['projectiles'], i: number, k: number, elev: (x: number, y: number) => number) {
  const wx = p.sx[i] + (p.tx[i] - p.sx[i]) * k;
  const wy = p.sy[i] + (p.ty[i] - p.sy[i]) * k;
  const e = elev(wx, wy);
  const z = 4 * p.height[i] * k * (1 - k);
  return { sx: isoX(wx, wy), sy: isoY(wx, wy, e + z), gx: isoX(wx, wy), gy: isoY(wx, wy, e), z };
}
