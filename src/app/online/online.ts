import type { Application } from 'pixi.js';
import type { Camera } from '../../camera';
import { HostLobby } from '../../net/host';
import { GuestSession, HostSession, type Session } from '../../net/client';
import { LockstepSim } from '../../net/lockstepSim';
import { battleConfig, makeCode, type GameInit, type ServerMsg } from '../../net/protocol';
import { PeerGuestTransport, PeerHostTransport } from '../../net/peerTransport';
import type { Transport } from '../../net/transport';
import { NetError, WsGuestTransport, WsHostTransport, lanUrl } from '../../net/wsTransport';
import type { Atlas } from '../../render/atlas';
import type { TeamColors } from '../../render/unitView';
import type { MapSpec } from '../../sim/mapSpec';
import { LEGACY_COUNT, setUnitLevel } from '../../sim/units';
import { STATS_DEFAULT_SHOWN, type StatsPanel } from '../../ui/stats';
import type { BattleOptions, BattleScene } from '../battle';
import { makeTeamColor } from '../state';
import type { WorldView } from '../world';
import { ConnBadge } from './badge';
import { ChatOverlay } from './chat';
import { CursorLayer, playerColor } from './cursors';
import { Placement } from './placement';
import { LobbyScreen, MenuScreen } from './screens';

const PROFILE_KEY = 'rpgweb.online.profile';
const LAST_KEY = 'rpgweb.online.last';

