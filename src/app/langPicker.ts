import { LANGS, getLang, switchLang, t, type Lang } from '../i18n';

/** Five-point star polygon points; one point faces left (towards the crescent), like the Turkish flag. */
function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = Math.PI + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.4;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(2)},${(cy + Math.sin(a) * rr).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Inline SVG flags (Windows has no flag emoji). 3:2 ratio. */
const FLAGS: Record<Lang, string> = {
  en: `<svg viewBox="0 0 60 40" width="24" height="16" aria-hidden="true"><rect width="60" height="40" fill="#012169"/><path d="M0 0 60 40M60 0 0 40" stroke="#fff" stroke-width="8"/><path d="M0 0 60 40M60 0 0 40" stroke="#C8102E" stroke-width="3"/><path d="M30 0V40M0 20H60" stroke="#fff" stroke-width="13"/><path d="M30 0V40M0 20H60" stroke="#C8102E" stroke-width="8"/></svg>`,
  tr: `<svg viewBox="0 0 60 40" width="24" height="16" aria-hidden="true"><rect width="60" height="40" fill="#E30A17"/><circle cx="22.5" cy="20" r="10" fill="#fff"/><circle cx="25.5" cy="20" r="8" fill="#E30A17"/><polygon points="${starPoints(35.5, 20, 5.4)}" fill="#fff"/></svg>`,
};

export interface LangPickerOptions {
  /** Return false to cancel the switch (e.g. the user declined to leave an online session). */
  beforeSwitch?: () => boolean;
}

/** Bottom-right language dropdown (flag + language name). Mounted once on <body>; switching reloads the page. */
export function mountLangPicker(opts: LangPickerOptions = {}): () => void {
  const root = document.createElement('div');
  root.className = 'lang-picker';
  const cur = getLang();
  const label = (id: Lang): string => LANGS.find((l) => l.id === id)!.label;
  root.innerHTML = `
<button type="button" class="lp-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${t('sys.lang.aria')}">${FLAGS[cur]}<span class="lp-name">${label(cur)}</span><span class="lp-caret" aria-hidden="true">▾</span></button>
<ul class="lp-list" role="listbox" tabindex="-1" aria-label="${t('sys.lang.aria')}" hidden>${LANGS.map(
    (l) => `<li role="option" tabindex="-1" data-lang="${l.id}" aria-selected="${l.id === cur}">${FLAGS[l.id]}<span class="lp-opt"><b>${l.label}</b></span></li>`,
  ).join('')}</ul>`;
  document.body.appendChild(root);
  const btn = root.querySelector('.lp-btn') as HTMLButtonElement;
  const list = root.querySelector('.lp-list') as HTMLElement;
  const items = [...list.querySelectorAll<HTMLElement>('[role=option]')];

  const open = (on: boolean): void => {
    list.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    if (on) (items.find((i) => i.dataset.lang === cur) ?? items[0]).focus();
  };
  const pick = (id: Lang): void => {
    open(false);
    if (id === cur) return;
    if (opts.beforeSwitch && !opts.beforeSwitch()) return;
    // A ?lang= query would override the stored choice after the reload: drop it.
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('lang')) {
        u.searchParams.delete('lang');
        history.replaceState(null, '', u.toString());
      }
    } catch {
      /* no URL support (tests) */
    }
    switchLang(id);
  };

  btn.addEventListener('click', () => open(!!list.hidden));
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-lang]');
    if (li) pick(li.dataset.lang as Lang);
  });
  list.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const id = (document.activeElement as HTMLElement | null)?.dataset.lang as Lang | undefined;
      if (id) pick(id);
    }
  });
  const onDoc = (e: Event): void => {
    if (!list.hidden && !root.contains(e.target as Node)) open(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !list.hidden) {
      open(false);
      btn.focus();
    }
  };
  document.addEventListener('pointerdown', onDoc);
  document.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('pointerdown', onDoc);
    document.removeEventListener('keydown', onKey);
    root.remove();
  };
}
