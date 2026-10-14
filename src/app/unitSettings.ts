import { fmtNum, loc, t } from '../i18n';
import { RACE_NAMES, RARITY_NAMES, TROOP_BY_ID, type Rarity } from '../sim/data/troops';
import { DEFAULT_STATS, KIND_COUNT, LEGACY_COUNT, STATS, TUNABLE, isTank, unitDisplayName, type StatKey } from '../sim/units';
import { trackDialog } from '../net/act';
import { saveState, type AppState } from './state';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** Unit settings dialog: one row per unit; HP, speed, power, cooldown, range, armor, knockback. */
export class UnitSettings {
  private readonly dlg: HTMLDialogElement;
  private readonly actTrack: { open(): void };

  constructor(
    private readonly state: AppState,
    private readonly onChange: () => void,
    private readonly icon: (kind: number, team: number) => HTMLCanvasElement,
  ) {
    this.dlg = document.createElement('dialog');
    this.dlg.className = 'unit-dialog unit-settings';
    this.dlg.setAttribute('aria-label', t('units.settings.title'));
    document.body.appendChild(this.dlg);
    this.actTrack = trackDialog(this.dlg, 'unitSettings');
    this.dlg.addEventListener('click', (e) => {
      if (e.target === this.dlg) this.dlg.close();
    });
  }

  /** How many values differ from the defaults. */
  changedCount(): number {
    let n = 0;
    for (const row of this.state.stats) n += Object.keys(row).length;
    return n;
  }

  open(): void {
    this.render();
    this.actTrack.open();
    if (!this.dlg.open) this.dlg.showModal();
  }

  private value(k: number, key: StatKey): number {
    return this.state.stats[k][key] ?? DEFAULT_STATS[k][key];
  }

  /** Row groups: classic units first, then roster units by rarity. */
  private groups(): Array<{ title: string; kinds: number[] }> {
    const out: Array<{ title: string; kinds: number[] }> = [{ title: t('units.classic'), kinds: Array.from({ length: LEGACY_COUNT }, (_, k) => k) }];
    for (const r of RARITY_ORDER) {
      const kinds: number[] = [];
      for (let k = LEGACY_COUNT; k < KIND_COUNT; k++) {
        const tr = TROOP_BY_ID[STATS[k].troop ?? ''];
        if (tr && tr.rarity === r) kinds.push(k);
      }
      if (kinds.length) out.push({ title: loc(RARITY_NAMES[r]), kinds });
    }
    return out;
  }

