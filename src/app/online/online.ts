import type { Application } from 'pixi.js';
import type { Camera } from '../../camera';
import { HostLobby } from '../../net/host';
import { GuestSession, HostSession, type Session } from '../../net/client';
import { LockstepSim } from '../../net/lockstepSim';
import { battleConfig, makeCode, type GameInit, type ServerMsg } from '../../net/protocol';
import { NetError, WsGuestTransport, WsHostTransport, lanUrl } from '../../net/wsTransport';
import type { Atlas } from '../../render/atlas';
import type { TeamColors } from '../../render/unitView';
import type { MapSpec } from '../../sim/mapSpec';
import { LEGACY_COUNT, setUnitLevel } from '../../sim/units';
import type { StatsPanel } from '../../ui/stats';
import type { BattleOptions, BattleScene } from '../battle';
import { makeTeamColor } from '../state';
import type { WorldView } from '../world';
import { CursorLayer, playerColor } from './cursors';
import { Placement } from './placement';
import { LobbyScreen, MenuScreen } from './screens';

const PROFILE_KEY = 'rpgweb.online.profile';

export interface OnlineEnv {
  app: Application;
  world: WorldView;
  camera: Camera;
  battle: BattleScene;
  stats: StatsPanel;
  /** Atlas'i verilen takim renkleri/ortam/turlerle yeniden pisirir ve dunyaya baglar. */
  bake(colors: TeamColors[], biome: MapSpec['biome'], kinds: Set<number>): void;
  getAtlas(): Atlas;
  /** Birim simgeleri icin gecici takim renkleri (null: normal). */
  setIconColors(c: TeamColors[] | null): void;
  icon(kind: number, team: number): HTMLCanvasElement;
  battleDefaults(): Pick<BattleOptions, 'fx' | 'numbers'>;
  /** Cevrimici moddan stüdyoya don. */
  onExit(): void;
  setComedyVisual(on: boolean | null): void;
}

type Screen = 'menu' | 'lobby' | 'placing' | 'battle';

function loadProfile(): { name: string; color: number } {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}') as { name?: string; color?: number };
    return { name: typeof p.name === 'string' ? p.name.slice(0, 16) : '', color: Number.isInteger(p.color) ? (p.color as number) : 0 };
  } catch {
    return { name: '', color: 0 };
  }
}
function saveProfile(name: string, color: number): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ name, color }));
  } catch {
    /* depolama kapali */
  }
}

/** Cevrimici mod orkestratoru: menu -> lobi -> yerlestirme -> savas; oturum durumuna gore ekran degistirir. */
export class OnlineApp {
  private readonly root: HTMLElement;
  private screen: Screen = 'menu';
  private menu: MenuScreen | null = null;
  private lobby: LobbyScreen | null = null;
  private placement: Placement | null = null;
  private session: Session | null = null;
  private cursors: CursorLayer | null = null;
  private colors: TeamColors[] = [];
  private biome: MapSpec['biome'] = 'forest';
  private inBattle = false;
  private sim: LockstepSim | null = null;
  private dead = false;
  private busy = false;
  private transition: Promise<void> = Promise.resolve();

  constructor(private readonly env: OnlineEnv) {
    this.root = document.createElement('div');
    this.root.id = 'online-root';
    document.body.appendChild(this.root);
  }

  get active(): boolean {
    return !this.dead;
  }

  // ---------------------------------------------------------------- menu

  openMenu(code?: string): void {
    this.menu?.destroy();
    const prof = loadProfile();
    this.menu = new MenuScreen(
      this.root,
      { name: prof.name, color: prof.color, code },
      {
        onHost: (n, c, tp) => void this.host(n, c, tp),
        onJoin: (n, c, code2, pass, spec) => void this.join(n, c, code2, pass, spec),
        onClose: () => this.exit(),
      },
      false,
    );
  }

  private fail(msg: string): void {
    this.menu?.setBusy(false);
    this.menu?.setError(msg);
    this.busy = false;
  }

  private async host(name: string, color: number, _tp: 'lan' | 'net'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu?.setBusy(true);
    this.menu?.setError('');
    saveProfile(name, color);
    try {
      let tp: WsHostTransport | null = null;
      let code = '';
      for (let i = 0; i < 6 && !tp; i++) {
        code = makeCode();
        try {
          tp = await WsHostTransport.create(lanUrl(code, 'host'));
        } catch (e) {
          if (!(e instanceof NetError) || e.code !== 'taken') throw e;
        }
      }
      if (!tp) return this.fail('Lobi kodu üretilemedi, tekrar dene.');
      const lobby = new HostLobby(tp, name, color, { code });
      tp.onPeerJoin = () => {};
      this.attach(new HostSession(lobby));
    } catch (e) {
      this.fail(e instanceof NetError && e.code === 'failed' ? 'LAN sunucusuna bağlanılamadı. Oyunu "--lan" ile başlat (oyna-lan) ve o adresi aç.' : `Bağlantı hatası: ${(e as Error).message}`);
    }
  }

