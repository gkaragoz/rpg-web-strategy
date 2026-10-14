import { describe, expect, it } from 'vitest';
import { isPlainShortcut, isTyping, langKeys } from '../../app/hotkeys';

const ev = (over: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'repeat', boolean>> & { target?: unknown }): KeyboardEvent => ({ ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: null, ...over }) as unknown as KeyboardEvent;
const el = (tagName: string, isContentEditable = false): unknown => ({ tagName, isContentEditable });

describe('language dependent shortcuts', () => {
  it('gallery is U in English and B in Turkish, and the brush key never collides with it', () => {
    expect(langKeys('en')).toEqual({ gallery: 'KeyU', brush: 'KeyB' });
    expect(langKeys('tr')).toEqual({ gallery: 'KeyB', brush: 'KeyF' });
    for (const l of ['en', 'tr'] as const) expect(langKeys(l).gallery).not.toBe(langKeys(l).brush);
  });

  it('does not fire while typing (chat, search, seed, select, rich text)', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTyping(ev({ target: el(tag) }))).toBe(true);
      expect(isPlainShortcut(ev({ target: el(tag) }))).toBe(false);
    }
    expect(isPlainShortcut(ev({ target: el('DIV', true) }))).toBe(false);
  });

  it('fires on the page, but not with modifiers or key repeat', () => {
    expect(isPlainShortcut(ev({ target: el('CANVAS') }))).toBe(true);
    expect(isPlainShortcut(ev({ target: el('BODY') }))).toBe(true);
    expect(isPlainShortcut(ev({ ctrlKey: true }))).toBe(false);
    expect(isPlainShortcut(ev({ metaKey: true }))).toBe(false);
    expect(isPlainShortcut(ev({ altKey: true }))).toBe(false);
    expect(isPlainShortcut(ev({ repeat: true }))).toBe(false);
  });
});
