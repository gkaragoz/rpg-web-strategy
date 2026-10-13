import { loc, t } from '../i18n';
import { RACE_NAMES, RARITY_NAMES, TROOP_BY_ID, type Race, type Rarity } from '../sim/data/troops';
import { KIND_COUNT, LEGACY_COUNT, STATS, isHealer, isMelee, unitDisplayName } from '../sim/units';
import { unitGold } from '../net/economy';
import { trackDialog } from '../net/act';
import { skillParams } from '../sim/data/skills';
import { ARM_IDS, DMG_IDS, TYPE_MULT } from '../sim/data/combat';
import { cardIcon, type CardIcon } from './cardIcons';
import type { UnitPreview } from './unitPreview';
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
  /** A unit was picked (the atlas is baked if needed). */
  onPick: (kind: number) => void;
  /** Online: unit gold cost and disabled rarities; price shown on the cards. */
  online?: { cost(kind: number): number; banned(): string[] };
  /** Animated attack previews (optional): attached after every render, detached when the dialog closes. */
  preview?: UnitPreview;
}

/** Unit gallery: card list with rarity/race filters, search and icons. */
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
    this.dlg.addEventListener('close', () => this.d.preview?.detach());
  }

  /** Closes the dialog and removes it from the DOM (so an open modal cannot leave the screen locked; the action label is cleared). */
  destroy(): void {
    this.d.preview?.detach();
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

  /** Largest value of every stat among the listed units (bar scale). */
  private maxima(): { hp: number; power: number; range: number; speed: number } {
    const m = { hp: 1, power: 1, range: 1, speed: 1 };
    for (let k = 0; k < KIND_COUNT; k++) {
      const s = STATS[k];
      m.hp = Math.max(m.hp, s.hp);
      m.power = Math.max(m.power, s.power);
      m.range = Math.max(m.range, s.range);
      m.speed = Math.max(m.speed, s.speed);
    }
    return m;
  }

  private stat(cls: string, icon: CardIcon, label: string, frac: number, value: string): string {
    const pct = Math.round(Math.min(1, Math.max(0.06, frac)) * 100);
    return `<span class="ug-stat ${cls}">${cardIcon(icon)}<span class="ug-sl">${esc(label)}</span><span class="ug-meter"><i style="width:${pct}%"></i></span><b>${esc(value)}</b></span>`;
  }

  private card(k: number, mx: ReturnType<UnitGallery['maxima']>): string {
    const s = STATS[k];
    const tr = k >= LEGACY_COUNT ? TROOP_BY_ID[s.troop ?? ''] : undefined;
    const healer = isHealer(k);
    const role = healer ? t('units.role.healer') : isMelee(k) ? t('units.role.melee') : t('units.role.ranged');
    const roleIcon: CardIcon = healer ? 'healer' : isMelee(k) ? 'sword' : 'bow';
    const meta = tr ? `${loc(RARITY_NAMES[tr.rarity])} · ${loc(RACE_NAMES[tr.race])}` : t('units.classic');
    const skillText = tr?.skillText ? loc(tr.skillText) : '';
    const skill = skillText
      ? `<span class="ug-skill">${cardIcon('star')}<span><b>${esc(t('units.skill'))}</b> ${esc(skillText)}</span></span>`
      : `<span class="ug-skill none">${cardIcon('star')}<span>${esc(t('units.noSkill'))}</span></span>`;
    const radius = s.splash > 0 ? s.splash : s.aoe;
    const skillArea = !!s.skill && skillParams(s.skill).radius > 0;
    const area =
      (radius > 0
        ? `<span class="ug-chip area" title="${esc(t('units.area.tip'))}">${cardIcon('burst', 14)}${esc(t('units.area.area', { r: radius.toFixed(1) }))}</span>`
        : `<span class="ug-chip single" title="${esc(t('units.area.singleTip'))}">${cardIcon('target', 14)}${esc(t('units.area.single'))}</span>`) +
      (skillArea ? `<span class="ug-chip area skill" title="${esc(t('units.area.skillTip'))}">${cardIcon('star', 14)}${esc(t('units.area.skill'))}</span>` : '');
    const dmgId = DMG_IDS[s.dmgType];
    const armId = ARM_IDS[s.armorCls];
    const best = (vals: number[], max: boolean): number => vals.indexOf(max ? Math.max(...vals) : Math.min(...vals));
    const dmgRow = [0, 1, 2, 3].map((a) => TYPE_MULT[s.dmgType * 4 + a]);
    const armCol = [0, 1, 2, 3].map((d) => TYPE_MULT[d * 4 + s.armorCls]);
    const armName = (i: number): string => t(`units.arm.${ARM_IDS[i]}`);
    const dmgName = (i: number): string => t(`units.dmg.${DMG_IDS[i]}`);
    const types =
      `<span class="ug-chip dmg" title="${esc(t('units.dmg.tip', { type: dmgName(s.dmgType), strong: armName(best(dmgRow, true)), weak: armName(best(dmgRow, false)) }))}">${cardIcon(dmgId, 14)}${esc(dmgName(s.dmgType))}</span>` +
      `<span class="ug-chip arm" title="${esc(t('units.arm.tip', { type: armName(s.armorCls), weak: dmgName(best(armCol, true)), strong: dmgName(best(armCol, false)) }))}">${cardIcon(armId, 14)}${esc(armName(s.armorCls))}</span>`;
    const sel = this.d.state.selKind === k;
    const gold = this.d.online ? this.d.online.cost(k) : unitGold(k);
    const price = `<span class="ug-price">${cardIcon('coin')}${esc(t('units.gold', { n: gold }))}</span>`;
    const stats =
      this.stat('hp', 'heart', t('units.stat.hp.label'), Math.sqrt(s.hp / mx.hp), String(Math.round(s.hp))) +
      this.stat('pw', 'flame', t('units.stat.power.label'), Math.sqrt(s.power / mx.power), String(Math.round(s.power))) +
      this.stat('rg', 'range', t('units.stat.range.label'), s.range / mx.range, s.range.toFixed(1)) +
      this.stat('sp', 'bolt', t('units.stat.speed.label'), s.speed / mx.speed, s.speed.toFixed(1));
    return `<button type="button" class="ug-card r-${tr ? tr.rarity : 'legacy'}${sel ? ' sel' : ''}" data-kind="${k}" aria-pressed="${sel}">${price}
  <span class="ug-icon" data-icon="${k}"></span>
  <span class="ug-name">${esc(unitDisplayName(k))}</span>
  <span class="ug-meta">${esc(meta)}</span>
  <span class="ug-chips"><span class="ug-role">${cardIcon(roleIcon, 15)}${esc(role)}</span>${types}${area}</span>
  <span class="ug-stats">${stats}</span>${skill}
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
    const list = this.kinds();
    const mx = this.maxima();
    this.dlg.innerHTML = `
<form method="dialog">
  <header><h2>${esc(t('units.gallery.title'))}</h2><p>${esc(t('units.gallery.hint'))}</p></header>
  <div class="ug-bar">
    <div class="seg" role="group" aria-label="${esc(t('units.gallery.rarity'))}">${rarityChips}</div>
    <div class="seg" role="group" aria-label="${esc(t('units.gallery.race'))}">${raceChips}</div>
    <input id="ug-search" type="search" placeholder="${esc(t('units.gallery.search'))}" value="${esc(this.query)}" aria-label="${esc(t('units.gallery.searchAria'))}" />
  </div>
  <div class="ug-grid">${list.map((k) => this.card(k, mx)).join('') || `<p class="note">${esc(t('units.gallery.none'))}</p>`}</div>
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
    search.addEventListener('compositionend', () => search.dispatchEvent(new Event('input')));
    search.addEventListener('input', (e) => {
      // Do not rebuild the dialog in the middle of an IME composition (Android keyboards): wait for compositionend.
      if ((e as InputEvent).isComposing) return;
      this.query = search.value;
      const pos = search.selectionStart ?? this.query.length;
      this.render();
      const again = this.dlg.querySelector<HTMLInputElement>('#ug-search')!;
      again.focus();
      again.setSelectionRange(pos, pos);
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
    this.d.preview?.attach(this.dlg, s.selTeam);
  }
}
