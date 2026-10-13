import { drawProjectile, projStyle } from '../render/projectileStyle';
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
import { STATS } from '../sim/units';
import { WorkerSim } from '../sim/workerSim';
import type { StatsPanel } from '../ui/stats';
import { hex } from './state';
import type { WorldView } from './world';

const WARMUP_FRAMES = 60;
/** Bu sayidan az birimde ayrintili (animasyonlu) cizim, fazlasinda toplu cizim. */
const DETAILED_MAX = 150;

export interface BattleOptions {
  config: BattleConfig;
  colors: TeamColors[];
  speed: number;
  /** Benchmark: HUD yok, otomatik rapor. */
  bench: boolean;
  autoSeconds: number;
  useWorker: boolean;
  seed: number;
  /** Efekt kalitesi ('auto': birim sayisina gore) ve yuzen hasar sayilari. */
  fx: 'auto' | FxQuality;
  numbers: boolean;
  /** ?debug=1: takilma izleme katmani (sim ana thread'de calisir). */
  debug?: boolean;
  /** Savastan stüdyoya don. */
  onEdit: () => void;
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
  /** Sesi ac/kapat (kalici); yeni durumu dondurur. */
  toggleSound: () => boolean;
  isSoundOn: () => boolean;
  /** Hata ayiklama katmanini ac/kapat (savasi ayni dizilimle yeniden baslatir). */
  isDebugOn: () => boolean;
  toggleDebug: () => void;
  /** Komedi gorunumu (canli) ve komedi fizigi (savasi yeniden baslatir). */
  isComedyVisual: () => boolean;
  toggleComedyVisual: () => boolean;
  isComedyPhysics: () => boolean;
  toggleComedyPhysics: () => void;
}

/** Savas sahnesi: sim (worker) + cizim (ayrintili veya toplu) + HUD + benchmark olcumu. */
export class BattleScene {
  private sim!: SimBackend;
  private opts!: BattleOptions;
  private mass: MassRenderer | null = null;
  private views: UnitView[] = [];
  private arrowViews: Array<{ shadow: Graphics; arrow: Graphics; tag: number }> = [];
  private fx: FxSystem | null = null;
  private massOpts: MassOptions = { bars: true, sort: true, cull: true };
  private speed = 1;
  private paused = false;
  private resetting = false;
  private seed = 1;
  private time = 0;
  private activeProjectiles = 0;
  /** Arazi yuksekligi (ekran pikseli); kabartma yoksa 0. */
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

  // olcum
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

