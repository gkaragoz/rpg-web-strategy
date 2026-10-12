import { Application, Container, Graphics } from 'pixi.js';
import { Camera } from './camera';
import { isoX, isoY } from './iso';
import { buildGround } from './render/ground';
import { MassRenderer, type MassOptions } from './render/massRenderer';
import { DEATH_FADE, UnitView } from './render/unitView';
import type { SimBackend } from './sim/backend';
import type { BattleConfig } from './sim/battle';
import { SIM_DT } from './sim/constants';
import { InlineSim } from './sim/inlineSim';
import { STATS, Team } from './sim/units';
import { WorkerSim } from './sim/workerSim';
import { StatsPanel } from './ui/stats';

const HEAL_FX_LIFE = 0.8;
const WARMUP_FRAMES = 60;

// ?bench=10000  -> takim basina birim sayisi (10000 vs 10000)
// ?auto=30      -> 30 sn sonra otomatik rapor
// ?sim=main     -> sim'i worker yerine ana thread'de calistir (karsilastirma)
const params = new URLSearchParams(location.search);
const benchPer = params.has('bench') ? Math.max(10, Number(params.get('bench')) || 10000) : 0;
const autoSeconds = Number(params.get('auto')) || 0;
const isBench = benchPer > 0;
const canUseWorker = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
const useWorker = params.get('sim') !== 'main' && canUseWorker;

const app = new Application();
await app.init({
  resizeTo: window,
  background: 0x1a2332,
  antialias: !isBench,
  preference: 'webgl',
  resolution: Math.min(window.devicePixelRatio || 1, 2),
  autoDensity: true,
});
document.body.prepend(app.canvas);
app.ticker.stop();

const world = new Container();
app.stage.addChild(world);

let seed = 1;
const config: BattleConfig = isBench ? { mode: 'bench', perTeam: benchPer } : { mode: 'demo', perTeam: 10 };
const sim: SimBackend = useWorker ? await WorkerSim.create(config, seed) : new InlineSim(config, seed);
const camera = new Camera(app.canvas, sim.mapSize);
const stats = new StatsPanel(document.getElementById('stats')!);
const banner = document.getElementById('banner')!;

let speed = 1;
let paused = false;

// ---- Demo (detayli) render katmanlari ----
const unitLayer = new Container();
unitLayer.sortableChildren = true;
const shadowLayer = new Container();
const arrowLayer = new Container();
const fxLayer = new Container();
let views: UnitView[] = [];
const arrowViews: Array<{ shadow: Graphics; arrow: Graphics }> = [];
const healFx: Array<{ g: Graphics; t: number; x: number; y: number }> = [];

// ---- Bench (toplu) render ----
let mass: MassRenderer | null = null;
const massOpts: MassOptions = { bars: true, sort: true, cull: true };

if (isBench) {
  mass = new MassRenderer(app, sim);
  world.addChild(mass.buildGround(), mass.layer);
  camera.fit(app.screen.width, app.screen.height);
  if (autoSeconds > 0) camera.enabled = false;
} else {
  world.addChild(buildGround(sim.mapSize), shadowLayer, unitLayer, arrowLayer, fxLayer);
  buildViews();
}

function buildViews(): void {
  for (const v of views) v.root.destroy({ children: true });
  views = [];
  const u = sim.units;
  for (let i = 0; i < u.count; i++) {
    const v = new UnitView(u.kind[i], u.team[i], i);
    unitLayer.addChild(v.root);
    views.push(v);
  }
}

let resetting = false;
async function restart(): Promise<void> {
  if (resetting) return;
  resetting = true;
  seed++;
  await sim.reset(seed);
  resetBenchStats();
  if (mass) mass.rebuild();
  else buildViews();
  for (const fx of healFx) fx.g.visible = false;
  banner.style.display = 'none';
  resetting = false;
}

