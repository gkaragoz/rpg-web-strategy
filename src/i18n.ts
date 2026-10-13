/** Minimal i18n core: English is the default language, Turkish is the alternative. */
export type Lang = 'en' | 'tr';
export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'tr', label: 'Türkçe' },
];

/** A text available in both languages. */
export interface Localized {
  en: string;
  tr: string;
}

const KEY = 'rpgweb.lang';
let lang: Lang = detect();
const listeners = new Set<(l: Lang) => void>();

function detect(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'tr') return q;
    const s = localStorage.getItem(KEY);
    if (s === 'en' || s === 'tr') return s;
  } catch {
    /* storage or location unavailable (tests, workers) */
  }
  return 'en';
}

export const getLang = (): Lang => lang;

export function setLang(l: Lang): void {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage unavailable */
  }
  for (const f of listeners) f(l);
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onLang(f: (l: Lang) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Picks the current-language variant of a localized text. */
export const loc = (l: Localized): string => l[lang];