  private render(): void {
    const head = TUNABLE.map((u) => `<th scope="col" title="${esc(u.hint)}">${esc(u.label)}</th>`).join('');
    const rows = this.groups()
      .map((grp) => {
        const body = grp.kinds
          .map((k) => {
            const cells = TUNABLE.map((u) => {
              if (u.tankOnly && !isTank(k)) return '<td class="na">–</td>';
              const v = this.value(k, u.key);
              const changed = this.state.stats[k][u.key] !== undefined;
              return `<td><input type="number" data-k="${k}" data-key="${u.key}" value="${v}" min="${u.min}" max="${u.max}" step="${u.step}" aria-label="${esc(unitDisplayName(k))} ${esc(u.label)}" class="${changed ? 'changed' : ''}" /></td>`;
            }).join('');
            const has = Object.keys(this.state.stats[k]).length > 0;
            const tr = STATS[k].troop ? TROOP_BY_ID[STATS[k].troop!] : undefined;
            const meta = tr ? `${loc(RARITY_NAMES[tr.rarity])} · ${loc(RACE_NAMES[tr.race])}` : t('units.classic');
            const skill = tr?.skillText ? `<small class="us-skill">${esc(loc(tr.skillText))}</small>` : '';
            return `<tr><th scope="row" class="us-unit"><span class="us-icon" data-icon="${k}"></span><span class="us-name"><b>${esc(unitDisplayName(k))}</b><small>${esc(meta)}</small>${skill}</span></th>${cells}<td class="derived" data-derived="dps" data-k="${k}">${this.dps(k)}</td><td class="derived" data-derived="ehp" data-k="${k}">${this.effHp(k)}</td><td><button type="button" class="mini" data-reset-kind="${k}" ${has ? '' : 'disabled'}>${esc(t('units.settings.reset'))}</button></td></tr>`;
          })
          .join('');
        return `<tr class="grp"><th colspan="${TUNABLE.length + 4}">${esc(grp.title)} · ${grp.kinds.length}</th></tr>${body}`;
      })
      .join('');

    this.dlg.innerHTML = `
<form method="dialog">
  <header><h2>${esc(t('units.settings.title'))}</h2><p>${esc(t('units.settings.hint'))}</p></header>
  <div class="table-wrap">
    <table>
      <thead><tr><th class="us-unit-h">${esc(t('units.settings.unit'))}</th>${head}<th title="${esc(t('units.settings.dpsHint'))}">${esc(t('units.settings.dps'))}</th><th title="${esc(t('units.settings.ehpHint'))}">${esc(t('units.settings.ehp'))}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <footer>
    <button type="button" id="us-reset-all" ${this.changedCount() ? '' : 'disabled'}>${esc(t('units.settings.resetAll'))}</button>
    <button type="submit" class="primary">${esc(t('units.close'))}</button>
  </footer>
</form>`;

    this.dlg.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => el.appendChild(this.icon(Number(el.dataset.icon), 0)));
    this.dlg.querySelectorAll('input[data-k]').forEach((el) => {
      el.addEventListener('change', (e) => this.edit(e.target as HTMLInputElement));
    });
    this.dlg.querySelectorAll('[data-reset-kind]').forEach((el) =>
      el.addEventListener('click', () => {
        this.state.stats[Number((el as HTMLElement).dataset.resetKind)] = {};
        this.commit();
      }),
    );
    this.dlg.querySelector('#us-reset-all')!.addEventListener('click', () => {
      for (let k = 0; k < KIND_COUNT; k++) this.state.stats[k] = {};
      this.commit();
    });
  }

  private dps(k: number): string {
    return fmtNum(this.value(k, 'power') / this.value(k, 'cooldown'));
  }

  private effHp(k: number): string {
    return Math.round(this.value(k, 'hp') / (1 - this.value(k, 'armor'))).toString();
  }

  private edit(input: HTMLInputElement): void {
    const k = Number(input.dataset.k);
    const key = input.dataset.key as StatKey;
    const u = TUNABLE.find((x) => x.key === key)!;
    const raw = Number(input.value);
    if (!Number.isFinite(raw) || input.value === '') {
      input.value = String(this.value(k, key));
      return;
    }
    const v = Math.min(u.max, Math.max(u.min, raw));
    // Do not keep an override that equals the default.
    if (Math.abs(v - DEFAULT_STATS[k][key]) < 1e-9) delete this.state.stats[k][key];
    else this.state.stats[k][key] = v;
    input.value = String(v);
    input.classList.toggle('changed', this.state.stats[k][key] !== undefined);
    this.refreshDerived();
    const reset = this.dlg.querySelector<HTMLButtonElement>(`[data-reset-kind="${k}"]`);
    if (reset) reset.disabled = Object.keys(this.state.stats[k]).length === 0;
    saveState(this.state);
    this.onChange();
    const resetAll = this.dlg.querySelector('#us-reset-all') as HTMLButtonElement | null;
    if (resetAll) resetAll.disabled = this.changedCount() === 0;
  }

  private refreshDerived(): void {
    this.dlg.querySelectorAll<HTMLElement>('[data-derived]').forEach((td) => {
      const k = Number(td.dataset.k);
      td.textContent = td.dataset.derived === 'dps' ? this.dps(k) : this.effHp(k);
    });
  }

  private commit(): void {
    saveState(this.state);
    this.onChange();
    this.render();
  }
}