function arrowView(i: number): { shadow: Graphics; arrow: Graphics } {
  let v = arrowViews[i];
  if (!v) {
    const shadow = new Graphics();
    shadow.ellipse(0, 0, 4, 2).fill({ color: 0x000000, alpha: 0.25 });
    const arrow = new Graphics();
    arrow.moveTo(-9, 0).lineTo(7, 0).stroke({ width: 2, color: 0x6b4a2b });
    arrow.poly([7, -3, 12, 0, 7, 3]).fill(0xcfd4dc);
    arrow.poly([-9, 0, -12, -3, -6, 0, -12, 3]).fill(0xf2f2f2);
    shadowLayer.addChild(shadow);
    arrowLayer.addChild(arrow);
    v = { shadow, arrow };
    arrowViews[i] = v;
  }
  return v;
}

function spawnHeal(x: number, y: number): void {
  let fx = healFx.find((f) => f.t >= HEAL_FX_LIFE);
  if (!fx) {
    const g = new Graphics();
    g.roundRect(-2, -7, 4, 14, 1).fill(0x5be07a);
    g.roundRect(-7, -2, 14, 4, 1).fill(0x5be07a);
    fxLayer.addChild(g);
    fx = { g, t: HEAL_FX_LIFE, x: 0, y: 0 };
    healFx.push(fx);
  }
  fx.t = 0;
  fx.x = x;
  fx.y = y;
  fx.g.visible = true;
}

// ---- Benchmark olcumleri ----
const frameLog = new Float32Array(60 * 60 * 20);
let frameCount = 0;
let wallStart = 0;
let mainSimTotalMs = 0;
let renderTotalMs = 0;
let stallMs = 0;
let stallCount = 0;
let simTimeBase = -1;
let reported = false;
let drawnLine = '';

function resetBenchStats(): void {
  frameCount = 0;
  wallStart = 0;
  mainSimTotalMs = renderTotalMs = stallMs = stallCount = 0;
  simTimeBase = -1;
  reported = false;
}

function pct(sorted: Float32Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function benchSummary() {
  const n = Math.min(frameCount, frameLog.length) - WARMUP_FRAMES;
  if (n < 10) return null;
  const arr = frameLog.slice(WARMUP_FRAMES, WARMUP_FRAMES + n).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const avg = sum / n;
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const wall = (performance.now() - wallStart - stallMs) / 1000;
  const st = sim.stats();
  const simSteps = Math.max(1, st.steps);
  return {
    backend: sim.kind,
    perTeam: benchPer,
    mapSize: sim.mapSize,
    seconds: Number(wall.toFixed(1)),
    stalls: stallCount,
    frames: n,
    avgFps: Number((1000 / avg).toFixed(1)),
    avgFrameMs: Number(avg.toFixed(2)),
    p95FrameMs: Number(pct(arr, 0.95).toFixed(2)),
    p99FrameMs: Number(pct(arr, 0.99).toFixed(2)),
    worstFrameMs: Number(arr[n - 1].toFixed(2)),
    onePercentLowFps: Number((1000 / pct(arr, 0.99)).toFixed(1)),
    mainThreadSimMsPerFrame: Number((mainSimTotalMs / Math.max(1, frameCount)).toFixed(2)),
    simMsPerStep: Number((st.totalMs / simSteps).toFixed(2)),
    simMaxStepMs: Number(st.maxMs.toFixed(2)),
    simPhasesMsPerStep: Object.fromEntries(
      Object.entries(st.prof)
        .filter(([k]) => k !== 'steps')
        .map(([k, v]) => [k, Number((v / Math.max(1, st.prof.steps)).toFixed(2))]),
    ),
    renderMsPerFrame: Number((renderTotalMs / Math.max(1, frameCount)).toFixed(2)),
    realtimeFactor: Number(((sim.time - simTimeBase) / Math.max(0.001, wall)).toFixed(2)),
    aliveBlue: sim.alivePerTeam[Team.Blue],
    aliveRed: sim.alivePerTeam[Team.Red],
    heapMB: heap ? Number((heap.usedJSHeapSize / 1048576).toFixed(1)) : null,
  };
}

function showReport(): void {
  const r = benchSummary();
  if (!r) return;
  reported = true;
  (window as unknown as { __benchResult: unknown }).__benchResult = r;
  console.log('BENCH RESULT', JSON.stringify(r));
  banner.style.display = 'flex';
  banner.innerHTML = `<div style="background:rgba(10,14,20,.85);padding:16px 22px;border-radius:10px;font:14px/1.6 ui-monospace,Consolas,monospace;text-align:left;white-space:pre">${
    `BENCH ${r.perTeam} vs ${r.perTeam}  [${r.backend}]  (harita ${r.mapSize}x${r.mapSize}, ${r.seconds} sn)\n` +
    `FPS ort ${r.avgFps}   1% low ${r.onePercentLowFps}\n` +
    `Kare ort ${r.avgFrameMs} ms   p95 ${r.p95FrameMs}   p99 ${r.p99FrameMs}   en kotu ${r.worstFrameMs}\n` +
    `Sim ${r.simMsPerStep} ms/adim (max ${r.simMaxStepMs})   ana thread sim ${r.mainThreadSimMsPerFrame} ms/kare\n` +
    `Render ${r.renderMsPerFrame} ms/kare (CPU)\n` +
    `Gercek zaman carpani x${r.realtimeFactor}   Canli: ${r.aliveBlue} / ${r.aliveRed}\n` +
    `R: yeniden baslat`
  }</div>`;
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') void restart();
  else if (e.code === 'F3') {
    e.preventDefault();
    stats.toggle();
  } else if (e.code === 'Space') {
    e.preventDefault();
    paused = !paused;
    sim.setPaused(paused);
  } else if (e.code === 'Digit1') setSpeed(1);
  else if (e.code === 'Digit2') setSpeed(2);
  else if (e.code === 'Digit3') setSpeed(4);
  else if (isBench && e.code === 'KeyB') massOpts.bars = !massOpts.bars;
  else if (isBench && e.code === 'KeyO') massOpts.sort = !massOpts.sort;
  else if (isBench && e.code === 'KeyC') massOpts.cull = !massOpts.cull;
  else if (isBench && e.code === 'KeyP') showReport();
});

