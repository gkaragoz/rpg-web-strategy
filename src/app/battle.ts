import { Graphics, type Application } from 'pixi.js';
import type { Camera } from '../camera';
import { isoX, isoY } from '../iso';
import type { Atlas } from '../render/atlas';
import { MassRenderer, type MassOptions } from '../render/massRenderer';
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
const HEAL_FX_LIFE = 0.8;
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
  /** Savastan stüdyoya don. */
  onEdit: () => void;
}

interface Fx {
  g: Graphics;
  t: number;
  life: number;
  kind: 'heal' | 'ring' | 'arc';
  x: number;
  y: number;
}

export interface BattleDeps {
  app: Application;
  world: WorldView;
  camera: Camera;
  getAtlas: () => Atlas;
  stats: StatsPanel;
  hudRoot: HTMLElement;
  banner: HTMLElement;
}

/** Savas sahnesi: sim (worker) + cizim (ayrintili veya toplu) + HUD + benchmark olcumu. */
export class BattleScene {
  private sim!: SimBackend;
  private opts!: BattleOptions;
  private mass: MassRenderer | null = null;
  private views: UnitView[] = [];
  private arrowViews: Array<{ shadow: Graphics; arrow: Graphics }> = [];
  private fx: Fx[] = [];
  private massOpts: MassOptions = { bars: true, sort: true, cull: true };
  private speed = 1;
  private paused = false;
  private resetting = false;
  private seed = 1;
  private time = 0;
  private activeProjectiles = 0;
  private drawnLine = '';
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private lastHud = 0;
  private resultShown = false;

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
    const detailed = !opts.bench && unitCount <= DETAILED_MAX;
    const atlas = this.d.getAtlas();
    const { world, camera, app } = this.d;
    world.rebuild(cfg, atlas, detailed, !opts.bench);
    camera.setMap(world.mapSize);
    camera.fit(app.screen.width, app.screen.height);
    camera.enabled = !(opts.bench && opts.autoSeconds > 0);

    if (detailed) {
      this.buildViews();
    } else {
      this.mass = new MassRenderer(app, this.sim, atlas, world.terrain);
      if (opts.bench) world.staticLayer.addChildAt(this.mass.buildGround(), 0);
      world.entityLayer.addChild(this.mass.layer);
    }