  private async join(name: string, color: number, code: string, pass: string, spectator: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu?.setBusy(true);
    this.menu?.setError('');
    saveProfile(name, color);
    try {
      const tp = await WsGuestTransport.create(lanUrl(code, 'guest'));
      const s = new GuestSession(tp, { name, color, pass: pass || undefined, spectator });
      const ok = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve('Lobi yanıt vermedi.'), 8000);
        s.model.listeners.push((m) => {
          if (m.t === 'welcome') {
            clearTimeout(timer);
            resolve(null);
          } else if (m.t === 'reject') {
            clearTimeout(timer);
            resolve(
              ({ full: 'Lobi dolu.', password: 'Parola yanlış.', version: 'Sürüm uyuşmuyor (sayfayı yenile).', started: 'Oyun başladı; seyirci olarak katılabilirsin.', kicked: 'Bu lobiden atıldın.', closed: 'Lobi kapalı.', name: 'Bu ad kullanımda.' } as Record<string, string>)[m.reason] ?? 'Katılınamadı.',
            );
          } else if (m.t === 'closed') {
            clearTimeout(timer);
            resolve('Bağlantı kapandı.');
          }
        });
      });
      if (ok) {
        s.leave();
        return this.fail(ok);
      }
      this.attach(s);
    } catch (e) {
      this.fail(e instanceof NetError ? (e.code === 'noroom' ? 'Böyle bir lobi yok.' : e.code === 'full' ? 'Lobi dolu.' : 'Sunucuya bağlanılamadı (LAN adresini kontrol et).') : `Bağlantı hatası: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- oturum

  private attach(s: Session): void {
    this.busy = false;
    this.session = s;
    this.menu?.destroy();
    this.menu = null;
    this.cursors = new CursorLayer(s.model, (m) => s.send(m));
    s.model.listeners.push((m) => this.onMessage(m));
    this.sync();
  }

  private onMessage(msg: ServerMsg): void {
    if (this.dead) return;
    const m = this.session?.model;
    if (!m) return;
    if (msg.t === 'closed' || msg.t === 'kicked') {
      this.toast(msg.t === 'kicked' ? `Lobiden atıldın: ${msg.reason}` : m.closedReason ?? 'Lobi kapandı');
      this.exit();
      return;
    }
    if (msg.t === 'state' || msg.t === 'welcome' || msg.t === 'start') this.sync();
    this.lobby?.update();
    this.placement?.onMessage(msg);
  }

  /** Oturum evresine gore dogru ekrani kurar. */
  private sync(): void {
    const m = this.session?.model;
    const st = m?.state;
    if (!m || !st) return;
    const want: Screen = st.phase === 'lobby' ? 'lobby' : st.phase === 'placing' ? 'placing' : 'battle';
    if (want === 'placing' && !st.init) return;
    if (want === 'battle' && !m.start) return;
    if (want === this.screen && (want !== 'battle' || this.inBattle)) return;
    // Gecisler sirayla calissin (asenkron savas kurulumu).
    this.transition = this.transition.then(() => this.go(want)).catch((e) => console.error(e));
  }

  private async go(want: Screen): Promise<void> {
    if (this.dead || !this.session) return;
    const st = this.session.model.state!;
    // Mevcut ekrani kapat.
    const prev = this.screen;
    if (prev === 'lobby' && want !== 'lobby') {
      this.lobby?.destroy();
      this.lobby = null;
    }
    if (prev === 'placing' && want !== 'placing') {
      this.placement?.destroy();
      this.placement = null;
    }
    if (prev === 'battle' && want !== 'battle') this.leaveBattle();
    this.screen = want;
    if (want === 'lobby') {
      this.cursors?.setView(null);
      this.env.setIconColors(null);
      this.env.setComedyVisual(null);
      this.lobby = new LobbyScreen(this.root, this.session, { onLeave: () => this.exit(), link: (c) => `${location.origin}${location.pathname}#join=${c}` });
    } else if (want === 'placing') {
      await this.startPlacing(st.init!);
    } else {
      await this.startBattle();
    }
  }

  private teamColorsFor(init: GameInit): TeamColors[] {
    const st = this.session!.model.state!;
    return init.teamPlayers.map((id) => makeTeamColor(playerColor(st.players.find((p) => p.id === id)?.color ?? 0)));
  }

  private mapConfig(init: GameInit) {
    return { mode: 'custom' as const, perTeam: 0, teamCount: init.teams, mapSize: init.size, env: true, kite: true, terrainSeed: init.seed, map: init.spec, level: init.level, comedy: init.comedyPhysics };
  }

  private async startPlacing(init: GameInit): Promise<void> {
    const { env } = this;
    setUnitLevel(init.level);
    this.colors = this.teamColorsFor(init);
    this.biome = init.spec.biome;
    env.setIconColors(this.colors);
    env.bake(this.colors, this.biome, new Set(Array.from({ length: LEGACY_COUNT }, (_, i) => i)));
    env.world.rebuild(this.mapConfig(init), env.getAtlas(), true);
    env.camera.setMap(env.world.mapSize);
    env.camera.fit(env.app.screen.width, env.app.screen.height);
    this.cursors?.setView({ app: env.app, world: env.world, terrain: () => env.world.terrain, size: () => env.world.mapSize });
    this.placement = new Placement(
      {
        app: env.app,
        world: env.world,
        camera: env.camera,
        getAtlas: () => env.getAtlas(),
        ensureAtlas: (kinds) => this.ensureKinds(kinds),
        icon: (k, t) => env.icon(k, t),
        toast: (m) => this.toast(m),
        root: this.root,
      },
      this.session!,
      init,
      this.colors,
    );
  }

  private ensureKinds(kinds: Set<number>): boolean {
    const a = this.env.getAtlas();
    for (const k of kinds) {
      if (!a.kinds.has(k)) {
        this.env.bake(this.colors, this.biome, new Set([...a.kinds, ...kinds]));
        return true;
      }
    }
    return false;
  }

  private async startBattle(): Promise<void> {
    const s = this.session!;
    const m = s.model;
    const start = m.start!;
    const { env } = this;
    const init = start.init;
    setUnitLevel(init.level);
    this.colors = this.teamColorsFor(init);
    this.biome = init.spec.biome;
    env.setIconColors(this.colors);
    // Katilimci ortasinda girenlerin atlasi tum turleri icermeli.
    const kinds = new Set<number>(Array.from({ length: LEGACY_COUNT }, (_, i) => i));
    for (let i = 0; i < start.layout.length; i += 4) kinds.add(start.layout[i + 1]);
    env.bake(this.colors, this.biome, kinds);
    this.placement?.destroy();
    this.placement = null;
    const cfg = battleConfig(start);
    const host = s instanceof HostSession ? s.lobby : undefined;
    this.sim = new LockstepSim(cfg, start.simSeed, m, { host, send: (msg) => s.send(msg) });
    const names = init.teamPlayers.map((id) => m.state?.players.find((p) => p.id === id)?.name ?? '');
    env.setComedyVisual(init.comedyVisual);
    const d = env.battleDefaults();
    await env.battle.enter({
      config: cfg,
      colors: this.colors,
      speed: 1,
      bench: false,
      autoSeconds: 0,
      useWorker: false,
      seed: start.simSeed,
      fx: d.fx,
      numbers: d.numbers,
      onEdit: () => this.exit(),
      sim: this.sim,
      online: {
        isHost: s.isHost,
        teamNames: names,
        getSpeed: () => m.speed,
        getPaused: () => m.paused,
        onLeave: () => this.exit(),
        onRematch: s.isHost ? () => s.send({ t: 'rematch' }) : undefined,
      },
    });
    env.stats.setShown(true);
    this.inBattle = true;
    this.cursors?.setView({ app: env.app, world: env.world, terrain: () => env.world.terrain, size: () => env.world.mapSize });
  }

  private leaveBattle(): void {
    if (!this.inBattle) return;
    this.inBattle = false;
    this.env.battle.exit();
    this.env.stats.setShown(false);
    this.sim = null;
  }

  // ---------------------------------------------------------------- dongu

  /** Ana dongunun cevrimici karesi. */
  frame(now: number, frameMs: number): void {
    const dt = frameMs > 500 ? 0 : Math.min(frameMs / 1000, 0.1);
    if (this.inBattle) this.env.battle.frame(now, frameMs);
    else {
      this.env.camera.update(dt);
      this.env.camera.apply(this.env.world.root, this.env.app.screen.width, this.env.app.screen.height);
      this.env.app.render();
    }
    this.cursors?.update(dt);
  }

  // ---------------------------------------------------------------- yardimci

  private toast(msg: string): void {
    const el = document.createElement('div');
    el.className = 'on-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  /** Cevrimici moddan cik: oturumu kapat, ekranlari kaldir, stüdyoya don. */
  exit(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.session?.leave();
    } catch {
      /* baglanti zaten kapali */
    }
    this.menu?.destroy();
    this.lobby?.destroy();
    this.placement?.destroy();
    this.leaveBattle();
    this.cursors?.destroy();
    this.root.remove();
    this.env.setIconColors(null);
    this.env.setComedyVisual(null);
    this.env.onExit();
  }
}
