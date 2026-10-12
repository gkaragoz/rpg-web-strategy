import { Application } from 'pixi.js';
import './app/studio.css';
import { BattleScene, type BattleOptions } from './app/battle';
import { Editor } from './app/editor';
import { loadState, saveState, teamColors } from './app/state';
import { Studio } from './app/studio';
import { WorldView } from './app/world';
import { Camera } from './camera';
import { bakeAtlas, type Atlas } from './render/atlas';
import type { BattleConfig } from './sim/battle';
import { StatsPanel } from './ui/stats';

// Benchmark ve hata ayiklama parametreleri (stüdyoyu atlar):
//   ?bench=10000&auto=30  -> takim basina birim, otomatik rapor
//   ?sim=main             -> sim'i worker yerine ana thread'de calistir
//   ?env=off  ?kite=off  ?seed=3  -> stüdyo ayarlarini gecici olarak ezer
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

const state = loadState();
if (params.get('env') === 'off') state.env = false;
if (params.get('kite') === 'off') state.kite = false;
if (Number(params.get('seed'))) state.seed = Number(params.get('seed'));

const world = new WorldView();
app.stage.addChild(world.root);
const camera = new Camera(app.canvas, state.mapSize);
const stats = new StatsPanel(document.getElementById('stats')!);
const banner = document.getElementById('banner')!;
const studioRoot = document.getElementById('studio')!;
const hudRoot = document.getElementById('hud')!;

let atlas: Atlas = bakeAtlas(app.renderer, teamColors(state.palette, state.teamCount));
const getAtlas = (): Atlas => atlas;

const battle = new BattleScene({ app, world, camera, getAtlas, stats, hudRoot, banner });
let mode: 'studio' | 'battle' = 'studio';

function studioConfig(): BattleConfig {
  return { mode: 'custom', perTeam: 0, teamCount: state.teamCount, mapSize: state.mapSize, env: state.env, kite: state.kite, terrainSeed: state.seed, stats: state.stats };
}

function layoutArray(): Float32Array {
  const a = new Float32Array(state.units.length * 4);
  state.units.forEach((u, i) => {
    a[i * 4] = u.team;
    a[i * 4 + 1] = u.kind;
    a[i * 4 + 2] = u.x;
    a[i * 4 + 3] = u.y;
  });
  return a;
}

// ---- Stüdyo ----

let studio!: Studio;
const editor = new Editor({
  app,
  world,
  camera,
  state,
  getAtlas,
  onChange: () => studio?.render(),
  toast: (m) => studio?.toast(m),
});

/** Harita ayarlari (tohum/cevre/boyut) degisince dunyayi yeniler, gecersiz askerleri tasir. */
function rebuildWorld(announce: boolean): void {
  world.rebuild(studioConfig(), atlas, true);
  camera.setMap(world.mapSize);
  camera.fit(app.screen.width, app.screen.height);
  editor.setSeedForRandom(state.seed);
  const r = editor.revalidate();
  if (announce && (r.moved > 0 || r.removed > 0)) {
    studio.toast(`Harita değişti: ${r.moved} asker taşındı${r.removed ? `, ${r.removed} asker kaldırıldı` : ''}.`);
  }
  studio.render();
}

let mapTimer: number | undefined;
function onMapChange(): void {
  window.clearTimeout(mapTimer);
  mapTimer = window.setTimeout(() => rebuildWorld(true), 120);
}

/** Takim sayisi/palet degisti: atlas'i yeni renklerle yeniden pisirir. */
function onPaletteChange(): void {
  const old = atlas;
  atlas = bakeAtlas(app.renderer, teamColors(state.palette, state.teamCount));
  world.setAtlas(atlas, true);
  editor.refreshSprites();
  old.dispose();
  studio.render();
}

studio = new Studio(studioRoot, {
  state,
  editor,
  onMapChange,
  onPaletteChange,
  onStart: () => void startBattle(),
  onBench: (per) => {
    location.search = `?bench=${per}&auto=30`;
  },
});

async function startBattle(): Promise<void> {
  saveState(state);
  const colors = teamColors(state.palette, state.teamCount);
  const opts: BattleOptions = {
    config: { ...studioConfig(), layout: layoutArray() },
    colors,
    speed: state.speed,
    bench: false,
    autoSeconds: 0,
    useWorker,
    seed: state.seed,
    onEdit: () => void backToStudio(),
  };
  studio.hide();
  editor.exit();
  await battle.enter(opts);
  stats.setShown(true);
  mode = 'battle';
}

async function backToStudio(): Promise<void> {
  battle.exit();
  mode = 'studio';
  rebuildWorld(false);
  camera.fit(app.screen.width, app.screen.height);
  stats.setShown(false);
  studio.show();
  editor.enter();
}

async function startBench(): Promise<void> {
  studioRoot.hidden = true;
  await battle.enter({
    config: { mode: 'bench', perTeam: benchPer, env: state.env, terrainSeed: state.seed, kite: state.kite },
    colors: teamColors('classic', 2),
    speed: 1,
    bench: true,
    autoSeconds,
    useWorker,
    seed: 1,
    onEdit: () => {
      location.search = '';
    },
  });
  mode = 'battle';
}

// ---- Ana dongu ----

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const frameMs = now - last;
  last = now;
  if (mode === 'battle') {
    battle.frame(now, frameMs);
    return;
  }
  const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
  camera.update(dt);
  camera.apply(world.root, app.screen.width, app.screen.height);
  app.render();
}

(window as unknown as { __camera: Camera }).__camera = camera;

if (isBench) {
  await startBench();
} else {
  rebuildWorld(false);
  if (state.fresh) {
    editor.quickFormation();
    state.fresh = false;
    saveState(state);
  }
  stats.setShown(false);
  studio.show();
  editor.enter();
}
requestAnimationFrame(frame);
