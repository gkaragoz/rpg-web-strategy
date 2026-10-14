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

const FS_ICON = {
  enter: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`,
  exit: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>`,
};

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export interface LangPickerOptions {
  /** Return false to cancel the switch (e.g. the user declined to leave an online session). */
  beforeSwitch?: () => boolean;
  /** Current world view and the switch handler (the 2D/3D buttons are shown when both are given). */
  view?: '2d' | '3d';
  onView?: (v: '2d' | '3d') => void;
}

/** Bottom-right language dropdown (flag + language name) with the full-screen button next to it. Mounted once on <body>; switching reloads the page. */
export function mountLangPicker(opts: LangPickerOptions = {}): () => void {
  const root = document.createElement('div');
  root.className = 'lang-picker';
  const cur = getLang();
  const label = (id: Lang): string => LANGS.find((l) => l.id === id)!.label;
  root.innerHTML = `
<span class="app-ver" aria-hidden="true">v${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''}</span>
<span class="view-seg" role="group" aria-label="${t('sys.view.aria')}" ${opts.view && opts.onView ? '' : 'hidden'}><button type="button" data-view="2d" aria-pressed="${opts.view === '2d'}" title="${t('sys.view.2d')}">2D</button><button type="button" data-view="3d" aria-pressed="${opts.view === '3d'}" title="${t('sys.view.3d')}">3D</button></span>
<button type="button" class="fs-btn" aria-label="${t('battle.fullscreen')}" title="${t('battle.fullscreen')}" hidden></button>
<button type="button" class="lp-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${t('sys.lang.aria')}">${FLAGS[cur]}<span class="lp-name">${label(cur)}</span><span class="lp-caret" aria-hidden="true">▾</span></button>
<ul class="lp-list" role="listbox" tabindex="-1" aria-label="${t('sys.lang.aria')}" hidden>${LANGS.map(
    (l) => `<li role="option" tabindex="-1" data-lang="${l.id}" aria-selected="${l.id === cur}">${FLAGS[l.id]}<span class="lp-opt"><b>${l.label}</b></span></li>`,
  ).join('')}</ul>`;
  document.body.appendChild(root);
  const btn = root.querySelector('.lp-btn') as HTMLButtonElement;
  const list = root.querySelector('.lp-list') as HTMLElement;
  const items = [...list.querySelectorAll<HTMLElement>('[role=option]')];

  // Full screen (not available on iPhone Safari: the button stays hidden there).
  const fs = root.querySelector('.fs-btn') as HTMLButtonElement;
  const docEl = document.documentElement as FsEl;
  const doc = document as FsDoc;
  const canFs = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);
  const isFs = (): boolean => !!(document.fullscreenElement || doc.webkitFullscreenElement);
  const paintFs = (): void => {
    fs.innerHTML = isFs() ? FS_ICON.exit : FS_ICON.enter;
    fs.setAttribute('aria-pressed', String(isFs()));
  };
  fs.hidden = !canFs;
  paintFs();
  fs.addEventListener('click', () => {
    try {
      if (isFs()) void (document.exitFullscreen ? document.exitFullscreen() : doc.webkitExitFullscreen?.());
      else void (docEl.requestFullscreen ? docEl.requestFullscreen() : docEl.webkitRequestFullscreen?.());
    } catch {
      /* refused by the browser */
    }
  });
  document.addEventListener('fullscreenchange', paintFs);
  document.addEventListener('webkitfullscreenchange', paintFs);

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
        history.replaceState(history.state, '', u.toString()); // keep the app's history marker (see nav.ts)
      }
    } catch {
      /* no URL support (tests) */
    }
    switchLang(id);
  };

  root.querySelectorAll<HTMLButtonElement>('.view-seg button').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.view as '2d' | '3d';
      if (v === opts.view) return;
      if (opts.beforeSwitch && !opts.beforeSwitch()) return;
      opts.onView?.(v);
    }),
  );
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
    document.removeEventListener('fullscreenchange', paintFs);
    document.removeEventListener('webkitfullscreenchange', paintFs);
    root.remove();
  };
}
