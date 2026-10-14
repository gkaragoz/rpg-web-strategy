import type { Lang } from '../i18n';

/** Physical keys (`KeyboardEvent.code`) of the placement shortcuts that depend on the UI language. */
export interface LangKeys {
  /** Opens / closes the units gallery: U in English, B in Turkish (the first letter of the Turkish word for units). */
  gallery: string;
  /** Cycles the brush size: B in English, F in Turkish (B is taken by the gallery there). */
  brush: string;
}

export function langKeys(lang: Lang): LangKeys {
  return lang === 'tr' ? { gallery: 'KeyB', brush: 'KeyF' } : { gallery: 'KeyU', brush: 'KeyB' };
}

/** True when the key event comes from somewhere the player is typing (chat, search, seed, a select, ...). */
export function isTyping(e: KeyboardEvent): boolean {
  const field = (el: Element | null): boolean => {
    const h = el as HTMLElement | null;
    return !!h && (h.tagName === 'INPUT' || h.tagName === 'TEXTAREA' || h.tagName === 'SELECT' || h.isContentEditable === true);
  };
  return field(e.target as Element | null) || field(typeof document !== 'undefined' ? document.activeElement : null);
}

/** A plain key press (no Ctrl / Meta / Alt, not auto-repeat) outside of any text field. */
export function isPlainShortcut(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !isTyping(e);
}