function setSpeed(s: number): void {
  speed = s;
  sim.setSpeed(s);
}

let last = performance.now();
let time = 0;
let activeProjectiles = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const frameMs = now - last;
  last = now;
  // Uzun duraklar (sekme/pencere beklemesi) simulasyonu ilerletmez.
  const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
  time += dt;
  if (!wallStart) {
    wallStart = performance.now();
    sim.resetStats();
  }
  if (resetting) return;

  camera.update(dt);
  camera.apply(world, app.screen.width, app.screen.height);

  const info = sim.frame(dt);
  if (simTimeBase < 0) simTimeBase = sim.time;

  const t1 = performance.now();
  if (mass) syncMass(info.alpha);
  else syncViews(dt, info.alpha);
  app.render();
  const t2 = performance.now();

  // >500 ms'lik kareler sekme/pencere beklemesidir (arka plan kisitlamasi); olcume katilmaz.
  if (frameMs > 500) {
    stallMs += frameMs;
    stallCount++;
  } else {
    if (frameCount < frameLog.length) frameLog[frameCount] = frameMs;
    frameCount++;
  }
  mainSimTotalMs += info.mainSimMs;
  renderTotalMs += t2 - t1;
  if (isBench && autoSeconds > 0 && !reported && (performance.now() - wallStart - stallMs) / 1000 >= autoSeconds) showReport();

  stats.push(frameMs, info.mainSimMs, t2 - t1);
  const st = sim.stats();
  const wall = (performance.now() - wallStart - stallMs) / 1000;
  const stepMs = st.totalMs / Math.max(1, st.steps);
  const extra: string[] = [
    `Sim thread ${sim.kind === 'worker' ? 'worker' : 'ana thread'}`,
    `Sim/adim   ${stepMs.toFixed(2)} ms (max ${st.maxMs.toFixed(1)})  yuk %${((stepMs / (SIM_DT * 1000)) * 100).toFixed(0)}`,
    `Zaman x    ${((sim.time - simTimeBase) / Math.max(0.001, wall)).toFixed(2)} (1.00 = gercek zaman)`,
  ];
  if (isBench) {
    extra.push(
      drawnLine,
      `[B]ar ${massOpts.bars ? 'ac' : 'kapali'}  [O]sira ${massOpts.sort ? 'ac' : 'kapali'}  [C]ull ${massOpts.cull ? 'ac' : 'kapali'}`,
    );
  }
  stats.update(now, {
    blue: sim.alivePerTeam[Team.Blue],
    red: sim.alivePerTeam[Team.Red],
    projectiles: activeProjectiles,
    simSteps: info.steps,
    speed,
    paused,
    extra,
  });
}

