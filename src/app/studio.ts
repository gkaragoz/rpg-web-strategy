import { KIND_COUNT, MAX_TEAMS, STATS } from '../sim/units';
import type { Editor } from './editor';
import { UnitSettings } from './unitSettings';
import { BRUSHES, MAP_SIZES, MAX_PLACED, PALETTES, hex, saveState, teamColors, type AppState } from './state';

export interface StudioDeps {
  state: AppState;
  editor: Editor;
  /** Tohum / cevre / harita boyutu degisti. */
  onMapChange: () => void;
  /** Takim sayisi veya palet degisti (atlas yeniden pisirilir, sprite'lar yenilenir). */
  onPaletteChange: () => void;
  onStart: () => void;
  onBench: (perTeam: number) => void;
}

const KIND_KEYS = ['1', '2', '3', '4', '5'];
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Ana sayfa: tek sayfa stüdyo (ayarlar + takimlar + yerlestirme dock'u). */
export class Studio {
  private readonly root: HTMLElement;
  private readonly $: (sel: string) => HTMLElement;
  private visible = false;
  private readonly units: UnitSettings;

  constructor(
    root: HTMLElement,
    private readonly d: StudioDeps,
  ) {
    this.root = root;
    this.units = new UnitSettings(d.state, () => this.render());
    root.innerHTML = this.template();
    this.$ = (sel) => root.querySelector(sel) as HTMLElement;
    this.bind();
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
  }

  toast(msg: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    this.$('#toasts').appendChild(el);
    window.setTimeout(() => el.classList.add('out'), 2600);
    window.setTimeout(() => el.remove(), 3200);
  }

  private template(): string {
    return `
<aside class="panel left" id="panel-left" aria-label="Ayarlar">
  <header><h1>Savaş Stüdyosu</h1><p>Ordunu kur, haritayı seç, savaşı izle.</p></header>
  <section>
    <h2>Harita</h2>
    <label class="row"><span>Çevre <small>nehir, orman, köy</small></span><input type="checkbox" id="env" role="switch" /></label>
    <div class="row"><span>Tohum</span><span class="inline"><input id="seed" type="number" min="1" max="999999" inputmode="numeric" aria-label="Harita tohumu" /><button id="dice" type="button" title="Rastgele tohum" aria-label="Rastgele tohum">Rastgele</button></span></div>
    <div class="row"><span>Boyut</span><div class="seg" id="mapsize" role="group" aria-label="Harita boyutu"></div></div>
  </section>
  <section>
    <h2>Savaş</h2>
    <label class="row"><span>Vur-kaç <small>okçu, rahip kaçar</small></span><input type="checkbox" id="kite" role="switch" /></label>
    <div class="row"><span>Hız</span><div class="seg" id="speed" role="group" aria-label="Savaş hızı"></div></div>
  </section>
  <section>
    <h2>Birimler</h2>
    <button id="units-btn" type="button" class="wide">Birim ayarları…</button>
    <p class="note" id="units-note">Can, hız, güç, menzil, zırh ve itmeyi ayarla.</p>
  </section>
  <section>
    <h2>Benchmark</h2>
    <div class="row"><span>Takım başına</span><div class="seg" id="benchsel" role="group" aria-label="Benchmark asker sayısı"></div></div>
    <button id="bench" type="button" class="wide">Benchmark çalıştır</button>
    <p class="note">Takım başına 10k = toplam 20.000 asker, yerleştirme yok.</p>
  </section>
</aside>

<aside class="panel right" id="panel-right" aria-label="Takımlar">
  <section>
    <h2>Takımlar</h2>
    <div class="row"><span>Takım sayısı</span><span class="stepper"><button id="tm-minus" type="button" aria-label="Takım azalt">−</button><b id="tm-count">2</b><button id="tm-plus" type="button" aria-label="Takım artır">+</button></span></div>
    <h3>Renk teması</h3>
    <div id="palettes" role="radiogroup" aria-label="Renk teması"></div>
  </section>
  <section>
    <h2>Askerler</h2>
    <div id="teamrows"></div>
    <button id="quick" type="button" class="wide">Hızlı dizilim kur</button>
  </section>
</aside>

<div class="dock" role="toolbar" aria-label="Yerleştirme araçları">
  <div class="dock-note" id="reason" role="status"></div>
  <div class="dock-group" id="chips" role="radiogroup" aria-label="Takım"></div>
  <div class="dock-group" id="kinds" role="radiogroup" aria-label="Asker türü"></div>
  <div class="dock-group"><div class="seg" id="brush" role="group" aria-label="Fırça boyutu"></div><div class="seg" id="tool" role="group" aria-label="Araç"></div></div>
  <div class="dock-group">
    <button id="undo" type="button" title="Geri al (Ctrl+Z)">Geri al</button>
    <button id="redo" type="button" title="Yinele (Ctrl+Y)">Yinele</button>
    <button id="fill" type="button" title="Seçili takım için blok dizilim ekle">Formasyon doldur</button>
    <button id="clear" type="button" title="Tüm askerleri sil">Temizle</button>
  </div>
  <div class="dock-group end">
    <span id="total" class="total">0 / ${MAX_PLACED}</span>
    <button id="tgl-left" type="button" class="only-narrow">Ayarlar</button>
    <button id="tgl-right" type="button" class="only-narrow">Takımlar</button>
    <button id="start" type="button" class="primary">Savaşı başlat</button>
  </div>
  <div class="dock-hint" id="hint">Sol tık: yerleştir · Sağ tık: sil · Shift+sağ tık: yalnız seçili takım · Tekerlek: yakınlaş · WASD / orta tuş: kaydır · Q/E: takım · 1-5: tür · Z/Y: geri al/yinele</div>
</div>
<div id="toasts" class="toasts" aria-live="polite"></div>`;
  }

  private seg(el: HTMLElement, items: Array<{ id: string | number; label: string }>, selected: string | number, onPick: (id: string) => void): void {
    el.innerHTML = items
      .map((it) => `<button type="button" data-id="${it.id}" aria-pressed="${String(it.id) === String(selected)}">${esc(it.label)}</button>`)
      .join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onPick((b as HTMLElement).dataset.id!)));
  }

  private bind(): void {
    const s = this.d.state;
    const $in = (id: string) => this.$(id) as HTMLInputElement;

    $in('#env').addEventListener('change', (e) => {
      s.env = (e.target as HTMLInputElement).checked;
      this.changed(true);
    });
    $in('#kite').addEventListener('change', (e) => {
      s.kite = (e.target as HTMLInputElement).checked;
      this.changed(false);
    });
    $in('#seed').addEventListener('change', (e) => {
      const v = Math.floor(Number((e.target as HTMLInputElement).value));
      s.seed = Number.isFinite(v) ? Math.min(999999, Math.max(1, v)) : s.seed;
      this.changed(true);
    });
    this.$('#dice').addEventListener('click', () => {
      s.seed = 1 + Math.floor(Math.random() * 999999);
      this.changed(true);
    });
    this.$('#tm-minus').addEventListener('click', () => this.setTeamCount(s.teamCount - 1));
    this.$('#tm-plus').addEventListener('click', () => this.setTeamCount(s.teamCount + 1));
    this.$('#quick').addEventListener('click', () => {
      const n = this.d.editor.quickFormation();
      this.toast(n > 0 ? `${n} asker dizildi.` : 'Dizilim için uygun yer bulunamadı.');
      this.render();
    });
    this.$('#undo').addEventListener('click', () => {
      this.d.editor.undo();
      this.render();
    });
    this.$('#redo').addEventListener('click', () => {
      this.d.editor.redo();
      this.render();
    });
    this.$('#fill').addEventListener('click', () => {
      const n = this.d.editor.fillFormation(s.selTeam);
      this.toast(n > 0 ? `Takım ${s.selTeam + 1}: ${n} asker eklendi.` : 'Uygun yer bulunamadı.');
      this.render();
    });
    this.$('#clear').addEventListener('click', () => {
      if (s.units.length === 0) return;
      if (!window.confirm(`${s.units.length} askerin hepsi silinsin mi? (Geri al ile döndürebilirsin)`)) return;
      this.d.editor.clear();
      this.render();
    });
    this.$('#bench').addEventListener('click', () => this.d.onBench(s.benchPerTeam));
    this.$('#units-btn').addEventListener('click', () => this.units.open());
    this.$('#start').addEventListener('click', () => {
      if (!this.canStart().ok) return;
      this.d.onStart();
    });
    this.$('#tgl-left').addEventListener('click', () => this.$('#panel-left').classList.toggle('open'));
    this.$('#tgl-right').addEventListener('click', () => this.$('#panel-right').classList.toggle('open'));
  }

  private setTeamCount(n: number): void {
    const s = this.d.state;
    const next = Math.min(MAX_TEAMS, Math.max(2, n));
    if (next === s.teamCount) return;
    if (next < s.teamCount) {
      const lost = s.units.filter((u) => u.team >= next).length;
      if (lost > 0 && !window.confirm(`Takım ${next + 1}-${s.teamCount} kaldırılacak, ${lost} asker silinecek. Devam edilsin mi?`)) return;
      this.d.editor.dropTeamsAbove(next);
    }
    s.teamCount = next;
    s.selTeam = Math.min(s.selTeam, next - 1);
    saveState(s);
    this.d.onPaletteChange();
    this.render();
  }

  private changed(map: boolean): void {
    saveState(this.d.state);
    if (map) this.d.onMapChange();
    this.render();
  }

  private canStart(): { ok: boolean; reason: string } {
    const s = this.d.state;
    const withUnits = new Set(s.units.map((u) => u.team)).size;
    if (s.units.length === 0) return { ok: false, reason: 'Haritaya asker yerleştir ya da "Hızlı dizilim kur" de.' };
    if (withUnits < 2) return { ok: false, reason: 'Savaş için en az 2 takımda asker olmalı.' };
    return { ok: true, reason: '' };
  }

  /** Durumdan tum arayuzu yeniden cizer (hafif, sik cagrilabilir). */
  render(): void {
    if (!this.visible) return;
    const s = this.d.state;
    const colors = teamColors(s.palette, s.teamCount);
    const counts = this.d.editor.counts();
    const $in = (id: string) => this.$(id) as HTMLInputElement;

    $in('#env').checked = s.env;
    $in('#kite').checked = s.kite;
    if (document.activeElement !== $in('#seed')) $in('#seed').value = String(s.seed);

    this.seg(this.$('#mapsize'), MAP_SIZES.map((m) => ({ id: m.id, label: m.name })), s.mapSize, (id) => {
      s.mapSize = Number(id);
      this.changed(true);
    });
    this.seg(this.$('#speed'), [1, 2, 4].map((v) => ({ id: v, label: `${v}×` })), s.speed, (id) => {
      s.speed = Number(id);
      this.changed(false);
    });
    this.seg(this.$('#benchsel'), [1000, 3000, 10000].map((v) => ({ id: v, label: `${v / 1000}k` })), s.benchPerTeam, (id) => {
      s.benchPerTeam = Number(id);
      this.changed(false);
    });
    this.$('#tm-count').textContent = String(s.teamCount);
    const changed = this.units.changedCount();
    this.$('#units-note').textContent = changed > 0 ? `${changed} değer varsayılandan farklı.` : 'Can, hız, güç, menzil, zırh ve itmeyi ayarla.';

    // Palet setleri
    this.$('#palettes').innerHTML = PALETTES.map((p) => {
      const sel = p.id === s.palette;
      return `<button type="button" class="palette${sel ? ' sel' : ''}" role="radio" aria-checked="${sel}" data-id="${p.id}"><span class="pname">${esc(p.name)}</span><span class="swatches">${p.colors
        .slice(0, Math.max(s.teamCount, 4))
        .map((c) => `<i style="background:${hex(c)}"></i>`)
        .join('')}</span></button>`;
    }).join('');
    this.$('#palettes').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        s.palette = (b as HTMLElement).dataset.id!;
        saveState(s);
        this.d.onPaletteChange();
        this.render();
      }),
    );

    // Takim satirlari
    this.$('#teamrows').innerHTML = colors
      .map((c, t) => {
        const total = counts[t].reduce((a, b) => a + b, 0);
        const detail = counts[t].map((n, k) => (n > 0 ? `${STATS[k].name} ${n}` : '')).filter(Boolean).join(' · ');
        return `<div class="trow${t === s.selTeam ? ' sel' : ''}" data-team="${t}"><i class="dot" style="background:${hex(c.main)}"></i><span class="tname">Takım ${t + 1} <b>${total}</b></span><small>${esc(detail || 'boş')}</small><button type="button" data-clear="${t}" ${total === 0 ? 'disabled' : ''} title="Takım ${t + 1} askerlerini sil">Temizle</button></div>`;
      })
      .join('');
    this.$('#teamrows').querySelectorAll('.trow').forEach((row) =>
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).dataset.clear !== undefined) return;
        s.selTeam = Number((row as HTMLElement).dataset.team);
        this.render();
      }),
    );
    this.$('#teamrows').querySelectorAll('button[data-clear]').forEach((b) =>
      b.addEventListener('click', () => {
        this.d.editor.clear(Number((b as HTMLElement).dataset.clear));
        this.render();
      }),
    );

    // Dock
    this.$('#chips').innerHTML = colors
      .map((c, t) => {
        const total = counts[t].reduce((a, b) => a + b, 0);
        return `<button type="button" class="chip${t === s.selTeam ? ' sel' : ''}" role="radio" aria-checked="${t === s.selTeam}" data-team="${t}" title="Takım ${t + 1} (Q/E ile değiştir)"><i class="dot" style="background:${hex(c.main)}"></i>${t + 1}<small>${total}</small></button>`;
      })
      .join('');
    this.$('#chips').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        s.selTeam = Number((b as HTMLElement).dataset.team);
        this.render();
      }),
    );
    this.$('#kinds').innerHTML = Array.from({ length: KIND_COUNT }, (_, k) => {
      const sel = k === s.selKind;
      return `<button type="button" class="kind${sel ? ' sel' : ''}" role="radio" aria-checked="${sel}" data-kind="${k}" title="${esc(STATS[k].name)} (${KIND_KEYS[k]})"><kbd>${KIND_KEYS[k]}</kbd>${esc(STATS[k].name)}</button>`;
    }).join('');
    this.$('#kinds').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        s.selKind = Number((b as HTMLElement).dataset.kind);
        s.tool = 'place';
        this.render();
      }),
    );
    this.seg(this.$('#brush'), BRUSHES.map((b) => ({ id: b.id, label: `${b.name}` })), s.brush, (id) => {
      s.brush = Number(id);
      this.changed(false);
    });
    this.seg(this.$('#tool'), [{ id: 'place', label: 'Yerleştir' }, { id: 'erase', label: 'Sil' }], s.tool, (id) => {
      s.tool = id as 'place' | 'erase';
      this.render();
    });

    ($in('#undo') as unknown as HTMLButtonElement).disabled = !this.d.editor.canUndo;
    ($in('#redo') as unknown as HTMLButtonElement).disabled = !this.d.editor.canRedo;
    ($in('#clear') as unknown as HTMLButtonElement).disabled = s.units.length === 0;
    this.$('#total').textContent = `${s.units.length} / ${MAX_PLACED}`;
    const start = this.canStart();
    const startBtn = this.$('#start') as HTMLButtonElement;
    startBtn.disabled = !start.ok;
    startBtn.title = start.ok ? 'Savaşı başlat' : start.reason;
    this.$('#reason').textContent = start.reason;
    this.$('#reason').hidden = start.ok;
    this.d.editor.drawGhost();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.visible) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const s = this.d.state;
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) this.d.editor.redo();
        else this.d.editor.undo();
        this.render();
      } else if (e.code === 'KeyY') {
        e.preventDefault();
        this.d.editor.redo();
        this.render();
      }
      return;
    }
    if (e.code === 'KeyQ') s.selTeam = (s.selTeam + s.teamCount - 1) % s.teamCount;
    else if (e.code === 'KeyE') s.selTeam = (s.selTeam + 1) % s.teamCount;
    else if (e.code === 'KeyX') s.tool = s.tool === 'place' ? 'erase' : 'place';
    else if (e.code === 'KeyZ') this.d.editor.undo();
    else if (e.code === 'KeyY') this.d.editor.redo();
    else if (e.code === 'KeyB') s.brush = (s.brush + 1) % BRUSHES.length;
    else if (e.code.startsWith('Digit')) {
      const k = Number(e.code.slice(5)) - 1;
      if (k < 0 || k >= KIND_COUNT) return;
      s.selKind = k;
      s.tool = 'place';
    } else return;
    saveState(s);
    this.render();
  }
}