    this.buildHud();
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    (window as unknown as { __sim: SimBackend }).__sim = this.sim;
  }

  exit(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    this.sim.dispose();
    for (const v of this.views) v.root.destroy({ children: true });
    this.views = [];
    for (const a of this.arrowViews) {
      a.arrow.destroy();
      a.shadow.destroy();
    }
    this.arrowViews = [];
    for (const f of this.fx) f.g.destroy();
    this.fx = [];
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
  <button type="button" id="hud-restart">Yeniden başlat</button>
  <button type="button" id="hud-edit" class="primary">Düzenle</button>
</div>
<div class="hud-hint">Space: duraklat · R: yeniden başlat · Esc: düzenle · 1-2-3: hız · F3: istatistik · WASD / orta tuş: kaydır · tekerlek: yakınlaş</div>
<div class="result" id="hud-result" hidden></div>`;
    const q = (s: string) => root.querySelector(s) as HTMLElement;
    q('#hud-pause').addEventListener('click', () => this.togglePause());
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
      teams.innerHTML = this.opts.colors
        .map((c, t) => {
          const n = this.sim.alivePerTeam[t];
          return `<span class="hud-team${n === 0 ? ' out' : ''}" style="background:${hex(c.main)}22;color:${hex(c.main)}"><i class="dot" style="background:${hex(c.main)}"></i>${n}</span>`;
        })
        .join('');
    }
    const w = this.sim.winner;
    const res = document.getElementById('hud-result');
    if (res && w !== -1 && !this.resultShown) {
      this.resultShown = true;
      const color = w >= 0 ? hex(this.opts.colors[w].main) : '#e6edf6';
      res.hidden = false;
      res.innerHTML = `<div><h2 style="color:${color}">${w >= 0 ? `Takım ${w + 1} kazandı` : 'Berabere'}</h2><p>Savaş bitti.</p><div class="btns"><button type="button" id="res-restart">Yeniden oyna</button><button type="button" id="res-edit" class="primary">Düzenle</button></div></div>`;
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
    for (const f of this.fx) f.g.destroy();
    this.fx = [];
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
    if (this.mass) this.syncMass(info.alpha);
    else this.syncViews(dt, info.alpha);
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

  private wallSeconds(): number {
    return (performance.now() - this.wallStart - this.stallMs) / 1000;
  }

  // ---- toplu cizim ----

  private syncMass(alpha: number): void {
    const { camera, app } = this.d;
    const w = app.screen.width / camera.zoom;
    const h = app.screen.height / camera.zoom;
    this.mass!.sync(
      this.time,
      alpha,
      { left: camera.x - w / 2 - 60, right: camera.x + w / 2 + 60, top: camera.y - h / 2 - 100, bottom: camera.y + h / 2 + 40 },
      this.massOpts,
    );
    this.sim.events.length = 0;
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

  private arrowView(i: number): { shadow: Graphics; arrow: Graphics } {
    let v = this.arrowViews[i];
    if (!v) {
      const shadow = new Graphics();
      shadow.ellipse(0, 0, 4, 2).fill({ color: 0x000000, alpha: 0.25 });
      const arrow = new Graphics();
      arrow.moveTo(-9, 0).lineTo(7, 0).stroke({ width: 2, color: 0x6b4a2b });
      arrow.poly([7, -3, 12, 0, 7, 3]).fill(0xcfd4dc);
      arrow.poly([-9, 0, -12, -3, -6, 0, -12, 3]).fill(0xf2f2f2);
      this.d.world.shadowLayer.addChild(shadow);
      this.d.world.fxLayer.addChild(arrow);
      v = { shadow, arrow };
      this.arrowViews[i] = v;
    }
    return v;
  }

  private spawnFx(kind: Fx['kind'], x: number, y: number, angle = 0): void {
    const g = new Graphics();
    if (kind === 'heal') {
      g.roundRect(-2, -7, 4, 14, 1).fill(0x5be07a);
      g.roundRect(-7, -2, 14, 4, 1).fill(0x5be07a);
    } else if (kind === 'ring') {
      g.ellipse(0, 0, 45, 22.5).stroke({ width: 4, color: 0xffe9a8, alpha: 0.9 });
    } else {
      // koni dalgasi: ileriye dogru genisleyen yay
      g.moveTo(0, 0).arc(0, 0, 70, -0.9, 0.9).closePath().fill({ color: 0xffffff, alpha: 0.35 }).stroke({ width: 2, color: 0xffffff, alpha: 0.8 });
      g.rotation = angle;
    }
    g.position.set(isoX(x, y), isoY(x, y) - (kind === 'heal' ? 50 : 6));
    this.d.world.fxLayer.addChild(g);
    this.fx.push({ g, t: 0, life: kind === 'heal' ? HEAL_FX_LIFE : 0.45, kind, x, y });
  }

  private syncViews(dt: number, alpha: number): void {
    const u = this.sim.units;
    const vdt = this.paused ? 0 : dt;

    for (const ev of this.sim.events) {
      if (ev.type === 'heal') this.spawnFx('heal', ev.x, ev.y);
      else if (ev.type === 'slam') this.spawnFx('ring', ev.x, ev.y);
      else if (ev.type === 'bash') {
        // Dunya acisini ekrana cevir: (cos, sin) -> iso yonu.
        const dx = Math.cos(ev.angle ?? 0);
        const dy = Math.sin(ev.angle ?? 0);
        this.spawnFx('arc', ev.x, ev.y, Math.atan2((dx + dy) * 16, (dx - dy) * 32));
      }
    }
    this.sim.events.length = 0;

    for (let i = 0; i < u.count; i++) {
      const v = this.views[i];
      if (!v) continue;
      const alive = u.alive[i] === 1;
      if (!alive && u.deathT[i] > DEATH_FADE) {
        v.root.visible = false;
        continue;
      }
      const wx = u.px[i] + (u.x[i] - u.px[i]) * alpha;
      const wy = u.py[i] + (u.y[i] - u.py[i]) * alpha;
      v.root.visible = true;
      v.root.position.set(isoX(wx, wy), isoY(wx, wy));
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
      const pos = arcPoint(p, i, k);
      const next = arcPoint(p, i, Math.min(1, k + 0.03));
      v.arrow.visible = v.shadow.visible = true;
      v.arrow.position.set(pos.sx, pos.sy);
      v.arrow.rotation = Math.atan2(next.sy - pos.sy, next.sx - pos.sx);
      v.shadow.position.set(pos.gx, pos.gy);
      v.shadow.scale.set(1 - pos.z / 120);
    }
    for (let i = p.count; i < this.arrowViews.length; i++) {
      const v = this.arrowViews[i];
      if (v) v.arrow.visible = v.shadow.visible = false;
    }

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      const k = f.t / f.life;
      if (k >= 1) {
        f.g.destroy();
        this.fx.splice(i, 1);
        continue;
      }
      if (f.kind === 'heal') f.g.position.y = isoY(f.x, f.y) - 50 - k * 28;
      else f.g.scale.set(0.4 + k * (f.kind === 'ring' ? 1.6 : 1));
      f.g.alpha = 1 - k;
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

function arcPoint(p: SimBackend['projectiles'], i: number, k: number) {
  const wx = p.sx[i] + (p.tx[i] - p.sx[i]) * k;
  const wy = p.sy[i] + (p.ty[i] - p.sy[i]) * k;
  const z = 4 * p.height[i] * k * (1 - k);
  return { sx: isoX(wx, wy), sy: isoY(wx, wy, z), gx: isoX(wx, wy), gy: isoY(wx, wy), z };
}
