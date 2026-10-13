import type { StringTable } from './types';

/** Strings for the "system" area. Every key must exist in both languages (checked by src/sim/__tests__/i18n.test.ts). */
export const system: StringTable = {
  en: {
    'sys.lang.aria': 'Language',
    'sys.lang.confirmLeave': 'Changing the language reloads the page and leaves the online lobby. Continue?',
    'sys.title': 'RPG Web - Battle Studio',
    'sys.loading': 'Loading…',
    'sys.error.unexpected': 'An unexpected error occurred: {msg}',
    'sys.error.unknown': 'unknown',
    'sys.gl.lost': 'The graphics context was lost.',
    'sys.gl.reload': 'Reload page',
    'sys.mapChanged': 'Map changed: {moved} soldiers moved.',
    'sys.mapChangedRemoved': 'Map changed: {moved} soldiers moved, {removed} soldiers removed.',
    'sys.slow': 'Frames are slow: graphics resolution lowered ({res}×)',
  },
  tr: {
    'sys.lang.aria': 'Dil',
    'sys.lang.confirmLeave': 'Dili değiştirmek sayfayı yeniler ve çevrimiçi lobiden çıkarır. Devam edilsin mi?',
    'sys.title': 'RPG Web - Savaş Stüdyosu',
    'sys.loading': 'Yükleniyor…',
    'sys.error.unexpected': 'Beklenmeyen bir hata oluştu: {msg}',
    'sys.error.unknown': 'bilinmeyen',
    'sys.gl.lost': 'Grafik bağlamı kayboldu.',
    'sys.gl.reload': 'Sayfayı yenile',
    'sys.mapChanged': 'Harita değişti: {moved} asker taşındı.',
    'sys.mapChangedRemoved': 'Harita değişti: {moved} asker taşındı, {removed} asker kaldırıldı.',
    'sys.slow': 'Kareler yavaş: grafik çözünürlüğü düşürüldü ({res}×)',
  },
};
