import { loc, t } from '../i18n';
import { RACE_NAMES, RARITY_NAMES, TROOP_BY_ID, type Race, type Rarity } from '../sim/data/troops';
import { KIND_COUNT, LEGACY_COUNT, MAX_LEVEL, STATS, isHealer, isMelee, unitDisplayName } from '../sim/units';
import { trackDialog } from '../net/act';
import { saveState, type AppState } from './state';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type RarityFilter = Rarity | 'legacy' | 'all';
type RaceFilter = Race | 'all';

const RARITIES: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
const RACES: Race[] = ['human', 'dark', 'sacred', 'wild'];

export interface GalleryDeps {
  state: AppState;
  /** Unit icon (in the selected team color). */
  icon: (kind: number, team: number) => HTMLCanvasElement;
  /** Level changed: STATS was refreshed, the UI must be updated. */
  onLevel: () => void;
  /** A unit was picked (the atlas is baked if needed). */
  onPick: (kind: number) => void;
  /** Online: unit gold cost and disabled rarities; the level picker is hidden. */
  online?: { cost(kind: number): number; banned(): string[] };
}

/** Unit gallery: card list with rarity/race filters, search and icons, plus a level picker. */
export class UnitGallery {
  private readonly dlg: HTMLDialogElement;
  private rarity: RarityFilter = 'all';
  private race: RaceFilter = 'all';
  private query = '';
  private readonly actTrack: { open(): void };

  constructor(private readonly d: GalleryDeps) {
    this.dlg = document.createElement('dialog');
    this.dlg.className = 'unit-dialog gallery-dialog';
    this.dlg.setAttribute('aria-label', t('units.gallery.aria'));
    document.body.appendChild(this.dlg);
    this.actTrack = trackDialog(this.dlg, 'unitPicker');
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
  }

  /** Closes the dialog and removes it from the DOM (so an open modal cannot leave the screen locked; the action label is cleared). */
  destroy(): void {
    if (this.dlg.open) this.dlg.close();
    this.dlg.remove();
  }

  open(): void {
    this.render();
    this.actTrack.open();
    if (!this.dlg.open) this.dlg.showModal();
  }

  /** Short summary of the selected unit (for the dock button). */
  static summary(kind: number): string {
    return unitDisplayName(kind);
  }

  private kinds(): number[] {
    const q = this.query.trim().toLocaleLowerCase('tr');
    const out: number[] = [];
    for (let k = 0; k < KIND_COUNT; k++) {
      const tr = k >= LEGACY_COUNT ? TROOP_BY_ID[STATS[k].troop ?? ''] : undefined;
      if (tr?.summoned) continue; // bone soldiers only come with the Bone Caller
      if (this.d.online && tr && this.d.online.banned().includes(tr.rarity)) continue;
      if (this.rarity === 'legacy') {
        if (k >= LEGACY_COUNT) continue;
      } else if (this.rarity !== 'all') {
        if (!tr || tr.rarity !== this.rarity) continue;
      }
      if (this.race !== 'all' && (!tr || tr.race !== this.race)) continue;
      if (q && !unitDisplayName(k).toLocaleLowerCase('tr').includes(q)) continue;
      out.push(k);
    }
    return out;
  }

  private card(k: number): string {
    const s = STATS[k];
    const tr = k >= LEGACY_COUNT ? TROOP_BY_ID[s.troop ?? ''] : undefined;
    const role = isHealer(k) ? t('units.role.healer') : isMelee(k) ? t('units.role.melee') : t('units.role.ranged');
    const meta = tr ? `${loc(RARITY_NAMES[tr.rarity])} · ${loc(RACE_NAMES[tr.race])}` : t('units.classic');
    const stats = t('units.statline', { hp: Math.round(s.hp), power: Math.round(s.power), range: s.range.toFixed(1), role });
    const skill = tr?.skillText ? `<span class="ug-skill">${esc(loc(tr.skillText))}</span>` : '';
    const sel = this.d.state.selKind === k;
    const price = this.d.online ? `<span class="ug-price">${esc(t('units.gold', { n: this.d.online.cost(k) }))}</span>` : '';
    return `<button type="button" class="ug-card r-${tr ? tr.rarity : 'legacy'}${sel ? ' sel' : ''}" data-kind="${k}" aria-pressed="${sel}">${price}
  <span class="ug-icon" data-icon="${k}"></span>
  <span class="ug-name">${esc(unitDisplayName(k))}</span>
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
      this.chip('data-r', 'all', t('units.gallery.all'), this.rarity === 'all'),
      this.chip('data-r', 'legacy', t('units.classic'), this.rarity === 'legacy'),
      ...RARITIES.map((r) => this.chip('data-r', r, loc(RARITY_NAMES[r]), this.rarity === r)),
    ].join('');
    const raceChips = [this.chip('data-c', 'all', t('units.gallery.allRaces'), this.race === 'all'), ...RACES.map((r) => this.chip('data-c', r, loc(RACE_NAMES[r]), this.race === r))].join('');
    const levels = Array.from({ length: MAX_LEVEL }, (_, i) => `<option value="${i + 1}"${i + 1 === s.level ? ' selected' : ''}>${i + 1}</option>`).join('');
    const list = this.kinds();
    this.dlg.innerHTML = `
<form method="dialog">
  <header><h2>${esc(t('units.gallery.title'))}</h2><p>${esc(t('units.gallery.hint'))}</p></header>
  <div class="ug-bar">
    <div class="seg" role="group" aria-label="${esc(t('units.gallery.rarity'))}">${rarityChips}</div>
    <div class="seg" role="group" aria-label="${esc(t('units.gallery.race'))}">${raceChips}</div>
    ${this.d.online ? '' : `<label class="ug-field">${esc(t('units.gallery.level'))} <select id="ug-level">${levels}</select></label>`}
    <input id="ug-search" type="search" placeholder="${esc(t('units.gallery.search'))}" value="${esc(this.query)}" aria-label="${esc(t('units.gallery.searchAria'))}" />
  </div>
  <div class="ug-grid">${list.map((k) => this.card(k)).join('') || `<p class="note">${esc(t('units.gallery.none'))}</p>`}</div>
  <footer><span class="note">${esc(t('units.gallery.footer', { n: list.length, name: STATS[s.selKind] ? unitDisplayName(s.selKind) : '' }))}</span><button type="submit" class="primary">${esc(t('units.close'))}</button></footer>
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
    this.dlg.querySelector('#ug-level')?.addEventListener('change', (e) => {
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
    // Icons (after the cards are created).
    this.dlg.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => el.appendChild(this.d.icon(Number(el.dataset.icon), s.selTeam)));
  }
}
