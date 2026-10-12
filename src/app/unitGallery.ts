import { RACE_NAMES, RARITY_NAMES, TROOP_BY_ID, type Race, type Rarity } from '../sim/data/troops';
import { KIND_COUNT, LEGACY_COUNT, MAX_LEVEL, STATS, isHealer, isMelee } from '../sim/units';
import { saveState, type AppState } from './state';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type RarityFilter = Rarity | 'legacy' | 'all';
type RaceFilter = Race | 'all';

const RARITIES: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
const RACES: Race[] = ['human', 'dark', 'sacred', 'wild'];

export interface GalleryDeps {
  state: AppState;
  /** Birim simgesi (secili takim renginde). */
  icon: (kind: number, team: number) => HTMLCanvasElement;
  /** Seviye degisti: STATS yenilendi, arayuz tazelenmeli. */
  onLevel: () => void;
  /** Birim secildi (atlas gerekiyorsa pisirilir). */
  onPick: (kind: number) => void;
}

/** Birim galerisi: nadirlik/irk filtreli, aramali, simgeli kart listesi + seviye secici. */
export class UnitGallery {
  private readonly dlg: HTMLDialogElement;
  private rarity: RarityFilter = 'all';
  private race: RaceFilter = 'all';
  private query = '';

  constructor(private readonly d: GalleryDeps) {
    this.dlg = document.createElement('dialog');
    this.dlg.className = 'unit-dialog gallery-dialog';
    this.dlg.setAttribute('aria-label', 'Birim galerisi');
    document.body.appendChild(this.dlg);
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
  }

  open(): void {
    this.render();
    if (!this.dlg.open) this.dlg.showModal();
  }

  /** Secili birimin kisa ozeti (dock'taki dugme icin). */
  static summary(kind: number): string {
    return STATS[kind].name;
  }

  private kinds(): number[] {
    const q = this.query.trim().toLocaleLowerCase('tr');
    const out: number[] = [];
    for (let k = 0; k < KIND_COUNT; k++) {
      const t = k >= LEGACY_COUNT ? TROOP_BY_ID[STATS[k].troop ?? ''] : undefined;
      if (t?.summoned) continue; // iskelet yalniz Bone Caller ile gelir
      if (this.rarity === 'legacy') {
        if (k >= LEGACY_COUNT) continue;
      } else if (this.rarity !== 'all') {
        if (!t || t.rarity !== this.rarity) continue;
      }
      if (this.race !== 'all' && (!t || t.race !== this.race)) continue;
      if (q && !STATS[k].name.toLocaleLowerCase('tr').includes(q)) continue;
      out.push(k);
    }
    return out;
  }

  private card(k: number): string {
    const s = STATS[k];
    const t = k >= LEGACY_COUNT ? TROOP_BY_ID[s.troop ?? ''] : undefined;
    const role = isHealer(k) ? 'Şifacı' : isMelee(k) ? 'Yakın' : 'Uzak';
    const meta = t ? `${RARITY_NAMES[t.rarity]} · ${RACE_NAMES[t.race]}` : 'Klasik';
    const stats = `Can ${Math.round(s.hp)} · Güç ${Math.round(s.power)} · Menzil ${s.range.toFixed(1)} · ${role}`;
    const skill = t?.skillText ? `<span class="ug-skill">${esc(t.skillText)}</span>` : '';
    const sel = this.d.state.selKind === k;
    return `<button type="button" class="ug-card r-${t ? t.rarity : 'legacy'}${sel ? ' sel' : ''}" data-kind="${k}" aria-pressed="${sel}">
  <span class="ug-icon" data-icon="${k}"></span>
  <span class="ug-name">${esc(s.name)}</span>
  <span class="ug-meta">${esc(meta)}</span>
  <span class="ug-stats">${esc(stats)}</span>${skill}
</button>`;
  }

  private chip(attr: string, id: string, label: string, active: boolean): string {
    return `<button type="button" ${attr}="${id}" aria-pressed="${active}">${esc(label)}</button>`;
  }

  private render(): void {
    const s = this.d.state;
    const rarityChips = [
      this.chip('data-r', 'all', 'Hepsi', this.rarity === 'all'),
      this.chip('data-r', 'legacy', 'Klasik', this.rarity === 'legacy'),
      ...RARITIES.map((r) => this.chip('data-r', r, RARITY_NAMES[r], this.rarity === r)),
    ].join('');
    const raceChips = [this.chip('data-c', 'all', 'Tüm ırklar', this.race === 'all'), ...RACES.map((r) => this.chip('data-c', r, RACE_NAMES[r], this.race === r))].join('');
    const levels = Array.from({ length: MAX_LEVEL }, (_, i) => `<option value="${i + 1}"${i + 1 === s.level ? ' selected' : ''}>${i + 1}</option>`).join('');
    const list = this.kinds();
    this.dlg.innerHTML = `
<form method="dialog">
  <header><h2>Birimler</h2><p>the reference game birimleri; seviye roster tablosundaki 1-10 değerlerini seçer. Birime tıkla: seçilir ve yerleştirmeye hazır olur.</p></header>
  <div class="ug-bar">
    <div class="seg" role="group" aria-label="Nadirlik">${rarityChips}</div>
    <div class="seg" role="group" aria-label="Irk">${raceChips}</div>
    <label class="ug-field">Seviye <select id="ug-level">${levels}</select></label>
    <input id="ug-search" type="search" placeholder="Ara…" value="${esc(this.query)}" aria-label="Birim ara" />
  </div>
  <div class="ug-grid">${list.map((k) => this.card(k)).join('') || '<p class="note">Eşleşen birim yok.</p>'}</div>
  <footer><span class="note">${list.length} birim · seçili: ${esc(STATS[s.selKind]?.name ?? '')}</span><button type="submit" class="primary">Kapat</button></footer>
</form>`;

    this.dlg.querySelectorAll<HTMLElement>('[data-r]').forEach((b) =>
      b.addEventListener('click', () => {
        this.rarity = b.dataset.r as RarityFilter;
        this.render();
      }),
    );
    this.dlg.querySelectorAll<HTMLElement>('[data-c]').forEach((b) =>
      b.addEventListener('click', () => {
        this.race = b.dataset.c as RaceFilter;
        this.render();
      }),
    );
    const search = this.dlg.querySelector<HTMLInputElement>('#ug-search')!;
    search.addEventListener('input', () => {
      this.query = search.value;
      const pos = search.selectionStart ?? this.query.length;
      this.render();
      const again = this.dlg.querySelector<HTMLInputElement>('#ug-search')!;
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    this.dlg.querySelector('#ug-level')!.addEventListener('change', (e) => {
      s.level = Number((e.target as HTMLSelectElement).value);
      saveState(s);
      this.d.onLevel();
      this.render();
    });
    this.dlg.querySelectorAll<HTMLElement>('.ug-card').forEach((b) =>
      b.addEventListener('click', () => {
        s.selKind = Number(b.dataset.kind);
        s.tool = 'place';
        saveState(s);
        this.d.onPick(s.selKind);
        this.dlg.close();
      }),
    );
    // Simgeler (kartlar olustuktan sonra).
    this.dlg.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => el.appendChild(this.d.icon(Number(el.dataset.icon), s.selTeam)));
  }
}
