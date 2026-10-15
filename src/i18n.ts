/**
 * Minimal i18n core: English is the default language, Turkish is the alternative.
 * UI strings live in src/i18n/*.ts (flat dotted keys); use t with a dotted key and optional placeholder values.
 * Changing the language reloads the page, so UI code can build its DOM once with `t()`.
 */
import { battle } from './i18n/battle';
import { maps } from './i18n/maps';
import { online } from './i18n/online';
import { studio } from './i18n/studio';
import { system } from './i18n/system';
import type { Strings } from './i18n/types';
import { units } from './i18n/units';
import type { Localized } from './contracts/localized';
import { setTranslator } from './sim/text';

export type Lang = 'en' | 'tr';
export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'tr', label: 'Türkçe' },
];

export type { Localized };

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

const TABLES = [studio, battle, maps, units, online, system];
const EN: Strings = Object.assign({}, ...TABLES.map((x) => x.en));
const TR: Strings = Object.assign({}, ...TABLES.map((x) => x.tr));

/** All keys of both languages (used by the consistency test). */
export const allStrings = (): { en: Strings; tr: Strings } => ({ en: EN, tr: TR });

/**
 * Looks up a UI string; falls back to English, then to the key itself. `{name}` placeholders come from `vars`.
 * A plural form `{n?one|other}` picks `one` when `vars.n` is exactly 1 and `other` otherwise (Turkish needs none:
 * a counted noun stays singular, so its tables simply write the noun after `{n}`).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let s = (lang === 'tr' ? TR[key] : EN[key]) ?? EN[key] ?? key;
  if (vars) {
    s = s.replace(PLURAL_RE, (_m, name: string, one: string, other: string) => (Number(vars[name]) === 1 ? one : other));
    for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  }
  return s;
}

setTranslator((key) => t(key));

/** `{n?one|other}` plural placeholder (see `t`). */
const PLURAL_RE = /\{([a-zA-Z0-9]+)\?([^|{}]*)\|([^{}]*)\}/g;

/** Number with `digits` decimals using the current language's decimal separator (Turkish uses a comma). */
export function fmtNum(n: number, digits = 1): string {
  const s = n.toFixed(digits);
  return lang === 'tr' ? s.replace('.', ',') : s;
}

/** Language switch that persists and reloads so every screen is rebuilt in the new language. */
export function switchLang(l: Lang): void {
  if (l === lang) return;
  setLang(l);
  try {
    location.reload();
  } catch {
    /* no location (tests) */
  }
}