interface LastSession {
  code: string;
  token: string;
  name: string;
  color: number;
  at: number;
}
/** Geri baglanma suresi (host 60 sn tutar); biraz pay birakilir. */
const REJOIN_MS = 55000;
function loadLast(): LastSession | null {
  try {
    const l = JSON.parse(sessionStorage.getItem(LAST_KEY) ?? 'null') as LastSession | null;
    return l && typeof l.code === 'string' && Date.now() - l.at < REJOIN_MS ? l : null;
  } catch {
    return null;
  }
}
function saveLast(l: LastSession | null): void {
  try {
    if (l) sessionStorage.setItem(LAST_KEY, JSON.stringify(l));
    else sessionStorage.removeItem(LAST_KEY);
  } catch {
    /* depolama kapali */
  }
}
/** Internet lobilerinin paylasilan baglanti adresi (Pages). */
/** Internet rolesi (relay/ Cloudflare Worker): NAT/TURN gerektirmez; ulasilamazsa PeerJS (WebRTC) denenir. */
export const RELAY_URL = 'wss://rpg-web-relay.gkaragoz96tablet.workers.dev';
/** Rolenin ilk baglantisi (TLS + Durable Object soguk baslangici) LAN'dan yavas olabilir. */
const RELAY_TIMEOUT_MS = 12000;
const PAGES_URL = 'https://gkaragoz.github.io/rpg-web-strategy/';

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
  private chat: ChatOverlay | null = null;
  private badge: ConnBadge | null = null;
  private session: Session | null = null;
  private cursors: CursorLayer | null = null;
  private colors: TeamColors[] = [];
  private biome: MapSpec['biome'] = 'forest';
  private inBattle = false;
  private sim: LockstepSim | null = null;
  private kind: 'lan' | 'net' = 'lan';
  /** Kullanilan tasima: gosterim ve tani icin. */
  private via = 'LAN';
  private lastSaved = 0;
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
      { name: prof.name, color: prof.color, code, last: loadLast()?.code },
      {
        onHost: (n, c, tp) => void this.host(n, c, tp),
        onJoin: (n, c, code2, pass, spec) => void this.join(n, c, code2, pass, spec),
        onClose: () => this.exit(),
        onRejoin: () => {
          const l = loadLast();
          if (l) void this.join(l.name, l.color, l.code, '', false, l.token);
        },
      },
      true,
    );
  }

  private fail(msg: string): void {
    this.menu?.setStatus('');
    this.menu?.setBusy(false);
    this.menu?.setError(msg);
    this.busy = false;
  }

  private async host(name: string, color: number, kind: 'lan' | 'net'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu?.setBusy(true);
    this.menu?.setError('');
    saveProfile(name, color);
    try {
      let tp: Transport | null = null;
      let code = '';
      this.menu?.setStatus(kind === 'net' ? 'Sinyal sunucusuna bağlanılıyor…' : 'LAN sunucusuna bağlanılıyor…');
      for (let i = 0; i < 6 && !tp; i++) {
        code = makeCode();
        try {
          if (kind === 'net') {
            try {
              tp = await WsHostTransport.create(lanUrl(code, 'host', RELAY_URL), RELAY_TIMEOUT_MS);
              this.via = 'İnternet rölesi';
            } catch (re) {
              if (re instanceof NetError && re.code === 'taken') throw re;
              console.warn('[online] röle host hatası', re);
              this.menu?.setStatus('Röle ulaşılamadı, doğrudan bağlantı (WebRTC) deneniyor…');
              tp = await PeerHostTransport.create(code);
              this.via = 'WebRTC';
            }
          } else tp = await WsHostTransport.create(lanUrl(code, 'host'));
        } catch (e) {
          if (!(e instanceof NetError) || e.code !== 'taken') throw e;
        }
      }
      if (!tp) return this.fail('Lobi kodu üretilemedi, tekrar dene.');
      const lobby = new HostLobby(tp, name, color, { code });
      this.kind = kind;
      this.attach(new HostSession(lobby));
    } catch (e) {
      this.fail(
        e instanceof NetError && e.code === 'failed'
          ? kind === 'net'
            ? 'İnternet bağlantısı kurulamadı (sinyal sunucusuna ulaşılamıyor). LAN dene ya da ağını kontrol et.'
            : 'LAN sunucusuna bağlanılamadı. Oyunu "--lan" ile başlat (oyna-lan) ve o adresi aç.'
          : `Bağlantı hatası: ${(e as Error).message}`,
      );
    }
  }

  private async join(name: string, color: number, code: string, pass: string, spectator: boolean, token?: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.menu?.setBusy(true);
    this.menu?.setError('');
    saveProfile(name, color);
    try {
      // Once LAN sunucusu (ayni adres), olmazsa internet (PeerJS).
      let tp: Transport;
      let kind: 'lan' | 'net' = 'lan';
      this.menu?.setStatus('LAN sunucusu aranıyor…');
      try {
        tp = await WsGuestTransport.create(lanUrl(code, 'guest'));
      } catch (e) {
        if (e instanceof NetError && (e.code === 'full' || e.code === 'taken')) throw e;
        kind = 'net';
        this.menu?.setStatus('İnternet rölesi deneniyor…');
        try {
          tp = await WsGuestTransport.create(lanUrl(code, 'guest', RELAY_URL), RELAY_TIMEOUT_MS);
          this.via = 'İnternet rölesi';
        } catch (re) {
          if (re instanceof NetError && (re.code === 'full' || re.code === 'taken')) throw re;
          console.warn('[online] röle misafir hatası', re);
          this.menu?.setStatus('Doğrudan bağlantı (WebRTC) deneniyor… (30 sn’ye kadar sürebilir)');
          tp = await PeerGuestTransport.create(code);
          this.via = 'WebRTC';
        }
      }
      this.kind = kind;
      const s = new GuestSession(tp, { name, color, pass: pass || undefined, spectator, token });
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
      saveLast({ code, token: s.model.token, name, color, at: Date.now() });
      this.attach(s);
    } catch (e) {
      const detail = e instanceof NetError ? e.message : '';
      this.fail(
        e instanceof NetError
          ? e.code === 'noroom'
            ? 'Böyle bir lobi yok (kodu kontrol et; host sayfası açık olmalı).'
            : e.code === 'full'
              ? 'Lobi dolu.'
              : detail.startsWith('ice')
                ? 'Host bulundu ama doğrudan bağlantı kurulamadı (ağ/NAT engeli). Farklı ağ ya da LAN dene; mobil veride bazı operatörler WebRTC’yi engeller.'
                : 'Sunucuya bağlanılamadı (internet ya da PeerJS sinyal sunucusu erişimi).'
          : `Bağlantı hatası: ${(e as Error).message}`,
      );
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
    // Misafir: yeniden baglanma kaydinin zamani canli tutulur (kopus anindan itibaren sayilir).
    if (!this.session?.isHost && Date.now() - this.lastSaved > 4000) {
      this.lastSaved = Date.now();
      const l = loadLast();
      if (l) saveLast({ ...l, at: Date.now() });
    }
    if (msg.t === 'state' || msg.t === 'welcome' || msg.t === 'start') this.sync();
    this.lobby?.update();
    this.chat?.update();
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
      this.chat?.destroy();
      this.chat = null;
      this.badge?.destroy();
      this.badge = null;
      this.cursors?.setView(null);
      this.env.setIconColors(null);
      this.env.setComedyVisual(null);
      this.lobby = new LobbyScreen(this.root, this.session, { onLeave: () => this.exit(), via: () => this.via, link: (c) => this.linkFor(c) });
    } else if (want === 'placing') {
      this.chat ??= new ChatOverlay(this.root, this.session);
      this.badge ??= this.makeBadge();
      await this.startPlacing(st.init!);
    } else {
      this.chat ??= new ChatOverlay(this.root, this.session);
      this.badge ??= this.makeBadge();
      await this.startBattle();
    }
  }

  private linkFor(code: string): string {
    return `${this.kind === 'net' ? PAGES_URL : location.origin + location.pathname}#join=${code}`;
  }

  private makeBadge(): ConnBadge {
    return new ConnBadge(this.root, () => {
      const code = this.session?.model.state?.code ?? '';
      return { via: this.via, code, link: this.linkFor(code) };
    });
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
    env.stats.setShown(STATS_DEFAULT_SHOWN);
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
    saveLast(null);
    try {
      this.session?.leave();
    } catch {
      /* baglanti zaten kapali */
    }
    this.menu?.destroy();
    this.lobby?.destroy();
    this.placement?.destroy();
    this.chat?.destroy();
    this.badge?.destroy();
    this.leaveBattle();
    this.cursors?.destroy();
    this.root.remove();
    this.env.setIconColors(null);
    this.env.setComedyVisual(null);
    this.env.onExit();
  }
}
