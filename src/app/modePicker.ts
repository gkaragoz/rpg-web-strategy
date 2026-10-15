import { t } from '../i18n';
import { SELECTABLE_MODES, type SelectableMode } from './modeIds';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Small inline icons (24 x 24, currentColor) so the cards need no image files. */
const ICONS: Record<SelectableMode, string> = {
  classic: '<path d="M5 19 17 7m0 0h-5m5 0v5M19 19 7 7m0 0h5M7 7v5" />',
  hill: '<path d="M3 19 9 8l4 7 3-4 5 8Z" /><circle cx="17" cy="6" r="2" />',
  vip: '<path d="M4 18h16M5 18 4 8l5 4 3-6 3 6 5-4-1 10" />',
  ctf: '<path d="M6 21V4m0 0 12 4-12 5" />',
};

/** Rule text of a mode (also shown under the cards); `target` fills the points goal. */
export function modeRuleText(id: SelectableMode, vars: { target?: number } = {}): string {
  const target = vars.target ?? 100;
  return id === 'hill' ? t('mode.hill.rule', { target }) : id === 'vip' ? t('mode.vip.rule') : id === 'ctf' ? t('mode.ctf.rule', { target: vars.target ?? 3 }) : t('mode.classic.rule');
}

export function modeName(id: SelectableMode): string {
  return id === 'hill' ? t('mode.hill.name') : id === 'vip' ? t('mode.vip.name') : id === 'ctf' ? t('mode.ctf.name') : t('mode.classic.name');
}

export interface ModePickerOptions {
  value: SelectableMode;
  onPick(id: SelectableMode): void;
  /** Only the host can change the mode in a lobby; guests see it read-only. */
  readOnly?: boolean;
}

/** Row of mode cards (icon + name) with the rule of the selected mode underneath. */
export class ModePicker {
  readonly el = document.createElement('div');
  private value: SelectableMode;
  private readOnly: boolean;

  constructor(private readonly opts: ModePickerOptions) {
    this.value = opts.value;
    this.readOnly = !!opts.readOnly;
    this.el.className = 'mode-picker';
    this.paint();
  }

  /** Selects a mode without calling `onPick` (state from the host / saved state). */
  set(value: SelectableMode, readOnly = this.readOnly): void {
    if (value === this.value && readOnly === this.readOnly) return;
    this.value = value;
    this.readOnly = readOnly;
    this.paint();
  }

  private paint(): void {
    const cards = SELECTABLE_MODES.map(
      (id) =>
        `<button type="button" class="mode-card" data-mode="${id}" role="radio" aria-checked="${id === this.value}" aria-pressed="${id === this.value}"${this.readOnly ? ' disabled' : ''}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg><span>${esc(modeName(id))}</span></button>`,
    ).join('');
    this.el.innerHTML = `<div class="mode-cards" role="radiogroup" aria-label="${esc(t('mode.aria'))}">${cards}</div><p class="mode-rule">${esc(modeRuleText(this.value))}</p>`;
    this.el.querySelectorAll<HTMLButtonElement>('.mode-card').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.mode as SelectableMode;
        if (this.readOnly || id === this.value) return;
        this.value = id;
        this.paint();
        this.opts.onPick(id);
      }),
    );
  }
}