  async enter(opts: BattleOptions): Promise<void> {
    this.opts = opts;
    this.speed = opts.speed;
    this.seed = opts.seed;
    this.paused = false;
    this.resultShown = false;
    this.resetBenchStats();

    const cfg = opts.config;
    this.sim = opts.useWorker ? await WorkerSim.create(cfg, this.seed) : new InlineSim(cfg, this.seed);
    this.sim.setSpeed(this.speed);

    const unitCount = this.sim.units.count;
    this.initialAlive = new Array(6).fill(0);
    this.initialHp = new Array(6).fill(0);
    // Cagrilacak (uyuyan) iskeletler baslangic sayimina girmez: yalniz canli birimler.
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

    if (detailed) {
      this.buildViews();
    } else {
      this.mass = new MassRenderer(app, this.sim, atlas, world.terrain);
      if (opts.bench && !reliefMap) world.staticLayer.addChildAt(this.mass.buildGround(), 0);
      world.entityLayer.addChild(this.mass.layer);
    }

    if (!opts.bench) {
      const quality: FxQuality = opts.fx === 'auto' ? (unitCount <= 400 ? 'high' : 'low') : opts.fx;
      // Kalabalikta yuzen sayilar okunmaz: yalniz az birimde goster.
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
    // Sekme gizlenince sim durur (savas kacirilmaz), ses susar.
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
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    if (this.visHandler) document.removeEventListener('visibilitychange', this.visHandler);
    this.visHandler = null;
    this.sim.dispose();
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
      this.mass.layer.destroy({ children: true });
      this.mass = null;
    }
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
<div class="hud-bottom">
  <div class="seg" id="hud-speed" role="group" aria-label="Hız"></div>
  <button type="button" id="hud-pause">Duraklat</button>
  <button type="button" id="hud-sound" aria-pressed="true">Ses</button>
  <button type="button" id="hud-cv" aria-pressed="false" title="Komedi görünümü (K)">Komedi görünümü</button>
  <button type="button" id="hud-cp" aria-pressed="false" title="Komedi fiziği (savaş yeniden başlar)">Komedi fiziği</button>
  <button type="button" id="hud-debug" aria-pressed="false" title="Takılma izleme katmanı (savaş yeniden başlar)">Debug</button>
  <button type="button" id="hud-full">Tam ekran</button>
  <button type="button" id="hud-restart">Yeniden başlat</button>
  <button type="button" id="hud-edit" class="primary">Düzenle</button>
</div>
<div class="hud-hint">Space: duraklat · R: yeniden başlat · Esc: düzenle · 1-2-3: hız · F3: istatistik · WASD / orta tuş: kaydır · tekerlek: yakınlaş</div>
<div class="result" id="hud-result" hidden></div>`;
    const q = (s: string) => root.querySelector(s) as HTMLElement;
    q('#hud-pause').addEventListener('click', () => this.togglePause());
    const cv = q('#hud-cv');
    const paintCv = (on: boolean): void => {
      cv.textContent = on ? 'Komedi görünümü: açık' : 'Komedi görünümü: kapalı';
      cv.setAttribute('aria-pressed', String(on));
    };
    paintCv(this.d.isComedyVisual());
    cv.addEventListener('click', () => paintCv(this.d.toggleComedyVisual()));
    this.paintComedy = paintCv;
    const cp = q('#hud-cp');
    cp.textContent = this.d.isComedyPhysics() ? 'Komedi fiziği: açık' : 'Komedi fiziği: kapalı';
    cp.setAttribute('aria-pressed', String(this.d.isComedyPhysics()));
    cp.addEventListener('click', () => this.d.toggleComedyPhysics());
    const dbg = q('#hud-debug');
    dbg.textContent = this.d.isDebugOn() ? 'Debug: açık' : 'Debug: kapalı';
    dbg.setAttribute('aria-pressed', String(this.d.isDebugOn()));
    dbg.addEventListener('click', () => this.d.toggleDebug());
    q('#hud-full').addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.();
    });
    const snd = q('#hud-sound');
    const paintSnd = (on: boolean): void => {
      snd.textContent = on ? 'Ses: açık' : 'Ses: kapalı';
      snd.setAttribute('aria-pressed', String(on));
    };
    paintSnd(this.d.isSoundOn());
    snd.addEventListener('click', () => paintSnd(this.d.toggleSound()));
    q('#hud-restart').addEventListener('click', () => void this.restart());
    q('#hud-edit').addEventListener('click', () => this.opts.onEdit());
    this.renderSpeed();
    this.updateHud(true);
  }

  private renderSpeed(): void {
    const el = this.d.hudRoot.querySelector('#hud-speed') as HTMLElement | null;
    if (!el) return;
    el.innerHTML = [1, 2, 4].map((v) => `<button type="button" data-v="${v}" aria-pressed="${v === this.speed}">${v}×</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.setSpeed(Number((b as HTMLElement).dataset.v))));
    const p = this.d.hudRoot.querySelector('#hud-pause');
    if (p) p.textContent = this.paused ? 'Devam' : 'Duraklat';
  }

  private updateHud(force = false): void {
    if (this.opts.bench) return;
    const now = performance.now();
    if (!force && now - this.lastHud < 200) return;
    this.lastHud = now;
    const teams = document.getElementById('hud-teams');
    if (teams) {
      const u = this.sim.units;
      const hp = new Array(6).fill(0);
      for (let i = 0; i < u.count; i++) if (u.alive[i]) hp[u.team[i]] += u.hp[i];
      teams.innerHTML = this.opts.colors
        .map((c, t) => {
          const n = this.sim.alivePerTeam[t];
          const pct = Math.round(Math.min(1, hp[t] / Math.max(1, this.initialHp[t])) * 100);
          return `<span class="hud-team${n === 0 ? ' out' : ''}" style="background:${hex(c.main)}22;color:${hex(c.main)}" title="Takım ${t + 1}: ${n} asker, güç %${pct}"><i class="dot" style="background:${hex(c.main)}"></i>${n}<span class="hud-bar"><i style="width:${pct}%;background:${hex(c.main)}"></i></span></span>`;
        })
        .join('');
    }
    const w = this.sim.winner;
    const res = document.getElementById('hud-result');
    if (res && w !== -1 && !this.resultShown) {
      this.resultShown = true;
      const color = w >= 0 ? hex(this.opts.colors[w].main) : '#e6edf6';
      res.hidden = false;
      const secs = Math.round(this.sim.time);
      const dur = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const losses = this.opts.colors
        .map((cc, t) => `<span style="color:${hex(cc.main)}">T${t + 1}: ${this.initialAlive[t] - this.sim.alivePerTeam[t]}/${this.initialAlive[t]}</span>`)
        .join(' · ');
      res.innerHTML = `<div><h2 style="color:${color}">${w >= 0 ? `Takım ${w + 1} kazandı` : 'Berabere'}</h2><p>Süre ${dur} · Kayıp ${losses}</p><div class="btns"><button type="button" id="res-restart">Yeniden oyna</button><button type="button" id="res-edit" class="primary">Düzenle</button></div></div>`;
      document.getElementById('res-restart')!.addEventListener('click', () => void this.restart());
      document.getElementById('res-edit')!.addEventListener('click', () => this.opts.onEdit());
    }
  }

  private setSpeed(v: number): void {
    this.speed = v;
    this.sim.setSpeed(v);
    this.renderSpeed();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.sim.setPaused(this.paused);
    this.renderSpeed();
  }

  private onKey(e: KeyboardEvent): void {
    const bench = this.opts.bench;
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
    else if (e.code === 'KeyK' && !bench) this.paintComedy?.(this.d.toggleComedyVisual());
    else if (bench && e.code === 'KeyB') this.massOpts.bars = !this.massOpts.bars;
    else if (bench && e.code === 'KeyO') this.massOpts.sort = !this.massOpts.sort;
    else if (bench && e.code === 'KeyC') this.massOpts.cull = !this.massOpts.cull;
    else if (bench && e.code === 'KeyP') this.showReport();
  }

  // ---- dongu ----

  async restart(): Promise<void> {
    if (this.resetting) return;
    this.resetting = true;
    this.seed++;
    await this.sim.reset(this.seed);
    this.resetBenchStats();
    this.resultShown = false;
    const res = document.getElementById('hud-result');
    if (res) res.hidden = true;
    if (this.mass) this.mass.rebuild();
    else this.buildViews();
    this.fx?.clear();
    this.comedySys?.clear();
    this.d.banner.style.display = 'none';
    this.resetting = false;
  }

  frame(now: number, frameMs: number): void {
    // Uzun duraklar (sekme/pencere beklemesi) simulasyonu ilerletmez.
    const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
    this.time += dt;
    if (!this.wallStart) {
      this.wallStart = performance.now();
      this.sim.resetStats();
    }
    if (this.resetting) return;
    const { camera, app, world, stats } = this.d;

    camera.update(dt);
    camera.apply(world.root, app.screen.width, app.screen.height);

    const info = this.sim.frame(dt);
    if (this.simTimeBase < 0) this.simTimeBase = this.sim.time;

    const t1 = performance.now();
    if (this.comedySys) {
      if (comedy.visual) {
        // Komedi gorunumu: olumler ragdoll olarak ucar; sentetik olaylar (inis, whoosh) ses/efekte eklenir.
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
      `Sim thread ${this.sim.kind === 'worker' ? 'worker' : 'ana thread'}`,
      `Sim/adim   ${stepMs.toFixed(2)} ms (max ${st.maxMs.toFixed(1)})  yuk %${((stepMs / (SIM_DT * 1000)) * 100).toFixed(0)}`,
      `Zaman x    ${((this.sim.time - this.simTimeBase) / Math.max(0.001, wall)).toFixed(2)} (1.00 = gercek zaman)`,
    ];
    if (this.opts.bench) {
      extra.push(
        this.drawnLine,
        `[B]ar ${this.massOpts.bars ? 'ac' : 'kapali'}  [O]sira ${this.massOpts.sort ? 'ac' : 'kapali'}  [C]ull ${this.massOpts.cull ? 'ac' : 'kapali'}`,
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

  /** Gorunur dunya dikdortgeni (iso piksel). */
  private viewRect(): MassViewport {
    const { camera, app } = this.d;
    const w = app.screen.width / camera.zoom;
    const h = app.screen.height / camera.zoom;
    return { left: camera.x - w / 2 - 60, right: camera.x + w / 2 + 60, top: camera.y - h / 2 - 100, bottom: camera.y + h / 2 + 40, zoom: camera.zoom };
  }

  private wallSeconds(): number {
    return (performance.now() - this.wallStart - this.stallMs) / 1000;
  }

  // ---- toplu cizim ----

  private syncMass(alpha: number): void {
    this.mass!.sync(this.time, alpha, this.viewRect(), this.massOpts);
    this.activeProjectiles = this.mass!.drawnArrows;
    this.drawnLine = `Cizilen    ${this.mass!.drawnUnits} birim, ${this.mass!.drawnDecor} dekor, ${this.mass!.drawnArrows} ok`;
  }

  // ---- ayrintili cizim ----

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
      v.root.position.set(isoX(wx, wy), isoY(wx, wy, this.elev(wx, wy) + (u.lift ? u.lift[i] * 38 : 0)));
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

  // ---- benchmark olcumu ----

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
      `BENCH ${r.perTeam} vs ${r.perTeam}  [${r.backend}]  (harita ${r.mapSize}x${r.mapSize}, ${r.seconds} sn)\n` +
      `FPS ort ${r.avgFps}   1% low ${r.onePercentLowFps}\n` +
      `Kare ort ${r.avgFrameMs} ms   p95 ${r.p95FrameMs}   p99 ${r.p99FrameMs}   en kotu ${r.worstFrameMs}\n` +
      `Sim ${r.simMsPerStep} ms/adim (max ${r.simMaxStepMs})   ana thread sim ${r.mainThreadSimMsPerFrame} ms/kare\n` +
      `Render ${r.renderMsPerFrame} ms/kare (CPU)\n` +
      `Gercek zaman carpani x${r.realtimeFactor}   Canli: ${r.aliveBlue} / ${r.aliveRed}\n` +
      `R: yeniden baslat`
    }</div>`;
  }
}

function arcPoint(p: SimBackend['projectiles'], i: number, k: number, elev: (x: number, y: number) => number) {
  const wx = p.sx[i] + (p.tx[i] - p.sx[i]) * k;
  const wy = p.sy[i] + (p.ty[i] - p.sy[i]) * k;
  const e = elev(wx, wy);
  const z = 4 * p.height[i] * k * (1 - k);
  return { sx: isoX(wx, wy), sy: isoY(wx, wy, e + z), gx: isoX(wx, wy), gy: isoY(wx, wy, e), z };
}
