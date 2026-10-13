import type { Session } from '../../net/client';
import { act } from '../../net/act';
import type { PlayerInfo } from '../../net/protocol';
import { DEFAULT_MAP, type MapSpec } from '../../sim/mapSpec';
import type { Rarity } from '../../sim/data/troops';
import { MapPicker, drawMinimap } from '../mapPicker';
import { PALETTES, defaultState, type AppState } from '../state';
import { hex } from '../state';
import { loadTurn, saveTurn } from '../../net/peerTransport';
import { playerColor } from './cursors';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COLORS = PALETTES[0].colors;

export interface MenuHandlers {
  onHost(name: string, color: number, transport: 'lan' | 'net'): void;
  onJoin(name: string, color: number, code: string, pass: string, spectator: boolean): void;
  onClose(): void;
  onRejoin?(): void;
}

export interface MenuInit {
  name: string;
  color: number;
  code?: string;
  /** Kopan oturum: yeniden baglan dugmesi gosterilir. */
  last?: string;
}

/** Cevrimici menu: ad + renk, Lobi Kur / Kodla Katil / Seyret kartlari. */
export class MenuScreen {
  private readonly el: HTMLElement;
  private color: number;
  private busy = false;
  private saveTurnForm: () => void = () => {};

  constructor(
    root: HTMLElement,
    init: MenuInit,
    private readonly h: MenuHandlers,
    netAvailable: boolean,
  ) {
    this.color = init.color;
    this.el = document.createElement('div');
    this.el.className = 'on-screen on-menu';
    this.el.innerHTML = `
<div class="on-panel on-menu-panel" role="dialog" aria-label="Çevrimiçi">
  <header><h2>Çevrimiçi</h2><button type="button" class="on-x" id="m-close" aria-label="Kapat">×</button></header>
  <div class="on-profile">
    <label>Ad <input id="m-name" maxlength="16" value="${esc(init.name)}" autocomplete="off" /></label>
    <div class="on-colors" id="m-colors" role="radiogroup" aria-label="Renk"></div>
  </div>
  <div class="on-error" id="m-error" role="alert" hidden></div>
  <div class="on-status" id="m-status" aria-live="polite" hidden></div>
  ${init.last ? `<div class="on-rejoin"><span>Son lobi: <b>${esc(init.last)}</b></span> <button type="button" class="primary" id="m-rejoin">Yeniden bağlan</button></div>` : ''}
  <details class="on-adv"><summary>Gelişmiş: TURN sunucusu (farklı ağlarda bağlanamıyorsan)</summary>
    <p class="note">Farklı ağlardaki iki cihaz doğrudan bağlanamazsa bir TURN rölesi gerekir (ücretsiz katmanı olan Metered, Cloudflare vb.). Host’ta ayarlamak çoğu zaman yeter.</p>
    <label>Adres(ler) <input id="m-turn-url" placeholder="turn:sunucu:3478, turns:sunucu:443?transport=tcp" autocomplete="off" /></label>
    <label>Kullanıcı <input id="m-turn-user" autocomplete="off" /></label>
    <label>Parola <input id="m-turn-cred" type="password" autocomplete="off" /></label>
  </details>
  <div class="on-cards">
    <section class="on-card">
      <h3>Lobi kur</h3>
      <p class="note">Sen host olursun: ayarları sen belirler, arkadaşların kodla katılır.</p>
      <div class="seg" id="m-tp" role="group" aria-label="Bağlantı"></div>
      <p class="note" id="m-tp-note"></p>
      <button type="button" class="primary wide" id="m-host">Lobi kur</button>
    </section>
    <section class="on-card">
      <h3>Kodla katıl</h3>
      <label>Kod <input id="m-code" maxlength="8" value="${esc((init.code ?? '').toUpperCase())}" placeholder="K7Q2XM" autocomplete="off" /></label>
      <label>Parola <input id="m-pass" type="password" placeholder="(varsa)" autocomplete="off" /></label>
      <button type="button" class="primary wide" id="m-join">Katıl</button>
    </section>
    <section class="on-card">
      <h3>Seyret</h3>
      <p class="note">Oyuncu olmadan izle (savaş sırasında da girebilirsin).</p>
      <label>Kod <input id="m-scode" maxlength="8" placeholder="K7Q2XM" autocomplete="off" /></label>
      <button type="button" class="wide" id="m-spec">İzle</button>
    </section>
  </div>
</div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(s: string): T => this.el.querySelector(s) as T;
    const turn = loadTurn();
    if (turn) {
      q<HTMLInputElement>('#m-turn-url').value = turn.urls;
      q<HTMLInputElement>('#m-turn-user').value = turn.username;
      q<HTMLInputElement>('#m-turn-cred').value = turn.credential;
      (this.el.querySelector('.on-adv') as HTMLDetailsElement).open = true;
    }
    const saveTurnForm = (): void =>
      saveTurn({ urls: q<HTMLInputElement>('#m-turn-url').value, username: q<HTMLInputElement>('#m-turn-user').value, credential: q<HTMLInputElement>('#m-turn-cred').value });
    this.saveTurnForm = saveTurnForm;
    this.paintColors();
    let tp: 'lan' | 'net' = netAvailable ? 'net' : 'lan';
    const paintTp = (): void => {
      q('#m-tp').innerHTML = [
        { id: 'net', label: 'İnternet', off: !netAvailable },
        { id: 'lan', label: 'LAN', off: false },
      ]
        .map((o) => `<button type="button" data-tp="${o.id}" aria-pressed="${tp === o.id}"${o.off ? ' disabled' : ''}>${o.label}${o.off ? ' (yakında)' : ''}</button>`)
        .join('');
      q('#m-tp-note').textContent = tp === 'lan' ? 'Sunucu: sayfayı açtığın bilgisayar (LAN için oyunu "--lan" ile başlat; arkadaşların onun adresini açar).' : 'Doğrudan bağlantı (WebRTC): kod ve bağlantı paylaşılır.';
      q('#m-tp').querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          tp = (b as HTMLElement).dataset.tp as 'lan' | 'net';
          paintTp();
        }),
      );
    };
    paintTp();
    const prof = (): { name: string; color: number } => ({ name: q<HTMLInputElement>('#m-name').value.trim() || 'Oyuncu', color: this.color });
    q('#m-close').addEventListener('click', () => this.h.onClose());
    this.el.querySelector('#m-rejoin')?.addEventListener('click', () => {
      if (!this.busy) this.h.onRejoin?.();
    });
    q('#m-host').addEventListener('click', () => {
      if (this.busy) return;
      this.saveTurnForm();
      const p = prof();
      this.h.onHost(p.name, p.color, tp);
    });
    q('#m-join').addEventListener('click', () => {
      if (this.busy) return;
      const code = q<HTMLInputElement>('#m-code').value.trim().toUpperCase();
      if (!code) return this.setError('Lobi kodunu yaz.');
      this.saveTurnForm();
      const p = prof();
      this.h.onJoin(p.name, p.color, code, q<HTMLInputElement>('#m-pass').value, false);
    });
    q('#m-spec').addEventListener('click', () => {
      if (this.busy) return;
      const code = q<HTMLInputElement>('#m-scode').value.trim().toUpperCase();
      if (!code) return this.setError('Lobi kodunu yaz.');
      this.saveTurnForm();
      const p = prof();
      this.h.onJoin(p.name, p.color, code, '', true);
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.h.onClose();
    });
  }

  private paintColors(): void {
    const box = this.el.querySelector('#m-colors') as HTMLElement;
    box.innerHTML = COLORS.map((c, i) => `<button type="button" class="on-sw${i === this.color ? ' sel' : ''}" data-c="${i}" style="background:${hex(c)}" role="radio" aria-checked="${i === this.color}" aria-label="Renk ${i + 1}"></button>`).join('');
    box.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        this.color = Number((b as HTMLElement).dataset.c);
        this.paintColors();
      }),
    );
  }

  setBusy(on: boolean): void {
    this.busy = on;
    this.el.classList.toggle('busy', on);
  }

  setStatus(msg: string): void {
    const e = this.el.querySelector('#m-status') as HTMLElement;
    e.textContent = msg;
    e.hidden = !msg;
  }

  setError(msg: string): void {
    this.setStatus('');
    const e = this.el.querySelector('#m-error') as HTMLElement;
    e.textContent = msg;
    e.hidden = !msg;
  }

  destroy(): void {
    this.el.remove();
  }
}

const GOLDS = [500, 1000, 2000, 5000, 10000];
const TIMES: Array<[number, string]> = [
  [60, '60 sn'],
  [120, '2 dk'],
  [300, '5 dk'],
  [0, 'Sınırsız'],
];
const SIZES: Array<[number, string]> = [
  [0, 'Otomatik'],
  [40, 'Küçük (40)'],
  [56, 'Orta (56)'],
  [80, 'Büyük (80)'],
  [100, 'Çok büyük (100)'],
  [120, 'Dev (120)'],
];

export interface LobbyEnv {
  onLeave(): void;
  /** Baglanti tipine gore paylasilacak link (kod dahil). */
  link(code: string): string;
}

/** Lobi: solda host ayarlari, sagda oyuncular + sohbet. */
export class LobbyScreen {
  private readonly el: HTMLElement;
  private readonly picker: MapPicker;
  private readonly mapState: AppState;
  private lastSettings = '';
  private lastPlayers = '';
  private chatCount = 0;

  constructor(
    root: HTMLElement,
    private readonly session: Session,
    private readonly env: LobbyEnv,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'on-screen on-lobby';
    this.el.innerHTML = `
<div class="on-lobby-grid">
  <aside class="on-panel on-settings" id="l-settings" aria-label="Ayarlar">
    <h2>Ayarlar <small id="l-host-note"></small></h2>
    <div class="on-field"><span>Harita</span>
      <div class="on-map"><canvas id="l-prev" width="160" height="82"></canvas><div class="on-map-info"><b id="l-map-name"></b><div class="on-btnrow"><button type="button" id="l-map-pick">Seç…</button><button type="button" id="l-map-rand">Rastgele</button></div></div></div>
    </div>
    <div class="on-field"><span>Başlangıç gold</span><div class="seg" id="l-gold"></div><input id="l-gold-n" type="number" min="100" max="100000" step="100" aria-label="Özel gold" /></div>
    <div class="on-field"><span>Yerleştirme süresi</span><select id="l-time"></select></div>
    <div class="on-field"><span>Birim seviyesi</span><select id="l-level"></select></div>
    <div class="on-field"><span>Harita boyutu</span><select id="l-size"></select></div>
    <label class="row"><span>Açık yerleştirme <small>herkes herkesin askerini anlık görür</small></span><input type="checkbox" id="l-open" role="switch" /></label>
    <label class="row"><span>Komedi fiziği <small>vuruşlar uçurur, suya düşen ölür</small></span><input type="checkbox" id="l-cp" role="switch" /></label>
    <label class="row"><span>Komedi görünümü</span><input type="checkbox" id="l-cv" role="switch" /></label>
    <div class="on-field"><span>Kapalı nadirlikler</span><div class="on-bans" id="l-bans"></div></div>
    <button type="button" class="primary wide" id="l-start">Oyunu başlat</button>
    <p class="note" id="l-start-note"></p>
  </aside>
  <section class="on-panel on-players" aria-label="Oyuncular ve sohbet">
    <header class="on-lhead">
      <div><span class="on-code-l">LOBİ KODU</span> <b class="on-code" id="l-code"></b></div>
      <div class="on-btnrow"><button type="button" id="l-link">Linki kopyala</button><span id="l-pass-wrap"><input id="l-pass" type="text" placeholder="Parola" maxlength="24" /><button type="button" id="l-pass-set">Ayarla</button></span><button type="button" id="l-leave">Ayrıl</button></div>
    </header>
    <h3 id="l-ptitle">Oyuncular</h3>
    <ul class="on-plist" id="l-players"></ul>
    <div class="on-chat"><div class="on-log" id="l-log" aria-live="polite"></div>
      <form class="on-chat-in" id="l-chatform"><input id="l-chat" maxlength="200" placeholder="Mesaj yaz…" autocomplete="off" /><button type="submit">Gönder</button></form>
    </div>
    <div class="on-ready-row"><button type="button" class="primary" id="l-ready">Hazırım</button></div>
  </section>
</div>`;
    root.appendChild(this.el);
    // Harita secici icin gecici durum (localStorage'a yazilmaz).
    this.mapState = { ...defaultState(), ephemeral: true, map: { ...DEFAULT_MAP }, mapPreset: 'custom' };
    this.picker = new MapPicker(
      this.mapState,
      () => {
        const ms = this.mapState;
        if (ms.mapPreset === 'random') this.session.send({ t: 'settings', settings: { mapMode: 'random' } });
        else this.session.send({ t: 'settings', settings: { mapMode: 'fixed', map: ms.map, mapSeed: ms.seed } });
      },
      false,
    );
    this.build();
    this.update();
  }

  private q<T extends HTMLElement>(s: string): T {
    return this.el.querySelector(s) as T;
  }

  private get host(): boolean {
    return this.session.model.isHost;
  }

  private build(): void {
    const q = this.q.bind(this);
    q('#l-gold').innerHTML = GOLDS.map((g) => `<button type="button" data-g="${g}">${g}</button>`).join('');
    q('#l-gold').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => this.patch({ gold: Number((b as HTMLElement).dataset.g) })),
    );
    q<HTMLInputElement>('#l-gold-n').addEventListener('change', (e) => this.patch({ gold: Number((e.target as HTMLInputElement).value) }));
    q<HTMLSelectElement>('#l-time').innerHTML = TIMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    q<HTMLSelectElement>('#l-time').addEventListener('change', (e) => this.patch({ placeSecs: Number((e.target as HTMLSelectElement).value) }));
    q<HTMLSelectElement>('#l-level').innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    q<HTMLSelectElement>('#l-level').addEventListener('change', (e) => this.patch({ level: Number((e.target as HTMLSelectElement).value) }));
    q<HTMLSelectElement>('#l-size').innerHTML = SIZES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    q<HTMLSelectElement>('#l-size').addEventListener('change', (e) => this.patch({ mapSize: Number((e.target as HTMLSelectElement).value) }));
    q<HTMLInputElement>('#l-open').addEventListener('change', (e) => this.patch({ openPlacement: (e.target as HTMLInputElement).checked }));
    q<HTMLInputElement>('#l-cp').addEventListener('change', (e) => this.patch({ comedyPhysics: (e.target as HTMLInputElement).checked }));
    q<HTMLInputElement>('#l-cv').addEventListener('change', (e) => this.patch({ comedyVisual: (e.target as HTMLInputElement).checked }));
    const rar: Array<[Rarity, string]> = [
      ['legendary', 'Efsanevi'],
      ['epic', 'Destansı'],
      ['rare', 'Nadir'],
    ];
    q('#l-bans').innerHTML = rar.map(([r, l]) => `<label><input type="checkbox" data-r="${r}" /> ${l} yok</label>`).join('');
    q('#l-bans').querySelectorAll('input').forEach((i) =>
      i.addEventListener('change', () => {
        const banned = [...q('#l-bans').querySelectorAll('input')].filter((x) => (x as HTMLInputElement).checked).map((x) => (x as HTMLElement).dataset.r as Rarity);
        this.patch({ banned });
      }),
    );
    q('#l-map-pick').addEventListener('click', () => {
      const s = this.session.model.state!.settings;
      this.mapState.map = { ...s.map };
      this.mapState.seed = s.mapSeed;
      this.mapState.mapPreset = s.mapMode === 'random' ? 'random' : 'custom';
      this.mapState.mapSize = s.mapSize || 56;
      this.picker.open();
    });
    q('#l-map-rand').addEventListener('click', () => this.patch({ mapMode: 'random' }));
    q('#l-start').addEventListener('click', () => this.session.send({ t: 'start' }));
    q('#l-leave').addEventListener('click', () => this.env.onLeave());
    q('#l-link').addEventListener('click', () => {
      const st = this.session.model.state!;
      void navigator.clipboard?.writeText(this.env.link(st.code)).catch(() => {});
      q('#l-link').textContent = 'Kopyalandı!';
      setTimeout(() => (q('#l-link').textContent = 'Linki kopyala'), 1500);
    });
    q('#l-pass-set').addEventListener('click', () => {
      const v = q<HTMLInputElement>('#l-pass').value.trim();
      this.session.send({ t: 'settings', settings: {}, password: v || null });
      q('#l-pass-set').textContent = v ? 'Kilitli' : 'Açık';
      setTimeout(() => (q('#l-pass-set').textContent = 'Ayarla'), 1500);
    });
    q('#l-ready').addEventListener('click', () => {
      const me = this.session.model.me;
      if (me) this.session.send({ t: 'ready', ready: !me.ready });
    });
    q<HTMLFormElement>('#l-chatform').addEventListener('submit', (e) => {
      e.preventDefault();
      const i = q<HTMLInputElement>('#l-chat');
      if (i.value.trim()) this.session.send({ t: 'chat', text: i.value });
      i.value = '';
    });
    // Imlecin yaninda "(Lobi ayarlari)" yazsin.
    const sp = q('#l-settings');
    sp.addEventListener('pointerenter', () => {
      act.text = 'Lobi ayarları';
    });
    sp.addEventListener('pointerleave', () => {
      if (act.text === 'Lobi ayarları') act.text = undefined;
    });
  }

  private patch(p: Record<string, unknown>): void {
    if (!this.host) return;
    this.session.send({ t: 'settings', settings: p });
  }

  /** Durum degisince cagrilir. */
  update(): void {
    const m = this.session.model;
    const st = m.state;
    if (!st) return;
    const q = this.q.bind(this);
    const host = this.host;
    q('#l-code').textContent = st.code;
    q('#l-host-note').textContent = host ? '(host)' : '(yalnız host değiştirir)';
    q('#l-pass-wrap').hidden = !host;
    const s = st.settings;
    const key = JSON.stringify([s, host, st.locked]);
    if (key !== this.lastSettings) {
      this.lastSettings = key;
      q('#l-gold').querySelectorAll('button').forEach((b) => {
        (b as HTMLButtonElement).disabled = !host;
        b.setAttribute('aria-pressed', String(Number((b as HTMLElement).dataset.g) === s.gold));
      });
      const gn = q<HTMLInputElement>('#l-gold-n');
      if (document.activeElement !== gn) gn.value = String(s.gold);
      gn.disabled = !host;
      const set = (id: string, v: string, dis = !host): void => {
        const el = q<HTMLSelectElement>(id);
        el.value = v;
        el.disabled = dis;
      };
      set('#l-time', String(s.placeSecs));
      set('#l-level', String(s.level));
      set('#l-size', String(s.mapSize));
      for (const [id, v] of [['#l-open', s.openPlacement], ['#l-cp', s.comedyPhysics], ['#l-cv', s.comedyVisual]] as const) {
        const el = q<HTMLInputElement>(id);
        el.checked = v;
        el.disabled = !host;
      }
      q('#l-bans').querySelectorAll('input').forEach((i) => {
        (i as HTMLInputElement).checked = s.banned.includes((i as HTMLElement).dataset.r as Rarity);
        (i as HTMLInputElement).disabled = !host;
      });
      (q('#l-map-pick') as HTMLButtonElement).disabled = !host;
      (q('#l-map-rand') as HTMLButtonElement).disabled = !host;
      this.paintMap(s.mapMode, s.map, s.mapSeed, s.mapSize);
    }
    const startBtn = q<HTMLButtonElement>('#l-start');
    startBtn.hidden = !host;
    const pl = st.players.filter((p) => p.role === 'player');
    const can = pl.length >= 2 && pl.every((p) => p.id === st.hostId || (p.ready && p.connected));
    startBtn.disabled = !can;
    q('#l-start-note').textContent = !host ? '' : pl.length < 2 ? 'En az 2 oyuncu gerekli.' : can ? `${pl.length} oyuncu, ${pl.length} takım.` : 'Herkes hazır olmalı.';
    const ready = q<HTMLButtonElement>('#l-ready');
    const me = m.me;
    ready.hidden = host || !me || me.role !== 'player';
    ready.textContent = me?.ready ? 'Hazır değilim' : 'Hazırım';
    ready.classList.toggle('on', !!me?.ready);

    const pkey = JSON.stringify(st.players);
    if (pkey !== this.lastPlayers) {
      this.lastPlayers = pkey;
      this.paintPlayers(st.players);
    }
    this.paintChat();
  }

  private paintMap(mode: 'random' | 'fixed', spec: MapSpec, seed: number, size: number): void {
    const c = this.q<HTMLCanvasElement>('#l-prev');
    const ctx = c.getContext('2d');
    if (mode === 'random') {
      ctx?.clearRect(0, 0, c.width, c.height);
      if (ctx) {
        ctx.fillStyle = '#0f1622';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#7aa7ff';
        ctx.font = 'bold 40px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('?', c.width / 2, c.height / 2 + 14);
      }
      this.q('#l-map-name').textContent = 'Rastgele (her tur farklı)';
      return;
    }
    const tmp = document.createElement('canvas');
    drawMinimap(tmp, spec, seed, size || 56);
    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#0f1622';
      ctx.fillRect(0, 0, c.width, c.height);
      const k = Math.min(c.width / tmp.width, c.height / tmp.height);
      ctx.drawImage(tmp, (c.width - tmp.width * k) / 2, (c.height - tmp.height * k) / 2, tmp.width * k, tmp.height * k);
    }
    this.q('#l-map-name').textContent = `${spec.biome} · ${spec.layout} (tohum ${seed})`;
  }

  private paintPlayers(players: PlayerInfo[]): void {
    const m = this.session.model;
    const host = this.host;
    const taken = new Set(players.filter((p) => p.role === 'player').map((p) => p.color));
    const ul = this.q('#l-players');
    const row = (p: PlayerInfo): string => {
      const mine = p.id === m.you;
      const isHost = p.id === m.state!.hostId;
      const col = hex(playerColor(p.color));
      const swatches =
        mine && p.role === 'player'
          ? `<span class="on-pick">${COLORS.map((c, i) => `<button type="button" class="on-sw sm${i === p.color ? ' sel' : ''}" data-c="${i}" style="background:${hex(c)}" ${taken.has(i) && i !== p.color ? 'disabled' : ''} aria-label="Renk ${i + 1}"></button>`).join('')}</span>`
          : '';
      const tags = [isHost ? '<span class="on-tag host">HOST</span>' : '', p.muted ? '<span class="on-tag">susturuldu</span>' : '', !p.connected ? '<span class="on-tag warn">koptu</span>' : '', p.role === 'spectator' ? '<span class="on-tag">seyirci</span>' : ''].join('');
      const rd = p.role === 'player' && !isHost ? `<span class="on-rd${p.ready ? ' ok' : ''}">${p.ready ? 'HAZIR' : 'bekliyor'}</span>` : '';
      const tools = host && !isHost ? `<button type="button" class="mini" data-mute="${p.id}">${p.muted ? 'Sesi aç' : 'Sustur'}</button><button type="button" class="mini danger" data-kick="${p.id}">At</button>` : '';
      return `<li class="on-prow${mine ? ' me' : ''}"><i class="dot" style="background:${col}"></i><span class="on-pname">${mine ? `<input class="on-nameinp" value="${esc(p.name)}" maxlength="16" aria-label="Adın" />` : esc(p.name)}</span>${tags}${swatches}${rd}${tools}</li>`;
    };
    const pl = players.filter((p) => p.role === 'player');
    const sp = players.filter((p) => p.role === 'spectator');
    ul.innerHTML = pl.map(row).join('') + (sp.length ? `<li class="on-sep">Seyirciler</li>${sp.map(row).join('')}` : '');
    this.q('#l-ptitle').textContent = `Oyuncular ${pl.length}/6`;
    ul.querySelectorAll('[data-c]').forEach((b) =>
      b.addEventListener('click', () => {
        const me = m.me;
        if (me) this.session.send({ t: 'profile', name: me.name, color: Number((b as HTMLElement).dataset.c) });
      }),
    );
    ul.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', () => this.session.send({ t: 'kick', id: (b as HTMLElement).dataset.kick! })));
    ul.querySelectorAll('[data-mute]').forEach((b) => {
      const id = (b as HTMLElement).dataset.mute!;
      b.addEventListener('click', () => this.session.send({ t: 'mute', id, on: !players.find((p) => p.id === id)?.muted }));
    });
    const inp = ul.querySelector('.on-nameinp') as HTMLInputElement | null;
    inp?.addEventListener('change', () => {
      const me = m.me;
      if (me) this.session.send({ t: 'profile', name: inp.value, color: me.color });
    });
  }

  private paintChat(): void {
    const m = this.session.model;
    const log = this.q('#l-log');
    while (this.chatCount < m.chat.length) {
      const c = m.chat[this.chatCount++];
      const p = m.state?.players.find((x) => x.id === c.id);
      const d = document.createElement('div');
      d.className = 'on-line';
      d.innerHTML = `<b style="color:${hex(playerColor(p?.color ?? 0))}">${esc(c.name)}</b> ${esc(c.text)}`;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }
  }

  destroy(): void {
    this.el.remove();
  }
}