function syncMass(alpha: number): void {
  const w = app.screen.width / camera.zoom;
  const h = app.screen.height / camera.zoom;
  mass!.sync(
    time,
    alpha,
    {
      left: camera.x - w / 2 - 60,
      right: camera.x + w / 2 + 60,
      top: camera.y - h / 2 - 100,
      bottom: camera.y + h / 2 + 40,
    },
    massOpts,
  );
  sim.events.length = 0;
  activeProjectiles = mass!.drawnArrows;
  drawnLine = `Cizilen    ${mass!.drawnUnits} birim, ${mass!.drawnArrows} ok`;
}

function syncViews(dt: number, alpha: number): void {
  const u = sim.units;
  const vdt = paused ? 0 : dt;

  for (const ev of sim.events) {
    if (ev.type === 'heal') spawnHeal(ev.x, ev.y);
  }
  sim.events.length = 0;

  for (let i = 0; i < u.count; i++) {
    const v = views[i];
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
      time,
      vdt,
    );
  }

  const p = sim.projectiles;
  const advance = alpha * SIM_DT;
  activeProjectiles = 0;
  for (let i = 0; i < p.count; i++) {
    const v = arrowView(i);
    if (!p.active[i]) {
      v.arrow.visible = v.shadow.visible = false;
      continue;
    }
    activeProjectiles++;
    const k = Math.min(1, (p.t[i] + advance) / p.dur[i]);
    const pos = arcPoint(p, i, k);
    const next = arcPoint(p, i, Math.min(1, k + 0.03));
    v.arrow.visible = v.shadow.visible = true;
    v.arrow.position.set(pos.sx, pos.sy);
    v.arrow.rotation = Math.atan2(next.sy - pos.sy, next.sx - pos.sx);
    v.shadow.position.set(pos.gx, pos.gy);
    v.shadow.scale.set(1 - pos.z / 120);
  }
  // Kullanilmayan (onceki kareden kalan) ok gorunumlerini gizle.
  for (let i = p.count; i < arrowViews.length; i++) {
    const v = arrowViews[i];
    if (v) v.arrow.visible = v.shadow.visible = false;
  }

  for (const fx of healFx) {
    if (fx.t >= HEAL_FX_LIFE) {
      fx.g.visible = false;
      continue;
    }
    fx.t += dt;
    const k = fx.t / HEAL_FX_LIFE;
    fx.g.position.set(isoX(fx.x, fx.y), isoY(fx.x, fx.y) - 50 - k * 28);
    fx.g.alpha = 1 - k;
  }

  if (sim.winner >= 0) {
    banner.style.display = 'flex';
    banner.innerHTML = `<div>${sim.winner === Team.Blue ? 'Mavi' : 'Kırmızı'} takım kazandı<br><span style="font-size:16px;font-weight:400">R ile yeniden başlat</span></div>`;
  }
}

function arcPoint(p: SimBackend['projectiles'], i: number, k: number) {
  const wx = p.sx[i] + (p.tx[i] - p.sx[i]) * k;
  const wy = p.sy[i] + (p.ty[i] - p.sy[i]) * k;
  const z = 4 * p.height[i] * k * (1 - k);
  return { sx: isoX(wx, wy), sy: isoY(wx, wy, z), gx: isoX(wx, wy), gy: isoY(wx, wy), z };
}

(window as unknown as { __sim: SimBackend; __camera: Camera }).__sim = sim;
(window as unknown as { __camera: Camera }).__camera = camera;
requestAnimationFrame(frame);
